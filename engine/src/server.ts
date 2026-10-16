import path from 'node:path';
import { loadConfig } from './config.js';
import { openDatabase, migrate } from './db/index.js';
import { loadCore } from './core.js';
import { loadOrCreateToken } from './token.js';
import { buildApp } from './app.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(path.join(config.dataDir, 'studio.db'));
  const applied = await migrate(db);
  const core = loadCore(config.coreDir);
  const { token, created } = loadOrCreateToken(config.dataDir, config.token);
  const app = await buildApp({ config, db, core, token, logger: true });
  await app.listen({ host: config.host, port: config.port });
  const shown = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  process.stdout.write(`\nVKS Migration Studio ${VERSION}\n` +
    (applied.length ? `Database migrations applied: ${applied.join(', ')}\n` : '') +
    (created ? `\nOpen this link to sign in (shown once; the token is stored in ${path.join(config.dataDir, 'token')}):\n  http://${shown}:${config.port}/?token=${token}\n\n`
             : `\nOpen http://${shown}:${config.port}/ and sign in with the token stored in ${path.join(config.dataDir, 'token')}.\n\n`));
  const stop = async () => { await app.close(); await db.destroy(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(error => { process.stderr.write(`Failed to start: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
