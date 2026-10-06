// Types and validation shared by the server and the client.

export interface Statement { id: string; text: string }
export interface HiddenFact { id: string; text: string; unlockedBy: string }
export interface Witness {
  id: string;
  name: string;
  role: string;
  personality: string;
  testimony: Statement[];
  hiddenFacts: HiddenFact[];
}
export interface Evidence { id: string; name: string; description: string }
export interface Contradiction { statement: string; evidence: string; key: boolean }
export interface CaseFile {
  id: string;
  title: string;
  charge: string;
  summary: string;
  defendant: string;
  witnesses: Witness[];
  evidence: Evidence[];
  contradictions: Contradiction[];
  verdictRule: { minKeyContradictions: number; minScore: number };
}

export const OBJECTION_TYPES = ['Leading', 'Hearsay', 'Speculation', 'Relevance', 'Argumentative'] as const;
export type ObjectionType = (typeof OBJECTION_TYPES)[number];

export type Phase = 'OPENING' | 'PROSECUTION_CASE' | 'CLOSING' | 'VERDICT';
export type Step =
  | 'opening_input'
  | 'opening_done'
  | 'direct_q'
  | 'direct_ruled'
  | 'direct_answered'
  | 'cross'
  | 'closing_input'
  | 'closing_done'
  | 'verdict';

export type Role = 'defense' | 'prosecutor' | 'judge' | 'witness';

export interface TranscriptLine {
  seq: number;
  speaker: string;
  role: Role;
  text: string;
  phase: Phase;
  ts: number;
}

export interface ScoreBreakdown {
  contradictions: number;
  objections: number;
  closing: number;
  penalty: number; // <= 0
  total: number;
}

export interface Ruling { by: 'defense' | 'prosecution'; type: ObjectionType; sustained: boolean }

/** What the client sees of a trial. Never contains hidden facts or contradiction pairs before the verdict. */
export interface TrialView {
  id: string;
  caseId: string;
  caseTitle: string;
  charge: string;
  defendant: string;
  witnesses: { id: string; name: string; role: string; testimony: Statement[] }[];
  evidence: Evidence[];
  phase: Phase;
  step: Step;
  banner: string;
  witnessIndex: number;
  questionNo: number;
  actionsLeft: number;
  ack: boolean;
  contradicted: string[]; // statement ids
  lastRuling: Ruling | null;
  notice: string | null;
  pending: number;
  busy: boolean;
  aiError: string | null;
  deadline: number | null;
  serverNow: number;
  turnSeconds: number;
  score: ScoreBreakdown;
  verdict: 'Guilty' | 'Not guilty' | null;
  result: null | {
    keyFound: number;
    rule: { minKeyContradictions: number; minScore: number };
    contradictions: { statement: string; statementText: string; evidence: string; evidenceName: string; key: boolean; found: boolean; witness: string }[];
    objectionsRaised: number;
    objectionsSustained: number;
    wrongPresentations: number;
  };
}

/** Validates a case file. Returns a list of human-readable errors (empty = valid). */
export function validateCase(c: unknown): string[] {
  const errors: string[] = [];
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['Case must be a JSON object.'];
  const k = c as Partial<CaseFile>;
  const str = (v: unknown) => typeof v === 'string';
  if (!str(k.id) || !k.id!.trim()) errors.push('Case id is required.');
  else if (!/^[A-Za-z0-9_-]+$/.test(k.id!)) errors.push('Case id may only contain letters, digits, "-" and "_".');
  if (!str(k.title) || !k.title!.trim()) errors.push('Title is required.');
  for (const f of ['charge', 'summary', 'defendant'] as const) {
    if (k[f] !== undefined && !str(k[f])) errors.push(`${f} must be text.`);
  }
  if (!Array.isArray(k.witnesses) || k.witnesses.length < 1) errors.push('At least one witness is required.');
  if (!Array.isArray(k.evidence) || k.evidence.length < 1) errors.push('At least one evidence item is required.');
  if (k.contradictions !== undefined && !Array.isArray(k.contradictions)) errors.push('contradictions must be a list.');

  const ids = new Set<string>();
  const dup = (id: string, what: string) => {
    if (ids.has(id)) errors.push(`Duplicate id "${id}" (${what}).`);
    ids.add(id);
  };
  const statementIds = new Set<string>();
  const evidenceIds = new Set<string>();

  (Array.isArray(k.witnesses) ? k.witnesses : []).forEach((w, i) => {
    const label = `Witness ${i + 1}`;
    if (!w || typeof w !== 'object') return errors.push(`${label} is invalid.`);
    if (!str(w.id) || !w.id.trim()) errors.push(`${label}: id is required.`);
    else dup(w.id, label);
    if (!str(w.name) || !w.name.trim()) errors.push(`${label}: name is required.`);
    if (w.role !== undefined && !str(w.role)) errors.push(`${label}: role must be text.`);
    if (w.personality !== undefined && !str(w.personality)) errors.push(`${label}: personality must be text.`);
    if (!Array.isArray(w.testimony)) errors.push(`${label}: testimony must be a list.`);
    const own = new Set<string>();
    (Array.isArray(w.testimony) ? w.testimony : []).forEach((s, j) => {
      if (!s || !str(s.id) || !s.id.trim()) return errors.push(`${label}, statement ${j + 1}: id is required.`);
      if (!str(s.text) || !s.text.trim()) errors.push(`${label}, statement ${j + 1}: text is required.`);
      dup(s.id, `${label} statement`);
      statementIds.add(s.id);
      own.add(s.id);
    });
    if (w.hiddenFacts !== undefined && !Array.isArray(w.hiddenFacts)) errors.push(`${label}: hiddenFacts must be a list.`);
    (Array.isArray(w.hiddenFacts) ? w.hiddenFacts : []).forEach((h, j) => {
      if (!h || !str(h.id) || !h.id.trim()) return errors.push(`${label}, hidden fact ${j + 1}: id is required.`);
      if (!str(h.text) || !h.text.trim()) errors.push(`${label}, hidden fact ${j + 1}: text is required.`);
      dup(h.id, `${label} hidden fact`);
      if (!str(h.unlockedBy) || !own.has(h.unlockedBy))
        errors.push(`${label}, hidden fact ${j + 1}: unlockedBy must reference one of this witness's statements.`);
    });
  });

  (Array.isArray(k.evidence) ? k.evidence : []).forEach((e, i) => {
    const label = `Evidence ${i + 1}`;
    if (!e || !str(e.id) || !e.id.trim()) return errors.push(`${label}: id is required.`);
    if (!str(e.name) || !e.name.trim()) errors.push(`${label}: name is required.`);
    if (e.description !== undefined && !str(e.description)) errors.push(`${label}: description must be text.`);
    dup(e.id, label);
    evidenceIds.add(e.id);
  });

  const pairs = new Set<string>();
  (Array.isArray(k.contradictions) ? k.contradictions : []).forEach((x, i) => {
    const label = `Contradiction ${i + 1}`;
    if (!x || !statementIds.has(x.statement)) errors.push(`${label}: statement "${x?.statement ?? ''}" does not exist.`);
    if (!x || !evidenceIds.has(x.evidence)) errors.push(`${label}: evidence "${x?.evidence ?? ''}" does not exist.`);
    if (x && typeof x.key !== 'boolean') errors.push(`${label}: key must be true or false.`);
    const p = `${x?.statement}|${x?.evidence}`;
    if (pairs.has(p)) errors.push(`${label}: duplicate contradiction pair.`);
    pairs.add(p);
  });

  const vr = k.verdictRule;
  if (!vr || typeof vr !== 'object') errors.push('verdictRule is required.');
  else {
    if (!Number.isInteger(vr.minKeyContradictions) || vr.minKeyContradictions < 0)
      errors.push('verdictRule.minKeyContradictions must be a non-negative integer.');
    if (!Number.isInteger(vr.minScore) || vr.minScore < 0 || vr.minScore > 100)
      errors.push('verdictRule.minScore must be an integer between 0 and 100.');
  }
  return errors;
}

/** Normalises optional fields so the rest of the code can rely on them. Call after validateCase. */
export function normaliseCase(c: CaseFile): CaseFile {
  return {
    id: c.id.trim(),
    title: c.title.trim(),
    charge: c.charge ?? '',
    summary: c.summary ?? '',
    defendant: c.defendant ?? '',
    witnesses: c.witnesses.map((w) => ({
      id: w.id,
      name: w.name,
      role: w.role ?? '',
      personality: w.personality ?? '',
      testimony: w.testimony.map((s) => ({ id: s.id, text: s.text })),
      hiddenFacts: (w.hiddenFacts ?? []).map((h) => ({ id: h.id, text: h.text, unlockedBy: h.unlockedBy })),
    })),
    evidence: c.evidence.map((e) => ({ id: e.id, name: e.name, description: e.description ?? '' })),
    contradictions: (c.contradictions ?? []).map((x) => ({ statement: x.statement, evidence: x.evidence, key: x.key })),
    verdictRule: { minKeyContradictions: c.verdictRule.minKeyContradictions, minScore: c.verdictRule.minScore },
  };
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'case';
}
