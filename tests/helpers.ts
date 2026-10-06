import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface Server { url: string; dbPath: string; proc: ChildProcess; stop: () => Promise<void> }

/** Starts the app in mock-AI mode on a free port with a throwaway database. */
export async function startServer(env: Record<string, string> = {}): Promise<Server> {
  const port = 3200 + Math.floor(Math.random() * 600);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'objection-test-'));
  const proc = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts', '--prod'], {
    cwd: ROOT,
    env: { ...process.env, AI_MOCK: '1', MOCK_TOKEN_MS: '0', PORT: String(port), DB_PATH: path.join(dir, 'test.db'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout!.on('data', (d) => (log += d));
  proc.stderr!.on('data', (d) => (log += d));
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 150; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited:\n${log}`);
    try {
      const r = await fetch(`${url}/api/auth/me`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    url,
    dbPath: path.join(dir, 'test.db'),
    proc,
    stop: () => new Promise<void>((resolve) => {
      proc.once('exit', () => { fs.rmSync(dir, { recursive: true, force: true }); resolve(); });
      proc.kill();
    }),
  };
}

/** A tiny API client with its own cookie jar. */
export class Client {
  cookie = '';
  constructor(public base: string) {}

  async req(method: string, url: string, body?: unknown): Promise<{ status: number; data: any; text: string }> {
    const res = await fetch(this.base + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, data, text };
  }

  async register(email = `u${Math.random().toString(36).slice(2)}@test.dev`, password = 'password123') {
    const r = await this.req('POST', '/api/auth/register', { email, password });
    if (r.status !== 201) throw new Error(`register failed: ${r.text}`);
    return email;
  }

  /** Sends a trial action; returns the HTTP status, the parsed NDJSON events and the final state. */
  async action(trialId: string, action: object) {
    const r = await this.req('POST', `/api/trials/${trialId}/actions`, action);
    if (r.status !== 200) return { status: r.status, events: [], state: null as any, error: r.data?.error };
    const events = r.text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const states = events.filter((e: any) => e.t === 'state');
    return { status: 200, events, state: states[states.length - 1].trial, error: null };
  }

  async trial(id: string) {
    return (await this.req('GET', `/api/trials/${id}`)).data;
  }
}
