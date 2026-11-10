# Haze file transform: op spec

Checked 10 Nov 2026 against the public sites `https://hazemethod.xyz` and `https://tikhaze.com` (same app), the public developer page, and the TikTok upload `7706265753510546695`. No account, no purchase, no call to `/engine/patch` or `/v1/patch`.

The picture is not re-encoded by the standard engines. The browser asks a server for a plan, then builds a new file by concatenation. The recipe that decides which header bytes to write lives on the server. The client and the public developer library only define the plan language and the checks that run before the request.

## Plain version

An accepted file is one non-fragmented MP4: `ftyp` first, exactly one `moov`, exactly one `mdat`, at most 64 top-level boxes, and every box except `mdat` together at most 16 MB.

The client sends the server three things: the top-level box list (`type`, file offset, size, header length), the base64 of every top-level box except `mdat`, and a job id plus an engine id. The media bytes stay in the browser. The public developer docs say the same thing in one sentence: the engines change the header, and the `mdat` payload is copied from the caller's own file.

The server answers with a plan. For a normal MP4 the plan is a JSON list of parts. Each part is one of:

1. Literal bytes (`b`, base64). This is how a new or rewritten `ftyp`, `moov`, `udta`, sample table, or extra box enters the file.
2. A half-open byte range of the original file (`src`). The range must sit strictly inside the `mdat` payload. Those bytes are copied unchanged.
3. A repeated hex unit (`fill` + `n`). This is how a padding or marker run is written without listing every byte.

The parts are concatenated in order. The first part must be a literal whose box type is `ftyp`. The sum of the part lengths must equal `plan.size`. There is no in-place "poke this offset" opcode, and there is no opcode named for a NAL, an SEI, a VUI, a timescale, or a flag. Those fields change only when the literal header bytes the server returned are different from the header that was sent.

A second plan language, `ops1`, builds an MPEG-TS file instead of an MP4. The website uses it for Haze Lite when a local flag `liteTs` is on. The public developer library does not implement `ops1`.

## Where this was read

| Source | What it is |
|---|---|
| `/assets/app/ce94e3af8746bfb9.js` | Website engine module. Layout check, both assemblers, NAL table, engine ids. |
| `/assets/app/0c5d5290650021a4.js` | Optimizer page. Credit calls, which engine runs audio prep, FFmpeg transcoder, error copy. |
| `/assets/app/3ed3bfabe2c2ee54.js` | Engine 6.1 audio prep (loaded only for that id). |
| `/assets/app/810b8f0b178ae7ba.js` | Engine list from `GET /engine/backend?audio61=1`, and the `freeMode` banner. |
| `/assets/app/41f84494f0040959.js` | Remote HandBrake re-encode. Separate from the plan. |
| `/assets/sdk/haze-engine-api.mjs` | Public MIT client. `prepare` + parts `assemble` only. About 170 lines, unobfuscated. |
| `https://tikhaze.com/api-docs` | Public description of `POST /v1/patch` and a truncated example plan. |
| `GET https://api.hazemethod.xyz/status` and `GET /engine/backend?audio61=1` | Public, no account. |
| yt-dlp of the TikTok URL above, format `hevc_2160p_46341623` | 192,532,067 bytes. Atom tree and NAL walk measured on that file. |

The homepage entry on this build is `/assets/app/f3b7cd5326a6066a.js` (release `acb9f1b7be69073c83e60e75371f8f8b7fa3171c`). Chunks were followed from public `import()` edges only. No sample plan object is embedded in those chunks. `HazePatchCache` is an IndexedDB cache of finished downloads (20 files, 500 MB, 3 days). It does not contain a demo plan.

## MP4 plan (the format every standard engine uses)

JSON object:

| Field | Rule |
|---|---|
| `size` | Exact output length in bytes. Must equal the sum of the parts. |
| `parts` | Array, length 1 to 100,000. |
| `engine` | Present on the developer-API example (`"5.5"`). The website assembler ignores it and only reads `parts` and `size`. |

Part, exactly one of these shapes:

### `b` — literal

```json
{ "b": "<standard base64>" }
```

Decoded with ordinary base64 and appended as raw bytes. This is the only way bytes that are not inside the original `mdat` payload can appear in the output. A rewritten `moov` (timescales, durations, `tkhd` flags, `elst`, `stts`/`stsz`/`stsc`/`stco`, `sdtp`, `udta`, codec config boxes) is just a literal blob.

### `src` — copy

```json
{ "src": [start, end] }
```

Copies file bytes `[start, end)`. Both ends are safe integers, `start < end`, and the range must satisfy `payloadStart <= start` and `end <= payloadEnd`. `payloadStart` is the first byte after the `mdat` header. `payloadEnd` is the first byte after the `mdat` box. The `mdat` header itself, `ftyp`, `moov`, `free`, and any other top-level box are outside that window, so they cannot be copied with `src`. They have to be re-supplied as literals if the output still needs them.

A plan that wants the media unchanged sends one `src` covering the whole payload. A plan that wants to drop, insert, or replace media bytes splits or skips ranges and puts literals between them. The assembler will do that. The public docs say the engines change the header, and the reference file's video samples are a straight HEVC stream (see below), which fits one untouched payload copy.

### `fill` — repeat

```json
{ "fill": "<even-length lowercase hex>", "n": <positive integer> }
```

`fill` matches `^(?:[0-9a-f]{2})+$`. The unit is at most 64 bytes. `n` is at least 1. `unit.length * n` is at most 64 MB. The unit is repeated `n` times (the implementation fills by doubling). Uppercase hex is rejected.

The 102-byte tail in the reference file is `21 10 04 60 8c 1c` repeated 17 times. That is a legal fill: unit `211004608c1c`, `n` = 17, plus an 8-byte `mdat` header as a separate literal.

### Output rule

The first part's decoded bytes must be at least 8 bytes and bytes 4–7 must be `ftyp`. The blob type is `video/mp4`. Nothing else is checked: the assembler does not walk the new `moov`, does not fix `stco`, and does not look at NALs.

### What that means for each kind of edit

| Edit people expect | What the assembler actually has |
|---|---|
| Insert a box | A literal (or a fill) at that point in the concatenation. |
| Replace a box | The old header is never copied. The new bytes are a literal. |
| Delete a box | Leave it out of the literal header. |
| Write bytes at a file offset | No such opcode. The output is rebuilt from the start. |
| Insert another `mdat` | Literal size+type, then a `src` and/or a `fill`. The reference file has two `mdat` boxes, and the second one is a fill-shaped payload. |
| Edit sample tables | Bytes inside the literal `moov`. The client does not parse `stts`, `stsz`, `stsc`, `stco`, or `co64` on the MP4 path. |
| Edit a NAL, SEI, or VUI | No opcode. Possible only by splitting `src` and inserting literals. The published description says the payload is copied. |
| Edit timescale, duration, flags | Bytes inside the literal `mvhd` / `mdhd` / `tkhd` / `elst`. |

The website error copy for a missing `stsz` / `stsc` / `stco` calls those tables the ones required for fake-sample injection. That string is a help key, not an assembler branch. It matches the shape of the reference file: the audio sample table points at a handful of samples that are not real AAC frames.

## `ops1` (MPEG-TS plan)

Used when the server returns `{ "format": "ops1", "ops": "<base64>", "size": N, "gzip": optional bool }`. `size` is a safe integer greater than 0. If `gzip` is true, the base64 payload is gunzipped with `DecompressionStream` before parsing. A browser without that API is rejected on this path.

After decoding, the buffer is a bytecode stream. Integers are unsigned LEB128, 7 bits per byte, at most 8 bytes. Opcodes:

| Opcode | Body | Effect |
|---|---|---|
| `0x00` | LEB128 length, then that many bytes | Append a literal. If this is the first byte of the output, the first literal byte must be `0x47` (MPEG-TS sync). |
| `0x01` | LEB128 zigzag, then LEB128 length | Copy `length` bytes from the source. The offset is the previous copy-end plus a zigzag delta: even `z` means `+z/2`, odd `z` means `-((z+1)/2)`. The cursor starts at 0, so the first copy's zigzag is the absolute file offset. The range must lie inside the `mdat` payload, and the length must be non-zero. The cursor becomes the end of this copy. |
| `0x02` | 3 bytes | Emit a 188-byte TS packet: `0x47` plus those 3 header bytes, then 184 (`0xB8`) source bytes at the current cursor. The cursor must already sit inside the payload with 184 bytes of room. The cursor advances by 184. |
| anything else | | Rejected as an unknown plan part. |

The output length must equal `size`. The website then marks the blob `hazeFormat = "mpegts"`. A later preview uses the original MP4, because a TS file is a poor preview. The public SDK's `assemble` rejects this shape, because it requires an `ftyp` literal.

The website asks for `ops1` only in one case: engine Lite, `localStorage['haze_auth'].liteTs === true`, and `DecompressionStream` exists. The request engine id becomes `lite-ts`, the body gains `planGzip: true` and a `nals` field, and a `400` with `engine_not_offered` drops the flag and retries as ordinary Lite (`engine: "lite"`, no `nals`). Any other engine can still assemble `ops1` if the server chooses to return it. The reference TikTok file is an MP4, so it was not built by this bytecode.

## NAL table (`nals`, Lite TS only)

Built from the video track before the `lite-ts` request. It is base64 of this stream, one record per sample, in decode order:

- LEB128 count of NALs in the sample.
- For each NAL: LEB128 of the NAL payload length (not including the length prefix), then the first `min(length, 2)` bytes of the NAL.

Length prefixes come from `avcC` byte 4 or `hvcC` byte `0x15`, low 2 bits, plus one. Samples come from `stsz` + `stsc` + `stco`/`co64`. More than 2,000,000 samples is rejected. The table itself must stay within 8 MB. The server therefore sees NAL sizes and the first two header bytes (enough for the AVC or HEVC NAL type), not the NAL payloads. The MP4 engines do not send this table.

## What the client checks before the request

Shared by the website module and the public `prepare`, unless noted.

- File starts with `ftyp`. A 64-bit box size (`size == 1`, 16-byte header) is parsed. The current checker does not reject it. Older help text and the page modal still tell the user that a 64-bit size box is refused and that FFmpeg Transcoder Mode is the workaround. That help text is ahead of, or behind, the checker that shipped in this bundle.
- `moof` anywhere at top level is refused (fragmented MP4).
- Exactly one top-level `moov` and one top-level `mdat`. A second tiny `mdat`, like the one in the reference file, would fail this check. So that second box is an output shape, not a legal input shape.
- More than 64 top-level boxes is refused.
- Non-`mdat` bytes summed over 16 MB is `header_too_large`.
- The header blob is those non-`mdat` boxes concatenated in file order. The box list still contains the `mdat` record so the server knows where the payload sits.
- Website only: the ASCII string `Haze Quality Method https://hazemethod.xyz` anywhere in the non-`mdat` bytes is `already_patched`. The same string in the first 8 packets of a file that starts with `0x47` at offsets 0, 188, and 376 is also `already_patched`.
- Website only, per engine, from the `moov` inside that header:

| Engine id sent | Codecs | Video tracks | Audio |
|---|---|---|---|
| `5.5` | `avc1`, `avc3`, `hvc1`, `hev1` | exactly one | one `soun` track whose first sample entry is `mp4a` |
| `6.0` | those four, plus `dvh1`, `dvhe` | one or more | same AAC rule |
| `6.1` | same as 6.0 | exactly one | same AAC rule |
| `6.2` | same as 5.5 (no Dolby Vision fourccs) | exactly one | same AAC rule |
| `lite` (UI id `Lite`) | same as 5.5 | exactly one | some `soun` track with entry `mp4a` |

A Dolby Vision fourcc on 5.5 is `unsupported_codec` with detail `dolby_vision`. Missing audio is detail `no_audio`. The video sample entry must contain `avcC` or `hvcC` only on the Lite TS path, because only that path walks NALs. The MP4 path does not require the config box at check time.

The website also reads, for display and for the credit quote, width, height, and a rounded frame rate from the video `mdhd` and the `stsz` sample count. That quote is not an edit.

Request body the website posts (gzip JSON) to `/engine/patch`:

```json
{
  "jobId": "hz_…",
  "engine": "6.2",
  "layout": { "fileSize": 0, "boxes": [{ "type": "ftyp", "start": 0, "size": 24, "header": 8 }] },
  "header": "<base64 of every top-level box except mdat>"
}
```

`Lite` is sent as `lite`. The `lite-ts` variant adds `nals` and `planGzip`. The developer API uses the same `layout` and `header` fields, with `requestId` instead of `jobId`, and does not define `nals`.

## Engines that exist in this build

`GET /engine/backend?audio61=1` on 10 Nov 2026 returned:

```json
{
  "backend": "self",
  "engine": "6.2",
  "name": "Haze Max",
  "engines": [
    { "id": "5.5", "name": "Haze Classic", "status": "fixing", "note": "use Haze Max" },
    { "id": "6.2", "name": "Haze Max", "status": "working" }
  ],
  "lite": { "status": "working" }
}
```

`GET /status` returned `freeMode: false`, `patched: false`, `maintenance: false`, `status: "operational"`.

The picker shows Lite plus whatever `/engine/backend` lists. Ids must look like `digits.digits`. A non-`working` engine stays visible and is not selectable. Fallback id compiled into the picker is `6.1`, replaced as soon as the backend answers.

| Id | Name on the site today | In the bundle | Offered by `/engine/backend` today | Local step before the plan |
|---|---|---|---|---|
| `5.5` | Haze Classic | yes | listed, status `fixing` | none |
| `6.0` | (no live name; an older guide still calls 6.0 the newer engine) | yes, including Dolby Vision fourccs and more than one video track | not listed | none |
| `6.1` | compiled as a Max id alongside 6.2 (`HAZE_MAX_IDS`) | yes | not listed | re-encodes audio, then re-checks layout. See below. |
| `6.2` | Haze Max, the default | yes | `working` | none |
| `Lite` / `lite` | Haze Lite | yes | `lite.status = working` | optional TS plan, see `ops1` |
| Fast 4.7 | | no id, no string, no branch | not listed | |

Fast 4.7 is absent from this build. The word "fast" in the bundles is an audio-speed preset on a different tool (speed 1.2, no reverb), not an engine. The public "what is Haze" guide is older than the backend: it still describes engine 6.0 and Lite, and it says Lite playback tops out around 720p at 60 frames per second.

The developer docs (18 Oct 2026) offer Classic `5.5` and `lite` on `POST /v1/patch`, and they say Haze Max is not on that API because it needs audio preparation on the device. In this website bundle the audio-preparation hook is engine **6.1**, not 6.2. The name "Max" has moved. 6.2 is what the site now calls Haze Max, and 6.2 does not re-encode audio.

6.1 audio prep, only if that engine is selected and the layout check passed:

```
ffmpeg -y -i input
  -map 0:v:0 -map 0:a:0
  -c:v copy
  -c:a aac -ar 48000 -ac 2 -b:a 320k
  -flags:a +bitexact
  -avoid_negative_ts make_zero
  -map_metadata -1 -map_chapters -1
  -movflags +faststart
  output
```

Video is copied. Audio becomes AAC-LC, 48 kHz, stereo, 320 kbps, metadata and chapters stripped, `moov` moved forward. Timeout in the call is 180000 ms. The reference file was not produced by this command: `moov` is at the end, handlers are still Mainconcept, and the tags were not cleared to a lavf encoder.

Other local FFmpeg strings, shown as user help rather than run automatically:

```
ffmpeg -i input.mp4 -c copy -map 0:v output.mp4
ffmpeg -i input.mp4 -f lavfi -i anullsrc -c:v copy -c:a aac -shortest output.mp4
```

The first is the suggested fix for a 64-bit size box, a missing video track, or missing chunk tables. The second adds silent AAC when the engine demands an audio track.

## `freeMode` and demos

`freeMode` is a boolean on the session refresh and on `/status`. The client stores it, shows a banner when it is true and the service is not in maintenance and not marked patched, and skips the local "no credits left" modal while it is true. The optimize call still goes through `/engine/patch` with a session. There is no anonymous assembler and no baked-in demo plan. On this date `/status` has `freeMode: false`.

Credits around a run are `POST /credits/quote`, `/credits/reserve`, `/credits/commit`, `/credits/refund`. A failed layout check is not charged. That gating is separate from the byte plan.

## FFmpeg Transcoder Mode

The page calls this Haze Refinery. The constant `HAZE_REFINERY_AVAILABLE` is `false` in this build, so the settings toggle is not attached and `refineryEnabled` stays false. The function is still in the bundle. When the flag is on, the file is remuxed before the layout check:

```
ffmpeg -i <input.mp4 or input.mov> -c copy -movflags +faststart <output.mp4>
```

Streams are copied. `moov` is moved to the front. There is a second call site for the same remux when the media probe fails with reason `unreadable`, also behind the same flag. The modal on the page still tells a user with a 64-bit mobile export to turn FFmpeg Transcoder Mode on. With the flag compiled off, that button does nothing.

Wasm assets used by both Refinery and the 6.1 audio step: `/assets/ffmpeg/ffmpeg.js`, `ffmpeg-core.js`, `ffmpeg-core.wasm`, cache-busted with `window.__HAZE_FF_VER` (`75cf8379e3` on this build).

## HandBrake

A separate, session-gated re-encode. The browser uploads the file in 5 MB chunks to `encoder.tikquick.online` and downloads a new MP4. Cap 1500 MB. This path does re-encode the picture. It is not the plan assembler, and the reference file's Mainconcept handlers and lack of a lavf tag say it was not used there.

## Public example plan

The only plan in public text is the truncated illustration on the API docs. The visible literal prefix `AAAAHGZ0eXBpc29t` decodes to 12 bytes:

```
00 00 00 1c  66 74 79 70  69 73 6f 6d
size 28      'ftyp'       'isom'
```

The box is declared as 28 bytes, so the minor version and compatible brands were cut off by the ellipsis in the docs. The other two illustrated parts are `src: [1460, 104831]` and `fill: "00"` repeated 16 times. `size` in the example is 106285. That object is documentation, not an engine response, and it is not long enough to assemble.

## Reference file, and which ops can produce it

File: TikTok `7706265753510546695`, yt-dlp format `hevc_2160p_46341623`, 192,532,067 bytes, duration 33.237 s, about 46.3 Mbps. ffprobe format tag `encoder` is exactly the Haze ASCII string above. TikTok is still serving this bitstream (HEVC, 2160×3840, 60/1, Main 10, 10-bit).

Top level:

| Box | Offset | Size | Notes |
|---|---|---|---|
| `ftyp` | 0 | 24 | major `mp42`, minor 0, brands `mp42`, `mp41` |
| `mdat` | 24 | 192,503,019 | header 8 bytes, payload starts at 32. Real interleaved media. |
| `mdat` | 192,503,043 | 110 | payload 102 bytes = `21 10 04 60 8c 1c` × 17 |
| `moov` | 192,503,153 | 28,914 | at the end. Not faststart. |

`moov` children, in order: `mvhd`, three `trak`s, `udta`. No `mvex`. Creation and modification times are 0. `mvhd` version 0, timescale 1000, duration 33237, rate 1.0, identity matrix, next track id 4.

Video track id 1, handler `vide`, name is a Pascal length byte plus `Mainconcept Video Media Handler`.

- `tkhd` flags `0x7` (enabled, in movie, in preview), duration 32850, layer 0, alternate group 0, volume 0, size 2160×3840.
- `elst` one entry: segment 32850, media time 0, rate 1.0.
- `mdhd` timescale 60000, duration 1,971,000, language `eng` (`0x15C7`).
- `stsd` one `hvc1`, compressor name empty, only child `hvcC` (118 byte payload). No `colr`, `pasp`, `btrt`, `mdcv`, `clli`.
- `stts` one run: 1971 samples × delta 1000. With timescale 60000 that is 60/1 exactly.
- `stco` 198 chunks, first offset 32 (first byte of the big payload). Every video chunk lies inside the big `mdat`.
- `stss` 66 sync samples, spacing 30 (a keyframe every 0.5 s).
- `sdtp` 1971 bytes: `0x24` on the 66 sync samples, `0x10` on the other 1905. No `ctts`.

HEVC, from `hvcC` plus `trace_headers` on the first access units, and a full walk of all 1971 samples:

- NAL length size 4. Sample-entry config is VPS+SPS+PPS only.
- Profile Main 10 (general_profile_idc 2), High tier, level 153 (5.1), compatibility bit 2 set.
- `chroma_format_idc` 1, bit depth luma and chroma 10 (`minus8` = 2).
- Coded size 2176×3840, conformance window right offset 8, other offsets 0, so the displayed width is 2160.
- CTU 32 (`log2_min_cb` 0, `log2_diff_max_min` 2). AMP on. SAO on. PCM off. One short-term RPS. Temporal MVP off. Strong intra smoothing off. Transform hierarchy depth 3.
- VUI present. Aspect 1:1. Full range off. Primaries 9, transfer 16 (PQ), matrix 9. Timing 1/60. No HRD.
- PPS: tiles off, entropy-coding sync (WPP) off, weighted pred off.
- NAL types across every sample: AUD (35) × 1971, VPS (32) × 66, SPS (33) × 66, PPS (34) × 66, IDR_W_RADL (19) × 66, TRAIL (1) × 1905. Zero SEI (39 or 40). Zero bad length prefixes. Keyframes carry AUD+VPS+SPS+PPS+IDR. Other frames carry AUD+TRAIL.

Two audio tracks, ids 2 and 3, both `soun`, both Pascal-length `Mainconcept MP4 Sound Media Handler`, both AAC-LC, 48 kHz, stereo, 16-bit, `stts` 1558 × 1024, `mdhd` duration 1,595,392.

- `tkhd` flags `0x1` (enabled only: not in movie, not in preview), duration 33237, alternate group 0, volume 1.0.
- `elst` segment 33237, media time 0, rate 1.0.
- Track 2 `stsd` has two `mp4a` entries (esds 39 bytes, then esds 57 bytes). Track 3 has one `mp4a`, matching the shorter entry.
- `stco` and `stsz` of the two tracks are the same 200 chunks. The first 198 chunks sit in the big `mdat`. Chunks 199 and 200 sit entirely in the small `mdat`: chunk 199 is 9 samples / 54 bytes at offset 192,503,051, chunk 200 is 8 samples / 48 bytes at 192,503,105. 17 samples × 6 bytes = 102 bytes, and each 6-byte sample is `21 10 04 60 8c 1c`. Track 2's last `stsc` entry uses sample-description index 2 for chunk 200 only. Track 3 uses index 1 for every chunk, including those two.
- Those 17 samples are inside the `stts` run of 1024, so they add 17×1024/48000 = 0.3627 s to the audio timeline. A 6-byte "AAC frame" at this bitrate is not a real frame. The movie duration follows this longer audio clock (33237 ms).

`udta` is only `meta` / `hdlr` `mdir` / `ilst` / `©too` / `data`. The data atom is type 1 (UTF-8), locale 0, value the Haze string. No other metadata atoms.

### Mapping

| Observed feature | Could the public ops have written it? |
|---|---|
| HEVC access units, AUD, IDR every 30, VUI colour, no SEI | Yes, as one `src` of the big `mdat` payload. The client has no NAL editor on this path. Nothing in the walk looks like an inserted NAL. Treat the picture and the real AAC frames as copied. |
| `ftyp` `mp42`/`mp41`, `moov` at end, Mainconcept handler names, empty compressor name, `hvcC` without `colr` | These are inside boxes the plan must re-emit as literals. They also match a Premiere / Mainconcept export. The plan can keep them by echoing the header it was given, or it can rewrite them. This file does not prove a rewrite of those fields. |
| `©too` Haze string | The client treats that exact string as its own watermark and as the already-processed marker. It is the one header field this file is known to have gained from Haze. A replica should use a different string. |
| Second `mdat` of 17 × `21 10 04 60 8c 1c` | A literal 8-byte `mdat` header plus `fill` `211004608c1c` × 17. The input checker would have rejected this file, so the box was added on the way out. |
| Last 17 audio samples, 6 bytes each, `stco` aimed at that second `mdat`, both tracks sharing `stco`/`stsz` | The sample table is part of the literal `moov`. This is the fake-sample shape named in the help text. High confidence the plan can do it. High confidence this file contains it. The pre-Haze export was not available, so it is not a byte-diff against the original. |
| `tkhd` flags 7 vs 1, `elst` media time 0, timescales 1000 / 60000 / 48000, times zeroed, `sdtp` | All live in the literal `moov`. The client never writes them itself. They may be the source export, preserved when the server copied the header and then patched `stco` and `udta`. |
| Phone gallery showing 0:00 or sound without picture | Documented on the public docs for Lite, Classic, and Max. Consistent with audio flags `0x1` and with a movie duration that follows the padded audio. Not something the assembler special-cases. |
| MPEG-TS, `ops1`, SEI injection, `colr` rewrite, faststart | Not in this file. |

The public compare clips on the homepage (`/assets/compare-before.mp4`, `compare-after.mp4`) are lavf/libx264 marketing files (brands `isom`/`iso2`/`avc1`/`mp41`, minor 512). They do not carry the Haze string and they are not an engine output.

## What a faithful local builder has to do

1. Reject fragmented files, a missing `ftyp`, and anything other than one `moov` plus one `mdat`, the same way `prepare` does. Remux with stream copy and `+faststart` first if the container is illegal. That remux moves `moov` forward; the reference file shows the plan may run on a file whose `moov` stays at the end, so both layouts are worth testing.
2. Send or locally compute a new header. The bytes that differ from the input header are the whole of the "edit". The public client cannot tell you which fields the server changes, because it forwards the header and pastes back whatever literal it is given.
3. Emit `ftyp` as a literal, then the media as one `src` of `[payloadStart, payloadEnd)`, then any extra tail (`fill` or literal), then the new `moov` literal. Or any other order the parts list.
4. Leave every byte of each `src` identical to the input. Do not re-encode the picture on this path.
5. Stamp a distinct encoder string. Reusing the Haze string makes the file look already processed to their client.

## Untouched, on the standard path

- Every byte covered by an `src` range. For a header-only plan that is the entire `mdat` payload: video NALs and audio frames, including SPS/VUI/SEI if they were already in the bitstream.
- The client does not run a video encoder, does not rewrite `hvcC`/`avcC`, and does not touch colour metadata except by replacing the whole header blob.
- Engine 6.1 is the exception that re-encodes audio before that copy. Refinery, currently compiled off, remuxes without re-encoding. HandBrake re-encodes on a server and is a different product path.

## Unknowns

- The server recipe: which `mvhd` / `tkhd` / `stco` / `udta` bytes it rewrites, and whether that recipe differs for 5.5, 6.0, 6.1, 6.2, and Lite. The client uses one assembler for all of them. Only the pre-check and the optional 6.1 audio remux differ locally.
- Whether the 17 six-byte audio samples and the second `mdat` are in every plan or only in some exports. They are in this served file, and the assembler can build them. The original upload before Haze was not available.
- Whether a plan ever splits `src` to insert or delete media bytes. The assembler allows it. The docs say the engines change the header. This file's video NAL walk shows no inserted SEI and no broken lengths.
- `ops1` contents for a real Lite TS job. The bytecode is fully specified above. No public plan bytes were found.
- Fast 4.7. Not in the current public client, backend list, or SDK.
- Why the API docs still say Max needs on-device audio prep, while the live site calls 6.2 Max and only 6.1 has the audio remux.
- Whether `freeMode: true` changes the server plan or only the credit check. The client only changes the credit gate and a banner.
- What TikTok's ingest did after the upload. This file still has the Haze tag, the Mainconcept handlers, and the original-looking HEVC, so the served file was not replaced by a heavy transcode. A second remux by TikTok is still possible and would not show up in the client.
