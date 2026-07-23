---
name: anim-studio
description: >-
  Best practices and pitfalls for anim-studio — the keyframe pose editor that
  layers hand-authored motion over a 2D game's procedural animation. Use this
  whenever the work touches anim-studio in any way: wiring it into a game (the
  rig contract fkBone/ikLeg/rootBone, the StudioAdapter, the dev-only Vite Save
  endpoint, sampling the store with poseForFrame), authoring or editing keyframe
  data (BodyClips, ClipTimeline, poses, the generated clips.ts / clips.json,
  absolute vs relative bone channels), or debugging the classic failure modes —
  an authored edit not changing the render, a Save producing a huge or unstable
  git diff, bone ids remapping to the wrong joint, a "converted baseline" not
  replaying byte-identically, or authored tempo moving a combat beat. Also use
  when developing the anim-studio package itself. Load it BEFORE touching poses,
  timelines, the adapter, the rig, or the clips file: the format has non-obvious
  invariants (byte-identical-until-authored, absolute-vs-relative channels,
  diff-stable saves, bone ids discovered from draw order) that are easy to break
  silently and expensive to debug after the fact.
---

# anim-studio

A keyframe pose editor for **procedurally-animated 2D characters**, for any game
and any engine. The game draws characters in code; their motion comes from pose
functions. anim-studio lets you (or an agent) pose those characters by dragging
joints on the game's *own* renders, keyframe with easing and per-clip duration,
and Save the edit back into the game's source as diffable, version-controlled
data. That data **layers over** the procedural motion and is **inert until
authored** — a body with no timeline renders exactly as before, byte-for-byte.

Everything below exists to protect that promise. The hard part of this tool is
not the API; it is a handful of invariants that keep authored data faithful and
diffs clean. Break one and the failure is silent — the render looks fine in the
studio but drifts in the game, or a one-key edit lands as a 100k-line diff.

## The mental model (read this first)

A character's motion has **two layers**:

1. **The procedural default** — computed by the game's own draw/pose code.
   Unchanged, free, byte-identical, what the whole cast gets.
2. **An optional authored keyframe timeline** per `(body, clip)` that layers
   corrections on top. Absent → layer 1 renders exactly as before.

The layers meet at each **bone**. A bone's authored offset carries two *kinds*
of channel, and the difference between them is the single most important concept
in the tool:

| Kind | Channels | Semantics | Written by |
|------|----------|-----------|------------|
| **Absolute** | `ang` `poke` `flex` `ext` `draw` `fx` `fy` `dx` `dy` `rot` | **Replaces** the bone's procedural computation. Replaying a captured absolute is byte-identical to the procedural render; editing the value edits the animation directly. | a "convert-to-data" capture; hand-typed keys |
| **Relative** | `dAng` `ikDx` `ikDy` | A **delta added on top** of the procedural (or absolute) pose. | an interactive drag in the studio |

Every field is optional; an empty pose is the identity. An absolute channel says
"the bone is *exactly here*"; a relative channel says "nudge the bone by this
much from wherever it already is."

**Sampling** (`src/sample.ts`, shared by the game and the studio) has three
rules that fall out of that distinction — know them cold, because most "why did
my edit do X?" questions are answered here:

- A clip-time landing **on** a key returns that key's pose **verbatim**, every
  channel included. This is what makes a converted baseline replay
  byte-identically and an edited absolute take effect immediately.
- **Between** keys: relative channels always interpolate (to/from 0 at an
  unauthored end). Absolute channels interpolate **only when both keys define
  them** — an absolute can't be lerped toward "unknown procedural," so a
  one-sided absolute drops out and the procedural default fills the in-between.
- Easing shapes the approach **into the next key** (`k1.ease`), not out of the
  current one. Keys are assumed **sorted by `t`**.

## The invariants — break these and it fails silently

These are the "rules this tool encodes." Each is cheap to honor and costly to
violate. Treat them as non-negotiable unless the user explicitly overrides.

1. **Inert until authored.** A body with no timeline must render its procedural
   default byte-for-byte. Never make the data channel change unauthored bodies.
   *Prove it* with a drift harness (bake everything → per-frame checksums →
   diff before/after any change to the channel; zero diff = provably inert).

2. **Absolutes replay byte-identically; never quantize floats.** A converted
   baseline stores the *exact* floats the procedural rig computed; its
   byte-identical replay survives only because those floats round-trip exactly.
   Rounding/quantizing a value anywhere in the save path silently perturbs the
   replay. Full precision, always.

3. **Faithful by construction — derive `clips` and `plan` from the same source
   the game bakes from.** The studio must show the frames the game renders. Hand
   the adapter the *same* frame plan and the *same* draw code the game bakes
   from, so it can never show a reduced, reordered, or stale set. Don't build a
   parallel "studio-only" frame list.

4. **Bone ids are discovered from draw order, never hand-authored.** Rig helpers
   self-assign stable ids from call order within a body (`arm0`, `arm1`, `leg0`,
   `root`). The same draw runs in the studio and the game, so ids agree — *as
   long as the draw order is stable*. Reorder your limb draw calls and every
   authored key silently remaps to the wrong joint. Call `resetBoneIds()` at the
   start of each body draw (`rootBone` does this for you), and keep limb order
   fixed once anything is authored against it.

5. **Authored tempo must never move a hazard beat.** An authored `duration`
   re-times **presentation** clips (idle/walk/hit) only — mark those `retimable`.
   Attack/combat tempo is data the game applies at play time (wind-up / active
   windows); leave those clips unmarked so `duration` can't touch them.

6. **Saves are diff-stable.** The emitter deep-sorts object keys, keeps full
   float precision, normalizes `-0`, and writes a compact one-line literal so a
   one-key edit diffs as one key. Two corollaries when you author *outside* the
   studio: keep each timeline's `keys` array **sorted by `t`** (the emitter sorts
   object keys but **not** array order), and keep the file **banner byte-identical**
   to what's already there (a mismatched banner reformats the whole file). When
   in doubt, route hand-edits back through the emitter or a studio Save to
   canonicalize. **Commit to seal an animation.**

## Pick your task

- **Wiring anim-studio into a game** (implementing the rig, the adapter, the
  sampler hookup, the Save endpoint) → read `references/wiring.md`.
- **Authoring or editing clip data** (in the studio, via the headless hook, with
  the timeline ops, or by hand) and understanding the stored format / sampling
  in depth → read `references/data-format.md`.
- **Proving it works or debugging a failure** (converted baseline, drift harness,
  headless verify, "my edit doesn't show / my diff exploded / a bone jumped") →
  read `references/verification.md`.

Read the reference that matches the task rather than guessing from the summaries
above — each carries the exact function signatures, invariant-preserving code,
and failure-mode playbooks.

## Quick reference

**Package shape.** Ships as source (`main: src/index.ts`), consumed through the
host's own Vite/bundler — there is **no dist to build**. `src/types.ts` and
`src/sample.ts` are pure leaf modules (no DOM, no engine) the game imports at
bake time. `src/save-plugin.ts` imports `node:fs` and is **deliberately not
re-exported** from the index — import it directly in `vite.config.ts`.

**Key exports** (`src/index.ts` re-exports all but the save plugin):
- Format & sampling: `poseForFrame(clips, clip, t)`, `samplePose(tl, t)`, the
  `BoneOffset` / `Pose` / `Keyframe` / `ClipTimeline` / `BodyClips` / `ClipStore`
  types (`types.ts`, `sample.ts`).
- Rig contract: `rootBone`, `fkBone`, `ikLeg`, `solveKnee`, `recordBone`,
  `beginBoneRecord` / `endBoneRecord`, `resetBoneIds`, `nextBone` (`rig.ts`).
- Timeline ops (mutate the store in place): `timelineFor`, `keyAt`, `clearKeyAt`,
  `prunedClips`, `countKeys`, `KEY_EPS` (`timeline.ts`).
- Emit (deterministic): `emitClipsModule`, `emitClipsJson`, `clipsLiteral`,
  `stableClips` (`emit.ts`).
- Studio + adapter: `mountStudio(adapter, opts?)`, the `StudioAdapter` /
  `BakedBody` / `ClipDef` / `PlanFrame` / `BodyDesc` interfaces (`studio.ts`,
  `adapter.ts`).
- Save plugin (import directly): `animStudioSavePlugin(opts)` from
  `anim-studio/src/save-plugin`.

**Headless hook.** `mountStudio` exposes a driving API on `window.__ae` (rename
via `opts.hook`, `false` disables): `ready() count() labels() select(i)
setClip(i) clips() state() setPose(on) bones() nudge(boneId, dAng)
authoredKeys() save()`. Use it to author or verify without a human — see
`references/verification.md`.

**Dev commands** (this repo; a host wires equivalents): `npm run dev` (the demo
is the workbench at `/demo/`), `npm run check` (strict `tsc`), `npm test`
(`node:test` over the pure modules), `npm run verify` (headless end-to-end:
pose → key → save → reload → assert the baked frame changed, then restores the
file), `npm run build` (bundle smoke check). Requires Node ≥ 22.18 (the test
runner strips types from `.ts` directly).

**`demo/` is the reference integration** — `demo/bodies.ts` implements the exact
`StudioAdapter` shape a real game implements against its own pipeline; start
there when wiring a new host. **`bridge/` is donor-repo-only** (it imports the
source game's real data by design) — delete it when lifting the package into its
own repo; never try to run it in the standalone package.
