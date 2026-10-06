import express from 'express';
import path from 'node:path';
import { config, ROOT } from './config.ts';
import './db.ts';
import { authRouter, sessionMiddleware } from './auth.ts';
import { casesRouter } from './cases.ts';
import { statsRouter, trialsRouter } from './trial/routes.ts';
import { bundleClient, OUT_DIR } from './bundle.ts';

const prod = process.argv.includes('--prod');
await bundleClient({ watch: !prod });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(sessionMiddleware);

app.use('/api/auth', authRouter);
app.use('/api/cases', casesRouter);
app.use('/api/trials', trialsRouter);
app.use('/api/stats', statsRouter);
app.use('/api', (_req, res) => void res.status(404).json({ error: 'Not found.' }));

app.use('/assets', express.static(OUT_DIR, { maxAge: prod ? '1h' : 0 }));
app.use(express.static(path.join(ROOT, 'public'), { index: false }));
// Single-page app: every other GET returns the shell; the client router handles the path.
app.get(/.*/, (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

app.use((err: Error & { status?: number; type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err.type === 'entity.parse.failed') return void res.status(400).json({ error: 'Invalid JSON body.' });
  console.error(err);
  res.status(err.status ?? 500).json({ error: 'Internal server error.' });
});

app.listen(config.port, () => {
  console.log(`OBJECTION! running at http://localhost:${config.port}`);
  console.log(config.mock ? 'AI: mock mode (AI_MOCK=1)' : `AI: Ollama ${config.ollamaUrl}, model ${config.ollamaModel}, num_ctx ${config.numCtx}`);
});
