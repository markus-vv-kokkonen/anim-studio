/**
 * Dev-only Vite plugin: the studio's Save endpoint. POST `{ clips }` to the
 * endpoint and it writes your clips file in the stored format, so an edit made
 * by dragging joints in the browser lands in your game's source (commit to
 * seal it). `apply: 'serve'` — never part of a production build.
 */
import type { Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { emitClipsJson, emitClipsModule, type EmitModuleOptions } from './emit';

/** Minimal shape used off the Node request (avoids depending on @types/node). */
type Req = { method?: string; on(ev: 'data' | 'end', cb: (chunk?: unknown) => void): void };

export interface SavePluginOptions extends EmitModuleOptions {
  /** The clips file to write, absolute or relative to `root`. A `.json` path
   *  gets plain JSON; anything else gets a typed TS module (see emit.ts). */
  file: string;
  /** Project root `file` is resolved against (pass your vite `__dirname`). */
  root?: string;
  /** POST path (default `/__anim/save` — match your adapter's
   *  `save.endpoint`). */
  endpoint?: string;
  /** Optional assembled-characters file (JSON, see skeleton.ts). When set,
   *  the studio loads it with GET and persists Assemble-mode edits with POST
   *  at `skeletonsEndpoint` — so assembled characters live in git next to
   *  your clips. Omit → the studio falls back to localStorage. */
  skeletonsFile?: string;
  /** GET/POST path for the skeletons file (default `/__anim/skeletons`). */
  skeletonsEndpoint?: string;
}

export function animStudioSavePlugin(opts: SavePluginOptions): Plugin {
  const file = path.resolve(opts.root ?? '.', opts.file);
  const endpoint = opts.endpoint ?? '/__anim/save';
  const json = file.endsWith('.json');
  const skelFile = opts.skeletonsFile ? path.resolve(opts.root ?? '.', opts.skeletonsFile) : null;
  const skelEndpoint = opts.skeletonsEndpoint ?? '/__anim/skeletons';
  return {
    name: 'anim-studio-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(endpoint, (req, res, next) => {
        const r = req as unknown as Req;
        if (r.method !== 'POST') return next();
        let body = '';
        r.on('data', (c) => (body += c));
        r.on('end', () => {
          try {
            const data = JSON.parse(body || '{}') as { clips?: unknown };
            fs.writeFileSync(file, json ? emitClipsJson(data.clips) : emitClipsModule(data.clips, opts));
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, bodies: Object.keys((data.clips as object) ?? {}).length }));
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
          }
        });
      });
      if (skelFile) {
        server.middlewares.use(skelEndpoint, (req, res, next) => {
          const r = req as unknown as Req;
          res.setHeader('content-type', 'application/json');
          if (r.method === 'GET') {
            res.statusCode = 200;
            res.end(fs.existsSync(skelFile) ? fs.readFileSync(skelFile, 'utf8') : '{"version":1,"skeletons":{}}\n');
            return;
          }
          if (r.method !== 'POST') return next();
          let body = '';
          r.on('data', (c) => (body += c));
          r.on('end', () => {
            try {
              JSON.parse(body || '{}'); // reject junk before it lands on disk
              fs.writeFileSync(skelFile, body.endsWith('\n') ? body : body + '\n');
              res.statusCode = 200;
              res.end(JSON.stringify({ ok: true }));
            } catch (e) {
              res.statusCode = 500;
              res.end(String(e));
            }
          });
        });
      }
    },
  };
}
