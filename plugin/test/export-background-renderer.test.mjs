import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import html2canvas, { sourceBackgroundPattern, withSourceBackgrounds } from '../plugin/export-background-renderer.mjs';

test('export adapter resolves the pinned CJS entry as a callable function', () => {
  assert.equal(typeof html2canvas, 'function');
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  const installed = JSON.parse(fs.readFileSync(new URL('../node_modules/html2canvas/package.json', import.meta.url)));
  assert.equal(packageJson.dependencies.html2canvas, '1.4.1');
  assert.equal(installed.version, '1.4.1');
});

test('background uses the original bitmap, exact fractional CSS size, and no CSS-size canvas', () => {
  const image = { width: 480, height: 90 };
  let received, matrix;
  const pattern = { setTransform: value => { matrix = value; } };
  const ctx = { createPattern: (source, repeat) => { received = [source, repeat]; return pattern; } };
  assert.equal(sourceBackgroundPattern(ctx, image, 104, 19.5), pattern);
  assert.deepEqual(received, [image, 'repeat']);
  assert.deepEqual(matrix, { a: 104 / 480, b: 0, c: 0, d: 19.5 / 90, e: 0, f: 0 });
  assert.equal(matrix.a * image.width, 104);
  assert.equal(matrix.d * image.height, 19.5);
});

test('unavailable or rejected pattern transforms request the original fallback', () => {
  const image = { width: 256, height: 221 };
  for (const pattern of [null, {}, { setTransform() { throw new TypeError('unsupported'); } }]) {
    assert.equal(sourceBackgroundPattern({ createPattern: () => pattern }, image, 27, 23.31), null);
  }
});

test('zero, negative, or nonfinite source/destination dimensions do not create a pattern', () => {
  const ctx = { createPattern() { assert.fail('invalid image must not be used'); } };
  for (const n of [0, -1, NaN, Infinity]) {
    assert.equal(sourceBackgroundPattern(ctx, { width: n, height: 10 }, 27, 23), null);
    assert.equal(sourceBackgroundPattern(ctx, { width: 10, height: n }, 27, 23), null);
    assert.equal(sourceBackgroundPattern(ctx, { width: 10, height: 10 }, n, 23), null);
    assert.equal(sourceBackgroundPattern(ctx, { width: 10, height: 10 }, 27, n), null);
  }
});

function fixture({ scale = 2, transform = true, missing = false } = {}) {
  const calls = [], image = { width: 444, height: 336 };
  class Base {
    constructor() {
      this.options = { scale };
      this.context = {
        cache: { match: async url => { calls.push(['load', url]); if (missing) throw Error('missing'); return image; } },
        logger: { error: message => calls.push(['error', message]) },
      };
      this.ctx = { createPattern: (source, repetition) => {
        calls.push(['pattern', source, repetition]);
        return transform ? { setTransform: m => calls.push(['matrix', m]) } : {};
      } };
    }
    renderBackgroundImage(container) { calls.push(['upstream', container]); }
    resizeImage(source, w, h) { const temp = { source, w, h }; calls.push(['resize', temp]); return temp; }
    renderRepeat(path, pattern, x, y) { calls.push(['paint', path, x, y]); }
  }
  const Renderer = withSourceBackgrounds(Base, (container, index, intrinsic) => {
    calls.push(['geometry', index, intrinsic]);
    return [`clip-${index}`, 17, 31, 148, 112];
  });
  return { renderer: new Renderer(), calls, image };
}

for (const scale of [1, 1.5, 2]) {
  test(`${scale}x backgrounds preserve reverse layer order, clip, and placement`, async () => {
    const { renderer, calls, image } = fixture({ scale });
    await renderer.renderBackgroundImage({ styles: { backgroundImage: [{ type: 0, url: 'top' }, { type: 0, url: 'bottom' }] } });
    assert.deepEqual(calls.filter(c => c[0] === 'load'), [['load', 'bottom'], ['load', 'top']]);
    assert.deepEqual(calls.filter(c => c[0] === 'paint'), [['paint', 'clip-1', 17, 31], ['paint', 'clip-0', 17, 31]]);
    assert.equal(calls.filter(c => c[0] === 'pattern').every(c => c[1] === image), true);
    assert.equal(calls.some(c => ['resize', 'upstream'].includes(c[0])), false);
  });
}

test('mixed gradient layers use the unmodified upstream path', async () => {
  for (const config of [{ scale: 1, layers: [{ type: 0, url: 'image' }, { type: 1 }] }, { scale: 2, layers: [{ type: 0, url: 'image' }, { type: 1 }] }]) {
    const { renderer, calls } = fixture(config);
    const container = { styles: { backgroundImage: config.layers } };
    await renderer.renderBackgroundImage(container);
    assert.deepEqual(calls, [['upstream', container]]);
  }
});

test('fractional no-repeat backgrounds never tile their dark left edge beyond the transparent right edge', async () => {
  let received, matrix;
  const image = { width: 350, height: 765 };
  const ctx = { createPattern: (source, repetition) => {
    received = { source, repetition }; return { setTransform: value => { matrix = value; } };
  } };
  sourceBackgroundPattern(ctx, image, 354.8, 775.49, 'no-repeat');
  assert.equal(received.source, image);
  assert.equal(received.repetition, 'no-repeat');
  assert.equal(matrix.a * 350, 354.8);
  for (const [cssRepeat, repetition] of [[1, 'no-repeat'], [2, 'repeat-x'], [3, 'repeat-y']]) {
    const { renderer, calls } = fixture({ scale: 1 });
    await renderer.renderBackgroundImage({ styles: { backgroundImage: [{ type: 0, url: 'image' }], backgroundRepeat: [cssRepeat] } });
    assert.equal(calls.find(call => call[0] === 'pattern')[2], repetition);
    assert.equal(calls.some(call => call[0] === 'resize'), false);
  }
});

test('unavailable transforms retain the original resize path and placement', async () => {
  const { renderer, calls, image } = fixture({ transform: false });
  await renderer.renderBackgroundImage({ styles: { backgroundImage: [{ type: 0, url: 'image' }] } });
  assert.deepEqual(calls.find(c => c[0] === 'resize'), ['resize', { source: image, w: 148, h: 112 }]);
  assert.deepEqual(calls.at(-1), ['paint', 'clip-0', 17, 31]);
});

test('missing images retain upstream error reporting without stopping later content', async () => {
  const { renderer, calls } = fixture({ missing: true });
  await renderer.renderBackgroundImage({ styles: { backgroundImage: [{ type: 0, url: 'missing' }] } });
  assert.deepEqual(calls, [['load', 'missing'], ['error', 'Error loading background-image missing']]);
});
