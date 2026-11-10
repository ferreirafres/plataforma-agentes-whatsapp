// Identidades (usuários autorizados) do WhatsApp MCP.
//
// Cada identidade tem seu próprio login + segredo (hash, nunca texto puro)
// e sua própria lista de scopes. Usado tanto pelo servidor (index.js, para
// validar login em /authorize/approve e marcar tokens com o dono) quanto
// pelo CLI administrativo (admin.js, para criar/listar/revogar/rotacionar).
import fs from 'node:fs';
import crypto from 'node:crypto';

export const ALL_SCOPES = [
  'whatsapp:read',
  'whatsapp:session',
  'whatsapp:labels',
  'whatsapp:media',
  'whatsapp:send',
  'whatsapp:transcribe',
  'whatsapp:send_file',
  'whatsapp:file_upload',
  'whatsapp:forward',
  'drive:read',
  'drive:download',
  'drive:send',
];

export function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(secret, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifySecret(secret, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(secret, salt, 64);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export class IdentityStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  // Sempre relê do disco antes de qualquer operação: o servidor (processo
  // de vida longa) e o CLI administrativo (admin.js, processo separado a
  // cada chamada via `docker exec`) escrevem no MESMO arquivo. Sem isso, o
  // servidor só veria identidades criadas/revogadas pelo CLI depois de
  // reiniciar. O arquivo é pequeno (poucos usuários) - reler sempre é barato.
  _reload() {
    try {
      this.identities = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      this.identities = [];
    }
    return this.identities;
  }

  _save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.identities, null, 2));
  }

  list() {
    return this._reload().map(({ secret_hash, ...rest }) => rest);
  }

  getById(id) {
    return this._reload().find((i) => i.id === id) || null;
  }

  findByLogin(login) {
    return this._reload().find((i) => i.login === login) || null;
  }

  isUsable(identity) {
    if (!identity) return false;
    if (identity.revoked_at) return false;
    if (identity.connection_enabled === false) return false;
    if (identity.connection_expires_at && new Date(identity.connection_expires_at).getTime() <= Date.now()) return false;
    if (identity.expires_at && new Date(identity.expires_at).getTime() < Date.now()) return false;
    return true;
  }

  create({ id, label, login, secret, scopes, expires_at }) {
    this._reload();
    if (this.findByLogin(login)) {
      throw new Error(`Já existe uma identidade com login "${login}".`);
    }
    const invalidScope = scopes.find((s) => !ALL_SCOPES.includes(s));
    if (invalidScope) throw new Error(`Scope inválido: "${invalidScope}". Válidos: ${ALL_SCOPES.join(', ')}`);
    const identity = {
      id: id || `usr_${crypto.randomUUID()}`,
      label,
      login,
      secret_hash: hashSecret(secret),
      scopes,
      created_at: new Date().toISOString(),
      revoked_at: null,
      expires_at: expires_at || null,
      last_used_at: null,
    };
    this.identities.push(identity);
    this._save();
    return identity;
  }

  touchLastUsed(id) {
    this._reload();
    const identity = this.getById(id);
    if (identity) {
      identity.last_used_at = new Date().toISOString();
      this._save();
    }
  }

  revoke(id) {
    this._reload();
    const identity = this.getById(id);
    if (!identity) throw new Error(`Identidade não encontrada: ${id}`);
    identity.revoked_at = new Date().toISOString();
    this._save();
    return identity;
  }

  setScopes(id, scopes) {
    this._reload();
    const identity = this.getById(id);
    if (!identity) throw new Error(`Identidade não encontrada: ${id}`);
    const invalidScope = scopes.find((s) => !ALL_SCOPES.includes(s));
    if (invalidScope) throw new Error(`Scope inválido: "${invalidScope}". Válidos: ${ALL_SCOPES.join(', ')}`);
    identity.scopes = scopes;
    this._save();
    return identity;
  }

  rotateSecret(id, newSecret) {
    this._reload();
    const identity = this.getById(id);
    if (!identity) throw new Error(`Identidade não encontrada: ${id}`);
    identity.secret_hash = hashSecret(newSecret);
    identity.revoked_at = null;
    this._save();
    return identity;
  }
}
