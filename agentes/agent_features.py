"""Validated contact lists and conditional output labels, shared by UI/API/worker."""
import json
import re
import secrets


def output_routes(agent):
    raw=agent.get('exit_routes',[])
    if isinstance(raw,str):raw=json.loads(raw or '[]')
    return raw or ([{'tag':agent.get('exit_tag',''),'condition':''}] if agent.get('exit_tag') else [])


def validate_routes(data):
    raw=data.get('exit_routes')
    if raw is None:raw=[{'tag':data.get('exit_tag',''),'condition':''}]
    if not isinstance(raw,list) or not 1<=len(raw)<=50:raise ValueError('Informe entre 1 e 50 tags de saída.')
    result=[];seen=set()
    for item in raw:
        if not isinstance(item,dict):raise ValueError('Informe uma saída válida.')
        tag=item.get('tag','');condition=item.get('condition','')
        if not isinstance(tag,str) or not isinstance(condition,str):raise ValueError('Informe textos válidos nas saídas.')
        tag=tag.strip();condition=condition.strip()
        if len(tag)>150 or len(condition)>2000:raise ValueError('Use até 150 caracteres na tag e 2.000 na condição.')
        if len(raw)>1 and not tag:raise ValueError('Preencha o nome de cada tag de saída.')
        if tag.casefold() in seen:raise ValueError('Não repita uma tag de saída no mesmo agente.')
        seen.add(tag.casefold());result.append({'tag':tag,'condition':condition})
    if data.get('exit_routes') is not None and 'exit_tag' in data and data['exit_tag']!=result[0]['tag']:
        raise ValueError('A saída principal deve corresponder à primeira tag de saída.')
    return result


def scope_args(agent,selected=None):
    tags=[route['tag'] for route in output_routes(agent)]
    args={'entry_tag':agent['target_tag'],'exit_tag':selected or agent['exit_tag']}
    if len(tags)>1:args['exit_tags']=tags
    return args


def normalize_phone(value,country='55'):
    if not isinstance(value,str) or not re.fullmatch(r'[+()\d\s.\-]+',value.strip()):
        raise ValueError('Informe um telefone válido com DDD e, para outros países, +DDI.')
    value=value.strip();digits=re.sub(r'\D','',value)
    if digits.startswith('00') and not value.startswith('+'):digits=digits[2:];value='+'
    if not value.startswith('+') and len(digits) in (10,11):digits=country+digits
    if not 10<=len(digits)<=15 or digits.startswith('0') or len(set(digits))<3:
        raise ValueError('Informe um telefone válido com DDD e, para outros países, +DDI.')
    return digits


def contact_changes(data,conn=None,agent_id=None):
    if not isinstance(data,dict):raise ValueError('Lista de contatos inválida.')
    add=data.get('add',[]);remove=data.get('remove',[])
    if not isinstance(add,list) or not isinstance(remove,list) or len(add)>1000 or len(remove)>1000:
        raise ValueError('Salve até 1.000 contatos por lote. A lista pode ter vários lotes.')
    clean=[];seen=set()
    for item in add:
        if not isinstance(item,dict):raise ValueError('Informe nome e telefone válidos.')
        name=item.get('name','')
        if not isinstance(name,str) or len(name.strip())>120:raise ValueError('Use até 120 caracteres no nome do contato.')
        phone=normalize_phone(item.get('phone',''))
        if phone not in seen:clean.append({'name':name.strip(),'phone':phone});seen.add(phone)
    if any(not isinstance(item,str) for item in remove):raise ValueError('Contato inválido para remoção.')
    if remove and conn is not None:
        owned={row[0] for row in conn.execute('SELECT id FROM agent_contacts WHERE agent_id=?',(agent_id,))}
        if not set(remove)<=owned:raise ValueError('Um dos contatos não pertence a este agente.')
    return {'add':clean,'remove':list(set(remove))}


def save_contacts(conn,agent_id,changes):
    for contact_id in changes['remove']:conn.execute('DELETE FROM agent_contacts WHERE id=? AND agent_id=?',(contact_id,agent_id))
    for item in changes['add']:
        conn.execute('''INSERT INTO agent_contacts (id,agent_id,name,phone) VALUES (?,?,?,?)
            ON CONFLICT(agent_id,phone) DO UPDATE SET name=excluded.name''',
            (secrets.token_hex(12),agent_id,item['name'],item['phone']))


def migrate_features(conn):
    columns={row[1] for row in conn.execute('PRAGMA table_info(agents)')}
    if 'exit_routes' not in columns:conn.execute("ALTER TABLE agents ADD COLUMN exit_routes TEXT NOT NULL DEFAULT '[]'")
    conn.execute('''CREATE TABLE IF NOT EXISTS agent_contacts (
        id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL,chat_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',error TEXT NOT NULL DEFAULT '',
        attempts INTEGER NOT NULL DEFAULT 0,retry_at REAL NOT NULL DEFAULT 0,result_tag TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        UNIQUE(agent_id,phone))''')
    conn.execute('CREATE INDEX IF NOT EXISTS agent_contacts_queue ON agent_contacts(agent_id,status,retry_at)')


def register_contact_routes(app,auth_required,db,brain,DATA,fail,action_lock):
    from flask import jsonify,request

    @app.get('/api/agents/<agent_id>/contacts')
    @auth_required
    def list_contacts(agent_id):
        try:offset=max(0,int(request.args.get('offset',0)))
        except ValueError:return fail('Página inválida.')
        with db() as conn:
            if not conn.execute('SELECT 1 FROM agents WHERE id=?',(agent_id,)).fetchone():return fail('Agente não encontrado.',404)
            total=conn.execute('SELECT COUNT(*) FROM agent_contacts WHERE agent_id=?',(agent_id,)).fetchone()[0]
            rows=[dict(row) for row in conn.execute('SELECT * FROM agent_contacts WHERE agent_id=? ORDER BY rowid LIMIT 200 OFFSET ?',(agent_id,offset))]
        return jsonify(contacts=rows,total=total,next_offset=offset+len(rows) if offset+len(rows)<total else None)

    @app.post('/api/agents/<agent_id>/contacts')
    @auth_required
    def update_contacts(agent_id):
        with action_lock(DATA),db() as conn:
            if not conn.execute('SELECT 1 FROM agents WHERE id=?',(agent_id,)).fetchone():return fail('Agente não encontrado.',404)
            try:changes=contact_changes(request.get_json(),conn,agent_id)
            except ValueError as error:return fail(str(error))
            save_contacts(conn,agent_id,changes)
            total=conn.execute('SELECT COUNT(*) FROM agent_contacts WHERE agent_id=?',(agent_id,)).fetchone()[0]
        return jsonify(ok=True,total=total)

    @app.post('/api/contacts/parse')
    @auth_required
    def parse_contacts():
        from openai_brain import BrainError
        text=request.get_json().get('text')
        if not isinstance(text,str) or not text.strip() or len(text)>20000:
            return fail('Cole um texto com até 20.000 caracteres por lote.')
        try:return jsonify(contacts=brain.extract_contacts(text))
        except (ValueError,BrainError) as error:return fail(str(error))
