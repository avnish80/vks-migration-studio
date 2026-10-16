import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { loadCore } from '../src/core.js';
import { openDatabase, migrate } from '../src/db/index.js';

export const TOKEN = 't'.repeat(43);
export const auth = { authorization: `Bearer ${TOKEN}`, host: '127.0.0.1:8080' };

export async function makeApp(options: { uiDir?: string; allowedHosts?: string } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
  const config = { ...loadConfig({ STUDIO_DATA_DIR: dataDir, STUDIO_ALLOWED_HOSTS: options.allowedHosts }), uiDir: options.uiDir ?? path.join(dataDir, 'no-ui') };
  const db = openDatabase(':memory:');
  await migrate(db);
  const app = await buildApp({ config, db, core: loadCore(config.coreDir), token: TOKEN });
  return { app, db, dataDir };
}
