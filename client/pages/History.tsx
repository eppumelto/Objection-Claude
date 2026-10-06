import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../api.ts';
import type { TranscriptLine, TrialView } from '../../shared/types.ts';

interface TrialItem {
  id: string; caseTitle: string; status: string; verdict: string | null; score: number | null; createdAt: number; finishedAt: number | null;
}

export function HistoryPage() {
  const navigate = useNavigate();
  const [trials, setTrials] = useState<TrialItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ trials: TrialItem[] }>('GET', '/api/trials')
      .then((r) => setTrials(r.trials.filter((t) => t.status === 'finished')))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load history.'));
  }, []);

  return (
    <section>
      <h1>Trial history</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {!trials ? <p className="loading">Loading…</p> : trials.length === 0 ? (
        <p className="empty">No finished trials yet. <Link to="/cases">Start one from the case library.</Link></p>
      ) : (
        <table className="history-table">
          <thead><tr><th scope="col">Case</th><th scope="col">Date</th><th scope="col">Verdict</th><th scope="col">Score</th></tr></thead>
          <tbody>
            {trials.map((t) => (
              <tr key={t.id} data-testid="history-item" tabIndex={0} role="link" aria-label={`Replay ${t.caseTitle}, ${t.verdict}, score ${t.score}`}
                onClick={() => navigate(`/history/${t.id}`)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/history/${t.id}`); } }}>
                <td>{t.caseTitle}</td>
                <td>{new Date(t.finishedAt ?? t.createdAt).toLocaleString()}</td>
                <td><span className={`pill ${t.verdict === 'Not guilty' ? 'win' : 'loss'}`}>{t.verdict}</span></td>
                <td>{t.score}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function ReplayPage() {
  const { trialId } = useParams();
  const [trial, setTrial] = useState<TrialView | null>(null);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [i, setI] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ trial: TrialView; transcript: TranscriptLine[] }>('GET', `/api/trials/${trialId}`)
      .then((r) => { setTrial(r.trial); setLines(r.transcript); })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the trial.'));
  }, [trialId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
      if (e.key === 'ArrowRight') setI((x) => Math.min(lines.length - 1, x + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lines.length]);

  if (error) return <section><p className="error" role="alert">{error}</p><Link to="/history">Back to history</Link></section>;
  if (!trial) return <p className="loading">Loading…</p>;
  const line = lines[i];

  return (
    <section className="replay">
      <div className="page-head">
        <div>
          <h1>Replay: {trial.caseTitle}</h1>
          <p className="muted">
            {trial.verdict ? <>Verdict: <strong>{trial.verdict}</strong> · Score {trial.score.total}</> : 'Trial in progress'}
          </p>
        </div>
        <div className="row-actions">
          <a className="btn" data-testid="transcript-export" href={`/api/trials/${trial.id}/transcript.md`} download>Export Markdown</a>
          <Link className="btn ghost" to="/history">Back</Link>
        </div>
      </div>

      {lines.length === 0 ? <p className="empty">This transcript is empty.</p> : (
        <>
          <div className={`replay-card role-${line.role}`} aria-live="polite">
            <p className="replay-pos">Line {i + 1} of {lines.length} · {line.phase.replace('_', ' ').toLowerCase()}</p>
            <p data-testid="replay-line"><span className="speaker">{line.speaker}:</span> {line.text}</p>
          </div>
          <div className="row-actions replay-nav">
            <button type="button" className="btn" data-testid="replay-prev" disabled={i === 0} onClick={() => setI(i - 1)}>← Prev</button>
            <input type="range" min={0} max={lines.length - 1} value={i} onChange={(e) => setI(Number(e.target.value))} aria-label="Transcript position" />
            <button type="button" className="btn" data-testid="replay-next" disabled={i >= lines.length - 1} onClick={() => setI(i + 1)}>Next →</button>
          </div>
          <ol className="transcript replay-full">
            {lines.map((l, n) => (
              <li key={l.seq} className={`tline role-${l.role}${n === i ? ' current' : ''}`} onClick={() => setI(n)}>
                <span className="speaker">{l.speaker}</span><span className="text">{l.text}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
