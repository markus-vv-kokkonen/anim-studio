/**
 * Projects — the standalone studio's working directories.
 *
 * The studio used to exist only mounted inside a host game's Vite config, so
 * "which project am I editing" was answered once, statically, by that host.
 * Standalone, it is a runtime choice: this module is the format and the pure
 * logic behind it. No node:fs and no DOM, so both the server plugin and the
 * tests can use it.
 *
 * Paths are resolved with posix semantics against an absolute `root`. A
 * project's data always lives in the PROJECT's repo, never in this one — the
 * studio is the tool, not the home.
 */

/** One editable project. `root` is absolute (machine-specific — which is why
 *  the real config file is gitignored and only the example is committed). */
export interface ProjectDef {
  /** Stable id used in the selector and on the wire. */
  id: string;
  /** Display name in the header dropdown. */
  name: string;
  /** Absolute path to the project checkout. */
  root: string;
  /** Directory under `root` served at the server root, so a bone's
   *  `src: "art/chars/x.png"` resolves exactly as it does in the game. */
  publicDir: string;
  /** Assembled-characters file, relative to `root`. */
  skeletonsFile: string;
  /** Optional authored-clips file for procedural bodies, relative to `root`. */
  clipsFile?: string;
}

export interface ProjectConfig {
  projects: ProjectDef[];
  /** Id of the project currently being edited. Always names a real project. */
  active: string;
}

const REQUIRED = ['id', 'name', 'root', 'publicDir', 'skeletonsFile'] as const;

/** Parse and validate `anim-studio.config.json`. Throws with a message that
 *  names the file, because a typo here is otherwise a blank studio. */
export function parseProjectConfig(text: string): ProjectConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`anim-studio.config.json is not valid JSON: ${String(e)}`);
  }
  const obj = raw as { projects?: unknown; active?: unknown };
  const list = Array.isArray(obj.projects) ? (obj.projects as Record<string, unknown>[]) : [];
  if (list.length === 0) throw new Error('anim-studio.config.json must list at least one project');

  const seen = new Set<string>();
  const projects: ProjectDef[] = list.map((p, i) => {
    for (const key of REQUIRED) {
      if (typeof p[key] !== 'string' || !(p[key] as string)) {
        throw new Error(`anim-studio.config.json: project #${i} is missing "${key}"`);
      }
    }
    const id = p.id as string;
    if (seen.has(id)) throw new Error(`anim-studio.config.json: duplicate project id "${id}"`);
    seen.add(id);
    return {
      id,
      name: p.name as string,
      root: p.root as string,
      publicDir: p.publicDir as string,
      skeletonsFile: p.skeletonsFile as string,
      ...(typeof p.clipsFile === 'string' && p.clipsFile ? { clipsFile: p.clipsFile } : {}),
    };
  });

  // An `active` naming nothing falls back rather than throwing: the id can go
  // stale simply by renaming a project, and a stale pointer should not be the
  // difference between a working tool and a crash on boot.
  const wanted = typeof obj.active === 'string' ? obj.active : '';
  const active = projects.some((p) => p.id === wanted) ? wanted : projects[0].id;
  return { projects, active };
}

export function projectById(cfg: ProjectConfig, id: string): ProjectDef | undefined {
  return cfg.projects.find((p) => p.id === id);
}

/**
 * Join `rel` under `rootAbs`, or null if it escapes.
 *
 * The studio serves a whole directory of somebody's checkout over HTTP on a
 * dev machine; `../../.ssh/id_rsa` must not be a valid asset path. Normalise
 * by walking the segments rather than by string-prefix comparison, which
 * `/tmp/heft-secrets` would defeat against a root of `/tmp/heft`.
 */
export function safeJoin(rootAbs: string, rel: string): string | null {
  const parts = rel.split(/[\\/]+/).filter((s) => s && s !== '.');
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(seg);
    }
  }
  const base = rootAbs.replace(/\/+$/, '');
  return out.length ? `${base}/${out.join('/')}` : base;
}
