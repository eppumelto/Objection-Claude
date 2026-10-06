// Agents: Prosecutor, Judge and one Witness agent per witness. Every agent gets its own system
// prompt and its own context. A witness prompt only ever contains that witness's own data.

import { config } from '../config.ts';
import { AiError, jsonChat, streamChat, type ChatMessage } from './ollama.ts';
import { OBJECTION_TYPES, type CaseFile, type ObjectionType, type TranscriptLine, type Witness } from '../../shared/types.ts';

export type OnToken = (t: string) => void;

export interface AgentCtx {
  c: CaseFile;
  transcript: TranscriptLine[];
  /** Found contradiction pairs, as "statementId|evidenceId". */
  found: string[];
  /** First transcript seq of the current witness's examination. */
  examStartSeq: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mockStream(text: string, onToken: OnToken): Promise<string> {
  const parts = text.split(/(?<= )/);
  for (const p of parts) {
    if (config.mockTokenMs) await sleep(config.mockTokenMs);
    onToken(p);
  }
  return text;
}

function formatTranscript(lines: TranscriptLine[]): string {
  if (!lines.length) return '(nothing has been said yet)';
  return lines.map((l) => `${l.speaker}: ${l.text}`).join('\n');
}

/** Removes speaker prefixes, wrapping quotes and markdown emphasis that models sometimes add. */
export function cleanLine(text: string, names: string[] = []): string {
  let t = text.trim();
  for (const n of ['Prosecutor', 'Judge', 'Witness', 'Defense', ...names]) {
    const re = new RegExp(`^\\**${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\**\\s*(\\([^)]*\\))?\\s*:\\s*`, 'i');
    t = t.replace(re, '');
  }
  t = t.replace(/\*\*/g, '').replace(/^"([\s\S]*)"$/, '$1').trim();
  return t;
}

const STYLE =
  'Reply with spoken dialogue only: no stage directions, no speaker name prefix, no markdown, no lists. Keep it short and natural for a courtroom.';

// ---------- Prosecutor ----------

function prosecutorSystem(c: CaseFile): string {
  const testimony = c.witnesses
    .map((w) => `- ${w.name} (${w.role}):\n${w.testimony.map((s) => `    • "${s.text}"`).join('\n')}`)
    .join('\n');
  const evidence = c.evidence.map((e) => `- ${e.name}: ${e.description}`).join('\n');
  return [
    `You are the Prosecutor in a criminal trial. You are sharp, confident and want a conviction.`,
    `Defendant: ${c.defendant || 'the defendant'}. Charge: ${c.charge}.`,
    `Case summary: ${c.summary}`,
    `Evidence in the case file:\n${evidence}`,
    `Public witness testimony:\n${testimony}`,
    `You only know the public record above and what is said in court. Never invent secret facts about witnesses.`,
    STYLE,
  ].join('\n\n');
}

async function prosecutorSay(ctx: AgentCtx, task: string, onToken: OnToken, maxWords: number): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: prosecutorSystem(ctx.c) },
    { role: 'user', content: `Court transcript so far:\n${formatTranscript(ctx.transcript)}\n\nYour task: ${task} Use at most ${maxWords} words.` },
  ];
  return streamChat(messages, onToken);
}

export function prosecutorOpening(ctx: AgentCtx, onToken: OnToken) {
  if (config.mock) return mockStream('Mock prosecutor opening.', onToken);
  return prosecutorSay(ctx, 'Give your opening statement to the court.', onToken, 120);
}

export function prosecutorClosing(ctx: AgentCtx, onToken: OnToken) {
  if (config.mock) return mockStream('Mock prosecutor closing.', onToken);
  return prosecutorSay(ctx, "Give your closing argument. Respond to the defense's closing argument where useful.", onToken, 150);
}

export function directQuestion(ctx: AgentCtx, w: Witness, k: number, onToken: OnToken) {
  if (config.mock) return mockStream(`Mock direct question ${k} to ${w.name}.`, onToken);
  return prosecutorSay(
    ctx,
    `You are conducting the direct examination of ${w.name} (${w.role}). Ask question ${k} of 2: a single question that helps the witness tell the court their testimony. Output only the question.`,
    onToken,
    40,
  );
}

export async function prosecutorObjects(ctx: AgentCtx, question: string): Promise<{ object: boolean; type: ObjectionType }> {
  if (config.mock) return { object: /\bobjectionable\b/i.test(question), type: 'Relevance' };
  const r = await jsonChat<{ object?: unknown; type?: unknown }>(
    [
      { role: 'system', content: prosecutorSystem(ctx.c) },
      {
        role: 'user',
        content:
          `Court transcript so far:\n${formatTranscript(ctx.transcript.slice(-12))}\n\n` +
          `The defense just asked the witness: "${question}"\n` +
          `Decide whether to object. Only object if the question is clearly improper under one of these grounds: ` +
          `Leading, Hearsay, Speculation, Relevance, Argumentative. Most fair questions should NOT be objected to. ` +
          `Answer as JSON {"object": boolean, "type": one of the grounds}.`,
      },
    ],
    {
      type: 'object',
      properties: { object: { type: 'boolean' }, type: { type: 'string', enum: [...OBJECTION_TYPES] } },
      required: ['object', 'type'],
    },
  );
  if (typeof r.object !== 'boolean') throw new AiError('The AI returned invalid structured output.');
  const type = OBJECTION_TYPES.includes(r.type as ObjectionType) ? (r.type as ObjectionType) : 'Relevance';
  return { object: r.object, type };
}

// ---------- Witness ----------

function witnessSystem(ctx: AgentCtx, w: Witness): string {
  // Only facts unlocked by a found contradiction on one of this witness's statements are included,
  // so a locked hidden fact can never be volunteered.
  const unlockedStatements = new Set(ctx.found.map((p) => p.split('|')[0]));
  const unlocked = w.hiddenFacts.filter((h) => unlockedStatements.has(h.unlockedBy));
  return [
    `You are ${w.name}, ${w.role}, testifying as a witness in a criminal trial.`,
    `Personality: ${w.personality}`,
    `Your testimony (what you have told the investigators and stand by):\n${w.testimony.map((s) => `- "${s.text}"`).join('\n')}`,
    unlocked.length
      ? `The defense has confronted you with evidence, and you now admit these facts when relevant:\n${unlocked.map((h) => `- ${h.text}`).join('\n')}`
      : `Stick to your testimony. If asked about things you don't know, say so; do not invent new events.`,
    `Stay in character and speak in the first person. ${STYLE} Use at most 70 words.`,
  ].join('\n\n');
}

function witnessSay(ctx: AgentCtx, w: Witness, task: string, onToken: OnToken) {
  const own = ctx.transcript.filter((l) => l.seq >= ctx.examStartSeq);
  return streamChat(
    [
      { role: 'system', content: witnessSystem(ctx, w) },
      { role: 'user', content: `Transcript of your examination so far:\n${formatTranscript(own)}\n\n${task}` },
    ],
    onToken,
  );
}

export function witnessAnswer(ctx: AgentCtx, w: Witness, question: string, onToken: OnToken) {
  if (config.mock) return mockStream(`Mock answer from ${w.name}.`, onToken);
  return witnessSay(ctx, w, `Answer this question from the lawyer: "${question}"`, onToken);
}

export function witnessPress(ctx: AgentCtx, w: Witness, statement: string, onToken: OnToken) {
  if (config.mock) return mockStream(`Mock answer from ${w.name}.`, onToken);
  return witnessSay(ctx, w, `The defense presses you on your statement: "${statement}". Elaborate on it in character with a little more detail about how you know it, staying consistent with your testimony.`, onToken);
}

export function witnessReaction(ctx: AgentCtx, w: Witness, statement: string, evidence: string, onToken: OnToken) {
  if (config.mock) return mockStream(`Mock answer from ${w.name}.`, onToken);
  return witnessSay(
    ctx,
    w,
    `The defense presents evidence that contradicts your statement "${statement}":\n${evidence}\n` +
      `React in character: you are caught out. Reluctantly admit the relevant fact you now admit.`,
    onToken,
  );
}

// ---------- Judge ----------

const JUDGE_SYSTEM = [
  'You are the Judge presiding over a criminal trial. You are impartial, concise and formal.',
  'Courtroom rules: the defense cross-examines witnesses and may present evidence against a statement. ' +
    'Objections: Leading (question suggests its own answer — improper on direct examination), Hearsay (asks for an out-of-court statement by someone else), ' +
    'Speculation (asks the witness to guess beyond their knowledge), Relevance (unrelated to the charge), Argumentative (badgers or argues with the witness instead of asking).',
  'You never take sides on guilt before the verdict.',
  STYLE,
].join('\n\n');

function judgeSay(ctx: AgentCtx, task: string, onToken: OnToken) {
  return streamChat(
    [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: `Court transcript so far:\n${formatTranscript(ctx.transcript)}\n\nYour task: ${task}` },
    ],
    onToken,
    0.4,
  );
}

export async function judgeRuling(
  ctx: AgentCtx,
  by: 'defense' | 'prosecution',
  type: ObjectionType,
  question: string,
  onToken: OnToken,
): Promise<{ sustained: boolean; text: string }> {
  if (config.mock) {
    const sustained = by === 'prosecution' ? true : type === 'Leading';
    const text = await mockStream(sustained ? 'Sustained. Mock ruling.' : 'Overruled. Mock ruling.', onToken);
    return { sustained, text };
  }
  const who = by === 'defense' ? 'The defense objects to the prosecutor' : 'The prosecutor objects to the defense';
  const text = await judgeSay(
    ctx,
    `${who}'s question "${question}" on the ground of ${type}. Rule on the objection. ` +
      `Start your reply with exactly "Sustained." or "Overruled." followed by a one-sentence reason.`,
    onToken,
  );
  const m = /\b(sustained|overruled)\b/i.exec(text);
  if (!m) throw new AiError('The judge gave an invalid ruling.');
  return { sustained: m[1].toLowerCase() === 'sustained', text };
}

export function judgeWarning(ctx: AgentCtx, statement: string, evidence: string, onToken: OnToken) {
  if (config.mock) return mockStream('Mock judge warning.', onToken);
  return judgeSay(
    ctx,
    `The defense presented "${evidence}" against the witness statement "${statement}", but it does not contradict it. ` +
      `This is not an objection, so do not say "sustained" or "overruled". Warn the defense in one or two sentences not to waste the court's time with irrelevant evidence.`,
    onToken,
  );
}

export interface Grade { usesContradictions: number; addressesCharge: number; coherence: number; persuasiveness: number; total: number }

export async function judgeGrade(ctx: AgentCtx, closing: string, foundSummaries: string[]): Promise<Grade> {
  if (config.mock) {
    const words = closing.split(/\s+/).filter(Boolean).length;
    const total = Math.min(40, Math.floor(words / 5));
    return { usesContradictions: 0, addressesCharge: 0, coherence: 0, persuasiveness: 0, total };
  }
  const n = { type: 'integer', minimum: 0, maximum: 10 };
  const r = await jsonChat<Record<string, unknown>>(
    [
      { role: 'system', content: JUDGE_SYSTEM },
      {
        role: 'user',
        content:
          `Charge: ${ctx.c.charge}\n` +
          `Contradictions the defense exposed during the trial:\n${foundSummaries.length ? foundSummaries.map((s) => `- ${s}`).join('\n') : '- none'}\n\n` +
          `The defense's closing argument:\n"""${closing}"""\n\n` +
          `Grade the closing argument on four criteria, 0-10 each: uses_contradictions (does it use the contradictions found above), ` +
          `addresses_charge (does it address the charge), coherence, persuasiveness. Be strict and fair. Answer as JSON.`,
      },
    ],
    {
      type: 'object',
      properties: { uses_contradictions: n, addresses_charge: n, coherence: n, persuasiveness: n },
      required: ['uses_contradictions', 'addresses_charge', 'coherence', 'persuasiveness'],
    },
  );
  const get = (k: string) => {
    const v = Number(r[k]);
    if (!Number.isFinite(v)) throw new AiError('The AI returned an invalid grade.');
    return Math.max(0, Math.min(10, Math.round(v)));
  };
  const g = {
    usesContradictions: get('uses_contradictions'),
    addressesCharge: get('addresses_charge'),
    coherence: get('coherence'),
    persuasiveness: get('persuasiveness'),
  };
  return { ...g, total: g.usesContradictions + g.addressesCharge + g.coherence + g.persuasiveness };
}

export function judgeVerdict(ctx: AgentCtx, verdict: string, facts: string, onToken: OnToken) {
  if (config.mock) return mockStream('Mock verdict explanation.', onToken);
  return judgeSay(
    ctx,
    `The court has reached its verdict: ${verdict}. This verdict is final and was decided by the court's rules:\n${facts}\n` +
      `Announce the verdict to the defendant and explain it briefly (at most 80 words), referring to what happened in the trial.`,
    onToken,
  );
}
