/**
 * Sample an authored keyframe timeline at a clip-time `t` ∈ [0,1], easing
 * between keys, into a per-bone {@link Pose}. Pure leaf util (no DOM, no
 * engine imports). Used by your game to layer authored corrections over the
 * procedural pose at bake/render time, and by the studio to preview them.
 */
import type { BodyClips, ClipTimeline, Pose, BoneOffset, Ease } from './types';

function applyEase(e: Ease | undefined, u: number): number {
  switch (e) {
    case 'easeIn':
      return u * u;
    case 'easeOut':
      return 1 - (1 - u) * (1 - u);
    case 'easeInOut':
      return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    default:
      return u; // linear
  }
}

function lerp(a: number | undefined, b: number | undefined, u: number): number {
  const av = a ?? 0;
  const bv = b ?? 0;
  return av + (bv - av) * u;
}

/** The RELATIVE channels (deltas over the procedural pose) — absent = 0, so they
 *  always interpolate, to/from identity at an unauthored key. */
const REL: (keyof BoneOffset)[] = ['dAng', 'ikDx', 'ikDy'];
/** The ABSOLUTE channels (the bone's whole pose). These interpolate only when
 *  BOTH keys define them — an absolute cannot be lerped toward "unknown
 *  procedural", so a one-sided channel falls back to the procedural default for
 *  the in-between (a converted-baseline bake only ever samples exactly ON keys
 *  anyway). */
const ABS: (keyof BoneOffset)[] = ['ang', 'poke', 'flex', 'ext', 'draw', 'fx', 'fy', 'dx', 'dy', 'rot'];

function lerpOffset(a: BoneOffset, b: BoneOffset, u: number): BoneOffset {
  const out: BoneOffset = {};
  for (const ch of REL) {
    const v = lerp(a[ch], b[ch], u);
    if (v !== 0) out[ch] = v;
  }
  for (const ch of ABS) {
    const av = a[ch];
    const bv = b[ch];
    if (av !== undefined && bv !== undefined) out[ch] = av + (bv - av) * u;
  }
  return out;
}

/** Exact-key tolerance: baked frames sample the same float a capture stored,
 *  so this only needs to absorb JSON round-trip noise. */
const EPS = 1e-9;

/** Sample one clip's timeline at `t`. Keys are assumed sorted by `t`.
 *  A `t` that lands ON a key returns that key's pose verbatim (absolute channels
 *  included) — this is what makes a converted baseline replay byte-identically
 *  and an edited absolute value take effect. Between keys, every channel eases
 *  into the NEXT key (`k1.ease`). */
export function samplePose(tl: ClipTimeline | undefined, t: number): Pose | undefined {
  if (!tl || tl.keys.length === 0) return undefined;
  const keys = tl.keys;
  if (t <= keys[0].t + EPS) return keys[0].pose;
  if (t >= keys[keys.length - 1].t - EPS) return keys[keys.length - 1].pose;
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t < t - EPS) i++;
  const k1 = keys[i + 1];
  if (Math.abs(k1.t - t) <= EPS) return k1.pose; // exactly on a key
  const k0 = keys[i];
  const span = k1.t - k0.t || 1;
  const u = applyEase(k1.ease, (t - k0.t) / span);
  const out: Pose = {};
  const ids = new Set([...Object.keys(k0.pose), ...Object.keys(k1.pose)]);
  for (const id of ids) out[id] = lerpOffset(k0.pose[id] ?? {}, k1.pose[id] ?? {}, u);
  return out;
}

/** Sample a body's clip at `t`; `undefined` if the body has no authored timeline
 *  for that clip (→ the procedural default renders, byte-identical). */
export function poseForFrame(clips: BodyClips | undefined, clip: string, t: number): Pose | undefined {
  if (!clips) return undefined;
  return samplePose(clips[clip], t);
}
