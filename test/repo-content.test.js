'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

function readText(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('package is website-only and no longer exposes Electron app commands', () => {
  const pkg = JSON.parse(readText('package.json'));
  const scripts = pkg.scripts || {};
  const devDependencies = pkg.devDependencies || {};

  assert.equal(pkg.main, undefined);
  assert.equal(pkg.build, undefined);
  assert.equal(scripts.start, undefined);
  assert.equal(scripts.dev, undefined);
  assert.equal(scripts['build:mac'], undefined);
  assert.equal(scripts['build:win'], undefined);
  assert.equal(devDependencies.electron, undefined);
  assert.equal(devDependencies['electron-builder'], undefined);
});

test('active Electron app source is removed from the current website repo', () => {
  for (const file of [
    'main.js',
    'preload.js',
    'src/index.html',
    'src/renderer.js',
    'src/styles.css',
    'src/patcher.js',
    'scripts/afterPack.js',
    'build/pkg-scripts/postinstall'
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), false, `${file} should not remain active`);
  }
});

test('legacy desktop builds remain archived and are labeled outdated', () => {
  for (const file of [
    'Upload120-1.2.0-arm64.dmg',
    'Upload120-1.2.0-arm64.pkg',
    'Upload120-1.2.0-arm64.zip',
    'Upload120-1.2.0-x64.exe',
    'Upload120-1.2.0-portable.exe'
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} should stay as a legacy artifact`);
  }

  assert.match(readText('README.md'), /Legacy desktop builds are outdated/i);
  assert.match(readText('docs/app/index.html'), /outdated legacy desktop builds/i);
});

test('public website does not promote the desktop app as the current product', () => {
  const home = readText('docs/index.html');
  const readme = readText('README.md');

  assert.doesNotMatch(home, /App download/i);
  assert.doesNotMatch(home, /desktop releases/i);
  assert.doesNotMatch(readme, /built-in post composer/i);
  assert.doesNotMatch(readme, /Upload to TikTok/i);
  assert.doesNotMatch(readme, /npm run dev/i);
  assert.doesNotMatch(readme, /electron/i);
});

test('website explains method differences in plain language', () => {
  const home = readText('docs/index.html');
  const readme = readText('README.md');

  assert.match(home, /Extension Signal/i);
  assert.match(home, /does not change playback speed/i);
  assert.match(home, /Old hard patch/i);
  assert.match(readme, /Extension Signal/i);
});
