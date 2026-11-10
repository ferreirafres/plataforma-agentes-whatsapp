"""Server-only WhatsApp MCP client. Credentials never leave the server."""
import concurrent.futures
import json
import os
import threading
import time
import fcntl
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone


class ConnectionError(Exception):
    pass


class TemporaryConnectionError(ConnectionError):
    """A read/connect operation may be retried; outgoing sends still need certainty."""
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def transport_url(config):
    # Keep the public OAuth resource separate from the private Docker route.
    return config.get('transport_url') or config['base_url']


class MCPConnections:
    def __init__(self, path):
        self.path = path
        self.file_lock = threading.RLock()
        self.locks = {}
        self.cache = {}
        self.opener = urllib.request.build_opener(NoRedirect())

    def configs(self):
        with self.file_lock:
            if not self.path.exists():
                return {}
            return json.loads(self.path.read_text())

    def _save(self, key, config):
        with self.file_lock:
            configs = self.configs()
            configs[key] = config
            temporary = self.path.with_suffix('.tmp')
            with temporary.open('w') as file:
                os.chmod(temporary, 0o600)
                json.dump(configs, file)
                file.flush()
                os.fsync(file.fileno())
            temporary.replace(self.path)

    def _request(self, url, method='GET', data=None, token=None, form=False):
        headers = {'Accept': 'application/json, text/event-stream'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        body = None
        if data is not None:
            body = urllib.parse.urlencode(data).encode() if form else json.dumps(data).encode()
            headers['Content-Type'] = 'application/x-www-form-urlencoded' if form else 'application/json'
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=5) as response:
                if response.headers.get_content_type() != 'application/json':
                    raise ConnectionError('Resposta inválida do MCP.')
                content = response.read(1024 * 1024 + 1)
                if len(content) > 1024 * 1024:
                    raise ConnectionError('Resposta inválida do MCP.')
                return json.loads(content)
        except urllib.error.HTTPError as error:
            # Never propagate response bodies, headers, URLs or credentials.
            if error.code in (408,425,429) or error.code >= 500:
                raise TemporaryConnectionError('O MCP está temporariamente indisponível. Aguardando nova tentativa.') from None
            if error.code in (400, 401, 403) and form:
                raise ConnectionError('A autorização expirou. É necessário reconectar esta instância.') from None
            raise ConnectionError('Não foi possível autenticar ou consultar o MCP.') from None
        except (OSError, ValueError) as error:
            raise TemporaryConnectionError('O MCP não respondeu. Aguardando nova tentativa.') from None

    def _access_token(self, key, config, force=False):
        with (self.path.parent / 'mcp-credentials.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            try:
                latest=self.configs().get(key)
                if latest: config.update(latest)
                return self._access_token_locked(key,config,force)
            finally:
                fcntl.flock(lock,fcntl.LOCK_UN)

    def _access_token_locked(self, key, config, force=False):
        if not force and config.get('access_token') and config.get('expires_at', 0) > time.time() + 60:
            return config['access_token']
        if not config.get('refresh_token') and config.get('management_key'):
            return self._renew_managed(key, config)
        result = self._request(transport_url(config) + '/token', 'POST', {
            'grant_type': 'refresh_token', 'client_id': config['client_id'],
            'refresh_token': config['refresh_token'], 'resource': config['base_url'] + '/mcp'
        }, form=True)
        if not result.get('access_token') or not result.get('refresh_token'):
            raise ConnectionError('A autorização expirou. É necessário reconectar esta instância.')
        config.update(access_token=result['access_token'], refresh_token=result['refresh_token'],
                      expires_at=time.time() + result.get('expires_in', 3600))
        self._save(key, config)
        return config['access_token']

    def _rpc(self, config, token, method, params, call_id):
        # A connection check must never read messages, mark chats read or send.
        if method not in ('initialize', 'tools/list'):
            raise ConnectionError('Operação indisponível nesta etapa.')
        result = self._request(transport_url(config) + '/mcp', 'POST', {
            'jsonrpc': '2.0', 'id': call_id, 'method': method, 'params': params
        }, token=token)
        if 'error' in result or 'result' not in result:
            raise ConnectionError('O MCP não confirmou a conexão.')
        return result['result']

    def check(self, key, force=False):
        with self.file_lock:
            lock = self.locks.setdefault(key, threading.Lock())
        with lock:
            cached = self.cache.get(key)
            if cached and time.time() - cached[0] < 45 and not force:
                return dict(cached[1])
            config = self.configs().get(key)
            if not config:
                return {'connected': False, 'configured': False, 'connection_status': 'unconfigured'}
            result = {'connected': False, 'configured': True, 'connection_status': 'error',
                      'checked_at': datetime.now(timezone.utc).isoformat(), 'access_mode': config.get('access_mode','read_only')}
            try:
                token = self._access_token(key, config)
                health = self._request(transport_url(config) + '/health', token=token)
                # Access tokens live in the MCP process. A restart invalidates them;
                # refresh once when the health endpoint returns its public response.
                if 'whatsapp_ready' not in health:
                    token = self._access_token(key, config, force=True)
                    health = self._request(transport_url(config) + '/health', token=token)
                if 'whatsapp_ready' not in health:
                    raise ConnectionError('Não foi possível autenticar esta instância.')
                if health.get('instance') != config['instance']:
                    raise ConnectionError('A instância não corresponde ao WhatsApp cadastrado.')
                handshake = self._rpc(config, token, 'initialize', {
                    'protocolVersion': '2025-03-26', 'capabilities': {},
                    'clientInfo': {'name': 'agentes-platform', 'version': '1.1.0'}
                }, 1)
                tools = self._rpc(config, token, 'tools/list', {}, 2)
                ready = health['whatsapp_ready'] is True
                result.update(connected=ready, authenticated=True,
                              connection_status='connected' if ready else 'disconnected',
                              instance_display_name=health.get('instance_display_name', config['name']),
                              mcp_version=handshake.get('serverInfo', {}).get('version', health.get('version')),
                              tool_count=len(tools.get('tools', [])),
                              agent_tools_ready=set(['list_contact_labels','get_chats_by_entry_tag','get_agent_chat_state','send_agent_reply','handoff_agent_contact','send_agent_handoff_summary']).issubset({tool['name'] for tool in tools.get('tools',[])}),
                              agent_contacts_ready=any(tool['name']=='enqueue_agent_contact' for tool in tools.get('tools',[])),
                              agent_routes_ready=all(any(tool['name']==name and tool.get('inputSchema',{}).get('properties',{}).get('exit_tags') for tool in tools.get('tools',[])) for name in ('get_chats_by_entry_tag','get_agent_chat_state','send_agent_reply','handoff_agent_contact')),
                              message='Conexão verificada.' if ready else 'O MCP está autorizado, mas a sessão do WhatsApp está desconectada.')
                if ready and result['agent_tools_ready']:
                    labels_response=self._request(transport_url(config)+'/mcp','POST',{
                        'jsonrpc':'2.0','id':4,'method':'tools/call','params':{'name':'list_contact_labels','arguments':{}}},token=token)
                    label_content=labels_response.get('result',{})
                    if not label_content.get('isError'):
                        try:
                            label_info=json.loads(''.join(item.get('text','') for item in label_content.get('content',[]) if item.get('type')=='text'))
                            result['labels_supported']=bool(label_info.get('supported'))
                        except (ValueError,TypeError):
                            result['labels_supported']=False
            except ConnectionError as error:
                result['message'] = str(error)
            except (KeyError, TypeError):
                result['message'] = 'Configuração incompleta. É necessário reconectar esta instância.'
            self.cache[key] = (time.time(), result)
            return dict(result)

    def call_tool(self,key,name,arguments):
        allowed={'list_contact_labels','get_chats_by_entry_tag','get_agent_chat_state','send_agent_reply','handoff_agent_contact','send_agent_handoff_summary','enqueue_agent_contact'}
        if name not in allowed: raise ConnectionError('Ferramenta não autorizada para os agentes.')
        config=self.configs().get(key)
        if not config: raise ConnectionError('WhatsApp não configurado.')
        token=self._access_token(key,config)
        health=self._request(transport_url(config)+'/health',token=token)
        if 'whatsapp_ready' not in health:
            token=self._access_token(key,config,force=True)
            health=self._request(transport_url(config)+'/health',token=token)
        if health.get('instance')!=config['instance']:
            raise ConnectionError('A sessão do WhatsApp não corresponde ao cadastro. Confira a instância selecionada.')
        if health.get('whatsapp_ready') is not True:
            raise TemporaryConnectionError('A sessão do WhatsApp está desconectada. Reconecte em Configurações; o agente aguarda e tentará novamente.')
        response=self._request(transport_url(config)+'/mcp','POST',{
            'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':name,'arguments':arguments}},token=token)
        result=response.get('result',{})
        content=''.join(item.get('text','') for item in result.get('content',[]) if item.get('type')=='text')
        try: parsed=json.loads(content)
        except ValueError: parsed={}
        if 'error' in response or result.get('isError') or parsed.get('success') is not True:
            raise ConnectionError(parsed.get('message','O MCP não confirmou a operação. Nenhum envio será repetido automaticamente.'))
        return parsed

    def all_statuses(self, keys):
        unique = sorted(set(key for key in keys if key))
        if not unique:
            return {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            return dict(zip(unique, pool.map(self.check, unique)))

    def management(self, key, action=None, values=None):
        config = self.configs().get(key)
        if not config or not config.get('management_key'):
            raise ConnectionError('Gerenciamento MCP ainda não configurado para esta instância.')
        # Separate credential keeps management available after access is blocked or expired.
        headers = {'Accept':'application/json','X-MCP-Management-Key':config['management_key']}
        payload = None if action is None else dict(values or {},action=action,instance=config['instance'])
        if payload is not None:
            headers['Content-Type']='application/json'
        req = urllib.request.Request(transport_url(config)+'/api/connection-management',
            data=None if payload is None else json.dumps(payload).encode(),headers=headers,
            method='GET' if payload is None else 'POST')
        try:
            with self.opener.open(req,timeout=8) as response:
                result=json.loads(response.read(65536))
        except urllib.error.HTTPError as error:
            messages={400:'Revise o login, a senha e o prazo de autorização.',403:'Gerenciamento não autorizado.',
                      409:'Login em uso ou conexão sem autorização. Revise os dados.'}
            raise ConnectionError(messages.get(error.code,'Não foi possível gerenciar esta conexão MCP.')) from None
        except (OSError,ValueError):
            raise TemporaryConnectionError('O MCP não respondeu ao gerenciamento. Tente novamente.') from None
        if result.get('instance') != config['instance']:
            raise ConnectionError('A instância não corresponde ao WhatsApp cadastrado.')
        return result

    def reconnect_managed(self,key):
        with (self.path.parent/'mcp-credentials.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            try:
                self._renew_managed(key,self.configs()[key])
            finally:
                fcntl.flock(lock,fcntl.LOCK_UN)

    def _renew_managed(self,key,config):
        tokens=self.management(key,'reconnect').get('tokens',{})
        if not tokens.get('access_token') or not tokens.get('refresh_token'):
            raise ConnectionError('O MCP não confirmou a autorização.')
        config.update(access_token=tokens['access_token'],refresh_token=tokens['refresh_token'],
                      expires_at=time.time()+tokens.get('expires_in',3600))
        self._save(key,config)
        self.cache.pop(key,None)
        return config['access_token']

    def whatsapp_session(self,key,reconnect=False):
        config=self.configs().get(key)
        if not config:raise ConnectionError('WhatsApp não configurado.')
        token=self._access_token(key,config)
        health=self._request(transport_url(config)+'/health',token=token)
        if 'whatsapp_ready' not in health:
            token=self._access_token(key,config,force=True)
            health=self._request(transport_url(config)+'/health',token=token)
        if health.get('instance')!=config['instance']:
            raise ConnectionError('A instância não corresponde ao WhatsApp cadastrado.')
        path='/api/whatsapp-session'+('/reconnect' if reconnect else '')
        result=self._request(transport_url(config)+path,'POST' if reconnect else 'GET',
                             {'instance':config['instance']} if reconnect else None,token=token)
        if result.get('instance')!=config['instance'] or result.get('success') is not True:
            raise ConnectionError('O MCP não confirmou a sessão desta conta.')
        state=result.get('state')
        if state not in ('connected','qr','expired','initializing','authenticating','disconnected','restarting','error'):
            raise ConnectionError('Estado de conexão inválido.')
        qr=result.get('qr_image')
        if qr is not None and (not isinstance(qr,str) or len(qr)>250000 or not qr.startswith('data:image/svg+xml;base64,')):
            raise ConnectionError('QR Code inválido.')
        if state=='connected':
            qr=None
            self.cache.pop(key,None)
        # Only explicit safe fields; no tokens, raw pairing payload or instance internals.
        return {'state':state,'connected':state=='connected','qr_image':qr,
                'expires_at':result.get('expires_at'),'message':str(result.get('message',''))[:500]}
