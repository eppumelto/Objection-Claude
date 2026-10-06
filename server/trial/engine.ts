// The trial state machine. All rules (phases, turns, evidence, contradictions, scores, verdict)
// live here as deterministic code; AI agents are only asked for dialogue and the closing grade.

import crypto from 'node:crypto';
import { db } from '../db.ts';
import { config } from '../config.ts';
import * as ai from '../ai/agents.ts';
import { AiError } from '../ai/ollama.ts';
import {
  OBJECTION_TYPES,
  type CaseFile,
  type ObjectionType,
  type Phase,
  type Role,
  type Ruling,
  type ScoreBreakdown,
  type Step,
  type TranscriptLine,
  type TrialView,
} from '../../shared/types.ts';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Task =
  | { kind: 'prosecutor_opening' }
  | { kind: 'prosecutor_closing' }
  | { kind: 'direct_question'; w: number; k: number }
  | { kind: 'witness_answer'; w: number; question: string }
  | { kind: 'witness_press'; w: number; statementId: string }
  | { kind: 'witness_reaction'; w: number; statementId: string; evidenceId: string }
  | { kind: 'judge_warning'; statementId: string; evidenceId: string }
  | { kind: 'ruling'; by: 'defense' | 'prosecution'; type: ObjectionType; question: string; w: number }
  | { kind: 'prosecutor_objection'; w: number; question: string }
  | { kind: 'judge_grade'; text: string }
  | { kind: 'judge_verdict' };

interface Grade { usesContradictions: number; addressesCharge: number; coherence: number; persuasiveness: number; total: number }

export interface TrialState {
  phase: Phase;
  step: Step;
  witnessIndex: number;
  questionNo: number;
  actionsLeft: number;
  ack: boolean;
  /** Found contradiction pairs as "statementId|evidenceId". */
  found: string[];
  wrong: number;
  objRaised: number;
  objSustained: number;
  closing: Grade | null;
  lastRuling: Ruling | null;
  lastQuestion: string | null;
  notice: string | null;
  pending: Task[];
  aiError: string | null;
  failNext: boolean;
  deadline: number | null;
  verdict: 'Guilty' | 'Not guilty' | null;
  examStartSeq: number;
}

export interface Trial {
  id: string;
  userId: number;
  c: CaseFile;
  state: TrialState;
  lines: TranscriptLine[];
  createdAt: number;
}

export type StreamEvent =
  | { t: 'start'; speaker: string; role: Role }
  | { t: 'token'; text: string }
  | { t: 'wait'; label: string }
  | { t: 'line'; line: TranscriptLine }
  | { t: 'error'; message: string }
  | { t: 'state'; trial: TrialView };
export type Emit = (e: StreamEvent) => void;

/** Trials currently running AI work (single process, so in-memory is enough). */
const busy = new Set<string>();
export const isBusy = (id: string) => busy.has(id);
export function lock(id: string): boolean {
  if (busy.has(id)) return false;
  busy.add(id);
  return true;
}
export const unlock = (id: string) => void busy.delete(id);

// ---------- persistence ----------

export function createTrial(userId: number, c: CaseFile): string {
  const id = crypto.randomUUID();
  const state: TrialState = {
    phase: 'OPENING', step: 'opening_input', witnessIndex: 0, questionNo: 0, actionsLeft: 0, ack: false,
    found: [], wrong: 0, objRaised: 0, objSustained: 0, closing: null, lastRuling: null, lastQuestion: null,
    notice: null, pending: [], aiError: null, failNext: false, deadline: null, verdict: null, examStartSeq: 1,
  };
  db.prepare(
    `INSERT INTO trials (id, user_id, case_id, case_title, case_data, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, c.id, c.title, JSON.stringify(c), JSON.stringify(state), Date.now());
  return id;
}

/** Loads a trial owned by the user; other users' trials are reported as not found. */
export function loadTrial(id: string, userId: number): Trial {
  const row = db.prepare('SELECT * FROM trials WHERE id = ? AND user_id = ?').get(id, userId) as
    | { id: string; user_id: number; case_data: string; state: string; created_at: number }
    | undefined;
  if (!row) throw new HttpError(404, 'Trial not found.');
  const lines = db
    .prepare('SELECT seq, speaker, role, text, phase, ts FROM lines WHERE trial_id = ? ORDER BY seq')
    .all(id) as TranscriptLine[];
  return { id: row.id, userId: row.user_id, c: JSON.parse(row.case_data), state: JSON.parse(row.state), lines, createdAt: row.created_at };
}

function save(t: Trial) {
  const s = t.state;
  const finished = s.phase === 'VERDICT';
  db.prepare(
    `UPDATE trials SET state = ?, status = ?, verdict = ?, score = ?, objections_raised = ?, objections_sustained = ?,
       finished_at = CASE WHEN ? AND finished_at IS NULL THEN ? ELSE finished_at END
     WHERE id = ?`,
  ).run(
    JSON.stringify(s), finished ? 'finished' : 'active', s.verdict, finished ? score(t).total : null,
    s.objRaised, s.objSustained, finished ? 1 : 0, Date.now(), t.id,
  );
}

function addLine(t: Trial, speaker: string, role: Role, text: string, emit: Emit): TranscriptLine {
  const line: TranscriptLine = { seq: t.lines.length + 1, speaker, role, text, phase: t.state.phase, ts: Date.now() };
  db.prepare('INSERT INTO lines (trial_id, seq, speaker, role, text, phase, ts) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    t.id, line.seq, line.speaker, line.role, line.text, line.phase, line.ts,
  );
  t.lines.push(line);
  emit({ t: 'line', line });
  return line;
}

// ---------- rules ----------

const pairKey = (s: string, e: string) => `${s}|${e}`;

export function score(t: Trial): ScoreBreakdown {
  const s = t.state;
  const contradictions = t.c.contradictions
    .filter((x) => s.found.includes(pairKey(x.statement, x.evidence)))
    .reduce((sum, x) => sum + (x.key ? 10 : 5), 0);
  const objections = s.objRaised ? Math.round((20 * s.objSustained) / s.objRaised) : 10;
  const closing = s.closing?.total ?? 0;
  const penalty = -3 * s.wrong;
  return { contradictions, objections, closing, penalty, total: Math.max(0, contradictions + objections + closing + penalty) };
}

function keyFound(t: Trial): number {
  return t.c.contradictions.filter((x) => x.key && t.state.found.includes(pairKey(x.statement, x.evidence))).length;
}

function banner(t: Trial): string {
  const s = t.state;
  const w = t.c.witnesses[s.witnessIndex];
  switch (s.phase) {
    case 'OPENING': return 'Opening';
    case 'PROSECUTION_CASE': return s.step === 'cross' ? `Cross-examination — ${w.name}` : `Direct examination — ${w.name}`;
    case 'CLOSING': return 'Closing';
    case 'VERDICT': return 'Verdict';
  }
}

function statementOf(t: Trial, id: string) {
  for (const w of t.c.witnesses) for (const s of w.testimony) if (s.id === id) return { witness: w, statement: s };
  return null;
}

export function view(t: Trial): TrialView {
  const s = t.state;
  const contradicted = [...new Set(s.found.map((p) => p.split('|')[0]))];
  const sc = score(t);
  return {
    id: t.id,
    caseId: t.c.id,
    caseTitle: t.c.title,
    charge: t.c.charge,
    defendant: t.c.defendant,
    witnesses: t.c.witnesses.map((w) => ({ id: w.id, name: w.name, role: w.role, testimony: w.testimony })),
    evidence: t.c.evidence,
    phase: s.phase,
    step: s.step,
    banner: banner(t),
    witnessIndex: s.witnessIndex,
    questionNo: s.questionNo,
    actionsLeft: s.actionsLeft,
    ack: s.ack,
    contradicted,
    lastRuling: s.lastRuling,
    notice: s.notice,
    pending: s.pending.length,
    busy: isBusy(t.id),
    aiError: s.aiError,
    deadline: s.deadline,
    serverNow: Date.now(),
    turnSeconds: config.turnSeconds,
    score: sc,
    verdict: s.verdict,
    result:
      s.phase === 'VERDICT'
        ? {
            keyFound: keyFound(t),
            rule: t.c.verdictRule,
            contradictions: t.c.contradictions.map((x) => {
              const st = statementOf(t, x.statement);
              return {
                statement: x.statement,
                statementText: st?.statement.text ?? x.statement,
                witness: st?.witness.name ?? '',
                evidence: x.evidence,
                evidenceName: t.c.evidence.find((e) => e.id === x.evidence)?.name ?? x.evidence,
                key: x.key,
                found: s.found.includes(pairKey(x.statement, x.evidence)),
              };
            }),
            objectionsRaised: s.objRaised,
            objectionsSustained: s.objSustained,
            wrongPresentations: s.wrong,
          }
        : null,
  };
}

// ---------- transitions ----------

function enterDirect(t: Trial, w: number) {
  const s = t.state;
  s.phase = 'PROSECUTION_CASE';
  s.witnessIndex = w;
  s.step = 'direct_q';
  s.questionNo = 1;
  s.examStartSeq = t.lines.length + 1;
  s.pending = [{ kind: 'direct_question', w, k: 1 }];
}

function nextQuestionOrCross(t: Trial) {
  const s = t.state;
  if (s.questionNo < config.directQuestions) {
    s.questionNo++;
    s.step = 'direct_q';
    s.pending = [{ kind: 'direct_question', w: s.witnessIndex, k: s.questionNo }];
  } else {
    s.step = 'cross';
    s.actionsLeft = config.actionsPerWitness;
    s.ack = false;
  }
}

function advanceWitness(t: Trial) {
  const s = t.state;
  s.deadline = null;
  s.ack = false;
  s.actionsLeft = 0;
  if (s.witnessIndex + 1 < t.c.witnesses.length) enterDirect(t, s.witnessIndex + 1);
  else {
    s.phase = 'CLOSING';
    s.step = 'closing_input';
  }
}

function enterVerdict(t: Trial) {
  const s = t.state;
  s.phase = 'VERDICT';
  s.step = 'verdict';
  const ok = keyFound(t) >= t.c.verdictRule.minKeyContradictions && score(t).total >= t.c.verdictRule.minScore;
  s.verdict = ok ? 'Not guilty' : 'Guilty';
  s.pending = [{ kind: 'judge_verdict' }];
}

/** Starts the turn timer whenever the trial is waiting for a cross-examination action. */
function finalize(t: Trial) {
  const s = t.state;
  const waiting = s.step === 'cross' && s.actionsLeft > 0 && s.pending.length === 0 && !s.aiError;
  if (!waiting) s.deadline = null;
  else if (s.deadline === null) s.deadline = Date.now() + config.turnSeconds * 1000;
}

export type Action =
  | { type: 'opening'; text: string }
  | { type: 'closing'; text: string }
  | { type: 'continue' }
  | { type: 'object'; objection: string }
  | { type: 'press'; statementId: string }
  | { type: 'present'; statementId: string; evidenceId: string }
  | { type: 'ask'; text: string }
  | { type: 'next-witness' }
  | { type: 'timeout' }
  | { type: 'retry' };

const outOfOrder = () => new HttpError(409, 'That action is not allowed at this point of the trial.');

function text(v: unknown, max: number, what: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new HttpError(400, `${what} cannot be empty.`);
  if (s.length > max) throw new HttpError(400, `${what} must be at most ${max} characters.`);
  return s;
}

/** Validates and applies a player action. Throws HttpError (409 when out of order). */
export function applyAction(t: Trial, a: Action, emit: Emit) {
  const s = t.state;
  if (a.type === 'retry') {
    if (!s.pending.length) throw outOfOrder();
    return;
  }
  if (s.pending.length) throw outOfOrder();
  const witness = t.c.witnesses[s.witnessIndex];
  const inCross = s.step === 'cross';
  const crossAction = () => {
    if (!inCross || s.actionsLeft <= 0) throw outOfOrder();
    s.actionsLeft--;
    s.ack = true;
    s.deadline = null;
    s.lastRuling = null;
  };
  s.notice = null;

  switch (a.type) {
    case 'opening': {
      if (s.step !== 'opening_input') throw outOfOrder();
      const body = text(a.text, 1000, 'The opening statement');
      s.failNext = body.includes('#fail');
      addLine(t, 'Defense', 'defense', body, emit);
      s.step = 'opening_done';
      s.pending = [{ kind: 'prosecutor_opening' }];
      break;
    }
    case 'continue': {
      s.lastRuling = null;
      if (s.step === 'opening_done') enterDirect(t, 0);
      else if (s.step === 'direct_q') {
        s.step = 'direct_answered';
        s.pending = [{ kind: 'witness_answer', w: s.witnessIndex, question: s.lastQuestion ?? '' }];
      } else if (s.step === 'direct_ruled' || s.step === 'direct_answered') nextQuestionOrCross(t);
      else if (inCross && s.actionsLeft <= 0) advanceWitness(t);
      else if (inCross && s.ack) s.ack = false;
      else if (s.step === 'closing_done') enterVerdict(t);
      else throw outOfOrder();
      break;
    }
    case 'object': {
      if (s.step !== 'direct_q') throw outOfOrder();
      if (!OBJECTION_TYPES.includes(a.objection as ObjectionType)) throw new HttpError(400, 'Unknown objection type.');
      const type = a.objection as ObjectionType;
      s.objRaised++;
      s.lastRuling = null;
      addLine(t, 'Defense', 'defense', `Objection, Your Honor! ${type}.`, emit);
      s.step = 'direct_ruled';
      s.pending = [{ kind: 'ruling', by: 'defense', type, question: s.lastQuestion ?? '', w: s.witnessIndex }];
      break;
    }
    case 'press': {
      const st = witness?.testimony.find((x) => x.id === a.statementId);
      if (inCross && !st) throw new HttpError(400, 'Select one of this witness\'s statements first.');
      crossAction();
      addLine(t, 'Defense', 'defense', `You said: "${st!.text}" Tell the court more about that.`, emit);
      s.pending = [{ kind: 'witness_press', w: s.witnessIndex, statementId: st!.id }];
      break;
    }
    case 'present': {
      if (!inCross || s.actionsLeft <= 0) throw outOfOrder();
      const st = witness.testimony.find((x) => x.id === a.statementId);
      const ev = t.c.evidence.find((e) => e.id === a.evidenceId);
      if (!st) throw new HttpError(400, 'Select one of this witness\'s statements first.');
      if (!ev) throw new HttpError(400, 'Select an evidence item first.');
      const key = pairKey(st.id, ev.id);
      if (s.found.includes(key)) {
        // Already established: no effect and no action spent.
        s.notice = 'That contradiction has already been established.';
        break;
      }
      crossAction();
      addLine(t, 'Defense', 'defense', `I present the ${ev.name}. It contradicts your statement: "${st.text}"`, emit);
      if (t.c.contradictions.some((x) => x.statement === st.id && x.evidence === ev.id)) {
        s.found.push(key);
        s.notice = 'Contradiction found!';
        s.pending = [{ kind: 'witness_reaction', w: s.witnessIndex, statementId: st.id, evidenceId: ev.id }];
      } else {
        s.wrong++;
        s.notice = 'Wrong presentation: −3 points.';
        s.pending = [{ kind: 'judge_warning', statementId: st.id, evidenceId: ev.id }];
      }
      break;
    }
    case 'ask': {
      if (!inCross || s.actionsLeft <= 0) throw outOfOrder();
      const q = text(a.text, 300, 'The question');
      crossAction();
      s.failNext = q.includes('#fail');
      addLine(t, 'Defense', 'defense', q, emit);
      s.pending = [{ kind: 'prosecutor_objection', w: s.witnessIndex, question: q }];
      break;
    }
    case 'next-witness': {
      if (!inCross) throw outOfOrder();
      advanceWitness(t);
      break;
    }
    case 'timeout': {
      if (!inCross || s.actionsLeft <= 0 || s.deadline === null || Date.now() < s.deadline - 2000) throw outOfOrder();
      s.actionsLeft--;
      s.deadline = null;
      s.ack = false;
      s.lastRuling = null;
      s.notice = 'Time ran out: the turn was lost.';
      break;
    }
    case 'closing': {
      if (s.step !== 'closing_input') throw outOfOrder();
      const body = text(a.text, 2000, 'The closing argument');
      s.failNext = body.includes('#fail');
      addLine(t, 'Defense', 'defense', body, emit);
      s.step = 'closing_done';
      s.pending = [{ kind: 'prosecutor_closing' }, { kind: 'judge_grade', text: body }];
      break;
    }
    default:
      throw new HttpError(400, 'Unknown action.');
  }
  finalize(t);
  save(t);
}

// ---------- AI task runner ----------

function agentCtx(t: Trial): ai.AgentCtx {
  return { c: t.c, transcript: t.lines, found: t.state.found, examStartSeq: t.state.examStartSeq };
}

/** Runs one AI task; returns a commit function that applies its result and yields follow-up tasks. */
async function execTask(t: Trial, task: Task, emit: Emit): Promise<() => Task[]> {
  const ctx = agentCtx(t);
  const s = t.state;
  const names = t.c.witnesses.map((w) => w.name);
  const streamAs = (speaker: string, role: Role) => {
    emit({ t: 'start', speaker, role });
    return (text: string) => emit({ t: 'token', text });
  };
  const say = (speaker: string, role: Role, raw: string) => () => {
    addLine(t, speaker, role, ai.cleanLine(raw, names) || raw.trim(), emit);
    return [] as Task[];
  };

  switch (task.kind) {
    case 'prosecutor_opening':
      return say('Prosecutor', 'prosecutor', await ai.prosecutorOpening(ctx, streamAs('Prosecutor', 'prosecutor')));
    case 'prosecutor_closing':
      return say('Prosecutor', 'prosecutor', await ai.prosecutorClosing(ctx, streamAs('Prosecutor', 'prosecutor')));
    case 'direct_question': {
      const w = t.c.witnesses[task.w];
      const raw = await ai.directQuestion(ctx, w, task.k, streamAs('Prosecutor', 'prosecutor'));
      return () => {
        const line = addLine(t, 'Prosecutor', 'prosecutor', ai.cleanLine(raw, names) || raw.trim(), emit);
        s.lastQuestion = line.text;
        return [];
      };
    }
    case 'witness_answer': {
      const w = t.c.witnesses[task.w];
      return say(w.name, 'witness', await ai.witnessAnswer(ctx, w, task.question, streamAs(w.name, 'witness')));
    }
    case 'witness_press': {
      const w = t.c.witnesses[task.w];
      const st = w.testimony.find((x) => x.id === task.statementId)!;
      return say(w.name, 'witness', await ai.witnessPress(ctx, w, st.text, streamAs(w.name, 'witness')));
    }
    case 'witness_reaction': {
      const w = t.c.witnesses[task.w];
      const st = w.testimony.find((x) => x.id === task.statementId)!;
      const ev = t.c.evidence.find((e) => e.id === task.evidenceId)!;
      const raw = await ai.witnessReaction(ctx, w, st.text, `${ev.name}: ${ev.description}`, streamAs(w.name, 'witness'));
      return say(w.name, 'witness', raw);
    }
    case 'judge_warning': {
      const st = statementOf(t, task.statementId)!.statement;
      const ev = t.c.evidence.find((e) => e.id === task.evidenceId)!;
      return say('Judge', 'judge', await ai.judgeWarning(ctx, st.text, ev.name, streamAs('Judge', 'judge')));
    }
    case 'ruling': {
      const r = await ai.judgeRuling(ctx, task.by, task.type, task.question, streamAs('Judge', 'judge'));
      return () => {
        addLine(t, 'Judge', 'judge', ai.cleanLine(r.text, names) || r.text.trim(), emit);
        s.lastRuling = { by: task.by, type: task.type, sustained: r.sustained };
        if (task.by === 'defense' && r.sustained) s.objSustained++;
        // Overruled: the witness answers the question.
        return r.sustained ? [] : [{ kind: 'witness_answer', w: task.w, question: task.question }];
      };
    }
    case 'prosecutor_objection': {
      emit({ t: 'wait', label: 'The prosecutor considers the question…' });
      const r = await ai.prosecutorObjects(ctx, task.question);
      return () => {
        if (!r.object) return [{ kind: 'witness_answer', w: task.w, question: task.question }];
        addLine(t, 'Prosecutor', 'prosecutor', `Objection, Your Honor! ${r.type}.`, emit);
        return [{ kind: 'ruling', by: 'prosecution', type: r.type, question: task.question, w: task.w }];
      };
    }
    case 'judge_grade': {
      emit({ t: 'wait', label: 'The judge is grading the closing argument…' });
      const found = t.c.contradictions
        .filter((x) => s.found.includes(pairKey(x.statement, x.evidence)))
        .map((x) => {
          const st = statementOf(t, x.statement);
          const ev = t.c.evidence.find((e) => e.id === x.evidence);
          return `${st?.witness.name}'s statement "${st?.statement.text}" is contradicted by the ${ev?.name}.`;
        });
      const g = await ai.judgeGrade(ctx, task.text, found);
      return () => {
        s.closing = g;
        const parts = config.mock
          ? ''
          : ` (use of contradictions ${g.usesContradictions}/10, addresses the charge ${g.addressesCharge}/10, coherence ${g.coherence}/10, persuasiveness ${g.persuasiveness}/10)`;
        addLine(t, 'Judge', 'judge', `The court grades the defense's closing argument ${g.total} out of 40${parts}.`, emit);
        return [];
      };
    }
    case 'judge_verdict': {
      const sc = score(t);
      const facts = [
        `Key contradictions exposed: ${keyFound(t)} (needed: ${t.c.verdictRule.minKeyContradictions}).`,
        `Defense score: ${sc.total} (needed: ${t.c.verdictRule.minScore}).`,
        ...t.c.contradictions
          .filter((x) => s.found.includes(pairKey(x.statement, x.evidence)))
          .map((x) => `Exposed: "${statementOf(t, x.statement)?.statement.text}" contradicted by ${t.c.evidence.find((e) => e.id === x.evidence)?.name}.`),
      ].join('\n');
      return say('Judge', 'judge', await ai.judgeVerdict(ctx, s.verdict!, facts, streamAs('Judge', 'judge')));
    }
  }
}

/** Runs queued AI tasks in order. On failure the task stays queued so "retry" can resume it. */
export async function runPending(t: Trial, emit: Emit) {
  const s = t.state;
  while (s.pending.length) {
    const task = s.pending[0];
    try {
      if (config.mock && s.failNext) {
        s.failNext = false;
        save(t);
        throw new AiError('Simulated AI failure (#fail).');
      }
      const commit = await execTask(t, task, emit);
      db.transaction(() => {
        const follow = commit();
        s.pending = [...follow, ...s.pending.slice(1)];
        s.aiError = null;
        finalize(t);
        save(t);
      })();
    } catch (e) {
      const message = e instanceof AiError ? e.message : `Unexpected error: ${(e as Error).message}`;
      if (!(e instanceof AiError)) console.error(e);
      s.aiError = message;
      finalize(t);
      save(t);
      emit({ t: 'error', message });
      return;
    }
  }
}

// ---------- export ----------

export function transcriptMarkdown(t: Trial): string {
  const out = [`# ${t.c.title}`, '', `- Charge: ${t.c.charge}`, `- Defendant: ${t.c.defendant}`, `- Date: ${new Date(t.createdAt).toISOString()}`];
  if (t.state.verdict) out.push(`- Verdict: **${t.state.verdict}**`, `- Score: ${score(t).total}`);
  let phase: string | null = null;
  const names: Record<Phase, string> = { OPENING: 'Opening', PROSECUTION_CASE: 'Prosecution case', CLOSING: 'Closing', VERDICT: 'Verdict' };
  for (const l of t.lines) {
    if (l.phase !== phase) {
      phase = l.phase;
      out.push('', `## ${names[l.phase]}`, '');
    }
    out.push(`**${l.speaker}** (${l.role}): ${l.text.replace(/\n+/g, ' ')}`, '');
  }
  return out.join('\n').trimEnd() + '\n';
}
