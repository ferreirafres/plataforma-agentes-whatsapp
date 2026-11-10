"""Private operator conversation and factual runtime diagnostics."""
import hashlib
import json
import time
from agent_features import scope_args,output_routes
from openai_brain import BrainError
from mcp_client import ConnectionError
from agent_modals import validate_modal
from chat_brain import selected_tags

def updates_for(answer,allowed):
    changes=answer.get('updates',[])
    if not isinstance(changes,list) or not changes or len(changes)>len(allowed):raise ValueError('Informe uma alteração válida.')
    result={}
    for item in changes:
        if not isinstance(item,dict) or set(item)!={'field','value'} or item['field'] not in allowed or item['field'] in result:raise ValueError('Campo de alteração inválido.')
        value=item['value']
        if not isinstance(value,str) or len(value)>allowed[item['field']]:raise ValueError('O texto ultrapassa o limite do campo.')
        if item['field'] in ('objective','instructions') and not value.strip():raise ValueError('Objetivo e instruções não podem ficar vazios.')
        result[item['field']]=value.strip()
    return result


def invalidate(conn,ids):
    for aid in ids:
        conn.execute("DELETE FROM agent_jobs WHERE agent_id=? AND stage='planned'",(aid,))
        conn.execute("""UPDATE agents SET revision=revision+1,review_token=review_token+1,retry_at=0,retry_count=0,
            runtime_status=CASE WHEN enabled=1 THEN 'reviewing' ELSE 'off' END,runtime_error='',
            updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?""",(aid,))


def guidance_key(agent):
    return hashlib.sha256(json.dumps([agent.get(k,'') for k in
        ('instructions','objective','identity','context','operator_notes','review_token')],ensure_ascii=False).encode()).hexdigest()


def migrate(conn):
    columns={r[1] for r in conn.execute('PRAGMA table_info(agents)')}
    for name,definition in [('operator_notes',"TEXT NOT NULL DEFAULT ''"),('review_token','INTEGER NOT NULL DEFAULT 0'),('operator_priority',"TEXT NOT NULL DEFAULT 'notes'")]:
        if name not in columns:conn.execute(f'ALTER TABLE agents ADD COLUMN {name} {definition}')
    if 'guidance_key' not in {r[1] for r in conn.execute('PRAGMA table_info(agent_sessions)')}:
        conn.execute("ALTER TABLE agent_sessions ADD COLUMN guidance_key TEXT NOT NULL DEFAULT ''")
    conn.execute('''CREATE TABLE IF NOT EXISTS agent_chat (
        id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        role TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))''')
    conn.execute('''CREATE TABLE IF NOT EXISTS modal_chat (
        id INTEGER PRIMARY KEY AUTOINCREMENT,modal_id TEXT NOT NULL REFERENCES agent_modals(id) ON DELETE CASCADE,
        role TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))''')
    for table in ('agent_chat','modal_chat'):
        if 'changes' not in {r[1] for r in conn.execute('PRAGMA table_info('+table+')')}:
            conn.execute('ALTER TABLE '+table+" ADD COLUMN changes TEXT NOT NULL DEFAULT '[]'")
    conn.execute('CREATE INDEX IF NOT EXISTS agent_chat_history ON agent_chat(agent_id,id)')
    conn.execute('CREATE INDEX IF NOT EXISTS modal_chat_history ON modal_chat(modal_id,id)')


def register(app,auth_required,db,brain,mcp,DATA,fail,action_lock,set_enabled,field):
    from flask import jsonify,request
    import threading
    busy=set();mutex=threading.Lock()

    def snapshot(a):
        with db() as c:
            counts={r['stage']:r['total'] for r in c.execute('SELECT stage,COUNT(*) total FROM agent_jobs WHERE agent_id=? GROUP BY stage',(a['id'],))}
            sessions=[dict(r) for r in c.execute('SELECT chat_id,started,completed FROM agent_sessions WHERE agent_id=?',(a['id'],))]
            heartbeat=c.execute("SELECT value FROM settings WHERE key='worker_heartbeat'").fetchone()
        result={'enabled':bool(a['enabled']),'status':a['runtime_status'],'reason':a['runtime_error'],
            'entry_tag':a['target_tag'],'exit_tag':a['exit_tag'],'jobs':counts,'sessions':sessions,
            'worker_available':bool(heartbeat and time.time()-float(heartbeat[0])<90),'checked_at':time.time()}
        try:
            live=mcp.call_tool(a['mcp_key'],'get_chats_by_entry_tag',scope_args(a))
            result['eligible_contacts']=live['chats']
            result['eligible_count']=len(live['chats'])
        except ConnectionError as error:result['consultation_error']=str(error)
        return result

    @app.get('/api/agents/<aid>/chat')
    @auth_required
    def history(aid):
        with db() as c:
            a=c.execute('SELECT a.*,w.mcp_key FROM agents a LEFT JOIN whatsapps w ON w.id=a.whatsapp_id WHERE a.id=?',(aid,)).fetchone()
            if not a:return fail('Agente não encontrado.',404)
            messages=[dict(r)|{'changes':json.loads(r['changes'])} for r in c.execute('SELECT role,body,created_at,changes FROM (SELECT * FROM agent_chat WHERE agent_id=? ORDER BY id DESC LIMIT 100) ORDER BY id',(aid,))]
        return jsonify(messages=messages,notes=a['operator_notes'],configuration={k:a[k] for k in ('objective','instructions')},diagnostic=snapshot(dict(a)))

    @app.post('/api/agents/<aid>/chat')
    @auth_required
    def converse(aid):
        message=request.get_json().get('message','')
        if not isinstance(message,str) or not message.strip() or len(message)>6000:return fail('Escreva uma mensagem com até 6.000 caracteres.')
        with mutex:
            if aid in busy:return fail('Já estou respondendo neste agente. Aguarde.',409)
            busy.add(aid)
        try:
            with db() as c:
                a=c.execute('SELECT a.*,w.mcp_key FROM agents a LEFT JOIN whatsapps w ON w.id=a.whatsapp_id WHERE a.id=?',(aid,)).fetchone()
                if not a:return fail('Agente não encontrado.',404)
                a=dict(a)
                history=[dict(r) for r in c.execute('SELECT role,body FROM (SELECT * FROM agent_chat WHERE agent_id=? ORDER BY id DESC LIMIT 20) ORDER BY id',(aid,))]
            diagnostic=snapshot(a)
            answer=brain.operator_chat(a,diagnostic,history,message)
            action=answer['action'];effect='Consulta concluída. Nenhuma orientação ou estado foi alterado.';changes=[]
            if action in ('pause','resume'):
                response=app.make_response(set_enabled(aid,action=='resume'))
                if response.status_code>=400:return response
                effect='Agente pausado.' if action=='pause' else 'Agente ligado. O worker continuará o atendimento.'
            elif action in ('remember','forget','recheck','update_agent'):
                with action_lock(DATA),db() as c:
                    current=c.execute('SELECT * FROM agents WHERE id=?',(aid,)).fetchone()
                    if not current or current['revision']!=a['revision']:return fail('O agente mudou durante a conversa. Envie novamente para usar o estado atualizado.',409)
                    if action=='update_agent':
                        values=updates_for(answer,{'objective':5000,'instructions':20000})
                        changes=[{'field':key,'before':current[key],'after':value} for key,value in values.items() if current[key]!=value]
                        if not changes:return fail('O objetivo e as instruções já estão como solicitado.')
                        c.execute('UPDATE agents SET '+','.join(key+'=?' for key in values)+",operator_priority='configuration' WHERE id=?",(*values.values(),aid))
                        invalidate(c,[aid])
                        c.execute('UPDATE agent_modals SET revision=revision+1 WHERE id=?',(current['modal_id'],))
                        effect='Cadastro atualizado. '+('O agente continua ligado e reavaliará a fila no próximo ciclo.' if current['enabled'] else 'O agente permanece desligado; a nova orientação será usada ao retomar.')
                        body=answer['reply']+'\n\n'+effect
                        c.executemany('INSERT INTO agent_chat (agent_id,role,body,changes) VALUES (?,?,?,?)',[(aid,'user',message.strip(),'[]'),(aid,'assistant',body,json.dumps(changes,ensure_ascii=False))])
                        return jsonify(reply=body,action=action,effect=effect,changes=changes)
                    notes=current['operator_notes']
                    if action=='remember':notes=(notes+'\n'+answer['guidance']).strip()
                    if action=='forget':notes=''
                    if len(notes)>12000:return fail('As orientações atingiram 12.000 caracteres. Peça para limpar as orientações antes de adicionar outras.')
                    # Only unsent plans may be regenerated. Partial/uncertain operations retain their journal.
                    c.execute("DELETE FROM agent_jobs WHERE agent_id=? AND stage='planned'",(aid,))
                    c.execute('UPDATE agents SET operator_notes=?,review_token=review_token+1,revision=revision+1,retry_at=0 WHERE id=?',(notes,aid))
                    if action in ('remember','forget'):c.execute("UPDATE agents SET operator_priority='notes' WHERE id=?",(aid,))
                effect={'remember':'Orientação salva para os próximos atendimentos e reavaliação da fila.',
                    'forget':'Orientações adicionais removidas. Cadastro original preservado.',
                    'recheck':'Reavaliação solicitada para o próximo ciclo, consultando o histórico e preservando envios já registrados.'}[action]
                if not a['enabled']:effect+=' O agente continua desligado; peça para retomar quando desejar.'
            body=answer['reply']+'\n\n'+effect
            with db() as c:
                c.executemany('INSERT INTO agent_chat (agent_id,role,body) VALUES (?,?,?)',[(aid,'user',message.strip()),(aid,'assistant',body)])
            return jsonify(reply=body,action=action,effect=effect)
        except (BrainError,ConnectionError,ValueError) as error:return fail(str(error),409)
        finally:
            with mutex:busy.discard(aid)

    def modal_record(mid):
        with db() as c:
            modal=c.execute('SELECT * FROM agent_modals WHERE id=?',(mid,)).fetchone()
            if not modal:return None,[]
            agents=[dict(r) for r in c.execute('SELECT * FROM agents WHERE modal_id=? ORDER BY flow_position,rowid',(mid,))]
        return dict(modal),agents

    def modal_diagnostic(modal,agents):
        result={'agents':[{k:a[k] for k in ('id','name','objective','instructions','target_tag','exit_tag','enabled','runtime_status')} for a in agents]}
        with db() as c:whatsapp=c.execute('SELECT name,mcp_key FROM whatsapps WHERE id=?',(modal['whatsapp_id'],)).fetchone()
        result['whatsapp']=whatsapp['name'] if whatsapp else 'Selecione o WhatsApp da base para criar agentes.'
        try:
            if not whatsapp or not whatsapp['mcp_key']:raise ConnectionError('O WhatsApp da base não está configurado para consultar etiquetas.')
            info=mcp.call_tool(whatsapp['mcp_key'],'list_contact_labels',{})
            if not info.get('supported'):raise ConnectionError('Esta conta não disponibiliza etiquetas Business.')
            result['labels']=info.get('labels',[])
        except ConnectionError as error:result['consultation_error']=str(error)
        return result

    @app.get('/api/agent-modals/<mid>/chat')
    @auth_required
    def modal_history(mid):
        modal,agents=modal_record(mid)
        if not modal:return fail('Modal não encontrado.',404)
        with db() as c:messages=[dict(r)|{'changes':json.loads(r['changes'])} for r in c.execute('SELECT role,body,created_at,changes FROM (SELECT * FROM modal_chat WHERE modal_id=? ORDER BY id DESC LIMIT 100) ORDER BY id',(mid,))]
        return jsonify(messages=messages,configuration={k:modal[k] for k in ('identity','context')},diagnostic=modal_diagnostic(modal,agents))

    @app.post('/api/agent-modals/<mid>/chat')
    @auth_required
    def modal_converse(mid):
        message=request.get_json().get('message','')
        if not isinstance(message,str) or not message.strip() or len(message)>6000:return fail('Escreva uma mensagem com até 6.000 caracteres.')
        key='modal:'+mid
        with mutex:
            if key in busy:return fail('Já estou respondendo neste modal. Aguarde.',409)
            busy.add(key)
        try:
            modal,agents=modal_record(mid)
            if not modal:return fail('Modal não encontrado.',404)
            with db() as c:history=[dict(r) for r in c.execute('SELECT role,body FROM (SELECT * FROM modal_chat WHERE modal_id=? ORDER BY id DESC LIMIT 20) ORDER BY id',(mid,))]
            diagnostic=modal_diagnostic(modal,agents)
            answer=brain.modal_chat({k:modal[k] for k in ('name','identity','context')},diagnostic,history,message)
            action=answer['action'];changes=[];created=None;effect='Consulta concluída. Nenhum cadastro foi alterado.'
            with action_lock(DATA),db() as c:
                current=c.execute('SELECT * FROM agent_modals WHERE id=?',(mid,)).fetchone()
                current_agents=[dict(r) for r in c.execute('SELECT * FROM agents WHERE modal_id=? ORDER BY flow_position,rowid',(mid,))]
                if not current or current['revision']!=modal['revision'] or [(a['id'],a['revision']) for a in agents]!=[(a['id'],a['revision']) for a in current_agents]:
                    return fail('O modal ou seus agentes mudaram durante a conversa. Envie novamente para considerar o estado atualizado.',409)
                if action=='update_modal':
                    values=updates_for(answer,{'identity':10000,'context':50000})
                    changes=[{'field':k,'before':current[k],'after':v} for k,v in values.items() if current[k]!=v]
                    if not changes:return fail('A identidade e o contexto já estão como solicitado.')
                    c.execute('UPDATE agent_modals SET '+','.join(k+'=?' for k in values)+',revision=revision+1 WHERE id=?',(*values.values(),mid))
                    c.execute('UPDATE agents SET '+','.join(k+'=?' for k in values)+' WHERE modal_id=?',(*values.values(),mid))
                    invalidate(c,[a['id'] for a in agents])
                    effect=f'Base compartilhada atualizada para os {len(agents)} agente(s). Os agentes ligados reavaliarão a fila; os desligados permanecem desligados.'
                elif action=='create_agent':
                    draft=answer.get('new_agent')
                    if not isinstance(draft,dict) or set(draft)!={'name','objective','instructions','target_tag','exit_routes'}:raise ValueError('Cadastro do novo agente inválido.')
                    if not all(isinstance(draft[k],str) and draft[k].strip() for k in ('name','objective','instructions','target_tag')):raise ValueError('Informe nome, objetivo, instruções e tag de entrada para criar a etapa.')
                    if diagnostic.get('consultation_error'):raise ValueError(diagnostic['consultation_error'])
                    if not current['whatsapp_id']:raise ValueError('Selecione o WhatsApp da base no cadastro do modal antes de criar agentes pelo chat.')
                    existing_stages=[{**a,'entry_auto':bool(a['entry_auto']),'whatsapp_id':'' if a['whatsapp_inherited'] else a['whatsapp_id'],'exit_routes':output_routes(a)} for a in current_agents]
                    base,stages,_,_=validate_modal(dict(current)|{'agents':existing_stages+[draft|{'whatsapp_id':'','entry_auto':False}]},c,field,current)
                    new=stages[-1]
                    names=[new['target_tag'],*[r['tag'] for r in output_routes(new)]]
                    if not selected_tags(names,history,message):raise ValueError('Informe explicitamente as etiquetas de entrada e saída que deseja usar para o novo agente.')
                    for tag in [new['target_tag'],*[r['tag'] for r in output_routes(new)]]:
                        if len([l for l in diagnostic['labels'] if l['name'].strip().casefold()==tag.strip().casefold()])!=1:raise ValueError(f'A etiqueta “{tag}” deve existir com nome único no WhatsApp da base.')
                    values={k:v for k,v in new.items() if k not in ('id','contact_changes')}
                    values.update(modal_id=mid,position=new['flow_position'])
                    c.execute('INSERT INTO agents (id,'+','.join(values)+') VALUES ('+','.join('?' for _ in range(len(values)+1))+')',(new['id'],*values.values()))
                    c.execute('UPDATE agent_modals SET revision=revision+1 WHERE id=?',(mid,))
                    created=new['id']
                    effect=f'Agente “{new["name"]}” criado neste modal, desligado. Entrada: {new["target_tag"]}. Saída(s): '+', '.join(r['tag'] for r in output_routes(new))+'. Ligue pelo interruptor ou peça para retomar no chat dessa etapa.'
                    details=f'Nome: {new["name"]}\nObjetivo: {new["objective"]}\nInstruções: {new["instructions"]}\nEntrada: {new["target_tag"]}\nSaídas: '+ '\n'.join(r['tag']+(' — '+r['condition'] if r['condition'] else '') for r in output_routes(new))
                    changes=[{'field':'Novo agente','before':'(não existia)','after':details}]
                elif action!='query':raise ValueError('Ação indisponível no chat do modal.')
                body=answer['reply']+'\n\n'+effect
                c.executemany('INSERT INTO modal_chat (modal_id,role,body,changes) VALUES (?,?,?,?)',[(mid,'user',message.strip(),'[]'),(mid,'assistant',body,json.dumps(changes,ensure_ascii=False))])
            return jsonify(reply=body,action=action,effect=effect,changes=changes,created_agent_id=created)
        except (BrainError,ConnectionError,ValueError) as error:return fail(str(error),409)
        finally:
            with mutex:busy.discard(key)
