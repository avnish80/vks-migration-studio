import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadOrCreateToken, tokenMatches } from '../src/token.js';
import { openDatabase, migrate } from '../src/db/index.js';
import { loadCore } from '../src/core.js';
import { loadConfig } from '../src/config.js';
import { auth, makeApp } from './helpers.js';
import { VERSION } from '../src/version.js';

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

describe('start-up', () => {
  it('creates the token once with mode 0600 and reuses it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-token-'));
    const first = loadOrCreateToken(dir);
    expect(first.created).toBe(true);
    expect(first.token.length).toBeGreaterThanOrEqual(43);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'token')).mode & 0o777).toBe(0o600);
    const second = loadOrCreateToken(dir);
    expect(second).toEqual({ token: first.token, created: false });
    expect(() => loadOrCreateToken(dir, 'short')).toThrow(/32/);
    // An empty or truncated token file is replaced instead of blocking start-up.
    fs.writeFileSync(path.join(dir, 'token'), '');
    const replaced = loadOrCreateToken(dir);
    expect(replaced.created).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'token'), 'utf8').trim()).toBe(replaced.token);
    expect(tokenMatches(first.token, first.token)).toBe(true);
    expect(tokenMatches(first.token, undefined)).toBe(false);
  });

  it('migrates a file database idempotently', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-db-')), 'studio.db');
    let db = openDatabase(file);
    expect(await migrate(db)).toEqual(['001_initial', '002_inventory', '003_pilots']);
    await db.destroy();
    db = openDatabase(file);
    expect(await migrate(db)).toEqual([]);
    await db.destroy();
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('loads every reused planning module from dist/', async () => {
    const core = loadCore(loadConfig({}).coreDir);
    expect(Object.keys(core.modules)).toHaveLength(16);
    const engine = core.modules.engine as { analyze: (raw: unknown) => { findings: unknown[] } };
    const demo = JSON.parse(fs.readFileSync(path.join(core.dir, 'demo.json'), 'utf8'));
    expect(engine.analyze(demo).findings.length).toBeGreaterThan(0);
    ({ app } = await makeApp());
    expect((await app.inject({ url: '/api/version', headers: auth })).json()).toMatchObject({ version: VERSION });
  });

  it('serves the UI shell for client routes but JSON 404 for unknown API paths', async () => {
    const ui = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ui-'));
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>Studio</title>');
    ({ app } = await makeApp({ uiDir: ui }));
    const page = await app.inject({ url: '/estate', headers: { host: 'localhost' } });
    expect(page.statusCode).toBe(200);
    expect((await app.inject({ method: 'HEAD', url: '/estate', headers: { host: 'localhost' } })).statusCode).toBe(200);
    expect(page.body).toContain('<title>Studio</title>');
    const api = await app.inject({ url: '/api/nope', headers: auth });
    expect(api.statusCode).toBe(404);
    expect(api.json().error).toBe('NotFound');
  });
});
