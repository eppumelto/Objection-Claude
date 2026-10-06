import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError, sendAction, type StreamEvent } from '../api.ts';
import { OBJECTION_TYPES, type Role, type TranscriptLine, type TrialView } from '../../shared/types.ts';

interface Streaming { speaker: string; role: Role; text: string }

export function TranscriptLineView({ line, streaming }: { line: { speaker: string; role: Role; text: string }; streaming?: boolean }) {
  return (
    <li className={`tline role-${line.role}${streaming ? ' streaming' : ''}`} data-testid="transcript-line" data-role={line.role}
      data-streaming={streaming ? 'true' : undefined}>
      <span className="speaker">{line.speaker}</span>
      <span className="text">{line.text}{streaming && <span className="caret" aria-hidden="true" />}</span>
    </li>
  );
}

export function TrialPage() {
  const { trialId } = useParams();
  const [trial, setTrial] = useState<TrialView | null>(null);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [waitLabel, setWaitLabel] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reqError, setReqError] = useState<string | null>(null);
  const [selStatement, setSelStatement] = useState<string | null>(null);
  const [selEvidence, setSelEvidence] = useState<string | null>(null);
  const [objecting, setObjecting] = useState(false);
  const [objType, setObjType] = useState<string>(OBJECTION_TYPES[0]);
  const [opening, setOpening] = useState('');
  const [closing, setClosing] = useState('');
  const [ask, setAsk] = useState('');
  const [clockOffset, setClockOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  const inFlightRef = useRef(false);
  const transcriptRef = useRef<HTMLOListElement>(null);
  const timeoutSentFor = useRef<number | null>(null);

  const applyTrial = useCallback((t: TrialView) => {
    setTrial(t);
    setClockOffset(t.serverNow - Date.now());
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api<{ trial: TrialView; transcript: TranscriptLine[] }>('GET', `/api/trials/${trialId}`);
      applyTrial(r.trial);
      setLines(r.transcript);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Could not load the trial.');
    }
  }, [trialId, applyTrial]);

  useEffect(() => { load(); }, [load]);

  const act = useCallback(async (action: Record<string, unknown>): Promise<boolean> => {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    setInFlight(true);
    setReqError(null);
    let ok = true;
    const onEvent = (e: StreamEvent) => {
      switch (e.t) {
        case 'start': setWaitLabel(null); setStreaming({ speaker: e.speaker, role: e.role, text: '' }); break;
        case 'token': setStreaming((s) => (s ? { ...s, text: s.text + e.text } : s)); break;
        case 'wait': setWaitLabel(e.label); break;
        case 'line':
          setStreaming(null);
          setWaitLabel(null);
          setLines((ls) => (ls.some((l) => l.seq === e.line.seq) ? ls : [...ls, e.line]));
          break;
        case 'error': setStreaming(null); setWaitLabel(null); break;
        case 'state': applyTrial(e.trial); break;
      }
    };
    try {
      await sendAction(trialId!, action, onEvent);
    } catch (e) {
      ok = false;
      if (e instanceof ApiError && e.data?.busy) setTimeout(load, 800);
      else setReqError(e instanceof Error ? e.message : 'Request failed.');
      if (!(e instanceof ApiError) || e.status === 0) await load();
    } finally {
      setStreaming(null);
      setWaitLabel(null);
      inFlightRef.current = false;
      setInFlight(false);
    }
    return ok;
  }, [trialId, applyTrial, load]);

  // Resume queued AI work after a reload (or wait while the server is still generating it).
  useEffect(() => {
    if (!trial || inFlight || trial.pending === 0 || trial.aiError) return;
    if (trial.busy) {
      const id = setTimeout(load, 800);
      return () => clearTimeout(id);
    }
    act({ type: 'retry' });
  }, [trial, inFlight, act, load]);

  // Turn timer.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const locked = inFlight || !trial || trial.pending > 0 || trial.busy;
  const remaining = trial?.deadline != null ? Math.max(0, Math.ceil((trial.deadline - (now + clockOffset)) / 1000)) : trial?.turnSeconds ?? 0;

  useEffect(() => {
    if (!trial || trial.deadline == null || locked) return;
    if (remaining <= 0 && timeoutSentFor.current !== trial.deadline) {
      timeoutSentFor.current = trial.deadline;
      act({ type: 'timeout' });
    }
  }, [remaining, trial, locked, act]);

  useLayoutEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, streaming]);

  // Reset selections when the witness changes.
  const witnessKey = trial ? `${trial.phase}-${trial.witnessIndex}` : '';
  useEffect(() => { setSelStatement(null); setSelEvidence(null); setObjecting(false); }, [witnessKey]);
  useEffect(() => { if (trial?.step !== 'direct_q') setObjecting(false); }, [trial?.step]);

  if (loadError) return <section><p className="error" role="alert">{loadError}</p><Link to="/cases">Back to cases</Link></section>;
  if (!trial) return <p className="loading">Loading trial…</p>;

  const witness = trial.phase === 'PROSECUTION_CASE' ? trial.witnesses[trial.witnessIndex] : null;
  const s = trial.step;
  const inCross = s === 'cross';
  const showContinue =
    ['opening_done', 'direct_q', 'direct_ruled', 'direct_answered', 'closing_done'].includes(s) ||
    (inCross && (trial.actionsLeft === 0 || trial.ack));
  const noActions = locked || trial.actionsLeft <= 0;
  const showRuling = trial.lastRuling && !locked && (s === 'direct_ruled' || inCross);
  const lastIsWitnessLine = trial.phase === 'PROSECUTION_CASE' && trial.witnessIndex === trial.witnesses.length - 1;

  const submitText = (type: 'opening' | 'closing', text: string, clear: () => void) => async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return setReqError('Please write something first.');
    if (await act({ type, text })) clear();
  };
  const submitAsk = async (e: FormEvent) => {
    e.preventDefault();
    if (!ask.trim()) return setReqError('Type a question first.');
    if (await act({ type: 'ask', text: ask })) setAsk('');
  };
  const submitObjection = async (e: FormEvent) => {
    e.preventDefault();
    if (await act({ type: 'object', objection: objType })) setObjecting(false);
  };

  return (
    <section className="courtroom">
      <div className="court-head">
        <div>
          <p className="case-name">{trial.caseTitle} · <span className="muted">{trial.charge}</span></p>
          <h1 className="phase-banner" data-testid="phase-banner">{trial.banner}</h1>
        </div>
        <dl className="meters">
          <div><dt>Score</dt><dd data-testid="live-score">{trial.score.total}</dd></div>
          <div><dt>Actions</dt><dd data-testid="actions-left">{trial.actionsLeft}</dd></div>
          <div className={inCross && trial.deadline != null && remaining <= 10 ? 'urgent' : ''}>
            <dt>Timer</dt><dd data-testid="turn-timer" aria-live="off">{remaining}</dd>
          </div>
        </dl>
      </div>

      <div className="court-grid">
        <div className="transcript-panel">
          <h2 className="panel-title">Transcript</h2>
          <ol className="transcript" data-testid="transcript" ref={transcriptRef} aria-live="polite" aria-relevant="additions">
            {lines.map((l) => <TranscriptLineView key={l.seq} line={l} />)}
            {streaming && <TranscriptLineView line={streaming} streaming />}
            {waitLabel && !streaming && <li className="wait">{waitLabel}</li>}
            {locked && !streaming && !waitLabel && !trial.aiError && <li className="wait">…</li>}
          </ol>
          {streaming && <p className="speaking">Now speaking: <strong>{streaming.speaker}</strong></p>}

          {trial.aiError && !inFlight && (
            <div className="ai-error" role="alert">
              <p data-testid="ai-error">The AI failed to respond: {trial.aiError}</p>
              <button type="button" className="btn primary" data-testid="ai-retry" onClick={() => act({ type: 'retry' })}>Retry</button>
            </div>
          )}
          {reqError && <p className="error" role="alert">{reqError}</p>}
          {trial.notice && !locked && <p className={`notice ${trial.notice.startsWith('Contradiction') ? 'good' : ''}`} role="status">{trial.notice}</p>}
          {showRuling && trial.lastRuling && (
            <p className={`ruling ${trial.lastRuling.sustained ? 'good' : 'bad'}`} data-testid="ruling" role="status">
              {trial.lastRuling.sustained ? 'Sustained' : 'Overruled'} · {trial.lastRuling.type} objection by the {trial.lastRuling.by}
            </p>
          )}

          <div className="action-bar">
            {s === 'opening_input' && (
              <form onSubmit={submitText('opening', opening, () => setOpening(''))} className="textform">
                <label htmlFor="opening">Your opening statement <span className="hint">({opening.length}/1000)</span></label>
                <textarea id="opening" rows={5} maxLength={1000} value={opening} onChange={(e) => setOpening(e.target.value)} data-testid="opening-input" />
                <button type="submit" className="btn primary" disabled={locked} data-testid="opening-submit">Deliver opening statement</button>
              </form>
            )}

            {s === 'closing_input' && (
              <form onSubmit={submitText('closing', closing, () => setClosing(''))} className="textform">
                <label htmlFor="closing">Your closing argument <span className="hint">({closing.length}/2000)</span></label>
                <textarea id="closing" rows={7} maxLength={2000} value={closing} onChange={(e) => setClosing(e.target.value)} data-testid="closing-input" />
                <button type="submit" className="btn primary" disabled={locked} data-testid="closing-submit">Deliver closing argument</button>
              </form>
            )}

            {s === 'direct_q' && (
              <div className="objection-box">
                {!objecting ? (
                  <button type="button" className="btn objection" disabled={locked} data-testid="object-button" onClick={() => setObjecting(true)}>
                    Objection!
                  </button>
                ) : (
                  <form onSubmit={submitObjection} className="inline-form">
                    <label htmlFor="obj-type">Objection type</label>
                    <select id="obj-type" value={objType} onChange={(e) => setObjType(e.target.value)} data-testid="object-type" autoFocus>
                      {OBJECTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <button type="submit" className="btn objection" disabled={locked} data-testid="object-submit">Object</button>
                    <button type="button" className="btn ghost" onClick={() => setObjecting(false)}>Cancel</button>
                  </form>
                )}
              </div>
            )}

            {inCross && (
              <div className="cross-actions">
                <div className="row-actions">
                  <button type="button" className="btn" disabled={noActions || !selStatement} data-testid="press-button"
                    onClick={() => act({ type: 'press', statementId: selStatement })}>Press statement</button>
                  <button type="button" className="btn present" disabled={noActions || !selStatement || !selEvidence} data-testid="present-button"
                    onClick={() => act({ type: 'present', statementId: selStatement, evidenceId: selEvidence })}>Present evidence</button>
                  <button type="button" className="btn ghost" disabled={locked} data-testid="next-witness" onClick={() => act({ type: 'next-witness' })}>
                    {lastIsWitnessLine ? 'Finish cross-examination' : 'Next witness'}
                  </button>
                </div>
                <form onSubmit={submitAsk} className="inline-form ask-form">
                  <label htmlFor="ask">Ask the witness <span className="hint">({ask.length}/300)</span></label>
                  <input id="ask" maxLength={300} value={ask} onChange={(e) => setAsk(e.target.value)} data-testid="ask-input" disabled={trial.actionsLeft <= 0} />
                  <button type="submit" className="btn" disabled={noActions} data-testid="ask-submit">Ask</button>
                </form>
                {!selStatement && trial.actionsLeft > 0 && <p className="hint">Select a statement to press it, or a statement and an evidence item to present.</p>}
              </div>
            )}

            {showContinue && (
              <button type="button" className="btn primary continue" disabled={locked} data-testid="continue" onClick={() => act({ type: 'continue' })}>
                Continue
              </button>
            )}

            {s === 'verdict' && <VerdictPanel trial={trial} />}
          </div>
        </div>

        <aside className="side">
          {witness && (
            <div className="witness-panel">
              <h2 className="panel-title">Witness</h2>
              <p className="witness-name">{witness.name}</p>
              <p className="muted">{witness.role}</p>
              <h3>Testimony</h3>
              {inCross ? (
                <ul className="statements">
                  {witness.testimony.map((st) => {
                    const done = trial.contradicted.includes(st.id);
                    return (
                      <li key={st.id}>
                        <button type="button" className={`statement${selStatement === st.id ? ' selected' : ''}${done ? ' done' : ''}`}
                          data-testid="statement" data-statement-id={st.id} data-contradicted={done ? 'true' : 'false'}
                          aria-pressed={selStatement === st.id} onClick={() => setSelStatement(selStatement === st.id ? null : st.id)}>
                          <span className="tick" aria-hidden="true">{done ? '✔' : ''}</span>
                          <span>{st.text}</span>
                          {done && <span className="sr-only"> (contradicted)</span>}
                        </button>
                      </li>
                    );
                  })}
                  {witness.testimony.length === 0 && <li className="muted">No recorded testimony.</li>}
                </ul>
              ) : (
                <ul className="statements plain">
                  {witness.testimony.map((st) => <li key={st.id}>{st.text}</li>)}
                </ul>
              )}
            </div>
          )}
          <div className="evidence-drawer">
            <h2 className="panel-title">Evidence</h2>
            <ul className="evidence">
              {trial.evidence.map((ev) => (
                <li key={ev.id}>
                  <button type="button" className={`evidence-item${selEvidence === ev.id ? ' selected' : ''}`} data-testid="evidence-item"
                    data-evidence-id={ev.id} aria-pressed={selEvidence === ev.id}
                    onClick={() => setSelEvidence(selEvidence === ev.id ? null : ev.id)}>
                    <strong>{ev.name}</strong>
                    <span>{ev.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </section>
  );
}

function VerdictPanel({ trial }: { trial: TrialView }) {
  const r = trial.result;
  const sc = trial.score;
  return (
    <div className={`verdict-panel ${trial.verdict === 'Not guilty' ? 'win' : 'loss'}`}>
      <p className="verdict-label">The court finds the defendant</p>
      <p className="verdict" data-testid="verdict">{trial.verdict}</p>
      <table className="score-table">
        <caption>Score breakdown</caption>
        <tbody>
          <tr><th scope="row">Contradictions</th><td data-testid="score-contradictions">{sc.contradictions}</td></tr>
          <tr><th scope="row">Objections{r ? ` (${r.objectionsSustained}/${r.objectionsRaised} sustained)` : ''}</th><td data-testid="score-objections">{sc.objections}</td></tr>
          <tr><th scope="row">Closing argument</th><td data-testid="score-closing">{sc.closing}</td></tr>
          <tr><th scope="row">Wrong presentations{r ? ` (${r.wrongPresentations})` : ''}</th><td data-testid="score-penalty">{sc.penalty}</td></tr>
          <tr className="total"><th scope="row">Total</th><td data-testid="score-total">{sc.total}</td></tr>
        </tbody>
      </table>
      {r && (
        <>
          <p className="muted">
            “Not guilty” requires at least {r.rule.minKeyContradictions} key contradiction(s) (you found {r.keyFound}) and a score of at least {r.rule.minScore}.
          </p>
          <h3>Contradictions</h3>
          <ul className="contra-list">
            {r.contradictions.map((x) => (
              <li key={`${x.statement}|${x.evidence}`} className={x.found ? 'found' : 'missed'}>
                <span className="mark">{x.found ? '✔ Found' : '✘ Missed'}</span>
                {x.key && <span className="tag">Key</span>} {x.witness}: “{x.statementText}” ↔ {x.evidenceName}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="row-actions">
        <Link to={`/history/${trial.id}`} className="btn">Replay transcript</Link>
        <Link to="/cases" className="btn primary">Back to cases</Link>
      </div>
    </div>
  );
}
