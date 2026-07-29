/**
 * The stored animation format — what the studio reads and writes, and what
 * your game samples at bake/render time.
 *
 * A character's motion has two layers:
 *  1. the procedural DEFAULT computed by your pose code — unchanged,
 *     byte-identical, the free motion the whole cast gets; and
 *  2. an optional authored KEYFRAME TIMELINE per (body, clip) that layers
 *     hand-posed corrections on top (drag a joint → an offset at that time).
 *     Absent → the procedural default renders exactly as before.
 *
 * This is a pure leaf module: it imports nothing, so game systems can import
 * it without a cycle.
 */

/** Interpolation into a keyframe — how the pose is reached, time-wise. */
export type Ease = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

/**
 * A per-bone pose at one instant. Two ways to specify it:
 *
 *  ABSOLUTE (what a convert-to-data capture writes — the bone's whole pose, so
 *  the data fully defines the motion and editing a value edits the animation
 *  directly):
 *   - `ang`   FK bone absolute rotation (rad) — arms, held weapons.
 *   - `poke`  weapon-arm forward extension (thrust/jab), 0 = none.
 *   - `flex`  second-bone elbow flex (rad) for a two-bone FK limb.
 *   - `ext`   weapon slide through the grip (px), 0 = none.
 *   - `draw`  bowstring-style draw, 0 (slack) .. 1 (full).
 *   - `fx/fy` IK leg absolute foot target (frame px) — the knee re-solves.
 *   - `dx/dy/rot` root absolute whole-body transform (px, px, rad).
 *  When an absolute field is present the rig helper USES it and skips its own
 *  procedural computation for that bone (so replaying a captured value is
 *  byte-identical to the procedural render, and editing it changes the pose).
 *
 *  RELATIVE (a delta ADDED on top of the procedural pose — what an interactive
 *  drag in the studio writes):
 *   - `dAng`  FK rotation delta (rad).
 *   - `ikDx/ikDy`  IK foot-target delta (frame px).
 * Every field defaults to 0/absent, so an empty pose is the identity.
 */
export interface BoneOffset {
  // absolute
  ang?: number;
  poke?: number;
  flex?: number;
  ext?: number;
  draw?: number;
  fx?: number;
  fy?: number;
  dx?: number;
  dy?: number;
  rot?: number;
  // relative
  dAng?: number;
  ikDx?: number;
  ikDy?: number;
}

/** boneId (e.g. `arm0`, `leg1`, `root`) → its pose at one instant. */
export type Pose = Record<string, BoneOffset>;

/** One authored key: a full pose at clip-time `t` ∈ [0,1], eased into. */
export interface Keyframe {
  t: number;
  ease?: Ease;
  pose: Pose;
}

/**
 * Optional per-clip RANDOM VARIATION — the "don't play it identically every
 * loop" layer. It is applied at SAMPLING time from a deterministic seed, never
 * baked into the keys: the authored data stays exact, and a given
 * (seed, cycle) always reproduces the same variation. Absent (or all-zero) →
 * every cycle plays the authored motion exactly, so this is inert until
 * configured.
 *
 * Amounts are fractions (0.15 = ±15%), drawn fresh per LOOP CYCLE — constant
 * within a cycle, so one playthrough stays smooth.
 */
export interface ClipVariation {
  /** ± amplitude jitter: how far the motion actually travels. 0.15 means a
   *  swing lands anywhere from 85% (falls short) to 115% (overshoots) of the
   *  authored pose. Drawn per bone, so limbs vary independently. */
  amp?: number;
  /** ± playback-speed jitter per cycle (0.1 = ±10% faster/slower). The host
   *  applies it to its clock; {@link VariationState.speed} carries the value. */
  speed?: number;
  /** ± clip-time phase offset per cycle (wraps), so looping bodies drift out
   *  of lockstep with each other instead of marching in sync. */
  phase?: number;
  /** Per-bone amplitude weights (default 1). `{ root: 0.2 }` keeps the body
   *  steady while the limbs vary; `0` pins a bone to its authored pose. */
  bones?: Record<string, number>;
  /** Base seed. Change it for a different (still repeatable) variation set;
   *  hosts add their own per-instance seed on top so two on-screen copies of
   *  the same body don't move identically. */
  seed?: number;
}

/** An authored timeline for one clip of one body. `duration` (ms) is meant for
 *  PRESENTATION clips (idle / walk / hit): the host re-times the whole clip
 *  over `duration` with uniform per-frame time. Attack clips should ignore it —
 *  their tempo is combat data (wind-up / active windows), applied at play time,
 *  so authored data can never move a hazard beat. Absent → the host's default
 *  frame rates. */
export interface ClipTimeline {
  duration?: number;
  keys: Keyframe[];
  /** Optional per-cycle randomisation (see {@link ClipVariation}). Absent →
   *  the clip replays exactly as authored, every cycle. */
  variation?: ClipVariation;
}

/** Clip id — whatever your game bakes, e.g. `idle|walk|attack|hit`. */
export type ClipId = string;

/** All authored clips for one body, keyed by clip id. */
export type BodyClips = Record<ClipId, ClipTimeline>;

/** The whole authored store: bodyId → its clips. This is the object the studio
 *  edits in place and the Save endpoint persists. */
export type ClipStore = Record<string, BodyClips>;

/** Coarse per-body motion multipliers/offsets over the procedural default —
 *  the "make this body's whole motion a bit more/less" knobs. Identity = all
 *  1 / 0, so an absent override changes nothing. Reserved in the stored format
 *  for hosts that want cast-wide feel sliders. */
export interface MotionOverride {
  swingAmp?: number; // × the weapon-arm swing arc
  strideLen?: number; // × leg fore/aft travel
  strideLift?: number; // × foot lift
  coilAmt?: number; // × whole-body coil/lunge
  pitchAmt?: number; // × whole-body pitch into the blow
}
