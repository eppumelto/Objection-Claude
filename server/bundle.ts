import * as esbuild from 'esbuild';
import path from 'node:path';
import { ROOT } from './config.ts';

export const OUT_DIR = path.join(ROOT, '.build');

const options = (prod: boolean): esbuild.BuildOptions => ({
  entryPoints: { app: path.join(ROOT, 'client', 'main.tsx') },
  bundle: true,
  outdir: OUT_DIR,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: !prod,
  minify: prod,
  define: { 'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development') },
  logLevel: 'warning',
});

/** Builds the client bundle; in watch mode rebuilds on change. */
export async function bundleClient({ watch }: { watch: boolean }) {
  if (watch) {
    const ctx = await esbuild.context(options(false));
    await ctx.rebuild();
    await ctx.watch();
    return;
  }
  await esbuild.build(options(true));
}
