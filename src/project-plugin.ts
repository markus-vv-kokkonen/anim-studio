/**
 * Dev-only Vite plugin: the standalone studio's project host.
 *
 * `save-plugin.ts` answers "write my clips file", configured once by a host
 * game's own Vite config. This answers the standalone case instead: WHICH
 * project is being edited is a runtime choice, so the endpoints resolve their
 * paths through the active project rather than through plugin options.
 *
 * It also statically serves the active project's `publicDir` as a fallback
 * after Vite's own middlewares. That is what lets a skeleton doc store
 * `src: "art/chars/podge_head.png"` — the same relative path the game uses —
 * instead of a base64 blob, so character documents stay small and diffable.
 *
 * `apply: 'serve'` — never part of a production build. Imported directly, not
 * via index.ts, because it reads node:fs.
 */
import type { Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { parseProjectConfig, projectById, safeJoin, type ProjectConfig, type ProjectDef } from './project';

/** Minimal shapes used off the Node req/res (avoids depending on @types/node). */
type Req = { method?: string; url?: string; on(ev: 'data' | 'end', cb: (chunk?: unknown) => void): void };
type Res = {
  statusCode: number;
  setHeader(k: string, v: string): void;
  end(s?: string): void;
};

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const EMPTY_SKELETONS = '{"version":1,"skeletons":{}}\n';

export interface ProjectPluginOptions {
  /** Config file, absolute or relative to `root`. */
  configFile: string;
  /** Directory `configFile` resolves against (pass your vite `__dirname`). */
  root?: string;
}

export function animStudioProjectPlugin(opts: ProjectPluginOptions): Plugin {
  const configPath = path.resolve(opts.root ?? '.', opts.configFile);

  /** Re-read on every request rather than caching: the file is hand-edited on
   *  a dev machine, and a stale cache means editing it appears to do nothing. */
  const readConfig = (): ProjectConfig | null => {
    if (!fs.existsSync(configPath)) return null;
    return parseProjectConfig(fs.readFileSync(configPath, 'utf8'));
  };

  /** The active id lives in memory, not on disk: switching project in the UI
   *  should not rewrite a file the user hand-maintains. It resets to the
   *  file's own `active` when the server restarts. */
  let activeOverride: string | null = null;

  const active = (cfg: ProjectConfig): ProjectDef => {
    const id = activeOverride && projectById(cfg, activeOverride) ? activeOverride : cfg.active;
    return projectById(cfg, id)!;
  };

  const readBody = (r: Req): Promise<string> =>
    new Promise((res) => {
      let body = '';
      r.on('data', (c) => (body += c));
      r.on('end', () => res(body));
    });

  const sendJson = (res: Res, code: number, value: unknown): void => {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(value));
  };

  return {
    name: 'anim-studio-project',
    apply: 'serve',
    configureServer(server) {
      // ---- the project list + switcher ----
      server.middlewares.use('/__anim/projects', (req, res, next) => {
        const r = req as unknown as Req;
        const w = res as unknown as Res;
        let cfg: ProjectConfig | null;
        try {
          cfg = readConfig();
        } catch (e) {
          return sendJson(w, 500, { ok: false, error: String(e) });
        }
        if (!cfg) {
          return sendJson(w, 200, {
            active: '',
            projects: [],
            error: `no config at ${configPath} — copy anim-studio.config.example.json`,
          });
        }
        if (r.method === 'GET') {
          return sendJson(w, 200, {
            active: active(cfg).id,
            projects: cfg.projects.map((p) => ({ id: p.id, name: p.name, root: p.root })),
          });
        }
        if (r.method !== 'POST') return next();
        const known = cfg;
        void readBody(r).then((body) => {
          try {
            const { id } = JSON.parse(body || '{}') as { id?: string };
            if (!id || !projectById(known, id)) {
              return sendJson(w, 404, { ok: false, error: `unknown project "${id ?? ''}"` });
            }
            activeOverride = id;
            sendJson(w, 200, { ok: true, active: id });
          } catch (e) {
            sendJson(w, 500, { ok: false, error: String(e) });
          }
        });
      });

      // ---- the active project's skeletons file ----
      server.middlewares.use('/__anim/skeletons', (req, res, next) => {
        const r = req as unknown as Req;
        const w = res as unknown as Res;
        let cfg: ProjectConfig | null;
        try {
          cfg = readConfig();
        } catch (e) {
          return sendJson(w, 500, { ok: false, error: String(e) });
        }
        if (!cfg) return next();
        const proj = active(cfg);
        const file = path.resolve(proj.root, proj.skeletonsFile);
        w.setHeader('content-type', 'application/json');
        if (r.method === 'GET') {
          w.statusCode = 200;
          w.end(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : EMPTY_SKELETONS);
          return;
        }
        if (r.method !== 'POST') return next();
        void readBody(r).then((body) => {
          try {
            JSON.parse(body || '{}'); // reject junk before it lands on disk
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, body.endsWith('\n') ? body : body + '\n');
            sendJson(w, 200, { ok: true });
          } catch (e) {
            sendJson(w, 500, { ok: false, error: String(e) });
          }
        });
      });

      // ---- static fallback: the active project's publicDir at the server root ----
      // Returned as a post-hook so it registers AFTER Vite's own middlewares:
      // the studio's own modules and HTML win, and only paths Vite does not
      // claim fall through to the project's assets.
      return () => {
        server.middlewares.use((req, res, next) => {
          const r = req as unknown as Req;
          const w = res as unknown as Res;
          if (r.method !== 'GET' && r.method !== 'HEAD') return next();
          const url = (r.url ?? '').split('?')[0];
          if (!url || url.startsWith('/__anim') || url.startsWith('/@')) return next();
          let cfg: ProjectConfig | null;
          try {
            cfg = readConfig();
          } catch {
            return next();
          }
          if (!cfg) return next();
          const proj = active(cfg);
          const base = path.resolve(proj.root, proj.publicDir);
          let rel: string;
          try {
            rel = decodeURIComponent(url);
          } catch {
            return next(); // malformed percent-encoding is not an asset path
          }
          const file = safeJoin(base, rel);
          if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
          w.statusCode = 200;
          w.setHeader('content-type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
          // No caching: an artist re-bakes a part and reloads, and a 304 there
          // would show them yesterday's PNG and cost an hour.
          w.setHeader('cache-control', 'no-store');
          fs.createReadStream(file).pipe(res as unknown as NodeJS.WritableStream);
        });
      };
    },
  };
}
