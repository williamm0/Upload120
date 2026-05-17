(() => {
  'use strict';

  const CONTAINER_BOXES = new Set([
    'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'meta', 'dinf', 'moof', 'traf', 'mvex'
  ]);

  const METHODS = Object.freeze([
    {
      id: 'balanced-sync',
      name: 'Balanced Sync',
      description: 'Best first try: timing patch plus a speed guard for steadier desktop preview.'
    },
    {
      id: 'extension-signal',
      name: 'Extension Signal',
      description: 'Adds a neutral edit list and iTunes-style metadata without changing playback speed.'
    },
    {
      id: 'header-lite',
      name: 'Header Lite',
      description: 'Gentle timing patch: changes the movie header only.'
    },
    {
      id: 'classic-force',
      name: 'Classic Force',
      description: 'Old hard patch: original mvhd/mdhd timing behavior.'
    }
  ]);

  const METHOD_IDS = new Set(METHODS.map(method => method.id));
  const METHOD_BEHAVIOR = Object.freeze({
    'balanced-sync': {
      patchMovieTiming: true,
      patchMediaTiming: true,
      editListMode: 'speed',
      localMetadata: true,
      itunesMetadata: false,
      requireTiming: true
    },
    'extension-signal': {
      patchMovieTiming: false,
      patchMediaTiming: false,
      editListMode: 'neutral',
      localMetadata: true,
      itunesMetadata: true,
      requireTiming: false
    },
    'header-lite': {
      patchMovieTiming: true,
      patchMediaTiming: false,
      editListMode: null,
      localMetadata: true,
      itunesMetadata: false,
      requireTiming: true
    },
    'classic-force': {
      patchMovieTiming: true,
      patchMediaTiming: true,
      editListMode: null,
      localMetadata: false,
      itunesMetadata: false,
      requireTiming: true
    }
  });

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

  function writeI16(view, off, value) {
    view.setInt16(off, value, false);
  }

  function writeU16(view, off, value) {
    view.setUint16(off, value, false);
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

  function findDirectChildren(bytes, parent, type) {
    const children = [];
    const childStart = parent.type === 'meta' ? parent.contentStart + 4 : parent.contentStart;
    for (const box of walkBoxes(bytes, childStart, parent.contentEnd)) {
      if (box.type === type) children.push(box);
    }
    return children;
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
      return { divider: Math.max(1, Math.round(options)), method: 'classic-force' };
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
      method
    };
  }

  function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }

  function stringBytes(value) {
    const out = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xFF;
    return out;
  }

  function boxTypeBytes(type) {
    if (typeof type === 'string') return stringBytes(type);
    if (type instanceof Uint8Array && type.byteLength === 4) return type;
    throw new Error('MP4 box type must be a four-character string or four bytes.');
  }

  function makeBox(type, ...parts) {
    const payload = concatBytes(parts);
    const out = new Uint8Array(payload.byteLength + 8);
    const view = makeView(out);
    writeU32(view, 0, out.byteLength);
    out.set(boxTypeBytes(type), 4);
    out.set(payload, 8);
    return out;
  }

  function makeFullBox(type, version, flags, ...parts) {
    const header = new Uint8Array(4);
    header[0] = version & 0xFF;
    header[1] = (flags >> 16) & 0xFF;
    header[2] = (flags >> 8) & 0xFF;
    header[3] = flags & 0xFF;
    return makeBox(type, header, ...parts);
  }

  function makeEditListBox(segmentDuration, divider) {
    const mediaRate = Math.max(1, Math.min(0x7FFF, Math.round(divider)));
    const durationNumber = typeof segmentDuration === 'bigint' ? Number(segmentDuration) : segmentDuration;

    if (typeof segmentDuration === 'bigint' || durationNumber > 0xFFFFFFFF) {
      const payload = new Uint8Array(24);
      const view = makeView(payload);
      writeU32(view, 0, 1);
      writeU64(view, 4, segmentDuration);
      writeU64(view, 12, 0n);
      writeI16(view, 20, mediaRate);
      writeU16(view, 22, 0);
      return makeFullBox('elst', 1, 0, payload);
    }

    const payload = new Uint8Array(16);
    const view = makeView(payload);
    writeU32(view, 0, 1);
    writeU32(view, 4, checkedU32(durationNumber, 'elst segment duration', 0));
    view.setInt32(8, 0, false);
    writeI16(view, 12, mediaRate);
    writeU16(view, 14, 0);
    return makeFullBox('elst', 0, 0, payload);
  }

  function makeMetadataHintBox(method, divider) {
    return makeBox('u120', stringBytes(JSON.stringify({
      tool: 'Upload120',
      method,
      divider,
      local: true
    })));
  }

  function makeDataBoxUtf8(value) {
    const text = new TextEncoder().encode(value);
    const payload = new Uint8Array(8 + text.byteLength);
    const view = makeView(payload);
    writeU32(view, 0, 1);
    writeU32(view, 4, 0);
    payload.set(text, 8);
    return makeBox('data', payload);
  }

  function makeItunesItem(typeBytes, value) {
    return makeBox(typeBytes, makeDataBoxUtf8(value));
  }

  function makeItunesMetadataBox(method, divider) {
    const methodInfo = METHODS.find(item => item.id === method);
    const methodName = methodInfo ? methodInfo.name : method;
    const handlerPayload = new Uint8Array(21);
    handlerPayload.set(stringBytes('mdir'), 4);
    handlerPayload.set(stringBytes('appl'), 8);

    const hdlr = makeFullBox('hdlr', 0, 0, handlerPayload);
    const ilst = makeBox('ilst',
      makeItunesItem(new Uint8Array([0xA9, 0x63, 0x6D, 0x74]), `${methodName} ${divider}x`),
      makeItunesItem(new Uint8Array([0x61, 0x41, 0x52, 0x54]), 'Upload120'),
      makeItunesItem(new Uint8Array([0xA9, 0x41, 0x52, 0x54]), 'Upload120')
    );

    return makeFullBox('meta', 0, 0, hdlr, ilst);
  }

  function patchMvhdInPlace(bytes, mvhd, divider) {
    const view = makeView(bytes);
    const m = readMvhd(bytes, mvhd);
    const newTimescale = checkedU32(Math.max(1, m.timescale / divider), 'mvhd timescale');
    writeU32(view, m.timescaleOffset, newTimescale);

    if (m.durationBytes === 4) {
      const newDuration = checkedU32(m.duration / divider, 'mvhd duration', 0);
      writeU32(view, m.durationOffset, newDuration);
      return { timescale: newTimescale, duration: newDuration };
    }

    const newDuration = m.duration / BigInt(divider);
    writeU64(view, m.durationOffset, newDuration);
    return { timescale: newTimescale, duration: newDuration };
  }

  function patchMdhdInPlace(bytes, mdhd, divider) {
    const view = makeView(bytes);
    const m = readMdhd(bytes, mdhd);
    const newTimescale = checkedU32(Math.max(1, m.timescale / divider), 'mdhd timescale');
    writeU32(view, m.timescaleOffset, newTimescale);

    if (m.durationBytes === 4) {
      const newDuration = checkedU32(m.duration / divider, 'mdhd duration', 0);
      writeU32(view, m.durationOffset, newDuration);
      return { timescale: newTimescale, duration: newDuration };
    }

    const newDuration = m.duration / BigInt(divider);
    writeU64(view, m.durationOffset, newDuration);
    return { timescale: newTimescale, duration: newDuration };
  }

  function adjustChunkOffsets(bytes, threshold, delta) {
    if (delta === 0) return;
    const view = makeView(bytes);

    for (const stco of findBoxes(bytes, 'stco')) {
      const entryCount = readU32(view, stco.contentStart + 4);
      const maxEntries = Math.floor((stco.contentEnd - (stco.contentStart + 8)) / 4);
      for (let i = 0; i < Math.min(entryCount, maxEntries); i++) {
        const offset = stco.contentStart + 8 + i * 4;
        const value = readU32(view, offset);
        if (value >= threshold) writeU32(view, offset, checkedU32(value + delta, 'stco chunk offset', 0));
      }
    }

    for (const co64 of findBoxes(bytes, 'co64')) {
      const entryCount = readU32(view, co64.contentStart + 4);
      const maxEntries = Math.floor((co64.contentEnd - (co64.contentStart + 8)) / 8);
      for (let i = 0; i < Math.min(entryCount, maxEntries); i++) {
        const offset = co64.contentStart + 8 + i * 8;
        const value = readU64(view, offset);
        if (value >= BigInt(threshold)) writeU64(view, offset, value + BigInt(delta));
      }
    }
  }

  function applyOperations(bytes, operations) {
    const sorted = [...operations].sort((a, b) => b.start - a.start);
    let current = bytes;

    for (const op of sorted) {
      const replacedLength = op.end - op.start;
      const delta = op.insert.byteLength - replacedLength;
      current = concatBytes([current.slice(0, op.start), op.insert, current.slice(op.end)]);
      const view = makeView(current);

      for (const start of [...new Set(op.ancestors)]) {
        const size = readU32(view, start);
        if (size === 1) writeU64(view, start + 8, readU64(view, start + 8) + BigInt(delta));
        else writeU32(view, start, checkedU32(size + delta, `${fourcc(current, start + 4)} box size`, 8));
      }

      adjustChunkOffsets(current, op.start, delta);
    }

    return current;
  }

  function collectEditListOperations(bytes, divider) {
    const operations = [];
    let elstCount = 0;

    for (const moov of findBoxes(bytes, 'moov')) {
      const mvhd = findChild(bytes, moov, 'mvhd');
      if (!mvhd) continue;
      const movie = readMvhd(bytes, mvhd);

      for (const trak of findDirectChildren(bytes, moov, 'trak')) {
        const elst = makeEditListBox(movie.duration, divider);
        const edts = findChild(bytes, trak, 'edts');

        if (edts) {
          const existing = findChild(bytes, edts, 'elst');
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
          const tkhd = findChild(bytes, trak, 'tkhd');
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

  function collectMetadataOperations(bytes, method, divider) {
    const operations = [];

    for (const moov of findBoxes(bytes, 'moov')) {
      const hint = makeMetadataHintBox(method, divider);
      const udta = findChild(bytes, moov, 'udta');

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

  function collectItunesMetadataOperations(bytes, method, divider) {
    const operations = [];

    for (const moov of findBoxes(bytes, 'moov')) {
      const meta = makeItunesMetadataBox(method, divider);
      const udta = findChild(bytes, moov, 'udta');

      if (udta) {
        operations.push({
          start: udta.contentEnd,
          end: udta.contentEnd,
          insert: meta,
          ancestors: [moov.start, udta.start]
        });
      } else {
        operations.push({
          start: moov.contentEnd,
          end: moov.contentEnd,
          insert: makeBox('udta', meta),
          ancestors: [moov.start]
        });
      }
    }

    return operations;
  }

  function patchTimingFields(bytes, divider, patchMovieTiming, patchMediaTiming) {
    let mvhdCount = 0;
    let mdhdCount = 0;

    for (const moov of findBoxes(bytes, 'moov')) {
      if (patchMovieTiming) {
        const mvhd = findChild(bytes, moov, 'mvhd');
        if (mvhd) {
          patchMvhdInPlace(bytes, mvhd, divider);
          mvhdCount++;
        }
      }

      if (!patchMediaTiming) continue;

      for (const trak of findDirectChildren(bytes, moov, 'trak')) {
        const mdia = findChild(bytes, trak, 'mdia');
        const mdhd = mdia && findChild(bytes, mdia, 'mdhd');
        if (!mdhd) continue;
        patchMdhdInPlace(bytes, mdhd, divider);
        mdhdCount++;
      }
    }

    return { mvhdCount, mdhdCount };
  }

  // Numeric dividers preserve the old behavior. Object options opt into the local method selector.
  function patchMp4Buffer(input, options = 4) {
    const { divider, method } = normalizePatchOptions(options);
    const source = asBytes(input);
    let bytes = new Uint8Array(source.byteLength);
    bytes.set(source);
    const behavior = METHOD_BEHAVIOR[method];
    const warnings = [];

    const { mvhdCount, mdhdCount } = patchTimingFields(
      bytes,
      divider,
      behavior.patchMovieTiming,
      behavior.patchMediaTiming
    );
    if (behavior.requireTiming && (mvhdCount === 0 || (behavior.patchMediaTiming && mdhdCount === 0))) {
      throw new Error('No mvhd/mdhd timing boxes were found to patch.');
    }

    const operations = [];
    let elstCount = 0;
    let metadataCount = 0;

    if (behavior.editListMode) {
      const editLists = collectEditListOperations(bytes, behavior.editListMode === 'neutral' ? 1 : divider);
      operations.push(...editLists.operations);
      elstCount = editLists.elstCount;
      if (elstCount === 0) warnings.push('No tracks were available for an edit-list signal.');
    }

    if (behavior.localMetadata) {
      const metadataOps = collectMetadataOperations(bytes, method, divider);
      operations.push(...metadataOps);
      metadataCount += metadataOps.length;
    }

    if (behavior.itunesMetadata) {
      const itunesOps = collectItunesMetadataOperations(bytes, method, divider);
      operations.push(...itunesOps);
      metadataCount += itunesOps.length;
    }

    if (!behavior.requireTiming && operations.length === 0) throw new Error('No moov box was found to tag.');

    if (operations.length > 0) bytes = applyOperations(bytes, operations);

    return {
      buffer: bytes.buffer,
      bytes,
      method,
      divider,
      warnings,
      mvhdCount,
      mdhdCount,
      elstCount,
      metadataCount
    };
  }

  window.Upload120Patcher = { METHODS, inspectMp4, patchMp4Buffer, walkBoxes };
})();
