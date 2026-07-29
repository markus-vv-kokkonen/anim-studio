/**
 * Headless end-to-end verify for the studio: boots the demo in Chromium,
 * drives the __ae hook through the WHOLE authoring loop — view a body, pose a
 * bone, keyframe, Save to demo/clips.ts, reload, and prove the authored edit
 * replays through the bake path (the baked frame actually changes) — then does
 * the same for Assemble mode: build a character from a generated part, CRUD
 * its clips and keys, persist demo/skeletons.json, and prove it survives a
 * reload. Both files are restored afterwards. Non-destructive.
 *
 *   npm run verify              # spawns its own vite dev server
 *
 * Set CHROMIUM_PATH to a chrome binary to skip Playwright's managed download.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const PKG = new URL('..', import.meta.url).pathname;
const CLIPS = PKG + 'demo/clips.ts';
const SKELS = PKG + 'demo/skeletons.json';
const SHOT = new URL('./verify-shot.png', import.meta.url).pathname;
const SHOT2 = new URL('./verify-shot-assemble.png', import.meta.url).pathname;

const snapshot = fs.readFileSync(CLIPS, 'utf8');
const skelSnapshot = fs.readFileSync(SKELS, 'utf8');
const { createServer } = await import('vite');
const server = await createServer({
  configFile: PKG + 'vite.config.ts',
  root: PKG,
  server: { port: 0, open: false },
});
await server.listen();
const port = server.httpServer.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
const notFound = [];
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('response', (r) => { if (r.status() === 404) notFound.push(new URL(r.url()).pathname); });

const fail = (msg) => {
  console.error('✗ ' + msg);
  process.exitCode = 1;
};

/** Poll `cond` until it holds. For waiting on something outside the page —
 *  the dev server's own state — where page.waitForFunction cannot reach. */
const waitFor = async (cond, msg, timeout = 5000, step = 50) => {
  for (let waited = 0; waited < timeout; waited += step) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  fail(`${msg} (waited ${timeout}ms)`);
  return false;
};

try {
  await page.goto(`http://localhost:${port}/demo/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ae && window.__ae.ready(), null, { timeout: 20000 });

  const out = {};
  out.count = await page.evaluate(() => window.__ae.count());
  out.labels = await page.evaluate(() => window.__ae.labels());
  if (out.count < 3 || !out.labels.includes('scout') || !out.labels.includes('wisp')) fail(`roster wrong: ${JSON.stringify(out.labels)}`);

  // --- the view path: clips + a non-empty preview ---------------------------
  out.clips = await page.evaluate(() => window.__ae.clips());
  if (!out.clips.includes('attack') || !out.clips.includes('idle')) fail(`scout clips wrong: ${out.clips}`);
  const gotoFrame = (clipName, frame) =>
    page.evaluate(([c, f]) => {
      window.__ae.setClip(window.__ae.clips().indexOf(c));
      const scrub = document.querySelector('[data-as="scrub"]');
      scrub.value = String(f);
      scrub.dispatchEvent(new Event('input'));
    }, [clipName, frame]);
  await gotoFrame('attack', 3);
  const png = () => page.evaluate(() => document.querySelector('[data-as="preview"]').toDataURL());
  const pixels = await page.evaluate(() => {
    const c = document.querySelector('[data-as="preview"]');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
    return n;
  });
  if (pixels < 50) fail(`preview near-empty (${pixels}px)`);
  const beforeEdit = await png();

  // --- a view-only body has no rig ------------------------------------------
  await page.evaluate((i) => window.__ae.select(i), out.labels.indexOf('wisp'));
  await page.waitForFunction(() => window.__ae.state().name === 'wisp');
  out.wisp = await page.evaluate(() => window.__ae.state());
  if (out.wisp.poseable) fail('wisp should be view-only');

  // --- the authoring loop: pose → key → save ---------------------------------
  await page.evaluate((i) => window.__ae.select(i), out.labels.indexOf('scout'));
  await page.waitForFunction(() => window.__ae.state().name === 'scout');
  await gotoFrame('attack', 3);
  await page.evaluate(() => window.__ae.setPose(true));
  out.bones = await page.evaluate(() => window.__ae.bones());
  const kinds = new Set(out.bones.map((b) => b.kind));
  if (!(kinds.has('arm') && kinds.has('leg') && kinds.has('root'))) fail(`bones missing kinds: ${JSON.stringify(out.bones)}`);
  await page.evaluate(() => window.__ae.nudge('arm1', 0.7));
  out.keys = await page.evaluate(() => window.__ae.authoredKeys());
  if (out.keys < 1) fail('nudge did not author a key');
  out.saved = await page.evaluate(() => window.__ae.save());
  if (!out.saved) fail('save endpoint failed');
  const written = fs.readFileSync(CLIPS, 'utf8');
  if (!written.includes('"scout:staff"') || !written.includes('"arm1"')) fail('clips.ts missing the authored key');
  if (!written.startsWith('// GENERATED by anim-studio (demo).')) fail('clips.ts banner not preserved');

  // --- the replay: reload → the authored key changes the BAKED frame --------
  //
  // Wait for Vite to actually SERVE the saved module before reloading. The
  // save endpoint writes demo/clips.ts straight to disk, but Vite answers
  // module requests from its own transform cache and only invalidates once its
  // file watcher fires. Reloading immediately re-imports the pre-save module,
  // the authored key appears to vanish, and the failure reads as "the studio
  // did not replay the edit" when nothing is wrong with the studio at all.
  //
  // Polled, not slept: the watcher's latency is whatever the filesystem and
  // the machine make it, and a fixed delay is a guess that fails on a slower
  // box and wastes time on a faster one.
  await waitFor(
    async () => (await (await fetch(`http://localhost:${port}/demo/clips.ts`)).text()).includes('"arm1"'),
    'vite never served the saved clips.ts',
  );
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__ae && window.__ae.ready(), null, { timeout: 20000 });
  const keysAfterReload = await page.evaluate(() => window.__ae.authoredKeys());
  if (keysAfterReload < 1) fail('authored store did not load from the saved file');
  await gotoFrame('attack', 3);
  const afterEdit = await png();
  if (afterEdit === beforeEdit) fail('authored key did not change the baked frame after reload');
  // …and only where authored: an unkeyed frame elsewhere is untouched by design
  await page.screenshot({ path: SHOT });

  // --- assemble mode: build a character from a generated part ----------------
  out.skel = await page.evaluate(() => {
    const api = window.__ae;
    api.setMode('assemble');
    const id = api.newSkeleton('Test Hero');
    const c = document.createElement('canvas');
    c.width = 12;
    c.height = 8;
    const cx = c.getContext('2d');
    cx.fillStyle = '#a7f070';
    cx.fillRect(0, 0, 12, 8);
    const src = c.toDataURL('image/png');
    const arm = api.addSkelBone(id, { name: 'arm', x: 10, y: -6, imgSrc: src, imgW: 12, imgH: 8 });
    const hand = api.addSkelBone(id, { name: 'hand', parent: arm, x: 8, imgSrc: src, imgW: 12, imgH: 8 });
    api.patchSkelBone(id, hand, { rot: 0.4, sx: 1.5, sy: 1.5 });
    api.patchSkelBone(id, arm, { joint: { type: 'hinge', min: -1, max: 1 } });
    return { id, arm, hand, list: api.skeletons(), mode: api.mode() };
  });
  if (out.skel.mode !== 'assemble') fail('setMode(assemble) did not switch');
  const hero = out.skel.list.find((s) => s.id === 'test_hero');
  if (!hero || hero.bones !== 3) fail(`skeleton wrong: ${JSON.stringify(out.skel.list)}`);
  await page.screenshot({ path: SHOT2 });

  // --- the assembled body joins the roster and animates ----------------------
  await page.evaluate(() => window.__ae.setMode('animate'));
  const labels2 = await page.evaluate(() => window.__ae.labels());
  if (!labels2.includes('Test Hero')) fail(`assembled body missing from roster: ${labels2}`);
  await page.evaluate((i) => window.__ae.select(i), labels2.indexOf('Test Hero'));
  await page.waitForFunction(() => window.__ae.state().name === 'Test Hero');
  out.skelState = await page.evaluate(() => window.__ae.state());
  if (!out.skelState.poseable) fail('assembled body should be poseable');

  // clip CRUD: add → rename → retime; key CRUD: nudge → move → copy/paste
  out.clipCrud = await page.evaluate(() => {
    const api = window.__ae;
    const key = api.addClip('walk');
    const renamed = api.renameClip(key, 'strut');
    const patched = api.patchClip(key, { frames: 6, fps: 30 });
    api.setClip(api.clips().indexOf('strut'));
    return { key, renamed, patched, clips: api.clips(), frames: api.state().frames };
  });
  if (!out.clipCrud.key || !out.clipCrud.renamed || !out.clipCrud.patched) fail(`clip CRUD failed: ${JSON.stringify(out.clipCrud)}`);
  if (!out.clipCrud.clips.includes('strut') || out.clipCrud.frames !== 6) fail(`clip rename/retime wrong: ${JSON.stringify(out.clipCrud)}`);

  await page.evaluate(() => window.__ae.setPose(true));
  out.skelBones = await page.evaluate(() => window.__ae.bones());
  if (out.skelBones.length !== 3 || !out.skelBones.some((b) => b.kind === 'root')) fail(`skeleton bones wrong: ${JSON.stringify(out.skelBones)}`);
  out.keyCrud = await page.evaluate(() => {
    const api = window.__ae;
    const scrub = document.querySelector('[data-as="scrub"]');
    const goto = (f) => {
      scrub.value = String(f);
      scrub.dispatchEvent(new Event('input'));
    };
    goto(0);
    api.nudge('arm', 0.6); // keys frame 0
    const moved = api.moveKey(0, 3);
    goto(3);
    const copyAtNew = api.copyKey(); // true only if the key really moved here
    goto(0);
    const copyAtOld = api.copyKey(); // false — the key left frame 0
    goto(5);
    const pasted = api.pasteKey();
    return { moved, copyAtNew, copyAtOld, pasted, keys: api.authoredKeys() };
  });
  if (!out.keyCrud.moved || !out.keyCrud.copyAtNew || out.keyCrud.copyAtOld || !out.keyCrud.pasted) fail(`key CRUD wrong: ${JSON.stringify(out.keyCrud)}`);

  // --- variation: off by default, deterministic when on, and clears away ----
  out.variation = await page.evaluate(async () => {
    const api = window.__ae;
    const before = api.getVariation() ?? null;
    api.setVariation({ amp: 0.25, speed: 0.1 });
    const cfg = api.getVariation();
    const { samplePoseVaried } = await import('/src/variation.ts');
    const tl = { variation: cfg, keys: [{ t: 0, pose: { arm: { dAng: 0 } } }, { t: 1, pose: { arm: { dAng: 1 } } }] };
    const draws = [0, 1, 2, 3].map((c) => samplePoseVaried(tl, 1, c, 0).arm.dAng);
    const repeat = samplePoseVaried(tl, 1, 2, 0).arm.dAng;
    api.setVariation({ amp: 0, speed: 0, phase: 0 });
    return { before, cfg, draws, repeat, cleared: api.getVariation() ?? null };
  });
  if (out.variation.before !== null) fail('variation should be absent until configured');
  if (out.variation.cleared !== null) fail('zeroing variation should remove the config');
  if (new Set(out.variation.draws).size < 3) fail(`variation draws not varying: ${out.variation.draws}`);
  if (out.variation.draws.some((d) => d < 0.75 || d > 1.25)) fail(`variation outside ±amp: ${out.variation.draws}`);
  if (out.variation.repeat !== out.variation.draws[2]) fail('variation is not deterministic per (seed, cycle)');

  // --- persistence: skeleton file written; the game clips file stays clean ---
  out.skelSaved = await page.evaluate(() => window.__ae.saveSkeletons());
  if (!out.skelSaved) fail('saveSkeletons failed');
  const skelWritten = fs.readFileSync(SKELS, 'utf8');
  if (!skelWritten.includes('"test_hero"') || !skelWritten.includes('"strut"') || !skelWritten.includes('"arm"')) fail('skeletons.json missing the assembled character');
  await page.evaluate(() => window.__ae.save());
  if (fs.readFileSync(CLIPS, 'utf8').includes('sk:')) fail('assembled sk:* timelines leaked into the game clips file');

  // --- reload: the assembled character and its keys survive ------------------
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__ae && window.__ae.ready(), null, { timeout: 20000 });
  out.skelAfterReload = await page.evaluate(() => window.__ae.skeletons());
  const heroAfter = out.skelAfterReload.find((s) => s.id === 'test_hero');
  if (!heroAfter || heroAfter.bones !== 3 || heroAfter.clips !== 2) {
    fail(`skeleton did not survive reload: ${JSON.stringify(out.skelAfterReload)}`);
  }
  // the seeded, fully-editable demo character ships in demo/skeletons.json
  if (!out.skelAfterReload.some((s) => s.id === 'scout_kit')) fail('seeded scout kit missing from the demo data');
  const deleted = await page.evaluate(() => window.__ae.deleteSkeleton('test_hero'));
  if (!deleted) fail('deleteSkeleton failed');

  // --- project host: the endpoint answers, and opt-in gates the picker ------
  // anim-studio.config.json is gitignored (absolute, machine-specific paths),
  // so a fresh clone and CI have none. The plugin answers with an empty list
  // rather than erroring, and this leg asserts BOTH shapes rather than
  // assuming the developer's own config is present.
  {
    const res = await fetch(`http://localhost:${port}/__anim/projects`, { headers: { accept: 'application/json' } });
    if (!res.ok) fail('GET /__anim/projects should answer 200');
    const info = await res.json();
    if (!Array.isArray(info.projects)) fail(`projects should be a list, got ${JSON.stringify(info)}`);
    out.projects = info.projects.length;

    if (info.projects.length > 0) {
      if (!info.active) fail('an active project should be named when projects exist');
      // Node's fetch, NOT the page: a deliberate 404 seen by the browser would
      // land in `notFound` and fail the whole run.
      const bad = await fetch(`http://localhost:${port}/__anim/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: '__nope__' }),
      });
      if (bad.status !== 404) fail(`an unknown project id should 404, got ${bad.status}`);
    }

    const skels = await fetch(`http://localhost:${port}/__anim/project-skeletons`);
    if (!skels.ok) fail('GET /__anim/project-skeletons should answer 200');
    JSON.parse(await skels.text()); // must be valid JSON even when the file is absent
  }

  // The demo host never opts in (no `projects` on its adapter), so it must
  // show no picker even though this very server runs the project plugin.
  out.demoPickerHidden = await page.evaluate(() => document.querySelector('[data-as="projWrap"]')?.hidden);
  if (out.demoPickerHidden !== true) fail('a host that did not opt in must show no project picker');

  out.errors = errors;
  out.notFound = notFound.filter((p) => p !== '/favicon.ico'); // favicon 404 is benign
  if (errors.length) fail(`console errors: ${errors.join(' | ')}`);
  if (out.notFound.length) fail(`404s: ${out.notFound.join(' ')}`);
  console.log(JSON.stringify({ ...out, bones: out.bones.length, skelBones: out.skelBones.length }, null, 2));
  if (process.exitCode !== 1) console.log('✓ studio verify passed');
} finally {
  await browser.close();
  await server.close();
  fs.writeFileSync(CLIPS, snapshot); // non-destructive: restore the demo data
  fs.writeFileSync(SKELS, skelSnapshot);
}
