// Upload temporário de arquivos (ingestão remota) - WhatsApp MCP v1.2.0.
//
// Objetivo (pedido explícito do usuário): nada de biblioteca permanente de
// documentos, File Bridge ou sincronização de pastas. Um arquivo que só
// existe no ambiente do cliente MCP (Claude/ChatGPT) precisa de um jeito de
// chegar à VPS, ser enviado pelo WhatsApp, e DESAPARECER - sem virar
// armazenamento permanente por padrão.
//
// Ciclo de vida de um temp_file_id:
//   upload (base64/source_url/multipart) -> blob em disco + registro
//     -> send_file/send_files tenta enviar
//       -> sucesso: blob apagado + registro removido (ver TempFileStore.remove)
//       -> falha: continua existindo até o TTL (permite retry sem novo upload)
//     -> nunca usado: removido pela varredura de TTL (cleanupExpired)
//
// Isolamento entre instâncias: cada instância cria seu próprio TempFileStore
// apontando para o seu PRÓPRIO diretório de dados (igual a FileRegistry/
// IdentityStore) - um temp_file_id de uma instância não existe no registro
// de outra, então nunca é resolvível lá.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function sanitizeFilename(name) {
  if (!name) return null;
  return name.replace(/[/\\\0]/g, '_').replace(/^\.+/, '').slice(0, 200) || null;
}

export class TempFileStore {
  constructor({ dataDir, blobsDir }) {
    this.dataDir = dataDir;
    this.blobsDir = blobsDir;
    fs.mkdirSync(this.blobsDir, { recursive: true });
    this.filePath = `${dataDir}/registry.json`;
  }

  // Mesmo padrão de FileRegistry/IdentityStore: relê do disco a cada
  // operação (processo de vida longa do servidor é o único escritor aqui,
  // mas o custo de reler é desprezível e mantém o código consistente/
  // auditável com o resto do projeto).
  _reload() {
    try {
      this.entries = new Map(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    } catch {
      this.entries = new Map();
    }
    return this.entries;
  }

  _save() {
    fs.writeFileSync(this.filePath, JSON.stringify([...this.entries.entries()], null, 2));
  }

  get(id) {
    return this._reload().get(id) || null;
  }

  // Todos os arquivos ainda disponíveis (não enviados/expirados) desta
  // instância - usado por list_temp_files/get_temp_batch. Nunca cruza
  // instância: cada TempFileStore só enxerga o próprio registry.json.
  list() {
    return [...this._reload().values()];
  }

  put(entry) {
    this._reload();
    this.entries.set(entry.temp_file_id, entry);
    this._save();
    return entry;
  }

  blobPath(id) {
    return path.join(this.blobsDir, id);
  }

  // Remove o blob E o registro juntos - nunca deixa só um dos dois (bytes
  // órfãos em blobs/, ou um registro apontando para um blob que já sumiu).
  // Usado após envio bem-sucedido e pela varredura de TTL.
  remove(id) {
    this._reload();
    fs.rmSync(this.blobPath(id), { force: true });
    const existed = this.entries.delete(id);
    if (existed) this._save();
    return existed;
  }

  // Varre o registro procurando expires_at vencido e remove (blob + linha).
  // Retorna a lista do que foi removido, para quem chamar poder auditar/
  // logar sem conteúdo (só temp_file_id/filename/hash/size).
  cleanupExpired() {
    this._reload();
    const now = Date.now();
    const expired = [];
    for (const [id, entry] of this.entries.entries()) {
      if (entry.expires_at && new Date(entry.expires_at).getTime() < now) {
        expired.push(entry);
      }
    }
    for (const entry of expired) {
      fs.rmSync(this.blobPath(entry.temp_file_id), { force: true });
      this.entries.delete(entry.temp_file_id);
    }
    if (expired.length) this._save();
    return expired;
  }
}

// ---------------------------------------------------------------------------
// Proteção anti-SSRF para source_url
//
// Ameaça: uma identidade válida (token roubado/vazado) usa source_url para
// fazer o SERVIDOR buscar um recurso interno (localhost, rede privada,
// endpoint de metadata de nuvem) e depois pedir pra WhatsApp MCP "enviar" esse
// conteúdo pelo WhatsApp - vazando dado interno para fora.
//
// Mitigação implementada: só HTTPS; bloqueia hostname "localhost"; resolve
// o DNS e valida que NENHUM IP resultante é privado/loopback/link-local/
// multicast antes de conectar; segue redirect manualmente, revalidando a
// CADA hop (nunca deixa o fetch seguir sozinho); aborta se exceder o limite
// de bytes (por Content-Length E durante o download).
//
// Limitação conhecida e aceita (documentada, não escondida): não há pinning
// de conexão ao IP validado - um ataque de DNS rebinding (o mesmo hostname
// responder um IP público na checagem e um IP privado no connect, dentro da
// mesma janela de milissegundos) não é coberto. Dado o porte deste projeto
// (uso interno de um escritório, poucas identidades confiáveis, não exposto
// como serviço público), decidimos não adicionar uma dependência extra
// (undici com Agent/lookup customizado) só para fechar esse vetor mais
// avançado - ver AGENTS.md para o racional completo.
export class SsrfBlockedError extends Error {}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

function isDisallowedIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918 classe A
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 classe B
    if (a === 192 && b === 168) return true; // RFC1918 classe C
    if (a === 169 && b === 254) return true; // link-local (cobre 169.254.169.254 de metadata de nuvem)
    if (a === 0) return true;
    if (a >= 224) return true; // multicast/reservado
    return false;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true; // loopback
    if (lower.startsWith('fe80:') || lower.startsWith('fe80::')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local fc00::/7
    if (lower.startsWith('::ffff:')) {
      const v4 = lower.split(':').pop();
      if (v4 && v4.includes('.')) return isDisallowedIp(v4);
    }
    return false;
  }
  return true; // nem IPv4 nem IPv6 reconhecido - rejeita por segurança
}

export async function fetchUrlWithSsrfProtection(urlString, { maxBytes, maxRedirects = 3 } = {}) {
  let current = urlString;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      throw new SsrfBlockedError('source_url inválida.');
    }
    if (parsed.protocol !== 'https:') {
      throw new SsrfBlockedError(`Protocolo não permitido: "${parsed.protocol}" (só https:// é aceito).`);
    }
    if (BLOCKED_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
      throw new SsrfBlockedError(`Host bloqueado: ${parsed.hostname}.`);
    }
    let addresses;
    try {
      addresses = await dns.lookup(parsed.hostname, { all: true });
    } catch {
      throw new SsrfBlockedError(`Não foi possível resolver o host: ${parsed.hostname}.`);
    }
    if (!addresses.length || addresses.some((a) => isDisallowedIp(a.address))) {
      throw new SsrfBlockedError(`Host "${parsed.hostname}" resolve para um IP não permitido (privado/loopback/link-local).`);
    }

    const resp = await fetch(current, { redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const location = resp.headers.get('location');
      if (!location) throw new SsrfBlockedError('Redirect sem header Location.');
      current = new URL(location, current).toString();
      continue;
    }
    if (!resp.ok) {
      throw new Error(`Download falhou: HTTP ${resp.status}`);
    }
    const contentLength = Number(resp.headers.get('content-length') || '0');
    if (maxBytes && contentLength > maxBytes) {
      throw new Error(`Arquivo excede o limite (Content-Length ${contentLength} > ${maxBytes} bytes).`);
    }
    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (maxBytes && total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // best-effort - já vamos lançar o erro de limite excedido de qualquer forma
        }
        throw new Error(`Arquivo excede o limite de ${maxBytes} bytes (abortado durante o download).`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  throw new SsrfBlockedError('Excesso de redirects (máximo permitido: ' + maxRedirects + ').');
}
