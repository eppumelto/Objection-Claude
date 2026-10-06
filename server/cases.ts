import { Router } from 'express';
import { db } from './db.ts';
import { requireUser, type AuthedRequest } from './auth.ts';
import { normaliseCase, slugify, validateCase, type CaseFile } from '../shared/types.ts';

interface CaseRow { pk: number; user_id: number | null; case_id: string; data: string }

/** Finds a case visible to the user: their own first, then built-in. */
export function findCase(userId: number, caseId: string): CaseRow | undefined {
  return db
    .prepare(
      `SELECT pk, user_id, case_id, data FROM cases
       WHERE case_id = ? AND (user_id = ? OR user_id IS NULL)
       ORDER BY user_id IS NULL LIMIT 1`,
    )
    .get(caseId, userId) as CaseRow | undefined;
}

function idTaken(userId: number, caseId: string, exceptPk?: number): boolean {
  const row = db
    .prepare('SELECT pk FROM cases WHERE case_id = ? AND (user_id = ? OR user_id IS NULL)')
    .all(caseId, userId) as { pk: number }[];
  return row.some((r) => r.pk !== exceptPk);
}

function uniqueId(userId: number, base: string): string {
  let id = base;
  for (let i = 2; idTaken(userId, id); i++) id = `${base}-${i}`;
  return id;
}

export const casesRouter = Router();
casesRouter.use(requireUser);

casesRouter.get('/', (req: AuthedRequest, res) => {
  const uid = req.user!.id;
  const rows = db
    .prepare('SELECT pk, user_id, case_id, data FROM cases WHERE user_id IS NULL OR user_id = ? ORDER BY user_id IS NOT NULL, created_at, pk')
    .all(uid) as CaseRow[];
  const best = db.prepare(
    `SELECT MAX(score) AS best FROM trials WHERE user_id = ? AND case_id = ? AND status = 'finished'`,
  );
  res.json({
    cases: rows.map((r) => {
      const c = JSON.parse(r.data) as CaseFile;
      const b = best.get(uid, r.case_id) as { best: number | null };
      return {
        id: r.case_id,
        title: c.title,
        charge: c.charge,
        witnessCount: c.witnesses.length,
        builtin: r.user_id === null,
        bestScore: b.best,
      };
    }),
  });
});

casesRouter.get('/:id', (req: AuthedRequest, res) => {
  const row = findCase(req.user!.id, String(req.params.id));
  if (!row) return void res.status(404).json({ error: 'Case not found.' });
  res.json({ case: JSON.parse(row.data), builtin: row.user_id === null });
});

casesRouter.get('/:id/export', (req: AuthedRequest, res) => {
  const row = findCase(req.user!.id, String(req.params.id));
  if (!row) return void res.status(404).json({ error: 'Case not found.' });
  res.setHeader('Content-Disposition', `attachment; filename="${row.case_id}.json"`);
  res.type('application/json').send(JSON.stringify(JSON.parse(row.data), null, 2));
});

function prepareInput(uid: number, body: unknown): { errors: string[]; data?: CaseFile } {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const b = body as Partial<CaseFile>;
    if ((b.id === undefined || (typeof b.id === 'string' && !b.id.trim())) && typeof b.title === 'string' && b.title.trim())
      b.id = uniqueId(uid, slugify(b.title));
  }
  const errors = validateCase(body);
  if (errors.length) return { errors };
  return { errors, data: normaliseCase(body as CaseFile) };
}

casesRouter.post('/', (req: AuthedRequest, res) => {
  const uid = req.user!.id;
  const { errors, data } = prepareInput(uid, req.body?.case);
  if (!data) return void res.status(400).json({ error: errors.join(' '), errors });
  if (idTaken(uid, data.id)) return void res.status(409).json({ error: `A case with id "${data.id}" already exists.` });
  const now = Date.now();
  db.prepare('INSERT INTO cases (user_id, case_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    uid, data.id, JSON.stringify(data), now, now,
  );
  res.status(201).json({ case: data });
});

casesRouter.post('/import', (req: AuthedRequest, res) => {
  const uid = req.user!.id;
  const body = req.body?.case;
  const { errors, data } = prepareInput(uid, body);
  if (!data) return void res.status(400).json({ error: `Invalid case file: ${errors.join(' ')}`, errors });
  data.id = uniqueId(uid, data.id);
  const now = Date.now();
  db.prepare('INSERT INTO cases (user_id, case_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    uid, data.id, JSON.stringify(data), now, now,
  );
  res.status(201).json({ case: data });
});

casesRouter.put('/:id', (req: AuthedRequest, res) => {
  const uid = req.user!.id;
  const row = findCase(uid, String(req.params.id));
  if (!row) return void res.status(404).json({ error: 'Case not found.' });
  if (row.user_id === null) return void res.status(403).json({ error: 'Built-in cases cannot be edited.' });
  const { errors, data } = prepareInput(uid, req.body?.case);
  if (!data) return void res.status(400).json({ error: errors.join(' '), errors });
  if (idTaken(uid, data.id, row.pk)) return void res.status(409).json({ error: `A case with id "${data.id}" already exists.` });
  db.prepare('UPDATE cases SET case_id = ?, data = ?, updated_at = ? WHERE pk = ?').run(
    data.id, JSON.stringify(data), Date.now(), row.pk,
  );
  res.json({ case: data });
});

casesRouter.delete('/:id', (req: AuthedRequest, res) => {
  const row = findCase(req.user!.id, String(req.params.id));
  if (!row) return void res.status(404).json({ error: 'Case not found.' });
  if (row.user_id === null) return void res.status(403).json({ error: 'Built-in cases cannot be deleted.' });
  db.prepare('DELETE FROM cases WHERE pk = ?').run(row.pk);
  res.json({ ok: true });
});
