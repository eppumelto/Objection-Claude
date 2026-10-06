import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { normaliseCase, validateCase, type CaseFile } from '../shared/types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cases (
  pk INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, -- NULL = built-in
  case_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cases_owner_id ON cases(IFNULL(user_id, 0), case_id);
CREATE TABLE IF NOT EXISTS trials (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  case_title TEXT NOT NULL,
  case_data TEXT NOT NULL,
  state TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  verdict TEXT,
  score INTEGER,
  objections_raised INTEGER NOT NULL DEFAULT 0,
  objections_sustained INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS trials_user ON trials(user_id, created_at);
CREATE TABLE IF NOT EXISTS lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  speaker TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  phase TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lines_trial ON lines(trial_id, seq);
`;

export function openDb(): Database.Database {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

/** Loads every *.json file in /cases as a built-in case (replacing existing built-ins). */
export function seed(db: Database.Database): number {
  const files = fs.existsSync(config.casesDir) ? fs.readdirSync(config.casesDir).filter((f) => f.endsWith('.json')) : [];
  const now = Date.now();
  const upsert = db.prepare(
    `INSERT INTO cases (user_id, case_id, data, created_at, updated_at) VALUES (NULL, ?, ?, ?, ?)
     ON CONFLICT(IFNULL(user_id, 0), case_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  );
  let n = 0;
  db.transaction(() => {
    for (const f of files.sort()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(config.casesDir, f), 'utf8'));
      } catch (e) {
        console.warn(`[seed] skipping ${f}: invalid JSON (${(e as Error).message})`);
        continue;
      }
      const errors = validateCase(parsed);
      if (errors.length) {
        console.warn(`[seed] skipping ${f}: ${errors.join(' ')}`);
        continue;
      }
      const c = normaliseCase(parsed as CaseFile);
      upsert.run(c.id, JSON.stringify(c), now, now);
      n++;
    }
  })();
  return n;
}

export function wipe(db: Database.Database) {
  db.pragma('foreign_keys = OFF');
  db.exec('DROP TABLE IF EXISTS lines; DROP TABLE IF EXISTS trials; DROP TABLE IF EXISTS cases; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS users;');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
}

export const db = openDb();
if ((db.prepare('SELECT COUNT(*) AS n FROM cases WHERE user_id IS NULL').get() as { n: number }).n === 0) {
  const n = seed(db);
  console.log(`[db] seeded ${n} built-in case(s)`);
}
