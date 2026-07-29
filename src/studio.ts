/**
 * The studio itself — two modes over one roster:
 *
 *  - ANIMATE: preview real baked clips, drag joints to pose, keyframe with
 *    easing, move/copy/paste keys on the dope sheet, retime clips, Save.
 *  - ASSEMBLE: build characters from imported image parts — bones, hierarchy,
 *    joints (see assembly.ts) — which then join the roster as poseable bodies
 *    with fully user-defined (CRUD + renamable) clips.
 *
 * Mount it on a page with your {@link StudioAdapter}:
 *
 *   const api = await mountStudio(myAdapter);
 *
 * Engine-agnostic by design: everything the studio touches is a canvas or a
 * plain object the adapter hands over. The adapter's `clips` store is edited
 * IN PLACE, so a bake path that samples it live shows edits immediately.
 */
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import type { StudioAdapter, BodyDesc, BakedBody, ClipDef, VariantValues } from './adapter';
import type { Ease, Pose, Keyframe } from './types';
import type { BoneRec } from './rig';
import { boneScreen } from './rig';
import { samplePose } from './sample';
import { timelineFor, keyAt, clearKeyAt, prunedClips, countKeys, KEY_EPS } from './timeline';
import { History } from './history.ts';
import type { SkeletonDoc, SkelPart } from './skeleton.ts';
import {
  SKEL_PREFIX, skelBodyId, isSkelBodyId, packSkeletons, unpackSkeletons,
  snapshotDoc, restoreDoc, clampJointAngle, boneById as skelBoneById,
  addBone as skelAddBone, addClip as skelAddClip, renameClip as skelRenameClip,
  removeClip as skelRemoveClip, duplicateClip as skelDuplicateClip, patchClip as skelPatchClip,
  renameBone as skelRenameBone, reparentBone as skelReparentBone,
} from './skeleton.ts';
import { skeletonBody, preloadSkeleton } from './skeleton-render.ts';
import { mountAssembly } from './assembly.ts';
import type { AddBoneOpts, SkelBone, SkelAttachment } from './skeleton.ts';

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

export type StudioMode = 'animate' | 'assemble';

/** The verification/debug surface (also exposed on `window` — see
 *  {@link StudioOptions.hook}) so a headless harness or an agent can drive the
 *  studio: the whole authoring loop, keyframe/clip CRUD, and Assemble mode. */
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
  // mode + history
  mode(): StudioMode;
  setMode(m: StudioMode): void;
  undo(): string | null;
  redo(): string | null;
  // keyframe CRUD (current body + clip)
  moveKey(fromFrame: number, toFrame: number): boolean;
  copyKey(): boolean;
  pasteKey(): boolean;
  // clip CRUD (assembled bodies)
  addClip(name: string): string | null;
  renameClip(key: string, name: string): boolean;
  deleteClip(key: string): boolean;
  patchClip(key: string, patch: { frames?: number; fps?: number }): boolean;
  // assembled characters
  skeletons(): { id: string; name: string; bones: number; clips: number }[];
  newSkeleton(name: string): string;
  deleteSkeleton(id: string): boolean;
  addSkelBone(docId: string, opts: AddBoneOpts & { imgSrc?: string; imgW?: number; imgH?: number }): string | null;
  patchSkelBone(docId: string, boneId: string, patch: Partial<Pick<SkelBone, 'x' | 'y' | 'rot' | 'sx' | 'sy' | 'len' | 'z' | 'joint'>> & { name?: string; parent?: string | null; img?: Partial<SkelAttachment> }): boolean;
  saveSkeletons(): Promise<boolean>;
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
.as-app { --bg:#0f1019; --panel:#171a2b; --panel2:#1e2238; --panel3:#252a45; --edge:#2b3050;
  --ink:#cfe3ff; --dim:#8c96bf; --accent:#73eff7; --accent2:#a7f070; --warn:#ffcd75;
  --danger:#ff6e79; --sel:#2d3a6b; }
.as-app, .as-app * { box-sizing: border-box; }
.as-app { display:flex; flex-direction:column; height:100vh; margin:0; background:var(--bg); color:var(--ink);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size:12px; overflow:hidden; position:relative; }
.as-app ::-webkit-scrollbar { width:10px; height:10px; }
.as-app ::-webkit-scrollbar-thumb { background:var(--panel3); border-radius:5px; border:2px solid var(--panel); }
.as-app ::-webkit-scrollbar-track { background:transparent; }
.as-app :focus-visible { outline:1px solid var(--accent); outline-offset:1px; }

.as-app header { padding:7px 14px; border-bottom:1px solid var(--edge); display:flex; align-items:center;
  gap:14px; background:linear-gradient(180deg,#191d31,#12152300); flex:none; }
.as-app header h1 { font-size:14px; margin:0; color:var(--accent); letter-spacing:.5px; }
.as-app header .sub { color:var(--dim); font-size:11px; }
.as-app header .status { margin-left:auto; color:var(--warn); font-size:11px; }
.as-tabs { display:flex; gap:2px; background:var(--panel2); border:1px solid var(--edge); border-radius:7px; padding:2px; }
.as-tabs button { border:0; background:transparent; color:var(--dim); padding:4px 14px; border-radius:5px;
  cursor:pointer; font:inherit; font-weight:600; letter-spacing:.3px; }
.as-tabs button:hover { color:var(--ink); }
.as-tabs button.on { background:var(--accent); color:#0c0e17; }

.as-app button { font:inherit; }
.as-app .as-mini { padding:1px 7px; border:1px solid var(--edge); background:var(--panel2); color:var(--dim);
  border-radius:4px; cursor:pointer; font-size:11px; }
.as-app .as-mini:hover { border-color:var(--accent); color:var(--ink); }
.as-app .as-danger:hover { border-color:var(--danger) !important; color:var(--danger) !important; }
.as-helpbtn { border:1px solid var(--edge); background:var(--panel2); color:var(--dim); width:22px; height:22px;
  border-radius:50%; cursor:pointer; }
.as-helpbtn:hover { border-color:var(--accent); color:var(--ink); }

.as-main, .asm-main { flex:1; display:grid; grid-template-columns:var(--as-leftw, 260px) 1fr 282px; min-height:0; }
.as-col { min-height:0; overflow:hidden; display:flex; flex-direction:column; }
.as-roster, .asm-left { border-right:1px solid var(--edge); background:var(--panel); position:relative; overflow-x:hidden; }
.as-vresize { position:absolute; top:0; right:0; width:7px; height:100%; cursor:col-resize; z-index:12; }
.as-vresize:hover, .as-vresize.on { background:linear-gradient(90deg, transparent, rgba(115,239,247,0.3)); }
.as-inspector, .asm-right { border-left:1px solid var(--edge); background:var(--panel); overflow-y:auto; }
.as-pad { padding:10px; }
.as-search { width:100%; padding:6px 8px; background:var(--panel2); border:1px solid var(--edge);
  color:var(--ink); border-radius:6px; font:inherit; }
.as-search::placeholder { color:var(--dim); }
.as-list { flex:1; overflow-y:auto; overflow-x:hidden; padding:4px; }
.as-grp { color:var(--dim); font-size:10px; text-transform:uppercase; letter-spacing:1px;
  padding:8px 6px 3px; position:sticky; top:0; background:var(--panel); z-index:1; }
.as-row { display:flex; align-items:center; gap:8px; padding:4px 6px; border-radius:6px; cursor:pointer; }
.as-row:hover { background:var(--panel2); }
.as-row.sel { background:var(--sel); outline:1px solid var(--accent); }
.as-row .thumb { width:34px; height:34px; image-rendering:pixelated; background:#0c0e17;
  border-radius:4px; object-fit:contain; flex:none; }
.as-row .nm { color:var(--ink); }
.as-row .ti { color:var(--dim); font-size:10px; }
.as-row .meta { overflow:hidden; }
.as-row .nm, .as-row .ti { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

.as-stage, .asm-stage { background: repeating-conic-gradient(#0c0e17 0% 25%, #10131f 0% 50%) 50% / 22px 22px;
  position:relative; align-items:stretch; }
.as-view { flex:1; display:flex; align-items:center; justify-content:center; min-height:0; position:relative; overflow:hidden; }
.as-preview { image-rendering:pixelated; max-width:100%; max-height:100%; }
.as-preview.posing { cursor:crosshair; }
.as-hud { position:absolute; top:8px; left:10px; color:var(--dim); font-size:11px;
  text-shadow:0 1px 2px #000; pointer-events:none; line-height:1.5; }

.as-transport { border-top:1px solid var(--edge); background:var(--panel);
  padding:8px 10px; display:flex; flex-direction:column; gap:7px; flex:none; }
.as-clips { display:flex; gap:4px; flex-wrap:wrap; align-items:center; }
.as-clip { padding:4px 11px; border:1px solid var(--edge); background:var(--panel2);
  color:var(--dim); border-radius:6px; cursor:pointer; font:inherit; }
.as-clip:hover { border-color:var(--accent); color:var(--ink); }
.as-clip.on { color:#0c0e17; background:var(--accent); border-color:var(--accent); font-weight:600; }
.as-clipadd { padding:4px 9px; border:1px dashed var(--edge); background:transparent; color:var(--dim);
  border-radius:6px; cursor:pointer; }
.as-clipadd:hover { border-color:var(--accent2); color:var(--accent2); }
.as-clipedit { width:110px; padding:3px 8px; background:var(--panel2); border:1px solid var(--accent);
  color:var(--ink); border-radius:6px; font:inherit; }

.as-tbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.as-tbar button { padding:4px 9px; border:1px solid var(--edge); background:var(--panel2);
  color:var(--ink); border-radius:6px; cursor:pointer; white-space:nowrap; flex:none; }
.as-tbar button:hover:not(:disabled) { border-color:var(--accent); }
.as-tbar button:disabled { opacity:.4; cursor:default; }
.as-tbar button.play { background:var(--accent2); color:#0c0e17; border-color:var(--accent2); font-weight:600; }
.as-scrub { flex:1; accent-color:var(--accent); }
.as-tbar .fno { color:var(--dim); min-width:108px; text-align:right; font-variant-numeric:tabular-nums; }
.as-app label.chk { display:inline-flex; align-items:center; gap:5px; color:var(--dim); cursor:pointer; }
.as-rowlabel { color:var(--dim); font-size:10px; text-transform:uppercase; letter-spacing:1px; min-width:38px; flex:none; }
.as-posebtn.on { background:var(--accent) !important; color:#0c0e17 !important; border-color:var(--accent) !important; font-weight:600; }

.as-dope { display:flex; gap:3px; align-items:stretch; height:58px; padding:2px;
  overflow-x:auto; overflow-y:hidden; touch-action:none; }
.as-dope .fcell { position:relative; flex:none; background:var(--panel2); border:1px solid var(--edge);
  border-radius:5px; cursor:pointer; display:flex; align-items:center; justify-content:center; padding:2px 3px 11px; }
.as-dope .fcell:hover { border-color:var(--accent); }
.as-dope .fcell.here { border-color:var(--accent); background:var(--panel3); box-shadow:0 0 0 1px var(--accent); }
.as-dope .fcell.key { border-color:var(--warn); cursor:grab; }
.as-dope .fcell.drop { border-color:var(--accent2); box-shadow:0 0 0 1px var(--accent2); }
.as-dope .fthumb { image-rendering:pixelated; pointer-events:none; }
.as-dope .fno2 { position:absolute; bottom:0; left:3px; font-size:9px; color:var(--dim); pointer-events:none; }
.as-dope .fkey { position:absolute; bottom:-1px; right:2px; font-size:10px; color:var(--warn);
  display:none; pointer-events:none; text-shadow:0 1px 2px #000; }
.as-dope .fcell.key .fkey { display:block; }
.as-dope .fadd { position:absolute; top:1px; right:1px; width:15px; height:15px; line-height:12px;
  font-size:9px; border-radius:4px; border:1px solid var(--edge); background:var(--panel3);
  color:var(--accent2); opacity:0; cursor:pointer; padding:0; font:inherit; }
.as-dope .fcell:hover .fadd { opacity:1; }
.as-dope .fcell.key .fadd { color:var(--danger); }
.as-dope .fcell.tween::after { content:""; position:absolute; left:2px; right:2px; bottom:12px;
  height:2px; border-radius:1px; background:rgba(255,205,117,0.4); pointer-events:none; }
.as-dope .fgrow { min-width:32px; color:var(--dim); font-size:14px; border-style:dashed; }
.as-dope .fgrow:hover { color:var(--accent2); border-color:var(--accent2); }

/* the timeline — keys (with their pose) at their true, freely-placed times */
.as-timeline { position:relative; flex:1; height:64px; background:var(--panel2); border:1px solid var(--edge);
  border-radius:6px; cursor:pointer; touch-action:none; }
.as-timeline .ttick { position:absolute; top:6px; bottom:6px; width:1px; background:rgba(140,150,191,0.16);
  pointer-events:none; }
.as-timeline .tphead { position:absolute; top:0; bottom:0; width:2px; background:var(--accent);
  pointer-events:none; box-shadow:0 0 6px rgba(115,239,247,0.7); z-index:5; }
.as-timeline .tkeycard { position:absolute; bottom:2px; transform:translateX(-50%); display:flex;
  flex-direction:column; align-items:center; gap:0; cursor:grab; z-index:2;
  animation:as-kpop .16s ease; transition:transform .12s ease; }
@keyframes as-kpop { from { transform:translateX(-50%) scale(.6); opacity:0; } }
.as-timeline .tkeycard:hover { z-index:4; }
.as-timeline .tkeycard.sel { z-index:3; }
.as-timeline .tkeycard.dragging { transition:none; animation:none; transform:translateX(-50%) scale(1.12);
  cursor:grabbing; z-index:6; filter:drop-shadow(0 4px 10px #000d); }
.as-timeline .kthumb { image-rendering:pixelated; background:rgba(12,14,23,0.7); border:1px solid var(--edge);
  border-radius:4px; pointer-events:none; }
.as-timeline .tkeycard:hover .kthumb { border-color:var(--warn); }
.as-timeline .tkeycard.sel .kthumb { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
.as-timeline .tkey { width:10px; height:10px; margin-top:-2px; background:var(--warn); border:1px solid #0c0e17;
  transform:rotate(45deg); border-radius:2px; pointer-events:none; }
.as-timeline .tkeycard.sel .tkey { background:var(--accent); }
.as-rowtoggle { border:0; background:transparent; padding:0; cursor:pointer; text-align:left; }
.as-rowtoggle:hover { color:var(--ink); }

.as-sect { border-bottom:1px solid var(--edge); }
.as-sect h3 { font-size:11px; color:var(--accent2); margin:0; padding:9px 10px 5px;
  text-transform:uppercase; letter-spacing:1px; display:flex; align-items:center; gap:6px; }
.as-field { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:3px 10px 3px; min-height:24px; }
.as-field label { color:var(--dim); }
.as-fieldctl { display:flex; align-items:center; gap:4px; }
.as-field select, .as-field input[type="number"], .as-field input:not([type]) { background:var(--panel2);
  border:1px solid var(--edge); color:var(--ink); border-radius:4px; padding:3px 6px; font:inherit; }
.as-row-btns { display:flex; gap:6px; padding:8px 10px; }
.as-row-btns a, .as-row-btns button { flex:1; text-align:center; text-decoration:none;
  padding:6px 8px; border:1px solid var(--edge); background:var(--panel2); color:var(--ink);
  border-radius:6px; cursor:pointer; font:inherit; }
.as-row-btns a:hover, .as-row-btns button:hover { border-color:var(--accent2); }
.as-note { color:var(--dim); font-size:10px; padding:6px 10px 12px; line-height:1.5; }
.as-hidden { display:none !important; }
.as-boot { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  color:var(--dim); background:var(--bg); z-index:5; }
.as-gif { color:var(--ink); }

.as-toasts { position:absolute; left:50%; bottom:18px; transform:translateX(-50%); display:flex;
  flex-direction:column; gap:6px; align-items:center; z-index:30; pointer-events:none; }
.as-toast { background:var(--panel3); border:1px solid var(--edge); color:var(--ink); border-radius:7px;
  padding:6px 14px; opacity:0; transform:translateY(6px); transition:all .18s ease; box-shadow:0 4px 16px #0008; }
.as-toast.show { opacity:1; transform:none; }

.as-modal { position:absolute; inset:0; background:rgba(6,8,14,0.6); display:flex; align-items:center;
  justify-content:center; z-index:40; }
.as-mbox { background:var(--panel); border:1px solid var(--edge); border-radius:10px; padding:16px 18px;
  min-width:320px; max-width:520px; max-height:80%; overflow-y:auto; box-shadow:0 12px 40px #000a; }
.as-mbox h2 { margin:0 0 10px; font-size:13px; color:var(--accent); }
.as-mbox p { margin:0 0 12px; line-height:1.5; }
.as-mbox .btns { display:flex; gap:8px; justify-content:flex-end; }
.as-mbox .btns button { padding:5px 14px; border:1px solid var(--edge); background:var(--panel2);
  color:var(--ink); border-radius:6px; cursor:pointer; }
.as-mbox .btns button:hover { border-color:var(--accent); }
.as-mbox .btns button.ok { background:var(--accent); color:#0c0e17; border-color:var(--accent); font-weight:600; }
.as-keys { display:grid; grid-template-columns:auto 1fr; gap:4px 14px; margin:0 0 12px; }
.as-keys kbd { background:var(--panel2); border:1px solid var(--edge); border-bottom-width:2px;
  border-radius:4px; padding:0 6px; color:var(--warn); }
.as-keys span { color:var(--dim); }

.as-menu { position:absolute; z-index:35; background:var(--panel); border:1px solid var(--edge);
  border-radius:8px; padding:4px; display:flex; flex-direction:column; min-width:150px; box-shadow:0 8px 28px #000a; }
.as-menu button { text-align:left; border:0; background:transparent; color:var(--ink); padding:6px 10px;
  border-radius:5px; cursor:pointer; }
.as-menu button:hover { background:var(--sel); }

/* ---- assemble mode ---- */
.asm-toolbar { display:flex; align-items:center; gap:8px; padding:7px 10px; border-bottom:1px solid var(--edge);
  background:var(--panel); flex:none; }
.asm-toolbar button { padding:4px 10px; border:1px solid var(--edge); background:var(--panel2);
  color:var(--ink); border-radius:6px; cursor:pointer; }
.asm-toolbar button:hover { border-color:var(--accent); }
.asm-zoom { color:var(--dim); min-width:44px; text-align:right; font-variant-numeric:tabular-nums; }
.asm-hint { color:var(--dim); font-size:10px; }
.asm-canvaswrap { flex:1; position:relative; min-height:0; }
.asm-canvaswrap canvas { display:block; }
.asm-canvaswrap.drop { outline:2px dashed var(--accent2); outline-offset:-6px; }
.asm-empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  text-align:center; color:var(--dim); line-height:1.6; }
.asm-empty button { margin-top:10px; padding:7px 16px; border:1px solid var(--accent2); background:var(--panel2);
  color:var(--accent2); border-radius:7px; cursor:pointer; font:inherit; font-weight:600; }
.asm-empty button:hover { background:var(--accent2); color:#0c0e17; }
.asm-charlist { max-height:150px; overflow-y:auto; overflow-x:hidden; padding:2px 6px 8px; }
.asm-partsect { flex:1; display:flex; flex-direction:column; min-height:0; }
.asm-partgrid { flex:1; overflow-y:auto; overflow-x:hidden; display:grid;
  grid-template-columns:repeat(auto-fill, minmax(84px, 1fr)); gap:6px; padding:6px 10px; align-content:start; }
.asm-part { background:var(--panel2); border:1px solid var(--edge); border-radius:6px; padding:4px;
  cursor:pointer; text-align:center; min-width:0; }
.asm-part:hover { border-color:var(--accent2); }
.asm-part img { width:100%; height:40px; object-fit:contain; image-rendering:pixelated; }
.asm-partname { color:var(--dim); font-size:9px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.asm-part { position:relative; }
.asm-partrm { position:absolute; top:1px; right:1px; width:14px; height:14px; line-height:11px; padding:0;
  font:inherit; font-size:9px; border-radius:4px; border:1px solid var(--edge); background:var(--panel3);
  color:var(--dim); opacity:0; cursor:pointer; }
.asm-part:hover .asm-partrm { opacity:1; }
.asm-partrm:hover { color:var(--danger); border-color:var(--danger); }
.asm-rowbtn { width:16px; height:16px; line-height:13px; padding:0; font:inherit; font-size:9px;
  border-radius:4px; border:1px solid var(--edge); background:var(--panel3); color:var(--dim);
  opacity:0; cursor:pointer; flex:none; }
.as-row:hover .asm-rowbtn, .asm-treerow:hover .asm-rowbtn { opacity:1; }
.asm-rowbtn:hover { color:var(--ink); border-color:var(--accent); }
.asm-rowbtn.danger:hover { color:var(--danger); border-color:var(--danger); }
.asm-tree { padding:2px 4px 8px; max-height:220px; overflow-y:auto; }
.asm-treerow { display:flex; align-items:center; gap:6px; padding:2px 6px; border-radius:5px; cursor:pointer; color:var(--ink); }
.asm-treerow:hover { background:var(--panel2); }
.asm-treerow.sel { background:var(--sel); outline:1px solid var(--accent); }
.asm-treedot { width:7px; height:7px; border-radius:50%; background:var(--dim); flex:none; }
.asm-treedot.img { background:var(--accent2); }
.asm-treejoint { color:var(--warn); margin-left:auto; font-size:10px; }
.asm-thumb { width:44px; height:44px; object-fit:contain; image-rendering:pixelated; background:#0c0e17;
  border-radius:4px; border:1px solid var(--edge); }
`;

const SHELL = `
<header>
  <h1 data-as="title">Anim Studio</h1>
  <nav class="as-tabs">
    <button data-as="tabAnimate" class="on" title="preview + keyframe (Animate mode)">Animate</button>
    <button data-as="tabAssemble" title="build characters from parts (Assemble mode)">Assemble</button>
  </nav>
  <span class="sub" data-as="subtitle">skeletal pose / keyframe editor · dev tool</span>
  <span class="status" data-as="status">booting…</span>
  <button class="as-helpbtn" data-as="helpBtn" title="shortcuts + help (?)">?</button>
</header>
<div class="as-main" data-as="animMain">
  <div class="as-col as-roster">
    <div class="as-pad"><input class="as-search" data-as="search" placeholder="search bodies…" /></div>
    <div class="as-list" data-as="list"></div>
  </div>
  <div class="as-col as-stage">
    <div class="as-view" data-as="view">
      <div class="as-hud" data-as="hud"></div>
      <canvas class="as-preview" data-as="preview" width="480" height="440"></canvas>
      <div class="as-boot" data-as="boot">baking the roster…</div>
    </div>
    <div class="as-transport">
      <div class="as-tbar"><span class="as-rowlabel">clips</span><div class="as-clips" data-as="clips" style="flex:1"></div></div>
      <div class="as-tbar">
        <button class="play" data-as="playBtn" title="play / pause (Space)">▶ play</button>
        <button data-as="stepBack" title="previous frame (←)">◀</button>
        <button data-as="stepFwd" title="next frame (→)">▶</button>
        <input class="as-scrub" type="range" data-as="scrub" min="0" max="0" value="0" step="1" />
        <span class="fno" data-as="fno">frame 0 / 0</span>
      </div>
      <div class="as-tbar">
        <label class="chk"><input type="checkbox" data-as="onion" /> onion skin</label>
        <label class="chk"><input type="checkbox" data-as="guides" checked /> guides</label>
        <label class="chk">zoom <input type="range" data-as="zoom" min="1" max="14" value="8" step="1" style="width:120px;accent-color:var(--accent)" /></label>
        <span style="flex:1"></span>
        <a class="as-gif" data-as="gif" download="clip.gif" href="#" title="export the current clip as an animated GIF">⬇ export GIF</a>
      </div>
      <div class="as-tbar">
        <button class="as-posebtn" data-as="poseEdit" title="toggle pose editing: drag joints to pose, every drag keys the frame (P)">✎ pose edit</button>
        <button data-as="keyBtn" title="set a key at this frame (K)">◆ set key</button>
        <button data-as="unkeyBtn" title="clear the key at this frame (Del)">◇ clear</button>
        <button data-as="copyKey" title="copy the key at this frame">⧉ copy</button>
        <button data-as="pasteKey" title="paste the copied key at this frame">⧉ paste</button>
        <span class="fno" data-as="keyInfo" style="flex:1;min-width:90px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">drag a joint to pose</span>
        <span style="display:flex;gap:8px;flex:none">
          <button data-as="undoA" title="undo (Ctrl+Z)">↶</button>
          <button data-as="redoA" title="redo (Ctrl+Shift+Z)">↷</button>
          <button data-as="resetClip" title="delete every key of this clip">reset clip</button>
        </span>
      </div>
      <div class="as-tbar">
        <span style="display:flex;flex-direction:column;gap:3px;flex:none;align-items:stretch">
          <span class="as-rowlabel">keys</span>
          <button class="as-mini" data-as="tAddKey" title="add a key at the playhead (K)">＋◆</button>
          <button class="as-mini" data-as="tDelKey" title="delete the key at the playhead (Del)">－◆</button>
        </span>
        <div class="as-timeline" data-as="tline" title="the animation: ◆ keys with their pose, at any time — drag a key ANYWHERE (Shift = snap to frames) · double-click to add a key · click one to select and edit it · everything between keys is interpolation"></div>
        <input type="number" data-as="tDur" min="60" max="16000" step="10" style="width:70px" title="total clip duration (ms)" />
        <span class="as-rowlabel" style="min-width:18px">ms</span>
      </div>
      <div class="as-tbar">
        <button class="as-rowlabel as-rowtoggle" data-as="framesToggle" title="show/hide the sampled frame grid (secondary — keys are the animation)">frames ▸</button>
        <div class="as-dope as-hidden" data-as="dope" style="flex:1" title="the sampled frame grid the clip plays/exports at — ◆ marks on-frame keys, the amber line is the interpolated tween; hover a frame to key it, right-click for actions"></div>
      </div>
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
      <div class="as-row-btns as-hidden" data-as="editCharRow">
        <button data-as="editChar" title="open this character in Assemble mode">🛠 edit skeleton</button>
      </div>
    </div>
    <div class="as-sect">
      <h3>Clip timing</h3>
      <div class="as-field"><label>duration (ms)</label>
        <input type="number" data-as="cDur" min="60" max="8000" step="10" style="width:78px" /></div>
      <div class="as-field as-hidden" data-as="cFpsRow"><label>fps</label>
        <input type="number" data-as="cFps" min="1" max="240" step="1" style="width:78px" /></div>
      <div class="as-field as-hidden" data-as="cFramesRow"><label>frames</label>
        <input type="number" data-as="cFrames" min="1" max="600" step="1" style="width:78px" /></div>
      <div class="as-field" data-as="iFramesRow"><label>frames</label><span data-as="iFrames">—</span></div>
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
      the motion, export a GIF. Turn on <b>pose edit</b> to drag joints, keyframe with
      easing, and Save. Press <b>?</b> for all shortcuts.
    </div>
  </div>
</div>
<div class="asm-main as-hidden" data-as="asmMain"></div>
<div class="as-toasts" data-as="toasts"></div>
<div class="as-modal as-hidden" data-as="modal"><div class="as-mbox" data-as="mbox"></div></div>
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
  const viewEl = $<HTMLDivElement>('view');
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
  const poseEditEl = $<HTMLButtonElement>('poseEdit');
  const keyBtn = $<HTMLButtonElement>('keyBtn');
  const unkeyBtn = $<HTMLButtonElement>('unkeyBtn');
  const copyKeyBtn = $<HTMLButtonElement>('copyKey');
  const pasteKeyBtn = $<HTMLButtonElement>('pasteKey');
  const keyInfo = $<HTMLSpanElement>('keyInfo');
  const dopeEl = $<HTMLDivElement>('dope');
  const cDur = $<HTMLInputElement>('cDur');
  const tlineEl = $<HTMLDivElement>('tline');
  const tDur = $<HTMLInputElement>('tDur');
  const cFrames = $<HTMLInputElement>('cFrames');
  const cFramesRow = $<HTMLDivElement>('cFramesRow');
  const cFps = $<HTMLInputElement>('cFps');
  const cFpsRow = $<HTMLDivElement>('cFpsRow');
  const kEase = $<HTMLSelectElement>('kEase');
  const kCount = $<HTMLSpanElement>('kCount');
  const saveBtn = $<HTMLButtonElement>('saveBtn');
  const copyBtn = $<HTMLButtonElement>('copyBtn');
  const saveNote = $<HTMLDivElement>('saveNote');
  const animMain = $<HTMLDivElement>('animMain');
  const asmMain = $<HTMLDivElement>('asmMain');
  const tabAnimate = $<HTMLButtonElement>('tabAnimate');
  const tabAssemble = $<HTMLButtonElement>('tabAssemble');
  const toastsEl = $<HTMLDivElement>('toasts');
  const modalEl = $<HTMLDivElement>('modal');
  const mboxEl = $<HTMLDivElement>('mbox');
  const editCharRow = $<HTMLDivElement>('editCharRow');

  if (host.title) $('title').textContent = host.title;
  if (host.subtitle) $('subtitle').textContent = host.subtitle;
  if (host.save?.hint) saveNote.textContent = host.save.hint;
  const endpoint = host.save?.endpoint ?? '/__anim/save';
  const store = host.clips;

  // -------------------------------------------------------------------------
  // ui services: toasts, modal (confirm + help), popover menu
  // -------------------------------------------------------------------------
  function toast(msg: string): void {
    const t = document.createElement('div');
    t.className = 'as-toast';
    t.textContent = msg;
    toastsEl.appendChild(t);
    while (toastsEl.children.length > 4) toastsEl.firstChild?.remove();
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 250);
    }, 2600);
  }

  let modalResolve: ((ok: boolean) => void) | null = null;
  function closeModal(ok = false): void {
    modalEl.classList.add('as-hidden');
    const r = modalResolve;
    modalResolve = null;
    r?.(ok);
  }
  modalEl.addEventListener('pointerdown', (e) => {
    if (e.target === modalEl) closeModal(false);
  });
  function confirmBox(msg: string): Promise<boolean> {
    return new Promise((resolve) => {
      closeModal(false);
      modalResolve = resolve;
      mboxEl.innerHTML = '';
      const p = document.createElement('p');
      p.textContent = msg;
      const btns = document.createElement('div');
      btns.className = 'btns';
      const cancel = document.createElement('button');
      cancel.textContent = 'cancel';
      cancel.onclick = () => closeModal(false);
      const ok = document.createElement('button');
      ok.className = 'ok';
      ok.textContent = 'OK';
      ok.onclick = () => closeModal(true);
      btns.append(cancel, ok);
      mboxEl.append(p, btns);
      modalEl.classList.remove('as-hidden');
      ok.focus();
    });
  }
  function showHelp(): void {
    closeModal(false);
    mboxEl.innerHTML = `
      <h2>Shortcuts</h2>
      <div class="as-keys">
        <kbd>Space</kbd><span>play / pause (Animate) · hold to pan (Assemble)</span>
        <kbd>← →</kbd><span>step a frame · nudge the selected bone (Assemble)</span>
        <kbd>Home / End</kbd><span>first / last frame</span>
        <kbd>P</kbd><span>toggle ✎ pose edit</span>
        <kbd>K</kbd><span>set a key at this frame</span>
        <kbd>Del</kbd><span>clear the key (Animate) · delete the bone (Assemble)</span>
        <kbd>Ctrl+Z / Ctrl+Shift+Z</kbd><span>undo / redo</span>
        <kbd>B</kbd><span>add a bone under the selection (Assemble)</span>
        <kbd>N</kbd><span>new character (Assemble)</span>
        <kbd>Shift</kbd><span>drag = move a skeleton joint · snap a key to frames (timeline) · 15° snap (Assemble)</span>
        <kbd>?</kbd><span>this help</span>
      </div>
      <p><b>Frames vs keyframes:</b> <b>keyframes (◆) are the animation</b> —
      the poses you author, at any times (spacing need not be uniform).
      Everything between keys is interpolation (each key's ease shapes the
      approach into it). Frames are just the sampled grid the clip plays and
      exports at (tucked behind the <b>frames ▸</b> toggle). The <b>keys</b>
      row is the timeline — each key shows its pose: drag it ANYWHERE
      (hold Shift to snap to frames), double-click to add a key, ＋◆/－◆ to
      key/unkey the playhead, click a key to select and edit it, and set the
      clip's total duration in the ms box.</p>
      <p><b>Building an animation from scratch:</b> pick a body (or press
      ▶ animate on an assembled character) → choose or <b>+ new clip</b> →
      turn on <b>✎ pose edit</b> → step to a frame → drag joints (every drag
      keys that frame) → pose more frames → Space to review. On the filmstrip:
      hover a frame and press its <b>◆</b> (or double-click) to key it, drag a
      key to retime it — <b>drop it on another key to swap the two</b> —
      right-click for copy/paste/duplicate, and <b>＋</b> grows an assembled
      clip.</p>
      <p>Double-click an assembled body's clip tab to rename it; <b>⋯</b>
      duplicates or deletes it. The frames + duration fields in the inspector
      retime the clip (existing keys snap to the new frame grid).</p>
      <div class="btns"><button class="ok">close</button></div>`;
    mboxEl.querySelector<HTMLButtonElement>('.ok')!.onclick = () => closeModal(false);
    modalEl.classList.remove('as-hidden');
  }
  $('helpBtn').onclick = () => showHelp();

  let menuEl: HTMLDivElement | null = null;
  function closeMenu(): void {
    menuEl?.remove();
    menuEl = null;
  }
  function openMenu(items: { label: string; danger?: boolean; run: () => void }[], anchor: HTMLElement): void {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'as-menu';
    for (const it of items) {
      const b = document.createElement('button');
      b.textContent = it.label;
      if (it.danger) b.classList.add('as-danger');
      b.onclick = () => {
        closeMenu();
        it.run();
      };
      m.appendChild(b);
    }
    app.appendChild(m);
    const r = anchor.getBoundingClientRect();
    const ar = app.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(r.left - ar.left, ar.width - 170)) + 'px';
    m.style.bottom = ar.bottom - r.top + 4 + 'px';
    menuEl = m;
    setTimeout(() => document.addEventListener('pointerdown', (e) => {
      if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
    }, { once: true }));
  }

  // -------------------------------------------------------------------------
  // history (shared undo/redo across both modes)
  // -------------------------------------------------------------------------
  const history = new History();
  function doUndo(): void {
    const label = history.undo();
    toast(label ? `undid ${label}` : 'nothing to undo');
  }
  function doRedo(): void {
    const label = history.redo();
    toast(label ? `redid ${label}` : 'nothing to redo');
  }

  // -------------------------------------------------------------------------
  // assembled characters: load + persist
  // -------------------------------------------------------------------------
  const skelEndpoint = host.skeletons ? (host.skeletons.endpoint ?? '/__anim/skeletons') : null;
  const SKEL_LS = 'anim-studio:skeletons';
  async function loadSkeletonDocs(): Promise<{ skeletons: SkeletonDoc[]; parts: SkelPart[] }> {
    if (skelEndpoint) {
      try {
        const res = await fetch(skelEndpoint, { headers: { accept: 'application/json' } });
        if (res.ok) return unpackSkeletons(await res.text());
      } catch {
        /* fall through to localStorage */
      }
    }
    try {
      return unpackSkeletons(localStorage.getItem(SKEL_LS) ?? '{}');
    } catch {
      return { skeletons: [], parts: [] };
    }
  }
  let skelTimer: ReturnType<typeof setTimeout> | undefined;
  let skelSaveOk = true;
  function scheduleSkelSave(): void {
    clearTimeout(skelTimer);
    skelTimer = setTimeout(() => void saveSkeletonDocs(), 600);
  }
  async function saveSkeletonDocs(): Promise<boolean> {
    const text = packSkeletons(docs, skelParts);
    if (skelEndpoint) {
      try {
        const res = await fetch(skelEndpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
        if (res.ok) {
          if (!skelSaveOk) toast('characters saved');
          skelSaveOk = true;
          return true;
        }
      } catch {
        /* fall through to localStorage */
      }
    }
    try {
      localStorage.setItem(SKEL_LS, text);
      if (!skelSaveOk) toast('characters saved (locally)');
      skelSaveOk = true;
      return true;
    } catch {
      if (skelSaveOk) toast('⚠ characters could not be saved');
      skelSaveOk = false;
      return false;
    }
  }

  const skelFile = await loadSkeletonDocs();
  const docs: SkeletonDoc[] = skelFile.skeletons;
  const skelParts: SkelPart[] = skelFile.parts;
  for (const doc of docs) store[skelBodyId(doc)] = doc.timelines;
  const skelRev = new Map<string, number>();

  if (host.ready) await host.ready();
  const adapterRoster: BodyDesc[] = await host.bodies();
  const roster: BodyDesc[] = [];

  const skelDesc = (doc: SkeletonDoc): BodyDesc => ({
    id: skelBodyId(doc),
    label: doc.name,
    group: 'assembled',
    title: `${doc.bones.length} bones · ${doc.clips.length} clips`,
  });

  function rebuildRoster(): void {
    const curId = roster[selected]?.id;
    roster.length = 0;
    roster.push(...adapterRoster, ...docs.map(skelDesc));
    const i = roster.findIndex((r) => r.id === curId);
    selected = i >= 0 ? i : Math.min(selected, Math.max(0, roster.length - 1));
    statusEl.textContent = `${roster.length} bodies`;
    renderList();
  }

  // -------------------------------------------------------------------------
  // baking (memoised per body + variant values; assembled bodies re-bake per rev)
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
  const docOfRow = (rowId: string): SkeletonDoc | undefined => docs.find((d) => skelBodyId(d) === rowId);
  const skelCacheKey = (doc: SkeletonDoc): string => skelBodyId(doc) + ' r' + (skelRev.get(doc.id) ?? 0);

  function bakeOf(row: BodyDesc): Promise<Baked | null> {
    if (isSkelBodyId(row.id)) {
      const doc = docOfRow(row.id);
      if (!doc) return Promise.resolve(null);
      const key = skelCacheKey(doc);
      let p0 = bakeCache.get(key);
      if (!p0) {
        p0 = preloadSkeleton(doc).then(() => {
          const body = skeletonBody(doc, store);
          return { body, bounds: contentBounds(body) };
        });
        bakeCache.set(key, p0);
      }
      return p0;
    }
    const vals = variantsFor(row);
    const key = row.id + ' ' + JSON.stringify(vals);
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
  let mode: StudioMode = 'animate';
  let selected = 0;
  let current: Baked | null = null;
  let clipIdx = 0;
  let frameIdx = 0;
  let poseMode = false;
  let poseWanted = false; // the user's toggle; poseMode = poseWanted && poseable
  /** Continuous clip-time selected on the timeline (a key's exact time, which
   *  may sit between frames) — pose/key ops target it; null = the frame's t. */
  let curT: number | null = null;
  /** Continuous playback clock for assembled bodies (they interpolate every
   *  displayed frame instead of stepping baked samples). */
  let playMs = 0;
  let playT: number | null = null;
  let handles: { bone: BoneRec; x: number; y: number }[] = [];
  let lastView = { dx: 0, dy: 0, scale: 1 };
  let keyClipboard: { pose: Pose; ease?: Ease } | null = null;
  let drag:
    | {
        bone: BoneRec;
        translate: boolean;
        pivotX: number;
        pivotY: number;
        downAng: number;
        baseAng: number;
        downX: number;
        downY: number;
        baseIkDx: number;
        baseIkDy: number;
        histBefore: string | null;
        bodyId: string;
      }
    | null = null;

  const poseable = (): boolean => !!current?.body.bodyId && !!current.body.renderPose;

  function activeClip(): ClipDef | null {
    return current ? (current.body.clips[clipIdx] ?? null) : null;
  }

  /** The assembled-character doc behind the current body (null for adapter bodies). */
  function curDoc(): SkeletonDoc | null {
    const bodyId = current?.body.bodyId;
    if (!bodyId || !isSkelBodyId(bodyId)) return null;
    return docOfRow(bodyId) ?? null;
  }

  /** Preview delays honouring an authored duration on retimable clips.
   *  Assembled bodies carry tempo in their own clip defs — no store duration. */
  function effDelays(clip: ClipDef): number[] {
    const bodyId = current?.body.bodyId;
    if (bodyId && !isSkelBodyId(bodyId)) {
      const ms = store[bodyId]?.[clip.clipKey]?.duration;
      if (ms && clip.retimable) return clip.frames.map(() => ms / clip.frames.length);
    }
    return clip.delays;
  }

  /** The authoring target: authored clip id + clip-time + render frame. The
   *  time is the timeline-selected `curT` when set (so ops hit a key's exact,
   *  possibly off-frame time), else the current frame's plan time. */
  function curDrive(): { clip: string; t: number; fi: number } | null {
    const clip = activeClip();
    if (!current || !clip) return null;
    const fi = clip.frames[frameIdx] ?? clip.frames[0];
    const pf = current.body.plan[fi];
    if (!pf) return null;
    return { clip: pf.clip, t: curT ?? pf.t, fi };
  }

  /** Clip-time of frame `i` of the active clip. */
  function frameT(i: number): number {
    const clip = activeClip();
    if (!current || !clip) return 0;
    return current.body.plan[clip.frames[i] ?? -1]?.t ?? 0;
  }

  /** Jump the playhead to a continuous time (nearest frame renders it). */
  function seekT(t: number): void {
    const clip = activeClip();
    if (!clip) return;
    curT = t;
    const n = clip.frames.length;
    frameIdx = n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
    render();
  }

  // -------------------------------------------------------------------------
  // clip-store undo helpers
  // -------------------------------------------------------------------------
  const snapshotClips = (bodyId: string): string | null => (store[bodyId] ? JSON.stringify(store[bodyId]) : null);
  function restoreClips(bodyId: string, snap: string | null): void {
    const cur = store[bodyId];
    if (snap === null) {
      if (cur) for (const k of Object.keys(cur)) delete cur[k];
      if (cur && !isSkelBodyId(bodyId)) delete store[bodyId];
    } else {
      const data = JSON.parse(snap) as Record<string, unknown>;
      if (cur) {
        for (const k of Object.keys(cur)) delete cur[k];
        Object.assign(cur, data);
      } else {
        store[bodyId] = data as (typeof store)[string];
      }
    }
    if (isSkelBodyId(bodyId)) scheduleSkelSave();
    dopeRev++;
    render();
  }
  /** Run a clip-store mutation with an undo entry (no-op edits push nothing). */
  function withClipsHistory(label: string, bodyId: string, fn: () => void): void {
    const before = snapshotClips(bodyId);
    fn();
    const after = snapshotClips(bodyId);
    if (before !== after) {
      history.push({ label, undo: () => restoreClips(bodyId, before), redo: () => restoreClips(bodyId, after) });
      if (isSkelBodyId(bodyId)) scheduleSkelSave();
      dopeRev++;
    }
  }

  // -------------------------------------------------------------------------
  // skeleton-doc undo helpers + re-bake
  // -------------------------------------------------------------------------
  function touchDoc(doc: SkeletonDoc): void {
    skelRev.set(doc.id, (skelRev.get(doc.id) ?? 0) + 1);
    scheduleSkelSave();
    rebuildRoster();
    if (mode === 'animate' && current?.body.bodyId === skelBodyId(doc)) refreshSkelBody();
  }
  /** Rebuild the current assembled body in place (fresh clips/plan) keeping the
   *  active clip (by key) and frame where possible. */
  function refreshSkelBody(selectKey?: string): void {
    const doc = curDoc();
    if (!doc) return;
    const want = selectKey ?? activeClip()?.clipKey;
    const body = skeletonBody(doc, store);
    const baked = { body, bounds: contentBounds(body) };
    current = baked;
    dopeRev++; // structure changed → rebuild the filmstrip
    bakeCache.set(skelCacheKey(doc), Promise.resolve(baked));
    clipIdx = Math.max(0, body.clips.findIndex((c) => c.clipKey === want));
    const clip = activeClip();
    frameIdx = Math.min(frameIdx, Math.max(0, (clip?.frames.length ?? 1) - 1));
    scrubEl.max = String(Math.max(0, (clip?.frames.length ?? 1) - 1));
    renderClipTabs();
    updateInspector();
    render();
  }
  /** Run a doc mutation (from Animate mode's clip CRUD) with an undo entry. */
  function withDocHistory<T>(doc: SkeletonDoc, label: string, fn: () => T): T {
    const before = snapshotDoc(doc);
    const out = fn();
    const after = snapshotDoc(doc);
    if (before !== after) {
      const apply = (snap: string): void => {
        restoreDoc(doc, snap);
        touchDoc(doc);
        asm.refresh();
      };
      history.push({ label, undo: () => apply(before), redo: () => apply(after) });
      touchDoc(doc);
    }
    return out;
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
    if (playT !== null && playing && current.body.renderPose && curDoc()) {
      // assembled bodies play CONTINUOUSLY: sample the keys at the exact
      // elapsed time — frames are just the export grid, keys are the motion
      const bodyId = current.body.bodyId!;
      const posed = current.body.renderPose(fi, samplePose(store[bodyId]?.[clip.clipKey], playT));
      if (posed) {
        pctx.imageSmoothingEnabled = false;
        pctx.drawImage(posed.canvas, 0, 0, posed.fw, posed.fh, dx, dy, posed.fw * scale, posed.fh * scale);
      }
    } else {
      if (onionEl.checked && clip.frames.length > 1) {
        const prev = clip.frames[(frameIdx - 1 + clip.frames.length) % clip.frames.length];
        const next = clip.frames[(frameIdx + 1) % clip.frames.length];
        blit(prev, scale, dx, dy, 0.2);
        blit(next, scale, dx, dy, 0.2);
      }
      blit(fi, scale, dx, dy, 1);
    }

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

    const doc = curDoc();
    handles = posed.bones.map((bone) => ({ bone, ...boneScreen(bone, dx, dy, scale) }));
    for (const h of handles) {
      const off = pose?.[h.bone.id];
      const keyed = !!off && ((off.dAng ?? 0) !== 0 || (off.ikDx ?? 0) !== 0 || (off.ikDy ?? 0) !== 0);
      let col = h.bone.kind === 'leg' ? '#a7f070' : h.bone.kind === 'root' ? '#ffcd75' : '#73eff7';
      if (doc && skelBoneById(doc, h.bone.id)?.joint.type === 'fixed') col = '#8c96bf';
      pctx.beginPath();
      pctx.arc(h.x, h.y, keyed ? 6.5 : 4.5, 0, 7);
      pctx.fillStyle = keyed ? col : col + '88';
      pctx.fill();
      pctx.lineWidth = 1.5;
      pctx.strokeStyle = '#0c0e17';
      pctx.stroke();
    }

    const hint = doc ? 'drag=rotate · shift-drag=move · grey=welded' : 'cyan=arm · green=foot · amber=body';
    hudEl.textContent = `${clip.name} · frame ${d.fi} · POSE EDIT — ${hint}`;
    fnoEl.textContent = `frame ${frameIdx + 1} / ${clip.frames.length}`;
    scrubEl.value = String(frameIdx);
  }

  function render(): void {
    if (poseMode && poseable()) renderPoseMode();
    else renderBaked();
    updateKeyUI();
  }

  function setPoseMode(on: boolean): void {
    poseWanted = on;
    poseMode = on && poseable();
    poseEditEl.disabled = !poseable();
    poseEditEl.title = poseable()
      ? 'toggle pose editing: drag joints to pose, every drag keys the frame (P)'
      : 'this body has no pose rig (view only)';
    poseEditEl.classList.toggle('on', poseMode);
    previewEl.classList.toggle('posing', poseMode);
    render();
  }

  // responsive preview: fill the stage, re-render on resize
  new ResizeObserver(() => {
    const r = viewEl.getBoundingClientRect();
    const w = Math.max(320, Math.floor(r.width) - 16);
    const h = Math.max(240, Math.floor(r.height) - 16);
    if (previewEl.width !== w || previewEl.height !== h) {
      previewEl.width = w;
      previewEl.height = h;
      render();
    }
  }).observe(viewEl);

  previewEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const v = Number(zoomEl.value) + (e.deltaY < 0 ? 1 : -1);
    zoomEl.value = String(Math.max(Number(zoomEl.min), Math.min(Number(zoomEl.max), v)));
    render();
  }, { passive: false });

  // -------------------------------------------------------------------------
  // pose dragging (writes relative deltas; every drag is one undo entry)
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
    const histBefore = snapshotClips(bodyId);
    const tl = timelineFor(store, bodyId, d.clip, true)!;
    const k = keyAt(tl, d.t, true, (kEase.value as Ease) || 'linear')!;
    const off = (k.pose[bone.id] ??= {});
    drag = {
      bone,
      translate: !!bone.end || bone.kind === 'leg' || (!!curDoc() && e.shiftKey),
      pivotX: hx,
      pivotY: hy,
      downAng: Math.atan2(my - hy, mx - hx),
      baseAng: off.dAng ?? 0,
      downX: mx,
      downY: my,
      baseIkDx: off.ikDx ?? 0,
      baseIkDy: off.ikDy ?? 0,
      histBefore,
      bodyId,
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
    if (drag.translate) {
      off.ikDx = drag.baseIkDx + (mx - drag.downX) / lastView.scale;
      off.ikDy = drag.baseIkDy + (my - drag.downY) / lastView.scale;
    } else {
      let delta = Math.atan2(my - drag.pivotY, mx - drag.pivotX) - drag.downAng;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      let next = drag.baseAng + delta;
      const doc = curDoc();
      if (doc) {
        const sb = skelBoneById(doc, drag.bone.id);
        if (sb) next = clampJointAngle(sb, next);
      }
      off.dAng = next;
    }
    render();
    refreshDopeThumb(frameIdx); // live filmstrip feedback while dragging
  });

  function endDrag(e: PointerEvent): void {
    if (!drag) return;
    const d = drag;
    drag = null;
    try {
      previewEl.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const after = snapshotClips(d.bodyId);
    if (after !== d.histBefore) {
      const bodyId = d.bodyId;
      const before = d.histBefore;
      history.push({ label: 'pose ' + d.bone.id, undo: () => restoreClips(bodyId, before), redo: () => restoreClips(bodyId, after) });
      if (isSkelBodyId(bodyId)) scheduleSkelSave();
      dopeRev++;
    }
    render();
  }
  previewEl.addEventListener('pointerup', endDrag);
  previewEl.addEventListener('pointercancel', endDrag);

  // -------------------------------------------------------------------------
  // dope sheet: seek, and drag a key to move it
  // -------------------------------------------------------------------------
  function clipDurationMs(): number {
    const clip = activeClip();
    return clip ? Math.round(effDelays(clip).reduce((a, c) => a + c, 0)) : 0;
  }

  let keyDrag: { from: number; to: number } | null = null;

  // The frames strip is SECONDARY (keys are the animation; frames just sample
  // it) — collapsed by default behind a disclosure toggle.
  const FRAMES_LS = 'anim-studio:frames-open';
  let framesOpen = localStorage.getItem(FRAMES_LS) === '1';

  // The dope sheet is a FILMSTRIP: every frame cell shows the character as it
  // renders at that frame (live-sampled, so edits show immediately), with a ◆
  // badge on keyed frames. Rebuilding thumbnails is the expensive part, so the
  // strip is cached and rebuilt only when the body/clip/keys change; the
  // playhead highlight updates per tick for free.
  let dopeRev = 0; // bump on any authored-keys change → thumbnails rebuild
  let dopeKey = '';
  let dopeCells: HTMLDivElement[] = [];

  function drawThumb(cv: HTMLCanvasElement, fi: number): void {
    if (!current) return;
    const b = current.bounds;
    const s = Math.min(40 / b.h, 60 / b.w);
    cv.width = Math.max(18, Math.round(b.w * s));
    cv.height = 40;
    const r = current.body.frame(fi);
    if (!r) return;
    const cx = cv.getContext('2d')!;
    cx.imageSmoothingEnabled = false;
    cx.drawImage(r.src, r.x + b.x, r.y + b.y, b.w, b.h, (cv.width - b.w * s) / 2, (40 - b.h * s) / 2, b.w * s, b.h * s);
  }

  function rebuildDope(clip: ClipDef): void {
    dopeEl.innerHTML = '';
    dopeCells = [];
    if (!current) return;
    if (clip.frames.length > 96) {
      const note = document.createElement('div');
      note.className = 'as-note';
      note.textContent = `${clip.frames.length} frames — too dense to strip; author on the keys timeline (lower the fps to see a strip)`;
      dopeEl.appendChild(note);
      return;
    }
    const bodyId = current.body.bodyId;
    const keyedIdx: number[] = [];
    clip.frames.forEach((fi, i) => {
      const pf = current?.body.plan[fi];
      if (!pf) return;
      const tl = bodyId ? store[bodyId]?.[pf.clip] : undefined;
      const keyed = !!tl?.keys.some((kf) => Math.abs(kf.t - pf.t) < KEY_EPS);
      if (keyed) keyedIdx.push(i);
      const cell = document.createElement('div');
      cell.className = 'fcell' + (keyed ? ' key' : '');
      cell.dataset.i = String(i);
      cell.title = keyed
        ? `frame ${i + 1} ◆ keyframe — drag to retime · drop on a key to swap · right-click for actions`
        : `frame ${i + 1} — click to jump · ◆ or double-click to set a key · right-click for actions`;
      const cv = document.createElement('canvas');
      cv.className = 'fthumb';
      drawThumb(cv, fi);
      const no = document.createElement('span');
      no.className = 'fno2';
      no.textContent = String(i + 1);
      const badge = document.createElement('span');
      badge.className = 'fkey';
      badge.textContent = '◆';
      const act = document.createElement('button');
      act.className = 'fadd';
      act.textContent = keyed ? '✕' : '◆';
      act.title = keyed ? 'clear this key' : 'set a key at this frame';
      act.onpointerdown = (ev) => ev.stopPropagation();
      act.onclick = (ev) => {
        ev.stopPropagation();
        if (keyed) void clearKeyAtFrame(i);
        else void setKeyAtFrame(i);
      };
      cell.ondblclick = () => {
        if (!keyed) void setKeyAtFrame(i);
      };
      cell.oncontextmenu = (ev) => {
        ev.preventDefault();
        openCellMenu(i, cell);
      };
      cell.append(cv, no, badge, act);
      dopeCells.push(cell);
      dopeEl.appendChild(cell);
    });
    // mark the interpolated span between consecutive keys — the tween the
    // sampler fills in at playback
    for (let k = 0; k + 1 < keyedIdx.length; k++) {
      for (let i = keyedIdx[k] + 1; i < keyedIdx[k + 1]; i++) {
        dopeCells[i]?.classList.add('tween');
        if (dopeCells[i]) dopeCells[i].title += ' · interpolated between keys';
      }
    }
    // assembled clips can grow/shrink right from the strip
    const doc = curDoc();
    if (doc) {
      if (clip.frames.length > 1) {
        const shrink = document.createElement('div');
        shrink.className = 'fcell fgrow';
        shrink.textContent = '－';
        shrink.title = 'remove the last frame (keys snap to the new grid)';
        shrink.onclick = () => {
          withDocHistory(doc, 'remove frame', () => skelPatchClip(doc, clip.clipKey, { frames: clip.frames.length - 1 }));
          frameIdx = Math.min(frameIdx, Math.max(0, (activeClip()?.frames.length ?? 1) - 1));
          render();
        };
        dopeEl.appendChild(shrink);
      }
      const grow = document.createElement('div');
      grow.className = 'fcell fgrow';
      grow.textContent = '＋';
      grow.title = 'add a frame to this clip (existing keys snap to the new grid)';
      grow.onclick = () => {
        withDocHistory(doc, 'add frame', () => skelPatchClip(doc, clip.clipKey, { frames: clip.frames.length + 1 }));
        frameIdx = Math.max(0, (activeClip()?.frames.length ?? 1) - 1);
        render();
      };
      dopeEl.appendChild(grow);
    }
  }

  function renderDope(): void {
    const clip = activeClip();
    if (!current || !clip || !framesOpen) {
      dopeEl.innerHTML = '';
      dopeKey = '';
      return;
    }
    const key = `${roster[selected]?.id}|${clipIdx}|${clip.frames.length}|${dopeRev}`;
    if (key !== dopeKey) {
      rebuildDope(clip);
      dopeKey = key;
    }
    dopeCells.forEach((c, i) => c.classList.toggle('here', i === frameIdx));
  }

  /** Redraw one cell's thumbnail (live feedback while dragging a joint). */
  function refreshDopeThumb(i: number): void {
    const clip = activeClip();
    const cv = dopeCells[i]?.querySelector<HTMLCanvasElement>('.fthumb');
    if (clip && cv) drawThumb(cv, clip.frames[i] ?? 0);
  }

  function dopeIndexAt(clientX: number): number | null {
    if (!dopeCells.length) return null;
    for (const t of dopeCells) {
      const r = t.getBoundingClientRect();
      if (clientX >= r.left - 2 && clientX <= r.right + 2) return Number(t.dataset.i);
    }
    return clientX < dopeCells[0].getBoundingClientRect().left ? Number(dopeCells[0].dataset.i) : Number(dopeCells[dopeCells.length - 1].dataset.i);
  }

  dopeEl.addEventListener('pointerdown', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.fcell');
    if (!t) return;
    const i = Number(t.dataset.i);
    setPlaying(false);
    if (!Number.isFinite(i)) return; // the ＋ grow cell handles its own click
    if (t.classList.contains('key') && poseable()) {
      keyDrag = { from: i, to: i };
      dopeEl.setPointerCapture(e.pointerId);
    } else {
      frameIdx = i;
      curT = null;
      render();
    }
  });
  dopeEl.addEventListener('pointermove', (e) => {
    if (!keyDrag) return;
    const i = dopeIndexAt(e.clientX);
    if (i === null || i === keyDrag.to) return;
    keyDrag.to = i;
    dopeCells.forEach((t) => t.classList.toggle('drop', Number(t.dataset.i) === i));
  });
  function endKeyDrag(e: PointerEvent): void {
    if (!keyDrag) return;
    const { from, to } = keyDrag;
    keyDrag = null;
    try {
      dopeEl.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (from === to) {
      frameIdx = from;
      curT = null;
      render();
    } else if (!moveKeyOp(from, to)) {
      render();
    }
  }
  dopeEl.addEventListener('pointerup', endKeyDrag);
  dopeEl.addEventListener('pointercancel', endKeyDrag);

  // -------------------------------------------------------------------------
  // the timeline — keys at their true times, freely draggable
  // -------------------------------------------------------------------------
  const tpos = (t: number): string => `calc(8px + ${t.toFixed(5)} * (100% - 16px))`;

  /** Thumbnail of the pose AT a key's exact time — the keyframe made visible. */
  function drawKeyThumb(cv: HTMLCanvasElement, t: number): void {
    const clip = activeClip();
    const bodyId = current?.body.bodyId;
    if (!current?.body.renderPose || !clip || !bodyId) return;
    const b = current.bounds;
    const s = Math.min(38 / b.h, 54 / b.w);
    cv.width = Math.max(16, Math.round(b.w * s));
    cv.height = 38;
    const n = clip.frames.length;
    const fi = clip.frames[n <= 1 ? 0 : Math.round(t * (n - 1))] ?? 0;
    const posed = current.body.renderPose(fi, samplePose(store[bodyId]?.[clip.clipKey], t));
    if (!posed) return;
    const cx = cv.getContext('2d')!;
    cx.imageSmoothingEnabled = false;
    cx.drawImage(posed.canvas, b.x, b.y, b.w, b.h, (cv.width - b.w * s) / 2, (38 - b.h * s) / 2, b.w * s, b.h * s);
  }

  let tlineKey = '';
  function renderTimeline(): void {
    const clip = activeClip();
    const bodyId = current?.body.bodyId;
    if (!clip || !bodyId || !poseable()) {
      tlineEl.innerHTML = '';
      tlineKey = '';
      return;
    }
    const n = clip.frames.length;
    const rebuildKey = `${roster[selected]?.id}|${clipIdx}|${n}|${dopeRev}`;
    if (rebuildKey !== tlineKey) {
      tlineEl.innerHTML = '';
      const step = Math.max(1, Math.ceil(n / 60)); // don't wallpaper dense grids
      for (let i = 0; i < n; i += step) {
        const d = document.createElement('div');
        d.className = 'ttick';
        d.style.left = tpos(n <= 1 ? 0 : i / (n - 1));
        tlineEl.appendChild(d);
      }
      const ph = document.createElement('div');
      ph.className = 'tphead';
      tlineEl.appendChild(ph);
      const dur = clipDurationMs();
      for (const k of store[bodyId]?.[clip.clipKey]?.keys ?? []) {
        const card = document.createElement('div');
        card.className = 'tkeycard';
        card.style.left = tpos(k.t);
        card.dataset.t = String(k.t);
        card.title = `◆ key @ ${Math.round(k.t * dur)}ms (t=${k.t.toFixed(3)}) — drag ANYWHERE to retime (Shift = snap to frames) · click to select · right-click for actions`;
        const cv = document.createElement('canvas');
        cv.className = 'kthumb';
        drawKeyThumb(cv, k.t);
        const dia = document.createElement('div');
        dia.className = 'tkey';
        card.append(cv, dia);
        tlineEl.appendChild(card);
      }
      tlineKey = rebuildKey;
    }
    tlineEl.querySelectorAll<HTMLElement>('.tkeycard').forEach((c) => {
      c.classList.toggle('sel', curT !== null && Math.abs(Number(c.dataset.t) - curT) < KEY_EPS);
    });
    const ph = tlineEl.querySelector<HTMLDivElement>('.tphead');
    if (ph) ph.style.left = tpos(playT ?? curT ?? frameT(frameIdx));
  }

  function tlineT(e: { clientX: number }): number {
    const r = tlineEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left - 8) / Math.max(1, r.width - 16)));
  }

  /** Keys live at ANY time — free placement is the default; `snap` (Shift)
   *  quantises to the frame grid on request. */
  function snapT(t: number, snap: boolean): number {
    const clip = activeClip();
    if (!clip) return t;
    const n = clip.frames.length;
    if (n <= 1) return 0;
    return snap ? Math.round(t * (n - 1)) / (n - 1) : t;
  }

  let tDrag: { key: Keyframe; tl: NonNullable<ReturnType<typeof timelineFor>>; bodyId: string; before: string | null; moved: boolean; card: HTMLElement } | null = null;
  let tScrub = false;

  tlineEl.addEventListener('pointerdown', (e) => {
    const bodyId = current?.body.bodyId;
    const clip = activeClip();
    if (!bodyId || !clip || !poseable()) return;
    setPlaying(false);
    tlineEl.setPointerCapture(e.pointerId);
    const kEl = (e.target as HTMLElement).closest<HTMLElement>('.tkeycard');
    const tl = store[bodyId]?.[clip.clipKey];
    if (kEl && tl) {
      const t0 = Number(kEl.dataset.t);
      const key = tl.keys.find((k) => Math.abs(k.t - t0) < KEY_EPS);
      if (key) {
        tDrag = { key, tl, bodyId, before: snapshotClips(bodyId), moved: false, card: kEl };
        kEl.classList.add('dragging');
        seekT(key.t);
        return;
      }
    }
    tScrub = true;
    seekT(tlineT(e));
  });
  tlineEl.addEventListener('pointermove', (e) => {
    if (tDrag) {
      const t = snapT(tlineT(e), e.shiftKey);
      const clash = tDrag.tl.keys.some((k) => k !== tDrag!.key && Math.abs(k.t - t) < KEY_EPS);
      if (!clash) {
        tDrag.key.t = t;
        tDrag.tl.keys.sort((a, b) => a.t - b.t);
        tDrag.moved = true;
        tDrag.card.style.left = tpos(t);
        tDrag.card.dataset.t = String(t);
        seekT(t);
      }
      return;
    }
    if (tScrub) seekT(tlineT(e));
  });
  function endTline(e: PointerEvent): void {
    try {
      tlineEl.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    tScrub = false;
    if (!tDrag) return;
    const d = tDrag;
    tDrag = null;
    d.card.classList.remove('dragging');
    const after = snapshotClips(d.bodyId);
    if (d.moved && after !== d.before) {
      const bodyId = d.bodyId;
      const before = d.before;
      history.push({ label: 'retime key', undo: () => restoreClips(bodyId, before), redo: () => restoreClips(bodyId, after) });
      if (isSkelBodyId(bodyId)) scheduleSkelSave();
      dopeRev++;
      render();
    }
  }
  tlineEl.addEventListener('pointerup', endTline);
  tlineEl.addEventListener('pointercancel', endTline);

  tlineEl.addEventListener('dblclick', (e) => {
    const bodyId = current?.body.bodyId;
    const clip = activeClip();
    if (!bodyId || !clip || !poseable()) return;
    const t = snapT(tlineT(e), e.shiftKey);
    withClipsHistory('add key', bodyId, () => {
      keyAt(timelineFor(store, bodyId, clip.clipKey, true)!, t, true, (kEase.value as Ease) || 'linear');
    });
    seekT(t);
    if (!poseMode) setPoseMode(true);
  });

  tlineEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const kEl = (e.target as HTMLElement).closest<HTMLElement>('.tkeycard');
    if (!kEl || !poseable()) return;
    const t = Number(kEl.dataset.t);
    seekT(t);
    const items: { label: string; danger?: boolean; run: () => void }[] = [
      { label: '⧉ copy key', run: () => void copyKeyOp(t) },
    ];
    if (keyClipboard) items.push({ label: '⧉ paste here (replace)', run: () => void pasteKeyOp(t) });
    items.push({ label: '◆ duplicate → next slot', run: () => void duplicateKeyAtT(t) });
    items.push({ label: '✕ delete key', danger: true, run: () => void clearKeyAtT(t) });
    openMenu(items, kEl);
  });

  // -------------------------------------------------------------------------
  // keyframe CRUD ops
  // -------------------------------------------------------------------------
  function keyAtFrame(i: number): { tl: NonNullable<ReturnType<typeof timelineFor>>; key: Keyframe; t: number } | null {
    const clip = activeClip();
    const bodyId = current?.body.bodyId;
    if (!clip || !bodyId || !current) return null;
    const pf = current.body.plan[clip.frames[i] ?? -1];
    if (!pf) return null;
    const tl = store[bodyId]?.[pf.clip];
    const key = tl?.keys.find((kf) => Math.abs(kf.t - pf.t) < KEY_EPS);
    return tl && key ? { tl, key, t: pf.t } : null;
  }

  /** Move a key to an empty frame, or SWAP it with the key already there —
   *  dragging keys around the strip reorders them without losing either pose. */
  function moveKeyOp(fromI: number, toI: number): boolean {
    const clip = activeClip();
    const bodyId = current?.body.bodyId;
    if (!clip || !bodyId || !current || fromI === toI) return false;
    const src = keyAtFrame(fromI);
    const dst = keyAtFrame(toI);
    const pfTo = current.body.plan[clip.frames[toI] ?? -1];
    if (!src || !pfTo) return false;
    const srcT = src.t;
    withClipsHistory(dst ? 'swap keys' : 'move key', bodyId, () => {
      if (dst) {
        src.key.t = dst.t;
        dst.key.t = srcT;
      } else {
        clearKeyAt(src.tl, srcT);
        src.tl.keys.push({ ...src.key, t: pfTo.t });
      }
      src.tl.keys.sort((a, b) => a.t - b.t);
    });
    frameIdx = toI;
    curT = null;
    render();
    toast(dst ? `keys ${fromI + 1} ⇄ ${toI + 1} swapped` : `key moved to frame ${toI + 1}`);
    return true;
  }

  function setKeyAtFrame(i: number): boolean {
    const clip = activeClip();
    const bodyId = current?.body.bodyId;
    const pf = current?.body.plan[clip?.frames[i] ?? -1];
    if (!clip || !bodyId || !pf) return false;
    setPlaying(false); // land ON the keyed frame, not a moving playhead
    withClipsHistory('set key', bodyId, () => {
      keyAt(timelineFor(store, bodyId, pf.clip, true)!, pf.t, true, (kEase.value as Ease) || 'linear');
    });
    frameIdx = i;
    curT = null;
    if (!poseMode) setPoseMode(true); // keying implies posing — show the joints
    else render();
    return true;
  }

  function clearKeyAtFrame(i: number): boolean {
    const hit = keyAtFrame(i);
    const bodyId = current?.body.bodyId;
    if (!hit || !bodyId) return false;
    setPlaying(false);
    withClipsHistory('clear key', bodyId, () => clearKeyAt(hit.tl, hit.t));
    render();
    return true;
  }

  /** The key at continuous time `t` in the active clip's timeline. */
  function keyAtT(t: number): { tl: NonNullable<ReturnType<typeof timelineFor>>; key: Keyframe } | null {
    const clip = activeClip();
    const bodyId = current?.body.bodyId;
    if (!clip || !bodyId) return null;
    const tl = store[bodyId]?.[clip.clipKey];
    const key = tl?.keys.find((kf) => Math.abs(kf.t - t) < KEY_EPS);
    return tl && key ? { tl, key } : null;
  }

  function clearKeyAtT(t: number): boolean {
    const hit = keyAtT(t);
    const bodyId = current?.body.bodyId;
    if (!hit || !bodyId) return false;
    setPlaying(false);
    withClipsHistory('clear key', bodyId, () => clearKeyAt(hit.tl, t));
    if (curT !== null && Math.abs(curT - t) < KEY_EPS) curT = null;
    render();
    return true;
  }

  /** Duplicate the key at `t` one frame-slot later (replacing any occupant). */
  function duplicateKeyAtT(t: number): boolean {
    const clip = activeClip();
    const bodyId = current?.body.bodyId;
    const hit = keyAtT(t);
    if (!clip || !bodyId || !hit) return false;
    const n = clip.frames.length;
    const t2 = Math.min(1, t + (n <= 1 ? 0.25 : 1 / (n - 1)));
    if (Math.abs(t2 - t) < KEY_EPS) {
      toast('no room after this key');
      return false;
    }
    setPlaying(false);
    const clone = JSON.parse(JSON.stringify({ pose: hit.key.pose, ease: hit.key.ease })) as { pose: Pose; ease?: Ease };
    withClipsHistory('duplicate key', bodyId, () => {
      clearKeyAt(hit.tl, t2);
      hit.tl.keys.push({ t: t2, ease: clone.ease, pose: clone.pose });
      hit.tl.keys.sort((a, b) => a.t - b.t);
    });
    seekT(t2);
    return true;
  }

  function copyKeyOp(t?: number): boolean {
    const d = curDrive();
    const tt = t ?? d?.t;
    const hit = tt !== undefined ? keyAtT(tt) : null;
    if (!hit) {
      toast('no key at this time');
      return false;
    }
    keyClipboard = JSON.parse(JSON.stringify({ pose: hit.key.pose, ease: hit.key.ease })) as { pose: Pose; ease?: Ease };
    toast('key copied');
    return true;
  }

  function pasteKeyOp(t?: number): boolean {
    const d = curDrive();
    const clip = activeClip();
    const bodyId = current?.body.bodyId;
    const tt = t ?? d?.t;
    if (!keyClipboard || tt === undefined || !clip || !bodyId || !poseable()) {
      if (!keyClipboard) toast('nothing copied yet');
      return false;
    }
    setPlaying(false);
    const clone = JSON.parse(JSON.stringify(keyClipboard)) as { pose: Pose; ease?: Ease };
    withClipsHistory('paste key', bodyId, () => {
      const tl = timelineFor(store, bodyId, clip.clipKey, true)!;
      clearKeyAt(tl, tt);
      tl.keys.push({ t: tt, ease: clone.ease, pose: clone.pose });
      tl.keys.sort((a, b) => a.t - b.t);
    });
    seekT(tt);
    toast('key pasted');
    return true;
  }

  function openCellMenu(i: number, anchor: HTMLElement): void {
    const keyed = !!keyAtFrame(i);
    const t = frameT(i);
    const items: { label: string; danger?: boolean; run: () => void }[] = [];
    if (keyed) {
      items.push({ label: '⧉ copy key', run: () => void copyKeyOp(t) });
      if (keyClipboard) items.push({ label: '⧉ paste here (replace)', run: () => void pasteKeyOp(t) });
      items.push({ label: '◆ duplicate → next frame', run: () => void duplicateKeyAtT(t) });
      items.push({ label: '✕ clear key', danger: true, run: () => void clearKeyAtFrame(i) });
    } else {
      items.push({ label: '◆ set key here', run: () => void setKeyAtFrame(i) });
      if (keyClipboard) items.push({ label: '⧉ paste key here', run: () => void pasteKeyOp(t) });
    }
    openMenu(items, anchor);
  }

  function updateKeyUI(): void {
    const bodyId = current?.body.bodyId;
    const can = poseable() && !!bodyId;
    for (const b of [keyBtn, unkeyBtn, copyKeyBtn, pasteKeyBtn]) b.disabled = !can;
    kEase.disabled = !can;
    tDur.disabled = !can;
    $<HTMLButtonElement>('tAddKey').disabled = !can;
    $<HTMLButtonElement>('tDelKey').disabled = !can || !keyAtT(curDrive()?.t ?? -1);
    if (!can) {
      dopeEl.innerHTML = '';
      dopeKey = '';
      renderTimeline();
      keyInfo.textContent = current && !poseable() ? 'this body has no pose rig (view only)' : '';
      kCount.textContent = '0';
      return;
    }
    renderDope();
    renderTimeline();
    const d = curDrive();
    if (!d) return;
    const tl = store[bodyId!]?.[d.clip];
    const k = tl?.keys.find((kf) => Math.abs(kf.t - d.t) < KEY_EPS);
    const durMs = clipDurationMs();
    keyInfo.textContent = !poseMode
      ? '① pick a time  ② turn on ✎ pose edit'
      : k
        ? `◆ key @ ${Math.round(d.t * durMs)}ms (t=${d.t.toFixed(2)})`
        : tl?.keys.length
          ? `${Math.round(d.t * durMs)}ms · drag a joint or “set key”`
          : 'now drag a joint — every drag keys this time';
    kCount.textContent = String(tl?.keys.length ?? 0);
    if (k?.ease) kEase.value = k.ease;
    const doc = curDoc();
    const dur = doc ? durMs : (tl?.duration ?? durMs);
    cDur.value = String(dur);
    tDur.value = String(dur);
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
    if (mode === 'animate' && playing && clip && clip.frames.length > 1) {
      if (!last) last = now;
      if (curDoc()) {
        // assembled: a continuous clock over the clip duration
        const total = Math.max(60, clipDurationMs());
        playMs = (playMs + (now - last)) % total;
        playT = playMs / total;
        frameIdx = Math.min(clip.frames.length - 1, Math.round(playT * (clip.frames.length - 1)));
        render();
      } else {
        acc += now - last;
        const delays = effDelays(clip);
        let guard = 0;
        while (acc >= Math.max(30, delays[frameIdx] ?? 120) && guard++ < 8) {
          acc -= Math.max(30, delays[frameIdx] ?? 120);
          frameIdx = (frameIdx + 1) % clip.frames.length;
        }
        render();
      }
    }
    last = now;
    requestAnimationFrame(tick);
  }

  function setPlaying(p: boolean): void {
    playing = p;
    acc = 0;
    last = 0;
    if (p) {
      curT = null;
      playMs = 0;
    } else {
      playT = null;
    }
    playBtn.textContent = p ? '❚❚ pause' : '▶ play';
    playBtn.classList.toggle('play', !p);
  }

  function setClip(i: number): void {
    clipIdx = i;
    frameIdx = 0;
    curT = null;
    acc = 0;
    const clip = activeClip();
    scrubEl.max = String(Math.max(0, (clip?.frames.length ?? 1) - 1));
    renderClipTabs();
    updateInspector();
    render();
  }

  // -------------------------------------------------------------------------
  // clip tabs — with full CRUD on assembled bodies
  // -------------------------------------------------------------------------
  function renderClipTabs(): void {
    clipsEl.innerHTML = '';
    if (!current) return;
    const doc = curDoc();
    current.body.clips.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'as-clip' + (i === clipIdx ? ' on' : '');
      b.textContent = c.name;
      b.onclick = () => setClip(i);
      if (doc) {
        b.title = 'double-click to rename';
        b.ondblclick = () => startClipRename(c.clipKey);
      }
      clipsEl.appendChild(b);
    });
    if (doc) {
      const del = document.createElement('button');
      del.className = 'as-mini as-danger';
      del.textContent = '✕';
      del.title = 'delete this clip';
      del.onclick = () => {
        const key = activeClip()?.clipKey;
        if (key) void deleteClipOp(key);
      };
      clipsEl.appendChild(del);
      const menu = document.createElement('button');
      menu.className = 'as-mini';
      menu.textContent = '⋯';
      menu.title = 'clip actions (rename · duplicate · delete)';
      menu.onclick = () => {
        const key = activeClip()?.clipKey;
        if (!key) return;
        openMenu(
          [
            { label: '✎ rename', run: () => startClipRename(key) },
            { label: '⧉ duplicate', run: () => duplicateClipOp(key) },
            { label: '🗑 delete', danger: true, run: () => void deleteClipOp(key) },
          ],
          menu,
        );
      };
      clipsEl.appendChild(menu);
      const add = document.createElement('button');
      add.className = 'as-clipadd';
      add.textContent = '+ new clip';
      add.title = 'add a clip (then type its name)';
      add.onclick = () => addClipOp();
      clipsEl.appendChild(add);
    }
  }

  function startClipRename(key: string): void {
    const doc = curDoc();
    if (!doc) return;
    const i = current!.body.clips.findIndex((c) => c.clipKey === key);
    const btn = clipsEl.children[i] as HTMLElement | undefined;
    if (!btn) return;
    const input = document.createElement('input');
    input.className = 'as-clipedit';
    input.value = doc.clips.find((c) => c.key === key)?.name ?? '';
    btn.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (ok: boolean): void => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (ok && name) withDocHistory(doc, 'rename clip', () => skelRenameClip(doc, key, name));
      else renderClipTabs();
    };
    input.onblur = () => commit(true);
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commit(true);
      if (e.key === 'Escape') commit(false);
    };
  }

  function addClipOp(): string | null {
    const doc = curDoc();
    if (!doc) return null;
    const key = withDocHistory(doc, 'add clip', () => skelAddClip(doc, `clip ${doc.clips.length + 1}`).key);
    refreshSkelBody(key);
    frameIdx = 0;
    startClipRename(key);
    return key;
  }

  function duplicateClipOp(key: string): void {
    const doc = curDoc();
    if (!doc) return;
    const copy = withDocHistory(doc, 'duplicate clip', () => skelDuplicateClip(doc, key));
    if (copy) {
      refreshSkelBody(copy.key);
      toast(`duplicated as “${copy.name}”`);
    }
  }

  async function deleteClipOp(key: string): Promise<boolean> {
    const doc = curDoc();
    if (!doc) return false;
    if (doc.clips.length <= 1) {
      toast(`can't delete the last clip`);
      return false;
    }
    const c = doc.clips.find((x) => x.key === key);
    const keys = doc.timelines[key]?.keys.length ?? 0;
    const ok = await confirmBox(`Delete clip “${c?.name ?? key}”${keys ? ` and its ${keys} keyframe(s)` : ''}?`);
    if (!ok) return false;
    withDocHistory(doc, 'delete clip', () => skelRemoveClip(doc, key));
    refreshSkelBody();
    return true;
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
    if (!row) return;
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
    const doc = curDoc();
    editCharRow.classList.toggle('as-hidden', !doc);
    cFramesRow.classList.toggle('as-hidden', !doc);
    cFpsRow.classList.toggle('as-hidden', !doc);
    $('iFramesRow').classList.toggle('as-hidden', !!doc); // editable field replaces it
    const clip = activeClip();
    iFrames.textContent = clip ? String(clip.frames.length) : '—';
    if (clip) cDur.value = String(Math.round(effDelays(clip).reduce((a, b2) => a + b2, 0)));
    if (doc && clip) {
      cFrames.value = String(clip.frames.length);
      const fps = doc.clips.find((c) => c.key === clip.clipKey)?.fps ?? 60;
      cFps.value = String(Math.round(fps * 100) / 100);
    }
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
    curT = null;
    if (current) {
      const max = Math.max(1, Math.floor(Math.min((previewEl.width - 24) / current.bounds.w, (previewEl.height - 24) / current.bounds.h)));
      zoomEl.value = String(Math.min(Number(zoomEl.max), max));
    }
    poseMode = poseable() && poseWanted;
    poseEditEl.disabled = !poseable();
    poseEditEl.classList.toggle('on', poseMode);
    previewEl.classList.toggle('posing', poseMode);
    dopeRev++; // fresh bake → rebuild the filmstrip
    const clip = activeClip();
    scrubEl.max = String(Math.max(0, (clip?.frames.length ?? 1) - 1));
    setPlaying(true);
    renderClipTabs();
    updateInspector();
    renderList();
    render();
  }

  async function selectById(id: string): Promise<void> {
    const i = roster.findIndex((r) => r.id === id);
    if (i >= 0) await selectRow(i);
  }

  // -------------------------------------------------------------------------
  // roster list (grouped, searchable, with lazy thumbnails)
  // -------------------------------------------------------------------------
  const thumbCache = new Map<string, string | null>();
  function thumbInto(row: BodyDesc, img: HTMLImageElement): void {
    if (row.variants?.length) return; // variant bodies' thumbs depend on loadout; skip
    const doc = isSkelBodyId(row.id) ? docOfRow(row.id) : undefined;
    const tkey = doc ? skelCacheKey(doc) : row.id;
    if (thumbCache.has(tkey)) {
      const png = thumbCache.get(tkey);
      if (png) img.src = png;
      return;
    }
    void bakeOf(row).then((baked) => {
      const r = baked?.body.frame(0);
      if (!r) {
        thumbCache.set(tkey, null);
        return;
      }
      const c = document.createElement('canvas');
      c.width = r.w * 2;
      c.height = r.h * 2;
      const cx = c.getContext('2d')!;
      cx.imageSmoothingEnabled = false;
      cx.drawImage(r.src, r.x, r.y, r.w, r.h, 0, 0, r.w * 2, r.h * 2);
      const png = c.toDataURL('image/png');
      thumbCache.set(tkey, png);
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
  // save (assembled `sk:*` timelines persist with the skeleton file instead)
  // -------------------------------------------------------------------------
  function gameClips(): Record<string, unknown> {
    const pruned = prunedClips(store);
    for (const k of Object.keys(pruned)) if (isSkelBodyId(k)) delete pruned[k];
    return pruned;
  }

  async function saveClips(): Promise<boolean> {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clips: gameClips() }),
      });
      saveNote.textContent = res.ok ? '✓ saved — commit to seal it.' : `save failed (${res.status}); use copy JSON.`;
      return res.ok;
    } catch {
      saveNote.textContent = 'no dev save endpoint; use copy JSON.';
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // assemble mode
  // -------------------------------------------------------------------------
  const asm = mountAssembly({
    root: asmMain,
    docs,
    parts: skelParts,
    onPartsChanged: () => scheduleSkelSave(),
    history,
    toast,
    confirmBox,
    onDocChanged: (doc) => touchDoc(doc),
    onDocsListChanged: () => {
      rebuildRoster();
      scheduleSkelSave();
    },
    registerTimelines: (doc) => {
      store[skelBodyId(doc)] = doc.timelines;
    },
    releaseTimelines: (doc) => {
      delete store[skelBodyId(doc)];
    },
    animate: (docId) => {
      setMode('animate');
      // land ready to author: pose edit on, so dragging a joint keys at once
      void selectById(SKEL_PREFIX + docId).then(() => setPoseMode(true));
    },
  });

  // -------------------------------------------------------------------------
  // resizable left panel (shared width across both modes, persisted)
  // -------------------------------------------------------------------------
  const LEFTW_LS = 'anim-studio:leftw';
  {
    const saved = Number(localStorage.getItem(LEFTW_LS));
    if (saved >= 180 && saved <= 560) app.style.setProperty('--as-leftw', saved + 'px');
    const mountLeftResizer = (col: HTMLElement | null): void => {
      if (!col) return;
      const h = document.createElement('div');
      h.className = 'as-vresize';
      h.title = 'drag to resize the panel';
      col.appendChild(h);
      h.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        h.setPointerCapture(e.pointerId);
        h.classList.add('on');
        const startX = e.clientX;
        const startW = col.getBoundingClientRect().width;
        let w = startW;
        const move = (ev: PointerEvent): void => {
          w = Math.max(180, Math.min(560, startW + (ev.clientX - startX)));
          app.style.setProperty('--as-leftw', w + 'px');
        };
        const up = (): void => {
          h.classList.remove('on');
          h.removeEventListener('pointermove', move);
          localStorage.setItem(LEFTW_LS, String(Math.round(w)));
        };
        h.addEventListener('pointermove', move);
        h.addEventListener('pointerup', up, { once: true });
        h.addEventListener('pointercancel', up, { once: true });
      });
    };
    mountLeftResizer(app.querySelector('.as-roster'));
    mountLeftResizer(asmMain.querySelector('.asm-left'));
  }

  function setMode(m: StudioMode): void {
    if (mode === m) return;
    mode = m;
    closeMenu();
    tabAnimate.classList.toggle('on', m === 'animate');
    tabAssemble.classList.toggle('on', m === 'assemble');
    animMain.classList.toggle('as-hidden', m !== 'animate');
    asmMain.classList.toggle('as-hidden', m !== 'assemble');
    if (m === 'assemble') {
      setPlaying(false);
      asm.refresh();
    } else {
      rebuildRoster();
      void selectRow(selected);
    }
  }
  tabAnimate.onclick = () => setMode('animate');
  tabAssemble.onclick = () => setMode('assemble');

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
    curT = null;
    render();
  };
  stepFwd.onclick = () => {
    const clip = activeClip();
    if (!clip) return;
    setPlaying(false);
    frameIdx = (frameIdx + 1) % clip.frames.length;
    curT = null;
    render();
  };
  scrubEl.oninput = () => {
    setPlaying(false);
    frameIdx = Number(scrubEl.value);
    curT = null;
    render();
  };
  onionEl.onchange = () => render();
  guidesEl.onchange = () => render();
  zoomEl.oninput = () => render();
  gifEl.onclick = () => exportGif();

  poseEditEl.onclick = () => setPoseMode(!poseWanted);
  keyBtn.onclick = () => {
    if (!poseMode) setPoseMode(true); // "set key" implies posing
    const d = curDrive();
    const bodyId = current?.body.bodyId;
    if (!poseMode || !bodyId || !d) return;
    withClipsHistory('set key', bodyId, () => {
      keyAt(timelineFor(store, bodyId, d.clip, true)!, d.t, true, (kEase.value as Ease) || 'linear');
    });
    render();
  };
  unkeyBtn.onclick = () => {
    const d = curDrive();
    const bodyId = current?.body.bodyId;
    if (!bodyId || !d) return;
    const tl = store[bodyId]?.[d.clip];
    if (!tl) return;
    withClipsHistory('clear key', bodyId, () => clearKeyAt(tl, d.t));
    render();
  };
  copyKeyBtn.onclick = () => void copyKeyOp();
  pasteKeyBtn.onclick = () => void pasteKeyOp();
  $<HTMLButtonElement>('tAddKey').onclick = () => keyBtn.click();
  $<HTMLButtonElement>('tDelKey').onclick = () => unkeyBtn.click();
  const framesToggle = $<HTMLButtonElement>('framesToggle');
  const applyFramesOpen = (): void => {
    framesToggle.textContent = framesOpen ? 'frames ▾' : 'frames ▸';
    dopeEl.classList.toggle('as-hidden', !framesOpen);
  };
  applyFramesOpen();
  framesToggle.onclick = () => {
    framesOpen = !framesOpen;
    localStorage.setItem(FRAMES_LS, framesOpen ? '1' : '0');
    applyFramesOpen();
    render();
  };
  $('undoA').onclick = () => doUndo();
  $('redoA').onclick = () => doRedo();
  kEase.onchange = () => {
    const d = curDrive();
    const bodyId = current?.body.bodyId;
    if (!bodyId || !d) return;
    const k = store[bodyId]?.[d.clip]?.keys.find((kf) => Math.abs(kf.t - d.t) < KEY_EPS);
    if (k) {
      withClipsHistory('ease change', bodyId, () => {
        k.ease = kEase.value as Ease;
      });
      render();
    }
  };
  function applyDurationMs(ms: number): void {
    const d = curDrive();
    const bodyId = current?.body.bodyId;
    if (!bodyId || !d) return;
    const doc = curDoc();
    const clip = activeClip();
    if (doc && clip) {
      // fps stays put; the duration decides how many frames sample it
      const fps = doc.clips.find((c) => c.key === clip.clipKey)?.fps ?? 60;
      const frames = Math.max(1, Math.round(((ms || clipDurationMs()) * fps) / 1000));
      withDocHistory(doc, 'clip duration', () => skelPatchClip(doc, clip.clipKey, { frames }));
      refreshSkelBody();
    } else {
      withClipsHistory('clip duration', bodyId, () => {
        timelineFor(store, bodyId, d.clip, true)!.duration = ms || undefined;
      });
      render();
    }
  }
  cDur.onchange = () => applyDurationMs(Number(cDur.value) || 0);
  tDur.onchange = () => applyDurationMs(Number(tDur.value) || 0);
  cFrames.onchange = () => {
    const doc = curDoc();
    const clip = activeClip();
    if (!doc || !clip) return;
    withDocHistory(doc, 'clip frames', () => skelPatchClip(doc, clip.clipKey, { frames: Number(cFrames.value) || clip.frames.length }));
    refreshSkelBody();
  };
  cFps.onchange = () => {
    const doc = curDoc();
    const clip = activeClip();
    if (!doc || !clip) return;
    // keep the DURATION: re-count the frames at the new rate
    const dur = clipDurationMs();
    const fps = Math.max(1, Math.min(240, Number(cFps.value) || 60));
    withDocHistory(doc, 'clip fps', () => skelPatchClip(doc, clip.clipKey, { fps, frames: Math.max(1, Math.round((dur * fps) / 1000)) }));
    refreshSkelBody();
  };
  $('resetClip').onclick = () => {
    const d = curDrive();
    const bodyId = current?.body.bodyId;
    if (!bodyId || !d) return;
    const n = store[bodyId]?.[d.clip]?.keys.length ?? 0;
    if (!n && !store[bodyId]?.[d.clip]?.duration) return;
    void confirmBox(`Reset “${d.clip}” — delete ${n} keyframe(s) and its authored timing?`).then((ok) => {
      if (!ok) return;
      withClipsHistory('reset clip', bodyId, () => {
        const bc = store[bodyId];
        if (bc) delete bc[d.clip];
      });
      render();
    });
  };
  $('editChar').onclick = () => {
    const doc = curDoc();
    if (!doc) return;
    setMode('assemble');
    asm.selectDoc(doc.id);
  };
  saveBtn.onclick = () => void saveClips();
  copyBtn.onclick = () => {
    void navigator.clipboard?.writeText(JSON.stringify(gameClips(), null, 2));
    saveNote.textContent = 'copied JSON to clipboard.';
  };

  document.addEventListener('keydown', (e) => {
    if (!modalEl.classList.contains('as-hidden')) {
      if (e.key === 'Escape') closeModal(false);
      return;
    }
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement || t.isContentEditable) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) doRedo();
      else doUndo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      doRedo();
      return;
    }
    if (e.key === '?') {
      showHelp();
      return;
    }
    if (mode === 'assemble') {
      if (asm.handleKey(e)) e.preventDefault();
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      setPlaying(!playing);
    } else if (e.key === 'ArrowLeft') stepBack.click();
    else if (e.key === 'ArrowRight') stepFwd.click();
    else if (e.key === 'Home') {
      setPlaying(false);
      frameIdx = 0;
      curT = null;
      render();
    } else if (e.key === 'End') {
      const clip = activeClip();
      if (clip) {
        setPlaying(false);
        frameIdx = clip.frames.length - 1;
        curT = null;
        render();
      }
    } else if (e.key.toLowerCase() === 'k') keyBtn.click();
    else if (e.key.toLowerCase() === 'p') {
      if (!poseEditEl.disabled) setPoseMode(!poseWanted);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (poseMode) unkeyBtn.click();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (mode === 'assemble') asm.handleKey(e);
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
    setPose: (on: boolean) => setPoseMode(on),
    bones: () => handles.map((h) => ({ id: h.bone.id, kind: h.bone.kind, x: h.x, y: h.y })),
    nudge: (boneId: string, dAng: number) => {
      const d = curDrive();
      const bodyId = current?.body.bodyId;
      if (!bodyId || !d) return;
      withClipsHistory('nudge ' + boneId, bodyId, () => {
        const k = keyAt(timelineFor(store, bodyId, d.clip, true)!, d.t, true, (kEase.value as Ease) || 'linear')!;
        const off = (k.pose[boneId] ??= {});
        off.dAng = (off.dAng ?? 0) + dAng;
      });
      render();
    },
    authoredKeys: () => countKeys(store),
    save: saveClips,
    mode: () => mode,
    setMode,
    undo: () => history.undo(),
    redo: () => history.redo(),
    moveKey: moveKeyOp,
    copyKey: copyKeyOp,
    pasteKey: pasteKeyOp,
    addClip: (name) => {
      const doc = curDoc();
      if (!doc) return null;
      const key = withDocHistory(doc, 'add clip', () => skelAddClip(doc, name).key);
      refreshSkelBody(key);
      return key;
    },
    renameClip: (key, name) => {
      const doc = curDoc();
      if (!doc) return false;
      const ok = withDocHistory(doc, 'rename clip', () => skelRenameClip(doc, key, name));
      refreshSkelBody();
      return ok;
    },
    deleteClip: (key) => {
      const doc = curDoc();
      if (!doc) return false;
      const ok = withDocHistory(doc, 'delete clip', () => skelRemoveClip(doc, key));
      refreshSkelBody();
      return ok;
    },
    patchClip: (key, patch) => {
      const doc = curDoc();
      if (!doc) return false;
      const ok = withDocHistory(doc, 'patch clip', () => skelPatchClip(doc, key, patch));
      refreshSkelBody();
      return ok;
    },
    skeletons: () => docs.map((d) => ({ id: d.id, name: d.name, bones: d.bones.length, clips: d.clips.length })),
    newSkeleton: (name) => asm.createDoc(name).id,
    deleteSkeleton: (id) => {
      const i = docs.findIndex((d) => d.id === id);
      if (i < 0) return false;
      const doc = docs[i];
      docs.splice(i, 1);
      delete store[skelBodyId(doc)];
      rebuildRoster();
      scheduleSkelSave();
      if (asm.current()?.id === id) asm.selectDoc(docs[0]?.id ?? null);
      asm.refresh();
      if (current?.body.bodyId === skelBodyId(doc)) void selectRow(Math.min(selected, roster.length - 1));
      return true;
    },
    addSkelBone: (docId, o) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return null;
      const id = withDocHistory(doc, 'add bone', () => {
        const img = o.imgSrc ? { src: o.imgSrc, w: o.imgW ?? 8, h: o.imgH ?? 8, ax: 0, ay: 0, rot: 0, sx: 1, sy: 1 } : o.img;
        return skelAddBone(doc, { ...o, img }).id;
      });
      asm.refresh();
      return id;
    },
    patchSkelBone: (docId, boneId, patch) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return false;
      const bone = skelBoneById(doc, boneId);
      if (!bone) return false;
      const ok = withDocHistory(doc, 'edit bone', () => {
        if (patch.parent !== undefined && !skelReparentBone(doc, bone.id, patch.parent)) return false;
        for (const f of ['x', 'y', 'rot', 'sx', 'sy', 'len', 'z'] as const) {
          if (patch[f] !== undefined) bone[f] = patch[f];
        }
        if (patch.joint) bone.joint = patch.joint;
        if (patch.img && bone.img) Object.assign(bone.img, patch.img);
        if (patch.name !== undefined) skelRenameBone(doc, bone.id, patch.name);
        return true;
      });
      asm.refresh();
      return ok;
    },
    saveSkeletons: saveSkeletonDocs,
  };
  if (opts.hook !== false) {
    (window as unknown as Record<string, unknown>)[opts.hook ?? '__ae'] = api;
  }

  bootEl.classList.add('as-hidden');
  rebuildRoster();
  await selectRow(0);
  booted = true;
  requestAnimationFrame(tick);
  window.addEventListener('beforeunload', () => {
    alive = false;
  });
  return api;
}
