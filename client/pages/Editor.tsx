import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../api.ts';
import { validateCase, type CaseFile, type Witness } from '../../shared/types.ts';

const emptyCase = (): CaseFile => ({
  id: '', title: '', charge: '', summary: '', defendant: '',
  witnesses: [], evidence: [], contradictions: [],
  verdictRule: { minKeyContradictions: 1, minScore: 50 },
});

/** Picks the next free id of the form `${prefix}${n}`. */
function nextId(prefix: string, used: string[]): string {
  for (let n = 1; ; n++) if (!used.includes(`${prefix}${n}`)) return `${prefix}${n}`;
}

function allIds(c: CaseFile): string[] {
  return [
    ...c.witnesses.flatMap((w) => [w.id, ...w.testimony.map((s) => s.id), ...w.hiddenFacts.map((h) => h.id)]),
    ...c.evidence.map((e) => e.id),
  ];
}

export function EditorPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const [c, setC] = useState<CaseFile | null>(isNew ? emptyCase() : null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isNew) return;
    api<{ case: CaseFile; builtin: boolean }>('GET', `/api/cases/${encodeURIComponent(id!)}`)
      .then((r) => {
        if (r.builtin) setErrors(['Built-in cases cannot be edited.']);
        else setC(r.case);
      })
      .catch((e) => setErrors([e instanceof ApiError ? e.message : 'Could not load the case.']));
  }, [id, isNew]);

  if (!c) {
    return (
      <section>
        <h1>Edit case</h1>
        {errors.length ? <p className="error" role="alert" data-testid="editor-error">{errors.join(' ')}</p> : <p className="loading">Loading…</p>}
        <Link to="/cases">Back to cases</Link>
      </section>
    );
  }

  const update = (fn: (draft: CaseFile) => void) => {
    setC((prev) => {
      const next = structuredClone(prev!);
      fn(next);
      return next;
    });
  };
  const updW = (i: number, fn: (w: Witness) => void) => update((d) => fn(d.witnesses[i]));

  const statements = c.witnesses.flatMap((w) => w.testimony.map((s) => ({ ...s, witness: w.name || w.id })));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const candidate = { ...c, id: c.id.trim() || 'pending-id' };
    const errs = validateCase(candidate);
    setErrors(errs);
    if (errs.length) return;
    setSaving(true);
    try {
      const body = { case: { ...c, id: c.id.trim() } };
      if (isNew) await api('POST', '/api/cases', body);
      else await api('PUT', `/api/cases/${encodeURIComponent(id!)}`, body);
      navigate('/cases');
    } catch (err) {
      setErrors([err instanceof ApiError ? err.message : 'Could not save the case.']);
      setSaving(false);
    }
  };

  return (
    <section className="editor">
      <div className="page-head">
        <h1>{isNew ? 'New case' : `Edit case`}</h1>
        <Link to="/cases" className="btn ghost">Cancel</Link>
      </div>
      <form onSubmit={save} noValidate>
        <fieldset>
          <legend>Case</legend>
          <div className="grid2">
            <div>
              <label htmlFor="ed-title">Title</label>
              <input id="ed-title" data-testid="editor-title" value={c.title} onChange={(e) => update((d) => { d.title = e.target.value; })} />
            </div>
            <div>
              <label htmlFor="ed-id">Case id <span className="hint">(letters, digits, - and _; blank = from title)</span></label>
              <input id="ed-id" value={c.id} onChange={(e) => update((d) => { d.id = e.target.value; })} />
            </div>
            <div>
              <label htmlFor="ed-charge">Charge</label>
              <input id="ed-charge" value={c.charge} onChange={(e) => update((d) => { d.charge = e.target.value; })} />
            </div>
            <div>
              <label htmlFor="ed-defendant">Defendant</label>
              <input id="ed-defendant" value={c.defendant} onChange={(e) => update((d) => { d.defendant = e.target.value; })} />
            </div>
          </div>
          <label htmlFor="ed-summary">Summary</label>
          <textarea id="ed-summary" rows={3} value={c.summary} onChange={(e) => update((d) => { d.summary = e.target.value; })} />
          <div className="grid2">
            <div>
              <label htmlFor="ed-minkey">Key contradictions needed for “Not guilty”</label>
              <input id="ed-minkey" type="number" min={0} value={c.verdictRule.minKeyContradictions}
                onChange={(e) => update((d) => { d.verdictRule.minKeyContradictions = Number.parseInt(e.target.value, 10) || 0; })} />
            </div>
            <div>
              <label htmlFor="ed-minscore">Minimum score for “Not guilty”</label>
              <input id="ed-minscore" type="number" min={0} max={100} value={c.verdictRule.minScore}
                onChange={(e) => update((d) => { d.verdictRule.minScore = Number.parseInt(e.target.value, 10) || 0; })} />
            </div>
          </div>
        </fieldset>

        <fieldset>
          <legend>Witnesses</legend>
          {c.witnesses.map((w, i) => (
            <div className="subcard" key={i}>
              <div className="subhead">
                <h3>Witness {i + 1}</h3>
                <button type="button" className="btn small danger" onClick={() => update((d) => {
                  const removed = new Set(d.witnesses[i].testimony.map((s) => s.id));
                  d.witnesses.splice(i, 1);
                  d.contradictions = d.contradictions.filter((x) => !removed.has(x.statement));
                })}>Remove witness</button>
              </div>
              <div className="grid3">
                <div><label htmlFor={`w${i}-name`}>Name</label>
                  <input id={`w${i}-name`} value={w.name} onChange={(e) => updW(i, (x) => { x.name = e.target.value; })} /></div>
                <div><label htmlFor={`w${i}-role`}>Role</label>
                  <input id={`w${i}-role`} value={w.role} onChange={(e) => updW(i, (x) => { x.role = e.target.value; })} /></div>
                <div><label htmlFor={`w${i}-id`}>Id</label>
                  <input id={`w${i}-id`} value={w.id} onChange={(e) => updW(i, (x) => { x.id = e.target.value; })} /></div>
              </div>
              <label htmlFor={`w${i}-pers`}>Personality</label>
              <input id={`w${i}-pers`} value={w.personality} onChange={(e) => updW(i, (x) => { x.personality = e.target.value; })} />

              <h4>Testimony</h4>
              {w.testimony.map((s, j) => (
                <div className="line-edit" key={j}>
                  <label className="sr-only" htmlFor={`w${i}-s${j}-id`}>Statement {j + 1} id</label>
                  <input className="id-input" id={`w${i}-s${j}-id`} value={s.id} onChange={(e) => updW(i, (x) => { x.testimony[j].id = e.target.value; })} />
                  <label className="sr-only" htmlFor={`w${i}-s${j}-text`}>Statement {j + 1} text</label>
                  <input id={`w${i}-s${j}-text`} placeholder="Statement text" value={s.text} onChange={(e) => updW(i, (x) => { x.testimony[j].text = e.target.value; })} />
                  <button type="button" className="btn small ghost" aria-label={`Remove statement ${j + 1}`} onClick={() => update((d) => {
                    d.witnesses[i].testimony.splice(j, 1);
                    d.contradictions = d.contradictions.filter((x) => x.statement !== s.id);
                  })}>✕</button>
                </div>
              ))}
              <button type="button" className="btn small" onClick={() => update((d) => {
                d.witnesses[i].testimony.push({ id: nextId(`${w.id || 'w'}-s`, allIds(d)), text: '' });
              })}>Add statement</button>

              <h4>Hidden facts</h4>
              {w.hiddenFacts.map((h, j) => (
                <div className="line-edit" key={j}>
                  <label className="sr-only" htmlFor={`w${i}-h${j}-id`}>Hidden fact {j + 1} id</label>
                  <input className="id-input" id={`w${i}-h${j}-id`} value={h.id} onChange={(e) => updW(i, (x) => { x.hiddenFacts[j].id = e.target.value; })} />
                  <label className="sr-only" htmlFor={`w${i}-h${j}-text`}>Hidden fact {j + 1} text</label>
                  <input id={`w${i}-h${j}-text`} placeholder="Hidden fact" value={h.text} onChange={(e) => updW(i, (x) => { x.hiddenFacts[j].text = e.target.value; })} />
                  <label className="sr-only" htmlFor={`w${i}-h${j}-unl`}>Unlocked by statement</label>
                  <select id={`w${i}-h${j}-unl`} value={h.unlockedBy} onChange={(e) => updW(i, (x) => { x.hiddenFacts[j].unlockedBy = e.target.value; })}>
                    <option value="">Unlocked by…</option>
                    {w.testimony.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
                  </select>
                  <button type="button" className="btn small ghost" aria-label={`Remove hidden fact ${j + 1}`} onClick={() => updW(i, (x) => { x.hiddenFacts.splice(j, 1); })}>✕</button>
                </div>
              ))}
              <button type="button" className="btn small" onClick={() => update((d) => {
                d.witnesses[i].hiddenFacts.push({ id: nextId(`${w.id || 'w'}-h`, allIds(d)), text: '', unlockedBy: w.testimony[0]?.id ?? '' });
              })}>Add hidden fact</button>
            </div>
          ))}
          <button type="button" className="btn" onClick={() => update((d) => {
            d.witnesses.push({ id: nextId('w', allIds(d)), name: '', role: '', personality: '', testimony: [], hiddenFacts: [] });
          })}>Add witness</button>
        </fieldset>

        <fieldset>
          <legend>Evidence</legend>
          {c.evidence.map((ev, i) => (
            <div className="line-edit evidence-edit" key={i}>
              <label className="sr-only" htmlFor={`e${i}-id`}>Evidence {i + 1} id</label>
              <input className="id-input" id={`e${i}-id`} value={ev.id} onChange={(e) => update((d) => { d.evidence[i].id = e.target.value; })} />
              <label className="sr-only" htmlFor={`e${i}-name`}>Evidence {i + 1} name</label>
              <input id={`e${i}-name`} placeholder="Name" value={ev.name} onChange={(e) => update((d) => { d.evidence[i].name = e.target.value; })} />
              <label className="sr-only" htmlFor={`e${i}-desc`}>Evidence {i + 1} description</label>
              <input id={`e${i}-desc`} placeholder="Description" value={ev.description} onChange={(e) => update((d) => { d.evidence[i].description = e.target.value; })} />
              <button type="button" className="btn small ghost" aria-label={`Remove evidence ${i + 1}`} onClick={() => update((d) => {
                d.evidence.splice(i, 1);
                d.contradictions = d.contradictions.filter((x) => x.evidence !== ev.id);
              })}>✕</button>
            </div>
          ))}
          <button type="button" className="btn" onClick={() => update((d) => {
            d.evidence.push({ id: nextId('e', allIds(d)), name: '', description: '' });
          })}>Add evidence</button>
        </fieldset>

        <fieldset>
          <legend>Contradictions</legend>
          {c.contradictions.map((x, i) => (
            <div className="line-edit" key={i}>
              <label className="sr-only" htmlFor={`c${i}-s`}>Contradiction {i + 1} statement</label>
              <select id={`c${i}-s`} value={x.statement} onChange={(e) => update((d) => { d.contradictions[i].statement = e.target.value; })}>
                <option value="">Statement…</option>
                {statements.map((s) => <option key={s.id} value={s.id}>{s.witness}: {s.text || s.id}</option>)}
              </select>
              <label className="sr-only" htmlFor={`c${i}-e`}>Contradiction {i + 1} evidence</label>
              <select id={`c${i}-e`} value={x.evidence} onChange={(e) => update((d) => { d.contradictions[i].evidence = e.target.value; })}>
                <option value="">Evidence…</option>
                {c.evidence.map((ev) => <option key={ev.id} value={ev.id}>{ev.name || ev.id}</option>)}
              </select>
              <label className="check">
                <input type="checkbox" checked={x.key} onChange={(e) => update((d) => { d.contradictions[i].key = e.target.checked; })} /> Key
              </label>
              <button type="button" className="btn small ghost" aria-label={`Remove contradiction ${i + 1}`} onClick={() => update((d) => { d.contradictions.splice(i, 1); })}>✕</button>
            </div>
          ))}
          <button type="button" className="btn" onClick={() => update((d) => {
            d.contradictions.push({ statement: '', evidence: '', key: false });
          })}>Add contradiction</button>
        </fieldset>

        {errors.length > 0 && (
          <div className="error" role="alert" data-testid="editor-error">
            {errors.length === 1 ? errors[0] : <ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
          </div>
        )}
        <div className="row-actions">
          <button type="submit" className="btn primary" data-testid="editor-save" disabled={saving}>{saving ? 'Saving…' : 'Save case'}</button>
          <Link to="/cases" className="btn ghost">Cancel</Link>
        </div>
      </form>
    </section>
  );
}
