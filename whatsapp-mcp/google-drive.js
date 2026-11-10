// Integração Google Drive (WhatsApp MCP v1.5.0) - OAuth próprio do WhatsApp MCP, NUNCA a
// conexão Google de um cliente MCP.
//
// Arquitetura multi-drive: N `drive_connection` por instância, cada uma com
// seu próprio refresh_token (sempre criptografado em repouso), suas próprias
// root_folder_ids (allowlist lógica opcional) e uma flag is_default. Um
// único OAuth Client do Google (GOOGLE_CLIENT_ID/SECRET) é compartilhado
// entre todas as conexões/instâncias - cada CONEXÃO tem seu próprio token,
// nunca se misturam.
import fs from 'node:fs';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Criptografia dos refresh_token em repouso (AES-256-GCM). A chave nunca é
// derivada de nada previsível - vem de DRIVE_TOKEN_ENCRYPTION_KEY (.env,
// 32 bytes em hex, gerada com `openssl rand -hex 32`), própria de cada
// instância.
// ---------------------------------------------------------------------------
export function encryptToken(plaintext, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('DRIVE_TOKEN_ENCRYPTION_KEY precisa ter 32 bytes (64 caracteres hex).');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
}

export function decryptToken(encoded, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const [ivB64, tagB64, dataB64] = encoded.split('.');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function maskEmail(email) {
  if (!email) return null;
  const [user, domain] = email.split('@');
  if (!domain) return email;
  const visible = user.slice(0, 3);
  return `${visible}${'*'.repeat(Math.max(3, user.length - visible.length))}@${domain}`;
}

// ---------------------------------------------------------------------------
// Armazenamento das conexões (metadados + refresh_token criptografado) -
// mesmo padrão "sempre relê do disco" de FileRegistry/IdentityStore/
// TempFileStore. UMA instância só enxerga o PRÓPRIO .drive-data/
// connections.json - isolamento é estrutural (arquivo/volume diferente por
// instância), nunca por filtro em memória.
export class DriveConnectionStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  _reload() {
    try {
      this.connections = new Map(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    } catch {
      this.connections = new Map();
    }
    return this.connections;
  }

  _save() {
    fs.writeFileSync(this.filePath, JSON.stringify([...this.connections.entries()], null, 2));
  }

  list() {
    return [...this._reload().values()];
  }

  get(id) {
    return this._reload().get(id) || null;
  }

  getDefault() {
    const all = this.list();
    if (all.length === 1) return all[0];
    return all.find((c) => c.is_default) || null;
  }

  // Resolve "qual conexão usar" a partir do parâmetro livre de uma tool:
  // vazio/"default" -> getDefault(); senão tenta por connection_id exato,
  // senão por display_name exato (case-insensitive).
  resolve(connectionRef) {
    const all = this.list();
    if (!connectionRef || connectionRef === 'default') {
      const def = this.getDefault();
      if (def) return { ok: true, connection: def };
      if (all.length === 0) return { ok: false, error: 'drive_not_connected' };
      return { ok: false, error: 'ambiguous_connection', candidates: all.map(publicConnectionFields) };
    }
    const byId = all.find((c) => c.connection_id === connectionRef);
    if (byId) return { ok: true, connection: byId };
    const byName = all.filter((c) => (c.display_name || '').toLowerCase() === connectionRef.toLowerCase());
    if (byName.length === 1) return { ok: true, connection: byName[0] };
    if (byName.length > 1) return { ok: false, error: 'ambiguous_connection', candidates: byName.map(publicConnectionFields) };
    return { ok: false, error: 'connection_not_found' };
  }

  create(entry) {
    this._reload();
    // Primeira conexão desta instância vira default automaticamente.
    const isFirst = this.connections.size === 0;
    const full = {
      authorized_instance_ids: [entry.instance_id],
      root_folder_ids: [],
      is_default: isFirst,
      status: 'connected',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_successful_refresh: new Date().toISOString(),
      ...entry,
    };
    this.connections.set(full.connection_id, full);
    this._save();
    return full;
  }

  update(id, patch) {
    this._reload();
    const existing = this.connections.get(id);
    if (!existing) throw new Error(`drive_connection não encontrada: ${id}`);
    const updated = { ...existing, ...patch, updated_at: new Date().toISOString() };
    this.connections.set(id, updated);
    this._save();
    return updated;
  }

  setDefault(id) {
    this._reload();
    if (!this.connections.has(id)) throw new Error(`drive_connection não encontrada: ${id}`);
    for (const [cid, conn] of this.connections.entries()) {
      this.connections.set(cid, { ...conn, is_default: cid === id, updated_at: new Date().toISOString() });
    }
    this._save();
    return this.connections.get(id);
  }

  revoke(id) {
    this._reload();
    const existing = this.connections.get(id);
    if (!existing) throw new Error(`drive_connection não encontrada: ${id}`);
    const updated = { ...existing, status: 'revoked', encrypted_refresh_token: null, updated_at: new Date().toISOString() };
    this.connections.set(id, updated);
    this._save();
    return updated;
  }
}

// Campos seguros para expor via tool/admin UI - NUNCA inclui
// encrypted_refresh_token nem qualquer token em texto puro.
export function publicConnectionFields(conn) {
  return {
    connection_id: conn.connection_id,
    display_name: conn.display_name,
    account_masked: maskEmail(conn.google_account_email),
    status: conn.status,
    is_default: !!conn.is_default,
    capabilities: conn.scopes?.includes('https://www.googleapis.com/auth/drive.readonly') ? ['read', 'download'] : [],
    root_folders: conn.root_folder_ids || [],
    created_at: conn.created_at,
    last_successful_refresh: conn.last_successful_refresh,
  };
}

// ---------------------------------------------------------------------------
// OAuth 2.0 Web Server Flow (authorization code + refresh token)
// ---------------------------------------------------------------------------
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
// userinfo.email é pedido JUNTO com drive.readonly - usado só para mostrar
// qual conta Google está conectada (mascarada) em /admin/drive e
// list_drive_connections; sem esse scope, fetchGoogleUserEmail() falharia.
const USERINFO_EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
export const DEFAULT_DRIVE_OAUTH_SCOPE = `${DRIVE_READONLY_SCOPE} ${USERINFO_EMAIL_SCOPE}`;

export function buildGoogleAuthUrl({ clientId, redirectUri, state, scope = DEFAULT_DRIVE_OAUTH_SCOPE }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent', // força a reemissão do refresh_token mesmo se o usuário já tiver autorizado antes
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens({ code, clientId, clientSecret, redirectUri }) {
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Falha ao trocar code por tokens: ${data.error_description || data.error || resp.status}`);
  if (!data.refresh_token) {
    throw new Error(
      'Google não devolveu refresh_token (comum se a conta já autorizou este app antes sem revogar). ' +
        'Revogue o acesso em https://myaccount.google.com/permissions e tente conectar de novo.'
    );
  }
  return data; // { access_token, refresh_token, expires_in, scope, token_type }
}

export async function refreshAccessToken({ refreshToken, clientId, clientSecret }) {
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Falha ao renovar access_token: ${data.error_description || data.error || resp.status}`);
  return data; // { access_token, expires_in, scope, token_type }
}

export async function revokeGoogleToken(token) {
  try {
    await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' });
  } catch {
    // best-effort - mesmo se a revogação no lado do Google falhar, já apagamos o token local
  }
}

export async function fetchGoogleUserEmail(accessToken) {
  const resp = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.email || null;
}

// ---------------------------------------------------------------------------
// Cache de access_token em memória por connection_id - renovado sob demanda
// via refresh_token (nunca persistido; só o refresh_token é persistido, e
// sempre criptografado). TTL com margem de segurança de 60s.
// ---------------------------------------------------------------------------
const accessTokenCache = new Map(); // connection_id -> { accessToken, expiresAt }

export async function getValidAccessToken({ connection, clientId, clientSecret, encryptionKey, store }) {
  const cached = accessTokenCache.get(connection.connection_id);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }
  const refreshToken = decryptToken(connection.encrypted_refresh_token, encryptionKey);
  const refreshed = await refreshAccessToken({ refreshToken, clientId, clientSecret });
  accessTokenCache.set(connection.connection_id, {
    accessToken: refreshed.access_token,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
  });
  store.update(connection.connection_id, { status: 'connected', last_successful_refresh: new Date().toISOString() });
  return refreshed.access_token;
}

// ---------------------------------------------------------------------------
// Drive API v3 - chamadas REST diretas via fetch (mesmo estilo de
// transcription.js: sem SDK, controle explícito sobre cada chamada).
// ---------------------------------------------------------------------------
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

async function driveApiCall(path, { accessToken, searchParams, method = 'GET' } = {}) {
  const url = new URL(`${DRIVE_API_BASE}${path}`);
  if (searchParams) {
    for (const [k, v] of Object.entries(searchParams)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }
  const resp = await fetch(url, { method, headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) {
    const body = await resp.text();
    const err = new Error(`Drive API ${path} falhou: HTTP ${resp.status} - ${body.slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

// Escapa aspas simples para uso seguro dentro de `q` (sintaxe de busca do
// Drive API v3 - https://developers.google.com/drive/api/guides/search-files).
function escapeDriveQueryValue(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function driveListFiles({ accessToken, q, pageToken, pageSize = 20, orderBy }) {
  return driveApiCall('/files', {
    accessToken,
    searchParams: {
      q,
      pageToken,
      pageSize,
      orderBy,
      fields: 'nextPageToken, files(id, name, mimeType, size, parents, modifiedTime, trashed)',
    },
  });
}

export async function driveGetFileMetadata({ accessToken, fileId }) {
  return driveApiCall(`/files/${encodeURIComponent(fileId)}`, {
    accessToken,
    searchParams: { fields: 'id, name, mimeType, size, parents, modifiedTime, trashed' },
  });
}

export async function driveSearchByText({ accessToken, text, folderId, mimeType, pageSize = 20 }) {
  const clauses = ["trashed = false", `fullText contains '${escapeDriveQueryValue(text)}'`];
  if (folderId) clauses.push(`'${escapeDriveQueryValue(folderId)}' in parents`);
  if (mimeType) clauses.push(`mimeType = '${escapeDriveQueryValue(mimeType)}'`);
  return driveListFiles({ accessToken, q: clauses.join(' and '), pageSize });
}

export async function driveListFolderChildren({ accessToken, folderId, pageToken, pageSize = 50 }) {
  const q = `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false`;
  return driveListFiles({ accessToken, q, pageToken, pageSize, orderBy: 'folder,name' });
}

// Sobe a árvore de pais até achar um root autorizado (ou até não ter mais
// pai). Drive v3 normalmente só tem 1 parent por arquivo - trata o caso raro
// de múltiplos tentando cada um. Custa 1 chamada de API por nível de
// profundidade (aceitável para a allowlist lógica pedida).
export async function isUnderAllowedRoot({ accessToken, fileId, rootFolderIds, maxDepth = 15 }) {
  if (!rootFolderIds || rootFolderIds.length === 0) return true; // sem allowlist configurada = sem restrição lógica adicional
  let frontier = [fileId];
  const rootSet = new Set(rootFolderIds);
  if (rootSet.has(fileId)) return true;
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier = [];
    for (const id of frontier) {
      let meta;
      try {
        meta = await driveGetFileMetadata({ accessToken, fileId: id });
      } catch {
        continue;
      }
      for (const parentId of meta.parents || []) {
        if (rootSet.has(parentId)) return true;
        nextFrontier.push(parentId);
      }
    }
    frontier = nextFrontier;
  }
  return false;
}

const GOOGLE_NATIVE_EXPORT_MIMETYPES = {
  'application/vnd.google-apps.document': { analyze: 'text/plain', send: 'application/pdf', sendExt: '.pdf' },
  'application/vnd.google-apps.spreadsheet': { analyze: 'text/csv', send: 'application/pdf', sendExt: '.pdf' },
  'application/vnd.google-apps.presentation': { analyze: 'text/plain', send: 'application/pdf', sendExt: '.pdf' },
};

export function isGoogleNativeMimetype(mimeType) {
  return Object.prototype.hasOwnProperty.call(GOOGLE_NATIVE_EXPORT_MIMETYPES, mimeType);
}

export function exportMimetypeFor(mimeType, purpose) {
  const entry = GOOGLE_NATIVE_EXPORT_MIMETYPES[mimeType];
  if (!entry) return null;
  return purpose === 'send' ? entry.send : entry.analyze;
}

// Baixa o conteúdo de um arquivo (binário normal via alt=media, ou via
// export quando for um tipo nativo do Google Workspace - Docs/Sheets/Slides
// não têm binário tradicional). `purpose` decide o formato de export quando
// aplicável: 'send' (PDF, pronto pra mandar no WhatsApp) ou 'analyze' (texto,
// pra read_drive_file).
export async function driveDownloadFileContent({ accessToken, fileId, mimeType, purpose = 'send' }) {
  const isNative = isGoogleNativeMimetype(mimeType);
  const url = new URL(
    isNative ? `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/export` : `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`
  );
  if (isNative) {
    url.searchParams.set('mimeType', exportMimetypeFor(mimeType, purpose));
  } else {
    url.searchParams.set('alt', 'media');
  }
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Download do Drive falhou: HTTP ${resp.status} - ${body.slice(0, 300)}`);
  }
  const arrayBuffer = await resp.arrayBuffer();
  const effectiveMimetype = isNative ? exportMimetypeFor(mimeType, purpose) : mimeType;
  return { buffer: Buffer.from(arrayBuffer), mimetype: effectiveMimetype };
}
