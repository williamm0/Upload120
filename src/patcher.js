'use strict';

// Pure-JS MP4 (ISO BMFF) atom parser + FPS detector + mvhd/mdhd timescale patcher.
// Improvements over the reference C++ patcher:
//   - Walks the atom hierarchy (no false positives from raw indexOf on payload bytes).
//   - Detects FPS from stts (sample-to-time) / mdhd timescale, no media library required.
//   - Supports any FPS (not only 60/120). Caller picks divider, default = round(fps/30).
//   - Handles 32-bit and 64-bit `largesize` boxes.
//   - Patches every mvhd + every track's mdhd in one pass.

function readU32(buf, off) {
  return buf.readUInt32BE(off);
}
function readU64(buf, off) {
  // BigInt-safe 64-bit read; JS numbers fine for typical MP4s but BigInt is correct.
  const hi = buf.readUInt32BE(off);
  const lo = buf.readUInt32BE(off + 4);
  return BigInt(hi) * 0x100000000n + BigInt(lo);
}
function writeU32(buf, off, v) {
  buf.writeUInt32BE(v >>> 0, off);
}
function writeU64(buf, off, v) {
  const big = typeof v === 'bigint' ? v : BigInt(v);
  buf.writeUInt32BE(Number((big >> 32n) & 0xFFFFFFFFn), off);
  buf.writeUInt32BE(Number(big & 0xFFFFFFFFn), off + 4);
}
function fourcc(buf, off) {
  return buf.toString('ascii', off, off + 4);
}

// Walk top-level boxes and yield {type, start, headerSize, contentStart, contentSize, end}.
function* walkBoxes(buf, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = readU32(buf, pos);
    const type = fourcc(buf, pos + 4);
    let headerSize = 8;
    let boxEnd;
    if (size === 1) {
      if (pos + 16 > end) return;
      const big = readU64(buf, pos + 8);
      headerSize = 16;
      boxEnd = pos + Number(big);
    } else if (size === 0) {
      boxEnd = end;
    } else {
      boxEnd = pos + size;
    }
    if (boxEnd > end || boxEnd <= pos) return;
    yield {
      type,
      start: pos,
      headerSize,
      contentStart: pos + headerSize,
      contentEnd: boxEnd,
      end: boxEnd
    };
    pos = boxEnd;
  }
}

const CONTAINER_BOXES = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'meta', 'dinf', 'moof', 'traf', 'mvex'
]);

const METHODS = Object.freeze([
  {
    id: 'balanced-sync',
    name: 'Balanced Sync',
    description: 'Adds an edit-list speed guard around the timing patch for better desktop preview behavior.'
  },
  {
    id: 'header-lite',
    name: 'Header Lite',
    description: 'Patches movie timing only and leaves media sample timing untouched.'
  },
  {
    id: 'classic-force',
    name: 'Classic Force',
    description: 'Uses the original mvhd/mdhd patch for maximum compatibility with the legacy method.'
  }
]);

const METHOD_IDS = new Set(METHODS.map(method => method.id));

function findBoxes(buf, type, start = 0, end = buf.length, results = []) {
  for (const box of walkBoxes(buf, start, end)) {
    if (box.type === type) results.push(box);
    if (CONTAINER_BOXES.has(box.type)) {
      findBoxes(buf, type, box.contentStart, box.contentEnd, results);
    }
  }
  return results;
}

function findChild(buf, parent, type) {
  for (const box of walkBoxes(buf, parent.contentStart, parent.contentEnd)) {
    if (box.type === type) return box;
  }
  return null;
}

function findDirectChildren(buf, parent, type) {
  const children = [];
  for (const box of walkBoxes(buf, parent.contentStart, parent.contentEnd)) {
    if (box.type === type) children.push(box);
  }
  return children;
}

function findDescendant(buf, parent, types) {
  let current = parent;
  for (const t of types) {
    if (!current) return null;
    current = findChild(buf, current, t);
  }
  return current;
}

// Read mvhd: returns {version, timescale, duration, contentStart}
function readMvhd(buf, box) {
  const off = box.contentStart;
  const version = buf[off];
  // skip flags(3)
  let p = off + 4;
  if (version === 1) {
    // creation(8) + modification(8) + timescale(4) + duration(8)
    p += 16;
    const timescale = readU32(buf, p);
    const duration = readU64(buf, p + 4);
    return { version, timescale, duration, timescaleOffset: p, durationOffset: p + 4, durationBytes: 8 };
  } else {
    // creation(4) + modification(4) + timescale(4) + duration(4)
    p += 8;
    const timescale = readU32(buf, p);
    const duration = readU32(buf, p + 4);
    return { version, timescale, duration, timescaleOffset: p, durationOffset: p + 4, durationBytes: 4 };
  }
}

function readMdhd(buf, box) {
  const off = box.contentStart;
  const version = buf[off];
  let p = off + 4;
  if (version === 1) {
    p += 16; // creation+modification
    const timescale = readU32(buf, p);
    const duration = readU64(buf, p + 4);
    return { version, timescale, duration, timescaleOffset: p, durationOffset: p + 4, durationBytes: 8 };
  } else {
    p += 8;
    const timescale = readU32(buf, p);
    const duration = readU32(buf, p + 4);
    return { version, timescale, duration, timescaleOffset: p, durationOffset: p + 4, durationBytes: 4 };
  }
}

// stts: sample count + sample delta entries → fps = timescale / mostCommonDelta
function readStts(buf, box) {
  const off = box.contentStart;
  // version(1)+flags(3)+entryCount(4)+entries[count]*(sampleCount(4)+sampleDelta(4))
  const entryCount = readU32(buf, off + 4);
  const entries = [];
  let totalSamples = 0;
  let weightedDelta = 0;
  for (let i = 0; i < entryCount; i++) {
    const sampleCount = readU32(buf, off + 8 + i * 8);
    const sampleDelta = readU32(buf, off + 8 + i * 8 + 4);
    entries.push({ sampleCount, sampleDelta });
    totalSamples += sampleCount;
    weightedDelta += sampleCount * sampleDelta;
  }
  const avgDelta = totalSamples > 0 ? weightedDelta / totalSamples : 0;
  return { entryCount, entries, totalSamples, avgDelta };
}

function findVideoTrack(buf, moov) {
  const traks = [];
  for (const box of walkBoxes(buf, moov.contentStart, moov.contentEnd)) {
    if (box.type === 'trak') traks.push(box);
  }
  for (const trak of traks) {
    const mdia = findChild(buf, trak, 'mdia');
    if (!mdia) continue;
    const hdlr = findChild(buf, mdia, 'hdlr');
    if (!hdlr) continue;
    // hdlr: version(1)+flags(3)+pre_defined(4)+handler_type(4)
    const handlerType = fourcc(buf, hdlr.contentStart + 8);
    if (handlerType === 'vide') return { trak, mdia };
  }
  return null;
}

function inspectMp4(buf) {
  const ftyp = findBoxes(buf, 'ftyp', 0, buf.length)[0];
  if (!ftyp) {
    return { isMp4: false, error: 'Not an MP4 / ISO BMFF file (no ftyp box).' };
  }
  const major = fourcc(buf, ftyp.contentStart);
  const moov = findBoxes(buf, 'moov', 0, buf.length)[0];
  if (!moov) {
    return { isMp4: true, major, error: 'Missing moov box (file may be incomplete).' };
  }
  const mvhd = findChild(buf, moov, 'mvhd');
  if (!mvhd) return { isMp4: true, major, error: 'Missing mvhd box.' };
  const mvhdData = readMvhd(buf, mvhd);

  const videoTrack = findVideoTrack(buf, moov);
  let fps = 0;
  let frameCount = 0;
  let durationSec = 0;
  let videoTimescale = 0;
  let width = 0, height = 0;

  if (videoTrack) {
    const mdhd = findChild(buf, videoTrack.mdia, 'mdhd');
    if (mdhd) {
      const m = readMdhd(buf, mdhd);
      videoTimescale = m.timescale;
      const dur = typeof m.duration === 'bigint' ? Number(m.duration) : m.duration;
      durationSec = dur / m.timescale;
    }
    // tkhd → width/height (fixed-point 16.16)
    const tkhd = findChild(buf, videoTrack.trak, 'tkhd');
    if (tkhd) {
      const off = tkhd.contentStart;
      const ver = buf[off];
      const baseSkip = ver === 1 ? 32 : 20;
      // After base header come reserved(4)+layer(2)+alt(2)+vol(2)+reserved(2)+matrix(36) = 48
      const wOff = off + 4 + baseSkip + 4 + 4 + 4 + 36;
      width = buf.readUInt32BE(wOff) >>> 16;
      height = buf.readUInt32BE(wOff + 4) >>> 16;
    }
    const stts = findDescendant(buf, videoTrack.trak, ['mdia', 'minf', 'stbl', 'stts']);
    if (stts && videoTimescale > 0) {
      const s = readStts(buf, stts);
      frameCount = s.totalSamples;
      if (s.avgDelta > 0) {
        fps = videoTimescale / s.avgDelta;
      } else if (durationSec > 0) {
        fps = frameCount / durationSec;
      }
    }
  }

  // Round near-integer FPS values (29.97 → 29.97, 59.94 → 59.94, 60.0001 → 60)
  const roundedFps = Math.abs(fps - Math.round(fps)) < 0.05 ? Math.round(fps) : Number(fps.toFixed(3));

  return {
    isMp4: true,
    major,
    fps: roundedFps,
    rawFps: fps,
    frameCount,
    durationSec,
    width,
    height,
    movieTimescale: mvhdData.timescale,
    videoTimescale
  };
}

function checkedU32(value, label, min = 1) {
  const integer = Math.floor(value);
  if (!Number.isFinite(integer) || integer < min || integer > 0xFFFFFFFF) {
    throw new Error(`${label} would overflow a 32-bit MP4 field.`);
  }
  return integer;
}

function normalizePatchOptions(options = 4) {
  if (typeof options === 'number') {
    if (!Number.isFinite(options) || options < 1) throw new Error(`Invalid divider: ${options}`);
    return { divider: Math.max(1, Math.round(options)), method: 'classic-force', legacyNumeric: true };
  }

  if (!options || typeof options !== 'object') {
    throw new Error('Patch options must be a divider number or options object.');
  }

  const divider = Number(options.divider ?? 4);
  if (!Number.isFinite(divider) || divider < 1) throw new Error(`Invalid divider: ${options.divider}`);

  const method = options.method || 'balanced-sync';
  if (!METHOD_IDS.has(method)) throw new Error(`Unknown patch method: ${method}`);

  return {
    divider: Math.max(1, Math.round(divider)),
    method,
    legacyNumeric: false
  };
}

function makeBox(type, ...parts) {
  const payload = Buffer.concat(parts);
  const out = Buffer.alloc(payload.length + 8);
  out.writeUInt32BE(out.length, 0);
  out.write(type, 4, 4, 'ascii');
  payload.copy(out, 8);
  return out;
}

function makeFullBox(type, version, flags, payload) {
  const header = Buffer.alloc(4);
  header[0] = version & 0xFF;
  header.writeUIntBE(flags & 0xFFFFFF, 1, 3);
  return makeBox(type, header, payload);
}

function makeEditListBox(segmentDuration, divider) {
  const mediaRate = Math.max(1, Math.min(0x7FFF, Math.round(divider)));
  const durationNumber = typeof segmentDuration === 'bigint' ? Number(segmentDuration) : segmentDuration;

  if (typeof segmentDuration === 'bigint' || durationNumber > 0xFFFFFFFF) {
    const payload = Buffer.alloc(24);
    payload.writeUInt32BE(1, 0);
    writeU64(payload, 4, segmentDuration);
    writeU64(payload, 12, 0n);
    payload.writeInt16BE(mediaRate, 20);
    payload.writeUInt16BE(0, 22);
    return makeFullBox('elst', 1, 0, payload);
  }

  const payload = Buffer.alloc(16);
  payload.writeUInt32BE(1, 0);
  payload.writeUInt32BE(checkedU32(durationNumber, 'elst segment duration', 0), 4);
  payload.writeInt32BE(0, 8);
  payload.writeInt16BE(mediaRate, 12);
  payload.writeUInt16BE(0, 14);
  return makeFullBox('elst', 0, 0, payload);
}

function makeMetadataHintBox(method, divider) {
  const payload = Buffer.from(JSON.stringify({
    tool: 'Upload120',
    method,
    divider,
    local: true
  }), 'utf8');
  return makeBox('u120', payload);
}

function patchMvhdInPlace(buf, mvhd, divider) {
  const m = readMvhd(buf, mvhd);
  const newTimescale = checkedU32(Math.max(1, m.timescale / divider), 'mvhd timescale');
  writeU32(buf, m.timescaleOffset, newTimescale);

  if (m.durationBytes === 4) {
    const newDuration = checkedU32(m.duration / divider, 'mvhd duration', 0);
    writeU32(buf, m.durationOffset, newDuration);
    return { timescale: newTimescale, duration: newDuration };
  }

  const newDuration = m.duration / BigInt(divider);
  writeU64(buf, m.durationOffset, newDuration);
  return { timescale: newTimescale, duration: newDuration };
}

function patchMdhdInPlace(buf, mdhd, divider) {
  const m = readMdhd(buf, mdhd);
  const newTimescale = checkedU32(Math.max(1, m.timescale / divider), 'mdhd timescale');
  writeU32(buf, m.timescaleOffset, newTimescale);

  if (m.durationBytes === 4) {
    const newDuration = checkedU32(m.duration / divider, 'mdhd duration', 0);
    writeU32(buf, m.durationOffset, newDuration);
    return { timescale: newTimescale, duration: newDuration };
  }

  const newDuration = m.duration / BigInt(divider);
  writeU64(buf, m.durationOffset, newDuration);
  return { timescale: newTimescale, duration: newDuration };
}

function adjustChunkOffsets(buf, threshold, delta) {
  if (delta === 0) return;

  for (const stco of findBoxes(buf, 'stco', 0, buf.length)) {
    const entryCount = readU32(buf, stco.contentStart + 4);
    const maxEntries = Math.floor((stco.contentEnd - (stco.contentStart + 8)) / 4);
    for (let i = 0; i < Math.min(entryCount, maxEntries); i++) {
      const offset = stco.contentStart + 8 + i * 4;
      const value = readU32(buf, offset);
      if (value >= threshold) writeU32(buf, offset, checkedU32(value + delta, 'stco chunk offset', 0));
    }
  }

  for (const co64 of findBoxes(buf, 'co64', 0, buf.length)) {
    const entryCount = readU32(buf, co64.contentStart + 4);
    const maxEntries = Math.floor((co64.contentEnd - (co64.contentStart + 8)) / 8);
    for (let i = 0; i < Math.min(entryCount, maxEntries); i++) {
      const offset = co64.contentStart + 8 + i * 8;
      const value = readU64(buf, offset);
      if (value >= BigInt(threshold)) writeU64(buf, offset, value + BigInt(delta));
    }
  }
}

function applyOperations(buf, operations) {
  const sorted = [...operations].sort((a, b) => b.start - a.start);
  let current = buf;

  for (const op of sorted) {
    const replacedLength = op.end - op.start;
    const delta = op.insert.length - replacedLength;
    current = Buffer.concat([
      current.subarray(0, op.start),
      op.insert,
      current.subarray(op.end)
    ]);

    for (const start of [...new Set(op.ancestors)]) {
      const size = readU32(current, start);
      if (size === 1) writeU64(current, start + 8, readU64(current, start + 8) + BigInt(delta));
      else writeU32(current, start, checkedU32(size + delta, `${fourcc(current, start + 4)} box size`, 8));
    }

    adjustChunkOffsets(current, op.start, delta);
  }

  return current;
}

function collectEditListOperations(buf, divider) {
  const operations = [];
  let elstCount = 0;

  for (const moov of findBoxes(buf, 'moov', 0, buf.length)) {
    const mvhd = findChild(buf, moov, 'mvhd');
    if (!mvhd) continue;

    const movie = readMvhd(buf, mvhd);
    const segmentDuration = movie.duration;

    for (const trak of findDirectChildren(buf, moov, 'trak')) {
      const elst = makeEditListBox(segmentDuration, divider);
      const edts = findChild(buf, trak, 'edts');

      if (edts) {
        const existing = findChild(buf, edts, 'elst');
        if (existing) {
          operations.push({
            start: existing.start,
            end: existing.end,
            insert: elst,
            ancestors: [moov.start, trak.start, edts.start]
          });
        } else {
          operations.push({
            start: edts.contentEnd,
            end: edts.contentEnd,
            insert: elst,
            ancestors: [moov.start, trak.start, edts.start]
          });
        }
      } else {
        const tkhd = findChild(buf, trak, 'tkhd');
        const start = tkhd ? tkhd.end : trak.contentStart;
        operations.push({
          start,
          end: start,
          insert: makeBox('edts', elst),
          ancestors: [moov.start, trak.start]
        });
      }

      elstCount++;
    }
  }

  return { operations, elstCount };
}

function collectMetadataOperations(buf, method, divider) {
  const operations = [];

  for (const moov of findBoxes(buf, 'moov', 0, buf.length)) {
    const hint = makeMetadataHintBox(method, divider);
    const udta = findChild(buf, moov, 'udta');

    if (udta) {
      operations.push({
        start: udta.contentEnd,
        end: udta.contentEnd,
        insert: hint,
        ancestors: [moov.start, udta.start]
      });
    } else {
      operations.push({
        start: moov.contentEnd,
        end: moov.contentEnd,
        insert: makeBox('udta', hint),
        ancestors: [moov.start]
      });
    }
  }

  return operations;
}

function patchTimingFields(buf, divider, patchMediaTiming) {
  let mvhdCount = 0;
  let mdhdCount = 0;

  for (const moov of findBoxes(buf, 'moov', 0, buf.length)) {
    const mvhd = findChild(buf, moov, 'mvhd');
    if (mvhd) {
      patchMvhdInPlace(buf, mvhd, divider);
      mvhdCount++;
    }

    if (!patchMediaTiming) continue;

    for (const trak of findDirectChildren(buf, moov, 'trak')) {
      const mdia = findChild(buf, trak, 'mdia');
      const mdhd = mdia && findChild(buf, mdia, 'mdhd');
      if (!mdhd) continue;
      patchMdhdInPlace(buf, mdhd, divider);
      mdhdCount++;
    }
  }

  return { mvhdCount, mdhdCount };
}

// Numeric dividers preserve the old behavior. Object options opt into the local method selector.
function patchMp4Buffer(input, options = 4) {
  const { divider, method } = normalizePatchOptions(options);
  const patchMediaTiming = method !== 'header-lite';
  let buf = Buffer.from(input); // copy so we don't mutate caller's buffer
  const warnings = [];

  const { mvhdCount, mdhdCount } = patchTimingFields(buf, divider, patchMediaTiming);
  if (mvhdCount === 0 || (patchMediaTiming && mdhdCount === 0)) {
    throw new Error('No mvhd/mdhd timing boxes were found to patch.');
  }

  const operations = [];
  let elstCount = 0;
  let metadataCount = 0;

  if (method === 'balanced-sync') {
    const editLists = collectEditListOperations(buf, divider);
    operations.push(...editLists.operations);
    elstCount = editLists.elstCount;
    if (elstCount === 0) warnings.push('No tracks were available for an edit-list speed guard.');
  }

  if (method !== 'classic-force') {
    const metadataOps = collectMetadataOperations(buf, method, divider);
    operations.push(...metadataOps);
    metadataCount = metadataOps.length;
  }

  if (operations.length > 0) buf = applyOperations(buf, operations);

  return {
    buffer: buf,
    bytes: buf,
    method,
    divider,
    warnings,
    mvhdCount,
    mdhdCount,
    elstCount,
    metadataCount
  };
}

module.exports = { METHODS, inspectMp4, patchMp4Buffer };
