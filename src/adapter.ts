/**
 * The host adapter — everything the studio needs to know about YOUR game,
 * behind one small interface. The studio never imports your engine; you hand
 * it canvases and a frame plan, it hands you back authored keyframe data.
 */
import type { Pose, ClipStore } from './types';
import type { BoneRec } from './rig';

/** One frame of a body's baked plan: which authored clip the frame belongs to
 *  and at what clip-time `t` ∈ [0,1] it samples. `plan[frameIndex]` must agree
 *  with the frames your game actually bakes/renders — derive both from the
 *  same source so the studio is faithful by construction. */
export interface PlanFrame {
  clip: string;
  t: number;
}

/** A playable clip: display name, the authored-timeline id it keys, its sheet
 *  frame indices, and per-frame preview delays (ms). Mark presentation clips
 *  (idle/walk/hit) `retimable` so an authored `duration` re-times their
 *  preview; leave attack clips unmarked — their tempo is combat data. */
export interface ClipDef {
  name: string;
  clipKey: string;
  frames: number[];
  delays: number[];
  retimable?: boolean;
}

/** A baked frame image: a source and the rect of frame `i` within it. */
export interface FrameImage {
  src: CanvasImageSource;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A direct-drawn, poseable frame: the canvas plus the bones discovered while
 *  drawing it (see rig.ts — record via {@link BoneRec}). */
export interface PosedFrame {
  canvas: HTMLCanvasElement;
  fw: number;
  fh: number;
  bones: BoneRec[];
}

/** A per-body option the roster panel exposes (loadout, facing, tier, …).
 *  Changing one re-bakes the body with the new values. */
export type VariantDef =
  | { id: string; label: string; kind: 'select'; options: { value: string; label: string }[]; value?: string }
  | { id: string; label: string; kind: 'toggle'; value?: boolean };

/** Chosen variant values, keyed by variant id. */
export type VariantValues = Record<string, string | boolean>;

/** One roster entry. */
export interface BodyDesc {
  /** Stable roster id (unique across the roster). */
  id: string;
  label: string;
  /** Roster group header ('player' / 'foes' / 'bosses' / …). */
  group?: string;
  /** Subtitle shown under the label. */
  title?: string;
  /** Per-body options panel (e.g. the hero's weapon/facing/tier). */
  variants?: VariantDef[];
}

/** A baked body, ready to preview and (optionally) pose. */
export interface BakedBody {
  /** Padded cell size of one frame. */
  frameW: number;
  frameH: number;
  clips: ClipDef[];
  /** Per-sheet-frame plan; `plan[i]` matches `frame(i)`. */
  plan: PlanFrame[];
  /** The authored-store key this body's edits live under. Absent → view-only. */
  bodyId?: string;
  /** The baked blit path: frame `i` of the real spritesheet. */
  frame(i: number): FrameImage | null;
  /** The pose-edit path: direct-draw frame `i` under an authored pose with
   *  bone recording on. Absent → the body views but doesn't pose. */
  renderPose?(i: number, pose: Pose | undefined): PosedFrame | null;
  /** Extra inspector lines (e.g. weapon: 'axe'). */
  info?: Record<string, string>;
}

/** The host adapter: the roster, the bake, and the live authored store. */
export interface StudioAdapter {
  /** Header title/subtitle. */
  title?: string;
  subtitle?: string;
  /** The authored clip store — the SAME live object your bake path samples,
   *  so studio edits show up in the next render. Load it from your saved
   *  clips file at boot. */
  clips: ClipStore;
  /** The roster. */
  bodies(): BodyDesc[] | Promise<BodyDesc[]>;
  /** Bake one body (idempotent per body+variants — cache internally if your
   *  bake is expensive; the studio also memoises per body+variants). */
  bake(body: BodyDesc, variants: VariantValues): BakedBody | null | Promise<BakedBody | null>;
  /** Await your engine boot before the first bake (e.g. Phaser READY). */
  ready?(): Promise<void>;
  /** Save wiring: POST target for the authored store (see save-plugin.ts) and
   *  the hint line shown under the Save button. */
  save?: { endpoint?: string; hint?: string };
  /** Assembled-characters wiring: GET/POST target for the skeletons file
   *  (default `/__anim/skeletons` — see save-plugin.ts `skeletonsFile`). When
   *  the endpoint is unreachable the studio persists to localStorage instead. */
  skeletons?: { endpoint?: string };
  /** Project-picker wiring: GET/POST target listing the working directories
   *  this studio can edit (see project-plugin.ts). Set it and the header grows
   *  a project dropdown; omit it and there is none.
   *
   *  Opting in EXPLICITLY, rather than just probing the endpoint, is
   *  deliberate: a host can be served by a dev server that happens to run the
   *  project plugin for something else, and a picker that silently reloads
   *  without changing anything that host reads is worse than no picker. */
  projects?: { endpoint?: string };
}
