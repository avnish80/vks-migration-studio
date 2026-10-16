import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** Built UI assets. Missing in development; the API still works. */
  uiDir: string;
  /** Repository dist/ folder holding the reused planning modules. */
  coreDir: string;
  /** Extra host names allowed in the Host header (for example a reverse proxy name). */
  allowedHosts: string[];
  /** Fixed access token, mainly for tests and automation. Generated when unset. */
  token?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.STUDIO_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('STUDIO_PORT must be a port number');
  const root = path.resolve(import.meta.dirname, '..', '..');
  return {
    host: env.STUDIO_HOST ?? '127.0.0.1',
    port,
    dataDir: path.resolve(env.STUDIO_DATA_DIR ?? path.join(root, '.studio-data')),
    uiDir: path.resolve(env.STUDIO_UI_DIR ?? path.join(root, 'ui', 'dist')),
    coreDir: path.resolve(env.STUDIO_CORE_DIR ?? path.join(root, 'dist')),
    allowedHosts: (env.STUDIO_ALLOWED_HOSTS ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean),
    token: env.STUDIO_TOKEN || undefined,
  };
}
