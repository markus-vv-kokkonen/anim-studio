/**
 * Canvas rendering for assembled skeletons (see skeleton.ts for the format):
 * draw a doc's attachments under a pose, record its bones for the joint
 * handles, and wrap a doc as a {@link BakedBody} so an assembled character
 * joins the roster exactly like a procedural one.
 *
 * The baked body samples the LIVE clip store on every `frame()` call, so an
 * authored key shows in the very next preview frame — no re-bake step.
 */
import type { Pose } from './types';
import type { BakedBody, ClipDef, PlanFrame, PosedFrame } from './adapter';
import type { ClipStore } from './types';
import type { SkeletonDoc, SkelBone, Mat2D } from './skeleton';
import { bonesByZ, worldTransforms, skelBodyId } from './skeleton';
import { poseForFrame } from './sample';
import { recordBone, beginBoneRecord, endBoneRecord } from './rig';

// ---------------------------------------------------------------------------
// image cache (data URIs → decoded images, shared across renders)
// ---------------------------------------------------------------------------
const imgCache = new Map<string, HTMLImageElement>();

/** The (possibly still-loading) image for a source. `onLoad` fires once when a
 *  cache miss finishes decoding — re-render then. */
export function imageFor(src: string, onLoad?: () => void): HTMLImageElement {
  let img = imgCache.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    imgCache.set(src, img);
    if (onLoad) {
      img.decode().catch(() => undefined).then(onLoad);
      return img;
    }
  }
  return img;
}

/** Await every attachment image of a doc (bake once, then draw synchronously). */
export async function preloadSkeleton(doc: SkeletonDoc): Promise<void> {
  await Promise.all(
    doc.bones
      .filter((b) => b.img)
      .map((b) => imageFor(b.img!.src).decode().catch(() => undefined)),
  );
}

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------
const applyMat = (ctx: CanvasRenderingContext2D, m: Mat2D): void => ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);

export const skelBoneKind = (b: SkelBone): string => (b.parent === null ? 'root' : 'part');

/**
 * Draw a skeleton's attachments (in z order) into `ctx` under `pose`, on top
 * of whatever transform `ctx` already carries (the assembly canvas passes its
 * view transform). With `record` on, every bone — attachment or not — is
 * recorded at its pivot for the studio's joint handles.
 */
export function drawSkeleton(ctx: CanvasRenderingContext2D, doc: SkeletonDoc, pose: Pose | undefined, record = false, onImg?: () => void): void {
  const worlds = worldTransforms(doc, pose);
  ctx.imageSmoothingEnabled = false;
  for (const bone of bonesByZ(doc)) {
    const world = worlds.get(bone.id)!;
    if (bone.img) {
      const a = bone.img;
      const img = imageFor(a.src, onImg);
      if (img.complete && img.naturalWidth > 0) {
        ctx.save();
        applyMat(ctx, world);
        ctx.translate(a.ax, a.ay);
        ctx.rotate(a.rot);
        ctx.scale(a.sx, a.sy);
        ctx.drawImage(img, -a.w / 2, -a.h / 2, a.w, a.h);
        ctx.restore();
      }
    }
    if (record) {
      ctx.save();
      applyMat(ctx, world);
      recordBone(ctx, bone.id, skelBoneKind(bone), 0, 0);
      ctx.restore();
    }
  }
}

/** Render one full frame of a doc to its own canvas (the skeleton equivalent
 *  of a bake or pose-mode render). */
export function renderSkeletonFrame(doc: SkeletonDoc, pose: Pose | undefined, record: boolean): PosedFrame {
  const c = document.createElement('canvas');
  c.width = doc.fw;
  c.height = doc.fh;
  const ctx = c.getContext('2d')!;
  if (record) beginBoneRecord();
  drawSkeleton(ctx, doc, pose, record);
  const bones = record ? endBoneRecord() : [];
  return { canvas: c, fw: doc.fw, fh: doc.fh, bones };
}

// ---------------------------------------------------------------------------
// the roster body
// ---------------------------------------------------------------------------

/** Clips + per-frame plan derived from the doc's own clip list — one source,
 *  so the studio and the export can never disagree. */
export function skeletonClipDefs(doc: SkeletonDoc): { clips: ClipDef[]; plan: PlanFrame[] } {
  const clips: ClipDef[] = [];
  const plan: PlanFrame[] = [];
  let at = 0;
  for (const c of doc.clips) {
    const frames = Array.from({ length: c.frames }, (_, k) => at + k);
    clips.push({ name: c.name, clipKey: c.key, frames, delays: frames.map(() => 1000 / c.fps), retimable: true });
    for (let k = 0; k < c.frames; k++) plan.push({ clip: c.key, t: c.frames === 1 ? 0 : k / (c.frames - 1) });
    at += c.frames;
  }
  return { clips, plan };
}

/** Wrap a doc as a poseable {@link BakedBody}. `frame()` samples the live
 *  store at call time, so keyframe edits show without re-baking; call
 *  {@link preloadSkeleton} first so attachment images draw synchronously. */
export function skeletonBody(doc: SkeletonDoc, store: ClipStore): BakedBody {
  const { clips, plan } = skeletonClipDefs(doc);
  const bodyId = skelBodyId(doc);
  return {
    frameW: doc.fw,
    frameH: doc.fh,
    clips,
    plan,
    bodyId,
    info: {
      bones: String(doc.bones.length),
      parts: String(doc.bones.filter((b) => b.img).length),
    },
    frame(i) {
      const pf = plan[i];
      if (!pf) return null;
      const pose = poseForFrame(store[bodyId], pf.clip, pf.t);
      const r = renderSkeletonFrame(doc, pose, false);
      return { src: r.canvas, x: 0, y: 0, w: doc.fw, h: doc.fh };
    },
    renderPose(_i, pose) {
      return renderSkeletonFrame(doc, pose, true);
    },
  };
}
