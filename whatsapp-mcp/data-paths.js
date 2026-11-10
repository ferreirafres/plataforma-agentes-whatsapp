import path from 'node:path';

export const DATA_ROOT = path.resolve(process.env.MCP_DATA_DIR || './data');
export const OAUTH_DATA_DIR = path.join(DATA_ROOT, '.oauth-data');
