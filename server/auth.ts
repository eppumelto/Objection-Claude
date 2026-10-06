import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { db } from './db.ts';

const COOKIE = 'sid';
const SESSION_MS = 30 * 24 * 3600 * 1000;

export interface AuthedRequest extends Request {
  user?: { id: number; email: string };
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function startSession(res: Response, userId: number) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, Date.now());
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_MS, path: '/' });
}

/** Attaches req.user when a valid session cookie is present. */
export function sessionMiddleware(req: AuthedRequest, _res: Response, next: NextFunction) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const row = db
      .prepare(
        `SELECT u.id, u.email, s.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
      )
      .get(token) as { id: number; email: string; created_at: number } | undefined;
    if (row && Date.now() - row.created_at < SESSION_MS) req.user = { id: row.id, email: row.email };
  }
  next();
}

export function requireUser(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.user) return void res.status(401).json({ error: 'Not logged in.' });
  next();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const authRouter = Router();

authRouter.post('/register', (req: AuthedRequest, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!EMAIL_RE.test(email)) return void res.status(400).json({ error: 'Please enter a valid email address.' });
  if (password.length < 8) return void res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email))
    return void res.status(409).json({ error: 'An account with this email already exists.' });
  const info = db
    .prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
    .run(email, hashPassword(password), Date.now());
  startSession(res, Number(info.lastInsertRowid));
  res.status(201).json({ user: { id: Number(info.lastInsertRowid), email } });
});

authRouter.post('/login', (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const row = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email) as
    | { id: number; email: string; password_hash: string }
    | undefined;
  if (!row || !verifyPassword(password, row.password_hash))
    return void res.status(401).json({ error: 'Invalid email or password.' });
  startSession(res, row.id);
  res.json({ user: { id: row.id, email: row.email } });
});

authRouter.post('/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', (req: AuthedRequest, res) => {
  res.json({ user: req.user ?? null });
});
