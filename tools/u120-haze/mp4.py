"""Minimal ISO BMFF reader used by the Haze-layout tool and the validator.

Boxes we treat as containers are the ones whose payload is only child boxes
(plus a 4-byte header on ``meta``). Sample entries inside ``stsd`` stay opaque
so a rewrite can copy them without rebuilding the codec config.
"""

from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass, field

CONTAINERS = {
    b"moov",
    b"trak",
    b"mdia",
    b"minf",
    b"stbl",
    b"edts",
    b"udta",
    b"dinf",
    b"ilst",
    b"mvex",
}

VISUAL_TYPES = {b"avc1", b"avc3", b"hvc1", b"hev1", b"dvh1", b"dvhe"}
AUDIO_TYPES = {b"mp4a"}


class Mp4Error(Exception):
    pass


def u16(buf: bytes, off: int) -> int:
    return struct.unpack_from(">H", buf, off)[0]


def u32(buf: bytes, off: int) -> int:
    return struct.unpack_from(">I", buf, off)[0]


def u64(buf: bytes, off: int) -> int:
    return struct.unpack_from(">Q", buf, off)[0]


def i32(buf: bytes, off: int) -> int:
    return struct.unpack_from(">i", buf, off)[0]


def p16(value: int) -> bytes:
    return struct.pack(">H", value & 0xFFFF)


def p32(value: int) -> bytes:
    return struct.pack(">I", value & 0xFFFFFFFF)


def p64(value: int) -> bytes:
    return struct.pack(">Q", value & 0xFFFFFFFFFFFFFFFF)


@dataclass
class Box:
    typ: bytes
    payload: bytes = b""
    children: list["Box"] = field(default_factory=list)
    container: bool = False
    # ``meta`` stores version/flags here, then child boxes.
    prefix: bytes = b""
    tail: bytes = b""

    def child(self, typ: bytes) -> Box | None:
        for kid in self.children:
            if kid.typ == typ:
                return kid
        return None

    def children_of(self, typ: bytes) -> list[Box]:
        return [kid for kid in self.children if kid.typ == typ]

    def serialize(self) -> bytes:
        if self.container:
            body = self.prefix + b"".join(kid.serialize() for kid in self.children) + self.tail
        else:
            body = self.payload
        size = 8 + len(body)
        if size > 0xFFFFFFFF:
            raise Mp4Error(f"{self.typ!r} needs a 64-bit box size ({size})")
        return p32(size) + self.typ + body


@dataclass
class TopBox:
    typ: bytes
    offset: int
    size: int
    header: int

    @property
    def payload_offset(self) -> int:
        return self.offset + self.header

    @property
    def payload_size(self) -> int:
        return self.size - self.header

    @property
    def end(self) -> int:
        return self.offset + self.size


def _parse_range(data: bytes, start: int, end: int, parent: bytes = b"") -> tuple[list[Box], bytes]:
    boxes: list[Box] = []
    off = start
    while off + 8 <= end:
        size = u32(data, off)
        typ = data[off + 4 : off + 8]
        header = 8
        if size == 1:
            if off + 16 > end:
                raise Mp4Error(f"truncated 64-bit box at {off}")
            size = u64(data, off + 8)
            header = 16
        elif size == 0:
            size = end - off
        if size < header or off + size > end:
            raise Mp4Error(f"bad box {typ!r} size={size} at {off}")
        payload = data[off + header : off + size]
        box = Box(typ=typ)
        # ilst children are tag boxes (©too and friends) whose payload is nested boxes.
        as_container = typ in CONTAINERS or parent == b"ilst"
        if typ == b"meta":
            prefix = payload[:4] if len(payload) >= 4 else b"\x00\x00\x00\x00"
            children, tail = _parse_range(payload, 4, len(payload), typ) if len(payload) > 4 else ([], b"")
            box.container = True
            box.prefix = prefix
            box.children = children
            box.tail = tail
        elif as_container:
            children, tail = _parse_range(payload, 0, len(payload), typ)
            box.container = True
            box.children = children
            box.tail = tail
        else:
            box.payload = payload
        boxes.append(box)
        off += size
    return boxes, data[off:end]


def parse_blob(data: bytes) -> list[Box]:
    boxes, tail = _parse_range(data, 0, len(data))
    if tail:
        raise Mp4Error(f"trailing {len(tail)} bytes after boxes")
    return boxes


def scan_top(path: str) -> list[TopBox]:
    boxes: list[TopBox] = []
    with open(path, "rb") as handle:
        handle.seek(0, 2)
        file_size = handle.tell()
        off = 0
        while off + 8 <= file_size:
            handle.seek(off)
            head = handle.read(16)
            if len(head) < 8:
                break
            size = u32(head, 0)
            typ = head[4:8]
            header = 8
            if size == 1:
                if len(head) < 16:
                    raise Mp4Error("truncated 64-bit top-level box")
                size = u64(head, 8)
                header = 16
            elif size == 0:
                size = file_size - off
            if size < header or off + size > file_size:
                raise Mp4Error(f"bad top-level box {typ!r} size={size} at {off}")
            boxes.append(TopBox(typ=typ, offset=off, size=size, header=header))
            off += size
        if off != file_size:
            raise Mp4Error(f"trailing {file_size - off} bytes after the last top-level box")
    return boxes


def read_span(path: str, offset: int, size: int) -> bytes:
    with open(path, "rb") as handle:
        handle.seek(offset)
        data = handle.read(size)
    if len(data) != size:
        raise Mp4Error(f"short read at {offset}: wanted {size}, got {len(data)}")
    return data


def load_moov(path: str, top: TopBox) -> Box:
    data = read_span(path, top.offset, top.size)
    boxes = parse_blob(data)
    if len(boxes) != 1 or boxes[0].typ != b"moov":
        raise Mp4Error("moov box did not parse")
    return boxes[0]


def fourcc(value: bytes) -> str:
    return value.decode("latin1")


def lang_code(packed: int) -> str:
    chars = bytes((((packed >> 10) & 31) + 0x60, ((packed >> 5) & 31) + 0x60, (packed & 31) + 0x60))
    return chars.decode("latin1")


def handler_kind(trak: Box) -> bytes:
    mdia = trak.child(b"mdia")
    if mdia is None:
        return b""
    hdlr = mdia.child(b"hdlr")
    if hdlr is None or len(hdlr.payload) < 12:
        return b""
    return hdlr.payload[8:12]


def find_stbl(trak: Box) -> Box | None:
    mdia = trak.child(b"mdia")
    if mdia is None:
        return None
    minf = mdia.child(b"minf")
    if minf is None:
        return None
    return minf.child(b"stbl")


@dataclass
class SampleEntryView:
    typ: bytes
    size: int
    compressor: bytes | None
    width: int | None
    height: int | None
    channels: int | None
    sample_rate: int | None
    children: list[tuple[bytes, bytes]]


def iter_sample_entries(stsd_payload: bytes) -> list[SampleEntryView]:
    if len(stsd_payload) < 8:
        return []
    count = u32(stsd_payload, 4)
    entries: list[SampleEntryView] = []
    off = 8
    for _ in range(count):
        if off + 8 > len(stsd_payload):
            break
        size = u32(stsd_payload, off)
        typ = stsd_payload[off + 4 : off + 8]
        if size < 8 or off + size > len(stsd_payload):
            break
        body = stsd_payload[off + 8 : off + size]
        compressor = None
        width = height = channels = sample_rate = None
        child_bytes = b""
        if typ in VISUAL_TYPES and len(body) >= 78:
            width = u16(body, 24)
            height = u16(body, 26)
            compressor = body[42:74]
            child_bytes = body[78:]
        elif typ in AUDIO_TYPES and len(body) >= 28:
            channels = u16(body, 16)
            sample_rate = u32(body, 24) >> 16
            child_bytes = body[28:]
        else:
            child_bytes = b""
        children: list[tuple[bytes, bytes]] = []
        coff = 0
        while coff + 8 <= len(child_bytes):
            csize = u32(child_bytes, coff)
            ctyp = child_bytes[coff + 4 : coff + 8]
            if csize < 8 or coff + csize > len(child_bytes):
                break
            children.append((ctyp, child_bytes[coff + 8 : coff + csize]))
            coff += csize
        entries.append(
            SampleEntryView(
                typ=typ,
                size=size,
                compressor=compressor,
                width=width,
                height=height,
                channels=channels,
                sample_rate=sample_rate,
                children=children,
            )
        )
        off += size
    return entries


def first_sample_type(trak: Box) -> bytes:
    stbl = find_stbl(trak)
    if stbl is None:
        return b""
    stsd = stbl.child(b"stsd")
    if stsd is None:
        return b""
    entries = iter_sample_entries(stsd.payload)
    if not entries:
        return b""
    return entries[0].typ


@dataclass
class Sample:
    index: int  # 1-based
    offset: int
    size: int
    chunk: int
    description: int


def _stsc_entries(payload: bytes) -> list[tuple[int, int, int]]:
    count = u32(payload, 4)
    return [
        (u32(payload, 8 + i * 12), u32(payload, 12 + i * 12), u32(payload, 16 + i * 12))
        for i in range(count)
    ]


def _stsz_sizes(payload: bytes) -> list[int]:
    sample_size = u32(payload, 4)
    count = u32(payload, 8)
    if sample_size:
        return [sample_size] * count
    return [u32(payload, 12 + 4 * i) for i in range(count)]


def _chunk_offsets(stbl: Box) -> tuple[bytes, list[int]]:
    stco = stbl.child(b"stco")
    co64 = stbl.child(b"co64")
    box = stco or co64
    if box is None or len(box.payload) < 8:
        raise Mp4Error("sample table is missing stco/co64")
    count = u32(box.payload, 4)
    if box.typ == b"stco":
        offsets = [u32(box.payload, 8 + 4 * i) for i in range(count)]
    else:
        offsets = [u64(box.payload, 8 + 8 * i) for i in range(count)]
    return box.typ, offsets


def samples_of(stbl: Box) -> list[Sample]:
    stsc = stbl.child(b"stsc")
    stsz = stbl.child(b"stsz")
    if stsc is None or stsz is None or len(stsc.payload) < 8 or len(stsz.payload) < 12:
        raise Mp4Error("sample table is missing stsc/stsz")
    runs = _stsc_entries(stsc.payload)
    sizes = _stsz_sizes(stsz.payload)
    _, offsets = _chunk_offsets(stbl)
    if not runs or not offsets:
        raise Mp4Error("empty chunk table")
    chunk_samples: dict[int, tuple[int, int]] = {}
    for index, (first, per_chunk, desc) in enumerate(runs):
        last = runs[index + 1][0] - 1 if index + 1 < len(runs) else len(offsets)
        for chunk in range(first, last + 1):
            chunk_samples[chunk] = (per_chunk, desc)
    samples: list[Sample] = []
    sample_index = 0
    for chunk, start in enumerate(offsets, start=1):
        if chunk not in chunk_samples:
            raise Mp4Error(f"chunk {chunk} has no stsc entry")
        per_chunk, desc = chunk_samples[chunk]
        cursor = start
        for _ in range(per_chunk):
            if sample_index >= len(sizes):
                raise Mp4Error("stsc walks off the end of stsz")
            size = sizes[sample_index]
            samples.append(
                Sample(
                    index=sample_index + 1,
                    offset=cursor,
                    size=size,
                    chunk=chunk,
                    description=desc,
                )
            )
            cursor += size
            sample_index += 1
    if sample_index != len(sizes):
        raise Mp4Error(f"stsc covered {sample_index} samples, stsz has {len(sizes)}")
    return samples


def hash_samples(path: str, samples: list[Sample]) -> list[str]:
    """SHA-256 of every sample payload, in sample order."""
    digests: list[str] = []
    with open(path, "rb") as handle:
        for sample in samples:
            handle.seek(sample.offset)
            blob = handle.read(sample.size)
            if len(blob) != sample.size:
                raise Mp4Error(f"short sample {sample.index} at {sample.offset}")
            digests.append(hashlib.sha256(blob).hexdigest())
    return digests


def combined_hash(digests: list[str]) -> str:
    hasher = hashlib.sha256()
    for item in digests:
        hasher.update(item.encode("ascii"))
    return hasher.hexdigest()


def parse_ftyp(payload: bytes) -> dict:
    brands = [payload[i : i + 4] for i in range(8, len(payload), 4)]
    return {"major": payload[0:4], "minor": u32(payload, 4), "brands": brands}


def parse_mvhd(payload: bytes) -> dict:
    version = payload[0]
    if version == 0:
        return {
            "version": 0,
            "flags": u32(payload, 0) & 0xFFFFFF,
            "creation": u32(payload, 4),
            "modification": u32(payload, 8),
            "timescale": u32(payload, 12),
            "duration": u32(payload, 16),
            "rate": u32(payload, 20),
            "volume": u16(payload, 24),
            "matrix": [u32(payload, 36 + 4 * i) for i in range(9)],
            "next_track_id": u32(payload, 96) if len(payload) >= 100 else None,
        }
    return {
        "version": 1,
        "flags": u32(payload, 0) & 0xFFFFFF,
        "creation": u64(payload, 4),
        "modification": u64(payload, 12),
        "timescale": u32(payload, 20),
        "duration": u64(payload, 24),
        "rate": u32(payload, 32),
        "volume": u16(payload, 36),
        "matrix": [u32(payload, 48 + 4 * i) for i in range(9)],
        "next_track_id": u32(payload, len(payload) - 4),
    }


def parse_tkhd(payload: bytes) -> dict:
    version = payload[0]
    flags = u32(payload, 0) & 0xFFFFFF
    if version == 0:
        base = 0
        track_id = u32(payload, 12)
        duration = u32(payload, 20)
        layer_at = 32
    else:
        track_id = u32(payload, 20)
        duration = u64(payload, 28)
        layer_at = 44
    return {
        "version": version,
        "flags": flags,
        "creation": u32(payload, 4) if version == 0 else u64(payload, 4),
        "modification": u32(payload, 8) if version == 0 else u64(payload, 12),
        "track_id": track_id,
        "duration": duration,
        "layer": u16(payload, layer_at),
        "alternate_group": u16(payload, layer_at + 2),
        "volume": u16(payload, layer_at + 4),
        "matrix": [u32(payload, layer_at + 8 + 4 * i) for i in range(9)],
        "width": u32(payload, layer_at + 44),
        "height": u32(payload, layer_at + 48),
    }


def parse_mdhd(payload: bytes) -> dict:
    version = payload[0]
    if version == 0:
        timescale = u32(payload, 12)
        duration = u32(payload, 16)
        lang_at = 20
        creation = u32(payload, 4)
        modification = u32(payload, 8)
    else:
        timescale = u32(payload, 20)
        duration = u64(payload, 24)
        lang_at = 32
        creation = u64(payload, 4)
        modification = u64(payload, 12)
    packed = u16(payload, lang_at)
    return {
        "version": version,
        "creation": creation,
        "modification": modification,
        "timescale": timescale,
        "duration": duration,
        "language": lang_code(packed),
        "language_packed": packed,
    }


def parse_elst(payload: bytes) -> list[tuple[int, int, int]]:
    version = payload[0]
    count = u32(payload, 4)
    entries = []
    off = 8
    for _ in range(count):
        if version == 0:
            entries.append((u32(payload, off), i32(payload, off + 4), u32(payload, off + 8)))
            off += 12
        else:
            media = struct.unpack_from(">q", payload, off + 8)[0]
            entries.append((u64(payload, off), media, u32(payload, off + 16)))
            off += 20
    return entries


def parse_hdlr(payload: bytes) -> dict:
    name = payload[24:] if len(payload) > 24 else b""
    return {"type": payload[8:12] if len(payload) >= 12 else b"", "name": name}


def stts_rows(payload: bytes) -> list[tuple[int, int]]:
    count = u32(payload, 4)
    return [(u32(payload, 8 + 8 * i), u32(payload, 12 + 8 * i)) for i in range(count)]


def ctts_rows(payload: bytes) -> list[tuple[int, int]]:
    version = payload[0]
    count = u32(payload, 4)
    rows = []
    for i in range(count):
        samples = u32(payload, 8 + 8 * i)
        if version == 1:
            offset = i32(payload, 12 + 8 * i)
        else:
            offset = u32(payload, 12 + 8 * i)
        rows.append((samples, offset))
    return rows


def stss_samples(payload: bytes) -> list[int]:
    count = u32(payload, 4)
    return [u32(payload, 8 + 4 * i) for i in range(count)]


def sdtp_flags(payload: bytes) -> bytes:
    return payload[4:]


def ilst_tags(udta: Box) -> list[tuple[str, int, str]]:
    """Return (tag, data type, utf-8 text) for each ilst child that has a data box."""
    found: list[tuple[str, int, str]] = []
    metas = udta.children_of(b"meta")
    for meta in metas:
        ilst = meta.child(b"ilst")
        if ilst is None:
            continue
        for item in ilst.children:
            data = item.child(b"data")
            if data is None or len(data.payload) < 8:
                found.append((fourcc(item.typ), -1, ""))
                continue
            kind = u32(data.payload, 0)
            text = data.payload[8:].decode("utf-8", "replace")
            found.append((fourcc(item.typ), kind, text))
    return found


def deep_copy(box: Box) -> Box:
    return Box(
        typ=box.typ,
        payload=box.payload,
        children=[deep_copy(kid) for kid in box.children],
        container=box.container,
        prefix=box.prefix,
        tail=box.tail,
    )


def nal_types(sample: bytes, codec: str) -> list[int]:
    """Length-prefixed NAL types. HEVC uses the 6-bit type; AVC uses the low 5 bits."""
    types: list[int] = []
    off = 0
    while off + 4 <= len(sample):
        length = u32(sample, off)
        if length < 1 or off + 4 + length > len(sample):
            break
        first = sample[off + 4]
        if codec == "hevc":
            types.append((first >> 1) & 0x3F)
        else:
            types.append(first & 0x1F)
        off += 4 + length
    return types
