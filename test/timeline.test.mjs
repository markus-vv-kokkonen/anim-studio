import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyClipsFor, timelineFor, keyAt, clearKeyAt, prunedClips, countKeys, KEY_EPS } from '../src/timeline.ts';

test('timelineFor creates on demand and mutates the store in place', () => {
  const store = {};
  assert.equal(timelineFor(store, 'scout', 'idle', false), undefined);
  const tl = timelineFor(store, 'scout', 'idle', true);
  assert.deepEqual(tl, { keys: [] });
  assert.equal(store.scout.idle, tl); // the live store the bake path samples
  assert.equal(bodyClipsFor(store, 'scout'), store.scout);
});

test('keyAt finds within KEY_EPS, creates sorted, and never duplicates', () => {
  const tl = { keys: [] };
  const k1 = keyAt(tl, 0.6, true);
  const k0 = keyAt(tl, 0.2, true, 'easeOut');
  assert.equal(tl.keys[0], k0);
  assert.equal(tl.keys[1], k1);
  assert.equal(k0.ease, 'easeOut');
  assert.equal(keyAt(tl, 0.2 + KEY_EPS / 2, false), k0); // same key within tolerance
  assert.equal(tl.keys.length, 2);
  assert.equal(keyAt(tl, 0.4, false), undefined); // no create → no insert
});

test('clearKeyAt removes exactly the key at t', () => {
  const tl = { keys: [] };
  keyAt(tl, 0.2, true);
  keyAt(tl, 0.8, true);
  clearKeyAt(tl, 0.2);
  assert.equal(tl.keys.length, 1);
  assert.equal(tl.keys[0].t, 0.8);
});

test('prunedClips keeps keyed OR duration-only timelines, drops empties — without touching the live store', () => {
  const store = {
    scout: {
      idle: { keys: [{ t: 0, pose: {} }] },
      walk: { keys: [], duration: 900 }, // duration-only must survive Save
      attack: { keys: [] }, // in-progress empty → dropped from the payload
    },
    brute: { hit: { keys: [] } }, // body with nothing authored → dropped
  };
  const p = prunedClips(store);
  assert.deepEqual(Object.keys(p), ['scout']);
  assert.deepEqual(Object.keys(p.scout).sort(), ['idle', 'walk']);
  assert.ok(store.scout.attack); // live store untouched
  assert.equal(countKeys(store), 1);
});
