import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProjectConfig, projectById, safeJoin } from '../src/project.ts';

test('parses a config and defaults active to the first project', () => {
  const cfg = parseProjectConfig(JSON.stringify({
    projects: [
      { id: 'heft', name: 'HEFT', root: '/tmp/heft', publicDir: 'public', skeletonsFile: 'src/data/anim/skeletons.json' },
      { id: 'other', name: 'Other', root: '/tmp/other', publicDir: 'static', skeletonsFile: 'sk.json' },
    ],
  }));
  assert.equal(cfg.projects.length, 2);
  assert.equal(cfg.active, 'heft');
  assert.equal(cfg.projects[0].publicDir, 'public');
});

test('honours an explicit active id', () => {
  const cfg = parseProjectConfig(JSON.stringify({
    active: 'other',
    projects: [
      { id: 'heft', name: 'HEFT', root: '/tmp/heft', publicDir: 'public', skeletonsFile: 'a.json' },
      { id: 'other', name: 'Other', root: '/tmp/other', publicDir: 'public', skeletonsFile: 'b.json' },
    ],
  }));
  assert.equal(cfg.active, 'other');
});

test('an active id naming no project falls back to the first', () => {
  const cfg = parseProjectConfig(JSON.stringify({
    active: 'ghost',
    projects: [{ id: 'heft', name: 'HEFT', root: '/tmp/heft', publicDir: 'public', skeletonsFile: 'a.json' }],
  }));
  assert.equal(cfg.active, 'heft');
});

test('rejects an empty project list', () => {
  assert.throws(() => parseProjectConfig('{"projects":[]}'), /at least one project/);
});

test('rejects duplicate ids', () => {
  const text = JSON.stringify({
    projects: [
      { id: 'a', name: 'A', root: '/tmp/a', publicDir: 'public', skeletonsFile: 'x.json' },
      { id: 'a', name: 'B', root: '/tmp/b', publicDir: 'public', skeletonsFile: 'y.json' },
    ],
  });
  assert.throws(() => parseProjectConfig(text), /duplicate project id/);
});

test('rejects a project missing a required field, naming the field', () => {
  // Omits ONLY skeletonsFile, so the assertion pins the reported field rather
  // than whichever of several missing ones happens to be checked first.
  const text = JSON.stringify({ projects: [{ id: 'a', name: 'A', root: '/tmp/a', publicDir: 'public' }] });
  assert.throws(() => parseProjectConfig(text), /skeletonsFile/);
});

test('names the FIRST missing field when several are absent', () => {
  const text = JSON.stringify({ projects: [{ id: 'a', name: 'A', root: '/tmp/a' }] });
  assert.throws(() => parseProjectConfig(text), /publicDir/);
});

test('rejects malformed JSON with a readable message', () => {
  assert.throws(() => parseProjectConfig('{nope'), /anim-studio\.config\.json/);
});

test('projectById finds and misses', () => {
  const cfg = parseProjectConfig(JSON.stringify({
    projects: [{ id: 'heft', name: 'HEFT', root: '/tmp/heft', publicDir: 'public', skeletonsFile: 'a.json' }],
  }));
  assert.equal(projectById(cfg, 'heft').name, 'HEFT');
  assert.equal(projectById(cfg, 'nope'), undefined);
});

test('safeJoin resolves inside the root and refuses escapes', () => {
  assert.equal(safeJoin('/tmp/heft', 'art/chars/podge_head.png'), '/tmp/heft/art/chars/podge_head.png');
  assert.equal(safeJoin('/tmp/heft', '/art/chars/x.png'), '/tmp/heft/art/chars/x.png');
  assert.equal(safeJoin('/tmp/heft', '../secrets.txt'), null);
  assert.equal(safeJoin('/tmp/heft', 'art/../../secrets.txt'), null);
});
