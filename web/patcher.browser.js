(() => {
  'use strict';

  const CONTAINER_BOXES = new Set([
    'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'meta', 'dinf', 'moof', 'traf', 'mvex'
  ]);

  function asBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeError('Expected an ArrayBuffer or Uint8Array.');
  }

  function makeView(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  function readU32(view, off) {
    return view.getUint32(off, false);
  }

  function readU64(view, off) {
    const hi = BigInt(view.getUint32(off, false));
    const lo = BigInt(view.getUint32(off + 4, false));
    return (hi << 32n) + lo;
  }

  function writeU32(view, off, value) {
    view.setUint32(off, Math.max(0, Math.min(0xFFFFFFFF, Math.floor(value))) >>> 0, false);
  }

  function writeU64(view, off, value) {
    const big = typeof value === 'bigint' ? value : BigInt(Math.floor(value));
    view.setUint32(off, Number((big >> 32n) & 0xFFFFFFFFn), false);
    view.setUint32(off + 4, Number(big & 0xFFFFFFFFn), false);
  }

  function fourcc(bytes, off) {
    if (off < 0 || off + 4 > bytes.length) return '';
    return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
  }

  function isSaneType(type) {
    return /^[\x20-\x7E]{4}$/.test(type);
  }

  function* walkBoxes(bytes, start = 0, end = bytes.length) {
    const view = makeView(bytes);
    let pos = start;
    while (pos + 8 <= end) {
      const size = readU32(view, pos);
      const type = fourcc(bytes, pos + 4);
      if (!isSaneType(type)) return;

      let headerSize = 8;
      let boxEnd;
      if (size === 1) {
        if (pos + 16 > end) return;
        const largeSize = readU64(view, pos + 8);
        if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return;
        headerSize = 16;
        boxEnd = pos + Number(largeSize);
      } else if (size === 0) {
        boxEnd = end;
      } else {
        boxEnd = pos + size;
      }

      if (boxEnd > end || boxEnd <= pos || pos + headerSize > boxEnd) return;
      yield { type, start: pos, headerSize, contentStart: pos + headerSize, contentEnd: boxEnd, end: boxEnd };
      pos = boxEnd;
    }
  }

  function findBoxes(bytes, type, start = 0, end = bytes.length, results = []) {
    for (const box of walkBoxes(bytes, start, end)) {
      if (box.type === type) results.push(box);
      const childStart = box.type === 'meta' ? box.contentStart + 4 : box.contentStart;
      if (CONTAINER_BOXES.has(box.type) && childStart < box.contentEnd) {
        findBoxes(bytes, type, childStart, box.contentEnd, results);
      }
    }
    return results;
  }

  function findChild(bytes, parent, type) {
    const childStart = parent.type === 'meta' ? parent.contentStart + 4 : parent.contentStart;
    for (const box of walkBoxes(bytes, childStart, parent.contentEnd)) {
      if (box.type === type) return box;
    }
    return null;
  }

  function findDescendant(bytes, parent, types) {
    return types.reduce((current, type) => current ? findChild(bytes, current, type) : null, parent);
  }

  function readMvhd(bytes, box) {
    const view = makeView(bytes);
    const off = box.contentStart;
    const version = bytes[off];
    let p = off + 4;
    if (version === 1) {
      p += 16;
      return {
        version,
        timescale: readU32(view, p),
        duration: readU64(view, p + 4),
        timescaleOffset: p,
        durationOffset: p + 4,
        durationBytes: 8
      };
    }
    p += 8;
    return {
      version,
      timescale: readU32(view, p),
      duration: readU32(view, p + 4),
      timescaleOffset: p,
      durationOffset: p + 4,
      durationBytes: 4
    };
  }

  function readMdhd(bytes, box) {
    const view = makeView(bytes);
    const off = box.contentStart;
    const version = bytes[off];
    let p = off + 4;
    if (version === 1) {
      p += 16;
      return {
        version,
        timescale: readU32(view, p),
        duration: readU64(view, p + 4),
        timescaleOffset: p,
        durationOffset: p + 4,
        durationBytes: 8
      };
    }
    p += 8;
    return {
      version,
      timescale: readU32(view, p),
      duration: readU32(view, p + 4),
      timescaleOffset: p,
      durationOffset: p + 4,
      durationBytes: 4
    };
  }

  function readStts(bytes, box) {
    const view = makeView(bytes);
    const entryCount = readU32(view, box.contentStart + 4);
    const maxEntries = Math.floor((box.contentEnd - (box.contentStart + 8)) / 8);
    const count = Math.min(entryCount, maxEntries);
    const deltas = new Map();
    let totalSamples = 0;
    let weightedDelta = 0;

    for (let i = 0; i < count; i++) {
      const sampleCount = readU32(view, box.contentStart + 8 + i * 8);
      const sampleDelta = readU32(view, box.contentStart + 12 + i * 8);
      totalSamples += sampleCount;
      weightedDelta += sampleCount * sampleDelta;
      deltas.set(sampleDelta, (deltas.get(sampleDelta) || 0) + sampleCount);
    }

    let modeDelta = 0;
    let modeSamples = 0;
    for (const [delta, samples] of deltas.entries()) {
      if (samples > modeSamples) {
        modeDelta = delta;
        modeSamples = samples;
      }
    }

    return {
      entryCount,
      parsedEntries: count,
      totalSamples,
      avgDelta: totalSamples > 0 ? weightedDelta / totalSamples : 0,
      modeDelta
    };
  }

  function findVideoTrack(bytes, moov) {
    const traks = [];
    for (const box of walkBoxes(bytes, moov.contentStart, moov.contentEnd)) {
      if (box.type === 'trak') traks.push(box);
    }
    for (const trak of traks) {
      const mdia = findChild(bytes, trak, 'mdia');
      const hdlr = mdia && findChild(bytes, mdia, 'hdlr');
      if (!hdlr) continue;
      const handlerType = fourcc(bytes, hdlr.contentStart + 8);
      if (handlerType === 'vide') return { trak, mdia };
    }
    return null;
  }

  function readTkhdSize(bytes, tkhd) {
    if (!tkhd || tkhd.contentEnd - tkhd.contentStart < 8) return { width: 0, height: 0 };
    const view = makeView(bytes);
    const widthRaw = readU32(view, tkhd.contentEnd - 8);
    const heightRaw = readU32(view, tkhd.contentEnd - 4);
    return { width: widthRaw / 65536, height: heightRaw / 65536 };
  }

  function roundFps(fps) {
    if (!Number.isFinite(fps) || fps <= 0) return 0;
    return Math.abs(fps - Math.round(fps)) < 0.05 ? Math.round(fps) : Number(fps.toFixed(3));
  }

  function inspectMp4(input) {
    const bytes = asBytes(input);
    const ftyp = findBoxes(bytes, 'ftyp')[0];
    if (!ftyp) return { isMp4: false, error: 'Not an MP4 / ISO BMFF file (no ftyp box).' };

    const major = fourcc(bytes, ftyp.contentStart);
    const moov = findBoxes(bytes, 'moov')[0];
    if (!moov) return { isMp4: true, major, error: 'Missing moov box (file may be incomplete).' };

    const mvhd = findChild(bytes, moov, 'mvhd');
    if (!mvhd) return { isMp4: true, major, error: 'Missing mvhd box.' };

    const mvhdData = readMvhd(bytes, mvhd);
    const videoTrack = findVideoTrack(bytes, moov);
    let fps = 0;
    let rawFps = 0;
    let frameCount = 0;
    let durationSec = 0;
    let videoTimescale = 0;
    let width = 0;
    let height = 0;

    if (videoTrack) {
      const mdhd = findChild(bytes, videoTrack.mdia, 'mdhd');
      if (mdhd) {
        const m = readMdhd(bytes, mdhd);
        videoTimescale = m.timescale;
        const duration = typeof m.duration === 'bigint' ? Number(m.duration) : m.duration;
        durationSec = m.timescale > 0 ? duration / m.timescale : 0;
      }

      const size = readTkhdSize(bytes, findChild(bytes, videoTrack.trak, 'tkhd'));
      width = size.width;
      height = size.height;

      const stts = findDescendant(bytes, videoTrack.trak, ['mdia', 'minf', 'stbl', 'stts']);
      if (stts && videoTimescale > 0) {
        const s = readStts(bytes, stts);
        frameCount = s.totalSamples;
        if (s.modeDelta > 0) rawFps = videoTimescale / s.modeDelta;
        else if (s.avgDelta > 0) rawFps = videoTimescale / s.avgDelta;
        else if (durationSec > 0) rawFps = frameCount / durationSec;
        fps = roundFps(rawFps);
      }
    }

    return {
      isMp4: true,
      major,
      fps,
      rawFps,
      frameCount,
      durationSec,
      width: Math.round(width),
      height: Math.round(height),
      movieTimescale: mvhdData.timescale,
      videoTimescale,
      mvhdCount: findBoxes(bytes, 'mvhd').length,
      mdhdCount: findBoxes(bytes, 'mdhd').length
    };
  }


  function checkedU32(value, label) {
    const integer = Math.floor(value);
    if (!Number.isFinite(integer) || integer < 1 || integer > 0xFFFFFFFF) {
      throw new Error(`${label} would overflow a 32-bit MP4 field.`);
    }
    return integer;
  }

  // Multiply mvhd/mdhd timescale and duration together so playback duration stays stable
  // while stts-derived apparent FPS becomes detected FPS × multiplier.
  function patchMp4Buffer(input, multiplier = 1) {
    if (!Number.isFinite(multiplier) || multiplier < 1) throw new Error(`Invalid multiplier: ${multiplier}`);
    const source = asBytes(input);
    const bytes = new Uint8Array(source.byteLength);
    bytes.set(source);
    const view = makeView(bytes);
    const moovs = findBoxes(bytes, 'moov');
    let mvhdCount = 0;
    let mdhdCount = 0;
    const roundedMultiplier = Math.max(1, Math.round(multiplier));

    for (const moov of moovs) {
      const mvhd = findChild(bytes, moov, 'mvhd');
      if (mvhd) {
        const m = readMvhd(bytes, mvhd);
        writeU32(view, m.timescaleOffset, checkedU32(m.timescale * roundedMultiplier, 'mvhd timescale'));
        if (m.durationBytes === 4) writeU32(view, m.durationOffset, checkedU32(m.duration * roundedMultiplier, 'mvhd duration'));
        else writeU64(view, m.durationOffset, m.duration * BigInt(roundedMultiplier));
        mvhdCount++;
      }

      for (const trak of walkBoxes(bytes, moov.contentStart, moov.contentEnd)) {
        if (trak.type !== 'trak') continue;
        const mdia = findChild(bytes, trak, 'mdia');
        const mdhd = mdia && findChild(bytes, mdia, 'mdhd');
        if (!mdhd) continue;
        const m = readMdhd(bytes, mdhd);
        writeU32(view, m.timescaleOffset, checkedU32(m.timescale * roundedMultiplier, 'mdhd timescale'));
        if (m.durationBytes === 4) writeU32(view, m.durationOffset, checkedU32(m.duration * roundedMultiplier, 'mdhd duration'));
        else writeU64(view, m.durationOffset, m.duration * BigInt(roundedMultiplier));
        mdhdCount++;
      }
    }

    if (mvhdCount === 0 || mdhdCount === 0) throw new Error('No mvhd/mdhd timing boxes were found to patch.');
    return { buffer: bytes.buffer, bytes, mvhdCount, mdhdCount, multiplier: roundedMultiplier };
  }

  window.Upload120Patcher = { inspectMp4, patchMp4Buffer, walkBoxes };
})();
