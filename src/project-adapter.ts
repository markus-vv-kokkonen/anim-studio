/**
 * The standalone host's adapter.
 *
 * A game's adapter bakes procedural bodies through the game's own pipeline —
 * that is what makes the studio faithful by construction for those bodies. The
 * standalone host has no game to bake through, and deliberately does not
 * pretend to: its roster is EMPTY, and every body on screen is an assembled
 * character loaded from the project's skeletons file. Those render through
 * skeleton-render.ts, which is the studio's own draw, so faithfulness is not
 * at stake.
 *
 * The clip store starts empty because assembled timelines live under `sk:<id>`
 * keys inside each character document, not in the game's clips file.
 */
import type { StudioAdapter } from './adapter';
import type { ClipStore } from './types';

export function projectAdapter(): StudioAdapter {
  const clips: ClipStore = {};
  return {
    title: 'anim-studio',
    subtitle: 'assembled characters — pick a project in the header',
    clips,
    bodies: () => [],
    bake: () => null,
    // Deliberately NOT the default `/__anim/skeletons`: a host may also run
    // save-plugin.ts (this repo does, for the demo), both claim that path, and
    // whichever registered first wins — which showed up as the standalone
    // studio confidently serving the demo's characters for every project.
    skeletons: { endpoint: '/__anim/project-skeletons' },
  };
}
