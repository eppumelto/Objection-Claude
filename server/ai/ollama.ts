import { config } from '../config.ts';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export class AiError extends Error {}

const TIMEOUT_MS = 5 * 60 * 1000;

async function post(body: object): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel,
        think: false,
        ...body,
        options: { num_ctx: config.numCtx, ...((body as { options?: object }).options ?? {}) },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new AiError(`Could not reach Ollama at ${config.ollamaUrl} (${(e as Error).message}).`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AiError(`Ollama returned HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return res;
}

/**
 * Suppresses any <think>…</think> block at the start of the output. Ollama is called with
 * think:false, so this is only a safety net in case a model still emits its reasoning inline.
 */
function thinkFilter() {
  let buf = '';
  let mode: 'probe' | 'thinking' | 'pass' = 'probe';
  return (chunk: string): string => {
    if (mode === 'pass') return chunk;
    buf += chunk;
    if (mode === 'probe') {
      const t = buf.trimStart();
      if (t.length < 7 && '<think>'.startsWith(t)) return '';
      if (!t.startsWith('<think>')) { mode = 'pass'; const out = buf; buf = ''; return out; }
      mode = 'thinking';
    }
    const end = buf.indexOf('</think>');
    if (end < 0) return '';
    mode = 'pass';
    const out = buf.slice(end + 8).trimStart();
    buf = '';
    return out;
  };
}

/** Streams a chat completion, calling onToken for each visible chunk. Returns the full text. */
export async function streamChat(messages: ChatMessage[], onToken: (t: string) => void, temperature = 0.8): Promise<string> {
  const res = await post({ messages, stream: true, options: { temperature } });
  if (!res.body) throw new AiError('Ollama returned an empty response.');
  const decoder = new TextDecoder();
  const filter = thinkFilter();
  let pending = '';
  let full = '';
  const handle = (line: string) => {
    if (!line.trim()) return;
    let msg: { message?: { content?: string }; error?: string };
    try { msg = JSON.parse(line); } catch { throw new AiError('Ollama sent malformed data.'); }
    if (msg.error) throw new AiError(`Ollama error: ${msg.error}`);
    // Only `content` is used; any `thinking` field is ignored so it never reaches the UI.
    const piece = msg.message?.content ? filter(msg.message.content) : '';
    if (piece) { full += piece; onToken(piece); }
  };
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        handle(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
    }
    handle(pending);
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw new AiError(`Lost connection to Ollama (${(e as Error).message}).`);
  }
  if (!full.trim()) throw new AiError('The AI returned an empty answer.');
  return full;
}

/** Non-streamed structured call; the response is constrained to the given JSON schema. */
export async function jsonChat<T>(messages: ChatMessage[], schema: object): Promise<T> {
  const res = await post({ messages, stream: false, format: schema, options: { temperature: 0.2 } });
  const body = (await res.json().catch(() => null)) as { message?: { content?: string } } | null;
  const content = body?.message?.content ?? '';
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new AiError('The AI returned invalid structured output.');
  }
}
