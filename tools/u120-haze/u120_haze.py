#!/usr/bin/env python3
"""Rebuild an H.264 or HEVC + AAC MP4 so the original file is what gets served.

TikTok's audio ingest fails on the structure below, and the picture is then
served from the file as uploaded. Video sample payloads and the video sample
entry are copied unchanged from whatever H.264 or HEVC input is given.

The default audio structure, matching the served Haze and ShoreUploader files:

- a second AAC track that points at the same samples
- a second ``mp4a`` sample entry on the first audio track, whose
  AudioSpecificConfig is ``11 80 04 c0 40 00 20 00`` (a program-config
  element: one side pair, no front channel)
- 17 silent AAC frames, ``21 10 04 60 8c 1c``, appended after the real
  audio and stored in a second ``mdat``. The last 8 of those frames use
  the second sample entry. The duplicate track keeps every frame on entry 1.

Each of those steps, and the container defaults around them, can be switched
off for a private comparison. The picture is not scaled, retimed, or retagged.
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
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mp4 import (  # noqa: E402
    Box,
    Mp4Error,
    TopBox,
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
    parse_mvhd,
    parse_tkhd,
    read_span,
    samples_of,
    scan_top,
    stts_rows,
    u16,
    u32,
)

ENCODER_TAG = "Upload120 Studio Method https://upload120.com"
HAZE_TAG = "Haze Quality Method https://hazemethod.xyz"
SILENT_FRAME = bytes.fromhex("211004608c1c")
PCE_ASC = bytes.fromhex("118004c040002000")
PADDED_DSI = bytes.fromhex("0580808008") + PCE_ASC
SILENT_COUNT = 17
SDI2_COUNT = 8
PATTERN = SILENT_FRAME * SILENT_COUNT
AUDIO_TIMESCALE = 48000
VIDEO_FLAGS = 7
AUDIO_FLAGS = 1
COPY_CHUNK = 8 * 1024 * 1024
ACCEPTED_VIDEO = {b"avc1", b"avc3", b"hvc1", b"hev1"}


class ShapeError(Mp4Error):
    pass


@dataclass
class Options:
    silent_frames: bool = True
    second_entry: bool = True
    duplicate_audio: bool = True
    track_flags: bool = True
    zero_times: bool = True
    brands: bool = True
    faststart: bool = False
    tag: bool = True
    silent_count: int = SILENT_COUNT
    sdi2_count: int = SDI2_COUNT


def log(message: str) -> None:
    print(message, file=sys.stderr)


def ftyp_bytes() -> bytes:
    body = b"mp42" + p32(0) + b"mp42" + b"mp41"
    return p32(8 + len(body)) + b"ftyp" + body


def _set_u32(buf: bytearray, off: int, value: int) -> None:
    buf[off : off + 4] = p32(value)


def _need_u32(value: int, what: str) -> None:
    if value < 0 or value > 0xFFFFFFFF:
        raise ShapeError(f"{what} does not fit in 32 bits")


def movie_units(media_duration: int, media_timescale: int, movie_timescale: int) -> int:
    if media_timescale <= 0 or movie_timescale <= 0:
        raise ShapeError("timescale is zero")
    return media_duration * movie_timescale // media_timescale


def patch_mvhd(mvhd: Box, duration: int | None, next_track_id: int | None, zero: bool) -> None:
    buf = bytearray(mvhd.payload)
    version = buf[0]
    if version == 0:
        if len(buf) < 100:
            raise ShapeError("mvhd v0 is shorter than 100 bytes")
        if zero:
            _set_u32(buf, 4, 0)
            _set_u32(buf, 8, 0)
        if duration is not None:
            _need_u32(duration, "movie duration")
            _set_u32(buf, 16, duration)
        if next_track_id is not None:
            _set_u32(buf, 96, next_track_id)
    elif version == 1:
        if len(buf) < 32:
            raise ShapeError("mvhd v1 is truncated")
        if zero:
            buf[4:20] = b"\x00" * 16
        if duration is not None:
            buf[24:32] = struct.pack(">Q", duration)
        if next_track_id is not None:
            _set_u32(buf, len(buf) - 4, next_track_id)
    else:
        raise ShapeError(f"mvhd version {version} is not supported")
    mvhd.payload = bytes(buf)


def patch_tkhd(tkhd: Box, flags: int | None, duration: int | None, zero: bool) -> None:
    buf = bytearray(tkhd.payload)
    version = buf[0]
    if flags is not None:
        buf[1:4] = struct.pack(">I", flags)[1:]
    if version == 0:
        if len(buf) < 84:
            raise ShapeError("tkhd v0 is shorter than 84 bytes")
        if zero:
            _set_u32(buf, 4, 0)
            _set_u32(buf, 8, 0)
        if duration is not None:
            _need_u32(duration, "track duration")
            _set_u32(buf, 20, duration)
    elif version == 1:
        if len(buf) < 44:
            raise ShapeError("tkhd v1 is truncated")
        if zero:
            buf[4:20] = b"\x00" * 16
        if duration is not None:
            buf[28:36] = struct.pack(">Q", duration)
    else:
        raise ShapeError(f"tkhd version {version} is not supported")
    tkhd.payload = bytes(buf)


def patch_mdhd(mdhd: Box, duration: int | None, zero: bool) -> None:
    buf = bytearray(mdhd.payload)
    version = buf[0]
    if version == 0:
        if len(buf) < 24:
            raise ShapeError("mdhd v0 is truncated")
        if zero:
            _set_u32(buf, 4, 0)
            _set_u32(buf, 8, 0)
        if duration is not None:
            _need_u32(duration, "media duration")
            _set_u32(buf, 16, duration)
    elif version == 1:
        if len(buf) < 36:
            raise ShapeError("mdhd v1 is truncated")
        if zero:
            buf[4:20] = b"\x00" * 16
        if duration is not None:
            buf[24:32] = struct.pack(">Q", duration)
    else:
        raise ShapeError(f"mdhd version {version} is not supported")
    mdhd.payload = bytes(buf)


def write_elst(segment: int, media_time: int = 0, rate: int = 0x00010000) -> bytes:
    _need_u32(segment, "edit duration")
    return (
        b"\x00\x00\x00\x00"
        + p32(1)
        + p32(segment)
        + struct.pack(">i", media_time)
        + p32(rate)
    )


def first_elst(trak: Box) -> tuple[int, int]:
    """Return ``(media_time, rate)`` of the first edit, or ``(0, 1.0)``."""
    edts = trak.child(b"edts")
    elst = edts.child(b"elst") if edts is not None else None
    if elst is None or len(elst.payload) < 8:
        return 0, 0x00010000
    entries = parse_elst(elst.payload)
    if not entries:
        return 0, 0x00010000
    media_time = entries[0][1]
    if media_time < 0:
        media_time = 0
    return media_time, entries[0][2]


def update_elst(trak: Box, segment: int) -> None:
    """Set the first edit's segment duration. Keep its media time and rate."""
    media_time, rate = first_elst(trak)
    edts = trak.child(b"edts")
    elst = edts.child(b"elst") if edts is not None else None
    if elst is not None and len(elst.payload) >= 20 and elst.payload[0] == 0 and u32(elst.payload, 4) == 1:
        buf = bytearray(elst.payload)
        _set_u32(buf, 8, segment)
        elst.payload = bytes(buf)
        return
    fresh = Box(typ=b"elst", payload=write_elst(segment, media_time, rate))
    if edts is None:
        edts = Box(typ=b"edts", container=True, children=[fresh])
        insert_at = 1
        for index, kid in enumerate(trak.children):
            if kid.typ == b"tkhd":
                insert_at = index + 1
                break
        trak.children.insert(insert_at, edts)
        return
    for index, kid in enumerate(edts.children):
        if kid.typ == b"elst":
            edts.children[index] = fresh
            return
    edts.children.insert(0, fresh)


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
        return [u32(box.payload, 8 + 4 * index) for index in range(count)]
    return [struct.unpack_from(">Q", box.payload, 8 + 8 * index)[0] for index in range(count)]


def map_offsets(offsets: list[int], regions: list[tuple[int, int, int]]) -> list[int]:
    mapped: list[int] = []
    for offset in offsets:
        hit = None
        for old, new, size in regions:
            if size > 0 and old <= offset < old + size:
                hit = new + (offset - old)
                break
        if hit is None:
            raise ShapeError(f"chunk offset {offset} is outside the media data")
        mapped.append(hit)
    return mapped


def read_base_descriptor(data: bytes, off: int) -> tuple[int, bytes, int]:
    if off >= len(data):
        raise ShapeError("truncated descriptor")
    tag = data[off]
    off += 1
    length = 0
    for _ in range(4):
        if off >= len(data):
            raise ShapeError("truncated descriptor length")
        byte = data[off]
        off += 1
        length = (length << 7) | (byte & 0x7F)
        if (byte & 0x80) == 0:
            break
    end = off + length
    if end > len(data):
        raise ShapeError("descriptor overruns its box")
    return tag, data[off:end], end


def _walk_descriptors(data: bytes) -> list[tuple[int, bytes]]:
    items: list[tuple[int, bytes]] = []
    off = 0
    while off + 2 <= len(data):
        try:
            tag, content, off = read_base_descriptor(data, off)
        except ShapeError:
            break
        items.append((tag, content))
    return items


def decoder_fields(esds_payload: bytes) -> dict:
    info = {
        "prefix": b"\x00\x00\x00",
        "object_type": 0x40,
        "stream_byte": 0x15,
        "buffer": b"\x00\x00\x00",
        "max_bitrate": 0,
        "avg_bitrate": 0,
        "dsi": b"",
    }
    if len(esds_payload) < 8:
        return info
    try:
        tag, content, _ = read_base_descriptor(esds_payload[4:], 0)
    except ShapeError:
        return info
    if tag != 0x03 or len(content) < 3:
        return info
    flags = content[2]
    pos = 3
    if flags & 0x80:
        pos += 2
    if flags & 0x40 and pos < len(content):
        pos += 1 + content[pos]
    if flags & 0x20:
        pos += 2
    if pos > len(content):
        pos = 3
    info["prefix"] = content[:pos]
    for dtag, dcontent in _walk_descriptors(content[pos:]):
        if dtag == 0x04 and len(dcontent) >= 13:
            info["object_type"] = dcontent[0]
            info["stream_byte"] = dcontent[1]
            info["buffer"] = bytes(dcontent[2:5])
            info["max_bitrate"] = int.from_bytes(dcontent[5:9], "big")
            info["avg_bitrate"] = int.from_bytes(dcontent[9:13], "big")
            for stag, scontent in _walk_descriptors(dcontent[13:]):
                if stag == 0x05:
                    info["dsi"] = bytes(scontent)
        elif dtag == 0x05:
            info["dsi"] = bytes(dcontent)
    return info


def build_pce_esds(info: dict) -> bytes:
    """Padded ``esds`` payload. DecoderSpecificInfo is exactly ``PCE_ASC``."""
    dsi = bytes([0x05, 0x80, 0x80, 0x80, len(PCE_ASC)]) + PCE_ASC
    dcd_body = bytes([info["object_type"], info["stream_byte"]]) + info["buffer"]
    dcd_body += int(info["max_bitrate"]).to_bytes(4, "big")
    dcd_body += int(info["avg_bitrate"]).to_bytes(4, "big")
    dcd_body += dsi
    if len(dcd_body) > 127:
        raise ShapeError("decoder config does not fit the padded length")
    dcd = bytes([0x04, 0x80, 0x80, 0x80, len(dcd_body)]) + dcd_body
    sl = bytes([0x06, 0x80, 0x80, 0x80, 0x01, 0x02])
    es_body = info["prefix"] + dcd + sl
    if len(es_body) > 127:
        raise ShapeError("ES descriptor does not fit the padded length")
    return b"\x00\x00\x00\x00" + bytes([0x03, 0x80, 0x80, 0x80, len(es_body)]) + es_body


def raw_entries(payload: bytes) -> list[bytes]:
    if len(payload) < 8:
        raise ShapeError("stsd is truncated")
    count = u32(payload, 4)
    off = 8
    entries: list[bytes] = []
    for _ in range(count):
        if off + 8 > len(payload):
            raise ShapeError("stsd entry is truncated")
        size = u32(payload, off)
        if size < 8 or off + size > len(payload):
            raise ShapeError("stsd entry size is invalid")
        entries.append(payload[off : off + size])
        off += size
    return entries


def rebuild_stsd(payload: bytes, entries: list[bytes]) -> bytes:
    return payload[:4] + p32(len(entries)) + b"".join(entries)


def _entry_children(entry: bytes) -> bytes:
    if len(entry) < 8 + 28:
        raise ShapeError("mp4a sample entry is truncated")
    if entry[4:8] != b"mp4a":
        raise ShapeError("audio sample entry is not mp4a")
    return entry[8 + 28 :]


def entry_esds_payload(entry: bytes) -> bytes | None:
    children = _entry_children(entry)
    off = 0
    while off + 8 <= len(children):
        size = u32(children, off)
        if size < 8 or off + size > len(children):
            break
        if children[off + 4 : off + 8] == b"esds":
            return children[off + 8 : off + size]
        off += size
    return None


def entry_dsi(entry: bytes) -> bytes:
    payload = entry_esds_payload(entry)
    if payload is None:
        return b""
    return decoder_fields(payload)["dsi"]


def sample_entry_configs(trak: Box) -> list[bytes]:
    stbl = find_stbl(trak)
    stsd = stbl.child(b"stsd") if stbl is not None else None
    if stsd is None:
        return []
    return [entry_dsi(entry) for entry in raw_entries(stsd.payload)]


def entry_esds_payloads(trak: Box) -> list[bytes]:
    stbl = find_stbl(trak)
    stsd = stbl.child(b"stsd") if stbl is not None else None
    if stsd is None:
        return []
    found: list[bytes] = []
    for entry in raw_entries(stsd.payload):
        payload = entry_esds_payload(entry)
        found.append(payload if payload is not None else b"")
    return found


def second_entry_bytes(first: bytes) -> bytes:
    header = first[8 : 8 + 28]
    esds_payload = entry_esds_payload(first)
    info = decoder_fields(esds_payload) if esds_payload is not None else decoder_fields(b"")
    esds = build_pce_esds(info)
    esds_box = p32(8 + len(esds)) + b"esds" + esds
    body = header + esds_box
    entry = p32(8 + len(body)) + b"mp4a" + body
    if entry_dsi(entry) != PCE_ASC or PADDED_DSI not in esds:
        raise ShapeError("built AudioSpecificConfig is not 11 80 04 c0 40 00 20 00")
    return entry


def ensure_pce_entry(trak: Box) -> str:
    stbl = find_stbl(trak)
    stsd = stbl.child(b"stsd") if stbl is not None else None
    if stsd is None:
        raise ShapeError("audio track is missing stsd")
    entries = raw_entries(stsd.payload)
    if not entries:
        raise ShapeError("audio track has no sample entries")
    if len(entries) >= 2 and entry_dsi(entries[1]) == PCE_ASC and PADDED_DSI in (entry_esds_payload(entries[1]) or b""):
        return "second mp4a already carries the side-pair config"
    fresh = second_entry_bytes(entries[0])
    if len(entries) >= 2:
        entries[1] = fresh
        note = "replaced the second mp4a with the side-pair config"
    else:
        entries.append(fresh)
        note = "added a second mp4a with the side-pair config"
    stsd.payload = rebuild_stsd(stsd.payload, entries[:2])
    return note


def keep_first_entry(trak: Box) -> None:
    stbl = find_stbl(trak)
    stsd = stbl.child(b"stsd") if stbl is not None else None
    if stsd is None:
        raise ShapeError("audio track is missing stsd")
    entries = raw_entries(stsd.payload)
    if len(entries) <= 1:
        return
    stsd.payload = rebuild_stsd(stsd.payload, entries[:1])


def parse_stsc(payload: bytes) -> list[tuple[int, int, int]]:
    count = u32(payload, 4)
    return [
        (u32(payload, 8 + index * 12), u32(payload, 12 + index * 12), u32(payload, 16 + index * 12))
        for index in range(count)
    ]


def write_stsc(rows: list[tuple[int, int, int]]) -> bytes:
    parts = [b"\x00\x00\x00\x00", p32(len(rows))]
    for first, per_chunk, desc in rows:
        parts.append(p32(first))
        parts.append(p32(per_chunk))
        parts.append(p32(desc))
    return b"".join(parts)


def force_sdi(trak: Box, sdi: int) -> None:
    stbl = find_stbl(trak)
    stsc = stbl.child(b"stsc") if stbl is not None else None
    if stsc is None:
        raise ShapeError("audio track is missing stsc")
    rows = parse_stsc(stsc.payload)
    if rows and all(desc == sdi for _, _, desc in rows):
        return
    stsc.payload = write_stsc([(first, per, sdi) for first, per, _ in rows])


def read_sizes(stbl: Box) -> list[int]:
    stsz = stbl.child(b"stsz")
    if stsz is None or len(stsz.payload) < 12:
        raise ShapeError("audio sample table is missing stsz")
    sample_size = u32(stsz.payload, 4)
    count = u32(stsz.payload, 8)
    if sample_size:
        return [sample_size] * count
    if len(stsz.payload) < 12 + 4 * count:
        raise ShapeError("stsz is truncated")
    return [u32(stsz.payload, 12 + 4 * index) for index in range(count)]


def write_stts(rows: list[tuple[int, int]]) -> bytes:
    parts = [b"\x00\x00\x00\x00", p32(len(rows))]
    for count, delta in rows:
        parts.append(p32(count))
        parts.append(p32(delta))
    return b"".join(parts)


def stts_total(stbl: Box) -> int:
    stts = stbl.child(b"stts")
    if stts is None:
        raise ShapeError("sample table is missing stts")
    return sum(count * delta for count, delta in stts_rows(stts.payload))


def extend_groups(stbl: Box, old_count: int, extra: int) -> None:
    for box in stbl.children:
        if box.typ != b"sbgp" or len(box.payload) < 12:
            continue
        buf = bytearray(box.payload)
        base = 12 if buf[0] >= 1 else 8
        if len(buf) < base + 4:
            continue
        count = u32(buf, base)
        need = base + 4 + count * 8
        if count == 0 or len(buf) < need:
            continue
        total = 0
        last_at = 0
        for index in range(count):
            at = base + 4 + index * 8
            total += u32(buf, at)
            last_at = at
        if total != old_count:
            continue
        _set_u32(buf, last_at, u32(buf, last_at) + extra)
        box.payload = bytes(buf)


def silence_plan(total: int, sdi2: int, second_entry: bool) -> list[tuple[int, int]]:
    if total <= 0:
        raise ShapeError("silent frame count must be positive")
    if sdi2 < 0 or sdi2 > total:
        raise ShapeError("the second-entry frame count is outside the silent run")
    first = total - sdi2
    last_sdi = 2 if second_entry and sdi2 else 1
    plan: list[tuple[int, int]] = []
    if first:
        plan.append((first, 1))
    if sdi2:
        plan.append((sdi2, last_sdi))
    if not plan:
        plan.append((total, 1))
    return plan


def append_silent(stbl: Box, plan: list[tuple[int, int]]) -> int:
    """Append the silent frames. New chunk offsets are placeholders, filled later.

    Returns the new media duration in the audio timescale.
    """
    total_new = sum(count for count, _ in plan)
    sizes = read_sizes(stbl)
    old_count = len(sizes)
    sizes.extend([len(SILENT_FRAME)] * total_new)
    stsz = stbl.child(b"stsz")
    if stsz is None:
        raise ShapeError("audio sample table is missing stsz")
    stsz.payload = b"\x00\x00\x00\x00" + p32(0) + p32(len(sizes)) + b"".join(p32(size) for size in sizes)

    stts = stbl.child(b"stts")
    if stts is None:
        raise ShapeError("audio sample table is missing stts")
    rows = stts_rows(stts.payload)
    if rows and rows[-1][1] == 1024:
        rows[-1] = (rows[-1][0] + total_new, 1024)
    else:
        rows.append((total_new, 1024))
    stts.payload = write_stts(rows)

    stsc = stbl.child(b"stsc")
    if stsc is None:
        raise ShapeError("audio sample table is missing stsc")
    runs = parse_stsc(stsc.payload)
    old_chunks = len(chunk_offsets_of(stbl))
    next_chunk = old_chunks + 1
    for per_chunk, desc in plan:
        runs.append((next_chunk, per_chunk, desc))
        next_chunk += 1
    stsc.payload = write_stsc(runs)
    write_offsets(stbl, chunk_offsets_of(stbl) + [0] * len(plan))
    extend_groups(stbl, old_count, total_new)
    return sum(count * delta for count, delta in rows)


def tail_is_silent(path: str, trak: Box, count: int) -> bool:
    stbl = find_stbl(trak)
    if stbl is None:
        return False
    try:
        samples = samples_of(stbl)
    except Mp4Error:
        return False
    if len(samples) < count:
        return False
    for sample in samples[-count:]:
        if sample.size != len(SILENT_FRAME):
            return False
        if read_span(path, sample.offset, sample.size) != SILENT_FRAME:
            return False
    return True


def audio_header(trak: Box) -> tuple[int, int]:
    stbl = find_stbl(trak)
    stsd = stbl.child(b"stsd") if stbl is not None else None
    if stsd is None:
        raise ShapeError("audio track is missing stsd")
    entries = raw_entries(stsd.payload)
    if not entries or entries[0][4:8] != b"mp4a" or len(entries[0]) < 8 + 28:
        raise ShapeError("first audio sample entry is not mp4a")
    body = entries[0][8:]
    channels = u16(body, 16)
    rate = u32(body, 24) >> 16
    return channels, rate


def touch_video(trak: Box, options: Options) -> int:
    """Flags and zeroed times only. Sample tables and the sample entry stay."""
    mdia = trak.child(b"mdia")
    tkhd = trak.child(b"tkhd")
    if mdia is None or tkhd is None:
        raise ShapeError("video track is missing tkhd or mdia")
    mdhd = mdia.child(b"mdhd")
    stbl = find_stbl(trak)
    stsd = stbl.child(b"stsd") if stbl is not None else None
    if mdhd is None or stsd is None:
        raise ShapeError("video track is missing mdhd or stsd")
    before = stsd.payload
    duration = parse_tkhd(tkhd.payload)["duration"]
    patch_tkhd(tkhd, VIDEO_FLAGS if options.track_flags else None, None, options.zero_times)
    patch_mdhd(mdhd, None, options.zero_times)
    if stsd.payload != before:
        raise ShapeError("video sample entry changed")
    return duration


def finish_audio(trak: Box, options: Options, movie_timescale: int) -> int:
    """Set the audio duration from the sample table, including any silent tail."""
    mdia = trak.child(b"mdia")
    tkhd = trak.child(b"tkhd")
    if mdia is None or tkhd is None:
        raise ShapeError("audio track is missing tkhd or mdia")
    mdhd = mdia.child(b"mdhd")
    stbl = find_stbl(trak)
    if mdhd is None or stbl is None:
        raise ShapeError("audio track is missing mdhd or stbl")
    media = parse_mdhd(mdhd.payload)
    media_duration = stts_total(stbl)
    patch_mdhd(mdhd, media_duration, options.zero_times)
    media_time, _rate = first_elst(trak)
    # Priming that the edit already skips stays skipped. The silent frames sit
    # after the real audio, so they fall inside the presented span.
    presented = media_duration - media_time
    if presented < 0:
        presented = media_duration
    duration = movie_units(presented, media["timescale"], movie_timescale)
    patch_tkhd(tkhd, AUDIO_FLAGS if options.track_flags else None, duration, options.zero_times)
    update_elst(trak, duration)
    return duration


def tracks_share_samples(left: Box, right: Box) -> bool:
    left_stbl = find_stbl(left)
    right_stbl = find_stbl(right)
    if left_stbl is None or right_stbl is None:
        return False
    try:
        return chunk_offsets_of(left_stbl) == chunk_offsets_of(right_stbl)
    except ShapeError:
        return False


def reshape_moov(moov: Box, path: str, options: Options, notes: list[str]) -> tuple[list[Box], int, int]:
    """Return tracks, how many silent frames were appended, and how many new chunks."""
    mvhd = moov.child(b"mvhd")
    if mvhd is None:
        raise ShapeError("moov has no mvhd")
    movie_timescale = parse_mvhd(mvhd.payload)["timescale"]
    if movie_timescale <= 0:
        raise ShapeError("movie timescale is zero")

    traks = moov.children_of(b"trak")
    videos = [trak for trak in traks if handler_kind(trak) == b"vide"]
    audios = [trak for trak in traks if handler_kind(trak) == b"soun"]
    others = [trak for trak in traks if trak not in videos and trak not in audios]
    if len(videos) != 1:
        raise ShapeError(f"need exactly one video track, found {len(videos)}")
    video = videos[0]
    if first_sample_type(video) not in ACCEPTED_VIDEO:
        raise ShapeError(f"video sample type {first_sample_type(video)!r} is not H.264 or HEVC")
    aac = [trak for trak in audios if first_sample_type(trak) == b"mp4a"]
    if not aac:
        raise ShapeError("need an AAC audio track")
    primary = aac[0]
    channels, rate = audio_header(primary)
    timescale = parse_mdhd(primary.child(b"mdia").child(b"mdhd").payload)["timescale"]
    if channels != 2 or rate != AUDIO_TIMESCALE or timescale != AUDIO_TIMESCALE:
        raise ShapeError(
            f"audio is {channels} ch at {rate} Hz (mdhd {timescale}); "
            f"the side-pair config and the silent frames are stereo AAC-LC at {AUDIO_TIMESCALE} Hz"
        )

    companions: list[Box] = []
    if len(aac) >= 2 and tracks_share_samples(aac[0], aac[1]):
        companions = [aac[1]]
        notes.append("input already had two AAC tracks on the same samples")
    elif len(audios) > 1:
        notes.append("kept the first AAC track and dropped the other audio tracks")
    if others:
        notes.append(
            "dropped non-av tracks: " + ", ".join(handler_kind(trak).decode("latin1") or "?" for trak in others)
        )

    video_duration = touch_video(video, options)
    appended = 0
    chunks_added = 0
    already = options.silent_frames and tail_is_silent(path, primary, options.silent_count)
    if options.silent_frames and not already:
        primary_plan = silence_plan(options.silent_count, options.sdi2_count, options.second_entry)
        plain_plan = silence_plan(options.silent_count, options.sdi2_count, False)
        append_silent(find_stbl(primary), primary_plan)
        for extra in companions:
            append_silent(find_stbl(extra), plain_plan)
        appended = options.silent_count
        chunks_added = len(primary_plan)
        split = "+".join(str(count) for count, _ in primary_plan)
        last_sdi = primary_plan[-1][1]
        notes.append(
            f"appended {appended} silent AAC frames in chunks of {split}; "
            f"the last chunk uses sample entry {last_sdi}"
        )
    elif options.silent_frames:
        notes.append(f"audio already ends in {options.silent_count} silent frames; left that tail in place")

    if options.second_entry:
        notes.append(ensure_pce_entry(primary))
        for extra in companions:
            keep_first_entry(extra)
            force_sdi(extra, 1)

    if not options.duplicate_audio:
        companions = []
        notes.append("left a single audio track")
    elif not companions:
        clone = deep_copy(primary)
        keep_first_entry(clone)
        force_sdi(clone, 1)
        companions = [clone]
        notes.append("duplicated the AAC track so both tracks share the same samples")

    ordered = [video, primary, *companions]
    for index, trak in enumerate(ordered, start=1):
        set_track_id(trak, index)

    audio_duration = 0
    for trak in ordered[1:]:
        audio_duration = max(audio_duration, finish_audio(trak, options, movie_timescale))

    movie_duration = max(video_duration, audio_duration)
    patch_mvhd(mvhd, movie_duration, len(ordered) + 1, options.zero_times)
    extras = [kid for kid in moov.children if kid.typ not in (b"mvhd", b"trak", b"udta")]
    if options.tag:
        udta = make_udta(ENCODER_TAG)
        notes.append(f"encoder tag: {ENCODER_TAG}")
    else:
        udta = moov.child(b"udta")
        notes.append("kept the existing user-data box")
    children: list[Box] = [mvhd, *ordered, *extras]
    if udta is not None:
        children.append(udta)
    moov.children = children
    moov.container = True
    return ordered, appended, chunks_added


def is_pattern_mdat(path: str, box: TopBox) -> bool:
    if box.typ != b"mdat" or box.payload_size <= 0 or box.payload_size % len(SILENT_FRAME) != 0:
        return False
    if box.payload_size > 4096:
        return False
    blob = read_span(path, box.payload_offset, box.payload_size)
    return blob == SILENT_FRAME * (box.payload_size // len(SILENT_FRAME))


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
        identities.append((kind.decode("latin1"), hash_samples(path, samples_of(stbl))))
    return identities


def _layout(ftyp_len: int, moov_len: int, media_len: int, tiny_len: int, faststart: bool) -> tuple[int, int | None]:
    cursor = ftyp_len + moov_len if faststart else ftyp_len
    media_at = cursor + 8
    cursor = media_at + media_len
    tiny_at = cursor + 8 if tiny_len else None
    return media_at, tiny_at


def convert(input_path: str, output_path: str, options: Options | None = None) -> list[str]:
    options = options or Options()
    if options.silent_count < 1:
        raise ShapeError("silent frame count must be at least 1")
    if options.sdi2_count < 0 or options.sdi2_count > options.silent_count:
        raise ShapeError("sdi2 count must fall inside the silent frames")
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
        signature_boxes = [box for box in tops if box.typ == b"mdat" and is_pattern_mdat(work, box)]
        media = media_boxes[0]
        signature = signature_boxes[0] if signature_boxes else None
        if 8 + media.payload_size > 0xFFFFFFFF:
            raise ShapeError("media data needs a 64-bit mdat size")

        moov = load_moov(work, moov_top)
        source_media = [
            trak
            for trak in moov.children_of(b"trak")
            if handler_kind(trak) in (b"vide", b"soun") and first_sample_type(trak) in ACCEPTED_VIDEO | {b"mp4a"}
        ]
        before = sample_identities(work, source_media)
        ordered, appended, chunks_added = reshape_moov(moov, work, options, notes)

        ftyp = ftyp_bytes() if options.brands else read_span(work, tops[0].offset, tops[0].size)
        tiny = b""
        preserve_signature = False
        if appended:
            tiny = SILENT_FRAME * appended
            notes.append(f"wrote {len(tiny)} bytes of silent frames into a second mdat")
        elif signature is not None and tail_is_silent(work, ordered[1] if len(ordered) > 1 else ordered[0], options.silent_count):
            tiny = read_span(work, signature.payload_offset, signature.payload_size)
            preserve_signature = True
            notes.append("kept the existing silent-frame mdat")

        saved: list[tuple[Box, list[int], int]] = []
        for trak in ordered:
            stbl = find_stbl(trak)
            if stbl is None:
                raise ShapeError("track lost its sample table")
            offsets = chunk_offsets_of(stbl)
            cut = chunks_added if appended and handler_kind(trak) == b"soun" else 0
            if cut > len(offsets):
                raise ShapeError("silent chunks are missing from the chunk table")
            saved.append((stbl, offsets[: len(offsets) - cut] if cut else list(offsets), cut))
        first_span = 0
        if chunks_added == 2:
            # The second new chunk starts after the first silent chunk's frames.
            primary_plan = silence_plan(options.silent_count, options.sdi2_count, options.second_entry)
            first_span = primary_plan[0][0] * len(SILENT_FRAME)

        def apply(media_at: int, tiny_at: int | None) -> None:
            regions = [(media.payload_offset, media_at, media.payload_size)]
            if preserve_signature and signature is not None and tiny_at is not None:
                regions.append((signature.payload_offset, tiny_at, signature.payload_size))
            for stbl, head, cut in saved:
                mapped = map_offsets(head, regions)
                if cut == 2 and tiny_at is not None:
                    mapped.append(tiny_at)
                    mapped.append(tiny_at + first_span)
                elif cut == 1 and tiny_at is not None:
                    mapped.append(tiny_at)
                elif cut:
                    raise ShapeError("silent frames have no mdat to land in")
                write_offsets(stbl, mapped)

        moov_len = 0
        moov_bytes = b""
        for _ in range(6):
            media_at, tiny_at = _layout(len(ftyp), moov_len, media.payload_size, len(tiny), options.faststart)
            apply(media_at, tiny_at)
            moov_bytes = moov.serialize()
            if len(moov_bytes) == moov_len:
                break
            moov_len = len(moov_bytes)
        else:
            media_at, tiny_at = _layout(len(ftyp), moov_len, media.payload_size, len(tiny), options.faststart)
            apply(media_at, tiny_at)
            moov_bytes = moov.serialize()
            if len(moov_bytes) != moov_len:
                raise ShapeError("moov size did not settle")

        if HAZE_TAG.encode("utf-8") in moov_bytes:
            raise ShapeError("refusing to write the Haze encoder tag")
        if options.tag and ENCODER_TAG.encode("utf-8") not in moov_bytes:
            raise ShapeError("encoder tag was not written")

        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        temporary = output_path + ".tmp"
        with open(temporary, "wb") as out:
            out.write(ftyp)
            if options.faststart:
                out.write(moov_bytes)
            out.write(p32(8 + media.payload_size) + b"mdat")
            copy_stream(work, media.payload_offset, media.payload_size, out)
            if tiny:
                out.write(p32(8 + len(tiny)) + b"mdat")
                out.write(tiny)
            if not options.faststart:
                out.write(moov_bytes)
        os.replace(temporary, output_path)

        after_tops = scan_top(output_path)
        after_moov = load_moov(output_path, next(box for box in after_tops if box.typ == b"moov"))
        after = sample_identities(output_path, after_moov.children_of(b"trak"))
        _assert_identity(before, after, appended, options, notes)
        _assert_audio_structure(output_path, after_moov, options)
        notes.append(f"wrote {output_path} ({os.path.getsize(output_path)} bytes)")
        return notes
    finally:
        if temp_dir and os.path.isdir(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)


def _assert_identity(
    before: list[tuple[str, list[str]]],
    after: list[tuple[str, list[str]]],
    appended: int,
    options: Options,
    notes: list[str],
) -> None:
    before_video = [digests for kind, digests in before if kind == "vide"]
    before_audio = [digests for kind, digests in before if kind == "soun"]
    after_video = [digests for kind, digests in after if kind == "vide"]
    after_audio = [digests for kind, digests in after if kind == "soun"]
    if len(before_video) != 1 or len(after_video) != 1 or before_video[0] != after_video[0]:
        raise ShapeError("video sample bytes changed")
    if not before_audio or not after_audio:
        raise ShapeError("identity check lost the audio track")
    expect_audio = 2 if options.duplicate_audio else 1
    if len(after_audio) != expect_audio:
        raise ShapeError(f"expected {expect_audio} audio tracks, found {len(after_audio)}")
    silent_hash = hashlib.sha256(SILENT_FRAME).hexdigest()
    original = before_audio[0]
    for digests in after_audio:
        if digests != after_audio[0]:
            raise ShapeError("audio tracks do not share the same samples")
        if appended == 0:
            if digests != original:
                raise ShapeError("audio sample bytes changed")
            continue
        if digests[: len(original)] != original:
            raise ShapeError("original audio sample bytes changed")
        tail = digests[len(original) :]
        if len(tail) != appended or any(item != silent_hash for item in tail):
            raise ShapeError("the appended audio is not the silent-frame pattern")
    digest = hashlib.sha256()
    for item in after_video[0] + after_audio[0]:
        digest.update(item.encode("ascii"))
    extra = f" plus {appended} silent" if appended else ""
    notes.append(
        f"sample identity ok: {len(after_video[0])} video, "
        f"{len(original)} audio{extra} x{len(after_audio)}, sha256 {digest.hexdigest()[:16]}"
    )


def _assert_audio_structure(path: str, moov: Box, options: Options) -> None:
    """The default mode has to land on the structure the served files share."""
    if not (options.silent_frames and options.second_entry and options.duplicate_audio):
        return
    if options.silent_count != SILENT_COUNT or options.sdi2_count != SDI2_COUNT:
        return
    audios = [trak for trak in moov.children_of(b"trak") if handler_kind(trak) == b"soun"]
    if len(audios) != 2:
        raise ShapeError("default output does not have two audio tracks")
    configs = sample_entry_configs(audios[0])
    payloads = entry_esds_payloads(audios[0])
    if len(configs) != 2 or configs[1] != PCE_ASC or PADDED_DSI not in payloads[1]:
        raise ShapeError("first audio track is missing the padded side-pair sample entry")
    if sample_entry_configs(audios[1]) and len(raw_entries(find_stbl(audios[1]).child(b"stsd").payload)) != 1:
        raise ShapeError("duplicate audio track should keep a single sample entry")
    left = samples_of(find_stbl(audios[0]))
    right = samples_of(find_stbl(audios[1]))
    if [sample.offset for sample in left] != [sample.offset for sample in right]:
        raise ShapeError("audio tracks do not share chunk offsets")
    if [sample.size for sample in left] != [sample.size for sample in right]:
        raise ShapeError("audio tracks do not share sample sizes")
    if len(left) < SILENT_COUNT:
        raise ShapeError("audio track is shorter than the silent tail")
    tail = left[-SILENT_COUNT:]
    early = tail[: SILENT_COUNT - SDI2_COUNT]
    late = tail[SILENT_COUNT - SDI2_COUNT :]
    for sample in tail:
        if sample.size != len(SILENT_FRAME) or read_span(path, sample.offset, sample.size) != SILENT_FRAME:
            raise ShapeError("silent tail bytes are not 21 10 04 60 8c 1c")
    if any(sample.description != 1 for sample in early):
        raise ShapeError("the first silent chunk must use sample entry 1")
    if any(sample.description != 2 for sample in late):
        raise ShapeError("the last 8 silent frames must use sample entry 2")
    if len({sample.chunk for sample in early}) != 1 or len({sample.chunk for sample in late}) != 1:
        raise ShapeError("silent frames are not split into chunks of 9 and 8")
    if early[-1].chunk == late[0].chunk:
        raise ShapeError("the 9-frame and 8-frame silent chunks were merged")
    other_tail = right[-SILENT_COUNT:]
    if any(sample.description != 1 for sample in other_tail):
        raise ShapeError("the duplicate track must keep every silent frame on sample entry 1")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Copy an H.264 or HEVC + AAC MP4 and add the audio structure that "
            "makes the original file the one that gets served. Video samples stay as they are."
        )
    )
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--no-silent-frames", action="store_true", help="do not append the 17 silent AAC frames")
    parser.add_argument("--no-second-entry", action="store_true", help="do not add the side-pair mp4a entry")
    parser.add_argument("--no-duplicate-audio", action="store_true", help="do not add the second audio track")
    parser.add_argument("--keep-flags", action="store_true", help="leave track header flags as the source wrote them")
    parser.add_argument("--keep-times", action="store_true", help="leave creation and modification times as they are")
    parser.add_argument("--keep-ftyp", action="store_true", help="leave the file-type box as the source wrote it")
    parser.add_argument("--faststart", action="store_true", help="put moov before the media data")
    parser.add_argument("--no-tag", action="store_true", help="keep the existing user-data box")
    parser.add_argument("--silent-count", type=int, default=SILENT_COUNT, help="silent frames to append (default 17)")
    parser.add_argument("--sdi2-count", type=int, default=SDI2_COUNT, help="how many of those frames use sample entry 2 (default 8)")
    args = parser.parse_args()
    options = Options(
        silent_frames=not args.no_silent_frames,
        second_entry=not args.no_second_entry,
        duplicate_audio=not args.no_duplicate_audio,
        track_flags=not args.keep_flags,
        zero_times=not args.keep_times,
        brands=not args.keep_ftyp,
        faststart=args.faststart,
        tag=not args.no_tag,
        silent_count=args.silent_count,
        sdi2_count=args.sdi2_count,
    )
    try:
        notes = convert(args.input, args.output, options)
    except (ShapeError, Mp4Error) as exc:
        log(f"error: {exc}")
        return 1
    for note in notes:
        print(note)
    return 0


if __name__ == "__main__":
    sys.exit(main())
