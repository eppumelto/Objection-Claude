import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client, startServer, type Server } from './helpers.ts';

let server: Server;
before(async () => { server = await startServer({ TURN_SECONDS: '1' }); });
after(async () => { await server.stop(); });

const lineTexts = (events: any[]) => events.filter((e) => e.t === 'line').map((e) => `${e.line.speaker}: ${e.line.text}`);

async function newTrial(c: Client) {
  const r = await c.req('POST', '/api/trials', { caseId: 'midnight-bakery' });
  assert.equal(r.status, 201);
  return r.data.id as string;
}

/** Plays opening + both direct questions (no objections) and lands in cross-examination. */
async function toCross(c: Client, id: string, first = true) {
  if (first) {
    assert.equal((await c.action(id, { type: 'opening', text: 'My client is innocent.' })).status, 200);
    assert.equal((await c.action(id, { type: 'continue' })).status, 200);
  }
  for (let i = 0; i < 4; i++) assert.equal((await c.action(id, { type: 'continue' })).status, 200);
  const t = (await c.trial(id)).trial;
  assert.equal(t.step, 'cross');
  return t;
}

describe('auth', () => {
  test('register, duplicate email, short password, login, logout', async () => {
    const c = new Client(server.url);
    const email = await c.register();
    assert.equal((await c.req('GET', '/api/auth/me')).data.user.email, email);
    const dup = await new Client(server.url).req('POST', '/api/auth/register', { email, password: 'password123' });
    assert.equal(dup.status, 409);
    const short = await new Client(server.url).req('POST', '/api/auth/register', { email: 'x@y.zz', password: 'short' });
    assert.equal(short.status, 400);
    const bad = await new Client(server.url).req('POST', '/api/auth/login', { email, password: 'wrongpassword' });
    assert.equal(bad.status, 401);
    const d = new Client(server.url);
    assert.equal((await d.req('POST', '/api/auth/login', { email, password: 'password123' })).status, 200);
    await d.req('POST', '/api/auth/logout');
    assert.equal((await d.req('GET', '/api/cases')).status, 401);
  });

  test('passwords are stored hashed', async () => {
    const c = new Client(server.url);
    await c.register(undefined, 'plaintext-secret');
    const raw = [server.dbPath, `${server.dbPath}-wal`].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f).toString('latin1')).join('');
    assert.ok(raw.includes('scrypt$'));
    assert.ok(!raw.includes('plaintext-secret'));
  });
});

describe('cases', () => {
  test('library lists the seed case with no best score', async () => {
    const c = new Client(server.url);
    await c.register();
    const r = await c.req('GET', '/api/cases');
    const seedCase = r.data.cases.find((x: any) => x.id === 'midnight-bakery');
    assert.equal(seedCase.witnessCount, 3);
    assert.equal(seedCase.bestScore, null);
    assert.equal(seedCase.builtin, true);
  });

  test('validation, create, edit, privacy, delete; built-ins are protected', async () => {
    const c = new Client(server.url);
    await c.register();
    const noWitness = await c.req('POST', '/api/cases', { case: { title: 'X', witnesses: [], evidence: [{ id: 'e', name: 'E' }], contradictions: [], verdictRule: { minKeyContradictions: 1, minScore: 50 } } });
    assert.equal(noWitness.status, 400);
    const bad = {
      title: 'My case', charge: 'Theft', summary: '', defendant: 'D',
      witnesses: [{ id: 'w1', name: 'W', role: '', personality: '', testimony: [{ id: 's1', text: 'I saw it.' }], hiddenFacts: [] }],
      evidence: [{ id: 'e1', name: 'Photo', description: '' }],
      contradictions: [{ statement: 's9', evidence: 'e1', key: true }],
      verdictRule: { minKeyContradictions: 1, minScore: 50 },
    };
    const r1 = await c.req('POST', '/api/cases', { case: bad });
    assert.equal(r1.status, 400);
    assert.match(r1.data.error, /s9/);
    const good = { ...bad, contradictions: [{ statement: 's1', evidence: 'e1', key: true }] };
    const r2 = await c.req('POST', '/api/cases', { case: good });
    assert.equal(r2.status, 201);
    assert.equal(r2.data.case.id, 'my-case');
    const r3 = await c.req('PUT', '/api/cases/my-case', { case: { ...r2.data.case, title: 'Renamed' } });
    assert.equal(r3.status, 200);

    const other = new Client(server.url);
    await other.register();
    assert.equal((await other.req('GET', '/api/cases/my-case')).status, 404);
    assert.ok(!(await other.req('GET', '/api/cases')).data.cases.some((x: any) => x.id === 'my-case'));

    assert.equal((await c.req('DELETE', '/api/cases/midnight-bakery')).status, 403);
    assert.equal((await c.req('DELETE', '/api/cases/my-case')).status, 200);
  });

  test('export and re-import', async () => {
    const c = new Client(server.url);
    await c.register();
    const exp = await c.req('GET', '/api/cases/midnight-bakery/export');
    assert.equal(exp.status, 200);
    const imp = await c.req('POST', '/api/cases/import', { case: exp.data });
    assert.equal(imp.status, 201);
    assert.equal(imp.data.case.id, 'midnight-bakery-2');
    const badImp = await c.req('POST', '/api/cases/import', { case: { hello: 1 } });
    assert.equal(badImp.status, 400);
  });
});

describe('trial', () => {
  test('full trial: objections, contradictions, penalties, failure + retry, verdict', async () => {
    const c = new Client(server.url);
    await c.register();
    const id = await newTrial(c);

    // Out-of-order call → 409.
    assert.equal((await c.action(id, { type: 'continue' })).status, 409);

    let r = await c.action(id, { type: 'opening', text: 'The defense will show reasonable doubt.' });
    assert.deepEqual(lineTexts(r.events), ['Defense: The defense will show reasonable doubt.', 'Prosecutor: Mock prosecutor opening.']);
    assert.equal(r.state.banner, 'Opening');

    r = await c.action(id, { type: 'continue' });
    assert.equal(r.state.banner, 'Direct examination — Inspector Ruth Kale');
    assert.deepEqual(lineTexts(r.events), ['Prosecutor: Mock direct question 1 to Inspector Ruth Kale.']);

    // Leading → sustained, witness does not answer.
    r = await c.action(id, { type: 'object', objection: 'Leading' });
    assert.equal(r.state.lastRuling.sustained, true);
    assert.equal(lineTexts(r.events).length, 2);
    r = await c.action(id, { type: 'continue' });
    assert.deepEqual(lineTexts(r.events), ['Prosecutor: Mock direct question 2 to Inspector Ruth Kale.']);
    // Hearsay → overruled, witness answers.
    r = await c.action(id, { type: 'object', objection: 'Hearsay' });
    assert.equal(r.state.lastRuling.sustained, false);
    assert.deepEqual(lineTexts(r.events).slice(-1), ['Inspector Ruth Kale: Mock answer from Inspector Ruth Kale.']);
    r = await c.action(id, { type: 'continue' });
    assert.equal(r.state.banner, 'Cross-examination — Inspector Ruth Kale');
    assert.equal(r.state.actionsLeft, 6);
    assert.equal(r.state.score.objections, 10);

    // Contradiction found.
    r = await c.action(id, { type: 'present', statementId: 'kale-1', evidenceId: 'e-burn' });
    assert.deepEqual(r.state.contradicted, ['kale-1']);
    assert.equal(r.state.actionsLeft, 5);
    assert.equal(r.state.score.contradictions, 10);
    // Re-presenting has no effect and spends nothing.
    r = await c.action(id, { type: 'present', statementId: 'kale-1', evidenceId: 'e-burn' });
    assert.equal(r.state.actionsLeft, 5);
    assert.equal(r.state.score.contradictions, 10);
    // Wrong presentation → judge warning + penalty.
    r = await c.action(id, { type: 'present', statementId: 'kale-2', evidenceId: 'e-policy' });
    assert.deepEqual(lineTexts(r.events).slice(-1), ['Judge: Mock judge warning.']);
    assert.equal(r.state.score.penalty, -3);
    // Press.
    r = await c.action(id, { type: 'press', statementId: 'kale-3' });
    assert.deepEqual(lineTexts(r.events).slice(-1), ['Inspector Ruth Kale: Mock answer from Inspector Ruth Kale.']);
    // Prosecutor objects to an "objectionable" question; sustained, action spent, no answer.
    r = await c.action(id, { type: 'ask', text: 'Is this question objectionable?' });
    assert.equal(r.state.actionsLeft, 2);
    assert.equal(r.state.lastRuling.by, 'prosecution');
    assert.equal(r.state.lastRuling.sustained, true);
    assert.ok(!lineTexts(r.events).some((l) => l.startsWith('Inspector')));
    // Failure injection: error, state kept, retry succeeds.
    r = await c.action(id, { type: 'ask', text: 'What time was it? #fail' });
    assert.ok(r.events.some((e: any) => e.t === 'error'));
    assert.ok(r.state.aiError);
    assert.equal(r.state.pending, 1);
    assert.equal((await c.action(id, { type: 'press', statementId: 'kale-1' })).status, 409);
    r = await c.action(id, { type: 'retry' });
    assert.equal(r.state.aiError, null);
    assert.deepEqual(lineTexts(r.events), ['Inspector Ruth Kale: Mock answer from Inspector Ruth Kale.']);
    assert.equal(r.state.actionsLeft, 1);
    r = await c.action(id, { type: 'next-witness' });
    assert.equal(r.state.banner, 'Direct examination — Dana Pike');

    // Pike: one key + one non-key contradiction.
    await toCross(c, id, false);
    await c.action(id, { type: 'present', statementId: 'pike-1', evidenceId: 'e-log' });
    r = await c.action(id, { type: 'present', statementId: 'pike-3', evidenceId: 'e-receipt' });
    assert.equal(r.state.score.contradictions, 25);
    await c.action(id, { type: 'next-witness' });

    // Ortiz: key contradiction, then a timeout, then use up all actions.
    await toCross(c, id, false);
    r = await c.action(id, { type: 'present', statementId: 'ortiz-1', evidenceId: 'e-camera' });
    assert.equal(r.state.actionsLeft, 5);
    await c.action(id, { type: 'continue' }); // acknowledge
    let t = (await c.trial(id)).trial;
    assert.ok(t.deadline > 0);
    await new Promise((res) => setTimeout(res, Math.max(0, t.deadline - Date.now())));
    r = await c.action(id, { type: 'timeout' });
    assert.equal(r.status, 200);
    assert.equal(r.state.actionsLeft, 4);
    assert.equal(r.state.score.total, 35 + 10 - 3);
    for (let i = 0; i < 4; i++) await c.action(id, { type: 'press', statementId: 'ortiz-2' });
    assert.equal((await c.action(id, { type: 'press', statementId: 'ortiz-2' })).status, 409);
    r = await c.action(id, { type: 'continue' });
    assert.equal(r.state.banner, 'Closing');

    // Closing: 100 words → 20 points.
    const closing = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
    r = await c.action(id, { type: 'closing', text: closing });
    assert.deepEqual(lineTexts(r.events).slice(1, 2), ['Prosecutor: Mock prosecutor closing.']);
    assert.equal(r.state.score.closing, 20);
    r = await c.action(id, { type: 'continue' });
    assert.equal(r.state.banner, 'Verdict');
    assert.equal(r.state.verdict, 'Not guilty');
    assert.deepEqual(r.state.score, { contradictions: 35, objections: 10, closing: 20, penalty: -3, total: 62 });
    assert.deepEqual(lineTexts(r.events), ['Judge: Mock verdict explanation.']);
    assert.equal(r.state.result.contradictions.filter((x: any) => x.found).length, 4);

    // History, stats, best score, export.
    const hist = (await c.req('GET', '/api/trials')).data.trials;
    assert.equal(hist[0].verdict, 'Not guilty');
    const stats = (await c.req('GET', '/api/stats')).data;
    assert.equal(stats.played, 1);
    assert.equal(stats.winRate, 100);
    assert.equal(stats.avgScore, 62);
    assert.equal(stats.objectionRate, 50);
    const lib = (await c.req('GET', '/api/cases')).data.cases.find((x: any) => x.id === 'midnight-bakery');
    assert.equal(lib.bestScore, 62);
    const md = await c.req('GET', `/api/trials/${id}/transcript.md`);
    assert.match(md.text, /^# The Midnight Bakery Fire/);
    assert.match(md.text, /\*\*Judge\*\* \(judge\): Mock verdict explanation\./);
  });

  test('skipping everything gives a guilty verdict', async () => {
    const c = new Client(server.url);
    await c.register();
    const id = await newTrial(c);
    await toCross(c, id);
    for (let w = 0; w < 3; w++) {
      await c.action(id, { type: 'next-witness' });
      if (w < 2) await toCross(c, id, false);
    }
    await c.action(id, { type: 'closing', text: 'Short.' });
    const r = await c.action(id, { type: 'continue' });
    assert.equal(r.state.verdict, 'Guilty');
    assert.equal(r.state.score.total, 10);
  });

  test("users cannot see each other's trials", async () => {
    const a = new Client(server.url);
    await a.register();
    const id = await newTrial(a);
    const b = new Client(server.url);
    await b.register();
    assert.equal((await b.req('GET', `/api/trials/${id}`)).status, 404);
    assert.equal((await b.action(id, { type: 'opening', text: 'hi' })).status, 404);
    assert.equal((await b.req('GET', `/api/trials/${id}/transcript.md`)).status, 404);
    assert.equal((await new Client(server.url).req('GET', `/api/trials/${id}`)).status, 401);
  });

  test('input limits are enforced', async () => {
    const c = new Client(server.url);
    await c.register();
    const id = await newTrial(c);
    assert.equal((await c.action(id, { type: 'opening', text: 'x'.repeat(1001) })).status, 400);
    await toCross(c, id);
    assert.equal((await c.action(id, { type: 'ask', text: 'x'.repeat(301) })).status, 400);
    assert.equal((await c.action(id, { type: 'press', statementId: 'pike-1' })).status, 400);
  });
});
