# The stored format, sampling, and authoring

Contents:
1. [The stored format](#1-the-stored-format)
2. [Bone channels (absolute vs relative)](#2-bone-channels)
3. [Sampling semantics](#3-sampling-semantics) — the rules, with worked examples
4. [Easing](#4-easing)
5. [Ways to author or edit](#5-ways-to-author-or-edit) — studio, hook, ops, by hand
6. [Keeping edits diff-stable](#6-keeping-edits-diff-stable)
7. [MotionOverride](#7-motionoverride)
8. [Assembled characters (the skeleton file)](#8-assembled-characters)
9. [Per-clip variation](#9-per-clip-variation)

---

## 1. The stored format

```
ClipStore:    bodyId → BodyClips
BodyClips:    clipId → ClipTimeline
ClipTimeline: { duration?: number; keys: Keyframe[]; variation?: ClipVariation }
Keyframe:     { t: number; ease?: Ease; pose: Pose }
Pose:         boneId → BoneOffset          // e.g. { arm1: { dAng: 0.7 }, root: { dx: 2 } }
```

- `bodyId` is whatever key the adapter's `bake()` returns (e.g. `scout:staff`);
  `clipId` is whatever the game bakes (`idle` | `walk` | `attack` | `hit` | …).
- `t ∈ [0,1]` is clip-time. `duration` (ms) re-times **presentation** clips only
  and only when the `ClipDef` is `retimable` (see rule 5 in SKILL.md).
- **A body absent from the store, or a clip with no keys, renders the procedural
  default** — nothing in this file is required; it is a pure overlay.

The file on disk (`clips.ts`) is a generated banner + `import type` + one compact
literal per export. It is written by Save; treat it as generated (§6).

---

## 2. Bone channels

A `BoneOffset` is a bag of optional numeric channels. Presence matters: an absent
channel means "don't touch this axis," which is *not* the same as `0`.

**Absolute** — the bone's *whole* pose on that axis. When present, the rig helper
**uses it and skips its own procedural computation** for that axis. So replaying
a captured absolute is byte-identical to the procedural render, and editing the
number edits the animation directly.

| Channel | Meaning |
|---------|---------|
| `ang` | FK bone absolute rotation (rad) — arms, held weapons |
| `poke` | weapon-arm forward extension (thrust/jab); 0 = none |
| `flex` | second-bone elbow flex (rad) for a two-bone FK limb |
| `ext` | weapon slide through the grip (px); 0 = none |
| `draw` | bowstring-style draw, 0 (slack) … 1 (full) |
| `fx` / `fy` | IK leg absolute foot target (frame px) — the knee re-solves |
| `dx` / `dy` / `rot` | root absolute whole-body transform (px, px, rad) |

**Relative** — a delta *added on top* of the procedural (or absolute) pose. This
is what an interactive drag writes.

| Channel | Meaning |
|---------|---------|
| `dAng` | FK rotation delta (rad); also composes onto the root's rotation |
| `ikDx` / `ikDy` | IK foot-target delta (frame px) |

Which one to reach for: **drags and small hand-tuned nudges → relative**
(compose cleanly over whatever the procedural motion does, interpolate to/from 0
at unauthored ends). **A converted baseline or "the bone is exactly here"
authoring → absolute** (byte-identical replay; directly editable). Note the rig
maps a leg *drag* to `ikDx/ikDy` and a captured leg to `fx/fy`; an FK arm drag to
`dAng` and a captured arm to `ang`. Mixing kinds on one bone across two keys has
consequences — see the one-sided rule below.

---

## 3. Sampling semantics

`samplePose(tl, t)` / `poseForFrame(clips, clip, t)` in `src/sample.ts` are shared
by the game and the studio, so what you read here is exactly what renders. Keys
are assumed **sorted by `t`**. Three rules:

**Rule A — on a key, the pose is returned verbatim.** Every channel, absolute
included, no lerp. (Tolerance `EPS = 1e-9`, just enough to absorb JSON
round-trip noise.) This is the mechanism behind byte-identical baseline replay.

```
keys: [ {t:0, {arm0:{ang:0}}}, {t:0.5, POSE}, {t:1, {arm0:{ang:0}}} ]
samplePose(tl, 0.5) === POSE     // the same object, not a copy or a lerp
```

**Rule B — before the first / after the last key, clamp to that key.**

```
keys: [ {t:0.25, {arm0:{dAng:1}}}, {t:0.75, {arm0:{dAng:3}}} ]
samplePose(tl, 0)  → {arm0:{dAng:1}}
samplePose(tl, 1)  → {arm0:{dAng:3}}
```

**Rule C — between keys, interpolate per channel-kind:**
- **Relative** channels always interpolate, treating absent as `0` (so they ease
  to/from identity at an unauthored end). Only non-zero results are emitted.
- **Absolute** channels interpolate **only when both keys define them**. A
  one-sided absolute is dropped from the in-between — an absolute cannot be lerped
  toward "unknown procedural," so the procedural default fills that span. (A
  converted-baseline bake only ever samples exactly *on* keys, so this never
  bites it.)
- The bone-id set of the in-between pose is the **union** of both keys' bones.

```
// relative eases from identity:
keys:[{t:0,{}},{t:1,{arm0:{dAng:2}}}]           → samplePose(_,0.5) = {arm0:{dAng:1}}
// absolute needs both sides:
keys:[{t:0,{arm0:{ang:1}}},{t:1,{arm0:{ang:3}}}]→ samplePose(_,0.5) = {arm0:{ang:2}}
// one-sided absolute drops out (only the relative survives):
keys:[{t:0,{arm0:{ang:1}}},{t:1,{arm0:{dAng:1}}}]→ samplePose(_,0.5) = {arm0:{dAng:0.5}}
```

The practical upshot: if a between-keys frame looks like it "snaps to procedural"
on one axis, you almost certainly have an absolute channel defined on only one of
the two surrounding keys. Define it on both, or use relative.

---

## 4. Easing

`Ease = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'`, applied to the normalized
span and shaping the approach **into the next key** (`k1.ease`):

| Ease | curve `f(u)` | at u=0.5 |
|------|--------------|----------|
| `linear` | `u` | 0.5 |
| `easeIn` | `u²` | 0.25 |
| `easeOut` | `1−(1−u)²` | 0.75 |
| `easeInOut` | `u<.5 ? 2u² : 1−(−2u+2)²/2` | 0.5 |

Because easing belongs to the destination key, the ease you pick on a key governs
the motion *arriving at* it, not leaving it.

---

## 5. Ways to author or edit

Four routes, from most to least assisted. Prefer the assisted ones — they keep
the invariants for you.

**A. The studio UI** (`bun run dev`, or the game's dev page). Pick a body, choose
a clip, turn on **✎ pose edit**, drag a joint (cyan = arm/FK, green = foot/IK, amber =
body root), then **set key** / **clear key**, choose **ease in**, set **duration**
(ms) for retimable clips, **reset clip** to clear a clip's authoring, and **Save**
(or **copy JSON**). Drags write relative channels; the studio inserts/sorts keys
and prunes empties for you. This is the primary path for a human. (**Copy JSON**
is the offline fallback, but it emits the pruned store *pretty-printed and
unwrapped* — inspection-friendly, not the canonical file format; see §6 before
committing anything seeded from it.)

**B. The headless hook** (`window.__ae`) — programmatic authoring/verification
without a human. Select a body, set a clip, `setPose(true)`, `nudge(boneId,
dAng)` to author a relative key, then `save()`. Full recipe and the Playwright
pattern are in `references/verification.md`.

**C. Timeline ops in code** (`src/timeline.ts`) — when writing a tool that edits a
`ClipStore` directly. **All mutate the store in place** (the store is the live
object the bake samples, so an edit shows in the next render):

```ts
import { timelineFor, keyAt, clearKeyAt, prunedClips, countKeys, KEY_EPS } from 'anim-studio';

const tl  = timelineFor(store, bodyId, clip, /* create */ true)!; // makes {keys:[]} on demand
const k   = keyAt(tl, t, /* create */ true, 'easeOut')!;          // finds within KEY_EPS(1e-4) or inserts SORTED
(k.pose[boneId] ??= {}).dAng = 0.7;                               // author a channel
clearKeyAt(tl, t);                                                // remove the key at t
const payload = prunedClips(store);                               // NEW object for Save: keeps keyed OR
                                                                  // duration-only timelines, drops empties
```

`keyAt` with `create` inserts in sorted position and never duplicates within
`KEY_EPS`. `prunedClips` returns a **new** object safe to serialize while the live
store keeps its in-progress empties; `countKeys` is a cheap "anything authored?"
probe.

**D. By hand**, editing `clips.ts` / `clips.json` directly. Allowed, but you are
now responsible for the invariants §6 enforces — most easily by re-canonicalizing
afterward (below). Reserve this for surgical fixes; for anything structural, use
route C and emit.

---

## 6. Keeping edits diff-stable

The emitter (`src/emit.ts`) is deterministic so a one-key edit is a one-key diff:

- `stableClips` **deep-sorts object keys** and normalizes `-0 → 0`. It **maps
  arrays in place without reordering** — so it does **not** sort a timeline's
  `keys` array. If you author by hand or by a tool that appends keys, **keep the
  `keys` array sorted by `t` yourself**; the sampler assumes it.
- Numbers keep **full precision** — never quantize (rule 2). Only `-0` is
  normalized.
- The literal is **compact (one line)**, so a Save never reformats a large
  baseline into a pretty-printed mega-diff.
- Output is a **fixed point**: emit → parse → emit is byte-identical.

The safe pattern after any programmatic or hand edit — run it back through the
emitter with the file's own banner:

```ts
import { emitClipsModule } from 'anim-studio';         // or emitClipsJson for .json
const text = emitClipsModule(prunedClips(store), {
  banner: EXISTING_FILE_BANNER,                        // byte-identical to the current header
  typesImport: `import type { BodyClips, MotionOverride } from './types';`,
});
// write `text` to clips.ts
```

Then eyeball `git diff` — a well-formed edit touches only the keys you changed.
An exploded diff (thousands of lines) almost always means an **external formatter
treating this generated file as source** — Prettier, ESLint `--fix`,
format-on-save, or a pre-commit hook re-expanding the compact one-liner. Exclude
the clips file from all of them (`.prettierignore` / `.eslintignore`, editor
format-on-save, pre-commit) and mark it `linguist-generated`; its formatting is
owned by the emitter, not the repo's style rules. (A header-only churn instead
means a wrong banner; a small reordered-keys churn means the array wasn't
sorted.) **Commit to seal.**

---

## 7. MotionOverride

`MotionOverride` is a reserved, coarse per-body feel layer — cast-wide
multipliers over the procedural default: `swingAmp` (× weapon-arm arc),
`strideLen` (× leg travel), `strideLift` (× foot lift), `coilAmt` (× whole-body
coil/lunge), `pitchAmt` (× pitch into the blow). Identity is all `1`/`0`, so an
absent override changes nothing. It ships in the format (the `ANIM_OVERRIDES`
export) for hosts that want "make this body's whole motion a bit more/less"
sliders; the base studio emits an empty map. Only wire it if the game reads it at
bake time — otherwise leave `ANIM_OVERRIDES` empty and untouched.

---

## 8. Assembled characters

Assemble mode builds characters as `SkeletonDoc`s (`src/skeleton.ts` — pure,
node-testable). One doc is one self-contained unit:

```
SkeletonFile: { version: 1, skeletons: { <docId>: SkeletonDoc } }
SkeletonDoc:  { id, name, fw, fh, bones: SkelBone[], clips: SkelClip[], timelines: BodyClips }
SkelBone:     { id, parent, x, y, rot, sx, sy, len, z, joint, img? }
SkelClip:     { key, name, frames, fps }         // key stable, name renamable
```

- **Bone ids are explicit unique names** (unlike procedural bodies' draw-order
  ids). `renameBone` rewrites the doc's timelines so authored keys follow the
  bone; `removeBone` strips the subtree's keys. Never rename by hand-editing.
- **`timelines` is the SAME object** the studio injects into the live clip
  store at `sk:<docId>` — animate-mode edits land in the doc and persist with
  it. `sk:*` keys are **filtered out of the game clips Save**; they belong to
  the skeleton file only.
- **Skeleton bones animate through the relative channels**: `dAng` rotates
  about the joint — clamped by the joint config (`free`/`hinge` min–max/`fixed`
  welds) — and `ikDx/ikDy` translate in parent space. Bind pose (position,
  rotation, scale) is assembly data, not animation data; the absolute channels
  are unused.
- **Keys may sit at any `t`, not just on frames** — the studio's timeline
  authors them freely (non-uniform spacing), the sampler interpolates them
  into whatever grid samples them, and the studio plays assembled bodies
  continuously. The file also carries the shared **parts bin** (`parts:
  [{name, src, w, h}]`) so imports survive reloads.
- **Clip keys are stable across renames** (`walk` stays `walk` when the display
  name becomes "strut"), so timelines never detach. Timing is **fps-based**
  (default 60, per-clip configurable, fractional allowed): duration =
  `frames / fps`, sampled at `t = i/(frames-1)`. Legacy files carrying `per`
  (ms/frame) convert on load. Changing a clip's frame count via `patchClip`
  **snaps existing keys to the new grid** (nearest frame; colliding keys keep
  the earliest); changing `fps` never moves keys (`t` is normalised). In the
  studio, editing the duration re-counts frames at the clip's fps, and
  editing fps re-counts frames to keep the duration.
- **Serialisation** (`packSkeletons` / `unpackSkeletons`) is canonical like the
  clips emitter — deep-sorted keys, bones sorted by draw order, empty timelines
  pruned, trailing newline — and `unpackSkeletons` is defensive (defaults
  filled, unknown parents cleared, ≥1 clip guaranteed). Attachment images are
  embedded data URIs (imports are capped at 512px on the long edge). The file
  is generated: exclude it from formatters like the clips file.

---

## 9. Per-clip variation

`ClipTimeline.variation` (optional) keeps repeating clips from playing
identically forever. `src/variation.ts` is a pure leaf module like `sample.ts`.

```ts
ClipVariation: {
  amp?: number       // ± travel: 0.15 = lands 85%..115% of the authored pose
  speed?: number     // ± tempo per loop
  phase?: number     // ± start offset per loop (wraps; desyncs copies)
  bones?: Record<string, number>  // per-bone amp weights (0 pins, 1 default)
  seed?: number      // base seed; hosts XOR a per-instance seed on top
}
```

**How it behaves** (rule 7 in SKILL.md):
- Amounts are drawn **per loop cycle**, constant through it → one playthrough
  is smooth. `amp` is drawn **per bone**, so limbs vary independently.
- **Relative** channels (`dAng`, `ikDx/ikDy`) are scaled directly. **Absolute**
  channels are scaled about the clip's **first key** for that bone/channel —
  "85% of the way from the starting pose," never dragged toward the origin; an
  absolute with no anchor is left alone.
- A pose of magnitude 0 scales to 0, so a clip that starts and ends at rest
  **loops seamlessly** even as cycles vary.
- Deterministic by hash of `(seed, cycle, bone)` — never `Math.random()`.

**Using it:**

```ts
import { samplePoseVaried, variationFor } from 'anim-studio';

const cycle = Math.floor(elapsedMs / clipMs);
const pose  = samplePoseVaried(tl, t, cycle, entityId);      // drop-in for samplePose
const rate  = variationFor(tl.variation, cycle, entityId).speed; // for your clock
```

`samplePoseVaried` with no config is exactly `samplePose`. `applyVariation`
never mutates the authored pose. `prunedClips` keeps a variation-only timeline,
so the config survives a Save. In the studio, the Variation panel writes it and
previews it **only while playing** — posing/scrubbing always shows the exact
authored pose.
