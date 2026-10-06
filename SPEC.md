# OBJECTION! — AI Courtroom Simulator — Frozen Specification v1.2

> Given **identically** to both AI tools, together with `cases/midnight-bakery.json`.
> Do not change between builds. Any change = version bump, logged in both build logs.

## 1. Product summary
The player is a **defense attorney**. Local LLM agents play the **Prosecutor**, the **Judge**
and each **Witness**. The trial runs through fixed phases enforced by code. The player
cross-examines witnesses, raises objections and presents evidence to expose contradictions.
A code-enforced scoring system plus an AI-judged closing argument decides the verdict.

Design principle: **the LLM talks, the code rules.** Phases, turns, evidence, contradictions,
scores and verdicts are deterministic code. LLMs only produce dialogue and the closing-argument grade.

## 2. Technical constraints (same for both builds)
- `npm install` then `npm run dev` → `http://localhost:3000`.
- Runtime: Node.js 20 LTS or newer. Must run on **Windows 11** (PowerShell): no Unix-only
  commands in npm scripts.
- JavaScript/TypeScript; framework is the tool's choice (record what it picked).
  Use current stable releases of all dependencies; no deprecated packages.
- SQLite single file. `npm run reset-db` wipes, recreates and re-seeds it.
- Cases are loaded from every `*.json` file in `/cases` at seed time (schema = §7).
- AI via Ollama HTTP API: `OLLAMA_URL` (default `http://localhost:11434`),
  `OLLAMA_MODEL` (default `qwen3.5:9b`). AI dialogue must **stream** to the UI token by token.
- Every Ollama request sends `"think": false` (the default model is a reasoning model;
  thinking output must never reach the UI and would delay the first token).
- Every Ollama request sets `options.num_ctx` from `OLLAMA_NUM_CTX` (default `16384`), so a full
  trial transcript fits in context (Ollama's own default of 4096 silently truncates).
- `AI_MOCK=1` → all AI calls return the deterministic output of §6 (used by the test suite).
- `TURN_SECONDS` (default 90) → per-turn timer length.
- Every element in §10 carries the exact `data-testid`.

## 3. Agents (separate system prompts, separate context)
| Agent | Knows | Must never |
|---|---|---|
| Prosecutor | Case summary, charge, all evidence, all public testimony | Reveal witnesses' hidden facts |
| Judge | Courtroom rules, transcript | Take sides before verdict |
| Witness (one per witness) | Own personality, own testimony, **own** hidden facts | Know other witnesses' hidden facts; volunteer hidden facts unless confronted with a contradicting evidence item |

**Information isolation is a requirement**: each witness agent's prompt contains only its own data.

## 4. Trial flow (state machine)
`OPENING → PROSECUTION_CASE → CLOSING → VERDICT`

1. **OPENING:** Player writes an opening statement (max 1000 chars); the Prosecutor then gives one.
2. **PROSECUTION_CASE:** for each witness, in case-file order:
   a. **Direct examination:** the Prosecutor asks 2 questions; the witness answers each.
      After each prosecutor question the player may **Object** (§5.2) before the witness answers.
   b. **Cross-examination:** the witness's testimony statements are listed. The player has
      **6 actions** for this witness. Each action is one of:
      - **Press** a statement → witness elaborates on it (AI).
      - **Present** an evidence item on a statement → contradiction check (§5.3).
      - **Ask** a free-text question (max 300 chars) → witness answers (AI).
      The Prosecutor may object to Ask actions (§5.2). "Next witness" ends early.
   c. Each player turn has a `TURN_SECONDS` countdown; on timeout the turn is spent with no effect.
3. **CLOSING:** Player writes a closing argument (max 2000 chars); the Prosecutor gives one;
   the Judge grades the player's closing 0–40 (§5.4).
4. **VERDICT:** Computed by code (§5.5), announced by the Judge with a short AI-written explanation.

Phase and turn order are enforced **server-side**: out-of-order API calls return HTTP 409.

## 5. Rules

### 5.1 Transcript
Every line (speaker, role, text, timestamp, phase) is stored and shown live in the transcript panel.

### 5.2 Objections
- Types: `Leading`, `Hearsay`, `Speculation`, `Relevance`, `Argumentative`.
- Player objects to a prosecutor question → Judge rules **Sustained** (question withdrawn,
  witness does not answer) or **Overruled** (witness answers), with a one-sentence reason.
- Prosecutor may object to a player's Ask action → Judge rules the same way. If sustained,
  the action is still spent.

### 5.3 Evidence & contradictions
- Evidence items and contradiction pairs come from the case file.
- Present `E` on statement `S`:
  - if `(S, E)` is a contradiction pair → **contradiction found**, the witness reacts (AI)
    and its matching hidden fact is now allowed to be revealed; the statement is marked ✔.
  - otherwise → **wrong presentation**, Judge warns the player (penalty).
- A contradiction can be scored only once. Re-presenting an already-found contradiction has
  no effect and does **not** spend an action.

### 5.4 Score (0–100, floored at 0)
| Component | Points |
|---|---|
| Contradictions | key = 10, non-key = 5 (max 40 for the seed case) |
| Objections | `round(20 × sustained / raised)`; 10 if none raised |
| Closing argument | 0–40, graded by the Judge on: uses found contradictions, addresses the charge, coherence, persuasiveness (10 each) |
| Wrong presentations | −3 each |

### 5.5 Verdict
**Not guilty** if (key contradictions found ≥ `case.verdictRule.minKeyContradictions`)
**and** (score ≥ `case.verdictRule.minScore`); otherwise **Guilty**.

## 6. Mock AI (AI_MOCK=1) — deterministic outputs
| Call | Output |
|---|---|
| Prosecutor opening / closing | `Mock prosecutor opening.` / `Mock prosecutor closing.` |
| Prosecutor direct question k (1-based, per witness) | `Mock direct question {k} to {witnessName}.` |
| Witness answer / press / reaction | `Mock answer from {witnessName}.` |
| Prosecutor objects to player Ask | only if question contains the word `objectionable`; type `Relevance` |
| Judge ruling (player objection) | Sustained iff objection type is `Leading`, else Overruled |
| Judge ruling (prosecutor objection) | Sustained |
| Judge closing grade | `min(40, floor(wordCount / 5))` |
| Judge verdict explanation | `Mock verdict explanation.` |
| Judge warning (wrong presentation) | `Mock judge warning.` |
| Failure injection | if the player's most recently submitted text contains `#fail`, the next AI call fails once (retry succeeds) |

## 7. Case file schema
```json
{
  "id": "string", "title": "string", "charge": "string", "summary": "string",
  "defendant": "string",
  "witnesses": [{
    "id": "string", "name": "string", "role": "string", "personality": "string",
    "testimony": [{ "id": "string", "text": "string" }],
    "hiddenFacts": [{ "id": "string", "text": "string", "unlockedBy": "statementId" }]
  }],
  "evidence": [{ "id": "string", "name": "string", "description": "string" }],
  "contradictions": [{ "statement": "statementId", "evidence": "evidenceId", "key": true }],
  "verdictRule": { "minKeyContradictions": 2, "minScore": 50 }
}
```

## 8. Features

### F1 Authentication
Register (email, password ≥ 8 chars), log in, log out. Hashed passwords. Duplicate email → error.
Trials are per-user; user A can never read user B's trials (UI or API → 403/404).

### F2 Case library
Lists all cases (title, charge, number of witnesses, player's best score). "Start trial" button.

### F3 Case editor
Create / edit / delete user-made cases through a form covering the full schema (§7), with validation:
every contradiction must reference existing statement and evidence ids; at least 1 witness and
1 evidence item. Built-in cases cannot be deleted. Import/export a case as JSON.

### F4 Courtroom screen
Phase banner, current speaker, live streaming transcript, witness panel with testimony
statements (✔ when contradicted), evidence drawer, action bar, action counter, turn timer,
live score.

### F5 Objections — §5.2
### F6 Evidence & contradictions — §5.3
### F7 Verdict & score breakdown — §5.4, §5.5. Shows every component and the found/missed contradictions.

### F8 Trial history & replay
List of the player's past trials (case, date, verdict, score). Replay view steps through the
transcript line by line (Prev / Next). Export transcript as Markdown.

### F9 Stats dashboard
Trials played, win rate, average score, objection success rate, chart of score per trial over time.

### Non-functional
- Responsive down to 375 px. Inputs labelled; whole trial playable by keyboard.
- AI failure (Ollama down / invalid output) → visible error + retry button, trial state not lost.
- README explains setup incl. Ollama.

## 9. Out of scope
Held back for the extension test (revealed only after both builds are finished).

## 10. data-testid contract
| Area | testids |
|---|---|
| Auth | `register-email`, `register-password`, `register-submit`, `login-email`, `login-password`, `login-submit`, `logout`, `auth-error` |
| Library | `case-item` (repeated), `case-title`, `case-best-score`, `case-start` |
| Editor | `case-new`, `case-edit`, `case-delete`, `confirm-yes`, `editor-title`, `editor-save`, `editor-error` (also used for import errors), `case-export`, `case-import-file` |
| Courtroom | `phase-banner`, `transcript`, `transcript-line` (repeated), `turn-timer`, `actions-left`, `live-score`, `ai-error`, `ai-retry` |
| Opening/closing | `opening-input`, `opening-submit`, `closing-input`, `closing-submit` |
| Direct exam | `object-button`, `object-type` (select), `object-submit`, `ruling` (text contains `Sustained` or `Overruled`), `continue` |
| Cross exam | `statement` (repeated, attributes `data-statement-id` and `data-contradicted="true"` once contradicted), `press-button`, `present-button`, `evidence-item` (repeated, attribute `data-evidence-id`), `ask-input`, `ask-submit`, `next-witness` |
| Verdict | `verdict` (text `Guilty` or `Not guilty`), `score-total`, `score-contradictions`, `score-objections`, `score-closing`, `score-penalty` |
| History | `history-item` (repeated), `replay-prev`, `replay-next`, `replay-line`, `transcript-export` |
| Stats | `stats-played`, `stats-winrate`, `stats-avg`, `stats-objections`, `stats-chart` |

## 11. UI contract (routes & interaction)
| Route | Page |
|---|---|
| `/register`, `/login` | Auth forms. Successful register **or** login → redirect to `/cases` (register logs the user in). |
| `/cases` | Case library, incl. `case-new` and `case-import-file`. |
| `/cases/new`, `/cases/:id/edit` | Case editor. Successful save → redirect to `/cases`. |
| `/trial/:trialId` | Courtroom. Reloading resumes the trial in its current state. |
| `/history` | Trial history. Clicking a `history-item` → `/history/:trialId` (replay, incl. `transcript-export`). |
| `/stats` | Stats dashboard. |

- Logged-out access to any page except `/register` and `/login` → redirect to `/login`. `logout` → `/login`.
- `logout` is visible on every logged-in page.
- `phase-banner` text: `Opening`, `Direct examination — {witnessName}`, `Cross-examination — {witnessName}`, `Closing`, `Verdict`.
- `continue` is the single "advance" button, shown whenever the trial waits for the player to move on
  (after prosecutor questions, witness answers, rulings, between phases).
- **While any AI response is streaming, `continue`, `object-button`, `press-button`, `present-button`,
  `ask-submit` and `next-witness` are disabled.**
- Cross-examination: clicking a `statement` selects it. `press-button` presses the selected statement.
  Present = select a statement, click an `evidence-item` to select it, click `present-button`.
  Evidence items are visible without extra clicks at widths ≥ 768 px.
- Objecting: `object-button` → choose `object-type` (option values = the five type names) → `object-submit`.
- Numbers: `actions-left`, `turn-timer` (seconds), `live-score` and every `score-*` element contain one integer;
  `score-penalty` is negative or 0 (e.g. `-3`). `stats-winrate` is a percentage (e.g. `50%`), `stats-avg` is rounded.
- `case-best-score` shows `—` (no digits) until the player has finished a trial of that case.
- User-made cases are private to their creator. Case `id`s are unique per user.
