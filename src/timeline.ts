/**
 * Edit operations over the authored clip store — the pure logic behind the
 * studio's keyframing UI (set/find/clear a key, prune the payload for Save).
 * All operations mutate the store IN PLACE: the store is the same object your
 * bake path samples, so an edit shows up in the very next render.
 */
import type { ClipStore, BodyClips, ClipTimeline, Keyframe, Ease } from './types';

/** Two clip-times within this are "the same key". Baked frames sample exact
 *  stored floats; this only absorbs scrub/UI rounding. */
export const KEY_EPS = 1e-4;

/** The body's clip map in the store, created on demand. */
export function bodyClipsFor(store: ClipStore, bodyId: string): BodyClips {
  return (store[bodyId] ??= {});
}

/** A clip's timeline; with `create` it is added (empty) when missing. */
export function timelineFor(store: ClipStore, bodyId: string, clip: string, create: boolean): ClipTimeline | undefined {
  const bc = create ? bodyClipsFor(store, bodyId) : store[bodyId];
  if (!bc) return undefined;
  if (!bc[clip] && create) bc[clip] = { keys: [] };
  return bc[clip];
}

/** The key at clip-time `t` (± {@link KEY_EPS}); with `create` a new empty key
 *  is inserted in sorted position. */
export function keyAt(tl: ClipTimeline, t: number, create: boolean, ease: Ease = 'linear'): Keyframe | undefined {
  let k = tl.keys.find((kf) => Math.abs(kf.t - t) < KEY_EPS);
  if (!k && create) {
    k = { t, pose: {}, ease };
    tl.keys.push(k);
    tl.keys.sort((a, b) => a.t - b.t);
  }
  return k;
}

/** Remove the key at clip-time `t` (± {@link KEY_EPS}), if any. */
export function clearKeyAt(tl: ClipTimeline, t: number): void {
  tl.keys = tl.keys.filter((kf) => Math.abs(kf.t - t) >= KEY_EPS);
}

/** The store pruned for persisting: keep a timeline that carries keys OR an
 *  authored duration (a duration-only timeline must survive Save), drop empty
 *  timelines and empty bodies. Returns a NEW object; the live store keeps its
 *  in-progress empties. */
export function prunedClips(store: ClipStore): ClipStore {
  const clips: ClipStore = {};
  for (const [id, bc] of Object.entries(store)) {
    const ne: BodyClips = {};
    for (const [cid, tl] of Object.entries(bc)) if (tl.keys.length || tl.duration) ne[cid] = tl;
    if (Object.keys(ne).length) clips[id] = ne;
  }
  return clips;
}

/** Total authored key count across the store (a cheap "anything authored?"
 *  probe, used by the verification hook). */
export function countKeys(store: ClipStore): number {
  return Object.values(prunedClips(store)).reduce((n, bc) => n + Object.values(bc).reduce((m, tl) => m + tl.keys.length, 0), 0);
}
