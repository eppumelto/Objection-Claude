import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const int = (v: string | undefined, def: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

export const config = {
  port: int(process.env.PORT, 3000),
  dbPath: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(ROOT, 'data', 'objection.db'),
  casesDir: path.join(ROOT, 'cases'),
  ollamaUrl: (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, ''),
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen3.5:9b',
  numCtx: int(process.env.OLLAMA_NUM_CTX, 16384),
  mock: process.env.AI_MOCK === '1',
  turnSeconds: int(process.env.TURN_SECONDS, 90),
  /** Delay between streamed mock tokens, so streaming is observable in the UI. */
  mockTokenMs: Number.parseInt(process.env.MOCK_TOKEN_MS ?? '25', 10) || 0,
  actionsPerWitness: 6,
  directQuestions: 2,
};
