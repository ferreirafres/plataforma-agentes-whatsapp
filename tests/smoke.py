"""Run inside the web container of a disposable, fresh Compose installation."""
import http.cookiejar
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

app = 'http://127.0.0.1:8000'
mcp = os.environ['MCP_TRANSPORT_URL']
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def request(url, data=None, headers=None, expected=200, json_response=True):
    headers = dict(headers or {})
    if data is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, json.dumps(data).encode() if data is not None else None, headers=headers)
    try:
        result = client.open(req, timeout=10)
    except urllib.error.HTTPError as error:
        result = error
    with result:
        assert result.status == expected, f'{req.method} {url}: HTTP {result.status}'
        return json.load(result) if json_response else result.read()


assert request(app + '/health') == {'status': 'ok'}
assert request(mcp + '/health') == {'status': 'ok'}
request(app + '/api/state', expected=401)
request(mcp + '/mcp', {'jsonrpc': '2.0', 'method': 'tools/list', 'id': 1},
        expected=401, json_response=False)

data_dir = Path(os.environ['DATA_DIR'])
password = (data_dir / 'initial-access.txt').read_text().splitlines()[1].split(': ', 1)[1]
csrf = request(app + '/api/session')['csrf']
login = request(app + '/api/login', {'username': 'admin', 'password': password}, {'X-CSRF-Token': csrf})
headers = {'X-CSRF-Token': login['csrf']}
state = request(app + '/api/state')
assert not state['agents'] and not state['modals'] and not state['columns'], 'Use volumes de teste vazios.'
assert not state['brain']['configured']
account, = state['whatsapps']
assert account['configured'] and not account['connected']

connections = request(app + '/api/mcp-connections')['connections']
assert len(connections) == 1 and connections[0]['managed'] and connections[0]['authorized']
config = json.loads((data_dir / 'mcp-connections.json').read_text())[account['mcp_key']]
tools = request(mcp + '/mcp', {'jsonrpc': '2.0', 'method': 'tools/list', 'id': 2},
                {'Authorization': 'Bearer ' + config['access_token'],
                 'Accept': 'application/json, text/event-stream'})
assert {'search_chats', 'send_message'} <= {tool['name'] for tool in tools['result']['tools']}

session_path = app + '/api/whatsapps/' + account['id'] + '/session'
for _ in range(20):
    session = request(session_path)
    if session['state'] == 'qr':
        assert session['qr_image'].startswith('data:image/svg+xml;base64,')
        break
    time.sleep(2)
else:
    raise AssertionError('Não foi possível gerar o QR do WhatsApp.')

board = next(board for board in state['boards'] if board['whatsapp_id'] == account['id'])
column = request(app + '/api/columns', {'board_id': board['id'], 'name': 'Triagem', 'color': 'green'}, headers)
request(app + '/api/agent-modals', {
    'column_id': column['id'], 'name': 'Atendimento de teste', 'whatsapp_id': account['id'],
    'agents': [{'name': 'Triagem inicial', 'objective': 'Classificar uma solicitação de teste.',
                'target_tag': 'teste-entrada', 'exit_tag': 'teste-saida'}],
}, headers)
state = request(app + '/api/state')
assert state['execution_ready'] and len(state['agents']) == 1 and len(state['modals']) == 1
assert not state['agents'][0]['enabled']
print('Instalação vazia, autenticação, OAuth, ferramentas, QR, worker e criação de agente validados.')
