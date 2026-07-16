/**
 * The studio itself — roster, preview, transport, pose-drag, dope sheet, GIF
 * export, Save. Mount it on a page with your {@link StudioAdapter}:
 *
 *   const api = await mountStudio(myAdapter);
 *
 * Engine-agnostic by design: everything the studio touches is a canvas or a
 * plain object the adapter hands over. The adapter's `clips` store is edited
 * IN PLACE, so a bake path that samples it live shows edits immediately.
 */
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import type { StudioAdapter, BodyDesc, BakedBody, ClipDef, VariantValues } from './adapter';
import type { Ease, Pose } from './types';
import type { BoneRec } from './rig';
import { boneScreen } from './rig';
import { samplePose } from './sample';
import { timelineFor, keyAt, clearKeyAt, prunedClips, countKeys, KEY_EPS } from './timeline';

// ---------------------------------------------------------------------------
// options + api
// ---------------------------------------------------------------------------
export interface StudioOptions {
  /** Where to mount (default `document.body`). */
  root?: HTMLElement;
  /** Window property to expose the headless-verification hook on
   *  (default `'__ae'`; `false` disables). */
  hook?: string | false;
}

/** The verification/debug surface (also exposed on `window` — see
 *  {@link StudioOptions.hook}) so a headless harness can drive the studio. */
export interface StudioApi {
  ready(): boolean;
  count(): number;
  labels(): string[];
  select(i: number): Promise<void>;
  setClip(i: number): void;
  clips(): string[];
  state(): { name: string; group: string; clip: string; frame: number; frames: number; poseable: boolean };
  setPose(on: boolean): void;
  bones(): { id: string; kind: string; x: number; y: number }[];
  nudge(boneId: string, dAng: number): void;
  authoredKeys(): number;
  save(): Promise<boolean>;
}

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// the shell
// ---------------------------------------------------------------------------
const CSS = `
.as-app { --bg:#0f1019; --panel:#171a2b; --panel2:#1e2238; --edge:#2b3050; --ink:#cfe3ff;
  --dim:#8c96bf; --accent:#73eff7; --accent2:#a7f070; --warn:#ffcd75; --sel:#2d3a6b; }
.as-app, .as-app * { box-sizing: border-box; }
.as-app { display:flex; flex-direction:column; height:100vh; margin:0; background:var(--bg); color:var(--ink);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size:12px; overflow:hidden; }
.as-app header { padding:8px 14px; border-bottom:1px solid var(--edge); display:flex; align-items:baseline;
  gap:12px; background:linear-gradient(180deg,#191d31,#12152300); }
.as-app header h1 { font-size:14px; margin:0; color:var(--accent); letter-spacing:.5px; }
.as-app header .sub { color:var(--dim); font-size:11px; }
.as-app header .status { margin-left:auto; color:var(--warn); font-size:11px; }
.as-main { flex:1; display:grid; grid-template-columns:250px 1fr 268px; min-height:0; }
.as-col { min-height:0; overflow:hidden; display:flex; flex-direction:column; }
.as-roster { border-right:1px solid var(--edge); background:var(--panel); }
.as-inspector { border-left:1px solid var(--edge); background:var(--panel); overflow-y:auto; }
.as-pad { padding:10px; }
.as-search { width:100%; padding:6px 8px; background:var(--panel2); border:1px solid var(--edge);
  color:var(--ink); border-radius:5px; font:inherit; }
.as-search::placeholder { color:var(--dim); }
.as-list { flex:1; overflow-y:auto; padding:4px; }
.as-grp { color:var(--dim); font-size:10px; text-transform:uppercase; letter-spacing:1px;
  padding:8px 6px 3px; position:sticky; top:0; background:var(--panel); }
.as-row { display:flex; align-items:center; gap:8px; padding:4px 6px; border-radius:5px; cursor:pointer; }
.as-row:hover { background:var(--panel2); }
.as-row.sel { background:var(--sel); outline:1px solid var(--accent); }
.as-row .thumb { width:34px; height:34px; image-rendering:pixelated; background:#0c0e17;
  border-radius:4px; object-fit:contain; flex:none; }
.as-row .nm { color:var(--ink); }
.as-row .ti { color:var(--dim); font-size:10px; }
.as-row .meta { overflow:hidden; }
.as-row .nm, .as-row .ti { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.as-stage { background: repeating-conic-gradient(#0c0e17 0% 25%, #10131f 0% 50%) 50% / 22px 22px;
  position:relative; align-items:stretch; }
.as-view { flex:1; display:flex; align-items:center; justify-content:center; min-height:0; position:relative; }
.as-preview { image-rendering:pixelated; }
.as-preview.posing { cursor:crosshair; }
.as-hud { position:absolute; top:8px; left:10px; color:var(--dim); font-size:11px;
  text-shadow:0 1px 2px #000; pointer-events:none; line-height:1.5; }
.as-transport { border-top:1px solid var(--edge); background:var(--panel);
  padding:8px 10px; display:flex; flex-direction:column; gap:8px; }
.as-clips { display:flex; gap:4px; flex-wrap:wrap; }
.as-clip { padding:4px 10px; border:1px solid var(--edge); background:var(--panel2);
  color:var(--dim); border-radius:5px; cursor:pointer; font:inherit; }
.as-clip.on { color:#0c0e17; background:var(--accent); border-color:var(--accent); font-weight:600; }
.as-tbar { display:flex; align-items:center; gap:8px; }
.as-tbar button { padding:4px 9px; border:1px solid var(--edge); background:var(--panel2);
  color:var(--ink); border-radius:5px; cursor:pointer; font:inherit; }
.as-tbar button:hover { border-color:var(--accent); }
.as-tbar button.play { background:var(--accent2); color:#0c0e17; border-color:var(--accent2); font-weight:600; }
.as-scrub { flex:1; accent-color:var(--accent); }
.as-tbar .fno { color:var(--dim); min-width:108px; text-align:right; font-variant-numeric:tabular-nums; }
.as-app label.chk { display:inline-flex; align-items:center; gap:5px; color:var(--dim); cursor:pointer; }
.as-dope { display:flex; gap:2px; align-items:center; height:20px; padding:0 2px; }
.as-dope .tick { flex:1; height:8px; border-radius:2px; background:var(--panel2); cursor:pointer; border:1px solid transparent; }
.as-dope .tick.here { border-color:var(--accent); height:14px; }
.as-dope .tick.key { background:var(--warn); height:12px; }
.as-dope .tick.key.here { background:var(--warn); border-color:var(--accent); height:16px; }
.as-sect { border-bottom:1px solid var(--edge); }
.as-sect h3 { font-size:11px; color:var(--accent2); margin:0; padding:9px 10px 5px;
  text-transform:uppercase; letter-spacing:1px; }
.as-field { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:3px 10px 3px; }
.as-field label { color:var(--dim); }
.as-field select, .as-field input[type="number"] { background:var(--panel2); border:1px solid var(--edge);
  color:var(--ink); border-radius:4px; padding:3px 6px; font:inherit; }
.as-row-btns { display:flex; gap:6px; padding:8px 10px; }
.as-row-btns a, .as-row-btns button { flex:1; text-align:center; text-decoration:none;
  padding:6px 8px; border:1px solid var(--edge); background:var(--panel2); color:var(--ink);
  border-radius:5px; cursor:pointer; font:inherit; }
.as-row-btns a:hover, .as-row-btns button:hover { border-color:var(--accent2); }
.as-note { color:var(--dim); font-size:10px; padding:6px 10px 12px; line-height:1.5; }
.as-hidden { display:none !important; }
.as-boot { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  color:var(--dim); background:var(--bg); z-index:5; }
.as-gif { color:var(--ink); }
`;

const SHELL = `
<header>
  <h1 data-as="title">Anim Studio</h1>
  <span class="sub" data-as="subtitle">skeletal pose / keyframe editor · dev tool</span>
  <span class="status" data-as="status">booting…</span>
</header>
<div class="as-main">
  <div class="as-col as-roster">
    <div class="as-pad"><input class="as-search" data-as="search" placeholder="search bodies…" /></div>
    <div class="as-list" data-as="list"></div>
  </div>
  <div class="as-col as-stage">
    <div class="as-view">
      <div class="as-hud" data-as="hud"></div>
      <canvas class="as-preview" data-as="preview" width="480" height="440"></canvas>
      <div class="as-boot" data-as="boot">baking the roster…</div>
    </div>
    <div class="as-transport">
      <div class="as-clips" data-as="clips"></div>
      <div class="as-tbar">
        <button class="play" data-as="playBtn">▶ play</button>
        <button data-as="stepBack">◀</button>
        <button data-as="stepFwd">▶</button>
        <input class="as-scrub" type="range" data-as="scrub" min="0" max="0" value="0" step="1" />
        <span class="fno" data-as="fno">frame 0 / 0</span>
      </div>
      <div class="as-tbar">
        <label class="chk"><input type="checkbox" data-as="onion" /> onion skin</label>
        <label class="chk"><input type="checkbox" data-as="guides" checked /> guides</label>
        <label class="chk">zoom <input type="range" data-as="zoom" min="1" max="14" value="8" step="1" style="width:120px;accent-color:var(--accent)" /></label>
        <span style="flex:1"></span>
        <a class="as-gif" data-as="gif" download="clip.gif" href="#">⬇ export GIF</a>
      </div>
      <div class="as-tbar">
        <label class="chk"><input type="checkbox" data-as="poseEdit" /> <b style="color:var(--accent)">pose edit</b></label>
        <button data-as="keyBtn">◆ set key</button>
        <button data-as="unkeyBtn">◇ clear key</button>
        <span class="fno" data-as="keyInfo" style="min-width:150px;text-align:left">drag a joint to pose</span>
        <span style="flex:1"></span>
        <button data-as="resetClip">reset clip</button>
      </div>
      <div class="as-dope" data-as="dope" title="keyframes on the clip timeline"></div>
    </div>
  </div>
  <div class="as-col as-inspector">
    <div class="as-sect as-hidden" data-as="variantSect">
      <h3>Options</h3>
      <div data-as="variants"></div>
    </div>
    <div class="as-sect">
      <h3>Selection</h3>
      <div class="as-field"><label>name</label><span data-as="iName">—</span></div>
      <div class="as-field"><label>group</label><span data-as="iKind">—</span></div>
      <div class="as-field"><label>frame size</label><span data-as="iSize">—</span></div>
      <div data-as="iInfo"></div>
    </div>
    <div class="as-sect">
      <h3>Clip timing</h3>
      <div class="as-field"><label>duration (ms)</label>
        <input type="number" data-as="cDur" min="60" max="4000" step="10" style="width:78px" /></div>
      <div class="as-field"><label>frames</label><span data-as="iFrames">—</span></div>
    </div>
    <div class="as-sect">
      <h3>Keyframe</h3>
      <div class="as-field"><label>ease in</label>
        <select data-as="kEase">
          <option value="linear">linear</option>
          <option value="easeIn">ease in</option>
          <option value="easeOut">ease out</option>
          <option value="easeInOut">ease in-out</option>
        </select>
      </div>
      <div class="as-field"><label>keys in clip</label><span data-as="kCount">0</span></div>
      <div class="as-row-btns">
        <button data-as="saveBtn">💾 Save</button>
        <button data-as="copyBtn">copy JSON</button>
      </div>
      <div class="as-note" data-as="saveNote">Save POSTs the authored store to the dev endpoint; commit to seal it.</div>
    </div>
    <div class="as-note">
      Pick a body, choose a clip, scrub or play the real baked animation, onion-skin
      the motion, export a GIF. Turn on <b>pose edit</b> to drag joints (cyan=arm ·
      green=foot · amber=body root), keyframe with easing, and Save.
    </div>
  </div>
</div>
`;

// ---------------------------------------------------------------------------
// mount
// ---------------------------------------------------------------------------
export async function mountStudio(host: StudioAdapter, opts: StudioOptions = {}): Promise<StudioApi> {
  const rootEl = opts.root ?? document.body;
  const app = document.createElement('div');
  app.className = 'as-app';
  const style = document.createElement('style');
  style.textContent = CSS;
  app.appendChild(style);
  app.insertAdjacentHTML('beforeend', SHELL);
  rootEl.appendChild(app);

  const $ = <T extends HTMLElement>(name: string): T => app.querySelector(`[data-as="${name}"]`) as T;
  const listEl = $<HTMLDivElement>('list');
  const searchEl = $<HTMLInputElement>('search');
  const previewEl = $<HTMLCanvasElement>('preview');
  const pctx = previewEl.getContext('2d')!;
  const clipsEl = $<HTMLDivElement>('clips');
  const scrubEl = $<HTMLInputElement>('scrub');
  const fnoEl = $<HTMLSpanElement>('fno');
  const hudEl = $<HTMLDivElement>('hud');
  const playBtn = $<HTMLButtonElement>('playBtn');
  const onionEl = $<HTMLInputElement>('onion');
  const guidesEl = $<HTMLInputElement>('guides');
  const zoomEl = $<HTMLInputElement>('zoom');
  const gifEl = $<HTMLAnchorElement>('gif');
  const bootEl = $<HTMLDivElement>('boot');
  const statusEl = $<HTMLSpanElement>('status');
  const variantSect = $<HTMLDivElement>('variantSect');
  const variantsEl = $<HTMLDivElement>('variants');
  const iName = $<HTMLSpanElement>('iName');
  const iKind = $<HTMLSpanElement>('iKind');
  const iSize = $<HTMLSpanElement>('iSize');
  const iInfo = $<HTMLDivElement>('iInfo');
  const iFrames = $<HTMLSpanElement>('iFrames');
  const poseEditEl = $<HTMLInputElement>('poseEdit');
  const keyBtn = $<HTMLButtonElement>('keyBtn');
  const unkeyBtn = $<HTMLButtonElement>('unkeyBtn');
  const keyInfo = $<HTMLSpanElement>('keyInfo');
  const dopeEl = $<HTMLDivElement>('dope');
  const cDur = $<HTMLInputElement>('cDur');
  const kEase = $<HTMLSelectElement>('kEase');
  const kCount = $<HTMLSpanElement>('kCount');
  const saveBtn = $<HTMLButtonElement>('saveBtn');
  const copyBtn = $<HTMLButtonElement>('copyBtn');
  const saveNote = $<HTMLDivElement>('saveNote');

  if (host.title) $('title').textContent = host.title;
  if (host.subtitle) $('subtitle').textContent = host.subtitle;
  if (host.save?.hint) saveNote.textContent = host.save.hint;
  const endpoint = host.save?.endpoint ?? '/__anim/save';
  const store = host.clips;

  if (host.ready) await host.ready();
  const roster: BodyDesc[] = await host.bodies();

  // -------------------------------------------------------------------------
  // baking (memoised per body + variant values)
  // -------------------------------------------------------------------------
  const variantValues = new Map<string, VariantValues>();
  function variantsFor(row: BodyDesc): VariantValues {
    let v = variantValues.get(row.id);
    if (!v) {
      v = {};
      for (const def of row.variants ?? []) v[def.id] = def.kind === 'toggle' ? (def.value ?? false) : (def.value ?? def.options[0]?.value ?? '');
      variantValues.set(row.id, v);
    }
    return v;
  }

  interface Baked {
    body: BakedBody;
    bounds: Bounds;
  }
  const bakeCache = new Map<string, Promise<Baked | null>>();
  function bakeOf(row: BodyDesc): Promise<Baked | null> {
    const vals = variantsFor(row);
    const key = row.id + ' ' + JSON.stringify(vals);
    let p = bakeCache.get(key);
    if (!p) {
      p = Promise.resolve(host.bake(row, vals)).then((body) => (body ? { body, bounds: contentBounds(body) } : null));
      bakeCache.set(key, p);
    }
    return p;
  }

  // scan the sheet's alpha to find the real content box (the frame cell is
  // usually padded for the swing arc, so much of it is transparent margin).
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d', { willReadFrequently: true })!;
  function contentBounds(body: BakedBody): Bounds {
    const { frameW: fw, frameH: fh, clips } = body;
    scratch.width = fw;
    scratch.height = fh;
    const seen = new Set<number>();
    clips.forEach((c) => c.frames.forEach((f) => seen.add(f)));
    let minX = fw, minY = fh, maxX = 0, maxY = 0, any = false;
    for (const fi of seen) {
      const r = body.frame(fi);
      if (!r) continue;
      sctx.clearRect(0, 0, fw, fh);
      sctx.imageSmoothingEnabled = false;
      sctx.drawImage(r.src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      const d = sctx.getImageData(0, 0, fw, fh).data;
      for (let y = 0; y < fh; y++) {
        for (let x = 0; x < fw; x++) {
          if (d[(y * fw + x) * 4 + 3] > 16) {
            any = true;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
    }
    if (!any) return { x: 0, y: 0, w: fw, h: fh };
    minX = Math.max(0, minX - 2);
    minY = Math.max(0, minY - 2);
    maxX = Math.min(fw - 1, maxX + 2);
    maxY = Math.min(fh - 1, maxY + 2);
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  // -------------------------------------------------------------------------
  // state
  // -------------------------------------------------------------------------
  let selected = 0;
  let current: Baked | null = null;
  let clipIdx = 0;
  let frameIdx = 0;
  let poseMode = false;
  let handles: { bone: BoneRec; x: number; y: number }[] = [];
  let lastView = { dx: 0, dy: 0, scale: 1 };
  let drag:
    | {
        bone: BoneRec;
        pivotX: number;
        pivotY: number;
        downAng: number;
        baseAng: number;
        downX: number;
        downY: number;
        baseIkDx: number;
        baseIkDy: number;
      }
    | null = null;

  const poseable = (): boolean => !!current?.body.bodyId && !!current.body.renderPose;

  function activeClip(): ClipDef | null {
    return current ? (current.body.clips[clipIdx] ?? null) : null;
  }

  /** Preview delays honouring an authored duration on retimable clips. */
  function effDelays(clip: ClipDef): number[] {
    const bodyId = current?.body.bodyId;
    const ms = bodyId ? store[bodyId]?.[clip.clipKey]?.duration : undefined;
    if (ms && clip.retimable) return clip.frames.map(() => ms / clip.frames.length);
    return clip.delays;
  }

  /** The plan entry (authored clip id + clip-time) at the current frame. */
  function curDrive(): { clip: string; t: number; fi: number } | null {
    const clip = activeClip();
    if (!current || !clip) return null;
    const fi = clip.frames[frameIdx] ?? clip.frames[0];
    const pf = current.body.plan[fi];
    if (!pf) return null;
    return { clip: pf.clip, t: pf.t, fi };
  }

  // -------------------------------------------------------------------------
  // preview render
  // -------------------------------------------------------------------------
  function fitScale(fw: number, fh: number): number {
    const max = Math.max(1, Math.floor(Math.min((previewEl.width - 24) / fw, (previewEl.height - 24) / fh)));
    return Math.max(1, Math.min(Number(zoomEl.value), max));
  }

  function viewTransform(b: Bounds): { dx: number; dy: number; scale: number } {
    const scale = fitScale(b.w, b.h);
    const dx = Math.round(previewEl.width / 2 - (b.x + b.w / 2) * scale);
    const dy = Math.round(previewEl.height / 2 - (b.y + b.h / 2) * scale);
    return { dx, dy, scale };
  }

  function blit(fi: number, scale: number, dx: number, dy: number, alpha: number): void {
    if (!current) return;
    const r = current.body.frame(fi);
    if (!r) return;
    pctx.globalAlpha = alpha;
    pctx.imageSmoothingEnabled = false;
    pctx.drawImage(r.src, r.x, r.y, r.w, r.h, dx, dy, r.w * scale, r.h * scale);
    pctx.globalAlpha = 1;
  }

  function drawGuides(b: Bounds, dx: number, dy: number, scale: number, fw: number): void {
    if (!guidesEl.checked) return;
    pctx.strokeStyle = 'rgba(115,239,247,0.26)';
    pctx.lineWidth = 1;
    const groundY = dy + (b.y + b.h) * scale - 2; // feet ~2px above content bottom
    pctx.beginPath();
    pctx.moveTo(dx + (b.x - 4) * scale, groundY + 0.5);
    pctx.lineTo(dx + (b.x + b.w + 4) * scale, groundY + 0.5);
    pctx.stroke();
    const ox = dx + Math.round((fw / 2) * scale); // origin of the padded cell
    pctx.strokeStyle = 'rgba(167,240,112,0.22)';
    pctx.beginPath();
    pctx.moveTo(ox + 0.5, dy + (b.y - 6) * scale);
    pctx.lineTo(ox + 0.5, dy + (b.y + b.h + 6) * scale);
    pctx.stroke();
  }

  /** The bake-path preview: blit real baked frames of the current clip. */
  function renderBaked(): void {
    const clip = activeClip();
    pctx.clearRect(0, 0, previewEl.width, previewEl.height);
    if (!current || !clip) return;
    const { frameW: fw } = current.body;
    const bounds = current.bounds;
    const { dx, dy, scale } = viewTransform(bounds);
    drawGuides(bounds, dx, dy, scale, fw);

    const fi = clip.frames[frameIdx] ?? clip.frames[0];
    if (onionEl.checked && clip.frames.length > 1) {
      const prev = clip.frames[(frameIdx - 1 + clip.frames.length) % clip.frames.length];
      const next = clip.frames[(frameIdx + 1) % clip.frames.length];
      blit(prev, scale, dx, dy, 0.2);
      blit(next, scale, dx, dy, 0.2);
    }
    blit(fi, scale, dx, dy, 1);

    hudEl.textContent = `${clip.name}  ·  frame ${fi}  ·  ${bounds.w}×${bounds.h}px  ·  ${scale}×`;
    fnoEl.textContent = `frame ${frameIdx + 1} / ${clip.frames.length}`;
    scrubEl.value = String(frameIdx);
  }

  /** Pose mode: direct-draw the current frame at its drive + authored pose,
   *  then overlay draggable joint handles at the discovered bone pivots. */
  function renderPoseMode(): void {
    const clip = activeClip();
    pctx.clearRect(0, 0, previewEl.width, previewEl.height);
    const d = curDrive();
    if (!current || !clip || !d || !current.body.renderPose) return;
    const bodyId = current.body.bodyId;
    const tl = bodyId ? store[bodyId]?.[d.clip] : undefined;
    const pose: Pose | undefined = samplePose(tl, d.t);
    const posed = current.body.renderPose(d.fi, pose);
    if (!posed) return;
    const b = current.bounds;
    const { dx, dy, scale } = viewTransform(b);
    lastView = { dx, dy, scale };
    drawGuides(b, dx, dy, scale, current.body.frameW);
    pctx.imageSmoothingEnabled = false;
    pctx.drawImage(posed.canvas, 0, 0, posed.fw, posed.fh, dx, dy, posed.fw * scale, posed.fh * scale);

    handles = posed.bones.map((bone) => ({ bone, ...boneScreen(bone, dx, dy, scale) }));
    for (const h of handles) {
      const off = pose?.[h.bone.id];
      const keyed = !!off && ((off.dAng ?? 0) !== 0 || (off.ikDx ?? 0) !== 0 || (off.ikDy ?? 0) !== 0);
      const col = h.bone.kind === 'leg' ? '#a7f070' : h.bone.kind === 'root' ? '#ffcd75' : '#73eff7';
      pctx.beginPath();
      pctx.arc(h.x, h.y, keyed ? 6.5 : 4.5, 0, 7);
      pctx.fillStyle = keyed ? col : col + '88';
      pctx.fill();
      pctx.lineWidth = 1.5;
      pctx.strokeStyle = '#0c0e17';
      pctx.stroke();
    }

    hudEl.textContent = `${clip.name} · frame ${d.fi} · POSE EDIT — drag a joint (cyan=arm · green=foot · amber=body)`;
    fnoEl.textContent = `frame ${frameIdx + 1} / ${clip.frames.length}`;
    scrubEl.value = String(frameIdx);
  }

  function render(): void {
    if (poseMode && poseable()) renderPoseMode();
    else renderBaked();
    updateKeyUI();
  }

  // -------------------------------------------------------------------------
  // pose dragging
  // -------------------------------------------------------------------------
  function pointerPos(e: PointerEvent): [number, number] {
    const r = previewEl.getBoundingClientRect();
    return [(e.clientX - r.left) * (previewEl.width / r.width), (e.clientY - r.top) * (previewEl.height / r.height)];
  }

  previewEl.addEventListener('pointerdown', (e) => {
    if (!poseMode || !poseable()) return;
    const d = curDrive();
    const bodyId = current?.body.bodyId;
    if (!d || !bodyId) return;
    const [mx, my] = pointerPos(e);
    let bone: BoneRec | null = null;
    let best = 15 * 15;
    let hx = 0;
    let hy = 0;
    for (const h of handles) {
      const ddx = mx - h.x;
      const ddy = my - h.y;
      const dd = ddx * ddx + ddy * ddy;
      if (dd < best) {
        best = dd;
        bone = h.bone;
        hx = h.x;
        hy = h.y;
      }
    }
    if (!bone) return;
    e.preventDefault();
    previewEl.setPointerCapture(e.pointerId);
    setPlaying(false);
    const tl = timelineFor(store, bodyId, d.clip, true)!;
    const k = keyAt(tl, d.t, true, (kEase.value as Ease) || 'linear')!;
    const off = (k.pose[bone.id] ??= {});
    drag = {
      bone,
      pivotX: hx,
      pivotY: hy,
      downAng: Math.atan2(my - hy, mx - hx),
      baseAng: off.dAng ?? 0,
      downX: mx,
      downY: my,
      baseIkDx: off.ikDx ?? 0,
      baseIkDy: off.ikDy ?? 0,
    };
  });

  previewEl.addEventListener('pointermove', (e) => {
    const bodyId = current?.body.bodyId;
    if (!drag || !bodyId) return;
    const d = curDrive();
    if (!d) return;
    const [mx, my] = pointerPos(e);
    const tl = timelineFor(store, bodyId, d.clip, true)!;
    const k = keyAt(tl, d.t, true, (kEase.value as Ease) || 'linear')!;
    const off = (k.pose[drag.bone.id] ??= {});
    if (drag.bone.end || drag.bone.kind === 'leg') {
      off.ikDx = drag.baseIkDx + (mx - drag.downX) / lastView.scale;
      off.ikDy = drag.baseIkDy + (my - drag.downY) / lastView.scale;
    } else {
      let delta = Math.atan2(my - drag.pivotY, mx - drag.pivotX) - drag.downAng;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      off.dAng = drag.baseAng + delta;
    }
    render();
  });

  function endDrag(e: PointerEvent): void {
    if (!drag) return;
    drag = null;
    try {
      previewEl.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    render();
  }
  previewEl.addEventListener('pointerup', endDrag);
  previewEl.addEventListener('pointercancel', endDrag);

  // -------------------------------------------------------------------------
  // dope sheet + keyframe UI
  // -------------------------------------------------------------------------
  function clipDurationMs(): number {
    const clip = activeClip();
    return clip ? Math.round(effDelays(clip).reduce((a, c) => a + c, 0)) : 0;
  }

  function renderDope(): void {
    dopeEl.innerHTML = '';
    const clip = activeClip();
    if (!current || !clip) return;
    const bodyId = current.body.bodyId;
    clip.frames.forEach((fi, i) => {
      const pf = current?.body.plan[fi];
      if (!pf) return;
      const tl = bodyId ? store[bodyId]?.[pf.clip] : undefined;
      const keyed = !!tl?.keys.some((kf) => Math.abs(kf.t - pf.t) < KEY_EPS);
      const el = document.createElement('div');
      el.className = 'tick' + (keyed ? ' key' : '') + (i === frameIdx ? ' here' : '');
      el.title = `frame ${fi}` + (keyed ? ' · keyed' : '');
      el.onclick = () => {
        setPlaying(false);
        frameIdx = i;
        render();
      };
      dopeEl.appendChild(el);
    });
  }

  function updateKeyUI(): void {
    const bodyId = current?.body.bodyId;
    if (!poseable() || !bodyId) {
      dopeEl.innerHTML = '';
      keyInfo.textContent = current && !poseable() ? 'this body has no pose rig (view only)' : '';
      kCount.textContent = '0';
      return;
    }
    renderDope();
    const d = curDrive();
    if (!d) return;
    const tl = store[bodyId]?.[d.clip];
    const k = tl?.keys.find((kf) => Math.abs(kf.t - d.t) < KEY_EPS);
    keyInfo.textContent = k ? `◆ key @ ${d.clip} t=${d.t.toFixed(2)}` : `frame ${d.fi} · drag or “set key”`;
    kCount.textContent = String(tl?.keys.length ?? 0);
    if (k?.ease) kEase.value = k.ease;
    cDur.value = String(tl?.duration ?? clipDurationMs());
  }

  // -------------------------------------------------------------------------
  // transport (play loop)
  // -------------------------------------------------------------------------
  let playing = true;
  let acc = 0;
  let last = 0;
  let alive = true;

  function tick(now: number): void {
    if (!alive) return;
    const clip = activeClip();
    if (playing && clip && clip.frames.length > 1) {
      if (!last) last = now;
      acc += now - last;
      const delays = effDelays(clip);
      let guard = 0;
      while (acc >= Math.max(30, delays[frameIdx] ?? 120) && guard++ < 8) {
        acc -= Math.max(30, delays[frameIdx] ?? 120);
        frameIdx = (frameIdx + 1) % clip.frames.length;
      }
      render();
    }
    last = now;
    requestAnimationFrame(tick);
  }

  function setPlaying(p: boolean): void {
    playing = p;
    acc = 0;
    last = 0;
    playBtn.textContent = p ? '❚❚ pause' : '▶ play';
    playBtn.classList.toggle('play', !p);
  }

  function setClip(i: number): void {
    clipIdx = i;
    frameIdx = 0;
    acc = 0;
    const clip = activeClip();
    scrubEl.max = String(Math.max(0, (clip?.frames.length ?? 1) - 1));
    renderClipTabs();
    updateInspector();
    render();
  }

  function renderClipTabs(): void {
    clipsEl.innerHTML = '';
    if (!current) return;
    current.body.clips.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'as-clip' + (i === clipIdx ? ' on' : '');
      b.textContent = c.name;
      b.onclick = () => setClip(i);
      clipsEl.appendChild(b);
    });
  }

  // -------------------------------------------------------------------------
  // GIF export
  // -------------------------------------------------------------------------
  function b64(bytes: Uint8Array): string {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(s);
  }

  function exportGif(): void {
    const clip = activeClip();
    if (!current || !clip) return;
    const b = current.bounds;
    const scale = Math.max(3, fitScale(b.w, b.h));
    const delays = effDelays(clip);
    const enc = GIFEncoder();
    const c = document.createElement('canvas');
    c.width = b.w * scale;
    c.height = b.h * scale;
    const cx = c.getContext('2d')!;
    cx.imageSmoothingEnabled = false;
    clip.frames.forEach((fi, i) => {
      const r = current!.body.frame(fi);
      if (!r) return;
      cx.clearRect(0, 0, c.width, c.height);
      cx.fillStyle = '#14161f';
      cx.fillRect(0, 0, c.width, c.height);
      cx.drawImage(r.src, r.x, r.y, r.w, r.h, -b.x * scale, -b.y * scale, r.w * scale, r.h * scale);
      const { data, width, height } = cx.getImageData(0, 0, c.width, c.height);
      const pal = quantize(data, 256);
      enc.writeFrame(applyPalette(data, pal), width, height, { palette: pal, delay: Math.max(30, Math.round(delays[i] ?? 120)) });
    });
    enc.finish();
    gifEl.href = 'data:image/gif;base64,' + b64(enc.bytes());
    gifEl.download = `${roster[selected].label.replace(/\s+/g, '-')}-${clip.name.replace(/\s+/g, '')}.gif`;
  }

  // -------------------------------------------------------------------------
  // inspector + variants + selection
  // -------------------------------------------------------------------------
  function updateInspector(): void {
    const row = roster[selected];
    iName.textContent = row.label;
    iKind.textContent = row.group ?? '—';
    iSize.textContent = current ? `${current.body.frameW}×${current.body.frameH}` : '—';
    iInfo.innerHTML = '';
    for (const [k, v] of Object.entries(current?.body.info ?? {})) {
      const f = document.createElement('div');
      f.className = 'as-field';
      const l = document.createElement('label');
      l.textContent = k;
      const s = document.createElement('span');
      s.textContent = v;
      f.append(l, s);
      iInfo.appendChild(f);
    }
    const clip = activeClip();
    iFrames.textContent = clip ? String(clip.frames.length) : '—';
    if (clip) cDur.value = String(Math.round(effDelays(clip).reduce((a, b2) => a + b2, 0)));
    renderVariants(row);
  }

  function renderVariants(row: BodyDesc): void {
    const defs = row.variants ?? [];
    variantSect.classList.toggle('as-hidden', defs.length === 0);
    variantsEl.innerHTML = '';
    if (!defs.length) return;
    const vals = variantsFor(row);
    for (const def of defs) {
      const f = document.createElement('div');
      f.className = 'as-field';
      const l = document.createElement('label');
      l.textContent = def.label;
      f.appendChild(l);
      if (def.kind === 'select') {
        const sel = document.createElement('select');
        for (const o of def.options) {
          const op = document.createElement('option');
          op.value = o.value;
          op.textContent = o.label;
          sel.appendChild(op);
        }
        sel.value = String(vals[def.id]);
        sel.onchange = () => {
          vals[def.id] = sel.value;
          void selectRow(selected);
        };
        f.appendChild(sel);
      } else {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!vals[def.id];
        cb.onchange = () => {
          vals[def.id] = cb.checked;
          void selectRow(selected);
        };
        f.appendChild(cb);
      }
      variantsEl.appendChild(f);
    }
  }

  let selectToken = 0;
  async function selectRow(i: number): Promise<void> {
    if (i < 0 || i >= roster.length) return;
    selected = i;
    const token = ++selectToken;
    const baked = await bakeOf(roster[i]);
    if (token !== selectToken) return; // a newer selection superseded this one
    current = baked;
    clipIdx = 0;
    frameIdx = 0;
    if (current) {
      const max = Math.max(1, Math.floor(Math.min((previewEl.width - 24) / current.bounds.w, (previewEl.height - 24) / current.bounds.h)));
      zoomEl.value = String(Math.min(Number(zoomEl.max), max));
    }
    poseEditEl.disabled = !poseable();
    poseMode = poseable() && poseEditEl.checked;
    previewEl.classList.toggle('posing', poseMode);
    const clip = activeClip();
    scrubEl.max = String(Math.max(0, (clip?.frames.length ?? 1) - 1));
    setPlaying(true);
    renderClipTabs();
    updateInspector();
    renderList();
    render();
  }

  // -------------------------------------------------------------------------
  // roster list (grouped, searchable, with lazy thumbnails)
  // -------------------------------------------------------------------------
  const thumbCache = new Map<string, string | null>();
  function thumbInto(row: BodyDesc, img: HTMLImageElement): void {
    if (row.variants?.length) return; // variant bodies' thumbs depend on loadout; skip
    if (thumbCache.has(row.id)) {
      const png = thumbCache.get(row.id);
      if (png) img.src = png;
      return;
    }
    void bakeOf(row).then((baked) => {
      const r = baked?.body.frame(0);
      if (!r) {
        thumbCache.set(row.id, null);
        return;
      }
      const c = document.createElement('canvas');
      c.width = r.w * 2;
      c.height = r.h * 2;
      const cx = c.getContext('2d')!;
      cx.imageSmoothingEnabled = false;
      cx.drawImage(r.src, r.x, r.y, r.w, r.h, 0, 0, r.w * 2, r.h * 2);
      const png = c.toDataURL('image/png');
      thumbCache.set(row.id, png);
      img.src = png;
    });
  }

  function renderList(): void {
    const q = searchEl.value.trim().toLowerCase();
    const match = (r: BodyDesc): boolean => !q || r.label.toLowerCase().includes(q) || (r.title ?? '').toLowerCase().includes(q);
    listEl.innerHTML = '';
    let lastGroup: string | null = null;
    roster.forEach((row, i) => {
      if (!match(row)) return;
      const grp = row.group ?? '';
      if (grp !== lastGroup) {
        if (grp) {
          const g = document.createElement('div');
          g.className = 'as-grp';
          g.textContent = grp;
          listEl.appendChild(g);
        }
        lastGroup = grp;
      }
      const el = document.createElement('div');
      el.className = 'as-row' + (i === selected ? ' sel' : '');
      el.onclick = () => void selectRow(i);
      const img = document.createElement('img');
      img.className = 'thumb';
      thumbInto(row, img);
      const meta = document.createElement('div');
      meta.className = 'meta';
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = row.label;
      const ti = document.createElement('div');
      ti.className = 'ti';
      ti.textContent = row.title ?? '';
      meta.appendChild(nm);
      meta.appendChild(ti);
      el.appendChild(img);
      el.appendChild(meta);
      listEl.appendChild(el);
    });
  }

  // -------------------------------------------------------------------------
  // save
  // -------------------------------------------------------------------------
  async function saveClips(): Promise<boolean> {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clips: prunedClips(store) }),
      });
      saveNote.textContent = res.ok ? '✓ saved — commit to seal it.' : `save failed (${res.status}); use copy JSON.`;
      return res.ok;
    } catch {
      saveNote.textContent = 'no dev save endpoint; use copy JSON.';
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // wiring
  // -------------------------------------------------------------------------
  searchEl.oninput = () => renderList();
  playBtn.onclick = () => setPlaying(!playing);
  const stepBack = $('stepBack');
  const stepFwd = $('stepFwd');
  stepBack.onclick = () => {
    const clip = activeClip();
    if (!clip) return;
    setPlaying(false);
    frameIdx = (frameIdx - 1 + clip.frames.length) % clip.frames.length;
    render();
  };
  stepFwd.onclick = () => {
    const clip = activeClip();
    if (!clip) return;
    setPlaying(false);
    frameIdx = (frameIdx + 1) % clip.frames.length;
    render();
  };
  scrubEl.oninput = () => {
    setPlaying(false);
    frameIdx = Number(scrubEl.value);
    render();
  };
  onionEl.onchange = () => render();
  guidesEl.onchange = () => render();
  zoomEl.oninput = () => render();
  gifEl.onclick = () => exportGif();

  poseEditEl.onchange = () => {
    poseMode = poseEditEl.checked;
    previewEl.classList.toggle('posing', poseMode && poseable());
    render();
  };
  keyBtn.onclick = () => {
    const d = curDrive();
    const bodyId = current?.body.bodyId;
    if (!poseMode || !bodyId || !d) return;
    keyAt(timelineFor(store, bodyId, d.clip, true)!, d.t, true, (kEase.value as Ease) || 'linear');
    render();
  };
  unkeyBtn.onclick = () => {
    const d = curDrive();
    const bodyId = current?.body.bodyId;
    if (!bodyId || !d) return;
    const tl = store[bodyId]?.[d.clip];
    if (tl) clearKeyAt(tl, d.t);
    render();
  };
  kEase.onchange = () => {
    const d = curDrive();
    const bodyId = current?.body.bodyId;
    if (!bodyId || !d) return;
    const k = store[bodyId]?.[d.clip]?.keys.find((kf) => Math.abs(kf.t - d.t) < KEY_EPS);
    if (k) {
      k.ease = kEase.value as Ease;
      render();
    }
  };
  cDur.onchange = () => {
    const d = curDrive();
    const bodyId = current?.body.bodyId;
    if (!bodyId || !d) return;
    timelineFor(store, bodyId, d.clip, true)!.duration = Number(cDur.value) || undefined;
  };
  $('resetClip').onclick = () => {
    const d = curDrive();
    const bodyId = current?.body.bodyId;
    if (!bodyId || !d) return;
    const bc = store[bodyId];
    if (bc) delete bc[d.clip];
    render();
  };
  saveBtn.onclick = () => void saveClips();
  copyBtn.onclick = () => {
    void navigator.clipboard?.writeText(JSON.stringify(prunedClips(store), null, 2));
    saveNote.textContent = 'copied JSON to clipboard.';
  };
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === ' ') {
      e.preventDefault();
      setPlaying(!playing);
    } else if (e.key === 'ArrowLeft') stepBack.click();
    else if (e.key === 'ArrowRight') stepFwd.click();
  });

  // -------------------------------------------------------------------------
  // api / hook + boot
  // -------------------------------------------------------------------------
  let booted = false;
  const api: StudioApi = {
    ready: () => booted,
    count: () => roster.length,
    labels: () => roster.map((r) => r.label),
    select: selectRow,
    setClip,
    clips: () => (current ? current.body.clips.map((c) => c.name) : []),
    state: () => {
      const clip = activeClip();
      return {
        name: roster[selected].label,
        group: roster[selected].group ?? '',
        clip: clip?.name ?? '—',
        frame: frameIdx,
        frames: clip?.frames.length ?? 0,
        poseable: poseable(),
      };
    },
    setPose: (on: boolean) => {
      poseMode = on && poseable();
      poseEditEl.checked = poseMode;
      previewEl.classList.toggle('posing', poseMode);
      render();
    },
    bones: () => handles.map((h) => ({ id: h.bone.id, kind: h.bone.kind, x: h.x, y: h.y })),
    nudge: (boneId: string, dAng: number) => {
      const d = curDrive();
      const bodyId = current?.body.bodyId;
      if (!bodyId || !d) return;
      const k = keyAt(timelineFor(store, bodyId, d.clip, true)!, d.t, true, (kEase.value as Ease) || 'linear')!;
      const off = (k.pose[boneId] ??= {});
      off.dAng = (off.dAng ?? 0) + dAng;
      render();
    },
    authoredKeys: () => countKeys(store),
    save: saveClips,
  };
  if (opts.hook !== false) {
    (window as unknown as Record<string, unknown>)[opts.hook ?? '__ae'] = api;
  }

  bootEl.classList.add('as-hidden');
  statusEl.textContent = `${roster.length} bodies`;
  renderList();
  await selectRow(0);
  booted = true;
  requestAnimationFrame(tick);
  window.addEventListener('beforeunload', () => {
    alive = false;
  });
  return api;
}
