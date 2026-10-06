import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';

interface Stats {
  played: number; winRate: number; avgScore: number; objectionRate: number; objectionsRaised: number;
  series: { id: string; caseTitle: string; score: number; verdict: string; at: number }[];
}

function ScoreChart({ series }: { series: Stats['series'] }) {
  const W = 640, H = 240, L = 36, R = 12, T = 12, B = 28;
  const x = (i: number) => L + (series.length <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (series.length - 1));
  const y = (v: number) => T + ((100 - v) * (H - T - B)) / 100;
  const path = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" data-testid="stats-chart" role="img"
      aria-label={series.length ? `Score per trial: ${series.map((p) => p.score).join(', ')}` : 'No trials yet'}>
      {[0, 25, 50, 75, 100].map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid" />
          <text x={L - 6} y={y(v) + 4} textAnchor="end" className="axis">{v}</text>
        </g>
      ))}
      {series.length === 0 && <text x={W / 2} y={H / 2} textAnchor="middle" className="axis">No finished trials yet</text>}
      {series.length > 1 && <path d={path} className="line" />}
      {series.map((p, i) => (
        <g key={p.id}>
          <circle cx={x(i)} cy={y(p.score)} r={5} className={p.verdict === 'Not guilty' ? 'dot win' : 'dot loss'}>
            <title>{`${p.caseTitle} · ${new Date(p.at).toLocaleDateString()} · ${p.score} (${p.verdict})`}</title>
          </circle>
          {series.length <= 12 && <text x={x(i)} y={H - 8} textAnchor="middle" className="axis">#{i + 1}</text>}
        </g>
      ))}
    </svg>
  );
}

export function StatsPage() {
  const [s, setS] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Stats>('GET', '/api/stats').then(setS).catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load stats.'));
  }, []);
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!s) return <p className="loading">Loading…</p>;
  return (
    <section>
      <h1>Your stats</h1>
      <dl className="stat-tiles">
        <div><dt>Trials played</dt><dd data-testid="stats-played">{s.played}</dd></div>
        <div><dt>Win rate</dt><dd data-testid="stats-winrate">{s.winRate}%</dd></div>
        <div><dt>Average score</dt><dd data-testid="stats-avg">{s.avgScore}</dd></div>
        <div><dt>Objections sustained</dt><dd data-testid="stats-objections">{s.objectionRate}%</dd></div>
      </dl>
      <h2>Score per trial</h2>
      <div className="chart-wrap"><ScoreChart series={s.series} /></div>
      <p className="muted legend"><span className="dot-key win" /> Not guilty <span className="dot-key loss" /> Guilty</p>
    </section>
  );
}
