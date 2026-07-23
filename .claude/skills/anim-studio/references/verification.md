# Verifying, and the debugging playbook

The whole value of anim-studio is that authored data is *faithful* (it renders in
the game exactly as in the studio) and *inert until authored* (it changes nothing
it didn't key). Both are provable. Prove them — the failures are silent
otherwise. Contents:

1. [The headless hook + end-to-end verify](#1-the-headless-hook)
2. [Drift harness — prove the channel is inert](#2-drift-harness)
3. [Converted baseline — a faithful, editable copy of today's motion](#3-converted-baseline)
4. [Durable authored layer — surviving a baseline regen](#4-durable-authored-layer)
5. [Extraction parity (donor repo only)](#5-extraction-parity)
6. [Debugging playbook — symptom → cause → fix](#6-debugging-playbook)
7. [Commands](#7-commands)

---

## 1. The headless hook

`mountStudio` exposes a driving API on `window.__ae` (rename via `opts.hook`,
`false` disables). It lets a Playwright/Puppeteer harness — or an agent — drive
the *real* studio and assert on the *real* baked output:

```
ready(): boolean            count(): number          labels(): string[]
select(i): Promise<void>    setClip(i): void          clips(): string[]
state(): { name, group, clip, frame, frames, poseable }
setPose(on): void           bones(): {id,kind,x,y}[]  nudge(boneId, dAng): void
authoredKeys(): number      save(): Promise<boolean>
```

Note `bones()` returns the discovered joints only *after* `setPose(true)` has
rendered a pose frame. There is no `setFrame` on the hook — to land on a specific
frame, drive the scrub input the UI uses:

```js
window.__ae.setClip(window.__ae.clips().indexOf('attack'));
const scrub = document.querySelector('[data-as="scrub"]');
scrub.value = '3';
scrub.dispatchEvent(new Event('input'));
```

**The end-to-end pattern** (this is what `verify/verify.mjs` does — read it as the
template, and mirror it against a game to prove that game's data channel):

1. Boot the dev server, `goto` the studio page, `waitForFunction(() => window.__ae
   && window.__ae.ready())`.
2. Assert the view path: roster `count`/`labels`, `clips()`, and that the preview
   canvas (`[data-as="preview"]`) has non-transparent pixels.
3. **Snapshot the baked frame** (`preview.toDataURL()`) *before* editing.
4. `select` a poseable body, land on a frame, `setPose(true)`, read `bones()`,
   `nudge('arm1', 0.7)`, assert `authoredKeys() >= 1`, then `save()`.
5. Read the clips file back and assert it contains the new key **and** that the
   banner is preserved (byte-for-byte).
6. **Reload.** Assert `authoredKeys() >= 1` (the store loaded from the saved
   file), land on the same frame, snapshot again, and assert the baked frame
   **changed** — this is the real proof: the edit flowed file → store → bake.
7. Assert an unkeyed frame elsewhere is **unchanged** (inert-except-where-keyed).
8. **Restore the clips file** from the snapshot you took in step 0 — keep it
   non-destructive.

Also fail on console errors and unexpected 404s, as `verify.mjs` does.

---

## 2. Drift harness

Proves invariant 1 (inert until authored). Before and after *any* change to the
data channel (a package bump, a rig refactor, a new sampler path):

1. Bake **every** body under a fixed seed.
2. Checksum **every** frame.
3. Diff the checksums against the previous run.

**Zero diff = the channel is provably inert.** After authoring, the diff must be
*surgical*: an authored knight keyframe changes exactly that one body's swing
frames and nothing else. A drift anywhere you didn't key is a bug — usually an
absolute channel leaking (data-format §3), a bone-id remap (rule 4), or the bake
path no longer matching the render path.

---

## 3. Converted baseline

Instead of shipping an empty data file, capture the whole cast's *current*
procedural motion **as absolute keys**, so the file is a faithful, **editable**
copy of today's motion rather than a blank slate. Editing a value then edits the
animation directly, and unedited values replay byte-identically (invariant 2).

How: bake each body once with **recording on** (`beginBoneRecord()` … draw …
`endBoneRecord()`), and at each frame store each helper's captured `val` (the
absolute `BoneOffset` it computed — `{ang}` for FK, `{fx,fy}` for IK, `{dx,dy,rot}`
for the root; use `setBoneVal` for a root known only post-compute) as a key at
that frame's `t`. Because the bake samples exactly *on* keys, Rule A returns them
verbatim and the replay is pixel-identical.

**Gate the writer:** refuse to write the converted baseline unless replaying it
is pixel-identical to the procedural render. A single quantized float (invariant
2) or a one-sided absolute (data-format §3) will trip the gate — which is the
point.

---

## 4. Durable authored layer

If you ever regenerate the converted baseline wholesale (e.g. after tuning the
procedural motion), hand-authored polish keyed on top would be overwritten. Keep
that polish as an **idempotent edit spec** — named deltas applied onto the
freshly generated baseline keys — and re-apply it after every regeneration. That
way "regenerate baseline" and "keep my hand-tuned hits" stop being in tension.

---

## 5. Extraction parity (donor repo only)

`bridge/parity.test.ts` proves the standalone package is a faithful
generalization of the source game's animation channel: the package sampler and
the game sampler agree across the whole shipped baseline; the package emitter
writes **byte-identically** what the game's own Save endpoint writes; and
round-tripping the real `clips.ts` is data-lossless and a fixed point. This is
meaningful **only inside the donor game's repository** — it imports that game's
real data by design. **Delete `bridge/` when lifting the package into its own
repo**, and never try to run it in the standalone package (its imports won't
resolve). When adapting the package to a *new* game, this file is the model for a
parity test worth writing against that game's own sampler/emitter.

---

## 6. Debugging playbook

| Symptom | Likely cause | Fix |
|---|---|---|
| Edit shows in the studio but **not in the game** | The game bake doesn't sample the store, samples a different `(clip, t)` than the plan, uses a different `bodyId`, or imports a stale/copied clips object instead of the saved file | Ensure the bake calls `poseForFrame(store[bodyId], clip, t)` and threads `pose` into the rig; confirm `adapter.clips` is the *same* live object the game samples; confirm the `bodyId` matches on both sides |
| Edit doesn't show **even in the studio** | Body is view-only (no `bodyId` or no `renderPose`); `renderPose` doesn't record bones; or `adapter.clips` isn't the object being mutated (a copy) | Give the body a `bodyId` and a recording `renderPose`; pass the live store |
| An authored key **affects the wrong joint** / a bone jumped | Draw order changed → bone ids remapped (rule 4); or `resetBoneIds()` not run per body | Restore the original limb draw order; ensure `rootBone`/`resetBoneIds()` runs at the start of each body draw; re-author if order legitimately changed |
| Save produced a **huge or unstable diff** | Banner doesn't byte-match the file (whole-header reformat); pretty-printing crept in; a float got quantized; or a hand/tool edit left `keys` unsorted | Re-emit with the file's exact banner via `emitClipsModule`; keep the compact literal; never quantize; sort each `keys` array by `t` (data-format §6) |
| Converted baseline **not byte-identical** on replay | A float was quantized; an absolute channel is defined on only one surrounding key and the bake sampled between keys; bone ids drifted; or the captured `val` was wrong | Keep full precision; ensure captures land *on* keys; fix draw order; let the pixel-identical write gate catch it (§3) |
| A between-keys frame **snaps to procedural** on one axis | One-sided absolute channel — defined on one key but not the other (data-format §3, Rule C) | Define the absolute on *both* surrounding keys, or use a relative channel |
| An **attack's timing / a hazard beat moved** after authoring | A combat clip was marked `retimable`, or the game applies `duration` to combat clips | Mark only presentation clips (idle/walk/hit) `retimable`; keep attack tempo as combat data applied at play time (rule 5) |
| Studio preview looks right but the **game differs** | Not faithful by construction: `clips`/`plan` weren't derived from the same source the game bakes from, or `renderPose` diverges from the real bake | Derive `clips` and `plan` in one pass from the bake source; make `renderPose` draw through the same code the game bakes from (rule 3) |
| `save()` returns false / "no dev save endpoint" | The Vite plugin isn't mounted, the endpoint doesn't match, or you're on a static build (`apply: 'serve'` only) | Mount `animStudioSavePlugin` in `vite.config.ts`, match `endpoint` to `adapter.save.endpoint`, run the dev server; offline, use **copy JSON** |

---

## 7. Commands

In this repo (a host game wires equivalents into its own scripts):

- `npm run dev` — the demo studio at `/demo/`, the authoring workbench.
- `npm test` — `node:test` over the pure modules (`sample`, `emit`, `timeline`).
- `npm run verify` — the full headless authoring loop in Chromium (§1);
  non-destructive, restores `demo/clips.ts` afterward. Set `CHROMIUM_PATH` to a
  Chrome binary to skip Playwright's managed download.
- `npm run check` — strict `tsc --noEmit`.
- `npm run build` — bundle smoke check (there is no shipped dist; the package is
  consumed as source).

CI runs all of them. Requires Node ≥ 22.18. When wiring anim-studio into a game,
port the `npm run verify` pattern to that game's studio page so you have an
end-to-end proof the data channel works before trusting authored data in a build.
