# anim-studio

A keyframe pose editor for **procedurally-animated 2D characters** — for any
game, any engine — plus a **character assembly workbench** for building
skeletal characters out of image parts.

Your game draws its characters in code; their motion comes from pose
functions. Editing that motion usually means tweaking a magic number blind,
re-baking, and squinting at a GIF. The studio replaces that with a tight loop:
**drag → see → keyframe → save.** Pick any body from your roster, watch its
real baked clips, pose it by dragging its joints (FK arms rotate, IK feet
re-plant, the body root tilts), set keyframes with easing and per-clip
duration, and Save — the edit lands in your game's own source as diffable,
version-controlled data that both you and an agent can iterate on.

The studio has two modes, Spine-style:

- **Animate** — the keyframe editor above, over every body in the roster.
  Keys move on the dope sheet (drag), copy/paste between frames, and every
  edit is undoable.
- **Assemble** — import pictures, attach them as bones, drag/rotate/scale
  them into a rig, parent bones into a hierarchy, and configure each joint
  (free / hinge with limits / welded). Assembled characters join the roster
  as poseable bodies whose clips you create, rename, retime, duplicate, and
  delete freely.

Extracted and generalized from a shipped game's internal animation studio,
where it posed a cast of ~190 procedurally-drawn bodies. The hard-won rules
are baked in as defaults.

---

## The rules this tool encodes

1. **Authored data layers over procedural motion — and is inert until
   authored.** A body with no timeline renders its procedural default
   byte-for-byte. An authored key changes exactly the frames it keys and
   nothing else. You can prove this in your own game with a drift harness
   (bake everything → per-frame checksums → diff).
2. **Absolute channels replay byte-identically; relative channels compose.**
   A captured absolute value (`ang`, `fx/fy`, `dx/dy/rot`, …) *replaces* the
   procedural computation — so a converted baseline replays exactly, and
   editing a value edits the animation directly. A drag writes a *relative*
   delta (`dAng`, `ikDx/ikDy`) that composes over either.
3. **The studio must be faithful by construction.** It doesn't approximate
   your animation — your adapter hands it the same frame plan and the same
   draw code the game bakes from, so the frames shown are the frames the game
   renders.
4. **A skeleton is discovered from the draw, never hand-authored.** Rig
   helpers self-assign stable bone ids from call order (`arm0`, `leg1`,
   `root`) and record their pivots while drawing — the same order runs in the
   studio and the game, so ids always agree.
5. **Authored tempo must never move a hazard beat.** An authored `duration`
   re-times *presentation* clips (idle/walk/hit) only; attack tempo stays
   combat data your game applies at play time. (The studio previews
   presentation clips at the authored tempo; mark them `retimable`.)
6. **Saves are diff-stable.** Deep-sorted keys, full-precision floats
   (quantising would silently perturb a converted baseline's byte-identical
   replay), compact one-line literal, `-0` normalised. A save that changes
   one key diffs as one key.

---

## Quick start (the demo rig)

```sh
bun install
bun run dev            # opens /demo/ — three procedural bodies, no engine
bun run test           # node:test suite over the pure modules
bun run verify         # headless end-to-end: pose → key → save → replay,
                       # then assemble → clip CRUD → key CRUD → reload
```

In the demo: pick **scout**, choose the *attack* clip, tick **pose edit**,
drag the staff arm (cyan), a foot (green) or the body root (amber), then
**Save** — the key lands in `demo/clips.ts`, and on reload the baked clip
plays your edit. `demo/bodies.ts` is the integration example: a real game
implements the same adapter shape against its own render pipeline.

Then switch to **Assemble** in the header: create a character, import a few
PNGs (or drop them on the canvas), click a part to attach it as a bone under
the selection, and drag it into place — the gizmo moves, the round handle
rotates (Shift snaps to 15°), the square handle scales; the inspector has the
numeric fields, parent dropdown, joint config, and draw order. Press **?**
anywhere for the shortcut list.

---

## Assemble mode — characters from parts

Everything needed to build a cut-out character and hand it a skeleton rig:

- **Parts** — import images (file picker or drag-drop onto the canvas). Each
  import is capped at 512px on the long edge and embedded as a data URI, so a
  character document is fully self-contained.
- **Bones** — a part attaches as a new bone under the selected bone; empty
  bones (`+ bone`) give the rig structure. Select on canvas or in the
  skeleton tree; move / rotate / scale with the gizmo or the inspector's
  numeric fields; arrows nudge (Shift ×10). Bone names are the stable ids
  authored keys attach to — renaming a bone rewrites its keys, so data never
  detaches.
- **Hierarchy** — reparent via the inspector dropdown (cycle-guarded; the
  bone keeps its world placement), reorder drawing with back/front, delete a
  bone with its subtree.
- **Joints** — per-bone: `free` (unlimited rotation), `hinge` (min/max degree
  limits, enforced when posing), `fixed` (welded — pose drags can't rotate
  it).
- **Clips** — assembled characters own their clip list: `+ clip` to add,
  double-click a tab to rename, `⋯` to duplicate/delete, and the inspector
  sets frame count and duration. Clip keys stay stable across renames, so
  timelines follow the clip.
- **Animating** — an assembled body poses exactly like a procedural one:
  drag rotates a joint (within its limits), Shift-drag translates it, keys
  land on the dope sheet where they can be dragged between frames,
  copied/pasted, and undone (`Ctrl+Z` spans both modes).
- **Persistence** — characters (rig + clips + keyframe timelines, one JSON
  unit each) autosave to the dev server's skeletons endpoint when the save
  plugin is configured with `skeletonsFile` (the demo writes
  `demo/skeletons.json`), else to localStorage. `↓ save` / `↑ load` in the
  Characters panel export/import the same JSON by hand. Assembled timelines
  live under `sk:<id>` store keys and are **never** written into the game's
  clips file — Save keeps your game data clean.

---

## Package layout & developing

```
src/            the package — pure TS source, consumed via your bundler
  types.ts        the stored format (poses, keyframes, timelines)
  sample.ts       sample a timeline at a clip-time (game + studio share it)
  emit.ts         deterministic clips-file emitters (TS module / JSON)
  timeline.ts     keyframe edit operations over the authored store
  rig.ts          the bone contract: record sink + canvas FK/IK/root helpers
  skeleton.ts     assembled characters: skeleton doc format + pure ops
  skeleton-render.ts  draw a skeleton doc / wrap it as a roster body
  assembly.ts     Assemble mode — the parts-to-rig editor pane
  history.ts      the shared undo/redo stack
  adapter.ts      the host interface the studio drives your game through
  studio.ts       mountStudio() — the editor UI (Animate + Assemble)
  save-plugin.ts  dev-only Vite endpoint (import directly, not via index)
demo/           the reference integration — a procedural cast, no engine
test/           node:test suite over the pure modules (`bun run test`)
verify/         headless Playwright end-to-end (`bun run verify`)
```

Developing: `bun run dev` (the demo is the workbench), `bun run check`
(strict tsc), `bun run test`, `bun run verify` (the full authoring loop in
headless Chromium — it restores `demo/clips.ts` afterwards), `bun run build`
(bundle smoke check). CI runs all of them. The test runner imports `.ts`
directly via Node's type stripping — hence `engines.node >= 22.18`; the
package itself is plain browser TS with no Node requirement.

The package ships as source (`main: src/index.ts`): hosts consume it through
their own Vite/bundler exactly like their other dev tools — there is no dist
to build or publish. Install it pinned to a release tag:

```sh
bun  add github:markus-vv-kokkonen/anim-studio#v0.1
# or: npm install github:markus-vv-kokkonen/anim-studio#v0.1
```

`save-plugin.ts` is deliberately not re-exported from `index.ts` (it imports
`node:fs`); import it directly in `vite.config.ts` — and import it by a path
**relative into `node_modules`**, not by the bare specifier:

```ts
import { animStudioSavePlugin } from './node_modules/anim-studio/src/save-plugin.ts';
```

Vite externalises bare imports when loading its own config, which hands the
file to Node, and Node fails it twice: it cannot resolve this package's
extensionless internal imports (`./emit`), and it refuses to type-strip a `.ts`
file under `node_modules` at all (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).
A relative path is bundled by esbuild instead, which handles both. Everything
your *game* imports (`anim-studio`, `anim-studio/src/rig.ts`, …) is resolved by
Vite, not Node, so those stay bare specifiers as normal.

## Wiring it to your game

Four pieces, all served by your dev server (it's a dev tool — keep it out of
the shipped bundle):

### 1. The stored format + sampler (`types.ts`, `sample.ts`)

Your game imports these (or vendors copies — they're two pure leaf modules)
and samples the authored store wherever it bakes/renders a frame:

```ts
import { poseForFrame } from 'anim-studio';
import { ANIM_CLIPS } from './data/anim/clips'; // written by Save

const pose = poseForFrame(ANIM_CLIPS[bodyId], clip, t); // undefined = procedural
drawBody(ctx, drive, pose);
```

### 2. The rig contract (`rig.ts`)

Route each limb of your draw code through a helper — or your own helpers that
call `recordBone` the same way (a game with its own limb abstractions can
thread them all through one bone-record sink):

```ts
rootBone(ctx, pose, cx, cy, { dx, dy, rot }, () => {
  fkBone(ctx, pose, shoulderX, shoulderY, proceduralAngle, () => {
    /* draw arm + hand + weapon as ONE rigid piece */
  });
  ikLeg(ctx, pose, hipX, hipY, footX, footY, thighLen, shinLen, (kx, ky, fx, fy) => {
    /* draw thigh to (kx,ky), shin to (fx,fy) */
  });
});
```

Each helper is the identity when nothing is authored, replays an authored
absolute, composes a drag delta, and records its pivot for the studio's
handles. `beginBoneRecord()`/`endBoneRecord()` around a draw captures the
skeleton; recording is off (free) in the game's hot path.

### 3. The adapter (`adapter.ts`)

One page in your dev tools mounts the studio over your roster:

```ts
import { mountStudio, type StudioAdapter } from 'anim-studio';
import { ANIM_CLIPS } from '@/data/anim/clips';

const adapter: StudioAdapter = {
  clips: ANIM_CLIPS,             // the LIVE store your bake path samples
  bodies: () => roster,          // { id, label, group?, title?, variants? }
  bake: (body, variants) => ({   // bake through YOUR pipeline
    frameW, frameH,
    clips,                       // { name, clipKey, frames, delays, retimable? }
    plan,                        // plan[frameIndex] = { clip, t }
    bodyId,                      // authored-store key; absent = view-only
    frame: (i) => ({ src, x, y, w, h }),          // the real baked sheet
    renderPose: (i, pose) => ({ canvas, fw, fh, bones }), // direct draw, recording on
  }),
};
void mountStudio(adapter);
```

Derive `clips` and `plan` from the same source your game bakes from, so the
studio can never show a reduced or stale set. `variants` (a select/toggle
panel per body) covers loadout-style options — a hero's weapon/facing/tier.

### 4. The Save endpoint (`save-plugin.ts`)

```ts
// vite.config.ts
import { animStudioSavePlugin } from 'anim-studio/src/save-plugin';

plugins: [
  animStudioSavePlugin({
    root: __dirname,
    file: 'src/data/anim/clips.ts',   // .json for plain JSON
    typesImport: `import type { BodyClips, MotionOverride } from './types';`,
    skeletonsFile: 'src/data/anim/skeletons.json', // optional: assembled characters
  }),
],
```

`apply: 'serve'` — it never ships. *Copy JSON* in the UI is the offline
fallback. **Commit to seal the animation.**

With `skeletonsFile` set, the studio loads assembled characters from the file
on boot (GET) and autosaves edits back (POST) at `/__anim/skeletons` — set
`adapter.skeletons = {}` (or `{ endpoint }` to customise the path) to opt the
studio in. Without an endpoint, characters persist to localStorage and can be
exported/imported as JSON from the Characters panel.

---

## The stored format

```
bodyId → clip id → { duration?, keys: [{ t, ease?, pose }] }
pose:    boneId → BoneOffset
```

`BoneOffset` carries **absolute** channels (`ang`, `poke`, `flex`, `ext`,
`draw`, `fx/fy`, `dx/dy/rot` — the bone's whole pose; a rig helper uses them
*instead of* its procedural computation) and **relative** channels (`dAng`,
`ikDx/ikDy` — deltas a drag writes, added on top). Sampling semantics
(`sample.ts`): a clip-time landing **on** a key returns that key's pose
verbatim — every channel — which is what makes a converted baseline replay
byte-identically. Between keys, relative channels interpolate to/from 0 and
absolute channels interpolate only when **both** keys define them (an
absolute can't be lerped toward "unknown procedural"). Every field is
optional; an empty pose is the identity.

## Headless verification

The studio exposes a driving hook (default `window.__ae`) covering the whole
tool: the classic loop (`ready() count() labels() select(i) setClip(i)
clips() state() setPose(on) bones() nudge(boneId, dAng) authoredKeys()
save()`), modes + history (`mode() setMode(m) undo() redo()`), keyframe CRUD
(`moveKey(from, to) copyKey() pasteKey()`), clip CRUD on assembled bodies
(`addClip(name) renameClip(key, name) deleteClip(key) patchClip(key, {frames,
per})`), and Assemble mode itself (`skeletons() newSkeleton(name)
deleteSkeleton(id) addSkelBone(docId, opts) patchSkelBone(docId, boneId,
patch) saveSkeletons()`). `verify/verify.mjs` shows the pattern: boot in
Playwright, nudge a bone, Save, reload, and assert the baked frame actually
changed; then assemble a character from a generated part, CRUD its clips and
keys, and assert it survives a reload — then restore both files. Wire the
same loop against your game and you have an end-to-end proof your data
channel works.

## Going further (patterns from production use)

- **Converted baseline** — capture the whole cast's procedural motion as
  absolute keys (bake each body once with recording on and store each
  helper's `val` at each frame), so the data file is a faithful, *editable*
  copy of today's motion instead of an empty file. Refuse to write unless
  replaying it is pixel-identical.
- **Drift harness** — bake every body under a fixed seed and checksum every
  frame, before vs after any change to the data channel. Zero diff = the
  channel is provably inert; an authored knight keyframe should change
  exactly one body's swing frames and nothing else.
- **Durable authored layer** — if you regenerate a baseline wholesale, keep
  hand-authored polish as an idempotent edit spec (named deltas applied onto
  baseline keys) and re-apply it after regeneration.

---

MIT.
