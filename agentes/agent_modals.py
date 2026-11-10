"""Shared knowledge and ordered, independently activated workflow agents."""
import secrets
import json
from agent_features import validate_routes,contact_changes,save_contacts,output_routes


def migrate(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS agent_modals (
        id TEXT PRIMARY KEY, column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
        name TEXT NOT NULL, identity TEXT NOT NULL DEFAULT '', context TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '', whatsapp_id TEXT REFERENCES whatsapps(id),
        position INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0)''')
    columns = {row[1] for row in conn.execute('PRAGMA table_info(agents)')}
    for name, definition in [('modal_id', 'TEXT REFERENCES agent_modals(id)'),
                             ('flow_position', 'INTEGER NOT NULL DEFAULT 0'),
                             ('entry_auto', 'INTEGER NOT NULL DEFAULT 0'),
                             ('whatsapp_inherited', 'INTEGER NOT NULL DEFAULT 1'),
                             ('context', "TEXT NOT NULL DEFAULT ''")]:
        if name not in columns:
            conn.execute(f'ALTER TABLE agents ADD COLUMN {name} {definition}')
    # Preserve IDs, activation, revisions, history and pending jobs on upgrade.
    for agent in conn.execute('SELECT * FROM agents WHERE modal_id IS NULL').fetchall():
        modal_id = secrets.token_hex(12)
        conn.execute('''INSERT INTO agent_modals
            (id,column_id,name,identity,context,description,whatsapp_id,position) VALUES (?,?,?,?,?,?,?,?)''',
            (modal_id, agent['column_id'], agent['name'], agent['identity'], agent['context'],
             agent['description'], agent['whatsapp_id'], agent['position']))
        conn.execute('UPDATE agents SET modal_id=? WHERE id=?', (modal_id, agent['id']))
    conn.execute('CREATE INDEX IF NOT EXISTS agents_modal_order ON agents(modal_id,flow_position)')


def create_legacy_modal(conn, agent_id):
    agent = conn.execute('SELECT * FROM agents WHERE id=?', (agent_id,)).fetchone()
    modal_id = secrets.token_hex(12)
    conn.execute('''INSERT INTO agent_modals
        (id,column_id,name,identity,context,description,whatsapp_id,position) VALUES (?,?,?,?,?,?,?,?)''',
        (modal_id, agent['column_id'], agent['name'], agent['identity'], agent['context'],
         agent['description'], agent['whatsapp_id'], agent['position']))
    conn.execute('UPDATE agents SET modal_id=? WHERE id=?', (modal_id, agent_id))


def validate_modal(data, conn, field, existing=None):
    base = {key: field(data, key, limit, key in ('name', 'column_id')) for key, limit in
            [('name', 120), ('column_id', 40), ('identity', 10000), ('context', 50000), ('description', 300)]}
    board = conn.execute('''SELECT b.* FROM boards b JOIN columns c ON c.board_id=b.id
        WHERE c.id=?''', (base['column_id'],)).fetchone()
    if not board:
        raise ValueError('Selecione uma coluna válida.')
    if existing:
        origin = conn.execute('SELECT board_id FROM columns WHERE id=?', (existing['column_id'],)).fetchone()[0]
        if origin != board['id']:
            raise ValueError('Escolha uma coluna do mesmo quadro.')

    def account(value):
        if value is not None and not isinstance(value, str):
            raise ValueError('Selecione um WhatsApp válido.')
        value = value or None
        if value and not conn.execute('SELECT 1 FROM whatsapps WHERE id=?', (value,)).fetchone():
            raise ValueError('Selecione um WhatsApp válido.')
        if board['whatsapp_id'] and value and value != board['whatsapp_id']:
            raise ValueError('Use o WhatsApp vinculado a este quadro.')
        return board['whatsapp_id'] or value

    base['whatsapp_id'] = account(data.get('whatsapp_id'))
    raw = data.get('agents')
    if not isinstance(raw, list) or not 1 <= len(raw) <= 50:
        raise ValueError('Adicione entre 1 e 50 agentes ao modal.')
    owned = {r['id']: dict(r) for r in conn.execute('SELECT * FROM agents WHERE modal_id=?',
             (existing['id'],)).fetchall()} if existing else {}
    stages, seen, entries = [], set(), set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError('Informe um agente válido.')
        agent_id = item.get('id')
        if agent_id is not None and (not isinstance(agent_id, str) or agent_id not in owned or agent_id in seen):
            raise ValueError('Um dos agentes não pertence a este modal ou está repetido.')
        if agent_id:
            seen.add(agent_id)
        values = {key: field(item, key, limit, key == 'name') for key, limit in
                  [('name', 120), ('objective', 5000), ('instructions', 20000), ('target_tag', 150), ('exit_tag', 150)]}
        routes=validate_routes(item)
        values['exit_tag']=routes[0]['tag']
        values['exit_routes']=json.dumps(routes,ensure_ascii=False)
        changes=contact_changes(item.get('contact_changes',{}),conn,agent_id)
        if 'entry_auto' in item and not isinstance(item['entry_auto'], bool):
            raise ValueError('Configuração de entrada automática inválida.')
        auto = index > 0 and (item.get('entry_auto', False) or not values['target_tag'])
        values['entry_auto'] = int(auto)
        inherited = not item.get('whatsapp_id')
        values['whatsapp_inherited'] = int(inherited)
        values['whatsapp_id'] = base['whatsapp_id'] if inherited else account(item['whatsapp_id'])
        if auto:
            values['target_tag'] = stages[-1]['exit_tag']
            if values['whatsapp_id'] != stages[-1]['whatsapp_id']:
                raise ValueError('A entrada automática exige o mesmo WhatsApp da etapa anterior. Selecione uma entrada manual para contas diferentes.')
        if values['target_tag'] and any(values['target_tag'].casefold()==route['tag'].casefold() for route in routes):
            raise ValueError(f'Agente {index + 1}: use tags diferentes para entrada e saída.')
        if values['target_tag']:
            scope = (values['whatsapp_id'], values['target_tag'].casefold())
            if scope in entries:
                raise ValueError('Dois agentes do modal não podem ter a mesma entrada no mesmo WhatsApp.')
            entries.add(scope)
        values.update(id=agent_id or secrets.token_hex(12), flow_position=index,
                      column_id=base['column_id'], identity=base['identity'], context=base['context'],
                      description=base['description'])
        values['contact_changes']=changes
        stages.append(values)
    # A completed label must not return the contact to an earlier step.
    for index, stage in enumerate(stages):
        if any(route['tag'] and previous['whatsapp_id']==stage['whatsapp_id'] and
                previous['target_tag'].casefold()==route['tag'].casefold()
                for previous in stages[:index] for route in json.loads(stage['exit_routes'])):
            raise ValueError('A tag de saída retorna a uma etapa anterior. Use outra tag para evitar um ciclo.')
    removed = set(owned) - seen
    for agent_id in removed:
        if conn.execute("SELECT 1 FROM agent_jobs WHERE agent_id=? AND stage='uncertain'", (agent_id,)).fetchone():
            raise ValueError('Há um envio com resultado incerto no agente removido. Confira a conversa antes de excluir.')
    return base, stages, owned, removed


def save_modal(conn, modal_id, base, stages, owned, removed):
    for agent_id in removed:
        conn.execute('DELETE FROM agents WHERE id=?', (agent_id,))
    for stage in stages:
        values = {key: value for key, value in stage.items() if key not in ('id','contact_changes')}
        values['modal_id'] = modal_id
        agent_id = stage['id']
        if agent_id in owned:
            old = owned[agent_id]
            if any(old[key]!=values[key] for key in ('objective','instructions')):
                values['operator_priority']='configuration'
            conn.execute('UPDATE agents SET ' + ','.join(key + '=?' for key in values) +
                ",enabled=0,revision=revision+1,runtime_status='off',runtime_error='',stop_code='edited',stop_reason='Modal alterado. A base ou as etapas foram salvas; revise e ligue o agente novamente para continuar.',stopped_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),retry_at=0,retry_count=0,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",
                (*values.values(), agent_id))
            conn.execute("DELETE FROM agent_jobs WHERE agent_id=? AND stage NOT IN ('done','uncertain')", (agent_id,))
            if any(old[key] != values[key] for key in ('whatsapp_id', 'target_tag', 'exit_tag')) or output_routes(old)!=output_routes(values):
                conn.execute('DELETE FROM agent_sessions WHERE agent_id=?', (agent_id,))
                conn.execute("UPDATE agent_contacts SET status='pending',chat_id=NULL,error='',attempts=0,retry_at=0 WHERE agent_id=? AND status IN ('pending','queued','error')",(agent_id,))
        else:
            values['position'] = stage['flow_position']
            conn.execute('INSERT INTO agents (id,' + ','.join(values) + ') VALUES (' +
                         ','.join('?' for _ in range(len(values) + 1)) + ')', (agent_id, *values.values()))
        save_contacts(conn,agent_id,stage['contact_changes'])
