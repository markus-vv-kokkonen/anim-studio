/**
 * Assemble mode — build characters from image parts, Spine-style "setup mode":
 * import pictures, attach them as bones, drag/rotate/scale them into a rig,
 * parent bones into a hierarchy, and configure each joint. The result is a
 * {@link SkeletonDoc} that joins the roster as a poseable, keyframable body.
 *
 * The pane owns its own canvas (pan/zoom/gizmos) and panels; the studio mounts
 * it beside the Animate view and shares the toast/confirm/history services so
 * both modes feel like one tool.
 */
import type { History } from './history.ts';
import type { SkeletonDoc, SkelBone, SkelPart, Mat2D } from './skeleton.ts';
import {
  addBone, removeBone, renameBone, reparentBone, boneById, bonesByZ, moveBoneZ,
  worldTransforms, matApply, matInvert, matMul, uniqueSkelId, createSkeleton, descendants,
  snapshotDoc, restoreDoc, packSkeletons, unpackSkeletons,
} from './skeleton.ts';
import { drawSkeleton, preloadSkeleton } from './skeleton-render.ts';

// ---------------------------------------------------------------------------
// deps + pane surface
// ---------------------------------------------------------------------------
export interface AssemblyDeps {
  /** Container the pane renders into (the studio's `.asm-main` grid). */
  root: HTMLElement;
  /** The live document list (owned by the studio, mutated here). */
  docs: SkeletonDoc[];
  /** The persistent parts bin (loaded with — and saved into — the skeleton
   *  file, so imports survive reloads). */
  parts: SkelPart[];
  /** The bin changed (imports, removals) — persist it. */
  onPartsChanged(): void;
  history: History;
  toast(msg: string): void;
  confirmBox(msg: string): Promise<boolean>;
  /** An existing doc changed (bump its bake rev, persist, refresh roster). */
  onDocChanged(doc: SkeletonDoc): void;
  /** A doc was created or deleted (rebuild roster, persist). */
  onDocsListChanged(): void;
  /** Inject / remove `store[sk:<id>] = doc.timelines` in the live clip store. */
  registerTimelines(doc: SkeletonDoc): void;
  releaseTimelines(doc: SkeletonDoc): void;
  /** Jump to Animate mode with this character selected. */
  animate(docId: string): void;
}

export interface AssemblyPane {
  refresh(): void;
  current(): SkeletonDoc | null;
  selectDoc(id: string | null): void;
  selectedBone(): string | null;
  selectBone(id: string | null): void;
  createDoc(name: string): SkeletonDoc;
  deleteDoc(id: string): Promise<boolean>;
  /** Keydown routed from the studio while Assemble mode is active. */
  handleKey(e: KeyboardEvent): boolean;
}

// gizmo geometry (screen px)
const HANDLE_R = 7;
const PIVOT_R = 5;
const PART_MAX = 512; // imported images are capped to keep docs storable

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const DEG = 180 / Math.PI;

// ---------------------------------------------------------------------------
// small DOM helpers
// ---------------------------------------------------------------------------
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function numInput(step: number, width = 64): HTMLInputElement {
  const i = el('input');
  i.type = 'number';
  i.step = String(step);
  i.style.width = width + 'px';
  return i;
}

function fieldRow(label: string, ...controls: HTMLElement[]): HTMLDivElement {
  const f = el('div', 'as-field');
  f.appendChild(el('label', undefined, label));
  const wrap = el('div', 'as-fieldctl');
  for (const c of controls) wrap.appendChild(c);
  f.appendChild(wrap);
  return f;
}

const readAsDataURL = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed to load'));
    img.src = src;
  });

/** File → part, re-encoding down to {@link PART_MAX} on the long edge so a
 *  photo-sized import can't bloat the doc. */
async function fileToPart(file: File): Promise<SkelPart> {
  let src = await readAsDataURL(file);
  let img = await loadImage(src);
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  const long = Math.max(w, h);
  if (long > PART_MAX) {
    const k = PART_MAX / long;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    src = c.toDataURL('image/png');
    img = await loadImage(src);
    w = img.naturalWidth;
    h = img.naturalHeight;
  }
  const name = file.name.replace(/\.[^.]+$/, '') || 'part';
  return { name, src, w, h };
}

// ---------------------------------------------------------------------------
// the pane
// ---------------------------------------------------------------------------
const SHELL = `
<div class="asm-left as-col">
  <div class="as-sect">
    <h3>Characters <button class="as-mini" data-asm="newChar" title="new character (N)">+ new</button>
      <button class="as-mini" data-asm="exportChars" title="download all characters as JSON">↓ save</button>
      <button class="as-mini" data-asm="importChars" title="load characters from a JSON file">↑ load</button></h3>
    <div class="asm-charlist" data-asm="charList"></div>
  </div>
  <div class="as-sect asm-partsect">
    <h3>Parts <button class="as-mini" data-asm="importBtn" title="import images as parts">↑ import…</button></h3>
    <div class="asm-partgrid" data-asm="partGrid"></div>
    <div class="as-note">Import PNGs (or drop them on the canvas), then click a part to
    attach it as a new bone under the selected bone.</div>
  </div>
</div>
<div class="asm-stage as-col">
  <div class="asm-toolbar">
    <button data-asm="addBone" title="add an empty bone under the selection (B)">+ bone</button>
    <button data-asm="undoBtn" title="undo (Ctrl+Z)">↶ undo</button>
    <button data-asm="redoBtn" title="redo (Ctrl+Shift+Z)">↷ redo</button>
    <label class="chk"><input type="checkbox" data-asm="gridChk" checked /> grid</label>
    <span class="asm-zoom" data-asm="zoomLabel">100%</span>
    <span style="flex:1"></span>
    <span class="asm-hint" data-asm="hint">drag: move · ◦ handle: rotate · ▪ handle: scale · wheel: zoom · drag empty space: pan</span>
  </div>
  <div class="asm-canvaswrap" data-asm="canvasWrap">
    <canvas data-asm="canvas"></canvas>
    <div class="asm-empty as-hidden" data-asm="empty">
      <div>
        <p><b>No characters yet.</b></p>
        <p>Create one, import a few PNG parts, and snap them together into a rig —<br/>
        then switch to <b>Animate</b> to keyframe it.</p>
        <button data-asm="emptyNew">+ new character</button>
      </div>
    </div>
  </div>
</div>
<div class="asm-right as-col as-inspector">
  <div class="as-sect" data-asm="charSect">
    <h3>Character</h3>
    <div data-asm="charFields"></div>
    <div class="as-row-btns">
      <button data-asm="animateBtn" title="keyframe this character">▶ animate</button>
      <button data-asm="dupChar">⧉ duplicate</button>
      <button data-asm="delChar" class="as-danger">🗑 delete</button>
    </div>
  </div>
  <div class="as-sect" data-asm="treeSect">
    <h3>Skeleton</h3>
    <div class="asm-tree" data-asm="tree"></div>
  </div>
  <div class="as-sect" data-asm="boneSect">
    <h3>Bone</h3>
    <div data-asm="boneFields"></div>
  </div>
  <div class="as-sect" data-asm="jointSect">
    <h3>Joint</h3>
    <div data-asm="jointFields"></div>
    <div class="as-note">Joints govern Animate mode: <b>free</b> rotates without limits,
    <b>hinge</b> clamps to the range, <b>fixed</b> welds the bone.</div>
  </div>
  <div class="as-sect" data-asm="imgSect">
    <h3>Image</h3>
    <div data-asm="imgFields"></div>
  </div>
</div>
`;

export function mountAssembly(deps: AssemblyDeps): AssemblyPane {
  const { root, docs, history } = deps;
  root.innerHTML = SHELL;
  const $ = <T extends HTMLElement>(name: string): T => root.querySelector(`[data-asm="${name}"]`) as T;

  const canvas = $<HTMLCanvasElement>('canvas');
  const ctx = canvas.getContext('2d')!;
  const wrap = $<HTMLDivElement>('canvasWrap');
  const emptyEl = $<HTMLDivElement>('empty');
  const charList = $<HTMLDivElement>('charList');
  const partGrid = $<HTMLDivElement>('partGrid');
  const treeEl = $<HTMLDivElement>('tree');
  const zoomLabel = $<HTMLSpanElement>('zoomLabel');

  // ---- state ---------------------------------------------------------------
  let doc: SkeletonDoc | null = null;
  let selBone: string | null = null;
  const parts = deps.parts;
  const view = { ox: 0, oy: 0, scale: 2 };
  let spaceHeld = false;

  const cur = (): SkeletonDoc | null => doc;
  const curBone = (): SkelBone | null => (doc && selBone ? (boneById(doc, selBone) ?? null) : null);

  // ---- history helper ------------------------------------------------------
  /** Run a doc mutation with undo/redo + persistence. Returns fn's result. */
  function withDoc<T>(label: string, fn: () => T): T {
    const d = doc!;
    const before = snapshotDoc(d);
    const out = fn();
    const after = snapshotDoc(d);
    if (after !== before) {
      history.push({
        label,
        undo: () => {
          restoreDoc(d, before);
          afterRestore(d);
        },
        redo: () => {
          restoreDoc(d, after);
          afterRestore(d);
        },
      });
      deps.onDocChanged(d);
    }
    refresh();
    return out;
  }
  function afterRestore(d: SkeletonDoc): void {
    if (selBone && !boneById(d, selBone)) selBone = null;
    deps.onDocChanged(d);
    refresh();
  }

  // ---- view transforms -----------------------------------------------------
  const toScreen = (x: number, y: number): [number, number] => [x * view.scale + view.ox, y * view.scale + view.oy];
  const toWorld = (sx: number, sy: number): [number, number] => [(sx - view.ox) / view.scale, (sy - view.oy) / view.scale];

  function fitView(): void {
    if (!doc) return;
    const s = Math.max(0.25, Math.min(8, Math.min(canvas.width / (doc.fw + 48), canvas.height / (doc.fh + 48))));
    view.scale = s;
    view.ox = (canvas.width - doc.fw * s) / 2;
    view.oy = (canvas.height - doc.fh * s) / 2;
  }

  // ---- canvas painting -----------------------------------------------------
  function paint(): void {
    const w = canvas.width;
    const h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!doc) return;

    // frame box + grid
    const [fx, fy] = toScreen(0, 0);
    const fw = doc.fw * view.scale;
    const fh = doc.fh * view.scale;
    ctx.fillStyle = 'rgba(12,14,23,0.55)';
    ctx.fillRect(fx, fy, fw, fh);
    if ($<HTMLInputElement>('gridChk').checked && 16 * view.scale >= 8) {
      ctx.strokeStyle = 'rgba(140,150,191,0.12)';
      ctx.lineWidth = 1;
      const step = 16 * view.scale;
      ctx.beginPath();
      for (let x = fx % step; x < w; x += step) {
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, h);
      }
      for (let y = fy % step; y < h; y += step) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(w, Math.round(y) + 0.5);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(115,239,247,0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(fx) + 0.5, Math.round(fy) + 0.5, Math.round(fw), Math.round(fh));

    // the character itself
    ctx.save();
    ctx.setTransform(view.scale, 0, 0, view.scale, view.ox, view.oy);
    drawSkeleton(ctx, doc, undefined, false, paint);
    ctx.restore();

    // bone widgets
    const worlds = worldTransforms(doc);
    for (const bone of bonesByZ(doc)) {
      const wm = worlds.get(bone.id)!;
      const [px, py] = matApply(wm, 0, 0);
      const [tx, ty] = matApply(wm, bone.len, 0);
      const [spx, spy] = toScreen(px, py);
      const [stx, sty] = toScreen(tx, ty);
      const selected = bone.id === selBone;
      const col = bone.parent === null ? '#ffcd75' : bone.joint.type === 'fixed' ? '#8c96bf' : '#73eff7';

      if (bone.parent) {
        const pw = worlds.get(bone.parent);
        if (pw) {
          const [ppx, ppy] = matApply(pw, 0, 0);
          const [sppx, sppy] = toScreen(ppx, ppy);
          ctx.strokeStyle = 'rgba(140,150,191,0.35)';
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(sppx, sppy);
          ctx.lineTo(spx, spy);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // bone: a slim triangle pivot→tip, Spine-style
      const ang = Math.atan2(sty - spy, stx - spx);
      const side = 3.2;
      ctx.beginPath();
      ctx.moveTo(spx + Math.cos(ang + Math.PI / 2) * side, spy + Math.sin(ang + Math.PI / 2) * side);
      ctx.lineTo(stx, sty);
      ctx.lineTo(spx + Math.cos(ang - Math.PI / 2) * side, spy + Math.sin(ang - Math.PI / 2) * side);
      ctx.closePath();
      ctx.fillStyle = selected ? col : col + '55';
      ctx.fill();
      ctx.strokeStyle = selected ? '#f4f4f4' : '#0c0e17';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(spx, spy, selected ? PIVOT_R + 1 : PIVOT_R - 1, 0, 7);
      ctx.fillStyle = selected ? col : col + '99';
      ctx.fill();
      ctx.strokeStyle = '#0c0e17';
      ctx.stroke();

      if (selected) {
        // attachment outline
        if (bone.img) {
          const a = bone.img;
          const am = matMul(wm, [
            Math.cos(a.rot) * a.sx, Math.sin(a.rot) * a.sx,
            -Math.sin(a.rot) * a.sy, Math.cos(a.rot) * a.sy,
            a.ax, a.ay,
          ]);
          const cs = [
            matApply(am, -a.w / 2, -a.h / 2),
            matApply(am, a.w / 2, -a.h / 2),
            matApply(am, a.w / 2, a.h / 2),
            matApply(am, -a.w / 2, a.h / 2),
          ].map(([x, y]) => toScreen(x, y));
          ctx.strokeStyle = 'rgba(244,244,244,0.5)';
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(cs[0][0], cs[0][1]);
          for (const [x, y] of cs.slice(1)) ctx.lineTo(x, y);
          ctx.closePath();
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // rotate handle (circle past the tip) + scale handle (square)
        const [rx, ry] = rotHandlePos(bone, wm);
        ctx.beginPath();
        ctx.arc(rx, ry, HANDLE_R, 0, 7);
        ctx.strokeStyle = '#f4f4f4';
        ctx.lineWidth = 1.6;
        ctx.stroke();
        const [sx2, sy2] = scaleHandlePos(bone, wm);
        ctx.strokeRect(sx2 - HANDLE_R + 1.5, sy2 - HANDLE_R + 1.5, (HANDLE_R - 1.5) * 2, (HANDLE_R - 1.5) * 2);
      }
    }
  }

  function rotHandlePos(bone: SkelBone, wm: Mat2D): [number, number] {
    const [px, py] = toScreen(...matApply(wm, 0, 0));
    const [tx, ty] = toScreen(...matApply(wm, bone.len, 0));
    const ang = Math.atan2(ty - py, tx - px);
    const d = Math.hypot(tx - px, ty - py) + 22;
    return [px + Math.cos(ang) * d, py + Math.sin(ang) * d];
  }
  function scaleHandlePos(bone: SkelBone, wm: Mat2D): [number, number] {
    const [px, py] = toScreen(...matApply(wm, 0, 0));
    const [tx, ty] = toScreen(...matApply(wm, bone.len, 0));
    const ang = Math.atan2(ty - py, tx - px);
    const d = Math.hypot(tx - px, ty - py) + 44;
    return [px + Math.cos(ang) * d, py + Math.sin(ang) * d];
  }

  // ---- hit testing ---------------------------------------------------------
  type Hit = { bone: string; part: 'pivot' | 'rotate' | 'scale' | 'body' };

  function hitTest(sx: number, sy: number): Hit | null {
    if (!doc) return null;
    const worlds = worldTransforms(doc);
    const sel = curBone();
    if (sel) {
      const wm = worlds.get(sel.id)!;
      const [rx, ry] = rotHandlePos(sel, wm);
      if (Math.hypot(sx - rx, sy - ry) <= HANDLE_R + 3) return { bone: sel.id, part: 'rotate' };
      const [cx, cy] = scaleHandlePos(sel, wm);
      if (Math.hypot(sx - cx, sy - cy) <= HANDLE_R + 3) return { bone: sel.id, part: 'scale' };
    }
    // pivots first (they're small and exact), topmost draw order wins
    const order = bonesByZ(doc).reverse();
    for (const b of order) {
      const [px, py] = toScreen(...matApply(worlds.get(b.id)!, 0, 0));
      if (Math.hypot(sx - px, sy - py) <= PIVOT_R + 4) return { bone: b.id, part: 'pivot' };
    }
    // then attachment bodies
    const [wx, wy] = toWorld(sx, sy);
    for (const b of order) {
      if (!b.img) continue;
      const a = b.img;
      const am = matMul(worlds.get(b.id)!, [
        Math.cos(a.rot) * a.sx, Math.sin(a.rot) * a.sx,
        -Math.sin(a.rot) * a.sy, Math.cos(a.rot) * a.sy,
        a.ax, a.ay,
      ]);
      const [lx, ly] = matApply(matInvert(am), wx, wy);
      if (Math.abs(lx) <= a.w / 2 && Math.abs(ly) <= a.h / 2) return { bone: b.id, part: 'body' };
    }
    return null;
  }

  // ---- drag machinery ------------------------------------------------------
  interface Drag {
    kind: 'pan' | 'move' | 'rotate' | 'scale';
    boneId?: string;
    startX: number;
    startY: number;
    viewOx: number;
    viewOy: number;
    base?: { x: number; y: number; rot: number; sx: number; sy: number };
    pivotSx?: number;
    pivotSy?: number;
    downAng?: number;
    downDist?: number;
    parentInv?: Mat2D;
    snap?: string;
  }
  let drag: Drag | null = null;

  function pointerPos(e: PointerEvent): [number, number] {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height];
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!doc) return;
    const [sx, sy] = pointerPos(e);
    canvas.setPointerCapture(e.pointerId);
    const pan = (): void => {
      drag = { kind: 'pan', startX: sx, startY: sy, viewOx: view.ox, viewOy: view.oy };
      canvas.style.cursor = 'grabbing';
    };
    if (e.button === 1 || spaceHeld) return pan();
    const hit = hitTest(sx, sy);
    if (!hit) {
      selBone = null;
      renderPanels();
      paint();
      return pan();
    }
    if (hit.bone !== selBone) {
      selBone = hit.bone;
      renderPanels();
    }
    const bone = curBone()!;
    const worlds = worldTransforms(doc);
    const wm = worlds.get(bone.id)!;
    const [px, py] = toScreen(...matApply(wm, 0, 0));
    const parentW = bone.parent ? (worlds.get(bone.parent) ?? [1, 0, 0, 1, 0, 0]) : ([1, 0, 0, 1, 0, 0] as Mat2D);
    drag = {
      kind: hit.part === 'rotate' ? 'rotate' : hit.part === 'scale' ? 'scale' : 'move',
      boneId: bone.id,
      startX: sx,
      startY: sy,
      viewOx: view.ox,
      viewOy: view.oy,
      base: { x: bone.x, y: bone.y, rot: bone.rot, sx: bone.sx, sy: bone.sy },
      pivotSx: px,
      pivotSy: py,
      downAng: Math.atan2(sy - py, sx - px),
      downDist: Math.max(8, Math.hypot(sx - px, sy - py)),
      parentInv: matInvert(parentW),
      snap: snapshotDoc(doc),
    };
    paint();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!doc) return;
    const [sx, sy] = pointerPos(e);
    if (!drag) {
      const hit = hitTest(sx, sy);
      canvas.style.cursor = spaceHeld ? 'grab' : hit ? (hit.part === 'rotate' ? 'crosshair' : hit.part === 'scale' ? 'nwse-resize' : 'move') : 'default';
      return;
    }
    if (drag.kind === 'pan') {
      view.ox = drag.viewOx + (sx - drag.startX);
      view.oy = drag.viewOy + (sy - drag.startY);
      paint();
      return;
    }
    const bone = drag.boneId ? boneById(doc, drag.boneId) : null;
    if (!bone || !drag.base) return;
    if (drag.kind === 'move') {
      // screen delta → parent-space delta (parent scale/rotation respected)
      const [ax, ay] = matApply(drag.parentInv!, ...toWorld(sx, sy));
      const [bx, by] = matApply(drag.parentInv!, ...toWorld(drag.startX, drag.startY));
      bone.x = r2(drag.base.x + (ax - bx));
      bone.y = r2(drag.base.y + (ay - by));
    } else if (drag.kind === 'rotate') {
      let delta = Math.atan2(sy - drag.pivotSy!, sx - drag.pivotSx!) - drag.downAng!;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      if (e.shiftKey) delta = Math.round((delta * DEG) / 15) * (15 / DEG); // 15° snap
      bone.rot = r4(drag.base.rot + delta);
    } else {
      const k = Math.max(0.05, Math.hypot(sx - drag.pivotSx!, sy - drag.pivotSy!) / drag.downDist!);
      bone.sx = r3(drag.base.sx * k);
      bone.sy = r3(drag.base.sy * k);
    }
    renderBoneFields();
    paint();
  });

  function endDrag(e: PointerEvent): void {
    if (!drag) return;
    const d = drag;
    drag = null;
    canvas.style.cursor = 'default';
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (d.kind !== 'pan' && doc && d.snap) {
      const after = snapshotDoc(doc);
      if (after !== d.snap) {
        const dd = doc;
        const before = d.snap;
        history.push({
          label: d.kind + ' bone',
          undo: () => {
            restoreDoc(dd, before);
            afterRestore(dd);
          },
          redo: () => {
            restoreDoc(dd, after);
            afterRestore(dd);
          },
        });
        deps.onDocChanged(dd);
        renderPanels();
      }
    }
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('wheel', (e) => {
    if (!doc) return;
    e.preventDefault();
    const [sx, sy] = pointerPos(e as unknown as PointerEvent);
    const [wx, wy] = toWorld(sx, sy);
    const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    view.scale = Math.max(0.25, Math.min(12, view.scale * k));
    view.ox = sx - wx * view.scale;
    view.oy = sy - wy * view.scale;
    zoomLabel.textContent = Math.round(view.scale * 100) + '%';
    paint();
  }, { passive: false });

  // drop image files straight onto the canvas
  wrap.addEventListener('dragover', (e) => {
    e.preventDefault();
    wrap.classList.add('drop');
  });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drop'));
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    wrap.classList.remove('drop');
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    const r = canvas.getBoundingClientRect();
    const sx = ((e.clientX - r.left) * canvas.width) / r.width;
    const sy = ((e.clientY - r.top) * canvas.height) / r.height;
    void importFiles(files, toWorld(sx, sy));
  });

  // ---- parts ---------------------------------------------------------------
  async function importFiles(files: File[], dropAt?: [number, number]): Promise<void> {
    let made = 0;
    for (const f of files) {
      try {
        const part = await fileToPart(f);
        parts.push(part);
        if (doc && dropAt) {
          attachPart(part, [dropAt[0] + made * 12, dropAt[1] + made * 12]);
          made++;
        }
      } catch {
        deps.toast(`couldn't read ${f.name}`);
      }
    }
    deps.onPartsChanged();
    renderParts();
    if (!doc) deps.toast(`imported ${files.length} part${files.length === 1 ? '' : 's'} — create a character to use them`);
  }

  /** Attach a part as a NEW bone under the selected bone (world pos given or
   *  centre-frame), named after the part. */
  function attachPart(part: SkelPart, atWorld?: [number, number]): void {
    if (!doc) return;
    const d = doc;
    withDoc('attach part', () => {
      const parentId = selBone ?? (boneById(d, 'root') ? 'root' : null);
      const worlds = worldTransforms(d);
      const pw = parentId ? (worlds.get(parentId) ?? null) : null;
      const [wx, wy] = atWorld ?? [d.fw / 2, d.fh / 2];
      const [lx, ly] = pw ? matApply(matInvert(pw), wx, wy) : [wx, wy];
      const bone = addBone(d, {
        name: part.name,
        parent: parentId,
        x: r2(lx),
        y: r2(ly),
        len: Math.max(10, Math.round(Math.max(part.w, part.h) * 0.4)),
        img: { src: part.src, w: part.w, h: part.h, ax: 0, ay: 0, rot: 0, sx: 1, sy: 1 },
      });
      selBone = bone.id;
    });
    void preloadSkeleton(d).then(paint);
  }

  function renderParts(): void {
    partGrid.innerHTML = '';
    if (!parts.length) {
      partGrid.appendChild(el('div', 'as-note', 'no parts imported yet'));
      return;
    }
    parts.forEach((part, pi) => {
      const cell = el('div', 'asm-part');
      cell.title = `${part.name} · ${part.w}×${part.h} — click to attach under the selected bone`;
      const img = el('img');
      img.src = part.src;
      img.alt = part.name;
      cell.appendChild(img);
      cell.appendChild(el('div', 'asm-partname', part.name));
      const rm = el('button', 'asm-partrm', '✕');
      rm.title = 'remove from the bin (bones keep their copies)';
      rm.onclick = (ev) => {
        ev.stopPropagation();
        parts.splice(pi, 1);
        deps.onPartsChanged();
        renderParts();
      };
      cell.appendChild(rm);
      cell.onclick = () => {
        if (!doc) {
          deps.toast('create a character first');
          return;
        }
        attachPart(part);
      };
      partGrid.appendChild(cell);
    });
  }

  // ---- characters ----------------------------------------------------------
  function createDoc(name: string): SkeletonDoc {
    const id = uniqueSkelId(docs.map((d) => d.id), name);
    const d = createSkeleton(id, name.trim() || id);
    docs.push(d);
    deps.registerTimelines(d);
    deps.onDocsListChanged();
    selectDoc(id);
    return d;
  }

  async function deleteDoc(id: string): Promise<boolean> {
    const i = docs.findIndex((d) => d.id === id);
    if (i < 0) return false;
    const d = docs[i];
    const ok = await deps.confirmBox(`Delete character “${d.name}” and all its clips? This can't be undone.`);
    if (!ok) return false;
    docs.splice(i, 1);
    deps.releaseTimelines(d);
    deps.onDocsListChanged();
    if (doc === d) {
      doc = docs[0] ?? null;
      selBone = null;
    }
    refresh();
    return true;
  }

  function duplicateDoc(src: SkeletonDoc): void {
    const id = uniqueSkelId(docs.map((d) => d.id), src.name + ' copy');
    const clone = JSON.parse(JSON.stringify({ ...src, id, name: src.name + ' copy' })) as SkeletonDoc;
    docs.push(clone);
    deps.registerTimelines(clone);
    deps.onDocsListChanged();
    selectDoc(id);
    deps.toast(`duplicated as “${clone.name}”`);
  }

  function selectDoc(id: string | null): void {
    doc = id ? (docs.find((d) => d.id === id) ?? null) : null;
    selBone = null;
    if (doc) {
      void preloadSkeleton(doc).then(paint);
      fitView();
    }
    refresh();
  }

  function renderChars(): void {
    charList.innerHTML = '';
    if (!docs.length) {
      charList.appendChild(el('div', 'as-note', 'none yet — create one'));
      return;
    }
    for (const d of docs) {
      const row = el('div', 'as-row' + (d === doc ? ' sel' : ''));
      const meta = el('div', 'meta');
      meta.appendChild(el('div', 'nm', d.name));
      meta.appendChild(el('div', 'ti', `${d.bones.length} bones · ${d.clips.length} clips`));
      row.appendChild(meta);
      row.onclick = () => selectDoc(d.id);
      charList.appendChild(row);
    }
  }

  // ---- inspector panels ----------------------------------------------------
  function renderCharFields(): void {
    const holder = $<HTMLDivElement>('charFields');
    holder.innerHTML = '';
    if (!doc) return;
    const d = doc;
    const name = el('input');
    name.value = d.name;
    name.style.width = '130px';
    name.onchange = () => withDoc('rename character', () => {
      d.name = name.value.trim() || d.name;
    });
    holder.appendChild(fieldRow('name', name));
    const fw = numInput(16, 60);
    fw.value = String(d.fw);
    const fh = numInput(16, 60);
    fh.value = String(d.fh);
    fw.onchange = () => withDoc('resize frame', () => {
      d.fw = Math.max(32, Math.min(1024, Number(fw.value) || d.fw));
    });
    fh.onchange = () => withDoc('resize frame', () => {
      d.fh = Math.max(32, Math.min(1024, Number(fh.value) || d.fh));
    });
    holder.appendChild(fieldRow('frame size', fw, el('span', undefined, '×'), fh));
  }

  function renderTree(): void {
    treeEl.innerHTML = '';
    if (!doc) return;
    const d = doc;
    const kids = new Map<string | null, SkelBone[]>();
    for (const b of d.bones) {
      const list = kids.get(b.parent) ?? [];
      list.push(b);
      kids.set(b.parent, list);
    }
    const add = (parent: string | null, depth: number): void => {
      for (const b of (kids.get(parent) ?? []).sort((x, y) => x.z - y.z)) {
        const row = el('div', 'asm-treerow' + (b.id === selBone ? ' sel' : ''));
        row.style.paddingLeft = 8 + depth * 14 + 'px';
        row.appendChild(el('span', 'asm-treedot' + (b.img ? ' img' : '')));
        row.appendChild(el('span', undefined, b.id));
        if (b.joint.type !== 'free') row.appendChild(el('span', 'asm-treejoint', b.joint.type === 'hinge' ? '⟲' : '⚓'));
        row.onclick = () => {
          selBone = b.id;
          renderPanels();
          paint();
        };
        treeEl.appendChild(row);
        add(b.id, depth + 1);
      }
    };
    add(null, 0);
  }

  function renderBoneFields(): void {
    const holder = $<HTMLDivElement>('boneFields');
    const bone = curBone();
    $<HTMLDivElement>('boneSect').classList.toggle('as-hidden', !bone);
    $<HTMLDivElement>('jointSect').classList.toggle('as-hidden', !bone);
    $<HTMLDivElement>('imgSect').classList.toggle('as-hidden', !bone);
    holder.innerHTML = '';
    if (!doc || !bone) return;
    const d = doc;

    const name = el('input');
    name.value = bone.id;
    name.style.width = '130px';
    name.onchange = () => withDoc('rename bone', () => {
      selBone = renameBone(d, bone.id, name.value);
    });
    holder.appendChild(fieldRow('name', name));

    const parentSel = el('select');
    const none = el('option', undefined, '(none — canvas)');
    none.value = '';
    parentSel.appendChild(none);
    const blocked = new Set([bone.id, ...(doc ? [...descendants(d, bone.id)] : [])]);
    for (const b of d.bones) {
      if (blocked.has(b.id)) continue;
      const o = el('option', undefined, b.id);
      o.value = b.id;
      parentSel.appendChild(o);
    }
    parentSel.value = bone.parent ?? '';
    parentSel.onchange = () => withDoc('reparent bone', () => {
      if (!reparentBone(d, bone.id, parentSel.value || null)) deps.toast('that parent would make a cycle');
    });
    holder.appendChild(fieldRow('parent', parentSel));

    const mk = (label: string, get: () => number, set: (v: number) => void, step = 1, round = r2): void => {
      const i = numInput(step);
      i.value = String(round(get()));
      i.onchange = () => withDoc(`set ${label}`, () => set(round(Number(i.value) || 0)));
      holder.appendChild(fieldRow(label, i));
    };
    mk('x', () => bone.x, (v) => (bone.x = v));
    mk('y', () => bone.y, (v) => (bone.y = v));
    mk('rotation °', () => bone.rot * DEG, (v) => (bone.rot = r4(v / DEG)), 1);
    mk('scale x', () => bone.sx, (v) => (bone.sx = v || 1), 0.05, r3);
    mk('scale y', () => bone.sy, (v) => (bone.sy = v || 1), 0.05, r3);
    mk('length', () => bone.len, (v) => (bone.len = Math.max(4, v)), 1);

    const back = el('button', 'as-mini', '▼ back');
    back.title = 'draw earlier (behind)';
    back.onclick = () => withDoc('draw order', () => void moveBoneZ(d, bone.id, -1));
    const fwd = el('button', 'as-mini', '▲ front');
    fwd.title = 'draw later (in front)';
    fwd.onclick = () => withDoc('draw order', () => void moveBoneZ(d, bone.id, 1));
    holder.appendChild(fieldRow('draw order', back, fwd));

    const addChild = el('button', 'as-mini', '+ child bone');
    addChild.onclick = () => withDoc('add bone', () => {
      const nb = addBone(d, { name: 'bone', parent: bone.id, x: Math.max(12, bone.len), y: 0 });
      selBone = nb.id;
    });
    const del = el('button', 'as-mini as-danger', '🗑 delete');
    del.onclick = () => {
      const n = 1 + descendants(d, bone.id).size;
      void deps.confirmBox(n > 1 ? `Delete “${bone.id}” and its ${n - 1} child bone(s)?` : `Delete bone “${bone.id}”?`).then((ok) => {
        if (!ok) return;
        withDoc('delete bone', () => {
          removeBone(d, bone.id);
          selBone = null;
        });
      });
    };
    holder.appendChild(fieldRow('', addChild, del));

    // joint
    const jHolder = $<HTMLDivElement>('jointFields');
    jHolder.innerHTML = '';
    const jSel = el('select');
    for (const t of ['free', 'hinge', 'fixed'] as const) {
      const o = el('option', undefined, t);
      o.value = t;
      jSel.appendChild(o);
    }
    jSel.value = bone.joint.type;
    jSel.onchange = () => withDoc('joint type', () => {
      bone.joint.type = jSel.value as 'free' | 'hinge' | 'fixed';
      if (bone.joint.type === 'hinge' && bone.joint.min === 0 && bone.joint.max === 0) {
        bone.joint.min = r4(-90 / DEG);
        bone.joint.max = r4(90 / DEG);
      }
    });
    jHolder.appendChild(fieldRow('type', jSel));
    if (bone.joint.type === 'hinge') {
      const min = numInput(5);
      min.value = String(r2(bone.joint.min * DEG));
      const max = numInput(5);
      max.value = String(r2(bone.joint.max * DEG));
      min.onchange = () => withDoc('joint limits', () => (bone.joint.min = r4(Math.min(0, Number(min.value) || 0) / DEG)));
      max.onchange = () => withDoc('joint limits', () => (bone.joint.max = r4(Math.max(0, Number(max.value) || 0) / DEG)));
      jHolder.appendChild(fieldRow('min °', min));
      jHolder.appendChild(fieldRow('max °', max));
    }

    // image attachment
    const iHolder = $<HTMLDivElement>('imgFields');
    iHolder.innerHTML = '';
    if (bone.img) {
      const a = bone.img;
      const thumb = el('img', 'asm-thumb');
      thumb.src = a.src;
      iHolder.appendChild(fieldRow('part', thumb, el('span', 'ti', `${a.w}×${a.h}`)));
      const mk2 = (label: string, get: () => number, set: (v: number) => void, step = 1, round = r2): void => {
        const i = numInput(step);
        i.value = String(round(get()));
        i.onchange = () => withDoc(`image ${label}`, () => set(round(Number(i.value) || 0)));
        iHolder.appendChild(fieldRow(label, i));
      };
      mk2('offset x', () => a.ax, (v) => (a.ax = v));
      mk2('offset y', () => a.ay, (v) => (a.ay = v));
      mk2('rotation °', () => a.rot * DEG, (v) => (a.rot = r4(v / DEG)));
      mk2('scale', () => a.sx, (v) => {
        a.sx = v || 1;
        a.sy = v || 1;
      }, 0.05, r3);
      const rm = el('button', 'as-mini', 'remove image');
      rm.onclick = () => withDoc('remove image', () => delete bone.img);
      iHolder.appendChild(fieldRow('', rm));
    } else {
      iHolder.appendChild(el('div', 'as-note', 'no image — click a part in the bin to attach one here'));
      // clicking a part replaces/attaches on the SELECTED bone when it has no image
    }
  }

  function renderPanels(): void {
    renderChars();
    renderTree();
    renderCharFields();
    renderBoneFields();
    $<HTMLDivElement>('charSect').classList.toggle('as-hidden', !doc);
    $<HTMLDivElement>('treeSect').classList.toggle('as-hidden', !doc);
    emptyEl.classList.toggle('as-hidden', !!doc);
  }

  function refresh(): void {
    sizeCanvas();
    renderPanels();
    renderParts();
    paint();
  }

  // ---- canvas sizing -------------------------------------------------------
  function sizeCanvas(): void {
    const r = wrap.getBoundingClientRect();
    const w = Math.max(320, Math.floor(r.width));
    const h = Math.max(240, Math.floor(r.height));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      if (doc) fitView();
    }
  }
  new ResizeObserver(() => {
    sizeCanvas();
    paint();
  }).observe(wrap);

  // ---- toolbar + left column wiring ---------------------------------------
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.multiple = true;
  fileInput.style.display = 'none';
  root.appendChild(fileInput);
  fileInput.onchange = () => {
    void importFiles([...(fileInput.files ?? [])]);
    fileInput.value = '';
  };
  $<HTMLButtonElement>('importBtn').onclick = () => fileInput.click();

  const newChar = (): void => {
    const d = createDoc(`character ${docs.length + 1}`);
    deps.toast(`created “${d.name}” — import parts and click them to build the rig`);
  };
  $<HTMLButtonElement>('newChar').onclick = newChar;
  $<HTMLButtonElement>('emptyNew').onclick = newChar;

  $<HTMLButtonElement>('addBone').onclick = () => {
    if (!doc) return deps.toast('create a character first');
    const d = doc;
    withDoc('add bone', () => {
      const parent = selBone ?? (boneById(d, 'root') ? 'root' : null);
      const nb = addBone(d, { name: 'bone', parent, x: 16, y: 0 });
      selBone = nb.id;
    });
  };
  $<HTMLButtonElement>('undoBtn').onclick = () => {
    const label = history.undo();
    deps.toast(label ? `undid ${label}` : 'nothing to undo');
  };
  $<HTMLButtonElement>('redoBtn').onclick = () => {
    const label = history.redo();
    deps.toast(label ? `redid ${label}` : 'nothing to redo');
  };
  $<HTMLInputElement>('gridChk').onchange = () => paint();
  $<HTMLButtonElement>('animateBtn').onclick = () => {
    if (doc) deps.animate(doc.id);
  };
  $<HTMLButtonElement>('dupChar').onclick = () => {
    if (doc) duplicateDoc(doc);
  };
  $<HTMLButtonElement>('delChar').onclick = () => {
    if (doc) void deleteDoc(doc.id);
  };
  $<HTMLButtonElement>('exportChars').onclick = () => {
    const a = el('a');
    a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(packSkeletons(docs, parts));
    a.download = 'skeletons.json';
    a.click();
    deps.toast(`exported ${docs.length} character${docs.length === 1 ? '' : 's'} + ${parts.length} part${parts.length === 1 ? '' : 's'}`);
  };
  const charsInput = el('input');
  charsInput.type = 'file';
  charsInput.accept = 'application/json,.json';
  charsInput.style.display = 'none';
  root.appendChild(charsInput);
  charsInput.onchange = () => {
    const f = charsInput.files?.[0];
    charsInput.value = '';
    if (!f) return;
    void f.text().then((text) => {
      try {
        const loaded = unpackSkeletons(text);
        let added = 0;
        let replaced = 0;
        for (const d of loaded.skeletons) {
          const existing = docs.find((x) => x.id === d.id);
          if (existing) {
            restoreDoc(existing, JSON.stringify(d));
            deps.onDocChanged(existing);
            replaced++;
          } else {
            docs.push(d);
            deps.registerTimelines(d);
            added++;
          }
        }
        for (const p of loaded.parts) if (!parts.some((x) => x.src === p.src)) parts.push(p);
        deps.onPartsChanged();
        deps.onDocsListChanged();
        for (const d of docs) void preloadSkeleton(d);
        refresh();
        deps.toast(`loaded ${added} new, updated ${replaced}`);
      } catch {
        deps.toast(`couldn't parse ${f.name}`);
      }
    });
  };
  $<HTMLButtonElement>('importChars').onclick = () => charsInput.click();

  // ---- keyboard (routed from the studio while Assemble is active) ----------
  function handleKey(e: KeyboardEvent): boolean {
    if (e.key === ' ') {
      spaceHeld = e.type === 'keydown';
      return true;
    }
    if (e.type !== 'keydown') return false;
    const bone = curBone();
    if ((e.key === 'Delete' || e.key === 'Backspace') && bone && doc) {
      const d = doc;
      const n = 1 + descendants(d, bone.id).size;
      void deps.confirmBox(n > 1 ? `Delete “${bone.id}” and its ${n - 1} child bone(s)?` : `Delete bone “${bone.id}”?`).then((ok) => {
        if (!ok) return;
        withDoc('delete bone', () => {
          removeBone(d, bone.id);
          selBone = null;
        });
      });
      return true;
    }
    if (e.key === 'Escape' && selBone) {
      selBone = null;
      renderPanels();
      paint();
      return true;
    }
    if (e.key.toLowerCase() === 'b' && !e.ctrlKey && !e.metaKey) {
      $<HTMLButtonElement>('addBone').click();
      return true;
    }
    if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey) {
      newChar();
      return true;
    }
    if (bone && doc && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      const d = doc;
      const step = e.shiftKey ? 10 : 1;
      withDoc('nudge bone', () => {
        if (e.key === 'ArrowLeft') bone.x = r2(bone.x - step);
        if (e.key === 'ArrowRight') bone.x = r2(bone.x + step);
        if (e.key === 'ArrowUp') bone.y = r2(bone.y - step);
        if (e.key === 'ArrowDown') bone.y = r2(bone.y + step);
        void d;
      });
      return true;
    }
    return false;
  }

  // first paint
  refresh();
  if (docs.length) selectDoc(docs[0].id);

  return {
    refresh,
    current: cur,
    selectDoc,
    selectedBone: () => selBone,
    selectBone: (id) => {
      selBone = id;
      renderPanels();
      paint();
    },
    createDoc,
    deleteDoc,
    handleKey,
  };
}
