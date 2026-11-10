#!/usr/bin/env node
// CLI administrativo LOCAL do WhatsApp MCP - roda só dentro do container
// (docker exec whatsapp-mcp node admin.js <comando> ...), nunca exposto
// como MCP tool. Gerencia identidades (usuários autorizados).
import crypto from 'node:crypto';
import { OAUTH_DATA_DIR } from './data-paths.js';
import { IdentityStore, ALL_SCOPES } from './identity-store.js';

const DATA_DIR = OAUTH_DATA_DIR;
const store = new IdentityStore(`${DATA_DIR}/identities.json`);

function parseScopes(arg) {
  if (!arg) return ['whatsapp:read'];
  return arg.split(',').map((s) => s.trim());
}

function printIdentity(identity) {
  console.log(`  id:         ${identity.id}`);
  console.log(`  label:      ${identity.label}`);
  console.log(`  login:      ${identity.login}`);
  console.log(`  scopes:     ${identity.scopes.join(', ')}`);
  console.log(`  criado em:  ${identity.created_at}`);
  console.log(`  expira em:  ${identity.expires_at || '(nunca)'}`);
  console.log(`  revogado:   ${identity.revoked_at || 'não'}`);
  console.log(`  último uso: ${identity.last_used_at || '(nunca)'}`);
}

function usage() {
  console.log(`
Uso: node admin.js <comando> [args]

Comandos:
  create-user <label> [--login <login>] [--scopes read,media,send] [--expires <ISO8601>]
      Cria uma nova identidade. Gera e IMPRIME o segredo (senha de login) UMA VEZ só - anote agora.

  list-users
      Lista identidades (sem mostrar os segredos - eles ficam só com hash salvo).

  revoke-user <id>
      Revoga uma identidade. Os refresh/access tokens dela deixam de funcionar.

  rotate-user <id>
      Gera um novo segredo para a identidade (invalida o antigo, reativa se estava revogada).
      Não invalida tokens de sessões OAuth já emitidas - use revoke-user + create-user se quiser isso.

  set-scopes <id> <read,media,send,transcribe>
      Troca os scopes de uma identidade existente (ex: liberar transcrição para quem já existia).

Scopes válidos: ${ALL_SCOPES.join(', ')}
`);
}

const [, , cmd, ...rest] = process.argv;

function flag(name, fallback) {
  const idx = rest.indexOf(`--${name}`);
  if (idx === -1 || idx === rest.length - 1) return fallback;
  return rest[idx + 1];
}

if (cmd === 'create-user') {
  const label = rest.find((a) => !a.startsWith('--'));
  if (!label) {
    console.error('Uso: node admin.js create-user "Nome" [--login nome] [--scopes read,media,send]');
    process.exit(1);
  }
  const login = flag('login', label.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, ''));
  const scopesArg = flag('scopes', 'read,media,send');
  const scopes = scopesArg
    .split(',')
    .map((s) => s.trim())
    // Atalho de conveniência: "read" vira "whatsapp:read" - mas só quando o
    // valor não é JÁ um scope válido por si só (ex: "drive:read" não deve
    // virar "whatsapp:drive:read"). Checa contra ALL_SCOPES em vez de só
    // olhar o prefixo "whatsapp:", pra não quebrar com novas famílias de
    // scope (ex: "drive:*").
    .map((s) => (ALL_SCOPES.includes(s) ? s : `whatsapp:${s}`));
  const expires = flag('expires', null);
  const secret = `wapp_${crypto.randomBytes(24).toString('base64url')}`;
  try {
    const identity = store.create({ label, login, secret, scopes, expires_at: expires });
    console.log('Identidade criada com sucesso.\n');
    printIdentity(identity);
    console.log(`\n  SEGREDO (login na tela de autorização do Claude - anote agora, não será mostrado de novo):`);
    console.log(`  ${secret}\n`);
  } catch (err) {
    console.error('Erro:', err.message);
    process.exit(1);
  }
} else if (cmd === 'list-users') {
  const identities = store.list();
  if (!identities.length) {
    console.log('Nenhuma identidade cadastrada.');
  } else {
    for (const identity of identities) {
      printIdentity(identity);
      console.log('');
    }
  }
} else if (cmd === 'revoke-user') {
  const id = rest[0];
  if (!id) {
    console.error('Uso: node admin.js revoke-user <id>');
    process.exit(1);
  }
  try {
    store.revoke(id);
    console.log(`Identidade ${id} revogada. Tokens de acesso e refresh dela deixam de funcionar.`);
  } catch (err) {
    console.error('Erro:', err.message);
    process.exit(1);
  }
} else if (cmd === 'rotate-user') {
  const id = rest[0];
  if (!id) {
    console.error('Uso: node admin.js rotate-user <id>');
    process.exit(1);
  }
  const secret = `wapp_${crypto.randomBytes(24).toString('base64url')}`;
  try {
    store.rotateSecret(id, secret);
    console.log(`Novo segredo gerado para ${id} (anote agora, não será mostrado de novo):`);
    console.log(`  ${secret}`);
  } catch (err) {
    console.error('Erro:', err.message);
    process.exit(1);
  }
} else if (cmd === 'set-scopes') {
  const id = rest[0];
  const scopesArg = rest[1];
  if (!id || !scopesArg) {
    console.error('Uso: node admin.js set-scopes <id> <read,media,send,transcribe>');
    process.exit(1);
  }
  const scopes = scopesArg
    .split(',')
    .map((s) => s.trim())
    // Atalho de conveniência: "read" vira "whatsapp:read" - mas só quando o
    // valor não é JÁ um scope válido por si só (ex: "drive:read" não deve
    // virar "whatsapp:drive:read"). Checa contra ALL_SCOPES em vez de só
    // olhar o prefixo "whatsapp:", pra não quebrar com novas famílias de
    // scope (ex: "drive:*").
    .map((s) => (ALL_SCOPES.includes(s) ? s : `whatsapp:${s}`));
  try {
    const identity = store.setScopes(id, scopes);
    console.log(`Scopes atualizados para ${id}:`, identity.scopes.join(', '));
  } catch (err) {
    console.error('Erro:', err.message);
    process.exit(1);
  }
} else {
  usage();
  process.exit(cmd ? 1 : 0);
}
