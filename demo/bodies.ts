/**
 * The demo cast — three procedurally-drawn characters that exercise the whole
 * studio loop with no game and no engine: plain Canvas2D bodies whose limbs
 * route through the package's rig helpers (fkBone / ikLeg / rootBone), so
 * their joints are draggable and authored keyframes replay in the bake.
 *
 * This file doubles as the integration example: a real game implements the
 * same {@link StudioAdapter} shape against its own render pipeline.
 */
import type { StudioAdapter, BodyDesc, BakedBody, ClipDef, PlanFrame, PosedFrame, VariantValues } from '../src/adapter';
import type { ClipStore, Pose } from '../src/types';
import { poseForFrame } from '../src/sample';
import { beginBoneRecord, endBoneRecord, fkBone, ikLeg, rootBone, resetBoneIds } from '../src/rig';

// a Sweetie-16-ish palette
const C = {
  ink: '#1a1c2c',
  plum: '#5d275d',
  red: '#b13e53',
  orange: '#ef7d57',
  yellow: '#ffcd75',
  lime: '#a7f070',
  green: '#38b764',
  teal: '#257179',
  navy: '#29366f',
  blue: '#3b5dc9',
  sky: '#41a6f6',
  cyan: '#73eff7',
  white: '#f4f4f4',
  silver: '#94b0c2',
  slate: '#566c86',
  charcoal: '#333c57',
};

/** Per-frame drive — what the procedural pose code runs on. */
interface Drive {
  clip: string;
  t: number;
  /** attack swing phase 0..1 (0 = rest) */
  sw: number;
  /** walk cycle phase 0..1 */
  step: number;
  /** hit flinch 0..1 */
  flinch: number;
}

/** A thick limb segment in local space (the enclosing bone transform rotates it). */
function limb(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, w: number, color: string): void {
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const len = Math.hypot(x1 - x0, y1 - y0);
  ctx.save();
  ctx.translate(x0, y0);
  ctx.rotate(ang);
  ctx.fillStyle = color;
  ctx.fillRect(0, -w / 2, len, w);
  ctx.restore();
}

function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

// ---------------------------------------------------------------------------
// drive curves — load, hold, whip (linear phases read mechanical)
// ---------------------------------------------------------------------------

/** −1 = cocked back through the wind-up, +1 = driven through the strike,
 *  easing back to 0 on the settle. */
function strikePose(sw: number): number {
  if (sw <= 0 || sw >= 1) return 0;
  if (sw < 0.35) return -(sw / 0.35); // coil back
  if (sw < 0.4) return -1; // hold the load
  if (sw < 0.7) {
    const u = (sw - 0.4) / 0.3;
    return -1 + (1 + 1) * (u * u); // accelerate through the blow
  }
  const u = (sw - 0.7) / 0.3;
  return 1 - u * (2 - u); // decelerate to rest… ends at 0
}

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// the cast
// ---------------------------------------------------------------------------

interface DemoSpec {
  desc: BodyDesc;
  fw: number;
  fh: number;
  clips: ClipDef[];
  plan: PlanFrame[];
  /** the studio store key; variants that change the silhouette key separately */
  bodyId?(variants: VariantValues): string;
  draw?(ctx: CanvasRenderingContext2D, d: Drive, pose: Pose | undefined, variants: VariantValues): void;
  /** view-only bodies draw without a rig */
  drawFlat?(ctx: CanvasRenderingContext2D, d: Drive): void;
  info?(variants: VariantValues): Record<string, string>;
}

/** Build clips + the per-frame plan in one pass so they can never disagree. */
function layout(defs: { key: string; name?: string; n: number; per: number; retimable?: boolean }[]): { clips: ClipDef[]; plan: PlanFrame[] } {
  const clips: ClipDef[] = [];
  const plan: PlanFrame[] = [];
  let at = 0;
  for (const d of defs) {
    const frames = Array.from({ length: d.n }, (_, k) => at + k);
    clips.push({ name: d.name ?? d.key, clipKey: d.key, frames, delays: frames.map(() => d.per), retimable: d.retimable });
    for (let k = 0; k < d.n; k++) plan.push({ clip: d.key, t: d.n === 1 ? 0 : k / (d.n - 1) });
    at += d.n;
  }
  return { clips, plan };
}

/** clip + t → the procedural drive for that instant. */
function driveOf(pf: PlanFrame): Drive {
  return {
    clip: pf.clip,
    t: pf.t,
    sw: pf.clip === 'attack' ? pf.t : 0,
    step: pf.clip === 'walk' ? pf.t : 0,
    flinch: pf.clip === 'hit' ? 1 - pf.t : 0,
  };
}

// --- the scout: a biped with a held weapon, IK feet and a variant loadout ----
const scoutLayout = layout([
  { key: 'idle', n: 6, per: 150, retimable: true },
  { key: 'walk', n: 8, per: 110, retimable: true },
  { key: 'attack', n: 8, per: 55 },
  { key: 'hit', n: 3, per: 170, retimable: true },
]);

function drawScout(ctx: CanvasRenderingContext2D, d: Drive, pose: Pose | undefined, v: VariantValues): void {
  const s = strikePose(d.sw);
  const breathe = d.clip === 'idle' ? Math.sin(d.t * TAU) : 0;
  // whole body: lunge into the strike, bob on the breath, pitch on a flinch
  const root = {
    dx: Math.max(0, s) * 2.5,
    dy: breathe * 0.7 + Math.abs(s) * 0.5,
    rot: s * 0.06 - d.flinch * 0.12,
  };
  const stepA = Math.sin(d.step * TAU);
  const stepB = Math.sin((d.step + 0.5) * TAU);
  const walking = d.clip === 'walk';

  rootBone(ctx, pose, 32, 34, root, () => {
    // back arm (arm0) — counter-swings the walk, jerks up on a hit
    fkBone(ctx, pose, 30, 21, (walking ? stepA * 0.35 : 0) - d.flinch * 0.5 - s * 0.25 + breathe * 0.03, () => {
      limb(ctx, 30, 21, 30, 31, 3, C.teal);
      px(ctx, 28.5, 30, 3, 3, C.orange); // hand
    });
    // legs — IK: planted feet, the knee re-solves
    const liftA = walking ? Math.max(0, Math.sin(d.step * TAU)) * 3 : 0;
    const liftB = walking ? Math.max(0, Math.sin((d.step + 0.5) * TAU)) * 3 : 0;
    ikLeg(ctx, pose, 29, 34, 26 + (walking ? stepB * 5 : 0), 50 - liftB, 9, 9, (kx, ky, fx, fy) => {
      limb(ctx, 29, 34, kx, ky, 3.5, C.navy);
      limb(ctx, kx, ky, fx, fy, 3, C.navy);
      px(ctx, fx - 2, fy - 1.5, 5, 3, C.charcoal); // boot
    });
    ikLeg(ctx, pose, 35, 34, 38 + (walking ? stepA * 5 : 0), 50 - liftA, 9, 9, (kx, ky, fx, fy) => {
      limb(ctx, 35, 34, kx, ky, 3.5, C.blue);
      limb(ctx, kx, ky, fx, fy, 3, C.blue);
      px(ctx, fx - 2, fy - 1.5, 5, 3, C.charcoal);
    });
    // cape (cosmetic variant — shares the pose)
    if (v.cape) {
      ctx.fillStyle = C.plum;
      ctx.beginPath();
      ctx.moveTo(28, 19);
      ctx.lineTo(26 - breathe, 36 + Math.abs(s) * 3);
      ctx.lineTo(33, 34);
      ctx.closePath();
      ctx.fill();
    }
    // torso
    px(ctx, 27, 19, 10, 15, C.green);
    px(ctx, 27, 19, 10, 4, C.lime); // collar
    // head (head0) — its own 'head' kind, so the id never depends on draw order
    fkBone(ctx, pose, 32, 19, breathe * 0.03 + s * 0.06 - d.flinch * 0.18, () => {
      px(ctx, 27.5, 9, 9, 10, C.orange); // head
      px(ctx, 33, 12, 2, 2, C.ink); // eye
      px(ctx, 27.5, 9, 9, 3, C.charcoal); // hood brim
    }, 'head');
    // weapon arm (arm1) — the strike; the whole limb + weapon move as one bone
    fkBone(ctx, pose, 34, 21, s * 1.35 + (walking ? stepB * 0.35 : 0) - d.flinch * 0.6 + breathe * 0.04, () => {
      limb(ctx, 34, 21, 36, 31, 3, C.green);
      px(ctx, 34.5, 30, 3, 3, C.orange); // hand
      const w = String(v.weapon ?? 'staff');
      if (w === 'staff') {
        limb(ctx, 36, 38, 36, 18, 2, C.yellow);
        px(ctx, 34.5, 16, 4, 4, C.cyan); // charm
      } else if (w === 'sword') {
        // blade points FORWARD from the grip (not up the face), guard at the hilt
        limb(ctx, 36, 31, 52, 31, 2.5, C.silver);
        px(ctx, 37.5, 27.5, 2, 7, C.yellow); // crossguard
      }
    });
  });
}

// --- the brute: a heavier biped, both fists, a deeper wind-up ---------------
const bruteLayout = layout([
  { key: 'idle', n: 6, per: 170, retimable: true },
  { key: 'walk', n: 8, per: 130, retimable: true },
  { key: 'attack', n: 10, per: 60 },
  { key: 'hit', n: 3, per: 170, retimable: true },
]);

function drawBrute(ctx: CanvasRenderingContext2D, d: Drive, pose: Pose | undefined): void {
  const s = strikePose(d.sw);
  const breathe = d.clip === 'idle' ? Math.sin(d.t * TAU) : 0;
  const root = { dx: Math.max(0, s) * 3, dy: breathe * 0.9 + Math.abs(s) * 1, rot: s * 0.1 - d.flinch * 0.14 };
  const walking = d.clip === 'walk';
  const stepA = Math.sin(d.step * TAU);
  const stepB = Math.sin((d.step + 0.5) * TAU);

  rootBone(ctx, pose, 36, 38, root, () => {
    // both arms drive the overhead smash together
    fkBone(ctx, pose, 30, 24, s * 1.5 + (walking ? stepA * 0.3 : 0) - d.flinch * 0.5, () => {
      limb(ctx, 30, 24, 26, 37, 5, C.plum);
      px(ctx, 23, 35, 6, 6, C.red); // fist
    });
    const liftA = walking ? Math.max(0, Math.sin(d.step * TAU)) * 3 : 0;
    const liftB = walking ? Math.max(0, Math.sin((d.step + 0.5) * TAU)) * 3 : 0;
    ikLeg(ctx, pose, 32, 38, 28 + (walking ? stepB * 6 : 0), 56 - liftB, 10, 10, (kx, ky, fx, fy) => {
      limb(ctx, 32, 38, kx, ky, 5, C.charcoal);
      limb(ctx, kx, ky, fx, fy, 4.5, C.charcoal);
      px(ctx, fx - 3, fy - 2, 7, 4, C.ink);
    });
    ikLeg(ctx, pose, 40, 38, 44 + (walking ? stepA * 6 : 0), 56 - liftA, 10, 10, (kx, ky, fx, fy) => {
      limb(ctx, 40, 38, kx, ky, 5, C.slate);
      limb(ctx, kx, ky, fx, fy, 4.5, C.slate);
      px(ctx, fx - 3, fy - 2, 7, 4, C.ink);
    });
    // torso
    px(ctx, 28, 20, 16, 18, C.red);
    px(ctx, 28, 20, 16, 5, C.orange); // shoulders
    // head (head0) — its own 'head' kind, so the id never depends on draw order
    fkBone(ctx, pose, 36, 20, s * 0.08 - d.flinch * 0.2 + breathe * 0.02, () => {
      px(ctx, 30, 10, 12, 10, C.orange); // head
      px(ctx, 38, 13, 2, 3, C.ink); // eye
    }, 'head');
    fkBone(ctx, pose, 42, 24, s * 1.5 + (walking ? stepB * 0.3 : 0) - d.flinch * 0.6, () => {
      limb(ctx, 42, 24, 46, 37, 5, C.red);
      px(ctx, 43, 35, 6, 6, C.orange); // fist
    });
  });
}

// --- the wisp: view-only (no rig) — exercises the roster/preview path -------
const wispLayout = layout([{ key: 'idle', n: 8, per: 120, retimable: true }]);

function drawWisp(ctx: CanvasRenderingContext2D, d: Drive): void {
  const bob = Math.sin(d.t * TAU) * 3;
  const flick = 0.75 + 0.25 * Math.sin(d.t * TAU * 3);
  ctx.globalAlpha = flick;
  px(ctx, 20, 16 + bob, 12, 14, C.cyan);
  px(ctx, 22, 12 + bob, 8, 4, C.white);
  px(ctx, 23, 20 + bob, 2, 3, C.navy);
  px(ctx, 28, 20 + bob, 2, 3, C.navy);
  ctx.globalAlpha = 1;
  px(ctx, 24, 30 + bob, 4, 6, C.teal); // tail
}

const CAST: DemoSpec[] = [
  {
    desc: {
      id: 'scout',
      label: 'scout',
      group: 'demo cast',
      title: 'biped · FK arms · IK feet',
      variants: [
        {
          id: 'weapon',
          label: 'weapon',
          kind: 'select',
          options: [
            { value: 'staff', label: 'staff' },
            { value: 'sword', label: 'sword' },
            { value: 'none', label: 'unarmed' },
          ],
        },
        { id: 'cape', label: 'cape', kind: 'toggle' },
      ],
    },
    fw: 64,
    fh: 64,
    ...scoutLayout,
    bodyId: (v) => `scout:${v.weapon ?? 'staff'}`,
    draw: drawScout,
    info: (v) => ({ weapon: String(v.weapon ?? 'staff') }),
  },
  {
    desc: { id: 'brute', label: 'brute', group: 'demo cast', title: 'heavy biped · two fists' },
    fw: 72,
    fh: 72,
    ...bruteLayout,
    bodyId: () => 'brute',
    draw: drawBrute,
  },
  {
    desc: { id: 'wisp', label: 'wisp', group: 'demo cast', title: 'view-only · no rig' },
    fw: 52,
    fh: 48,
    ...wispLayout,
    drawFlat: drawWisp,
  },
];

// ---------------------------------------------------------------------------
// the adapter
// ---------------------------------------------------------------------------

/** Render one frame of a spec. When `record` is set the discovered bones are
 *  captured (pose mode); otherwise it's a straight bake-style render. */
function renderFrame(spec: DemoSpec, i: number, pose: Pose | undefined, v: VariantValues, record: boolean): PosedFrame {
  const c = document.createElement('canvas');
  c.width = spec.fw;
  c.height = spec.fh;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const d = driveOf(spec.plan[i] ?? { clip: 'idle', t: 0 });
  if (record) beginBoneRecord();
  else resetBoneIds();
  if (spec.draw) spec.draw(ctx, d, pose, v);
  else spec.drawFlat?.(ctx, d);
  const bones = record ? endBoneRecord() : [];
  return { canvas: c, fw: spec.fw, fh: spec.fh, bones };
}

/** Build the demo adapter over a live authored store (demo/clips.ts). */
export function demoAdapter(store: ClipStore): StudioAdapter {
  return {
    title: 'Anim Studio',
    subtitle: 'demo rig · drag joints, keyframe, save',
    clips: store,
    save: { hint: 'Save writes demo/clips.ts via the dev server; commit to seal it.' },
    skeletons: {}, // default endpoint — the vite plugin persists demo/skeletons.json
    bodies: () => CAST.map((s) => s.desc),
    bake(body: BodyDesc, variants: VariantValues): BakedBody | null {
      const spec = CAST.find((s) => s.desc.id === body.id);
      if (!spec) return null;
      const bodyId = spec.bodyId?.(variants);
      return {
        frameW: spec.fw,
        frameH: spec.fh,
        clips: spec.clips,
        plan: spec.plan,
        bodyId,
        info: spec.info?.(variants),
        // Render exactly like a game bake would: sample the AUTHORED store and
        // layer it over the procedural pose. Sampling happens per call, so a
        // keyframe edit shows in the very next preview frame — no re-bake.
        frame(i) {
          const pf = spec.plan[i];
          if (!pf) return null;
          const pose = bodyId ? poseForFrame(store[bodyId], pf.clip, pf.t) : undefined;
          return { src: renderFrame(spec, i, pose, variants, false).canvas, x: 0, y: 0, w: spec.fw, h: spec.fh };
        },
        renderPose: spec.draw ? (i, pose) => renderFrame(spec, i, pose, variants, true) : undefined,
      };
    },
  };
}
