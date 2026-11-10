"""Administrator-only connection management; secrets are returned only on reveal."""
from flask import jsonify, request
from mcp_client import ConnectionError


def register(app, auth_required, db, mcp, fail):
    allowed = ('login','password_available','enabled','policy','authorization_expires_at','authorized','last_used_at')

    def connection(item_id):
        with db() as conn:
            row=conn.execute('SELECT mcp_key FROM whatsapps WHERE id=?',(item_id,)).fetchone()
        return row['mcp_key'] if row else None

    @app.get('/api/mcp-connections')
    @auth_required
    def list_connections():
        with db() as conn:
            rows=conn.execute('SELECT id,name,mcp_key,endpoint FROM whatsapps WHERE mcp_key IS NOT NULL').fetchall()
        items=[]
        for row in rows:
            item={'id':row['id'],'name':row['name'],'endpoint':row['endpoint'],'managed':False}
            try:
                result=mcp.management(row['mcp_key'])
                item.update({k:result.get(k) for k in allowed},managed=True)
                item['status']=mcp.check(row['mcp_key'],force=True) if result.get('authorized') else {
                    'connected':False,'authenticated':False,'message':'Autorização bloqueada ou expirada.'}
            except ConnectionError as error:
                item['error']=str(error)
            items.append(item)
        return jsonify(connections=items)

    @app.post('/api/mcp-connections/<item_id>/<action>')
    @auth_required
    def manage_connection(item_id,action):
        key=connection(item_id)
        if not key:return fail('Conexão não encontrada.',404)
        if action not in ('reveal','update','reconnect'):return fail('Ação inválida.',404)
        values=request.get_json()
        try:
            if action=='reconnect':
                mcp.reconnect_managed(key)
                return jsonify(status=mcp.check(key,force=True))
            if action=='update':
                if set(values)-{'login','password','policy'}:return fail('Campos inválidos.')
                if not isinstance(values.get('password'),str) or not isinstance(values.get('login'),str):return fail('Dados inválidos.')
                result=mcp.management(key,action,values)
                mcp.cache.pop(key,None)
                warning=None
                if result.get('authorized'):
                    try:mcp.reconnect_managed(key)
                    except ConnectionError:warning='Configuração salva. Clique em Reconectar para renovar a conexão da plataforma.'
                return jsonify({k:result.get(k) for k in allowed}|{'warning':warning})
            result=mcp.management(key,'reveal')
            return jsonify(login=result.get('login'),password=result.get('password'))
        except ConnectionError as error:
            return fail(str(error),409)
