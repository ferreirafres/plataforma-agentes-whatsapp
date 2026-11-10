import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { OAUTH_DATA_DIR } from './data-paths.js';

const makeSecret = () => crypto.randomBytes(32).toString('base64url');

function writePrivate(file, value) {
  fs.writeFileSync(file + '.tmp', value, { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

export function initialPassword() {
  if (process.env.MCP_TOKEN) return process.env.MCP_TOKEN;
  const file = path.join(OAUTH_DATA_DIR, 'initial-admin-password.txt');
  if (!fs.existsSync(file)) writePrivate(file, makeSecret() + '\n');
  return fs.readFileSync(file, 'utf8').trim();
}

export async function provisionPlatform({ identityStore, provider, instance, name, publicUrl }) {
  const outputDir = process.env.PLATFORM_BOOTSTRAP_DIR;
  if (!outputDir) return;
  const file = path.join(OAUTH_DATA_DIR, 'connection-management.json');
  const id = 'platform-runtime';
  let config;
  if (fs.existsSync(file)) {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    config = {
      management_key: makeSecret(), identity_id: id,
      client_id: 'platform-' + crypto.randomUUID(), password: makeSecret(),
    };
    writePrivate(file, JSON.stringify(config));
  }
  if (config.identity_id === id && !identityStore.getById(id)) {
    identityStore.create({
      id, login: 'agentes-platform', label: 'Plataforma Agentes', secret: config.password,
      scopes: ['whatsapp:read', 'whatsapp:session', 'whatsapp:labels', 'whatsapp:send'],
    });
  }
  if (!await provider.clientsStore.getClient(config.client_id)) {
    await provider.clientsStore.registerClient({
      client_id: config.client_id, client_name: 'Plataforma Agentes',
      redirect_uris: [], grant_types: ['refresh_token'], token_endpoint_auth_method: 'none',
    });
  }
  fs.mkdirSync(outputDir, { recursive: true });
  writePrivate(path.join(outputDir, 'mcp.json'), JSON.stringify({
    name, instance, base_url: publicUrl, management_key: config.management_key,
    client_id: config.client_id,
  }));
}
