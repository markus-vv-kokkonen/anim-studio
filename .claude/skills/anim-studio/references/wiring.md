# Wiring anim-studio into a game

Four pieces, all served by the game's **dev** server (it is a dev tool — keep it
out of the shipped bundle). The reference implementation of all four is
`demo/bodies.ts` + `vite.config.ts` in this repo; a real game implements the same
shapes against its own render pipeline. Read `demo/bodies.ts` alongside this — it
is the worked example.

Order to build them: **2 (rig) → 1 (sampler) → 3 (adapter) → 4 (save)**. The rig
makes limbs poseable; the sampler makes authored data render; the adapter drives
the studio over the roster; the endpoint persists edits.

---

## 1. The stored format + sampler (`types.ts`, `sample.ts`)

The game imports these two **pure leaf modules** (or vendors copies — they import
nothing) and samples the authored store wherever it bakes or renders a frame:

```ts
import { poseForFrame } from 'anim-studio';
import { ANIM_CLIPS } from './data/anim/clips'; // the file Save writes

const pose = poseForFrame(ANIM_CLIPS[bodyId], clip, t); // undefined = procedural
drawBody(ctx, drive, pose);                             // pose flows into the rig
```

`poseForFrame(clips, clip, t)` returns `undefined` when the body has no authored
timeline for that clip — and `undefined` must mean "render the procedural
default." Thread the (possibly `undefined`) `pose` into your draw code so the rig
helpers can apply it. That is the entire game-side integration: one sample call,
one `pose` argument.

**Invariant:** sample the store at the *same* `(clip, t)` your plan uses (piece
3), so the studio preview and the game bake agree frame-for-frame.

---

## 2. The rig contract (`rig.ts`)

Route each limb of the draw code through a helper (or your own helper that calls
`recordBone` the same way). Each helper does three jobs at once: it is the
identity when nothing is authored, it applies the sampled offset (an **absolute**
channel replaces the procedural value; a **relative** delta composes over it),
and it records its pivot + live canvas transform **when the studio is recording**
so a joint handle lands exactly on the drawn pivot. Recording is off (free) in
the game's hot path.

The three canvas helpers:

```ts
// Outermost. A whole-body translate+rotate everything else rides. Resets bone
// numbering, so per-body ids are stable. Authored dx/dy/rot replace the drive;
// a dAng drag delta composes onto the rotation.
rootBone(ctx, pose, px, py, { dx, dy, rot }, () => {

  // FK bone: rotate the WHOLE limb about (px,py). Draw the arm + hand + held
  // weapon inside the callback so they move as ONE rigid piece (no torn seams).
  // procAngle is your procedural pose; absolute `ang` replaces it, `dAng` adds.
  fkBone(ctx, pose, shoulderX, shoulderY, proceduralAngle, () => {
    /* draw arm, hand, weapon together */
  }, 'arm');

  // IK leg: the FOOT is the handle. procFx/procFy is your planted target;
  // absolute fx/fy replace it, ikDx/ikDy add; the knee re-solves so feet stay
  // planted and the mid-joint bends. draw receives (kneeX, kneeY, footX, footY).
  ikLeg(ctx, pose, hipX, hipY, footX, footY, thighLen, shinLen, (kx, ky, fx, fy) => {
    /* draw thigh to (kx,ky), shin to (fx,fy) */
  }, { kind: 'leg', bend: 1 });
});
```

Supporting exports:
- `solveKnee(hx, hy, fx, fy, l1, l2, bend = 1)` — the two-bone IK solution
  (`bend` +1 = knee forward, -1 = back; out-of-reach targets clamp to a straight
  leg). `ikLeg` uses it; call it directly only for custom limbs.
- `recordBone(ctx, id, kind, px, py, end = false, val?)` — record one drawn bone.
  No-op unless recording. `end: true` flags an IK end-effector (a foot: its
  handle drags a target, not a rotation). `val` is the **absolute** pose the
  helper computed this frame — a convert-to-data capture reads it.
- `beginBoneRecord()` / `endBoneRecord(): BoneRec[]` — wrap the pose-mode draw to
  capture the skeleton. `setBoneVal(id, val)` attaches a captured value to an
  already-recorded bone (e.g. a root known only after it's computed).
- `resetBoneIds()` — reset per-body bone numbering. **Call at the start of each
  body draw** (`rootBone` calls it for you). `nextBone(kind)` yields the next id.

**Invariants that live here:**
- *Bone ids come from call order* (rule 4 in SKILL.md). Fix your limb draw order;
  once anything is authored against `arm1`, reordering makes `arm1` a different
  joint and the authored key lands on the wrong limb — silently.
- *Draw a limb + everything rigidly attached to it inside one `fkBone` callback.*
  Splitting the arm and its weapon across two bones tears the seam when the bone
  rotates.
- *A body without a rig is view-only.* If a body never calls the helpers (or the
  adapter omits `renderPose`), it previews but cannot be posed — which is a fine,
  deliberate state (see the demo `wisp`), not a bug.

A game that draws through its own abstraction (a Brush, a batched renderer) can
pass the underlying `CanvasRenderingContext2D`, or write its own helpers that
call `recordBone` with the same discipline — see how the source game threads its
`armSwing` / `legWalk` / `bodyDrive` through one bone-record sink.

---

## 3. The adapter (`adapter.ts`)

One page in the game's dev tools mounts the studio over the roster:

```ts
import { mountStudio, type StudioAdapter } from 'anim-studio';
import { ANIM_CLIPS } from '@/data/anim/clips';

const adapter: StudioAdapter = {
  title: 'My Game — Anim Studio',
  clips: ANIM_CLIPS,             // the LIVE store your bake path samples (§1)
  bodies: () => roster,          // BodyDesc[]: { id, label, group?, title?, variants? }
  bake: (body, variants) => ({   // bake through YOUR pipeline
    frameW, frameH,
    clips,                       // ClipDef[]: { name, clipKey, frames, delays, retimable? }
    plan,                        // PlanFrame[]: plan[frameIndex] = { clip, t }
    bodyId,                      // authored-store key; ABSENT = view-only
    frame: (i) => ({ src, x, y, w, h }),                  // the real baked sheet
    renderPose: (i, pose) => ({ canvas, fw, fh, bones }), // direct draw, recording ON
  }),
  ready: async () => { /* await engine boot, e.g. Phaser READY */ },
  save: { endpoint: '/__anim/save', hint: 'Save writes src/data/anim/clips.ts; commit to seal.' },
};
void mountStudio(adapter);
```

What each field must satisfy:

- **`clips`** is the **same live `ClipStore` object** the game's bake path samples
  in §1, loaded from the saved file at boot. The studio edits it *in place*, so a
  drag shows up in the very next render. Pass a *copy* and edits will neither
  preview live nor round-trip correctly.
- **`bake(body, variants)`** returns a `BakedBody`. It must **sample the authored
  store per frame and layer it over the procedural pose**, exactly as the game
  does — otherwise an authored key won't change the bake and the studio is lying.
  In the demo: `poseForFrame(store[bodyId], pf.clip, pf.t)` per plan frame. Bake
  is idempotent per body+variants; cache if it's expensive (the studio also
  memoizes per body + variant values).
- **`clips` and `plan` are derived from the same source the game bakes from**
  (rule 3). `plan[i]` must describe the same `(clip, t)` that `frame(i)` renders.
  The demo's `layout()` builds both in one pass so they can never disagree — copy
  that discipline.
- **`bodyId`** is the authored-store key this body's edits live under. **Absent →
  view-only** (previews, no posing). Variants that change the silhouette should
  key **separately** (the demo scout is `scout:staff` vs `scout:sword`) so an
  authored key for one loadout never leaks onto another. Cosmetic variants that
  share the pose (a cape) share one `bodyId`.
- **`frame(i)`** is the real baked blit path (the actual spritesheet frame).
  **`renderPose(i, pose)`** is the pose-edit path: direct-draw frame `i` under an
  authored pose **with bone recording on** (`beginBoneRecord()` … draw …
  `endBoneRecord()`), returning the discovered `bones`. Omit `renderPose` to make
  a body view-only even if it has a rig.
- **`retimable`** on a `ClipDef` opts that clip into authored-`duration` retiming.
  Mark presentation clips (idle/walk/hit); leave attack clips unmarked (rule 5).
- **`variants`** (`VariantDef`: `select` with options, or `toggle`) is the
  per-body loadout/facing/tier panel. Changing one re-bakes the body.

`mountStudio(adapter, opts?)` returns and (by default) exposes the `StudioApi` on
`window.__ae` — see `references/verification.md`. `opts.hook` renames it or
`false` disables it; `opts.root` mounts elsewhere than `document.body`.

---

## 4. The Save endpoint (`save-plugin.ts`)

A dev-only Vite plugin. The studio POSTs the pruned store to it; it writes the
clips file in the deterministic stored format.

```ts
// vite.config.ts — import the plugin DIRECTLY (it is not re-exported from index;
// it imports node:fs and must never enter the browser/production bundle).
import { animStudioSavePlugin } from 'anim-studio/src/save-plugin';

export default defineConfig({
  plugins: [
    animStudioSavePlugin({
      root: __dirname,
      file: 'src/data/anim/clips.ts',   // a .json path emits plain JSON instead
      endpoint: '/__anim/save',         // must match adapter.save.endpoint
      // Emit options (TS-module output):
      banner: MY_BANNER,                // MUST byte-match the file's existing header
      typesImport: `import type { BodyClips, MotionOverride } from './types';`,
      clipsExport: 'ANIM_CLIPS',        // default
      overridesExport: 'ANIM_OVERRIDES', // or false to omit
    }),
  ],
});
```

- The plugin is `apply: 'serve'` — it **never ships**. In the browser, **Copy
  JSON** is the offline fallback when no endpoint is reachable.
- **The `banner` must byte-match the header already in the file** (see how
  `vite.config.ts` copies `demo/clips.ts`'s banner exactly). A mismatch makes the
  first Save rewrite the whole header — a noisy diff. If the file's first lines
  ever change, update the banner to match.
- A `.json` `file` emits plain JSON (`emitClipsJson`); anything else emits a
  typed TS module (`emitClipsModule`) shaped exactly like what the game imports.
- The written file is **generated** — do not hand-edit it casually (rule 6). To
  change data by hand, edit and then re-canonicalize (see
  `references/data-format.md`), or just re-Save from the studio. Because it is a
  generated compact one-liner, **exclude it from formatters**
  (`.prettierignore` / `.eslintignore`, format-on-save, pre-commit) and mark it
  `linguist-generated` — otherwise every Save fights the formatter and explodes
  the diff. **Commit to seal the animation.**

---

## Sanity checklist for a new integration

- [ ] Game samples `poseForFrame(store[bodyId], clip, t)` at bake/render and
      threads the `pose` into the rig; `undefined` renders procedural.
- [ ] Each limb routes through `fkBone`/`ikLeg`/`rootBone` (or a `recordBone`
      equivalent); draw order is fixed; `resetBoneIds()` runs per body.
- [ ] `adapter.clips` is the **same live object** the game bakes from.
- [ ] `bake()` samples the authored store per frame; `clips` + `plan` come from
      one source; `plan[i]` matches `frame(i)`.
- [ ] Silhouette-changing variants get distinct `bodyId`s.
- [ ] Presentation clips are `retimable`; combat clips are not.
- [ ] Save plugin imported directly in `vite.config.ts`, `apply: 'serve'`, banner
      byte-matches the file, endpoint matches the adapter.
- [ ] With everything wired: drag a joint, Save, reload, confirm the **baked**
      frame changed and nothing else did (`references/verification.md`).
