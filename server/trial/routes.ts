import { Router, type Response } from 'express';
import { db } from '../db.ts';
import { requireUser, type AuthedRequest } from '../auth.ts';
import { findCase } from '../cases.ts';
import {
  applyAction, createTrial, HttpError, loadTrial, lock, runPending, transcriptMarkdown, unlock, view,
  type Action, type StreamEvent,
} from './engine.ts';

export const trialsRouter = Router();
trialsRouter.use(requireUser);

function fail(res: Response, e: unknown) {
  if (e instanceof HttpError) return void res.status(e.status).json({ error: e.message });
  console.error(e);
  res.status(500).json({ error: 'Internal server error.' });
}

trialsRouter.post('/', (req: AuthedRequest, res) => {
  const row = findCase(req.user!.id, String(req.body?.caseId ?? ''));
  if (!row) return void res.status(404).json({ error: 'Case not found.' });
  const id = createTrial(req.user!.id, JSON.parse(row.data));
  res.status(201).json({ id });
});

/** Finished trials (history), plus active ones so they can be resumed. */
trialsRouter.get('/', (req: AuthedRequest, res) => {
  const rows = db
    .prepare(
      `SELECT id, case_id, case_title, status, verdict, score, created_at, finished_at FROM trials
       WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(req.user!.id) as Record<string, unknown>[];
  res.json({
    trials: rows.map((r) => ({
      id: r.id, caseId: r.case_id, caseTitle: r.case_title, status: r.status, verdict: r.verdict,
      score: r.score, createdAt: r.created_at, finishedAt: r.finished_at,
    })),
  });
});

trialsRouter.get('/:id', (req: AuthedRequest, res) => {
  try {
    const t = loadTrial(String(req.params.id), req.user!.id);
    res.json({ trial: view(t), transcript: t.lines });
  } catch (e) { fail(res, e); }
});

trialsRouter.get('/:id/transcript.md', (req: AuthedRequest, res) => {
  try {
    const t = loadTrial(String(req.params.id), req.user!.id);
    res.setHeader('Content-Disposition', `attachment; filename="transcript-${t.c.id}-${t.id.slice(0, 8)}.md"`);
    res.type('text/markdown').send(transcriptMarkdown(t));
  } catch (e) { fail(res, e); }
});

/**
 * Applies a player action and streams the resulting AI dialogue as NDJSON events.
 * Out-of-order actions are rejected with 409 before any streaming starts.
 */
trialsRouter.post('/:id/actions', async (req: AuthedRequest, res) => {
  const id = String(req.params.id);
  let t;
  try { t = loadTrial(id, req.user!.id); } catch (e) { return fail(res, e); }
  if (!lock(id)) return void res.status(409).json({ error: 'The court is still speaking. Please wait.', busy: true });
  try {
    t = loadTrial(id, req.user!.id); // re-read under the lock
    const buffered: StreamEvent[] = [];
    try {
      applyAction(t, (req.body ?? {}) as Action, (e) => buffered.push(e));
    } catch (e) { return fail(res, e); }

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    // Generation continues even if the client disconnects; the result is saved and visible on reload.
    const emit = (e: StreamEvent) => {
      if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(e) + '\n');
    };
    for (const e of buffered) emit(e);
    emit({ t: 'state', trial: view(t) });
    await runPending(t, emit);
    unlock(id);
    emit({ t: 'state', trial: view(t) });
    res.end();
  } finally {
    unlock(id);
  }
});

export const statsRouter = Router();
statsRouter.use(requireUser);

statsRouter.get('/', (req: AuthedRequest, res) => {
  const rows = db
    .prepare(
      `SELECT id, case_title, verdict, score, objections_raised, objections_sustained, finished_at
       FROM trials WHERE user_id = ? AND status = 'finished' ORDER BY finished_at`,
    )
    .all(req.user!.id) as { id: string; case_title: string; verdict: string; score: number; objections_raised: number; objections_sustained: number; finished_at: number }[];
  const played = rows.length;
  const wins = rows.filter((r) => r.verdict === 'Not guilty').length;
  const raised = rows.reduce((s, r) => s + r.objections_raised, 0);
  const sustained = rows.reduce((s, r) => s + r.objections_sustained, 0);
  res.json({
    played,
    winRate: played ? Math.round((100 * wins) / played) : 0,
    avgScore: played ? Math.round(rows.reduce((s, r) => s + r.score, 0) / played) : 0,
    objectionRate: raised ? Math.round((100 * sustained) / raised) : 0,
    objectionsRaised: raised,
    series: rows.map((r) => ({ id: r.id, caseTitle: r.case_title, score: r.score, verdict: r.verdict, at: r.finished_at })),
  });
});
