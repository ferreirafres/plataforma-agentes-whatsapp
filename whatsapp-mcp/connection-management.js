import fs from 'node:fs';
import crypto from 'node:crypto';
import { hashSecret } from './identity-store.js';

export function registerConnectionManagement(app, {dataDir, identityStore, provider, instance, publicUrl, rateLimiter}) {
  const file = `${dataDir}/connection-management.json`;
  const read = () => {
    const config=JSON.parse(fs.readFileSync(file, 'utf8'));
    if (config.pending) {
      identityStore._reload();
      const identity=identityStore.identities.find(i=>i.id===config.identity_id);
      if (!identity) throw new Error('Identity missing');
      Object.assign(identity,config.pending);
      identityStore._save();
      invalidate(identity.id);
      delete config.pending;
      save(config);
    }
    return config;
  };
  const save = value => {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value), {mode:0o600});
    fs.chmodSync(`${file}.tmp`, 0o600);
    fs.renameSync(`${file}.tmp`, file);
  };
  const invalidate = id => {
    for (const map of [provider.accessTokens, provider.refreshTokensByHash, provider.codes]) {
      for (const [key, value] of map) if (value.identityId === id) map.delete(key);
    }
    provider._persistRefreshTokens();
  };
  const status = (config, identity) => ({
    instance, login:identity.login, password_available:!!config.password,
    enabled:identity.connection_enabled !== false,
    policy:identity.connection_policy || 'always',
    authorization_expires_at:identity.connection_expires_at || null,
    authorized:identityStore.isUsable(identity), last_used_at:identity.last_used_at,
  });
  app.all('/api/connection-management', rateLimiter, async (req,res) => {
    res.set('Cache-Control','no-store');
    let config;
    try { config = read(); } catch { return res.status(404).json({error:'Gerenciamento não configurado.'}); }
    const supplied = Buffer.from(String(req.headers['x-mcp-management-key'] || ''));
    const expected = Buffer.from(config.management_key || '');
    if (!expected.length || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied,expected))
      return res.status(403).json({error:'Gerenciamento não autorizado.'});
    if (!['GET','POST'].includes(req.method)) return res.status(405).json({error:'Método indisponível.'});
    let identity = identityStore.getById(config.identity_id);
    if (!identity) return res.status(409).json({error:'Identidade não encontrada.'});
    if (req.method === 'GET') return res.json(status(config,identity));
    const body = req.body || {};
    if (body.instance !== instance) return res.status(409).json({error:'Instância incorreta.'});
    if (body.action === 'reveal') return res.json({...status(config,identity),password:config.password || null});
    if (body.action === 'reconnect') {
      if (!identityStore.isUsable(identity)) return res.status(409).json({error:'Autorize a conexão para reconectar.'});
      const client = await provider.clientsStore.getClient(config.client_id);
      if (!client) return res.status(409).json({error:'Cliente não encontrado.'});
      return res.json({instance,tokens:provider._issueTokenPair(config.client_id,identity.id,identity.scopes,new URL(`${publicUrl}/mcp`))});
    }
    if (body.action !== 'update') return res.status(400).json({error:'Ação inválida.'});
    const policies = {always:null, hour:3600, day:86400, week:604800, month:2592000, disabled:null};
    if (!Object.hasOwn(policies,body.policy)) return res.status(400).json({error:'Prazo inválido.'});
    const login = typeof body.login === 'string' ? body.login.trim().toLowerCase() : '';
    if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(login)) return res.status(400).json({error:'Use um login de 3 a 80 caracteres: letras, números, ponto, hífen ou sublinhado.'});
    const existing = identityStore.findByLogin(login);
    if (existing && existing.id !== identity.id) return res.status(409).json({error:'Este login já está em uso.'});
    if (typeof body.password !== 'string' || (body.password && (body.password.length<12 || body.password.length>128)))
      return res.status(400).json({error:'Use uma senha de 12 a 128 caracteres.'});
    // Compute everything before changing either file; a pending transaction is recoverable.
    const password = body.password || config.password;
    const secretHash = body.password ? hashSecret(body.password) : identity.secret_hash;
    const expires = policies[body.policy] ? new Date(Date.now()+policies[body.policy]*1000).toISOString() : null;
    config = {...config,password,pending:{login,secret_hash:secretHash,connection_policy:body.policy,
      connection_enabled:body.policy!=='disabled',connection_expires_at:expires}};
    save(config);
    identityStore._reload();
    identity = identityStore.identities.find(i=>i.id===config.identity_id);
    Object.assign(identity,config.pending);
    identityStore._save();
    delete config.pending;
    save(config);
    invalidate(identity.id);
    return res.json(status(config,identity));
  });
}
