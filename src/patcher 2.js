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

// Patch every mvhd + every mdhd by `divider` (timescale and duration both divided).
function patchMp4Buffer(input, divider) {
  if (!Number.isFinite(divider) || divider < 1) {
    throw new Error(`Invalid divider: ${divider}`);
  }
  const buf = Buffer.from(input); // copy so we don't mutate caller's buffer
  const moovs = findBoxes(buf, 'moov', 0, buf.length);
  let mvhdCount = 0;
  let mdhdCount = 0;

  const div = Math.round(divider);

  for (const moov of moovs) {
    const mvhd = findChild(buf, moov, 'mvhd');
    if (mvhd) {
      const m = readMvhd(buf, mvhd);
      const newTs = Math.max(1, Math.floor(m.timescale / div));
      writeU32(buf, m.timescaleOffset, newTs);
      if (m.durationBytes === 4) {
        const newDur = Math.floor(m.duration / div);
        writeU32(buf, m.durationOffset, newDur);
      } else {
        const newDur = m.duration / BigInt(div);
        writeU64(buf, m.durationOffset, newDur);
      }
      mvhdCount++;
    }
    // every trak/mdia/mdhd
    for (const box of walkBoxes(buf, moov.contentStart, moov.contentEnd)) {
      if (box.type !== 'trak') continue;
      const mdia = findChild(buf, box, 'mdia');
      if (!mdia) continue;
      const mdhd = findChild(buf, mdia, 'mdhd');
      if (!mdhd) continue;
      const m = readMdhd(buf, mdhd);
      const newTs = Math.max(1, Math.floor(m.timescale / div));
      writeU32(buf, m.timescaleOffset, newTs);
      if (m.durationBytes === 4) {
        const newDur = Math.floor(m.duration / div);
        writeU32(buf, m.durationOffset, newDur);
      } else {
        const newDur = m.duration / BigInt(div);
        writeU64(buf, m.durationOffset, newDur);
      }
      mdhdCount++;
    }
  }

  return { buffer: buf, mvhdCount, mdhdCount };
}

module.exports = { inspectMp4, patchMp4Buffer };
