import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samplePose, poseForFrame } from '../src/sample.ts';

const key = (t, pose, ease) => ({ t, pose, ...(ease ? { ease } : {}) });

test('no timeline / no keys → undefined (the procedural default renders)', () => {
  assert.equal(samplePose(undefined, 0.5), undefined);
  assert.equal(samplePose({ keys: [] }, 0.5), undefined);
  assert.equal(poseForFrame(undefined, 'idle', 0), undefined);
  assert.equal(poseForFrame({}, 'idle', 0), undefined);
});

test('a t exactly ON a key returns that key pose VERBATIM — absolute channels included', () => {
  const pose = { arm0: { ang: 1.25, poke: 0.5 }, root: { dx: 2, dy: -1, rot: 0.1 } };
  const tl = { keys: [key(0, { arm0: { ang: 0 } }), key(0.5, pose), key(1, { arm0: { ang: 0 } })] };
  assert.equal(samplePose(tl, 0.5), pose); // same object, not a lerp
});

test('before the first / after the last key clamps to that key', () => {
  const tl = { keys: [key(0.25, { arm0: { dAng: 1 } }), key(0.75, { arm0: { dAng: 3 } })] };
  assert.deepEqual(samplePose(tl, 0), { arm0: { dAng: 1 } });
  assert.deepEqual(samplePose(tl, 1), { arm0: { dAng: 3 } });
});

test('relative channels interpolate to/from 0 at an unauthored end', () => {
  const tl = { keys: [key(0, {}), key(1, { arm0: { dAng: 2 } })] };
  assert.deepEqual(samplePose(tl, 0.5), { arm0: { dAng: 1 } });
  const tl2 = { keys: [key(0, { leg1: { ikDx: 4, ikDy: -4 } }), key(1, {})] };
  assert.deepEqual(samplePose(tl2, 0.75), { leg1: { ikDx: 1, ikDy: -1 } });
});

test('absolute channels interpolate ONLY when both keys define them', () => {
  const both = { keys: [key(0, { arm0: { ang: 1 } }), key(1, { arm0: { ang: 3 } })] };
  assert.deepEqual(samplePose(both, 0.5), { arm0: { ang: 2 } });
  // one-sided → the in-between drops the channel (procedural default renders)
  const oneSided = { keys: [key(0, { arm0: { ang: 1 } }), key(1, { arm0: { dAng: 1 } })] };
  assert.deepEqual(samplePose(oneSided, 0.5), { arm0: { dAng: 0.5 } });
});

test('easing shapes the approach into the NEXT key', () => {
  const tl = { keys: [key(0, {}), key(1, { arm0: { dAng: 1 } }, 'easeIn')] };
  assert.deepEqual(samplePose(tl, 0.5), { arm0: { dAng: 0.25 } }); // u²
  const out = { keys: [key(0, {}), key(1, { arm0: { dAng: 1 } }, 'easeOut')] };
  assert.deepEqual(samplePose(out, 0.5), { arm0: { dAng: 0.75 } }); // 1-(1-u)²
  const io = { keys: [key(0, {}), key(1, { arm0: { dAng: 1 } }, 'easeInOut')] };
  assert.deepEqual(samplePose(io, 0.25), { arm0: { dAng: 0.125 } }); // 2u²
});

test('between-key sampling unions bone ids from both keys', () => {
  const tl = { keys: [key(0, { arm0: { dAng: 2 } }), key(1, { leg0: { ikDy: 2 } })] };
  assert.deepEqual(samplePose(tl, 0.5), { arm0: { dAng: 1 }, leg0: { ikDy: 1 } });
});
