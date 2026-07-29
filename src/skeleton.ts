/**
 * Assembled characters — the skeleton document format and its pure edit
 * operations. An assembled character is built in the studio's Assemble mode:
 * imported images become bones, bones parent into a rig, and the character
 * joins the roster as a poseable body whose clips are user-defined.
 *
 * Unlike a procedural body (whose skeleton is discovered from its draw), an
 * assembled skeleton IS the source of truth: bone ids are explicit, unique,
 * user-named, and stable — renaming a bone rewrites its authored keys so data
 * never detaches. The document carries its own clips and timelines, so one
 * character is one self-contained, diffable JSON unit.
 *
 * Pure leaf module: no DOM, no engine — node-testable. Canvas rendering lives
 * in skeleton-render.ts.
 */
import type { BodyClips, BoneOffset, Pose } from './types';
import { prunedClips } from './timeline.ts';
import { stableClips } from './emit.ts';

// ---------------------------------------------------------------------------
// 2D affine math ([a,b,c,d,e,f] — canvas order: x' = a·x + c·y + e)
// ---------------------------------------------------------------------------
export type Mat2D = [number, number, number, number, number, number];

export const MAT_IDENTITY: Mat2D = [1, 0, 0, 1, 0, 0];

/** A·B — apply B first, then A (world = parent · local). */
export function matMul(m: Mat2D, n: Mat2D): Mat2D {
  const [a, b, c, d, e, f] = m;
  const [a2, b2, c2, d2, e2, f2] = n;
  return [a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f];
}

export function matApply(m: Mat2D, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function matInvert(m: Mat2D): Mat2D {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1e-12;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** Translate·Rotate·Scale, the local transform of a bone. */
export function composeTRS(x: number, y: number, rot: number, sx: number, sy: number): Mat2D {
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return [cos * sx, sin * sx, -sin * sy, cos * sy, x, y];
}

/** Recover x/y/rot/sx/sy from a (skew-free) affine matrix — used to preserve a
 *  bone's world placement when reparenting. */
export function decomposeTRS(m: Mat2D): { x: number; y: number; rot: number; sx: number; sy: number } {
  const [a, b, c, d, e, f] = m;
  const sx = Math.hypot(a, b) || 1e-9;
  const sy = (a * d - b * c) / sx;
  return { x: e, y: f, rot: Math.atan2(b, a), sx, sy };
}

// ---------------------------------------------------------------------------
// the document
// ---------------------------------------------------------------------------

/** An image part attached to a bone, drawn centred at (ax,ay) in bone space. */
export interface SkelAttachment {
  /** Image source (data URI once imported, so the doc is self-contained). */
  src: string;
  /** Natural pixel size of the image. */
  w: number;
  h: number;
  /** Offset of the image centre from the bone pivot, in bone space. */
  ax: number;
  ay: number;
  /** Rotation (rad) of the image about its centre, in bone space. */
  rot: number;
  /** Scale of the image in bone space. */
  sx: number;
  sy: number;
}

/** How a bone's joint may move in Animate mode:
 *  - `free`  rotates without limits (the default);
 *  - `hinge` rotation clamps to [min,max] rad around the bind rotation;
 *  - `fixed` ignores rotation edits entirely (welded). */
export type JointType = 'free' | 'hinge' | 'fixed';

export interface SkelJoint {
  type: JointType;
  /** Hinge limits in rad, relative to the bind rotation (min ≤ 0 ≤ max). */
  min: number;
  max: number;
}

/** One bone. `id` is the stable identity authored keyframes key on — unique
 *  within the doc, user-renamable via {@link renameBone} (which rewrites the
 *  keys so data never detaches). */
export interface SkelBone {
  id: string;
  /** Parent bone id; `null` = attached to the canvas origin. */
  parent: string | null;
  /** Pivot position in parent space (canvas px at the root). */
  x: number;
  y: number;
  /** Bind rotation (rad) / scale — what Assemble mode edits. */
  rot: number;
  sx: number;
  sy: number;
  /** Display length of the bone widget (px, bone space). */
  len: number;
  /** Draw order — lower draws first (further back). */
  z: number;
  joint: SkelJoint;
  img?: SkelAttachment;
}

/** A user-defined clip: `key` is the stable timeline id, `name` the renamable
 *  display label, `frames` × `per` (ms) the sampling grid. */
export interface SkelClip {
  key: string;
  name: string;
  frames: number;
  per: number;
}

/** One assembled character — self-contained: rig, clips, and authored
 *  timelines travel together. `timelines` is the SAME live object the studio
 *  injects into its clip store at `sk:<id>`, so animate-mode edits land here
 *  and persist with the doc. */
export interface SkeletonDoc {
  id: string;
  name: string;
  /** Frame (canvas) size of the character. */
  fw: number;
  fh: number;
  bones: SkelBone[];
  clips: SkelClip[];
  timelines: BodyClips;
}

/** The persisted file: every assembled character, keyed by doc id. */
export interface SkeletonFile {
  version: 1;
  skeletons: Record<string, SkeletonDoc>;
}

/** Store-key prefix separating assembled bodies from the host game's bodies —
 *  `sk:*` timelines are managed with the skeleton file, never written into the
 *  game's clips file. */
export const SKEL_PREFIX = 'sk:';
export const skelBodyId = (doc: SkeletonDoc): string => SKEL_PREFIX + doc.id;
export const isSkelBodyId = (bodyId: string): boolean => bodyId.startsWith(SKEL_PREFIX);

// ---------------------------------------------------------------------------
// ids + naming
// ---------------------------------------------------------------------------
const slug = (s: string, fallback: string): string => {
  const t = s.trim().replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '');
  return t || fallback;
};

export function uniqueSkelId(taken: string[], name: string): string {
  const base = slug(name, 'character').toLowerCase();
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(base + n)) n++;
  return base + n;
}

export function uniqueBoneId(doc: SkeletonDoc, name: string, ignore?: string): string {
  const base = slug(name, 'bone');
  const taken = new Set(doc.bones.filter((b) => b.id !== ignore).map((b) => b.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(base + n)) n++;
  return base + n;
}

export function uniqueClipKey(doc: SkeletonDoc, name: string): string {
  const base = slug(name, 'clip').toLowerCase();
  const taken = new Set(doc.clips.map((c) => c.key));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(base + n)) n++;
  return base + n;
}

// ---------------------------------------------------------------------------
// document + bone ops (all mutate the doc in place, like timeline.ts)
// ---------------------------------------------------------------------------

export function createSkeleton(id: string, name: string, fw = 192, fh = 192): SkeletonDoc {
  const doc: SkeletonDoc = { id, name, fw, fh, bones: [], clips: [], timelines: {} };
  doc.bones.push({
    id: 'root',
    parent: null,
    x: Math.round(fw / 2),
    y: Math.round(fh * 0.55),
    rot: 0,
    sx: 1,
    sy: 1,
    len: 14,
    z: 0,
    joint: { type: 'free', min: 0, max: 0 },
  });
  addClip(doc, 'idle', 8, 120);
  return doc;
}

export const boneById = (doc: SkeletonDoc, id: string): SkelBone | undefined => doc.bones.find((b) => b.id === id);

export interface AddBoneOpts {
  name?: string;
  parent?: string | null;
  x?: number;
  y?: number;
  rot?: number;
  sx?: number;
  sy?: number;
  len?: number;
  img?: SkelAttachment;
}

export function addBone(doc: SkeletonDoc, opts: AddBoneOpts = {}): SkelBone {
  const parent = opts.parent !== undefined ? opts.parent : (boneById(doc, 'root') ? 'root' : null);
  const bone: SkelBone = {
    id: uniqueBoneId(doc, opts.name ?? 'bone'),
    parent: parent && boneById(doc, parent) ? parent : null,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    rot: opts.rot ?? 0,
    sx: opts.sx ?? 1,
    sy: opts.sy ?? 1,
    len: opts.len ?? 14,
    z: doc.bones.reduce((m, b) => Math.max(m, b.z), -1) + 1,
    joint: { type: 'free', min: 0, max: 0 },
    img: opts.img,
  };
  doc.bones.push(bone);
  return bone;
}

/** All ids in the subtree under `id` (excluding `id` itself). */
export function descendants(doc: SkeletonDoc, id: string): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of doc.bones) {
      if (out.has(b.id) || b.id === id) continue;
      if (b.parent === id || (b.parent && out.has(b.parent))) {
        out.add(b.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Remove a bone AND its subtree; authored keys for the removed bones are
 *  stripped from every timeline so the doc stays consistent. Returns the
 *  removed ids (empty when the bone doesn't exist). */
export function removeBone(doc: SkeletonDoc, id: string): string[] {
  if (!boneById(doc, id)) return [];
  const gone = descendants(doc, id);
  gone.add(id);
  doc.bones = doc.bones.filter((b) => !gone.has(b.id));
  for (const tl of Object.values(doc.timelines)) {
    for (const k of tl.keys) for (const bid of gone) delete k.pose[bid];
  }
  return [...gone];
}

/** Rename a bone, keeping authored keys attached (their pose maps are rewritten
 *  to the new id). Returns the final (unique-ified) id. */
export function renameBone(doc: SkeletonDoc, id: string, name: string): string {
  const bone = boneById(doc, id);
  if (!bone) return id;
  const next = uniqueBoneId(doc, name, id);
  if (next === id) return id;
  bone.id = next;
  for (const b of doc.bones) if (b.parent === id) b.parent = next;
  for (const tl of Object.values(doc.timelines)) {
    for (const k of tl.keys) {
      if (k.pose[id]) {
        k.pose[next] = k.pose[id];
        delete k.pose[id];
      }
    }
  }
  return next;
}

/** Reparent a bone (cycle-guarded), preserving its WORLD placement — the bone
 *  stays put on canvas; only the hierarchy changes. Returns false on a cycle
 *  or unknown ids. */
export function reparentBone(doc: SkeletonDoc, id: string, parent: string | null): boolean {
  const bone = boneById(doc, id);
  if (!bone) return false;
  if (parent !== null) {
    if (parent === id || !boneById(doc, parent) || descendants(doc, id).has(parent)) return false;
  }
  const worlds = worldTransforms(doc);
  const world = worlds.get(id) ?? MAT_IDENTITY;
  const pw = parent ? (worlds.get(parent) ?? MAT_IDENTITY) : MAT_IDENTITY;
  const local = decomposeTRS(matMul(matInvert(pw), world));
  bone.parent = parent;
  bone.x = local.x;
  bone.y = local.y;
  bone.rot = local.rot;
  bone.sx = local.sx;
  bone.sy = local.sy;
  return true;
}

/** Bones in draw order (back → front). Stable: ties break by id. */
export function bonesByZ(doc: SkeletonDoc): SkelBone[] {
  return [...doc.bones].sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1));
}

/** Nudge a bone one step forward (+1) or back (-1) in draw order. */
export function moveBoneZ(doc: SkeletonDoc, id: string, dir: 1 | -1): boolean {
  const order = bonesByZ(doc);
  const i = order.findIndex((b) => b.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return false;
  const a = order[i].z;
  order[i].z = order[j].z;
  order[j].z = a;
  return true;
}

// ---------------------------------------------------------------------------
// transforms + pose
// ---------------------------------------------------------------------------

/** The rotation delta a joint actually allows (hinge clamps, fixed welds). */
export function clampJointAngle(bone: SkelBone, dAng: number): number {
  const j = bone.joint;
  if (j.type === 'fixed') return 0;
  if (j.type === 'hinge') return Math.min(j.max, Math.max(j.min, dAng));
  return dAng;
}

/** A bone's local transform under an (optional) authored offset. Skeleton
 *  bones use the RELATIVE channels: `dAng` rotates about the joint (subject to
 *  its limits), `ikDx/ikDy` translate in parent space. Scale is bind-only —
 *  assembly data, not animation data. */
export function boneLocal(bone: SkelBone, off?: BoneOffset): Mat2D {
  const dAng = clampJointAngle(bone, off?.dAng ?? 0);
  return composeTRS(bone.x + (off?.ikDx ?? 0), bone.y + (off?.ikDy ?? 0), bone.rot + dAng, bone.sx, bone.sy);
}

/** World transform of every bone under `pose` (cycle-safe: a corrupt parent
 *  loop breaks at the revisit rather than recursing forever). */
export function worldTransforms(doc: SkeletonDoc, pose?: Pose): Map<string, Mat2D> {
  const out = new Map<string, Mat2D>();
  const byId = new Map(doc.bones.map((b) => [b.id, b]));
  const visiting = new Set<string>();
  const resolve = (b: SkelBone): Mat2D => {
    const got = out.get(b.id);
    if (got) return got;
    const local = boneLocal(b, pose?.[b.id]);
    let world = local;
    if (b.parent && !visiting.has(b.id)) {
      visiting.add(b.id);
      const p = byId.get(b.parent);
      if (p) world = matMul(resolve(p), local);
      visiting.delete(b.id);
    }
    out.set(b.id, world);
    return world;
  };
  for (const b of doc.bones) resolve(b);
  return out;
}

// ---------------------------------------------------------------------------
// clip ops
// ---------------------------------------------------------------------------

export function addClip(doc: SkeletonDoc, name: string, frames = 8, per = 120): SkelClip {
  const clip: SkelClip = { key: uniqueClipKey(doc, name), name: name.trim() || 'clip', frames: clampFrames(frames), per: clampPer(per) };
  doc.clips.push(clip);
  return clip;
}

export function renameClip(doc: SkeletonDoc, key: string, name: string): boolean {
  const c = doc.clips.find((x) => x.key === key);
  if (!c || !name.trim()) return false;
  c.name = name.trim();
  return true;
}

/** Remove a clip and its timeline. The last clip can't be removed — a body
 *  always has something to play. */
export function removeClip(doc: SkeletonDoc, key: string): boolean {
  if (doc.clips.length <= 1) return false;
  const i = doc.clips.findIndex((x) => x.key === key);
  if (i < 0) return false;
  doc.clips.splice(i, 1);
  delete doc.timelines[key];
  return true;
}

/** Duplicate a clip INCLUDING its authored timeline (deep copy). */
export function duplicateClip(doc: SkeletonDoc, key: string): SkelClip | null {
  const c = doc.clips.find((x) => x.key === key);
  if (!c) return null;
  const copy = addClip(doc, c.name + ' copy', c.frames, c.per);
  const tl = doc.timelines[key];
  if (tl) doc.timelines[copy.key] = JSON.parse(JSON.stringify(tl)) as BodyClips[string];
  return copy;
}

const clampFrames = (n: number): number => Math.max(1, Math.min(120, Math.round(n) || 1));
const clampPer = (n: number): number => Math.max(16, Math.min(2000, Math.round(n) || 120));

export function patchClip(doc: SkeletonDoc, key: string, patch: { frames?: number; per?: number }): boolean {
  const c = doc.clips.find((x) => x.key === key);
  if (!c) return false;
  if (patch.frames !== undefined) c.frames = clampFrames(patch.frames);
  if (patch.per !== undefined) c.per = clampPer(patch.per);
  return true;
}

// ---------------------------------------------------------------------------
// snapshots (undo/redo)
// ---------------------------------------------------------------------------

/** Snapshot a doc for an undo entry. */
export const snapshotDoc = (doc: SkeletonDoc): string => JSON.stringify(doc);

/** Restore a snapshot IN PLACE — doc identity and (crucially) the `timelines`
 *  object reference survive, since the live clip store aliases it. */
export function restoreDoc(doc: SkeletonDoc, snap: string): void {
  const s = JSON.parse(snap) as SkeletonDoc;
  doc.name = s.name;
  doc.fw = s.fw;
  doc.fh = s.fh;
  doc.bones = s.bones;
  doc.clips = s.clips;
  for (const k of Object.keys(doc.timelines)) delete doc.timelines[k];
  Object.assign(doc.timelines, s.timelines);
}

// ---------------------------------------------------------------------------
// (de)serialisation — canonical and diff-stable, like emit.ts
// ---------------------------------------------------------------------------

/** Serialise every doc into the skeleton-file JSON: deep-sorted keys, bones
 *  sorted by id, timelines pruned of empties — a one-bone edit diffs small. */
export function packSkeletons(docs: SkeletonDoc[]): string {
  const skeletons: Record<string, unknown> = {};
  for (const doc of docs) {
    skeletons[doc.id] = {
      ...doc,
      bones: bonesByZ(doc),
      clips: doc.clips, // array order = the user's tab order; keep it
      timelines: prunedClips({ [doc.id]: doc.timelines })[doc.id] ?? {},
    };
  }
  return JSON.stringify(stableClips({ version: 1, skeletons }), null, 0) + '\n';
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string): string => (typeof v === 'string' && v ? v : d);

function normaliseBone(raw: Record<string, unknown>, i: number): SkelBone {
  const jointRaw = (raw.joint ?? {}) as Record<string, unknown>;
  const type = jointRaw.type === 'hinge' || jointRaw.type === 'fixed' ? jointRaw.type : 'free';
  const img = raw.img as Record<string, unknown> | undefined;
  return {
    id: str(raw.id, `bone${i}`),
    parent: typeof raw.parent === 'string' ? raw.parent : null,
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    rot: num(raw.rot, 0),
    sx: num(raw.sx, 1),
    sy: num(raw.sy, 1),
    len: num(raw.len, 14),
    z: num(raw.z, i),
    joint: { type, min: num(jointRaw.min, 0), max: num(jointRaw.max, 0) },
    img:
      img && typeof img.src === 'string'
        ? { src: img.src, w: num(img.w, 1), h: num(img.h, 1), ax: num(img.ax, 0), ay: num(img.ay, 0), rot: num(img.rot, 0), sx: num(img.sx, 1), sy: num(img.sy, 1) }
        : undefined,
  };
}

/** Parse a skeleton file defensively: defaults are filled, unknown parents are
 *  cleared, and a doc always ends up with ≥1 clip — so a hand-edited file
 *  loads rather than wedging the studio. Throws only on invalid JSON. */
export function unpackSkeletons(text: string): SkeletonDoc[] {
  const root = JSON.parse(text || '{}') as Record<string, unknown>;
  const skeletons = (root.skeletons ?? {}) as Record<string, Record<string, unknown>>;
  const docs: SkeletonDoc[] = [];
  for (const [id, raw] of Object.entries(skeletons)) {
    const bonesRaw = Array.isArray(raw.bones) ? (raw.bones as Record<string, unknown>[]) : [];
    const clipsRaw = Array.isArray(raw.clips) ? (raw.clips as Record<string, unknown>[]) : [];
    const doc: SkeletonDoc = {
      id,
      name: str(raw.name, id),
      fw: Math.max(32, Math.min(1024, num(raw.fw, 192))),
      fh: Math.max(32, Math.min(1024, num(raw.fh, 192))),
      bones: bonesRaw.map(normaliseBone),
      clips: clipsRaw.map((c, i) => ({
        key: str(c.key, `clip${i}`),
        name: str(c.name, str(c.key, `clip ${i + 1}`)),
        frames: clampFrames(num(c.frames, 8)),
        per: clampPer(num(c.per, 120)),
      })),
      timelines: (raw.timelines && typeof raw.timelines === 'object' ? raw.timelines : {}) as BodyClips,
    };
    const ids = new Set(doc.bones.map((b) => b.id));
    for (const b of doc.bones) if (b.parent && !ids.has(b.parent)) b.parent = null;
    if (!doc.clips.length) addClip(doc, 'idle');
    docs.push(doc);
  }
  return docs;
}
