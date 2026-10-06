# OBJECTION! — AI Courtroom Simulator

You play the **defense attorney**. Local LLM agents running in [Ollama](https://ollama.com) play the
Prosecutor, the Judge and each Witness. Cross-examine witnesses, raise objections and present evidence
to expose contradictions, then win (or lose) the verdict.

**The LLM talks, the code rules:** phases, turns, evidence, contradictions, scores and the verdict are
deterministic server code. The AI only writes dialogue and grades your closing argument.

Built against `SPEC.md` v1.2.

## Requirements

- **Node.js 20 LTS or newer** (tested on Node 20.17, Windows 11 / PowerShell)
- **Ollama** with the `qwen3.5:9b` model (not needed for mock mode)

## Setup

```powershell
# 1. Install Ollama from https://ollama.com/download, then pull the model
ollama pull qwen3.5:9b

# 2. Install and run the app
npm install
npm run dev
```

Open **http://localhost:3000**, register an account and start the built-in case
*The Midnight Bakery Fire*.

The SQLite database is created at `data/objection.db` on first start and seeded with every
`*.json` file in `/cases`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Starts the server and the client bundler (watch mode) on port 3000 |
| `npm run reset-db` | Wipes the database, recreates the schema and re-seeds the cases from `/cases` |
| `npm test` | Runs the API integration tests (starts its own server in mock mode on a temporary database) |
| `npm run typecheck` | TypeScript type check |
| `npm start` | Same server with a minified client bundle and no file watching |

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama HTTP API |
| `OLLAMA_MODEL` | `qwen3.5:9b` | Model used by every agent |
| `OLLAMA_NUM_CTX` | `16384` | Sent as `options.num_ctx` on every request |
| `AI_MOCK` | unset | `1` = deterministic mock AI (spec §6), used by tests |
| `TURN_SECONDS` | `90` | Cross-examination turn timer |
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `data/objection.db` | SQLite file |
| `MOCK_TOKEN_MS` | `25` | Delay between streamed mock tokens (`0` = instant) |

PowerShell example:

```powershell
$env:AI_MOCK = "1"; $env:TURN_SECONDS = "30"; npm run dev
```

Every Ollama request sends `"think": false` and `options.num_ctx`. As a safety net, any `<think>` block
or `thinking` field in the output is dropped before it reaches the UI.

## How to play

1. **Opening:** write your opening statement (max 1000 chars). The prosecutor answers.
2. **Direct examination:** the prosecutor asks each witness 2 questions. After each question you can
   **Objection!** (Leading, Hearsay, Speculation, Relevance or Argumentative) or **Continue**.
3. **Cross-examination:** 6 actions per witness, each with a turn timer:
   - **Press** a selected statement: the witness elaborates.
   - **Present** an evidence item on a selected statement: if it contradicts the statement, the witness
     is caught out (✔). Otherwise the judge warns you (−3 points).
   - **Ask** a free-text question (max 300 chars). The prosecutor may object.
4. **Closing:** write your closing argument (max 2000 chars). The judge grades it 0–40.
5. **Verdict:** *Not guilty* needs enough key contradictions **and** a high enough score.

Score: key contradiction 10, other contradictions 5; objections `round(20 × sustained / raised)`
(10 if none raised); closing 0–40; −3 per wrong presentation; floored at 0.

Everything is keyboard-accessible (Tab / Enter / Space). On the replay page ← and → step through
the transcript.

## Tech choices

| Area | Choice |
|---|---|
| Server | **Express 5** on Node, TypeScript run directly with **tsx** |
| Client | **React 19** + **React Router 7**, bundled by **esbuild** in-process (no separate dev server) |
| Database | **SQLite** via **better-sqlite3** (single file, WAL mode) |
| Auth | scrypt password hashes (`node:crypto`), httpOnly session cookie |
| AI | Ollama `/api/chat`; streaming NDJSON for dialogue, JSON-schema `format` for structured decisions |
| Tests | `node:test` integration tests over HTTP, in mock mode |

Vite was considered, but current Vite releases need Node 20.19+. esbuild keeps the project working on
every Node 20 LTS release.

## Architecture

```
server/
  index.ts          Express app, static client, SPA fallback
  db.ts             schema, seeding from /cases, reset
  auth.ts           register / login / logout, sessions
  cases.ts          case library + editor API, import / export
  trial/engine.ts   trial state machine, rules, scoring, AI task queue
  trial/routes.ts   trial API (NDJSON streaming), history, stats
  ai/ollama.ts      Ollama client (streaming + structured)
  ai/agents.ts      Prosecutor / Judge / Witness prompts + mock outputs
shared/types.ts     types and case validation shared with the client
client/             React UI
tests/              API integration tests
```

- **Server-enforced flow.** Every player action goes to `POST /api/trials/:id/actions`. The engine checks
  the current step and returns **409** for out-of-order calls. Valid actions update the state and queue
  AI tasks. The response then streams NDJSON events (`start`, `token`, `line`, `state`, `error`) while
  the tasks run.
- **Failure and retry.** A failed AI task stays at the head of the queue and the error is stored on the
  trial. The UI shows an error with a **Retry** button, which re-runs the queue. Nothing that already
  happened is lost, and reloading the page resumes the trial in exactly the same state.
- **Information isolation.** Every agent call builds its own system prompt.
  - A witness prompt contains only that witness's personality, testimony and its own examination
    transcript.
  - A hidden fact is included only after the matching contradiction has been found, so a locked fact
    cannot leak.
  - The prosecutor sees only the public record. The client never receives hidden facts or contradiction
    pairs before the verdict.
- **Turn timer.** The deadline is stored server-side, so it survives reloads. When it runs out, the
  client sends a `timeout` action, which the server only accepts once the deadline has passed.

## Spec interpretations

- In cross-examination you may act again straight after a witness answers. A **Continue** button also
  appears to acknowledge the answer. When the 6 actions are used up, **Continue** moves to the next
  witness.
- If the judge overrules your objection during direct examination, the witness answers immediately.
  One **Continue** then moves to the next question, the same as after a sustained objection.
- The turn timer applies to cross-examination turns, the only turns where an action can be spent.
  Elsewhere it shows the full `TURN_SECONDS`.
- `#fail` failure injection is active only in mock mode (`AI_MOCK=1`).
- Imported cases whose `id` is already taken get a numeric suffix (e.g. `midnight-bakery-2`), so an
  exported built-in case can be re-imported. In the editor, a duplicate id is an error. A blank id is
  generated from the title.
- Built-in cases can be exported but not edited or deleted (the edit and delete buttons are hidden,
  and the API returns 403).
- History lists finished trials. Unfinished trials can be resumed from the case library.
