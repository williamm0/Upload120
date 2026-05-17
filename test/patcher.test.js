'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'meta']);

function loadWebsitePatcher() {
  const browserSource = fs.readFileSync(path.join(__dirname, '..', 'docs', 'patcher.browser.js'), 'utf8');
  const context = {
    window: {},
    ArrayBuffer,
    BigInt,
    DataView,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    RegExp,
    Set,
    String,
    TextEncoder,
    TypeError,
    Uint8Array
  };

  vm.runInNewContext(browserSource, context);
  return context.window.Upload120Patcher;
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value >>> 0, 0);
  return buf;
}

function box(type, ...parts) {
  const payload = Buffer.concat(parts);
  return Buffer.concat([u32(payload.length + 8), Buffer.from(type, 'ascii'), payload]);
}

function fullBox(type, payload) {
  return box(type, Buffer.from([0, 0, 0, 0]), payload);
}

function mvhd(timescale, duration) {
  const payload = Buffer.alloc(96);
  payload.writeUInt32BE(timescale, 8);
  payload.writeUInt32BE(duration, 12);
  return fullBox('mvhd', payload);
}

function mdhd(timescale, duration) {
  const payload = Buffer.alloc(20);
  payload.writeUInt32BE(timescale, 8);
  payload.writeUInt32BE(duration, 12);
  return fullBox('mdhd', payload);
}

function hdlr(handlerType) {
  const payload = Buffer.alloc(24);
  payload.write(handlerType, 4, 4, 'ascii');
  return fullBox('hdlr', payload);
}

function stts(sampleCount, sampleDelta) {
  const payload = Buffer.alloc(12);
  payload.writeUInt32BE(1, 0);
  payload.writeUInt32BE(sampleCount, 4);
  payload.writeUInt32BE(sampleDelta, 8);
  return fullBox('stts', payload);
}

function stco(offset) {
  const payload = Buffer.alloc(8);
  payload.writeUInt32BE(1, 0);
  payload.writeUInt32BE(offset, 4);
  return fullBox('stco', payload);
}

function elst(rate = 1) {
  const payload = Buffer.alloc(16);
  payload.writeUInt32BE(1, 0);
  payload.writeUInt32BE(120, 4);
  payload.writeInt32BE(0, 8);
  payload.writeInt16BE(rate, 12);
  payload.writeUInt16BE(0, 14);
  return fullBox('elst', payload);
}

function makeMoov(chunkOffset, { includeEditList = false } = {}) {
  const stbl = box('stbl', stts(120, 1), stco(chunkOffset));
  const minf = box('minf', stbl);
  const mdia = box('mdia', mdhd(120, 120), hdlr('vide'), minf);
  const trak = box('trak', ...(includeEditList ? [box('edts', elst())] : []), mdia);
  return box('moov', mvhd(120, 120), trak);
}

function makeSampleMp4(options = {}) {
  const ftyp = box('ftyp', Buffer.from([
    0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x00, 0x01,
    0x69, 0x73, 0x6f, 0x6d,
    0x69, 0x73, 0x6f, 0x32
  ]));
  const placeholderMoov = makeMoov(0, options);
  const mdat = box('mdat', Buffer.alloc(16, 1));
  const mediaOffset = ftyp.length + placeholderMoov.length + 8;
  const moov = makeMoov(mediaOffset, options);
  return Buffer.concat([ftyp, moov, mdat]);
}

function readU32(buf, off) {
  return buf.readUInt32BE(off);
}

function typeAt(buf, off) {
  return buf.toString('ascii', off, off + 4);
}

function walkBoxes(buf, start = 0, end = buf.length) {
  const boxes = [];
  let pos = start;
  while (pos + 8 <= end) {
    const size = readU32(buf, pos);
    const type = typeAt(buf, pos + 4);
    if (size < 8 || pos + size > end) break;
    const current = { type, start: pos, contentStart: pos + 8, end: pos + size };
    boxes.push(current);
    if (CONTAINER_BOXES.has(type)) {
      boxes.push(...walkBoxes(buf, type === 'meta' ? current.contentStart + 4 : current.contentStart, current.end));
    }
    pos += size;
  }
  return boxes;
}

function findBox(buf, type) {
  return walkBoxes(buf).find(candidate => candidate.type === type);
}

function findBoxes(buf, type) {
  return walkBoxes(buf).filter(candidate => candidate.type === type);
}

function firstChunkOffset(buf) {
  const stcoBox = findBox(buf, 'stco');
  return readU32(buf, stcoBox.contentStart + 8);
}

function readMvhdTimescale(buf) {
  const header = findBox(buf, 'mvhd');
  return readU32(buf, header.contentStart + 12);
}

function readMdhdTimescale(buf) {
  const header = findBox(buf, 'mdhd');
  return readU32(buf, header.contentStart + 12);
}

function readElstRateInteger(buf) {
  const editList = findBox(buf, 'elst');
  return editList ? buf.readInt16BE(editList.contentStart + 16) : 0;
}

function hasUtf8(buf, value) {
  return buf.includes(Buffer.from(value, 'utf8'));
}

function outputBuffer(result) {
  return Buffer.from(result.bytes);
}

test('numeric divider keeps the legacy classic-force timing patch', () => {
  const { patchMp4Buffer } = loadWebsitePatcher();
  const source = makeSampleMp4();
  const result = patchMp4Buffer(source, 4);
  const output = outputBuffer(result);

  assert.equal(result.method, 'classic-force');
  assert.equal(result.divider, 4);
  assert.equal(result.mvhdCount, 1);
  assert.equal(result.mdhdCount, 1);
  assert.equal(result.elstCount, 0);
  assert.equal(readMvhdTimescale(output), 30);
  assert.equal(readMdhdTimescale(output), 30);
  assert.equal(findBoxes(output, 'elst').length, 0);
});

test('header-lite patches movie timing only and shifts chunk offsets for metadata', () => {
  const { patchMp4Buffer } = loadWebsitePatcher();
  const source = makeSampleMp4();
  const originalOffset = firstChunkOffset(source);
  const result = patchMp4Buffer(source, { method: 'header-lite', divider: 4 });
  const output = outputBuffer(result);

  assert.equal(result.method, 'header-lite');
  assert.equal(result.mvhdCount, 1);
  assert.equal(result.mdhdCount, 0);
  assert.equal(result.elstCount, 0);
  assert.equal(readMvhdTimescale(output), 30);
  assert.equal(readMdhdTimescale(output), 120);
  assert.equal(findBoxes(output, 'u120').length, 1);
  assert.equal(firstChunkOffset(output), originalOffset + (output.length - source.length));
});

test('balanced-sync adds an edit list speed guard and shifts media offsets', () => {
  const { patchMp4Buffer } = loadWebsitePatcher();
  const source = makeSampleMp4();
  const originalOffset = firstChunkOffset(source);
  const result = patchMp4Buffer(source, { method: 'balanced-sync', divider: 4 });
  const output = outputBuffer(result);

  assert.equal(result.method, 'balanced-sync');
  assert.equal(result.mvhdCount, 1);
  assert.equal(result.mdhdCount, 1);
  assert.equal(result.elstCount, 1);
  assert.equal(readMvhdTimescale(output), 30);
  assert.equal(readMdhdTimescale(output), 30);
  assert.equal(readElstRateInteger(output), 4);
  assert.equal(findBoxes(output, 'u120').length, 1);
  assert.equal(firstChunkOffset(output), originalOffset + (output.length - source.length));
});

test('extension-signal keeps desktop timing normal while adding elst and iTunes metadata', () => {
  const { patchMp4Buffer } = loadWebsitePatcher();
  const source = makeSampleMp4();
  const originalOffset = firstChunkOffset(source);
  const result = patchMp4Buffer(source, { method: 'extension-signal', divider: 4 });
  const output = outputBuffer(result);

  assert.equal(result.method, 'extension-signal');
  assert.equal(result.mvhdCount, 0);
  assert.equal(result.mdhdCount, 0);
  assert.equal(result.elstCount, 1);
  assert.equal(result.metadataCount, 2);
  assert.equal(readMvhdTimescale(output), 120);
  assert.equal(readMdhdTimescale(output), 120);
  assert.equal(readElstRateInteger(output), 1);
  assert.equal(findBoxes(output, 'meta').length, 1);
  assert.equal(findBoxes(output, 'ilst').length, 1);
  assert.equal(findBoxes(output, 'u120').length, 1);
  assert.equal(hasUtf8(output, 'Extension Signal'), true);
  assert.equal(firstChunkOffset(output), originalOffset + (output.length - source.length));
});

test('browser patcher exposes the same public method ids as the Node patcher', () => {
  const patcher = loadWebsitePatcher();
  const methodIds = Array.from(patcher.METHODS, method => method.id);
  assert.deepEqual(
    methodIds,
    ['balanced-sync', 'extension-signal', 'header-lite', 'classic-force']
  );
});

test('browser patcher applies balanced-sync to the synthetic MP4', () => {
  const patcher = loadWebsitePatcher();
  const source = makeSampleMp4();

  const result = patcher.patchMp4Buffer(
    source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength),
    { method: 'balanced-sync', divider: 4 }
  );
  const output = Buffer.from(result.bytes);

  assert.equal(result.method, 'balanced-sync');
  assert.equal(result.elstCount, 1);
  assert.equal(readElstRateInteger(output), 4);
  assert.equal(firstChunkOffset(output), firstChunkOffset(source) + (output.length - source.length));
});

test('balanced-sync output remains inspectable after insertion', () => {
  const { inspectMp4, patchMp4Buffer } = loadWebsitePatcher();
  const source = makeSampleMp4();
  const result = patchMp4Buffer(source, { method: 'balanced-sync', divider: 4 });
  const info = inspectMp4(result.bytes);

  assert.equal(info.isMp4, true);
  assert.equal(info.movieTimescale, 30);
  assert.equal(info.videoTimescale, 30);
  assert.equal(info.fps, 30);
});
