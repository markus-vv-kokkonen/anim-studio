import { test } from 'node:test';
import assert from 'node:assert/strict';
import { variationFor, applyVariation, warpTime, samplePoseVaried } from '../src/variation.ts';
import { samplePose } from '../src/sample.ts';

const tl = (variation) => ({
  variation,
  keys: [
    { t: 0, pose: { arm0: { dAng: 0 }, root: { dAng: 0 } } },
    { t: 0.5, pose: { arm0: { dAng: 1 }, root: { dAng: 0.4 } } },
    { t: 1, pose: { arm0: { dAng: 0 }, root: { dAng: 0 } } },
  ],
});

test('inert until configured: no variation → samplePose verbatim', () => {
  const t0 = tl(undefined);
  for (const t of [0, 0.25, 0.5, 0.77, 1]) {
    assert.deepEqual(samplePoseVaried(t0, t, 3, 7), samplePose(t0, t));
  }
  assert.ok(variationFor(undefined, 0).identity);
  assert.ok(variationFor({}, 0).identity);
  assert.ok(variationFor({ amp: 0, speed: 0, phase: 0 }, 0).identity, 'all-zero is identity');
  // a config with only per-bone weights still changes nothing
  assert.ok(variationFor({ bones: { arm0: 2 } }, 0).identity);
});

test('deterministic: same (seed, cycle) reproduces, different cycles differ', () => {
  const v = { amp: 0.3, seed: 5 };
  const a = variationFor(v, 2, 11);
  const b = variationFor(v, 2, 11);
  assert.equal(a.ampFor('arm0'), b.ampFor('arm0'));
  assert.equal(a.speed, b.speed);
  const other = variationFor(v, 3, 11);
  assert.notEqual(a.ampFor('arm0'), other.ampFor('arm0'), 'a new cycle draws again');
  const otherInstance = variationFor(v, 2, 12);
  assert.notEqual(a.ampFor('arm0'), otherInstance.ampFor('arm0'), 'instance seed separates copies');
  // bones vary independently within one cycle
  assert.notEqual(a.ampFor('arm0'), a.ampFor('root'));
});

test('amplitude stays inside ±amp and both under- and overshoots occur', () => {
  const v = { amp: 0.2 };
  let below = 0;
  let above = 0;
  for (let cycle = 0; cycle < 60; cycle++) {
    const k = variationFor(v, cycle).ampFor('arm0');
    assert.ok(k >= 0.8 - 1e-9 && k <= 1.2 + 1e-9, `k=${k} out of range`);
    if (k < 1) below++;
    if (k > 1) above++;
  }
  assert.ok(below > 5 && above > 5, `expected both sides, got ${below}/${above}`);
});

test('per-bone weights scale and pin', () => {
  const v = { amp: 0.5, bones: { root: 0, arm0: 1 } };
  const st = variationFor(v, 4);
  assert.equal(st.ampFor('root'), 1, 'weight 0 pins the bone to its authored pose');
  assert.notEqual(st.ampFor('arm0'), 1);
  const half = variationFor({ amp: 0.5, bones: { arm0: 0.5 } }, 4);
  const full = variationFor({ amp: 0.5 }, 4);
  assert.ok(Math.abs(half.ampFor('arm0') - 1) < Math.abs(full.ampFor('arm0') - 1));
});

test('relative channels scale; a rest pose is untouched (loops stay seamless)', () => {
  const st = { speed: 1, phase: 0, identity: false, ampFor: () => 0.5 };
  const out = applyVariation({ arm0: { dAng: 1, ikDx: 4, ikDy: -2 } }, st);
  assert.deepEqual(out.arm0, { dAng: 0.5, ikDx: 2, ikDy: -1 });
  // scaling zeros changes nothing → a clip that starts/ends at rest loops clean
  assert.deepEqual(applyVariation({ arm0: { dAng: 0 } }, st).arm0, { dAng: 0 });
});

test('absolute channels scale about the clip anchor, not the origin', () => {
  const st = { speed: 1, phase: 0, identity: false, ampFor: () => 0.5 };
  const anchor = { arm0: { ang: 2 } };
  // halfway from the anchor (2) toward the sampled value (4)
  assert.equal(applyVariation({ arm0: { ang: 4 } }, st, anchor).arm0.ang, 3);
  // no anchor for that channel → left alone (never dragged toward 0)
  assert.equal(applyVariation({ arm0: { ang: 4 } }, st, {}).arm0.ang, 4);
});

test('applyVariation never mutates the authored pose', () => {
  const st = { speed: 1, phase: 0, identity: false, ampFor: () => 0.25 };
  const pose = { arm0: { dAng: 1 } };
  const out = applyVariation(pose, st);
  assert.equal(pose.arm0.dAng, 1, 'source untouched');
  assert.notEqual(out.arm0, pose.arm0);
});

test('speed stays positive and phase wraps into [0,1)', () => {
  for (let c = 0; c < 40; c++) {
    const st = variationFor({ speed: 3, phase: 2 }, c); // absurd amounts
    assert.ok(st.speed > 0, `speed ${st.speed} must stay positive`);
    assert.ok(st.phase >= 0 && st.phase < 1, `phase ${st.phase} out of range`);
    assert.ok(warpTime(0.9, st) >= 0 && warpTime(0.9, st) < 1);
  }
});

test('samplePoseVaried composes sampling + variation', () => {
  const t1 = tl({ amp: 0.2, seed: 3 });
  const k = variationFor(t1.variation, 1).ampFor('arm0');
  const got = samplePoseVaried(t1, 0.5, 1);
  assert.ok(Math.abs(got.arm0.dAng - k) < 1e-12, 'peak pose scaled by this cycle draw');
  assert.equal(samplePoseVaried(undefined, 0.5, 1), undefined);
});
