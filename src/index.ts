/**
 * anim-studio — a keyframe pose editor for procedurally-animated 2D
 * characters, for any game and any engine. See README.md.
 *
 * The pieces:
 *  - types.ts     the stored format (poses, keyframes, timelines)
 *  - sample.ts    sample a timeline at a clip-time (game + studio share it)
 *  - emit.ts      deterministic clips-file emitters (TS module / JSON)
 *  - timeline.ts  keyframe edit operations over the authored store
 *  - rig.ts       the bone contract: record sink + canvas FK/IK/root helpers
 *  - skeleton.ts  assembled characters: the skeleton doc format + pure ops
 *  - skeleton-render.ts  draw a skeleton doc / wrap it as a roster body
 *  - assembly.ts  Assemble mode — the parts-to-rig editor pane
 *  - history.ts   the shared undo/redo stack
 *  - adapter.ts   the host interface the studio drives your game through
 *  - studio.ts    mountStudio() — the editor UI itself (Animate + Assemble)
 *  - save-plugin.ts  a dev-only Vite endpoint that writes the clips +
 *    skeletons files
 */
export * from './types';
export * from './sample';
export * from './emit';
export * from './timeline';
export * from './rig';
export * from './skeleton.ts';
export * from './skeleton-render.ts';
export * from './history.ts';
export * from './adapter';
export * from './studio';
export * from './assembly.ts';
