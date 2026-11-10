#!/usr/bin/env python3
"""Rebuild an MP4 container into the layout of the served Haze file.

The picture and audio sample payloads are copied byte for byte. The tool
rewrites the file header, the movie header, track flags, edit lists, the
video timescale, a second AAC track that points at the same samples, a
sample-dependency table, and the encoder tag.

It does not re-encode, and it does not rewrite NAL payloads. Adding access
unit delimiters or changing the VUI would change those sample bytes.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mp4 import (  # noqa: E402
    VISUAL_TYPES,
    Box,
    Mp4Error,
    TopBox,
    ctts_rows,
    deep_copy,
    find_stbl,
    first_sample_type,
    handler_kind,
    hash_samples,
    load_moov,
    p32,
    p64,
    parse_elst,
    parse_mdhd,
    read_span,
    samples_of,
    scan_top,
    stts_rows,
    u32,
)

ENCODER_TAG = "Upload120 Studio Method https://upload120.com"
HAZE_TAG = "Haze Quality Method https://hazemethod.xyz"
PATTERN = bytes.fromhex("211004608c1c") * 17
MVHD_TIMESCALE = 1000
VIDEO_TIMESCALE = 60000
AUDIO_TIMESCALE = 48000
VIDEO_FLAGS = 7
AUDIO_FLAGS = 1
COPY_CHUNK = 8 * 1024 * 1024
ACCEPTED_VIDEO = {b"avc1", b"avc3", b"hvc1", b"hev1"}


class ShapeError(Mp4Error):
    pass


def log(message: str) -> None:
    print(message, file=sys.stderr)


def ftyp_bytes() -> bytes:
    body = b"mp42" + p32(0) + b"mp42" + b"mp41"
    return p32(8 + len(body)) + b"ftyp" + body


def tiny_mdat_bytes() -> bytes:
    return p32(8 + len(PATTERN)) + b"mdat" + PATTERN


def scale_num(value: int, old: int, new: int) -> tuple[int, bool]:
    if old == new or value == 0:
        return value, False
    product = value * new
    if product % old == 0:
        return product // old, False
    return int(round(product / old)), True


def duration_ms(media_duration: int, media_timescale: int) -> int:
    if media_timescale <= 0:
        raise ShapeError("media timescale is zero")
    return media_duration * MVHD_TIMESCALE // media_timescale


def _set_u32(buf: bytearray, off: int, value: int) -> None:
    buf[off : off + 4] = p32(value)


def zero_mvhd(mvhd: Box, duration: int, next_track_id: int) -> None:
    payload = mvhd.payload
    version = payload[0]
    if version == 0:
        if len(payload) < 100:
            raise ShapeError("mvhd v0 is shorter than 100 bytes")
        buf = bytearray(payload)
        _set_u32(buf, 0, 0)
        _set_u32(buf, 4, 0)
        _set_u32(buf, 8, 0)
        _set_u32(buf, 12, MVHD_TIMESCALE)
        _set_u32(buf, 16, duration)
        _set_u32(buf, 96, next_track_id)
        mvhd.payload = bytes(buf)
        return
    if len(payload) < 32:
        raise ShapeError("mvhd v1 is truncated")
    # Rate, volume, matrix, and the pre-defined block follow the duration.
    rest = payload[32:]
    if len(rest) < 68:
        raise ShapeError("mvhd v1 is missing the rate/matrix tail")
    built = bytearray(b"\x00\x00\x00\x00" + b"\x00" * 8 + p32(MVHD_TIMESCALE) + p32(duration) + rest)
    _set_u32(built, len(built) - 4, next_track_id)
    mvhd.payload = bytes(built)


def zero_tkhd(tkhd: Box, flags: int, duration: int) -> None:
    payload = tkhd.payload
    version = payload[0]
    if version == 0:
        if len(payload) < 84:
            raise ShapeError("tkhd v0 is shorter than 84 bytes")
        track_id = u32(payload, 12)
        buf = bytearray(payload)
    else:
        if len(payload) < 44:
            raise ShapeError("tkhd v1 is truncated")
        track_id = u32(payload, 20)
        rest = payload[36:]
        buf = bytearray(
            b"\x00\x00\x00\x00" + b"\x00" * 8 + p32(track_id) + b"\x00" * 4 + p32(0) + rest
        )
    buf[0] = 0
    buf[1:4] = struct.pack(">I", flags)[1:]
    _set_u32(buf, 4, 0)
    _set_u32(buf, 8, 0)
    _set_u32(buf, 12, track_id)
    _set_u32(buf, 16, 0)
    _set_u32(buf, 20, duration)
    # alternate_group sits at byte 34 of a v0 header. The reference file uses 0.
    if len(buf) >= 36:
        buf[34:36] = b"\x00\x00"
    tkhd.payload = bytes(buf)


def write_mdhd(mdhd: Box, timescale: int, duration: int) -> None:
    payload = mdhd.payload
    version = payload[0]
    if version == 0:
        if len(payload) < 24:
            raise ShapeError("mdhd v0 is truncated")
        language = payload[20:24]
    else:
        if len(payload) < 36:
            raise ShapeError("mdhd v1 is truncated")
        language = payload[32:36]
    if duration > 0xFFFFFFFF:
        raise ShapeError("media duration does not fit in a 32-bit mdhd")
    mdhd.payload = b"\x00\x00\x00\x00" + b"\x00" * 8 + p32(timescale) + p32(duration) + language


def write_elst(segment_ms: int) -> bytes:
    return (
        b"\x00\x00\x00\x00"
        + p32(1)
        + p32(segment_ms)
        + struct.pack(">i", 0)
        + p32(0x00010000)
    )


def replace_elst(trak: Box, segment_ms: int) -> None:
    elst = Box(typ=b"elst", payload=write_elst(segment_ms))
    edts = trak.child(b"edts")
    if edts is None:
        edts = Box(typ=b"edts", container=True, children=[elst])
        insert_at = 1
        for index, kid in enumerate(trak.children):
            if kid.typ == b"tkhd":
                insert_at = index + 1
                break
        trak.children.insert(insert_at, edts)
        return
    for index, kid in enumerate(edts.children):
        if kid.typ == b"elst":
            edts.children[index] = elst
            return
    edts.children.insert(0, elst)


def first_elst_media_time(trak: Box) -> int:
    edts = trak.child(b"edts")
    if edts is None:
        return 0
    elst = edts.child(b"elst")
    if elst is None or len(elst.payload) < 8:
        return 0
    entries = parse_elst(elst.payload)
    if not entries:
        return 0
    media_time = entries[0][1]
    if media_time < 0:
        return 0
    return media_time


def scale_stts(stbl: Box, old_ts: int, new_ts: int) -> tuple[int, bool]:
    stts = stbl.child(b"stts")
    if stts is None:
        raise ShapeError("video sample table is missing stts")
    rows = stts_rows(stts.payload)
    inexact = False
    scaled: list[tuple[int, int]] = []
    total = 0
    for count, delta in rows:
        new_delta, drifted = scale_num(delta, old_ts, new_ts)
        inexact = inexact or drifted
        if new_delta <= 0:
            raise ShapeError("scaled stts delta is not positive")
        scaled.append((count, new_delta))
        total += count * new_delta
    parts = [b"\x00\x00\x00\x00", p32(len(scaled))]
    for count, delta in scaled:
        parts.append(p32(count))
        parts.append(p32(delta))
    stts.payload = b"".join(parts)
    return total, inexact


def scale_ctts(stbl: Box, old_ts: int, new_ts: int, shift: int) -> bool:
    """Scale composition offsets and subtract ``shift`` (already in new_ts units).

    ``shift`` is the old edit-list media time. Subtracting it keeps the
    displayed order the same once the new edit list starts at media time 0.
    Offsets may become negative, so the table is written as version 1.
    """
    ctts = stbl.child(b"ctts")
    if ctts is None or (shift == 0 and old_ts == new_ts):
        return False
    rows = ctts_rows(ctts.payload)
    inexact = False
    scaled: list[tuple[int, int]] = []
    for count, offset in rows:
        new_offset, drifted = scale_num(offset, old_ts, new_ts)
        inexact = inexact or drifted
        scaled.append((count, new_offset - shift))
    if any(off < 0 for _, off in scaled):
        parts = [b"\x01\x00\x00\x00", p32(len(scaled))]
        for count, offset in scaled:
            parts.append(p32(count))
            parts.append(struct.pack(">i", offset))
    else:
        parts = [b"\x00\x00\x00\x00", p32(len(scaled))]
        for count, offset in scaled:
            parts.append(p32(count))
            parts.append(p32(offset))
    ctts.payload = b"".join(parts)
    return inexact


def scale_cslg(stbl: Box, old_ts: int, new_ts: int, shift: int) -> None:
    cslg = stbl.child(b"cslg")
    if cslg is None or len(cslg.payload) < 24 or cslg.payload[0] != 0:
        return
    values = [struct.unpack_from(">i", cslg.payload, 4 + 4 * i)[0] for i in range(5)]
    scaled = []
    for index, value in enumerate(values):
        new_value, _ = scale_num(value, old_ts, new_ts)
        # compositionStartTime and compositionEndTime move with the edit.
        if index in (3, 4):
            new_value -= shift
        scaled.append(new_value)
    cslg.payload = b"\x00\x00\x00\x00" + b"".join(struct.pack(">i", value) for value in scaled)


def _strip_hvcc_sei(payload: bytes) -> bytes:
    """Drop prefix/suffix SEI arrays from an hvcC. Parameter sets stay as they are."""
    if len(payload) < 23:
        return payload
    count = payload[22]
    kept: list[bytes] = []
    off = 23
    for _ in range(count):
        if off + 3 > len(payload):
            return payload
        nal_type = payload[off] & 0x3F
        nal_count = int.from_bytes(payload[off + 1 : off + 3], "big")
        start = off
        off += 3
        for _ in range(nal_count):
            if off + 2 > len(payload):
                return payload
            length = int.from_bytes(payload[off : off + 2], "big")
            off += 2 + length
            if off > len(payload):
                return payload
        if nal_type not in (39, 40):
            kept.append(payload[start:off])
    if len(kept) == count:
        return payload
    return payload[:22] + bytes([len(kept)]) + b"".join(kept)


def strip_hvcc_sei(stsd: Box) -> bool:
    payload = stsd.payload
    if len(payload) < 8:
        return False
    count = u32(payload, 4)
    rebuilt = bytearray(payload[:8])
    off = 8
    changed = False
    for _ in range(count):
        if off + 8 > len(payload):
            return False
        size = u32(payload, off)
        if size < 8 or off + size > len(payload):
            return False
        typ = payload[off + 4 : off + 8]
        body = payload[off + 8 : off + size]
        if typ in VISUAL_TYPES and len(body) >= 78:
            children = body[78:]
            new_children = bytearray()
            coff = 0
            while coff + 8 <= len(children):
                csize = u32(children, coff)
                if csize < 8 or coff + csize > len(children):
                    return False
                ctyp = children[coff + 4 : coff + 8]
                cpay = children[coff + 8 : coff + csize]
                if ctyp == b"hvcC":
                    stripped = _strip_hvcc_sei(cpay)
                    if stripped != cpay:
                        changed = True
                        cpay = stripped
                        csize = 8 + len(cpay)
                new_children += p32(csize) + ctyp + cpay
                coff += u32(children, coff)
            if coff < len(children):
                new_children += children[coff:]
            body = body[:78] + bytes(new_children)
            size = 8 + len(body)
        rebuilt += p32(size) + typ + body
        off += u32(payload, off)
    if changed:
        stsd.payload = bytes(rebuilt)
    return changed


def clear_compressor_names(stsd: Box) -> bool:
    payload = bytearray(stsd.payload)
    if len(payload) < 8:
        return False
    count = u32(payload, 4)
    off = 8
    changed = False
    for _ in range(count):
        if off + 8 > len(payload):
            break
        size = u32(payload, off)
        typ = bytes(payload[off + 4 : off + 8])
        if size < 8 or off + size > len(payload):
            break
        if typ in VISUAL_TYPES and size >= 8 + 78:
            name_at = off + 8 + 42
            if payload[name_at : name_at + 32] != b"\x00" * 32:
                payload[name_at : name_at + 32] = b"\x00" * 32
                changed = True
        off += size
    stsd.payload = bytes(payload)
    return changed


def ensure_sdtp(stbl: Box, notes: list[str]) -> None:
    """Write the dependency flags used by the reference file.

    Sync samples are 0x24 and other samples are 0x10 (sample_depends_on = 2
    or 1). Missing stss means every sample is a sync sample. An existing
    table is left alone only when it already has those bytes.
    """
    stsz = stbl.child(b"stsz")
    if stsz is None or len(stsz.payload) < 12:
        return
    count = u32(stsz.payload, 8)
    stss = stbl.child(b"stss")
    if stss is None or len(stss.payload) < 8:
        sync = set(range(1, count + 1))
    else:
        n = u32(stss.payload, 4)
        sync = {u32(stss.payload, 8 + 4 * i) for i in range(n)}
    payload = b"\x00\x00\x00\x00" + bytes(0x24 if (index + 1) in sync else 0x10 for index in range(count))
    existing = stbl.child(b"sdtp")
    if existing is not None and existing.payload == payload:
        notes.append("kept the existing sdtp")
        return
    if existing is not None:
        existing.payload = payload
        notes.append("rewrote sdtp to 0x24 on sync samples and 0x10 on the others")
        return
    stbl.children.append(Box(typ=b"sdtp", payload=payload))
    notes.append("added sdtp (0x24 on sync samples, 0x10 on the others)")


def make_udta(tag: str) -> Box:
    text = tag.encode("utf-8")
    data = Box(typ=b"data", payload=p32(1) + p32(0) + text)
    too = Box(typ=b"\xa9too", container=True, children=[data])
    ilst = Box(typ=b"ilst", container=True, children=[too])
    hdlr = Box(
        typ=b"hdlr",
        payload=b"\x00" * 8 + b"mdir" + b"\x00" * 12 + b"\x00",
    )
    meta = Box(typ=b"meta", container=True, prefix=b"\x00" * 4, children=[hdlr, ilst])
    return Box(typ=b"udta", container=True, children=[meta])


def set_track_id(trak: Box, track_id: int) -> None:
    tkhd = trak.child(b"tkhd")
    if tkhd is None:
        raise ShapeError("track is missing tkhd")
    buf = bytearray(tkhd.payload)
    if buf[0] == 0:
        _set_u32(buf, 12, track_id)
    else:
        _set_u32(buf, 20, track_id)
    tkhd.payload = bytes(buf)


def write_offsets(stbl: Box, offsets: list[int]) -> None:
    if any(offset > 0xFFFFFFFF for offset in offsets):
        payload = b"\x00\x00\x00\x00" + p32(len(offsets)) + b"".join(p64(offset) for offset in offsets)
        typ = b"co64"
    else:
        payload = b"\x00\x00\x00\x00" + p32(len(offsets)) + b"".join(p32(offset) for offset in offsets)
        typ = b"stco"
    replacement = Box(typ=typ, payload=payload)
    replaced = False
    kept: list[Box] = []
    for kid in stbl.children:
        if kid.typ in (b"stco", b"co64"):
            if not replaced:
                kept.append(replacement)
                replaced = True
            continue
        kept.append(kid)
    if not replaced:
        kept.append(replacement)
    stbl.children = kept


def chunk_offsets_of(stbl: Box) -> list[int]:
    box = stbl.child(b"stco") or stbl.child(b"co64")
    if box is None or len(box.payload) < 8:
        raise ShapeError("track is missing stco/co64")
    count = u32(box.payload, 4)
    if box.typ == b"stco":
        return [u32(box.payload, 8 + 4 * i) for i in range(count)]
    return [struct.unpack_from(">Q", box.payload, 8 + 8 * i)[0] for i in range(count)]


def reshape_video(trak: Box, notes: list[str]) -> int:
    mdia = trak.child(b"mdia")
    tkhd = trak.child(b"tkhd")
    if mdia is None or tkhd is None:
        raise ShapeError("video track is missing tkhd or mdia")
    mdhd = mdia.child(b"mdhd")
    stbl = find_stbl(trak)
    if mdhd is None or stbl is None:
        raise ShapeError("video track is missing mdhd or stbl")
    old = parse_mdhd(mdhd.payload)
    old_ts = old["timescale"]
    media_time = first_elst_media_time(trak)
    shift, shift_inexact = scale_num(media_time, old_ts, VIDEO_TIMESCALE)
    total, stts_inexact = scale_stts(stbl, old_ts, VIDEO_TIMESCALE)
    ctts_inexact = scale_ctts(stbl, old_ts, VIDEO_TIMESCALE, shift)
    scale_cslg(stbl, old_ts, VIDEO_TIMESCALE, shift)
    if old_ts != VIDEO_TIMESCALE:
        notes.append(f"scaled video timescale {old_ts} -> {VIDEO_TIMESCALE}")
    if shift:
        notes.append(
            f"set video edit media_time to 0 and subtracted {shift} from composition offsets"
        )
    if stts_inexact or ctts_inexact or shift_inexact:
        notes.append("video timescale conversion was not an exact integer; deltas were rounded")
    write_mdhd(mdhd, VIDEO_TIMESCALE, total)
    movie_ms = duration_ms(total, VIDEO_TIMESCALE)
    zero_tkhd(tkhd, VIDEO_FLAGS, movie_ms)
    replace_elst(trak, movie_ms)
    stsd = stbl.child(b"stsd")
    if stsd is not None and clear_compressor_names(stsd):
        notes.append("cleared the visual sample-entry compressor name")
    if stsd is not None and strip_hvcc_sei(stsd):
        notes.append("removed SEI arrays from hvcC; sample payloads were not edited")
    ensure_sdtp(stbl, notes)
    return movie_ms


def reshape_audio(trak: Box, notes: list[str]) -> int:
    mdia = trak.child(b"mdia")
    tkhd = trak.child(b"tkhd")
    if mdia is None or tkhd is None:
        raise ShapeError("audio track is missing tkhd or mdia")
    mdhd = mdia.child(b"mdhd")
    stbl = find_stbl(trak)
    if mdhd is None or stbl is None:
        raise ShapeError("audio track is missing mdhd or stbl")
    old = parse_mdhd(mdhd.payload)
    timescale = old["timescale"]
    if timescale != AUDIO_TIMESCALE:
        notes.append(
            f"left audio timescale at {timescale}; {AUDIO_TIMESCALE} would require resampling"
        )
    rows = stts_rows(stbl.child(b"stts").payload) if stbl.child(b"stts") else []
    total = sum(count * delta for count, delta in rows) or old["duration"]
    write_mdhd(mdhd, timescale, total)
    movie_ms = duration_ms(total, timescale)
    zero_tkhd(tkhd, AUDIO_FLAGS, movie_ms)
    replace_elst(trak, movie_ms)
    return movie_ms


def tracks_share_samples(left: Box, right: Box) -> bool:
    left_stbl = find_stbl(left)
    right_stbl = find_stbl(right)
    if left_stbl is None or right_stbl is None:
        return False
    try:
        return chunk_offsets_of(left_stbl) == chunk_offsets_of(right_stbl)
    except ShapeError:
        return False


def reshape_moov(moov: Box, notes: list[str]) -> list[Box]:
    mvhd = moov.child(b"mvhd")
    if mvhd is None:
        raise ShapeError("moov has no mvhd")
    traks = moov.children_of(b"trak")
    videos = [trak for trak in traks if handler_kind(trak) == b"vide"]
    audios = [trak for trak in traks if handler_kind(trak) == b"soun"]
    others = [trak for trak in traks if trak not in videos and trak not in audios]
    if len(videos) != 1:
        raise ShapeError(f"need exactly one video track, found {len(videos)}")
    video = videos[0]
    if first_sample_type(video) not in ACCEPTED_VIDEO:
        raise ShapeError(
            f"video sample type {first_sample_type(video)!r} is not H.264 or HEVC"
        )
    aac = [trak for trak in audios if first_sample_type(trak) == b"mp4a"]
    if not aac:
        raise ShapeError("need an AAC audio track")
    kept_audio: list[Box]
    if len(aac) >= 2 and tracks_share_samples(aac[0], aac[1]):
        kept_audio = [aac[0], aac[1]]
        notes.append("input already had two AAC tracks on the same samples")
    else:
        kept_audio = [aac[0]]
        if len(audios) > 1:
            notes.append("kept the first AAC track and dropped the other audio tracks")
    if others:
        notes.append(
            "dropped non-av tracks: " + ", ".join(handler_kind(trak).decode("latin1") or "?" for trak in others)
        )
    video_ms = reshape_video(video, notes)
    audio_ms = 0
    for trak in kept_audio:
        audio_ms = max(audio_ms, reshape_audio(trak, notes))
    if len(kept_audio) == 1:
        clone = deep_copy(kept_audio[0])
        kept_audio.append(clone)
        notes.append("duplicated the AAC track so two tracks share the same samples")

    ordered = [video] + kept_audio
    for index, trak in enumerate(ordered, start=1):
        set_track_id(trak, index)
    movie_ms = max(video_ms, audio_ms)
    zero_mvhd(mvhd, movie_ms, next_track_id=len(ordered) + 1)
    extras = [kid.typ.decode("latin1") for kid in moov.children if kid.typ not in (b"mvhd", b"trak", b"udta")]
    if extras:
        notes.append("dropped extra movie boxes: " + ", ".join(extras))
    moov.children = [mvhd, *ordered, make_udta(ENCODER_TAG)]
    moov.container = True
    moov.tail = b""
    notes.append(f"encoder tag: {ENCODER_TAG}")
    return ordered


def map_offsets(offsets: list[int], regions: list[tuple[int, int, int]]) -> list[int]:
    mapped: list[int] = []
    for offset in offsets:
        hit = None
        for old, new, size in regions:
            if old <= offset < old + size:
                hit = new + (offset - old)
                break
        if hit is None:
            raise ShapeError(f"chunk offset {offset} is outside the media data")
        mapped.append(hit)
    return mapped


def is_pattern_mdat(path: str, box: TopBox) -> bool:
    if box.typ != b"mdat" or box.payload_size != len(PATTERN):
        return False
    return read_span(path, box.payload_offset, box.payload_size) == PATTERN


def needs_normalize(path: str, tops: list[TopBox]) -> str:
    if not tops or tops[0].typ != b"ftyp":
        return "file does not start with ftyp"
    if any(box.typ == b"moof" for box in tops):
        return "fragmented file"
    if any(box.header == 16 for box in tops):
        return "64-bit top-level size"
    moovs = [box for box in tops if box.typ == b"moov"]
    if len(moovs) != 1:
        return f"{len(moovs)} moov boxes"
    if moovs[0].payload_size > 16 * 1024 * 1024:
        return "moov larger than 16 MB"
    media = [box for box in tops if box.typ == b"mdat" and not is_pattern_mdat(path, box)]
    signature = [box for box in tops if box.typ == b"mdat" and is_pattern_mdat(path, box)]
    if len(media) != 1:
        return f"{len(media)} media mdat boxes"
    if len(signature) > 1:
        return "more than one signature mdat"
    return ""


def copy_stream(src: str, offset: int, size: int, out) -> None:
    with open(src, "rb") as handle:
        handle.seek(offset)
        left = size
        while left:
            chunk = handle.read(min(COPY_CHUNK, left))
            if not chunk:
                raise ShapeError("unexpected end of media data")
            out.write(chunk)
            left -= len(chunk)


def remux_copy(src: str, dst: str) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        src,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        dst,
    ]
    log("normalizing container with a stream copy")
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace")
        raise ShapeError(f"stream copy failed:\n{detail}")


def sample_identities(path: str, traks: list[Box]) -> list[tuple[str, list[str]]]:
    identities = []
    for trak in traks:
        kind = handler_kind(trak)
        stbl = find_stbl(trak)
        if stbl is None:
            raise ShapeError("track is missing a sample table")
        digests = hash_samples(path, samples_of(stbl))
        identities.append((kind.decode("latin1"), digests))
    return identities


def convert(input_path: str, output_path: str) -> list[str]:
    notes: list[str] = []
    input_path = os.path.abspath(input_path)
    output_path = os.path.abspath(output_path)
    if not os.path.isfile(input_path):
        raise ShapeError(f"input not found: {input_path}")
    if input_path == output_path:
        raise ShapeError("input and output must be different files")

    work = input_path
    temp_dir = None
    try:
        tops = scan_top(work)
        reason = needs_normalize(work, tops)
        if reason:
            temp_dir = tempfile.mkdtemp(prefix="u120-haze-")
            normalized = os.path.join(temp_dir, "normalized.mp4")
            remux_copy(work, normalized)
            notes.append(f"stream-copied first because: {reason}")
            work = normalized
            tops = scan_top(work)
            again = needs_normalize(work, tops)
            if again:
                raise ShapeError(f"container is still unusable after the stream copy: {again}")
        else:
            notes.append("source container can be rebuilt directly")

        moov_top = next(box for box in tops if box.typ == b"moov")
        media_boxes = [box for box in tops if box.typ == b"mdat" and not is_pattern_mdat(work, box)]
        signature = [box for box in tops if box.typ == b"mdat" and is_pattern_mdat(work, box)]
        media = media_boxes[0]
        if 8 + media.payload_size > 0xFFFFFFFF:
            raise ShapeError("media data needs a 64-bit mdat size")

        moov = load_moov(work, moov_top)
        source_media = [
            trak
            for trak in moov.children_of(b"trak")
            if handler_kind(trak) in (b"vide", b"soun") and first_sample_type(trak) in ACCEPTED_VIDEO | {b"mp4a"}
        ]
        before = sample_identities(work, source_media)
        # Identity is checked against the file we actually copy samples from.
        # A stream copy is still the same coded samples; the validator repeats
        # the check against the caller's original path when that path is a
        # plain MP4.
        ordered = reshape_moov(moov, notes)

        new_media_at = 32  # ftyp 24 + mdat header 8
        new_signature_at = 32 + media.payload_size + 8
        regions = [(media.payload_offset, new_media_at, media.payload_size)]
        if signature:
            regions.append(
                (signature[0].payload_offset, new_signature_at, signature[0].payload_size)
            )
            notes.append("source already stored the 102-byte mdat; sample pointers into it were kept")
        else:
            notes.append("wrote the 102-byte mdat before moov")

        for trak in ordered:
            stbl = find_stbl(trak)
            if stbl is None:
                raise ShapeError("track lost its sample table")
            write_offsets(stbl, map_offsets(chunk_offsets_of(stbl), regions))

        moov_bytes = moov.serialize()
        if HAZE_TAG.encode("utf-8") in moov_bytes:
            raise ShapeError("refusing to write the Haze encoder tag")
        if ENCODER_TAG.encode("utf-8") not in moov_bytes:
            raise ShapeError("encoder tag was not written")

        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        temporary = output_path + ".tmp"
        with open(temporary, "wb") as out:
            out.write(ftyp_bytes())
            out.write(p32(8 + media.payload_size) + b"mdat")
            copy_stream(work, media.payload_offset, media.payload_size, out)
            out.write(tiny_mdat_bytes())
            out.write(moov_bytes)
        os.replace(temporary, output_path)

        after_tops = scan_top(output_path)
        after_moov = load_moov(output_path, next(box for box in after_tops if box.typ == b"moov"))
        after = sample_identities(output_path, after_moov.children_of(b"trak"))
        _assert_identity(before, after, notes)
        notes.append(f"wrote {output_path} ({os.path.getsize(output_path)} bytes)")
        return notes
    finally:
        if temp_dir and os.path.isdir(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)


def _assert_identity(before: list[tuple[str, list[str]]], after: list[tuple[str, list[str]]], notes: list[str]) -> None:
    before_video = [digests for kind, digests in before if kind == "vide"]
    before_audio = [digests for kind, digests in before if kind == "soun"]
    after_video = [digests for kind, digests in after if kind == "vide"]
    after_audio = [digests for kind, digests in after if kind == "soun"]
    if len(before_video) != 1 or len(after_video) != 1:
        raise ShapeError("identity check lost the video track")
    if before_video[0] != after_video[0]:
        raise ShapeError("video sample bytes changed")
    if not before_audio or len(after_audio) != 2:
        raise ShapeError("identity check lost the audio pair")
    if before_audio[0] != after_audio[0] or before_audio[0] != after_audio[1]:
        raise ShapeError("audio sample bytes changed")
    # The two output audio tracks must be the same digests, which means the
    # shared sample bytes survived. Hash the list once more so a partial
    # write cannot pass on length alone.
    digest = hashlib.sha256()
    for item in after_video[0] + after_audio[0]:
        digest.update(item.encode("ascii"))
    notes.append(
        f"sample identity ok: {len(after_video[0])} video, {len(after_audio[0])} audio x2, sha256 {digest.hexdigest()[:16]}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Rebuild an H.264 or HEVC + AAC MP4 into the served Haze container layout. Samples are copied."
    )
    parser.add_argument("input")
    parser.add_argument("output")
    args = parser.parse_args()
    try:
        notes = convert(args.input, args.output)
    except (ShapeError, Mp4Error) as exc:
        log(f"error: {exc}")
        return 1
    for note in notes:
        print(note)
    return 0


if __name__ == "__main__":
    sys.exit(main())
