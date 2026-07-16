/**
 * The rig contract — how a procedurally-drawn character becomes editable.
 *
 * Your draw code routes each limb through one of these helpers (or through
 * your own helpers that call {@link recordBone} the same way). Each helper:
 *
 *  1. self-assigns a STABLE BONE ID from its call order within a body
 *     (`arm0`, `arm1`, `leg0`, `root`, …) — so a body's skeleton is discovered
 *     from its own draw, never hand-authored, and the same draw order runs in
 *     the studio and the game, so ids agree;
 *  2. applies the sampled authored offset — an absolute channel REPLACES the
 *     procedural value (data mode: replaying a captured value is
 *     byte-identical, editing it changes the pose), a relative delta COMPOSES
 *     over either — and is the identity when nothing is authored;
 *  3. records its pivot + the live canvas transform when the studio is
 *     capturing, so a joint handle can be placed exactly on the drawn pivot.
 *
 * Everything here is plain Canvas2D — no engine dependency. A game that draws
 * through its own abstraction (like a Brush) can pass the underlying context.
 */
import type { Pose, BoneOffset } from './types';

// ---------------------------------------------------------------------------
// stable bone ids from call order
// ---------------------------------------------------------------------------
let _ord: Record<string, number> = {};

/** The next id for a bone kind (`arm` → `arm0`, `arm1`, …). */
export function nextBone(kind: string): string {
  const n = _ord[kind] ?? 0;
  _ord[kind] = n + 1;
  return `${kind}${n}`;
}

/** Reset per-body bone numbering. Call once at the START of each body draw so
 *  arm/leg ids are stable and agree between the editor and the game. */
export function resetBoneIds(): void {
  _ord = {};
}

// ---------------------------------------------------------------------------
// the record sink
// ---------------------------------------------------------------------------

/** A discovered bone: its id, pivot (local coords) + the live CTM at draw time
 *  (so the studio can place a handle at `matrix·pivot`, accounting for any
 *  root drive + frame padding), and `val` — the ABSOLUTE pose the helper
 *  computed this frame, which a convert-to-data capture stores. `end` flags an
 *  IK end-effector (a foot): its handle drags a target, not a rotation. */
export interface BoneRec {
  id: string;
  kind: string;
  pivot: [number, number];
  matrix: DOMMatrix;
  end?: boolean;
  val?: BoneOffset;
}

let _rec: BoneRec[] | null = null;

/** Begin/stop recording the bones drawn on the next body draw (the studio does
 *  this around its pose-mode render; a game render never records). */
export function beginBoneRecord(): void {
  _rec = [];
}
export function endBoneRecord(): BoneRec[] {
  const r = _rec ?? [];
  _rec = null;
  return r;
}

/** Record one drawn bone (id, local pivot, live CTM, optional captured value).
 *  No-op unless the studio is recording — free in the game's hot path. */
export function recordBone(ctx: CanvasRenderingContext2D, id: string, kind: string, px: number, py: number, end = false, val?: BoneOffset): void {
  if (_rec) _rec.push({ id, kind, pivot: [px, py], matrix: ctx.getTransform(), end, val });
}

/** Attach the captured absolute value to an already-recorded bone (e.g. a root
 *  whose transform is only known after it's computed). */
export function setBoneVal(id: string, val: BoneOffset): void {
  if (_rec) {
    const r = _rec.find((x) => x.id === id);
    if (r) r.val = val;
  }
}

// ---------------------------------------------------------------------------
// canvas rig helpers
// ---------------------------------------------------------------------------

/** Run `draw` under a rotation of `angle` rad about pivot (px,py) — the
 *  cut-and-rotate a bone does. Save/restore is balanced, so it never leaks. */
export function pivot(ctx: CanvasRenderingContext2D, px: number, py: number, angle: number, draw: () => void): void {
  if (!angle) return draw();
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(angle);
  ctx.translate(-px, -py);
  draw();
  ctx.restore();
}

/**
 * An FK bone: rotate the whole limb (draw the arm + hand + held weapon inside
 * `draw` so it moves as one rigid piece, no torn seams) about pivot (px,py).
 * `procAngle` is your procedural pose; an authored absolute `ang` replaces it,
 * a `dAng` drag delta composes over either.
 */
export function fkBone(ctx: CanvasRenderingContext2D, pose: Pose | undefined, px: number, py: number, procAngle: number, draw: () => void, kind = 'arm'): void {
  const id = nextBone(kind);
  const P = pose?.[id];
  let ang = P?.ang !== undefined ? P.ang : procAngle;
  ang += P?.dAng ?? 0;
  recordBone(ctx, id, kind, px, py, false, { ang });
  pivot(ctx, px, py, ang, draw);
}

/** Two-bone IK: the knee position for a hip→foot chain of lengths l1/l2.
 *  `bend` picks the solution side (+1 knee forward, -1 back). Out-of-reach
 *  targets clamp to a straight leg. */
export function solveKnee(hx: number, hy: number, fx: number, fy: number, l1: number, l2: number, bend = 1): [number, number] {
  let dx = fx - hx;
  let dy = fy - hy;
  let d = Math.hypot(dx, dy);
  const max = l1 + l2 - 1e-4;
  if (d > max) {
    dx *= max / d;
    dy *= max / d;
    d = max;
  }
  if (d < 1e-6) return [hx, hy + l1];
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h2 = Math.max(0, l1 * l1 - a * a);
  const h = Math.sqrt(h2);
  const mx = hx + (a * dx) / d;
  const my = hy + (a * dy) / d;
  return [mx + (bend * h * dy) / d, my - (bend * h * dx) / d];
}

/**
 * An IK leg: the FOOT is the handle. `procFx/procFy` is your procedural planted
 * target; an authored absolute `fx/fy` replaces it, an `ikDx/ikDy` drag delta
 * composes over either; the knee re-solves so feet stay planted and the
 * mid-joint bends. `draw` receives (kneeX, kneeY, footX, footY).
 */
export function ikLeg(
  ctx: CanvasRenderingContext2D,
  pose: Pose | undefined,
  hipX: number,
  hipY: number,
  procFx: number,
  procFy: number,
  l1: number,
  l2: number,
  draw: (kx: number, ky: number, fx: number, fy: number) => void,
  opts: { kind?: string; bend?: number } = {},
): void {
  const id = nextBone(opts.kind ?? 'leg');
  const P = pose?.[id];
  let fx = P?.fx !== undefined ? P.fx : procFx;
  let fy = P?.fy !== undefined ? P.fy : procFy;
  fx += P?.ikDx ?? 0;
  fy += P?.ikDy ?? 0;
  const [kx, ky] = solveKnee(hipX, hipY, fx, fy, l1, l2, opts.bend ?? 1);
  recordBone(ctx, id, opts.kind ?? 'leg', fx, fy, true, { fx, fy });
  draw(kx, ky, fx, fy);
}

/**
 * The body root: a whole-body translate + rotate about (px,py) that everything
 * else rides (call it OUTERMOST, and draw all other bones inside `draw`).
 * Resets bone numbering, so per-body ids are stable. Authored absolute
 * `dx/dy/rot` replace the procedural drive; a `dAng` drag delta composes onto
 * the rotation.
 */
export function rootBone(
  ctx: CanvasRenderingContext2D,
  pose: Pose | undefined,
  px: number,
  py: number,
  proc: { dx?: number; dy?: number; rot?: number },
  draw: () => void,
): void {
  resetBoneIds();
  const P = pose?.['root'];
  const dx = P?.dx !== undefined ? P.dx : (proc.dx ?? 0);
  const dy = P?.dy !== undefined ? P.dy : (proc.dy ?? 0);
  let rot = P?.rot !== undefined ? P.rot : (proc.rot ?? 0);
  rot += P?.dAng ?? 0;
  ctx.save();
  ctx.translate(dx, dy);
  recordBone(ctx, 'root', 'root', px, py, false, { dx, dy, rot });
  if (rot) {
    ctx.translate(px, py);
    ctx.rotate(rot);
    ctx.translate(-px, -py);
  }
  draw();
  ctx.restore();
}

/** Screen position of a recorded bone's pivot: apply its captured CTM (→ frame
 *  px), then the display transform (offset + scale). */
export function boneScreen(bone: BoneRec, dx: number, dy: number, scale: number): { x: number; y: number } {
  const p = bone.matrix.transformPoint(new DOMPoint(bone.pivot[0], bone.pivot[1]));
  return { x: dx + p.x * scale, y: dy + p.y * scale };
}
