import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Loads the access token from <dataDir>/token, creating it (mode 0600) on first start.
 * Returns whether it was created, so the server prints it only once.
 */
export function loadOrCreateToken(dataDir: string, fixed?: string): { token: string; created: boolean } {
  if (fixed) {
    if (fixed.length < 32) throw new Error('STUDIO_TOKEN must be at least 32 characters');
    return { token: fixed, created: false };
  }
  const file = path.join(dataDir, 'token');
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (token.length >= 32) return { token, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeSync(fd, token + '\n'); } finally { fs.closeSync(fd); }
  return { token, created: true };
}

export function tokenMatches(expected: string, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(supplied).digest();
  return crypto.timingSafeEqual(a, b);
}
