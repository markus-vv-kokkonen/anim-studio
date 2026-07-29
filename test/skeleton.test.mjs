import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSkeleton, addBone, removeBone, renameBone, reparentBone, boneById,
  descendants, bonesByZ, moveBoneZ, worldTransforms, boneLocal, clampJointAngle,
  addClip, renameClip, removeClip, duplicateClip, patchClip,
  packSkeletons, unpackSkeletons, skelBodyId, isSkelBodyId, uniqueSkelId,
  matMul, matInvert, matApply, composeTRS, decomposeTRS,
} from '../src/skeleton.ts';

test('affine math round-trips: M · M⁻¹ = I, decompose(compose) = identity', () => {
  const m = composeTRS(10, -4, 0.7, 2, 0.5);
  const inv = matInvert(m);
  const [x, y] = matApply(matMul(inv, m), 12.5, -3);
  assert.ok(Math.abs(x - 12.5) < 1e-9 && Math.abs(y - -3) < 1e-9);
  const d = decomposeTRS(m);
  assert.ok(Math.abs(d.x - 10) < 1e-9 && Math.abs(d.rot - 0.7) < 1e-9);
  assert.ok(Math.abs(d.sx - 2) < 1e-9 && Math.abs(d.sy - 0.5) < 1e-9);
});

test('createSkeleton: a root bone and a default idle clip', () => {
  const doc = createSkeleton('hero', 'Hero');
  assert.equal(doc.bones.length, 1);
  assert.equal(doc.bones[0].id, 'root');
  assert.equal(doc.clips.length, 1);
  assert.equal(doc.clips[0].key, 'idle');
  assert.equal(skelBodyId(doc), 'sk:hero');
  assert.ok(isSkelBodyId('sk:hero'));
  assert.ok(!isSkelBodyId('scout:staff'));
});

test('uniqueSkelId slugs and de-dupes', () => {
  assert.equal(uniqueSkelId([], 'My Hero!'), 'my_hero');
  assert.equal(uniqueSkelId(['my_hero'], 'My Hero!'), 'my_hero2');
});

test('addBone parents to root by default, ids never collide', () => {
  const doc = createSkeleton('c', 'c');
  const a = addBone(doc, { name: 'arm' });
  const b = addBone(doc, { name: 'arm' });
  assert.equal(a.parent, 'root');
  assert.equal(a.id, 'arm');
  assert.equal(b.id, 'arm2');
  assert.ok(b.z > a.z); // new bones draw on top
});

test('removeBone takes the subtree and strips authored keys', () => {
  const doc = createSkeleton('c', 'c');
  const arm = addBone(doc, { name: 'arm' });
  const hand = addBone(doc, { name: 'hand', parent: arm.id });
  doc.timelines.idle = { keys: [{ t: 0, pose: { [arm.id]: { dAng: 1 }, [hand.id]: { dAng: 2 }, root: { dAng: 3 } } }] };
  const gone = removeBone(doc, arm.id);
  assert.deepEqual(gone.sort(), ['arm', 'hand']);
  assert.equal(doc.bones.length, 1);
  assert.deepEqual(doc.timelines.idle.keys[0].pose, { root: { dAng: 3 } });
});

test('renameBone keeps children and authored keys attached', () => {
  const doc = createSkeleton('c', 'c');
  const arm = addBone(doc, { name: 'arm' });
  addBone(doc, { name: 'hand', parent: arm.id });
  doc.timelines.idle = { keys: [{ t: 0, pose: { arm: { dAng: 1 } } }] };
  const next = renameBone(doc, 'arm', 'weapon arm');
  assert.equal(next, 'weapon_arm');
  assert.equal(boneById(doc, 'hand').parent, 'weapon_arm');
  assert.deepEqual(doc.timelines.idle.keys[0].pose, { weapon_arm: { dAng: 1 } });
});

test('reparentBone refuses cycles and preserves world placement', () => {
  const doc = createSkeleton('c', 'c');
  const arm = addBone(doc, { name: 'arm', x: 10, y: 0, rot: Math.PI / 2 });
  const hand = addBone(doc, { name: 'hand', parent: arm.id, x: 5, y: 0 });
  assert.equal(reparentBone(doc, arm.id, hand.id), false); // descendant → cycle
  assert.equal(reparentBone(doc, arm.id, arm.id), false);
  const before = worldTransforms(doc).get(hand.id);
  assert.ok(reparentBone(doc, hand.id, 'root'));
  const after = worldTransforms(doc).get(hand.id);
  for (let i = 0; i < 6; i++) assert.ok(Math.abs(before[i] - after[i]) < 1e-9, `mat[${i}] moved`);
});

test('worldTransforms chains parent→child and applies pose deltas', () => {
  const doc = createSkeleton('c', 'c');
  const root = boneById(doc, 'root');
  root.x = 0;
  root.y = 0;
  const arm = addBone(doc, { name: 'arm', x: 10, y: 0 });
  const bind = worldTransforms(doc);
  assert.deepEqual(matApply(bind.get(arm.id), 0, 0), [10, 0]);
  // rotate the root 90° via a pose delta: the arm pivot swings to (0,10)
  const posed = worldTransforms(doc, { root: { dAng: Math.PI / 2 } });
  const [x, y] = matApply(posed.get(arm.id), 0, 0);
  assert.ok(Math.abs(x) < 1e-9 && Math.abs(y - 10) < 1e-9);
  // translate a bone via ikDx/ikDy
  const moved = worldTransforms(doc, { [arm.id]: { ikDx: 3, ikDy: 4 } });
  assert.deepEqual(matApply(moved.get(arm.id), 0, 0), [13, 4]);
});

test('joint limits: hinge clamps, fixed welds, free passes through', () => {
  const doc = createSkeleton('c', 'c');
  const b = addBone(doc, { name: 'b' });
  assert.equal(clampJointAngle(b, 2), 2);
  b.joint = { type: 'hinge', min: -0.5, max: 0.5 };
  assert.equal(clampJointAngle(b, 2), 0.5);
  assert.equal(clampJointAngle(b, -2), -0.5);
  b.joint = { type: 'fixed', min: 0, max: 0 };
  assert.equal(clampJointAngle(b, 2), 0);
  const local = boneLocal(b, { dAng: 9 });
  const bind = boneLocal(b, undefined);
  assert.deepEqual(local, bind); // welded: pose rotation has no effect
});

test('draw order: bonesByZ sorts, moveBoneZ swaps neighbours', () => {
  const doc = createSkeleton('c', 'c');
  const a = addBone(doc, { name: 'a' });
  const b = addBone(doc, { name: 'b' });
  assert.deepEqual(bonesByZ(doc).map((x) => x.id), ['root', 'a', 'b']);
  assert.ok(moveBoneZ(doc, b.id, -1));
  assert.deepEqual(bonesByZ(doc).map((x) => x.id), ['root', 'b', 'a']);
  assert.equal(moveBoneZ(doc, 'root', -1), false); // already at the back
  assert.ok(a && b);
});

test('clip CRUD: add/rename/patch/duplicate/remove, last clip protected', () => {
  const doc = createSkeleton('c', 'c');
  const walk = addClip(doc, 'walk', 10, 90);
  assert.equal(walk.key, 'walk');
  assert.ok(renameClip(doc, 'walk', 'stride'));
  assert.equal(doc.clips.find((x) => x.key === 'walk').name, 'stride'); // key stable across rename
  assert.ok(patchClip(doc, 'walk', { frames: 200, per: 1 }));
  assert.equal(doc.clips.find((x) => x.key === 'walk').frames, 120); // clamped
  assert.equal(doc.clips.find((x) => x.key === 'walk').per, 16); // clamped
  doc.timelines.walk = { keys: [{ t: 0.5, pose: { root: { dAng: 1 } } }] };
  const dup = duplicateClip(doc, 'walk');
  assert.equal(dup.name, 'stride copy');
  assert.notEqual(doc.timelines[dup.key].keys[0], doc.timelines.walk.keys[0]); // deep copy
  assert.deepEqual(doc.timelines[dup.key], doc.timelines.walk);
  assert.ok(removeClip(doc, dup.key));
  assert.equal(doc.timelines[dup.key], undefined);
  assert.ok(removeClip(doc, 'walk'));
  assert.equal(removeClip(doc, 'idle'), false); // never remove the last clip
});

test('patchClip frame-count change snaps keys to the new grid', () => {
  const doc = createSkeleton('c', 'c'); // idle: 8 frames
  doc.timelines.idle = { keys: [
    { t: 0, pose: { root: { dAng: 1 } } },
    { t: 3 / 7, pose: { root: { dAng: 2 } } },
    { t: 1, pose: { root: { dAng: 3 } } },
  ] };
  patchClip(doc, 'idle', { frames: 5 }); // grid denominators 7 → 4
  assert.deepEqual(doc.timelines.idle.keys.map((k) => k.t), [0, 0.5, 1]);
  patchClip(doc, 'idle', { frames: 2 }); // collisions keep the earliest key
  assert.deepEqual(doc.timelines.idle.keys.map((k) => k.pose.root.dAng), [1, 2]);
  assert.deepEqual(doc.timelines.idle.keys.map((k) => k.t), [0, 1]);
});

test('pack → unpack round-trips a doc (bones by z, empty timelines pruned)', () => {
  const doc = createSkeleton('hero', 'Hero', 128, 160);
  const arm = addBone(doc, { name: 'arm', x: 3.5, rot: 0.25, img: { src: 'data:x', w: 8, h: 8, ax: 0, ay: 4, rot: 0, sx: 1, sy: 1 } });
  arm.joint = { type: 'hinge', min: -1, max: 1 };
  doc.timelines.idle = { keys: [{ t: 0, ease: 'easeOut', pose: { arm: { dAng: 0.5 } } }] };
  doc.timelines.empty = { keys: [] }; // must be pruned on pack
  const text = packSkeletons([doc]);
  assert.ok(text.endsWith('\n'));
  assert.equal(text, packSkeletons([doc]), 'pack is deterministic');
  const [back] = unpackSkeletons(text);
  assert.equal(back.id, 'hero');
  assert.equal(back.name, 'Hero');
  assert.equal(back.fw, 128);
  assert.deepEqual(back.bones.map((b) => b.id).sort(), ['arm', 'root']);
  assert.deepEqual(boneById(back, 'arm').joint, { type: 'hinge', min: -1, max: 1 });
  assert.deepEqual(back.timelines.idle, doc.timelines.idle);
  assert.equal(back.timelines.empty, undefined);
});

test('unpack is defensive: bad parents cleared, missing clips defaulted', () => {
  const [doc] = unpackSkeletons(JSON.stringify({
    version: 1,
    skeletons: { junk: { bones: [{ id: 'a', parent: 'ghost' }], clips: [] } },
  }));
  assert.equal(doc.name, 'junk');
  assert.equal(boneById(doc, 'a').parent, null);
  assert.equal(doc.clips.length, 1);
  assert.equal(descendants(doc, 'a').size, 0);
});
