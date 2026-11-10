#!/usr/bin/env python3
"""Compare a rebuilt file with the served Haze reference and with its input.

Prints an atom-by-atom path diff, a track-by-track field diff, and a SHA-256
of every sample. Sample hashes are the proof that picture and audio bytes
were copied. Layout checks cover the container rules; codec and NAL
differences are reported separately because they are properties of the
bitstream.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mp4 import (  # noqa: E402
    Box,
    Mp4Error,
    TopBox,
    combined_hash,
    find_stbl,
    first_sample_type,
    fourcc,
    handler_kind,
    hash_samples,
    ilst_tags,
    iter_sample_entries,
    load_moov,
    nal_types,
    parse_elst,
    parse_ftyp,
    parse_hdlr,
    parse_mdhd,
    parse_mvhd,
    parse_tkhd,
    read_span,
    samples_of,
    scan_top,
    sdtp_flags,
    stss_samples,
    stts_rows,
    u32,
)
from u120_haze import (  # noqa: E402
    AUDIO_TIMESCALE,
    ENCODER_TAG,
    HAZE_TAG,
    PADDED_DSI,
    PATTERN,
    PCE_ASC,
    SDI2_COUNT,
    SILENT_COUNT,
    SILENT_FRAME,
    entry_esds_payloads,
    sample_entry_configs,
)

HDR_TRANSFER = {"smpte2084", "arib-std-b67", "smpte428", "smpte428_1"}
HDR_PRIMARIES = {"bt2020"}
HDR_MATRIX = {"bt2020nc", "bt2020c"}
IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]


class Report:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.failures: list[str] = []

    def add(self, text: str = "") -> None:
        self.lines.append(text)

    def fail(self, text: str) -> None:
        self.failures.append(text)
        self.add(f"FAIL  {text}")

    def ok(self, text: str) -> None:
        self.add(f"ok    {text}")

    def text(self) -> str:
        verdict = "PASS" if not self.failures else f"FAIL ({len(self.failures)})"
        body = "\n".join(self.lines)
        return f"verdict: {verdict}\n\n{body}\n"


def _label(typ: bytes, index: int, total: int) -> str:
    name = fourcc(typ)
    if total > 1:
        return f"{name}[{index}]"
    return name


def atom_paths(box: Box, prefix: str = "") -> list[str]:
    path = box.typ.decode("latin1") if not prefix else prefix
    found = [path]
    if box.typ == b"stsd":
        entries = iter_sample_entries(box.payload)
        totals: Counter[bytes] = Counter(entry.typ for entry in entries)
        seen: Counter[bytes] = Counter()
        for entry in entries:
            seen[entry.typ] += 1
            epath = f"{path}/{_label(entry.typ, seen[entry.typ] - 1, totals[entry.typ])}"
            found.append(epath)
            child_totals: Counter[bytes] = Counter(typ for typ, _ in entry.children)
            child_seen: Counter[bytes] = Counter()
            for typ, _payload in entry.children:
                child_seen[typ] += 1
                found.append(f"{epath}/{_label(typ, child_seen[typ] - 1, child_totals[typ])}")
        return found
    totals = Counter(kid.typ for kid in box.children)
    seen = Counter()
    for kid in box.children:
        seen[kid.typ] += 1
        found.extend(atom_paths(kid, f"{path}/{_label(kid.typ, seen[kid.typ] - 1, totals[kid.typ])}"))
    return found


def tree_lines(box: Box, indent: int = 0) -> list[str]:
    lines = []
    size = len(box.serialize())
    lines.append(f"{'  ' * indent}{fourcc(box.typ)} {size}")
    if box.typ == b"stsd":
        for entry in iter_sample_entries(box.payload):
            lines.append(f"{'  ' * (indent + 1)}{fourcc(entry.typ)} {entry.size}")
            for typ, payload in entry.children:
                lines.append(f"{'  ' * (indent + 2)}{fourcc(typ)} {8 + len(payload)}")
        return lines
    for kid in box.children:
        lines.extend(tree_lines(kid, indent + 1))
    return lines


def top_summary(path: str) -> tuple[list[TopBox], list[str]]:
    tops = scan_top(path)
    lines = []
    for box in tops:
        extra = ""
        if box.typ == b"ftyp":
            info = parse_ftyp(read_span(path, box.payload_offset, box.payload_size))
            brands = ",".join(fourcc(brand) for brand in info["brands"])
            extra = f" major={fourcc(info['major'])} minor={info['minor']} brands={brands}"
        elif box.typ == b"mdat":
            extra = f" payload={box.payload_size}"
            if box.payload_size == len(PATTERN):
                blob = read_span(path, box.payload_offset, box.payload_size)
                extra += " pattern-match" if blob == PATTERN else " not-the-pattern"
        lines.append(f"  {fourcc(box.typ)} off={box.offset} size={box.size}{extra}")
    return tops, lines


def _track_rows(moov: Box) -> list[Box]:
    return moov.children_of(b"trak")


def _fmt(value) -> str:
    if isinstance(value, bytes):
        text = value.decode("latin1", "replace")
    elif isinstance(value, list):
        text = ",".join(str(item) for item in value)
    else:
        text = str(value)
    return "".join(ch if 32 <= ord(ch) < 127 else f"\\x{ord(ch):02x}" for ch in text)


def field_table(rows: list[tuple[str, object, object, str]]) -> list[str]:
    lines = [f"  {'field':<28} {'output':<24} {'reference':<24} note"]
    for name, left, right, note in rows:
        lines.append(f"  {name:<28} {_fmt(left):<24} {_fmt(right):<24} {note}")
    return lines


def same(left, right) -> str:
    return "MATCH" if left == right else "DIFF"


def content(left, right) -> str:
    return "MATCH" if left == right else "content"


def hvcc_summary(payload: bytes) -> str:
    if len(payload) < 23:
        return f"short:{len(payload)}"
    profile = payload[1] & 0x1F
    tier = "high" if (payload[1] >> 5) & 1 else "main"
    level = payload[12]
    chroma = payload[16] & 0x3
    depth = (payload[17] & 0x7) + 8
    arrays = payload[22]
    return f"profile={profile} tier={tier} level={level} chroma={chroma} bitdepth={depth} arrays={arrays} bytes={len(payload)}"


def avcc_summary(payload: bytes) -> str:
    if len(payload) < 4:
        return f"short:{len(payload)}"
    return f"profile={payload[1]} compat={payload[2]} level={payload[3]} bytes={len(payload)}"


def colr_summary(payload: bytes) -> str:
    if len(payload) < 4:
        return payload.hex()
    kind = payload[0:4]
    if kind == b"nclx" and len(payload) >= 10:
        pri = int.from_bytes(payload[4:6], "big")
        trc = int.from_bytes(payload[6:8], "big")
        matrix = int.from_bytes(payload[8:10], "big")
        return f"nclx pri={pri} trc={trc} mtx={matrix}"
    return f"{fourcc(kind)} {payload[4:].hex()}"


def entry_child(trak: Box, atom: bytes) -> bytes | None:
    stbl = find_stbl(trak)
    if stbl is None or stbl.child(b"stsd") is None:
        return None
    for entry in iter_sample_entries(stbl.child(b"stsd").payload):
        for typ, payload in entry.children:
            if typ == atom:
                return payload
    return None


def sdtp_matches(stbl: Box) -> tuple[bool, str]:
    sdtp = stbl.child(b"sdtp")
    if sdtp is None:
        return False, "missing"
    flags = sdtp_flags(sdtp.payload)
    stsz = stbl.child(b"stsz")
    count = u32(stsz.payload, 8) if stsz is not None and len(stsz.payload) >= 12 else 0
    if len(flags) != count:
        return False, f"length {len(flags)} != sample count {count}"
    stss = stbl.child(b"stss")
    sync = set(stss_samples(stss.payload)) if stss is not None else set(range(1, count + 1))
    bad = 0
    for index, flag in enumerate(flags):
        expect = 0x24 if (index + 1) in sync else 0x10
        if flag != expect:
            bad += 1
    if bad:
        return False, f"{bad} samples do not use 0x24/0x10"
    return True, f"{len(flags)} bytes, 0x24 x {sum(1 for f in flags if f == 0x24)}, 0x10 x {sum(1 for f in flags if f == 0x10)}"


def probe(path: str) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise Mp4Error(result.stderr.strip() or "ffprobe failed")
    return json.loads(result.stdout)


def color_of(stream: dict) -> str:
    return "/".join(
        [
            str(stream.get("color_primaries") or "-"),
            str(stream.get("color_transfer") or "-"),
            str(stream.get("color_space") or "-"),
            str(stream.get("color_range") or "-"),
        ]
    )


def is_hdr(stream: dict) -> bool:
    return (
        stream.get("color_transfer") in HDR_TRANSFER
        or stream.get("color_primaries") in HDR_PRIMARIES
        or stream.get("color_space") in HDR_MATRIX
    )


def video_stream(info: dict) -> dict:
    for stream in info.get("streams", []):
        if stream.get("codec_type") == "video":
            return stream
    return {}


def nal_histogram(path: str, trak: Box) -> Counter:
    codec = "hevc" if first_sample_type(trak) in (b"hvc1", b"hev1", b"dvh1", b"dvhe") else "avc"
    counts: Counter = Counter()
    stbl = find_stbl(trak)
    if stbl is None:
        return counts
    samples = samples_of(stbl)
    with open(path, "rb") as handle:
        for sample in samples:
            handle.seek(sample.offset)
            blob = handle.read(sample.size)
            for nal in nal_types(blob, codec):
                counts[nal] += 1
    return counts


def samples_in_mdats(path: str, tops: list[TopBox], samples) -> Counter:
    mdats = [box for box in tops if box.typ == b"mdat"]
    counts: Counter = Counter()
    for sample in samples:
        placed = False
        for index, box in enumerate(mdats):
            if box.payload_offset <= sample.offset and sample.offset + sample.size <= box.end:
                counts[index] += 1
                placed = True
                break
        if not placed:
            counts["outside"] += 1
    return counts


def layout_checks(path: str, moov: Box, tops: list[TopBox], report: Report) -> None:
    report.add("== layout checks ==")
    types = [box.typ for box in tops]
    if types == [b"ftyp", b"mdat", b"mdat", b"moov"]:
        report.ok("top-level order is ftyp, mdat, mdat, moov")
    else:
        report.fail(f"top-level order is {[fourcc(t) for t in types]}")
    ftyp = next(box for box in tops if box.typ == b"ftyp")
    info = parse_ftyp(read_span(path, ftyp.payload_offset, ftyp.payload_size))
    brands = info["brands"]
    if info["major"] == b"mp42" and info["minor"] == 0 and brands[:2] == [b"mp42", b"mp41"]:
        report.ok("ftyp mp42 minor 0, compatible mp42, mp41")
    else:
        report.fail(f"ftyp major={info['major']!r} minor={info['minor']} brands={brands!r}")
    mdats = [box for box in tops if box.typ == b"mdat"]
    if len(mdats) < 2:
        report.fail("there is no second mdat")
        return
    signature = mdats[1]
    blob = read_span(path, signature.payload_offset, signature.payload_size)
    if blob == PATTERN:
        report.ok("second mdat is 21 10 04 60 8c 1c repeated 17 times")
    else:
        report.fail(f"second mdat payload is {blob[:16].hex()} ({len(blob)} bytes)")

    mvhd = parse_mvhd(moov.child(b"mvhd").payload)
    if mvhd["creation"] == 0 and mvhd["modification"] == 0:
        report.ok(f"mvhd time fields are zero (timescale {mvhd['timescale']} left as the source wrote it)")
    else:
        report.fail(f"mvhd creation={mvhd['creation']} modification={mvhd['modification']}")
    traks = _track_rows(moov)
    videos = [trak for trak in traks if handler_kind(trak) == b"vide"]
    audios = [trak for trak in traks if handler_kind(trak) == b"soun"]
    if len(videos) == 1 and len(audios) == 2 and len(traks) == 3:
        report.ok("one video track and two audio tracks")
    else:
        report.fail(f"track counts video={len(videos)} audio={len(audios)} total={len(traks)}")
    if mvhd["next_track_id"] == len(traks) + 1:
        report.ok(f"next_track_id is {mvhd['next_track_id']}")
    else:
        report.fail(f"next_track_id is {mvhd['next_track_id']}")

    if not videos or len(audios) < 2:
        return
    video = videos[0]
    vtkhd = parse_tkhd(video.child(b"tkhd").payload)
    vmdhd = parse_mdhd(video.child(b"mdia").child(b"mdhd").payload)
    if vtkhd["flags"] == 7 and vtkhd["creation"] == 0 and vtkhd["modification"] == 0:
        report.ok(f"video tkhd flags=7, times zero (alternate_group {vtkhd['alternate_group']} left as the source wrote it)")
    else:
        report.fail(f"video tkhd flags={vtkhd['flags']} times={vtkhd['creation']}/{vtkhd['modification']}")
    if vmdhd["creation"] == 0 and vmdhd["modification"] == 0:
        report.ok(f"video mdhd times zero (timescale {vmdhd['timescale']} left as the source wrote it)")
    else:
        report.fail(f"video mdhd times={vmdhd['creation']}/{vmdhd['modification']}")
    vstbl = find_stbl(video)
    _good, detail = sdtp_matches(vstbl)
    report.add(f"  video sdtp (kept from the source, not required): {detail}")

    offsets = []
    sizes = []
    for index, audio in enumerate(audios, start=1):
        tkhd = parse_tkhd(audio.child(b"tkhd").payload)
        mdhd = parse_mdhd(audio.child(b"mdia").child(b"mdhd").payload)
        elst_box = audio.child(b"edts").child(b"elst") if audio.child(b"edts") else None
        elst = parse_elst(elst_box.payload) if elst_box is not None else []
        if tkhd["flags"] == 1 and tkhd["creation"] == 0 and tkhd["modification"] == 0:
            report.ok(f"audio {index} tkhd flags=1, times zero (alternate_group {tkhd['alternate_group']})")
        else:
            report.fail(f"audio {index} tkhd flags={tkhd['flags']} times={tkhd['creation']}/{tkhd['modification']}")
        if mdhd["timescale"] == AUDIO_TIMESCALE and mdhd["creation"] == 0 and mdhd["modification"] == 0:
            report.ok(f"audio {index} mdhd timescale 48000, times zero, duration {mdhd['duration']}")
        else:
            report.fail(f"audio {index} mdhd timescale={mdhd['timescale']} times={mdhd['creation']}/{mdhd['modification']}")
        if elst:
            report.add(f"  audio {index} elst segment={elst[0][0]} media_time={elst[0][1]} rate={elst[0][2]}")
        else:
            report.fail(f"audio {index} has no edit list")
        if tkhd["duration"] < vtkhd["duration"]:
            report.fail(f"audio {index} duration {tkhd['duration']} is shorter than the video {vtkhd['duration']}")
        stbl = find_stbl(audio)
        offsets.append([sample.offset for sample in samples_of(stbl)])
        sizes.append([sample.size for sample in samples_of(stbl)])
    if offsets[0] == offsets[1] and sizes[0] == sizes[1]:
        report.ok(f"the two audio tracks share {len(offsets[0])} sample offsets and sizes")
    else:
        report.fail("the two audio tracks do not share sample offsets and sizes")
    if mvhd["duration"] == max(parse_tkhd(audio.child(b"tkhd").payload)["duration"] for audio in audios):
        report.ok(f"movie duration {mvhd['duration']} follows the audio")
    else:
        report.fail(f"movie duration {mvhd['duration']} does not follow the audio")

    tags = ilst_tags(moov.child(b"udta")) if moov.child(b"udta") else []
    if tags == [("©too", 1, ENCODER_TAG)]:
        report.ok(f"only udta tag is ©too = {ENCODER_TAG}")
    else:
        report.fail(f"udta tags are {tags}")
    moov_top = next(box for box in tops if box.typ == b"moov")
    moov_bytes = read_span(path, moov_top.offset, moov_top.size)
    if HAZE_TAG.encode("utf-8") in moov_bytes:
        report.fail("moov still contains the Haze encoder tag")
    else:
        report.ok("moov does not contain the Haze encoder tag")


def _silent_groups(samples: list) -> tuple[list, list]:
    tail = samples[-SILENT_COUNT:]
    early = tail[: SILENT_COUNT - SDI2_COUNT]
    late = tail[SILENT_COUNT - SDI2_COUNT :]
    return early, late


def audio_structure(path: str, moov: Box, tops: list[TopBox], report: Report) -> None:
    """The structure shared by the served Haze and ShoreUploader files."""
    report.add("")
    report.add("== audio structure ==")
    audios = [trak for trak in moov.children_of(b"trak") if handler_kind(trak) == b"soun"]
    if len(audios) != 2:
        report.fail(f"need two audio tracks, found {len(audios)}")
        return
    configs = sample_entry_configs(audios[0])
    payloads = entry_esds_payloads(audios[0])
    if len(configs) == 2 and configs[1] == PCE_ASC and payloads[1] and PADDED_DSI in payloads[1]:
        report.ok("first audio track has a second mp4a whose AudioSpecificConfig is 11 80 04 c0 40 00 20 00")
    else:
        shown = configs[1].hex() if len(configs) > 1 else "missing"
        report.fail(f"first audio track second config is {shown}")
    second_count = len(sample_entry_configs(audios[1]))
    if second_count == 1:
        report.ok("duplicate audio track has one mp4a sample entry")
    else:
        report.fail(f"duplicate audio track has {second_count} sample entries")

    left = samples_of(find_stbl(audios[0]))
    right = samples_of(find_stbl(audios[1]))
    if len(left) < SILENT_COUNT or len(right) < SILENT_COUNT:
        report.fail("audio track is shorter than 17 frames")
        return
    early, late = _silent_groups(left)
    other_early, other_late = _silent_groups(right)
    frames_ok = True
    for sample in left[-SILENT_COUNT:]:
        if sample.size != len(SILENT_FRAME) or read_span(path, sample.offset, sample.size) != SILENT_FRAME:
            frames_ok = False
            break
    if frames_ok and [sample.size for sample in right[-SILENT_COUNT:]] == [len(SILENT_FRAME)] * SILENT_COUNT:
        report.ok("last 17 audio samples are 21 10 04 60 8c 1c")
    else:
        report.fail("last 17 audio samples are not the silent frame")
    mdats = [box for box in tops if box.typ == b"mdat"]
    if len(mdats) >= 2:
        second = mdats[1]
        inside = all(
            second.payload_offset <= sample.offset and sample.offset + sample.size <= second.end
            for sample in left[-SILENT_COUNT:]
        )
        if inside:
            report.ok("those 17 frames sit in the second mdat")
        else:
            report.fail("the silent frames are not inside the second mdat")
    split_ok = (
        len({sample.chunk for sample in early}) == 1
        and len({sample.chunk for sample in late}) == 1
        and early[-1].chunk != late[0].chunk
        and all(sample.description == 1 for sample in early)
        and all(sample.description == 2 for sample in late)
    )
    if split_ok:
        report.ok("first audio track: silent chunk of 9 on entry 1, then 8 on entry 2")
    else:
        report.fail(
            "silent chunk split is "
            f"{[sample.description for sample in early]} / {[sample.description for sample in late]}"
        )
    other_ok = all(sample.description == 1 for sample in other_early + other_late)
    if other_ok and [sample.chunk for sample in right[-SILENT_COUNT:]] == [sample.chunk for sample in left[-SILENT_COUNT:]]:
        report.ok("duplicate track shares those chunks and keeps every frame on entry 1")
    else:
        report.fail("duplicate track does not keep the silent frames on entry 1")
    if len(left) > SILENT_COUNT and left[-SILENT_COUNT - 1].chunk == early[0].chunk:
        report.fail("the silent run was merged into the last real audio chunk")
    else:
        report.ok("the silent run starts in its own chunk")


def sample_identity(input_path: str, output_path: str, out_moov: Box, report: Report) -> None:
    report.add("")
    report.add("== sample identity vs input ==")
    in_tops = scan_top(input_path)
    in_moov = load_moov(input_path, next(box for box in in_tops if box.typ == b"moov"))
    in_video = next(trak for trak in in_moov.children_of(b"trak") if handler_kind(trak) == b"vide")
    in_audio = next(trak for trak in in_moov.children_of(b"trak") if handler_kind(trak) == b"soun" and first_sample_type(trak) == b"mp4a")
    out_video = next(trak for trak in out_moov.children_of(b"trak") if handler_kind(trak) == b"vide")
    out_audios = [trak for trak in out_moov.children_of(b"trak") if handler_kind(trak) == b"soun"]

    in_vs = samples_of(find_stbl(in_video))
    out_vs = samples_of(find_stbl(out_video))
    in_vh = hash_samples(input_path, in_vs)
    out_vh = hash_samples(output_path, out_vs)
    if in_vh == out_vh and [s.size for s in in_vs] == [s.size for s in out_vs]:
        report.ok(
            f"video samples {len(out_vh)}/{len(out_vh)} match  combined {combined_hash(out_vh)}"
        )
    else:
        mismatch = [i for i, (a, b) in enumerate(zip(in_vh, out_vh), start=1) if a != b]
        report.fail(
            f"video sample hash mismatch count={len(in_vh)} vs {len(out_vh)} first={mismatch[:8]}"
        )

    in_as = samples_of(find_stbl(in_audio))
    in_ah = hash_samples(input_path, in_as)
    silent_hash = hashlib.sha256(SILENT_FRAME).hexdigest()
    for index, audio in enumerate(out_audios, start=1):
        samples = samples_of(find_stbl(audio))
        digests = hash_samples(output_path, samples)
        sizes = [sample.size for sample in samples]
        exact = digests == in_ah and sizes == [sample.size for sample in in_as]
        extended = (
            len(digests) == len(in_ah) + SILENT_COUNT
            and digests[: len(in_ah)] == in_ah
            and sizes[: len(in_as)] == [sample.size for sample in in_as]
            and all(item == silent_hash for item in digests[-SILENT_COUNT:])
        )
        if exact:
            report.ok(
                f"audio track {index} samples {len(digests)}/{len(digests)} match input  combined {combined_hash(digests)}"
            )
        elif extended:
            report.ok(
                f"audio track {index} keeps {len(in_ah)} input samples and adds {SILENT_COUNT} silent frames  "
                f"combined {combined_hash(digests)}"
            )
        else:
            mismatch = [i for i, (a, b) in enumerate(zip(in_ah, digests), start=1) if a != b]
            report.fail(
                f"audio track {index} hash mismatch count={len(digests)} vs input {len(in_ah)} first={mismatch[:8]}"
            )
    if len(out_audios) == 2:
        left = [sample.offset for sample in samples_of(find_stbl(out_audios[0]))]
        right = [sample.offset for sample in samples_of(find_stbl(out_audios[1]))]
        if left == right:
            report.ok("output audio tracks point at the same file offsets")
        else:
            report.fail("output audio tracks point at different file offsets")


def changed_fields(input_path: str, output_path: str, report: Report) -> None:
    report.add("")
    report.add("== what the container change did (input -> output) ==")
    in_tops, in_lines = top_summary(input_path)
    out_tops, out_lines = top_summary(output_path)
    report.add("input top level:")
    report.lines.extend(in_lines)
    report.add("output top level:")
    report.lines.extend(out_lines)
    in_moov = load_moov(input_path, next(box for box in in_tops if box.typ == b"moov"))
    out_moov = load_moov(output_path, next(box for box in out_tops if box.typ == b"moov"))
    report.add("input moov atoms:")
    report.lines.extend(tree_lines(in_moov, 1))
    report.add("output moov atoms:")
    report.lines.extend(tree_lines(out_moov, 1))
    report.add(f"input udta: {ilst_tags(in_moov.child(b'udta')) if in_moov.child(b'udta') else []}")
    report.add(f"output udta: {ilst_tags(out_moov.child(b'udta')) if out_moov.child(b'udta') else []}")
    in_paths = set(atom_paths(in_moov))
    out_paths = set(atom_paths(out_moov))
    report.add("atoms removed from the input moov:")
    removed = sorted(in_paths - out_paths)
    report.lines.extend([f"  - {item}" for item in removed] or ["  (none)"])
    report.add("atoms added:")
    added = sorted(out_paths - in_paths)
    report.lines.extend([f"  + {item}" for item in added] or ["  (none)"])


def reference_section(output_path: str, reference_path: str, out_moov: Box, out_tops: list[TopBox], report: Report) -> None:
    report.add("")
    report.add("== atom-by-atom diff vs Haze reference ==")
    ref_tops, ref_lines = top_summary(reference_path)
    out_lines_top = top_summary(output_path)[1]
    report.add("output:")
    report.lines.extend(out_lines_top)
    report.add("reference:")
    report.lines.extend(ref_lines)
    ref_moov = load_moov(reference_path, next(box for box in ref_tops if box.typ == b"moov"))
    out_paths = atom_paths(out_moov)
    ref_paths = atom_paths(ref_moov)
    report.add("atoms only in the output:")
    only_out = sorted(set(out_paths) - set(ref_paths))
    report.lines.extend([f"  + {item}" for item in only_out] or ["  (none)"])
    report.add("atoms only in the reference:")
    only_ref = sorted(set(ref_paths) - set(out_paths))
    report.lines.extend([f"  - {item}" for item in only_ref] or ["  (none)"])
    report.add("shared atom paths: " + str(len(set(out_paths) & set(ref_paths))))
    out_tags = ilst_tags(out_moov.child(b"udta")) if out_moov.child(b"udta") else []
    ref_tags = ilst_tags(ref_moov.child(b"udta")) if ref_moov.child(b"udta") else []
    report.add(f"output udta: {out_tags}")
    report.add(f"reference udta: {ref_tags}")
    report.add("the tag text is replaced on purpose; the reference string is not written")

    report.add("")
    report.add("output moov tree:")
    report.lines.extend(tree_lines(out_moov, 1))
    report.add("reference moov tree:")
    report.lines.extend(tree_lines(ref_moov, 1))

    report.add("")
    report.add("== track-by-track diff vs Haze reference ==")
    out_traks = _track_rows(out_moov)
    ref_traks = _track_rows(ref_moov)
    count = max(len(out_traks), len(ref_traks))
    for index in range(count):
        report.add(f"-- track slot {index + 1} --")
        if index >= len(out_traks) or index >= len(ref_traks):
            report.add("  one side has no track in this slot")
            continue
        left = out_traks[index]
        right = ref_traks[index]
        rows = track_rows(output_path, reference_path, left, right, out_tops, ref_tops)
        report.lines.extend(field_table(rows))

    report.add("")
    report.add("== bitstream diff vs Haze reference ==")
    out_video = next(trak for trak in out_traks if handler_kind(trak) == b"vide")
    ref_video = next(trak for trak in ref_traks if handler_kind(trak) == b"vide")
    out_hist = nal_histogram(output_path, out_video)
    ref_hist = nal_histogram(reference_path, ref_video)
    report.add(f"  output NAL types: {sorted(out_hist.items())}")
    report.add(f"  reference NAL types: {sorted(ref_hist.items())}")
    out_probe = probe(output_path)
    ref_probe = probe(reference_path)
    ov = video_stream(out_probe)
    rv = video_stream(ref_probe)
    report.add(f"  output ffprobe: {ov.get('codec_name')} {ov.get('profile')} {ov.get('width')}x{ov.get('height')} {ov.get('pix_fmt')} {color_of(ov)} bframes={ov.get('has_b_frames')}")
    report.add(f"  reference ffprobe: {rv.get('codec_name')} {rv.get('profile')} {rv.get('width')}x{rv.get('height')} {rv.get('pix_fmt')} {color_of(rv)} bframes={rv.get('has_b_frames')}")
    report.add("")
    report.add("== bitstream differences, not part of the audio structure ==")
    report.add("  The served file is the original upload once audio ingest fails.")
    report.add("  Codec, resolution, color, GOP, and handler text are properties of the source.")
    if out_hist != ref_hist:
        report.add(f"  - NAL mix differs. Reference histogram {dict(sorted(ref_hist.items()))}.")
    if 35 in ref_hist and 35 not in out_hist:
        report.add("  - Reference HEVC samples each start with an access-unit delimiter (NAL 35). The output does not, because that unit is inside the sample.")
    if (39 in ref_hist or 40 in ref_hist) != (39 in out_hist or 40 in out_hist):
        report.add("  - SEI inside the samples differs. The reference samples have none. Adding or removing those units rewrites the sample.")
    if (6 in out_hist) != (6 in ref_hist):
        report.add("  - AVC SEI (NAL 6) differs. It is inside the sample, so it stays with the copied bytes.")
    if ov.get("codec_name") != rv.get("codec_name"):
        report.add(f"  - Codec is {ov.get('codec_name')} here and {rv.get('codec_name')} in the reference.")
    if color_of(ov) != color_of(rv):
        report.add(f"  - Color signaling is {color_of(ov)} here and {color_of(rv)} in the reference. The reference values are in the HEVC VUI, which lives in the SPS bytes.")
    if (ov.get("has_b_frames") or 0) != (rv.get("has_b_frames") or 0):
        report.add("  - B-frame structure differs, so composition-offset tables differ. Removing B-frames re-encodes the picture.")
    out_handler = parse_hdlr(out_video.child(b"mdia").child(b"hdlr").payload)["name"]
    ref_handler = parse_hdlr(ref_video.child(b"mdia").child(b"hdlr").payload)["name"]
    if out_handler != ref_handler:
        report.add(f"  - Video handler name is {out_handler!r} here and {ref_handler!r} in the reference (Mainconcept / Premiere).")
    ref_audios = [trak for trak in ref_traks if handler_kind(trak) == b"soun"]
    if ref_audios:
        ref_configs = sample_entry_configs(ref_audios[0])
        out_audio = next(trak for trak in out_traks if handler_kind(trak) == b"soun")
        out_configs = sample_entry_configs(out_audio)
        same_asc = len(ref_configs) > 1 and len(out_configs) > 1 and ref_configs[1] == out_configs[1] == PCE_ASC
        report.add(
            "  audio config matches the reference"
            if same_asc
            else f"  audio config output={ [item.hex() for item in out_configs] } reference={ [item.hex() for item in ref_configs] }"
        )
    out_audio_samples = samples_of(find_stbl([t for t in out_traks if handler_kind(t) == b"soun"][0]))
    ref_audio_samples = samples_of(find_stbl(ref_audios[0])) if ref_audios else []
    out_member = samples_in_mdats(output_path, out_tops, out_audio_samples)
    ref_member = samples_in_mdats(reference_path, ref_tops, ref_audio_samples) if ref_audios else {}
    report.add(f"  output audio samples by mdat index: {dict(out_member)}")
    report.add(f"  reference audio samples by mdat index: {dict(ref_member)}")
    if ref_audios:
        ref_tail = ref_audio_samples[-SILENT_COUNT:]
        out_tail = out_audio_samples[-SILENT_COUNT:]
        ref_bytes = all(sample.size == 6 and read_span(reference_path, sample.offset, 6) == SILENT_FRAME for sample in ref_tail)
        out_bytes = all(sample.size == 6 and read_span(output_path, sample.offset, 6) == SILENT_FRAME for sample in out_tail)
        ref_sdi = [sample.description for sample in ref_tail[-SDI2_COUNT:]]
        out_sdi = [sample.description for sample in out_tail[-SDI2_COUNT:]]
        if ref_bytes and out_bytes and ref_sdi == out_sdi == [2] * SDI2_COUNT:
            report.add("  silent tail matches the reference: 17 frames, last 8 on sample entry 2")
        else:
            report.add(f"  silent tail output sdi={out_sdi} reference sdi={ref_sdi}")


def track_rows(out_path: str, ref_path: str, left: Box, right: Box, out_tops: list[TopBox], ref_tops: list[TopBox]) -> list[tuple[str, object, object, str]]:
    del out_path, ref_path
    rows: list[tuple[str, object, object, str]] = []
    lk = handler_kind(left)
    rk = handler_kind(right)
    rows.append(("handler", fourcc(lk), fourcc(rk), same(lk, rk)))
    ltk = parse_tkhd(left.child(b"tkhd").payload)
    rtk = parse_tkhd(right.child(b"tkhd").payload)
    for key in ("flags", "creation", "modification", "alternate_group", "volume", "matrix"):
        note = same(ltk[key], rtk[key])
        if key in ("duration",):
            note = content(ltk[key], rtk[key])
        rows.append((f"tkhd.{key}", ltk[key], rtk[key], note))
    rows.append(("tkhd.duration", ltk["duration"], rtk["duration"], content(ltk["duration"], rtk["duration"])))
    rows.append(("tkhd.width", ltk["width"] / 65536, rtk["width"] / 65536, content(ltk["width"], rtk["width"])))
    rows.append(("tkhd.height", ltk["height"] / 65536, rtk["height"] / 65536, content(ltk["height"], rtk["height"])))
    lmd = parse_mdhd(left.child(b"mdia").child(b"mdhd").payload)
    rmd = parse_mdhd(right.child(b"mdia").child(b"mdhd").payload)
    for key in ("creation", "modification", "timescale", "language"):
        note = same(lmd[key], rmd[key]) if key != "language" else content(lmd[key], rmd[key])
        if key == "timescale":
            note = same(lmd[key], rmd[key])
        rows.append((f"mdhd.{key}", lmd[key], rmd[key], note))
    rows.append(("mdhd.duration", lmd["duration"], rmd["duration"], content(lmd["duration"], rmd["duration"])))
    lel = parse_elst(left.child(b"edts").child(b"elst").payload)
    rel = parse_elst(right.child(b"edts").child(b"elst").payload)
    rows.append(("elst.count", len(lel), len(rel), same(len(lel), len(rel))))
    if lel and rel:
        rows.append(("elst.media_time", lel[0][1], rel[0][1], same(lel[0][1], rel[0][1])))
        rows.append(("elst.rate", hex(lel[0][2]), hex(rel[0][2]), same(lel[0][2], rel[0][2])))
        rows.append(("elst.segment", lel[0][0], rel[0][0], content(lel[0][0], rel[0][0])))
    lhdl = parse_hdlr(left.child(b"mdia").child(b"hdlr").payload)
    rhdl = parse_hdlr(right.child(b"mdia").child(b"hdlr").payload)
    rows.append(("hdlr.name", lhdl["name"], rhdl["name"], content(lhdl["name"], rhdl["name"])))
    lst = find_stbl(left)
    rst = find_stbl(right)
    ltypes = [fourcc(entry.typ) for entry in iter_sample_entries(lst.child(b"stsd").payload)]
    rtypes = [fourcc(entry.typ) for entry in iter_sample_entries(rst.child(b"stsd").payload)]
    rows.append(("stsd.entries", " ".join(ltypes), " ".join(rtypes), content(ltypes, rtypes)))
    lcomp = next((entry.compressor for entry in iter_sample_entries(lst.child(b"stsd").payload) if entry.compressor is not None), None)
    rcomp = next((entry.compressor for entry in iter_sample_entries(rst.child(b"stsd").payload) if entry.compressor is not None), None)
    if lcomp is not None or rcomp is not None:
        rows.append(("compressor", (lcomp or b"").split(b"\x00")[0], (rcomp or b"").split(b"\x00")[0], content(lcomp, rcomp)))
    for atom, summary in ((b"hvcC", hvcc_summary), (b"avcC", avcc_summary), (b"colr", colr_summary)):
        lb = entry_child(left, atom)
        rb = entry_child(right, atom)
        if lb is None and rb is None:
            continue
        rows.append((fourcc(atom), summary(lb) if lb else "-", summary(rb) if rb else "-", content(lb, rb)))
    lrows = stts_rows(lst.child(b"stts").payload) if lst.child(b"stts") else []
    rrows = stts_rows(rst.child(b"stts").payload) if rst.child(b"stts") else []
    rows.append(("stts", f"{len(lrows)} rows first={lrows[:1]}", f"{len(rrows)} rows first={rrows[:1]}", content(lrows, rrows)))
    rows.append(("ctts", "yes" if lst.child(b"ctts") else "no", "yes" if rst.child(b"ctts") else "no", content(lst.child(b"ctts") is not None, rst.child(b"ctts") is not None)))
    rows.append(("sdtp", "yes" if lst.child(b"sdtp") else "no", "yes" if rst.child(b"sdtp") else "no", same(lst.child(b"sdtp") is not None, rst.child(b"sdtp") is not None)))
    ls = samples_of(lst)
    rs = samples_of(rst)
    rows.append(("samples", len(ls), len(rs), content(len(ls), len(rs))))
    lmember = _member(out_tops, ls)
    rmember = _member(ref_tops, rs)
    rows.append(("samples.in_mdat", dict(lmember), dict(rmember), content(dict(lmember), dict(rmember))))
    if lst.child(b"stsc") and rst.child(b"stsc"):
        def last_sdi(payload: bytes) -> int:
            count = u32(payload, 4)
            if count == 0:
                return 0
            return u32(payload, 16 + (count - 1) * 12)
        rows.append((
            "stsc.last_sdi",
            last_sdi(lst.child(b"stsc").payload),
            last_sdi(rst.child(b"stsc").payload),
            content(last_sdi(lst.child(b"stsc").payload), last_sdi(rst.child(b"stsc").payload)),
        ))
    return rows


def _member(tops: list[TopBox], samples) -> Counter:
    counts: Counter = Counter()
    mdats = [box for box in tops if box.typ == b"mdat"]
    for sample in samples:
        for index, box in enumerate(mdats):
            if box.payload_offset <= sample.offset and sample.offset + sample.size <= box.end:
                counts[index] += 1
                break
        else:
            counts["outside"] += 1
    return counts


def color_guard(input_path: str, output_path: str, report: Report) -> None:
    report.add("")
    report.add("== color guard ==")
    inn = video_stream(probe(input_path))
    out = video_stream(probe(output_path))
    report.add(f"  input    {color_of(inn)} {inn.get('pix_fmt')} {inn.get('profile')}")
    report.add(f"  output   {color_of(out)} {out.get('pix_fmt')} {out.get('profile')}")
    if is_hdr(out) and not is_hdr(inn):
        report.fail(f"output color {color_of(out)} is HDR while the input {color_of(inn)} is not")
    else:
        report.ok("output did not gain HDR color signaling")
    if color_of(out) != color_of(inn):
        report.add("  note: ffprobe color differs from the input. The tool does not rewrite VUI; this would be a container colr change or a probe quirk.")


def run(input_path: str, output_path: str, reference_path: str | None) -> Report:
    report = Report()
    report.add(f"input:     {input_path}")
    report.add(f"output:    {output_path}")
    report.add(f"reference: {reference_path or '(none)'}")
    out_tops = scan_top(output_path)
    out_moov = load_moov(output_path, next(box for box in out_tops if box.typ == b"moov"))
    changed_fields(input_path, output_path, report)
    sample_identity(input_path, output_path, out_moov, report)
    report.add("")
    layout_checks(output_path, out_moov, out_tops, report)
    audio_structure(output_path, out_moov, out_tops, report)
    color_guard(input_path, output_path, report)
    if reference_path:
        reference_section(output_path, reference_path, out_moov, out_tops, report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Diff a rebuilt MP4 against its input and the Haze reference.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--reference")
    parser.add_argument("--report", help="also write the report to this path")
    args = parser.parse_args()
    try:
        report = run(args.input, args.output, args.reference)
    except (Mp4Error, OSError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    text = report.text()
    print(text)
    if args.report:
        Path(args.report).write_text(text)
    return 1 if report.failures else 0


if __name__ == "__main__":
    sys.exit(main())
