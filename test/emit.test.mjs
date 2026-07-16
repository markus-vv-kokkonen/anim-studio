import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stableClips, clipsLiteral, emitClipsJson, emitClipsModule } from '../src/emit.ts';

test('object keys are deep-sorted → byte-stable output regardless of insertion order', () => {
  const a = { b: { z: 1, a: 2 }, a: { keys: [] } };
  const b = { a: { keys: [] }, b: { a: 2, z: 1 } };
  assert.equal(clipsLiteral(a), clipsLiteral(b));
  assert.equal(clipsLiteral(a), '{"a":{"keys":[]},"b":{"a":2,"z":1}}');
});

test('numbers keep full precision; only -0 is normalised', () => {
  const v = { x: { ang: 0.1148050297095271, neg: -0 } };
  const lit = clipsLiteral(v);
  assert.ok(lit.includes('0.1148050297095271'));
  assert.ok(lit.includes('"neg":0'));
  assert.deepEqual(stableClips(v), { x: { ang: 0.1148050297095271, neg: 0 } });
});

test('emit → parse → emit is a fixed point (idempotent round-trip)', () => {
  const store = { scout: { idle: { keys: [{ t: 0.5, ease: 'easeIn', pose: { arm0: { dAng: -0.25 } } }] } } };
  const once = emitClipsJson(store);
  const twice = emitClipsJson(JSON.parse(once));
  assert.equal(once, twice);
});

test('the TS module shape: banner, types import, typed exports, compact literal', () => {
  const out = emitClipsModule({ b: { idle: { keys: [] } } }, {
    banner: '// custom banner',
    typesImport: `import type { BodyClips, MotionOverride } from '../src/types';`,
  });
  assert.equal(
    out,
    `// custom banner\n` +
      `import type { BodyClips, MotionOverride } from '../src/types';\n\n` +
      `export const ANIM_CLIPS: Record<string, BodyClips> = {"b":{"idle":{"keys":[]}}};\n\n` +
      `export const ANIM_OVERRIDES: Record<string, MotionOverride> = {};\n`,
  );
});

test('export names are configurable; overrides can be omitted', () => {
  const out = emitClipsModule({}, { banner: '//b', clipsExport: 'CLIPS', overridesExport: false });
  assert.ok(out.includes('export const CLIPS: Record<string, BodyClips> = {};'));
  assert.ok(!out.includes('MotionOverride> ='));
});

test('json emit ends with one trailing newline', () => {
  assert.equal(emitClipsJson({}), '{}\n');
});
