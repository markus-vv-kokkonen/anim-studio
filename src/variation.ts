/**
 * Per-cycle random variation — the layer that keeps a repeating animation from
 * playing byte-identically forever: a swing that sometimes falls short of full
 * extension and sometimes overshoots, a loop that runs a touch fast or slow,
 * copies of one body drifting out of lockstep.
 *
 * Three properties make it safe to ship:
 *
 *  1. **Sampling-time, never baked.** The authored keys stay exact; variation
 *     is a function applied when a pose is sampled. Turning it off restores
 *     the authored motion byte-for-byte.
 *  2. **Deterministic.** Values come from a hash of (seed, cycle, bone), not
 *     `Math.random()`, so a replay, a bake, and the studio preview all agree —
 *     and a bug is reproducible.
 *  3. **Inert until configured.** No `variation` (or all-zero amounts) → the
 *     sampled pose is returned untouched.
 *
 * Amounts are drawn once per LOOP CYCLE and held constant through it, so a
 * single playthrough stays smooth; a clip that starts and ends at rest loops
 * seamlessly, because scaling a zero-magnitude pose changes nothing.
 *
 * Pure leaf module (no DOM, no engine) — the game imports it exactly like
 * `sample.ts`.
 */
import type { BoneOffset, ClipTimeline, ClipVariation, Pose } from './types';
import { samplePose } from './sample.ts';

// ---------------------------------------------------------------------------
// deterministic noise
// ---------------------------------------------------------------------------

/** FNV-1a over a string → uint32; how a bone id becomes part of the seed. */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Integer hash → a stable float in [0,1) (no state, no sequencing). */
function hash01(n: number): number {
  let h = n >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A signed unit sample in [-1,1] for one (seed, cycle, channel) triple. */
function signed(seed: number, cycle: number, channel: number): number {
  return hash01(Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(cycle + 1, 0xc2b2ae35) ^ Math.imul(channel + 1, 0x27d4eb2f)) * 2 - 1;
}

// ---------------------------------------------------------------------------
// per-cycle state
// ---------------------------------------------------------------------------

/** The variation drawn for one loop cycle. `speed` is for the HOST's clock
 *  (multiply your per-cycle advance by it); `phase` and the amplitudes are
 *  applied by {@link samplePoseVaried}. */
export interface VariationState {
  /** Playback rate multiplier for this cycle (1 = as authored). */
  speed: number;
  /** Clip-time offset for this cycle, wrapped into [0,1). */
  phase: number;
  /** Amplitude multiplier for a bone this cycle (1 = as authored). */
  ampFor(boneId: string): number;
  /** True when nothing would change (all amounts zero/absent). */
  identity: boolean;
}

const IDENTITY: VariationState = { speed: 1, phase: 0, ampFor: () => 1, identity: true };

const isOff = (v: ClipVariation | undefined): boolean =>
  !v || (!(v.amp ?? 0) && !(v.speed ?? 0) && !(v.phase ?? 0));

/**
 * Draw the variation for one loop `cycle`. `extraSeed` is the host's
 * per-instance seed (an entity id, say) so two copies of the same body vary
 * differently; omit it and every instance shares one sequence.
 */
export function variationFor(v: ClipVariation | undefined, cycle: number, extraSeed = 0): VariationState {
  if (isOff(v)) return IDENTITY;
  const cfg = v!;
  const seed = ((cfg.seed ?? 0) ^ extraSeed) >>> 0;
  const amp = cfg.amp ?? 0;
  const speed = 1 + signed(seed, cycle, 1) * (cfg.speed ?? 0);
  const rawPhase = signed(seed, cycle, 2) * (cfg.phase ?? 0);
  const phase = ((rawPhase % 1) + 1) % 1;
  const weights = cfg.bones;
  return {
    speed: speed > 0.05 ? speed : 0.05,
    phase,
    identity: false,
    ampFor(boneId: string): number {
      const w = weights?.[boneId] ?? 1;
      if (!amp || !w) return 1;
      return 1 + signed(seed ^ hashStr(boneId), cycle, 3) * amp * w;
    },
  };
}

// ---------------------------------------------------------------------------
// applying it to a pose
// ---------------------------------------------------------------------------

/** Deltas over the procedural/bind pose — scaling these IS "travel less/more". */
const REL: (keyof BoneOffset)[] = ['dAng', 'ikDx', 'ikDy'];
/** Absolute channels: scaled about an anchor (the clip's first authored value
 *  for that bone/channel), so "85%" means 85% of the way from the clip's
 *  starting pose — scaling them raw would drag the bone toward the origin. */
const ABS: (keyof BoneOffset)[] = ['ang', 'poke', 'flex', 'ext', 'draw', 'fx', 'fy', 'dx', 'dy', 'rot'];

/** The first key's pose — the anchor absolute channels scale about. */
function anchorPose(tl: ClipTimeline): Pose | undefined {
  return tl.keys[0]?.pose;
}

/** Scale one bone's offset by `k` about `anchor`. Returns a NEW offset; the
 *  authored key objects are never mutated. */
function scaleOffset(off: BoneOffset, k: number, anchor: BoneOffset | undefined): BoneOffset {
  if (k === 1) return off;
  const out: BoneOffset = { ...off };
  for (const ch of REL) {
    const v = off[ch];
    if (v !== undefined) out[ch] = v * k;
  }
  for (const ch of ABS) {
    const v = off[ch];
    const a = anchor?.[ch];
    if (v !== undefined && a !== undefined) out[ch] = a + (v - a) * k;
  }
  return out;
}

/** Apply a drawn {@link VariationState} to an already-sampled pose. */
export function applyVariation(pose: Pose | undefined, state: VariationState, anchor?: Pose): Pose | undefined {
  if (!pose || state.identity) return pose;
  const out: Pose = {};
  for (const id of Object.keys(pose)) out[id] = scaleOffset(pose[id], state.ampFor(id), anchor?.[id]);
  return out;
}

/** Wrap a clip-time by the cycle's phase offset (loops stay in [0,1]). */
export const warpTime = (t: number, state: VariationState): number => (state.phase ? (t + state.phase) % 1 : t);

/**
 * Sample a timeline at `t` WITH this cycle's variation applied — the drop-in
 * replacement for {@link samplePose} in a host that wants varied loops:
 *
 * ```ts
 * const cycle = Math.floor(elapsedMs / clipMs);
 * const pose = samplePoseVaried(tl, t, cycle, entityId);
 * ```
 *
 * With no `variation` configured this is exactly `samplePose(tl, t)`.
 */
export function samplePoseVaried(tl: ClipTimeline | undefined, t: number, cycle = 0, extraSeed = 0): Pose | undefined {
  if (!tl) return undefined;
  const state = variationFor(tl.variation, cycle, extraSeed);
  if (state.identity) return samplePose(tl, t);
  return applyVariation(samplePose(tl, warpTime(t, state)), state, anchorPose(tl));
}
