import fcntl
import json
import os
import secrets
import sqlite3
import threading
import time
from datetime import timedelta
from functools import wraps
from pathlib import Path

from flask import Flask, jsonify, request, session
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash
from mcp_client import MCPConnections
from openai_brain import OpenAIBrain
from runtime_lock import action_lock
from agent_modals import migrate as migrate_modals, create_legacy_modal, validate_modal, save_modal
from agent_features import migrate_features,output_routes,validate_routes,register_contact_routes
from agent_chat import migrate as migrate_chat,register as register_chat
from chat_audio import register as register_audio,MAX_AUDIO
from mcp_settings import register as register_mcp_settings

DATA = Path(os.environ.get('DATA_DIR', './data'))
DATA.mkdir(parents=True, exist_ok=True)
mcp = MCPConnections(DATA / 'mcp-connections.json')
if bootstrap_file := os.environ.get('MCP_BOOTSTRAP_FILE'):
    bootstrap = json.loads(Path(bootstrap_file).read_text())
    if transport := os.environ.get('MCP_TRANSPORT_URL'):
        bootstrap['transport_url'] = transport.rstrip('/')
    key = bootstrap['instance']
    with (DATA / 'mcp-credentials.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        previous = mcp.configs().get(key, {})
        if any(bootstrap.get(k) != previous.get(k) for k in ('base_url', 'client_id', 'management_key')):
            mcp._save(key, bootstrap)
        elif any(previous.get(k) != v for k, v in bootstrap.items()):
            mcp._save(key, previous | bootstrap)
brain = OpenAIBrain(DATA / 'openai-config.json')
secret_file = DATA / 'session.key'
if not secret_file.exists():
    secret_file.write_text(secrets.token_hex(32))
    secret_file.chmod(0o600)

app = Flask(__name__, static_folder='static')
if proxy_hops := int(os.environ.get('AGENTES_PROXY_HOPS', '0')):
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=proxy_hops, x_proto=proxy_hops)
app.config.update(SECRET_KEY=secret_file.read_text().strip(), MAX_CONTENT_LENGTH=2097152,
                  SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Lax',
                  SESSION_COOKIE_SECURE=os.environ.get('COOKIE_SECURE', '1') == '1',
                  PERMANENT_SESSION_LIFETIME=timedelta(hours=12))

def db():
    conn = sqlite3.connect(DATA / 'agents.sqlite3', timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys=ON')
    return conn

with db() as conn:
    conn.executescript('''
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS columns (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, position INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS whatsapps (id TEXT PRIMARY KEY, name TEXT NOT NULL, endpoint TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, column_id TEXT NOT NULL REFERENCES columns(id),
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
      objective TEXT NOT NULL DEFAULT '', target_tag TEXT NOT NULL DEFAULT '',
      whatsapp_id TEXT REFERENCES whatsapps(id), enabled INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    ''')
    agent_columns = {r[1] for r in conn.execute('PRAGMA table_info(agents)')}
    for name, definition in [('exit_tag', "TEXT NOT NULL DEFAULT ''"),('revision','INTEGER NOT NULL DEFAULT 0'),
                             ('runtime_status',"TEXT NOT NULL DEFAULT 'off'"),('runtime_error',"TEXT NOT NULL DEFAULT ''"),
                             ('identity',"TEXT NOT NULL DEFAULT ''"),
                             ('stop_reason',"TEXT NOT NULL DEFAULT ''"),('stop_code',"TEXT NOT NULL DEFAULT ''"),
                             ('stopped_at','TEXT'),('retry_at','REAL NOT NULL DEFAULT 0'),('retry_count','INTEGER NOT NULL DEFAULT 0')]:
        if name not in agent_columns: conn.execute(f'ALTER TABLE agents ADD COLUMN {name} {definition}')
    conn.executescript('''
    CREATE TABLE IF NOT EXISTS agent_sessions (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, chat_id TEXT NOT NULL,
      started INTEGER NOT NULL DEFAULT 0, last_incoming TEXT NOT NULL DEFAULT '',
      completed INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(agent_id,chat_id));
    CREATE TABLE IF NOT EXISTS agent_jobs (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL, decision TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'planned',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    ''')
    if not conn.execute("SELECT 1 FROM settings WHERE key='real_execution_migrated'").fetchone():
        conn.execute("UPDATE agents SET enabled=0, runtime_status='off', revision=revision+1")
        conn.execute("INSERT INTO settings VALUES ('real_execution_migrated','1')")
    if 'mcp_key' not in [r[1] for r in conn.execute('PRAGMA table_info(whatsapps)')]:
        conn.execute('ALTER TABLE whatsapps ADD COLUMN mcp_key TEXT')
    conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_mcp_key ON whatsapps(mcp_key)')
    for key, config in mcp.configs().items():
        if conn.execute('SELECT 1 FROM whatsapps WHERE mcp_key=?', (key,)).fetchone():
            continue
        existing = conn.execute('SELECT id FROM whatsapps WHERE mcp_key IS NULL AND rtrim(endpoint,\'/\') IN (?,?) ORDER BY rowid LIMIT 1',
                                (config['base_url'], config['base_url'] + '/mcp')).fetchone()
        if existing:
            conn.execute('UPDATE whatsapps SET mcp_key=?, name=?, endpoint=? WHERE id=?',
                         (key, config['name'], config['base_url'], existing['id']))
        else:
            conn.execute('INSERT INTO whatsapps (id,name,endpoint,mcp_key) VALUES (?,?,?,?)',
                         (secrets.token_hex(12), config['name'], config['base_url'], key))
    conn.execute('CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, whatsapp_id TEXT REFERENCES whatsapps(id), position INTEGER NOT NULL)')
    if 'board_id' not in [r[1] for r in conn.execute('PRAGMA table_info(columns)')]:
        conn.execute('ALTER TABLE columns ADD COLUMN board_id TEXT REFERENCES boards(id)')
        # Keep the existing kanban intact; bind it only when its agents agree on one account.
        accounts = [r[0] for r in conn.execute('SELECT DISTINCT whatsapp_id FROM agents')]
        wid = accounts[0] if len(accounts)==1 and accounts[0] else None
        account = conn.execute('SELECT name FROM whatsapps WHERE id=?',(wid,)).fetchone()
        conn.execute('INSERT INTO boards VALUES (?,?,?,0)',('main',account['name'] if account else 'Meu quadro',wid))
        conn.execute("UPDATE columns SET board_id='main'")
        for position, whatsapp in enumerate(conn.execute('SELECT id,name FROM whatsapps WHERE mcp_key IS NOT NULL AND id IS NOT ?',(wid,)).fetchall(),1):
            conn.execute('INSERT INTO boards VALUES (?,?,?,?)',(secrets.token_hex(12),whatsapp['name'],whatsapp['id'],position))
    migrate_modals(conn)
    migrate_features(conn)
    migrate_chat(conn)
    # Existing errors have a known reason, but their stop time was not recorded.
    # Do not invent a timestamp or a manual-stop reason for older registrations.
    conn.execute("""UPDATE agents SET stop_reason=runtime_error,stop_code='error'
        WHERE enabled=0 AND runtime_status='error' AND stop_reason='' AND runtime_error!=''""")
    conn.execute("""UPDATE agents SET stop_reason='Fila encerrada com os atendimentos e a troca de etiquetas confirmados.',stop_code='completed'
        WHERE enabled=0 AND runtime_status='completed' AND stop_reason=''""")
    if not conn.execute("SELECT 1 FROM settings WHERE key='password'").fetchone():
        password = secrets.token_urlsafe(15)
        conn.execute('INSERT INTO settings VALUES (?,?)', ('password', generate_password_hash(password)))
        conn.execute('INSERT INTO settings VALUES (?,?)', ('auth_version', '1'))
        access = DATA / 'initial-access.txt'
        access.write_text(f'Usuário: admin\nSenha inicial: {password}\n')
        access.chmod(0o600)

def fail(message, status=400):
    return jsonify(error=message), status

def auth_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        with db() as conn:
            version = conn.execute("SELECT value FROM settings WHERE key='auth_version'").fetchone()[0]
        if not session.get('logged_in') or session.get('auth_version') != version:
            return fail('Entre novamente para continuar.', 401)
        return fn(*args, **kwargs)
    return wrapper

@app.before_request
def csrf():
    if request.path.startswith('/api/') and request.method in ('POST', 'PUT', 'DELETE', 'PATCH'):
        if not session.get('csrf') or not secrets.compare_digest(session['csrf'], request.headers.get('X-CSRF-Token', '')):
            return fail('Sessão expirada. Atualize a página.', 403)
        audio_request=request.path.endswith('/chat/transcribe') and request.mimetype=='multipart/form-data'
        if audio_request:request.max_content_length=MAX_AUDIO+65536
        if request.method in ('POST', 'PUT', 'PATCH') and request.path != '/api/logout' and not audio_request and not isinstance(request.get_json(), dict):
            return fail('Envie um objeto JSON válido.')

@app.after_request
def headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'same-origin'
    response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    response.headers['Cache-Control'] = 'no-store' if request.path.startswith('/api/') or request.path == '/' else 'no-cache'
    return response

@app.errorhandler(413)
def too_large(_):
    return fail('O conteúdo ultrapassou o limite permitido.', 413)

@app.errorhandler(404)
def not_found(_):
    return fail('Registro não encontrado.', 404)

@app.errorhandler(415)
def invalid_json(_):
    return fail('Envie dados em JSON.', 415)

@app.errorhandler(400)
def invalid_request(_):
    return fail('Dados inválidos.', 400)

@app.get('/')
def index():
    return app.send_static_file('index.html')

register_mcp_settings(app,auth_required,db,mcp,fail)

@app.get('/health')
def health():
    with db() as conn:
        conn.execute('SELECT 1')
    return jsonify(status='ok')

@app.get('/sw.js')
def service_worker():
    response=app.send_static_file('sw.js')
    response.headers['Service-Worker-Allowed']='/'
    return response

@app.get('/api/session')
def current_session():
    if 'csrf' not in session:
        session['csrf'] = secrets.token_hex(24)
    with db() as conn:
        version = conn.execute("SELECT value FROM settings WHERE key='auth_version'").fetchone()[0]
    return jsonify(authenticated=bool(session.get('logged_in') and session.get('auth_version') == version), csrf=session['csrf'])

attempts = {}
attempts_lock = threading.Lock()

@app.post('/api/login')
def login():
    data = request.get_json()
    ip = request.remote_addr
    now = time.time()
    with attempts_lock:
        for key in list(attempts):
            attempts[key] = [t for t in attempts[key] if now-t < 900]
            if not attempts[key]:
                del attempts[key]
        recent = attempts.get(ip, [])
        if len(recent) >= 10:
            return fail('Muitas tentativas. Aguarde 15 minutos.', 429)
        attempts[ip] = recent + [now]
    with db() as conn:
        password_hash = conn.execute("SELECT value FROM settings WHERE key='password'").fetchone()[0]
        version = conn.execute("SELECT value FROM settings WHERE key='auth_version'").fetchone()[0]
    if data.get('username') != 'admin' or not check_password_hash(password_hash, str(data.get('password', ''))):
        return fail('Usuário ou senha incorretos.', 401)
    with attempts_lock:
        attempts.pop(ip, None)
    session.clear()
    session.update(logged_in=True, auth_version=version, csrf=secrets.token_hex(24))
    session.permanent = True
    return jsonify(csrf=session['csrf'])

@app.post('/api/logout')
def logout():
    session.clear()
    return jsonify(ok=True)

@app.post('/api/password')
@auth_required
def change_password():
    data = request.get_json()
    password = str(data.get('password', ''))
    if len(password) < 12 or len(password) > 128:
        return fail('Use uma senha com 12 a 128 caracteres.')
    with db() as conn:
        old = conn.execute("SELECT value FROM settings WHERE key='password'").fetchone()[0]
        if not check_password_hash(old, str(data.get('current_password', ''))):
            return fail('A senha atual está incorreta.')
        version = str(int(conn.execute("SELECT value FROM settings WHERE key='auth_version'").fetchone()[0]) + 1)
        conn.execute("UPDATE settings SET value=? WHERE key='password'", (generate_password_hash(password),))
        conn.execute("UPDATE settings SET value=? WHERE key='auth_version'", (version,))
    session['auth_version'] = version
    (DATA / 'initial-access.txt').unlink(missing_ok=True)
    return jsonify(ok=True)

@app.get('/api/state')
@auth_required
def state():
    with db() as conn:
        boards = [dict(r) for r in conn.execute('SELECT * FROM boards ORDER BY position, rowid')]
        columns = [dict(r) for r in conn.execute('SELECT * FROM columns ORDER BY position, rowid')]
        agents = [dict(r) for r in conn.execute('SELECT * FROM agents ORDER BY position, rowid')]
        counts={row['agent_id']:dict(row) for row in conn.execute("SELECT agent_id,COUNT(*) AS total,SUM(status='pending') AS pending,SUM(status='error') AS errors FROM agent_contacts GROUP BY agent_id")}
        for agent in agents:
            agent['exit_routes']=output_routes(agent)
            agent['contacts_count']=counts.get(agent['id'],{}).get('total',0)
            agent['contacts_pending']=counts.get(agent['id'],{}).get('pending',0)
            agent['contacts_errors']=counts.get(agent['id'],{}).get('errors',0)
        modals = [dict(r) for r in conn.execute('SELECT * FROM agent_modals ORDER BY position,rowid')]
        whatsapps = [dict(r) for r in conn.execute('SELECT * FROM whatsapps ORDER BY rowid')]
    statuses = mcp.all_statuses([w['mcp_key'] for w in whatsapps])
    for whatsapp in whatsapps:
        whatsapp.update(statuses.get(whatsapp['mcp_key'], {'connected': False, 'configured': False, 'connection_status': 'unconfigured'}))
    return jsonify(boards=boards, columns=columns, agents=agents, modals=modals, whatsapps=whatsapps,
                   integration_ready=any(w['connected'] for w in whatsapps), execution_ready=worker_ready(), brain=brain.status())

def worker_ready():
    with db() as conn:
        last=conn.execute("SELECT value FROM settings WHERE key='worker_heartbeat'").fetchone()
    return bool(last and time.time()-float(last[0])<90)

@app.post('/api/brain/check')
@auth_required
def check_brain():
    return jsonify(brain.check())

def field(data, key, limit, required=False):
    value = data.get(key, '')
    if not isinstance(value, str):
        raise ValueError('Informe um texto válido.')
    value = value.strip()
    if required and not value:
        raise ValueError('Preencha os campos obrigatórios.')
    if len(value) > limit:
        raise ValueError(f'O campo ultrapassa {limit} caracteres.')
    return value

COLORS = ('green', 'blue', 'purple', 'orange', 'pink')

@app.route('/api/boards', methods=['POST'])
@app.route('/api/boards/<item_id>', methods=['PUT','DELETE'])
@auth_required
def boards(item_id=None):
    with action_lock(DATA), db() as conn:
        existing=conn.execute('SELECT * FROM boards WHERE id=?',(item_id,)).fetchone() if item_id else None
        if item_id and not existing:return fail('Quadro não encontrado.',404)
        if request.method=='DELETE':
            if conn.execute('SELECT 1 FROM columns WHERE board_id=?',(item_id,)).fetchone():
                return fail('Remova as colunas antes de excluir este quadro.',409)
            conn.execute('DELETE FROM boards WHERE id=?',(item_id,))
        else:
            data=request.get_json()
            try:name=field(data,'name',100,True)
            except ValueError as error:return fail(str(error))
            wid=data.get('whatsapp_id') or None
            if wid and (not isinstance(wid,str) or not conn.execute('SELECT 1 FROM whatsapps WHERE id=?',(wid,)).fetchone()):
                return fail('Selecione um WhatsApp válido.')
            if existing and existing['whatsapp_id']!=wid and conn.execute('SELECT 1 FROM agents a JOIN columns c ON c.id=a.column_id WHERE c.board_id=?',(item_id,)).fetchone():
                return fail('O WhatsApp de um quadro com agentes não pode ser alterado. Crie outro quadro para essa conta.',409)
            if item_id:conn.execute('UPDATE boards SET name=?,whatsapp_id=? WHERE id=?',(name,wid,item_id))
            else:
                item_id=secrets.token_hex(12)
                position=conn.execute('SELECT COALESCE(MAX(position),-1)+1 FROM boards').fetchone()[0]
                conn.execute('INSERT INTO boards VALUES (?,?,?,?)',(item_id,name,wid,position))
    return jsonify(ok=True,id=item_id)

@app.route('/api/columns', methods=['POST'])
@app.route('/api/columns/<item_id>', methods=['PUT', 'DELETE'])
@auth_required
def columns(item_id=None):
    with db() as conn:
        if item_id and not conn.execute('SELECT 1 FROM columns WHERE id=?', (item_id,)).fetchone():
            return fail('Coluna não encontrada.', 404)
        if request.method == 'DELETE':
            if conn.execute('SELECT 1 FROM agents WHERE column_id=?', (item_id,)).fetchone():
                return fail('Mova ou exclua os agentes antes de excluir esta coluna.', 409)
            conn.execute('DELETE FROM columns WHERE id=?', (item_id,))
        else:
            data = request.get_json()
            try:
                name = field(data, 'name', 80, True)
            except ValueError as e:
                return fail(str(e))
            color = data.get('color', 'green')
            if color not in COLORS:
                return fail('Cor inválida.')
            if item_id:
                conn.execute('UPDATE columns SET name=?, color=? WHERE id=?', (name, color, item_id))
            else:
                bid=data.get('board_id','main')
                if not isinstance(bid,str) or not conn.execute('SELECT 1 FROM boards WHERE id=?',(bid,)).fetchone():
                    return fail('Selecione um quadro válido.')
                item_id = secrets.token_hex(12)
                position = conn.execute('SELECT COALESCE(MAX(position), -1)+1 FROM columns WHERE board_id=?',(bid,)).fetchone()[0]
                conn.execute('INSERT INTO columns (id,name,color,position,board_id) VALUES (?,?,?,?,?)', (item_id, name, color, position,bid))
    return jsonify(ok=True, id=item_id)

@app.put('/api/columns-order')
@auth_required
def reorder_columns():
    ids = request.get_json().get('ids', [])
    with db() as conn:
        bid=request.get_json().get('board_id','main')
        if not isinstance(bid,str) or not conn.execute('SELECT 1 FROM boards WHERE id=?',(bid,)).fetchone():return fail('Quadro inválido.')
        actual = [r[0] for r in conn.execute('SELECT id FROM columns WHERE board_id=?',(bid,))]
        if not isinstance(ids, list) or any(not isinstance(i, str) for i in ids) or len(ids) != len(actual) or set(ids) != set(actual):
            return fail('Ordem inválida.')
        conn.executemany('UPDATE columns SET position=? WHERE id=?', enumerate(ids))
    return jsonify(ok=True)

def agent_values(data, conn):
    values = {k: field(data, k, limit, k in ('name', 'column_id')) for k, limit in
              (('name', 120), ('column_id', 40), ('description', 300), ('identity',10000), ('context',50000), ('instructions', 20000), ('objective', 5000), ('target_tag', 150), ('exit_tag',150))}
    routes=validate_routes(data)
    values['exit_tag']=routes[0]['tag']
    values['exit_routes']=json.dumps(routes,ensure_ascii=False)
    if not conn.execute('SELECT 1 FROM columns WHERE id=?', (values['column_id'],)).fetchone():
        raise ValueError('Selecione uma coluna válida.')
    wid = data.get('whatsapp_id') or None
    if wid and (not isinstance(wid, str) or not conn.execute('SELECT 1 FROM whatsapps WHERE id=?', (wid,)).fetchone()):
        raise ValueError('Selecione um WhatsApp válido.')
    values['whatsapp_id'] = wid
    board=conn.execute('SELECT b.* FROM boards b JOIN columns c ON c.board_id=b.id WHERE c.id=?',(values['column_id'],)).fetchone()
    if board and board['whatsapp_id']:
        if wid and wid!=board['whatsapp_id']:raise ValueError('Use o WhatsApp vinculado a este quadro.')
        values['whatsapp_id']=board['whatsapp_id']
    return values

@app.route('/api/agent-modals', methods=['POST'])
@app.route('/api/agent-modals/<item_id>', methods=['PUT', 'DELETE'])
@auth_required
def agent_modals(item_id=None):
    with action_lock(DATA), db() as conn:
        existing = conn.execute('SELECT * FROM agent_modals WHERE id=?', (item_id,)).fetchone() if item_id else None
        if item_id and not existing:
            return fail('Modal de Agente não encontrado.', 404)
        if request.method == 'DELETE':
            if conn.execute("SELECT 1 FROM agent_jobs j JOIN agents a ON a.id=j.agent_id WHERE a.modal_id=? AND j.stage='uncertain'", (item_id,)).fetchone():
                return fail('Há um envio com resultado incerto. Confira a conversa antes de excluir este modal.', 409)
            conn.execute('DELETE FROM agents WHERE modal_id=?', (item_id,))
            conn.execute('DELETE FROM agent_modals WHERE id=?', (item_id,))
        else:
            data = request.get_json()
            if existing and (type(data.get('revision')) is not int or data['revision'] != existing['revision']):
                return fail('O modal foi alterado em outra janela. Reabra o cadastro antes de salvar.', 409)
            try:
                base, stages, owned, removed = validate_modal(data, conn, field, existing)
            except ValueError as error:
                return fail(str(error))
            if existing:
                conn.execute('UPDATE agent_modals SET ' + ','.join(key+'=?' for key in base) +
                             ',revision=revision+1 WHERE id=?', (*base.values(), item_id))
            else:
                item_id = secrets.token_hex(12)
                position = conn.execute('SELECT COALESCE(MAX(position),-1)+1 FROM agent_modals WHERE column_id=?', (base['column_id'],)).fetchone()[0]
                conn.execute('INSERT INTO agent_modals (id,' + ','.join(base) + ',position) VALUES (' +
                             ','.join('?' for _ in range(len(base)+2)) + ')', (item_id, *base.values(), position))
            save_modal(conn, item_id, base, stages, owned, removed)
    return jsonify(ok=True, id=item_id)


@app.put('/api/agent-modals/<item_id>/move')
@auth_required
def move_modal(item_id):
    cid = request.get_json().get('column_id')
    with action_lock(DATA), db() as conn:
        modal = conn.execute('SELECT * FROM agent_modals WHERE id=?', (item_id,)).fetchone()
        if not modal:
            return fail('Modal de Agente não encontrado.', 404)
        destination = conn.execute('SELECT board_id FROM columns WHERE id=?', (cid,)).fetchone() if isinstance(cid, str) else None
        if not destination:
            return fail('Coluna inválida.')
        origin = conn.execute('SELECT board_id FROM columns WHERE id=?', (modal['column_id'],)).fetchone()[0]
        if origin != destination['board_id']:
            return fail('Mova o modal entre colunas do mesmo quadro.', 409)
        position = conn.execute('SELECT COALESCE(MAX(position),-1)+1 FROM agent_modals WHERE column_id=?', (cid,)).fetchone()[0]
        conn.execute('UPDATE agent_modals SET column_id=?,position=?,revision=revision+1 WHERE id=?', (cid, position, item_id))
        conn.execute('UPDATE agents SET column_id=? WHERE modal_id=?', (cid, item_id))
    return jsonify(ok=True)


@app.route('/api/agents', methods=['POST'])
@app.route('/api/agents/<item_id>', methods=['PUT', 'DELETE'])
@auth_required
def agents(item_id=None):
    with action_lock(DATA), db() as conn:
        existing = conn.execute('SELECT * FROM agents WHERE id=?', (item_id,)).fetchone() if item_id else None
        if item_id and not existing:
            return fail('Agente não encontrado.', 404)
        if existing and existing['modal_id'] and conn.execute('SELECT COUNT(*) FROM agents WHERE modal_id=?', (existing['modal_id'],)).fetchone()[0] > 1:
            return fail('Edite as etapas pelo Modal de Agente para manter a base e a sequência consistentes.', 409)
        if request.method == 'DELETE':
            conn.execute('DELETE FROM agents WHERE id=?', (item_id,))
            if existing['modal_id']:
                conn.execute('DELETE FROM agent_modals WHERE id=?', (existing['modal_id'],))
        else:
            try:
                values = agent_values(request.get_json(), conn)
            except ValueError as e:
                return fail(str(e))
            if existing:
                old_board=conn.execute('SELECT board_id FROM columns WHERE id=?',(existing['column_id'],)).fetchone()[0]
                new_board=conn.execute('SELECT board_id FROM columns WHERE id=?',(values['column_id'],)).fetchone()[0]
                if old_board!=new_board:return fail('Escolha uma coluna do mesmo quadro.')
                # Editing the scope always pauses the activation request.
                if any(existing[key]!=values[key] for key in ('objective','instructions')):values['operator_priority']='configuration'
                conn.execute('UPDATE agents SET ' + ','.join(k+'=?' for k in values) + ", enabled=0, revision=revision+1, runtime_status='off', runtime_error='',stop_code='edited',stop_reason='Cadastro alterado. Revise as configurações e ligue o agente novamente para continuar.',stopped_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),retry_at=0,retry_count=0, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?", (*values.values(), item_id))
                conn.execute("DELETE FROM agent_jobs WHERE agent_id=? AND stage NOT IN ('done','uncertain')",(item_id,))
                if any(existing[key]!=values[key] for key in ('whatsapp_id','target_tag','exit_tag')) or output_routes(dict(existing))!=output_routes(values):
                    conn.execute('DELETE FROM agent_sessions WHERE agent_id=?',(item_id,))
                    conn.execute("UPDATE agent_contacts SET status='pending',chat_id=NULL,error='',attempts=0,retry_at=0 WHERE agent_id=? AND status IN ('pending','queued','error')",(item_id,))
                if existing['modal_id']:
                    shared = {key: values[key] for key in ('column_id','name','identity','context','description','whatsapp_id')}
                    conn.execute('UPDATE agent_modals SET '+','.join(key+'=?' for key in shared)+',revision=revision+1 WHERE id=?', (*shared.values(), existing['modal_id']))
            else:
                item_id = secrets.token_hex(12)
                position = conn.execute('SELECT COALESCE(MAX(position),-1)+1 FROM agents WHERE column_id=?', (values['column_id'],)).fetchone()[0]
                conn.execute('INSERT INTO agents (id,'+','.join(values)+',position) VALUES ('+','.join('?' for _ in range(len(values)+2))+')', (item_id, *values.values(), position))
                create_legacy_modal(conn, item_id)
    return jsonify(ok=True, id=item_id)

@app.put('/api/agents/<item_id>/enabled')
@auth_required
def enabled(item_id):
    return set_agent_enabled(item_id,request.get_json().get('enabled'))

def set_agent_enabled(item_id,value):
    if not isinstance(value, bool):
        return fail('Estado inválido.')
    with db() as conn:
        agent = conn.execute('SELECT * FROM agents WHERE id=?', (item_id,)).fetchone()
        if not agent:
            return fail('Agente não encontrado.', 404)
        if value and any(not agent[k] for k in ('instructions', 'objective', 'target_tag', 'exit_tag', 'whatsapp_id')):
            return fail('Preencha as instruções, o objetivo, as tags de entrada e saída e o WhatsApp antes de ativar.')
        whatsapp=conn.execute('SELECT * FROM whatsapps WHERE id=?',(agent['whatsapp_id'],)).fetchone()
        if value and conn.execute("SELECT 1 FROM agent_jobs WHERE agent_id=? AND stage='uncertain'",(item_id,)).fetchone():
            return fail('Existe um envio com resultado incerto. Confira a conversa antes de retomar este agente.',409)
    if value:
        tags=[route['tag'] for route in output_routes(dict(agent))]
        if not tags or any(not tag or agent['target_tag'].casefold()==tag.casefold() for tag in tags): return fail('Use tags diferentes para entrada e saída e preencha todas as saídas.')
        if not worker_ready(): return fail('O serviço dos agentes não está disponível. Tente novamente em instantes.',503)
        if not brain.status()['verified']: return fail('Verifique a conexão da OpenAI em Configurações antes de ativar.',409)
        if not whatsapp or not whatsapp['mcp_key']: return fail('Selecione um WhatsApp conectado ao MCP.')
        status=mcp.check(whatsapp['mcp_key'],force=True)
        if not status.get('connected') or not status.get('agent_tools_ready') or status.get('access_mode')!='agent_execution':
            return fail('O WhatsApp ainda não está pronto para executar agentes. Verifique a conexão.',409)
        if len(tags)>1 and not status.get('agent_routes_ready'):return fail('Atualize a integração WhatsApp para usar saídas condicionais.',409)
        with db() as conn:has_contacts=conn.execute("SELECT 1 FROM agent_contacts WHERE agent_id=? AND status='pending'",(item_id,)).fetchone()
        if has_contacts and not status.get('agent_contacts_ready'):return fail('Atualize a integração WhatsApp para usar a lista de contatos.',409)
        try:
            labels=mcp.call_tool(whatsapp['mcp_key'],'list_contact_labels',{})
            if not labels.get('supported'): return fail('Esta conta não disponibiliza etiquetas do WhatsApp Business.',409)
            for tag in [agent['target_tag'],*tags]:
                matches=[label for label in labels['labels'] if label['name'].strip().casefold()==tag.casefold()]
                if len(matches)!=1:return fail(f'A tag “{tag}” deve existir com um nome único no WhatsApp selecionado.',409)
        except Exception as error:
            from mcp_client import ConnectionError
            if isinstance(error,ConnectionError): return fail(str(error),409)
            raise
    with action_lock(DATA), db() as conn:
        current=conn.execute('SELECT revision FROM agents WHERE id=?',(item_id,)).fetchone()
        if not current or current['revision']!=agent['revision']: return fail('O cadastro foi alterado. Atualize a página e tente novamente.',409)
        if value and conn.execute('SELECT 1 FROM agents WHERE enabled=1 AND whatsapp_id=? AND lower(target_tag)=lower(?) AND id!=?',(agent['whatsapp_id'],agent['target_tag'],item_id)).fetchone():
            return fail('Já há um agente ativo com esta tag de entrada neste WhatsApp.',409)
        if value:
            conn.execute("UPDATE agents SET enabled=1, revision=revision+1, runtime_status='waiting', runtime_error='',retry_at=0,retry_count=0, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?", (item_id,))
        elif agent['enabled']:
            conn.execute("UPDATE agents SET enabled=0, revision=revision+1, runtime_status='off', runtime_error='',stop_code='manual',stop_reason='Desligado manualmente pelo administrador. Os atendimentos não foram marcados como concluídos por esta ação.',stopped_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),retry_at=0,retry_count=0, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?", (item_id,))
    return jsonify(ok=True, execution_status='active' if value else 'off', executing=value)

@app.put('/api/agents/<item_id>/move')
@auth_required
def move(item_id):
    cid = request.get_json().get('column_id')
    with action_lock(DATA), db() as conn:
        if not isinstance(cid, str) or not conn.execute('SELECT 1 FROM columns WHERE id=?', (cid,)).fetchone():
            return fail('Coluna inválida.')
        if not conn.execute('SELECT 1 FROM agents WHERE id=?', (item_id,)).fetchone():
            return fail('Agente não encontrado.', 404)
        origin=conn.execute('SELECT c.board_id FROM agents a JOIN columns c ON c.id=a.column_id WHERE a.id=?',(item_id,)).fetchone()[0]
        destination=conn.execute('SELECT board_id FROM columns WHERE id=?',(cid,)).fetchone()[0]
        if origin!=destination:return fail('Mova o agente entre colunas do mesmo quadro.',409)
        modal_id = conn.execute('SELECT modal_id FROM agents WHERE id=?', (item_id,)).fetchone()[0]
        position = conn.execute('SELECT COALESCE(MAX(position),-1)+1 FROM agents WHERE column_id=?', (cid,)).fetchone()[0]
        if modal_id:
            conn.execute('UPDATE agent_modals SET column_id=?,position=?,revision=revision+1 WHERE id=?', (cid,position,modal_id))
            conn.execute("UPDATE agents SET column_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE modal_id=?", (cid,modal_id))
        else:
            conn.execute("UPDATE agents SET column_id=?, position=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?", (cid, position, item_id))
    return jsonify(ok=True)

@app.route('/api/whatsapps', methods=['POST'])
@app.route('/api/whatsapps/<item_id>', methods=['PUT', 'DELETE'])
@auth_required
def whatsapps(item_id=None):
    with db() as conn:
        existing = conn.execute('SELECT * FROM whatsapps WHERE id=?', (item_id,)).fetchone() if item_id else None
        if item_id and not existing:
            return fail('WhatsApp não encontrado.', 404)
        if request.method == 'DELETE':
            if existing['mcp_key']:
                return fail('Esta instância está conectada ao MCP. A desconexão será configurada separadamente.', 409)
            if conn.execute('SELECT 1 FROM agents WHERE whatsapp_id=?', (item_id,)).fetchone():
                return fail('Este WhatsApp está vinculado a agentes. Remova os vínculos primeiro.', 409)
            if conn.execute('SELECT 1 FROM agent_modals WHERE whatsapp_id=?', (item_id,)).fetchone():
                return fail('Este WhatsApp está vinculado à base de um modal. Remova o vínculo primeiro.', 409)
            if conn.execute('SELECT 1 FROM boards WHERE whatsapp_id=?',(item_id,)).fetchone():
                return fail('Este WhatsApp está vinculado a um quadro. Remova o vínculo primeiro.',409)
            conn.execute('DELETE FROM whatsapps WHERE id=?', (item_id,))
        else:
            data = request.get_json()
            try:
                name = field(data, 'name', 100, True)
                endpoint = field(data, 'endpoint', 300)
            except ValueError as e:
                return fail(str(e))
            if endpoint:
                from urllib.parse import urlparse
                parsed = urlparse(endpoint)
                if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                    return fail('Use uma URL HTTPS sem credenciais ou parâmetros.')
            if existing and existing['mcp_key'] and endpoint != existing['endpoint']:
                return fail('O endereço de uma instância conectada não pode ser alterado por este cadastro.')
            if item_id:
                conn.execute('UPDATE whatsapps SET name=?, endpoint=? WHERE id=?', (name, endpoint, item_id))
            else:
                item_id = secrets.token_hex(12)
                conn.execute('INSERT INTO whatsapps (id,name,endpoint) VALUES (?,?,?)', (item_id, name, endpoint))
    return jsonify(ok=True, id=item_id)

@app.post('/api/whatsapps/<item_id>/check')
@auth_required
def check_whatsapp(item_id):
    with db() as conn:
        whatsapp = conn.execute('SELECT mcp_key FROM whatsapps WHERE id=?', (item_id,)).fetchone()
    if not whatsapp:
        return fail('WhatsApp não encontrado.', 404)
    if not whatsapp['mcp_key']:
        return fail('Este cadastro ainda não tem uma conexão MCP configurada.')
    return jsonify(mcp.check(whatsapp['mcp_key'], force=True))

@app.get('/api/whatsapps/<item_id>/session')
@app.post('/api/whatsapps/<item_id>/reconnect')
@auth_required
def whatsapp_session(item_id):
    with db() as conn:
        whatsapp=conn.execute('SELECT name,mcp_key FROM whatsapps WHERE id=?',(item_id,)).fetchone()
    if not whatsapp:return fail('WhatsApp não encontrado.',404)
    if not whatsapp['mcp_key']:return fail('Este cadastro ainda não tem uma conexão MCP configurada.',409)
    try:
        return jsonify(mcp.whatsapp_session(whatsapp['mcp_key'],reconnect=request.method=='POST')|{'name':whatsapp['name']})
    except Exception as error:
        from mcp_client import ConnectionError
        if isinstance(error,ConnectionError):return fail(str(error),503)
        raise

register_contact_routes(app,auth_required,db,brain,DATA,fail,action_lock)
register_chat(app,auth_required,db,brain,mcp,DATA,fail,action_lock,set_agent_enabled,field)
register_audio(app,auth_required,db,brain,fail)

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=8000)
