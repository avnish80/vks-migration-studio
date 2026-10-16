import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, makeApp, TOKEN } from './helpers.js';
import { hostname, redactUrl } from '../src/app.js';

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

describe('access control', () => {
  it('serves health without a token', async () => {
    ({ app } = await makeApp());
    const res = await app.inject({ url: '/api/health', headers: { host: 'localhost:8080' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('refuses API calls without a valid token', async () => {
    ({ app } = await makeApp());
    for (const authorization of [undefined, 'Bearer wrong', `Basic ${TOKEN}`, `Bearer ${TOKEN}x`]) {
      const res = await app.inject({ url: '/api/projects', headers: { host: '127.0.0.1', ...(authorization ? { authorization } : {}) } });
      expect(res.statusCode, String(authorization)).toBe(401);
    }
    expect((await app.inject({ url: '/api/projects', headers: auth })).statusCode).toBe(200);
  });

  it('refuses foreign Host headers even with a token (DNS rebinding)', async () => {
    ({ app } = await makeApp());
    for (const host of ['evil.example', 'evil.example:8080', '127.0.0.1.evil.example', 'localhost.evil.example']) {
      const res = await app.inject({ url: '/api/health', headers: { ...auth, host } });
      expect(res.statusCode, host).toBe(403);
    }
    for (const host of ['localhost', '127.0.0.1:9000', '[::1]:8080']) {
      expect((await app.inject({ url: '/api/health', headers: { host } })).statusCode, host).toBe(200);
    }
  });

  it('refuses cross-origin writes even with a token', async () => {
    ({ app } = await makeApp());
    const res = await app.inject({ method: 'POST', url: '/api/projects', headers: { ...auth, origin: 'https://evil.example' }, payload: { name: 'x' } });
    expect(res.statusCode).toBe(403);
    const same = await app.inject({ method: 'POST', url: '/api/projects', headers: { ...auth, origin: 'http://127.0.0.1:8080' }, payload: { name: 'x' } });
    expect(same.statusCode).toBe(201);
  });

  it('sets security headers and no-store on API responses', async () => {
    ({ app } = await makeApp());
    const res = await app.inject({ url: '/api/version', headers: auth });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('never logs the sign-in token', () => {
    expect(redactUrl('/?token=abc123&x=1')).toBe('/?token=REDACTED&x=1');
    expect(redactUrl('/estate?a=1&TOKEN=abc')).toBe('/estate?a=1&TOKEN=REDACTED');
    expect(redactUrl('/api/health')).toBe('/api/health');
  });

  it('parses host names', () => {
    expect(hostname('LOCALHOST:8080')).toBe('localhost');
    expect(hostname('[::1]:80')).toBe('[::1]');
    expect(hostname(undefined)).toBe('');
  });
});
