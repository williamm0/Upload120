# TikTok HD rules: original passthrough vs a 540p transcode

Checked 10 Nov 2026. Read-only: public pages, public JavaScript, public GitHub, and one public TikTok post. No sign-in, no payment, no credits, and no call to Haze's plan endpoint.

The question is what makes TikTok publish 720p / 1080p / 4K playback instead of a single ~540p transcode, and how a Haze file (hazemethod.xyz / tikhaze.com) can be served with no re-encode.

## Answer

Two different outcomes get called "HD". They are not the same file.

1. **A transcode ladder.** TikTok re-encodes the upload. A full ladder has several gears (`normal_540_0`, `adapt_540_1`, `adapt_lower_720_1`, `adapt_lowest_1080_1`, …), `encodedType` `normal`, a VQ score, and bitrates around 0.5–3 Mbps. The top rung can be 1080p and still not be the upload.
2. **Original passthrough.** TikTok stores the upload and the player lists that file as the only rendition: gear `original_<short-side>_0`, `encodedType` `original`, `videoQuality` `original`, `QualityType` 10000. No lower rung is published.

The reference post is outcome 2. On 10 Nov 2026 its page JSON had **one** `bitrateInfo` entry, `original_2160_0`, HEVC, 2160×3840, 60 fps, 46,341,623 bit/s, 192,532,067 bytes. The download is that size, still carries the Haze encoder tag and Mainconcept handlers, and plays as 60 fps HDR10 Main 10. TikTok did not re-encode it and did not publish a 540p sibling.

The team's Only me posts of re-encoded H.264 1080×1920 and of SDR copies are outcome "ladder bottom only": one 540p rendition at 576×1024. Haze's own help text says a post that is not HD should be published as Everyone, not private. **Only me posts do not get this HD path in any case we can see.** The one confirmed passthrough is a public post.

What flips a file from the ladder onto `original_*` is not published by TikTok. The best public evidence is that ingest schedules the ladder from the movie header, and a movie duration it cannot read skips that job and stores the bytes. That recipe is sufficient in one vendor's paired uploads, and it is **not** what the Haze reference uses: that file's movie duration is a normal, readable 33.237 s. Ghost-frame sample tables, the other widely copied recipe, are also absent from this file, and by August 2026 that recipe was being quarantined. The Haze file that is live today is a Premiere-shaped HEVC Main 10 upload with a readable duration, posted in public, whose bytes arrived unaltered.

## Reference renditions (measured)

Post: https://www.tiktok.com/@yessirskiedt/video/7706265753510546695

Pulled 10 Nov 2026 with yt-dlp 2026.10.26 (Chrome impersonation) and from the `__UNIVERSAL_DATA_FOR_REHYDRATION__` blob on the same page. Account `yessirskiedt` / `yessirski`, id `7378617082181190661`, not verified, not a private account, about 32 followers. Post flags: `privateItem` false, `secret` false, `forFriend` false, `isReviewing` false. Posted 9 Nov 2026 (`createTime` 1794254833). About 37,700 plays at fetch time. Location tag `TR`. Sound title `original sound - yessirski`, music id `0` (not a TikTok library sound).

`video` scalars:

| Field | Value |
| --- | --- |
| `width` × `height` | 2160 × 3840 |
| `duration` | 33 |
| `ratio` / `definition` | `2160p` / `2160p` |
| `bitrate` | 46341623 |
| `size` | 192532067 |
| `codecType` | `hevc` |
| `format` | `mp4` |
| `encodedType` | `original` |
| `videoQuality` | `original` |
| `encodeUserTag` | empty |
| `VQScore` | `0` |
| `videoID` | `v1c025g50000dbp2dtfog65sk0ur25j0` |

`bitrateInfo` length **1**. `playAddr`, `downloadAddr`, and `PlayAddrStruct` are the same object (same URI, same byte size). yt-dlp prints two format ids only because two CDN hosts (`v16-webapp-prime` and `v19-webapp-prime`) mirror that one file, plus the usual `aweme/v1/play` redirect.

| Field | The only entry |
| --- | --- |
| `GearName` | `original_2160_0` |
| `QualityType` | 10000 |
| `Bitrate` | 46341623 |
| `BitrateFPS` | 60 |
| `CodecType` | `hevc` |
| `Format` | `mp4` |
| `MVMAF` | empty |
| `PlayAddr.Width` × `Height` | 2160 × 3840 |
| `PlayAddr.DataSize` | 192532067 |
| `PlayAddr.UrlKey` | `v1c025g50000dbp2dtfog65sk0ur25j0_hevc_2160p_46341623` |
| `PlayAddr.Uri` | `v1c025g50000dbp2dtfog65sk0ur25j0` |
| `VideoExtra` | `transcode_feature_id`, `mvmaf`, `ufq`, `gearvqm`, `dec_info` all empty. `audio_bit_rate` 313772 |

`UrlList` has three URLs (two CDN mirrors and `/aweme/v1/play/`). Signed query strings expire; they are not part of the rendition identity.

Downloaded file: 192,532,067 bytes. ffprobe:

- Container 46,341,623 bit/s, duration 33.237 s, brands `mp42` / minor 0 / `mp42mp41`.
- Encoder tag: `Haze Quality Method https://hazemethod.xyz`.
- Video: HEVC Main 10, `hvc1`, `yuv420p10le`, tv, bt2020 / smpte2084 / bt2020nc, 2160×3840 (coded 2176×3840), level 153 (5.1), 0 B-frames, 46.56 Mbps, 60/1 fps, 1971 frames, media duration 32.850 s, timescale 1/60000. `hvcC` extradata 118 bytes.
- Audio: two AAC-LC tracks, 48 kHz stereo, 313,772 bit/s each, 1558 frames, media duration 33.237 s.

That audio bitrate matches `VideoExtra.audio_bit_rate`. A normal TikTok transcode re-encodes audio down to a few tens of kbps and would not keep a third-party encoder tag. Empty `VQScore`, empty `MVMAF`, and an empty `transcode_feature_id` are the opposite of a finished ladder (the public ladder sample below has `VQScore` 70.11 and filled MVMAF on the HEVC rungs).

### Box layout of the served file

Top level, in order:

| Box | Size | Notes |
| --- | --- | --- |
| `ftyp` | 24 | major `mp42`, minor 0, compatible `mp42` `mp41` |
| `mdat` | 192,503,019 | media, starts at offset 32 |
| `mdat` | 110 | 102-byte payload, `21 10 04 60 8c 1c` repeated 17 times |
| `moov` | 28,914 | at end of file, offset 192,503,153 |

Movie header is version 0, timescale 1000, duration **33237** (33.237 s). Not the all-ones "unknown" duration. Three tracks:

| Track | id | `tkhd` flags | `tkhd` duration | `mdhd` |
| --- | --- | --- | --- | --- |
| video | 1 | 7 (enabled, in movie, in preview) | 32850 | timescale 60000, duration 1971000 (32.850 s), language `eng` |
| audio | 2 | 1 (enabled only) | 33237 | timescale 48000, duration 1595392, language `eng` |
| audio | 3 | 1 (enabled only) | 33237 | same as track 2 |

1971 × 1000 ticks at 60000 = 1971000 exactly, so the sample table is the real 60 fps frame count. It is not a 5× or 10× inflated table. Handlers are Mainconcept (`Mainconcept Video Media Handler`, `Mainconcept MP4 Sound Media Handler`). The only `udta` text is the Haze `©too` string (iTunes data type 1, UTF-8), at the end of the file.

So the passthrough file is a coherent Premiere / Mainconcept export plus a short text tag, a second tiny `mdat`, and audio tracks that are enabled but not flagged in-movie. Local players read a normal duration (ffprobe does). This is not a file whose movie duration is unknown, and it is not a ghost-frame file.

## What a normal ladder looks like

A public page-JSON dump for item `7420162633292205342` (tiktokscraper docs; snapshot from late 2024, so the gear set is illustrative, not a re-fetch) is the other shape:

`encodedType` `normal`, `videoQuality` `normal`, `definition` `540p`, `codecType` `h264`, display bitrate 1,624,115, `VQScore` `70.11`, `volumeInfo` loudness −14.2 / peak 0.73.

| Gear | QualityType | Codec | Size | Bitrate |
| --- | --- | --- | --- | --- |
| `adapt_lowest_1080_1` | 2 | `h265_hvc1` | 1080×1920 | 2,606,091 |
| `normal_540_0` | 20 | `h264` | 576×1024 | 1,624,115 |
| `adapt_lower_720_1` | 14 | `h265_hvc1` | 720×1280 | 1,106,913 |
| `adapt_540_1` | 28 | `h265_hvc1` | 576×1024 | 879,581 |
| `lowest_540_0` | 25 | `h264` | 576×1024 | 476,629 |

UrlKeys look like `<videoID>_bytevc1_1080p_2606091` and `<videoID>_h264_540p_1624115`. HEVC rungs carry an MVMAF blob. There is no `original_*` gear and no multi-tens-of-Mbps entry. 1080p here is a ~2.6 Mbps transcode, not the upload.

Another public sample (tbar-dl, undated) lists only the bottom of that ladder: `normal_540_0`, `adapt_lower_720_1`, `lower_540_0`, `adapt_540_1`, `lowest_540_0`, all ≤ ~2.2 Mbps, no 1080p. So "HD" inside the ladder is "did they bother to emit 720/1080", and it can be missing even on a public post. That is a different failure from "they kept the original".

The team's Only me result (one 540p picture at 576×1024) matches `normal_540_0` geometry. It does not match `original_2160_0`.

## Ranked conditions

Confidence is about the claim in that row, not about whether a vendor says it.

### High

**1. The HD we measured is passthrough, identified by gear name and by the bytes.**  
`encodedType=original` + `GearName=original_2160_0` + `QualityType=10000` + one entry + source encoder tag + source size. A 1080p HEVC rung at ~2 Mbps with `encodedType=normal` is a transcode even though the height says 1080.

**2. The bytes that reach the server have to be the prepared file.**  
Haze's help page: the phone app re-encodes; upload in TikTok Studio on the website, or through their uploader (they describe it as TikTok's posting API). Adding a TikTok sound while posting re-encodes and drops the quality. Re-exporting or editing the file after the header step drops it too. zaclip measured the same split on one treated file: tiktok.com on a computer, and one direct-post API upload, both came back byte-identical; finishing the post inside the phone app re-encoded it. ShortSync's guide ranks the same way (API and desktop send the file; the apps compress before upload) but then recommends ordinary H.264 export settings, which feed the ladder, not passthrough.

The reference has music id 0 and the title "original sound", which fits "no library sound was attached at post time".

**3. Official ingest limits are a gate, not the HD switch.**  
Content Posting API media transfer guide: MP4 (recommended), WebM, MOV; H.264 recommended, H.265 / VP8 / VP9 accepted; 23–60 fps; 360–4096 px per side; max 4 GB; duration 3 min for every creator, 5 or 10 min for some, 10 min max on the API. No bitrate, HDR, bit depth, or "keep original" rule. A readable movie duration of 10 hours is rejected at upload with `status_code` 3013036, `Can't upload more than 60 minutes` (zaclip, web uploader). So duration is parsed when it can be parsed. The reference (33 s, 2160×3840, HEVC, 60 fps) is inside the published window, which is why it was accepted. Being inside the window does not by itself select passthrough: the same guide is how ordinary files enter the ladder.

**4. Only me does not get the original gear.**  
See the last section. Haze's current help text treats private visibility as the reason a post stayed not-HD. The team's Only me files stayed at one 540p rendition. The passthrough example is public.

### Medium

**5. A movie duration the scheduler cannot read is sufficient to skip the ladder, on the one account that published hashes.**  
zaclip (public JS in `src/mp4/build.js` and `src/mp4/remux.js`, and their write-up) rewrites only the movie-level duration and copies samples. Exact write, version-0 `mvhd` widened to version 1:

- version byte set to 1, flags 0
- creation and modification widened from 4 bytes to 8, values kept, right-aligned
- timescale copied unchanged
- duration set to 8 bytes of `0xFF` (ISO "unknown")
- the rest of the box copied from the old rate field onward

If the source `mvhd` is already version 1, only bytes 32–40 (the 64-bit duration) are filled with `0xFF`. Track `tkhd` / `mdhd` durations are left as they were. Their remux also rebuilds `moov` in front of `mdat`, re-chunks at about 0.5 s, and renames handlers to `VideoHandler` / `SoundHandler`. They say that rebuild is not the cause.

Their paired uploads, one account, two days, all 1080×1920 at 60 fps, tiktok.com from a computer, "HD by default" left on for every variant:

| Movie duration | Rest of container | Came back |
| --- | --- | --- |
| correct, file untouched | — | 576×1024, 30 fps, 10–24% of the bitrate |
| correct, container rebuilt | same bitstreams | same 576p file as the untouched upload |
| unknown (`0xFF`… as above) | rebuilt | whole-file md5 identical to the upload (three clips: 11,136,662 / 40,015,188 / 54,357,147 bytes) |
| 10 hours, readable | rebuilt | rejected, error 3013036 |

A second 2×2 on one clip (movie duration × audio resampled to 48 kHz or left at 44.1 kHz) moved with the duration field only. Stripping editor metadata did nothing once duration was correct. Web "HD by default" was on for the 576p controls, so that toggle does not select passthrough.

This is the cleanest public A/B. It is still one vendor, one account, 1080p60 only, not re-run here. Their inference: an unreadable duration gives the ladder job nothing to size, so the file is stored as-is. The 10-hour rejection shows the field is read when the value is a number.

**6. That duration trick is not how this Haze file got `original_2160_0`.**  
The served reference has `mvhd` version 0 and duration 33237. zaclip's hash match shows TikTok stores the container as uploaded when it takes the passthrough path (it does not repair the duration). If Haze had written an unknown duration, the file we downloaded would still have one. It does not. Unknown duration is sufficient in their test and unnecessary for at least this one 4K passthrough.

**7. What the live Haze file actually is.**  
Public Haze API (`GET https://api.hazemethod.xyz/engine/backend?audio61=1`, 10 Nov 2026 08:50 UTC): backend `self`, default engine `6.2` "Haze Max" `working`, `5.5` "Haze Classic" `fixing` ("use Haze Max"), Lite `working`. `GET /status`: `maintenance` false, `patched` false, `freeMode` false, `operational`. Their API docs say the engine returns a plan for the header only; the client stitches that plan onto the original `mdat`. Picture samples are not re-encoded. Lite is described as playing at up to 720p 60 fps. Max is the HDR engine and is not on the public API yet (the API lists Classic and Lite). Plan ops themselves are not in the public client; a same-day read of that client found layout checks and the encoder string, not the numeric box writes.

The file TikTok stored, which is therefore the file they accepted, has all of the following. Which of them the plan wrote, and which Premiere already wrote, is not separated here:

- HEVC Main 10, high tier, level 5.1, 10-bit 4:2:0, constant 60 fps, no B-frames, ~46.5 Mbps, 2160×3840 with a 2176 coded width (crop).
- HDR10 in the HEVC VUI only (primaries bt2020, transfer smpte2084, matrix bt2020nc, tv). No `colr` box. ffprobe still reports the VUI.
- AAC-LC, 48 kHz, stereo, ~314 kbps, two sound tracks sharing the timeline, `tkhd` flags 1 on both.
- Brands `mp42`/`mp41`, `moov` after `mdat` (not faststart), Mainconcept handler names, video `tkhd` flags 7.
- Movie 387 ms longer than the video track. Edit lists were not needed for ffprobe to get a normal duration.
- A 102-byte second `mdat` of a repeated 6-byte pattern, purpose unknown.
- `udta` / `©too` = `Haze Quality Method https://hazemethod.xyz`. Their client treats that string as the already-processed marker. It is a watermark. The tag alone cannot be the switch: it survives because the file was stored, it does not explain why the ladder was skipped.

Haze's posting rules that match this post: Everyone, not private; no TikTok sound added; file not re-exported after the header step; not the phone app. Their help page also says a phone gallery may show 0:00 or picture-less audio after Lite, Classic, or Max. This served file does not do that to ffprobe, so the 0:00 behavior is another engine output, not this one.

**8. The ladder skip is a quirk and gets closed.**  
Haze marks an engine Patched or Fixing when a TikTok change stops it, and refuses it until they ship another. Classic is Fixing today; Max is the one they tell people to use. NoBlur's issues (Aug 2026) say the ghost-frame uploads started sticking on "Processing" and getting forced to Only you even when the poster chose public. A comment there says Haze was still posting after that. Treat any current engine as temporary.

**9. "Allow high-quality uploads" / web HD-by-default changes the ladder preset, not the passthrough decision.**  
ShortSync and a lot of creator advice treat the toggle as the difference between a soft transcode and a sharper one. zaclip's controls had it on and still came back 576×1024 at 30 fps until the duration field changed. It is not a substitute for the skip, and it is not what made the reference 4K.

### Low

**10. Account size, verification, region.**  
This passthrough is on an unverified account with ~32 followers, posting from a `TR` location tag, with 37k plays on the video. Nothing in the page JSON marks a creator tier. `VQScore` 0 means it was not "a high quality score unlocked 1080p". Region and account are not ruled out (every hash test so far is one account), but they are not required by anything we can see on this post.

**11. Bitrate and "upload 1080 H.264 SDR" guides.**  
ShortSync: 1080×1920, H.264, 10–15 Mbps at 30 fps or up to ~25 Mbps at 60 fps, AAC 256 kbps, and they explicitly say not to send HEVC because TikTok will re-encode it. The Post Flow: don't upload 4K, H.264 High, ~8–16 Mbps, SDR only, HDR gets a bad tone map. Post Mate: above ~12 Mbps gets hit harder. Those guides describe how to feed the **ladder**. They contradict the reference, which is 4K HEVC Main 10 HDR at ~46 Mbps and was not re-encoded. High bitrate is not a published TikTok rule, and "higher bitrate gets a gentler transcode" does not explain a 46 Mbps source being returned intact.

**12. Ghost-frame sample tables.**  
Exact code is in the next section. The theory in those READMEs is that a much larger declared sample count makes TikTok skip a heavy transcode or assign 1080p60. The reference has 1971 real frames, so this is not that method. NoBlur issues say TikTok was already blocking it in August 2026. Confidence that it ever produced passthrough is low: the published "proof" is a screenshot and a Telegram bot, not a `bitrateInfo` dump, and we did not re-test it.

**13. HDR, 10-bit, or Mainconcept as a requirement.**  
The working sample has all three. Haze markets Max as the HDR engine, and their client accepts `avc1`/`avc3`/`hvc1`/`hev1` (and Dolby Vision sample entries on some engines). They detect HDR; they do not, in the public docs, require it. Our SDR and H.264 re-encodes failed, but they were also Only me posts and they were not this container, so the test does not isolate color or codec. A fake HDR tag (SDR pixels labeled PQ) is a known way to get a bad picture if the ladder does run; it is not evidence that honest HDR is the switch.

**14. Post private, then flip to public.**  
Reddit is split: one paid "Studio, private, then public" pitch was called a scam after the buyer was told only that; another creator says private-then-public holds quality but buffers. Vague Transcode's Pulse blurb says leave a post private for 30–60 seconds, then make it public. That product re-encodes on their server, and the tip conflicts with Haze's current "don't post private" line. No hash test supports the flip.

## Exact file changes in open code

These are competitors and clones. None of them emit the reference file. Listed so a later test can tell their outputs apart from a Haze Max file.

### zaclip — movie duration unknown

Public site, logic in https://zaclip.com/src/mp4/build.js and `remux.js` (cache `v=2f17e390` on 10 Nov 2026). Not a GitHub repo. Samples are copied. The deliberate change is `mvhdUnknownDuration`, quoted above: version-1 `mvhd`, 64-bit duration all `0xFF`, track durations untouched. Optional and off by default: drop `udta` and zero creation/modification times. The remux also moves `moov` before `mdat`, re-interleaves at ~0.5 s chunks, and rewrites handler names. Their own A/B says only the duration field changes the TikTok result.

### `BastienGimbert/tiktok-quality` — Editing News ghost frames

https://github.com/BastienGimbert/tiktok-quality (MIT, `src/tiktok_quality/transform.py`, `mp4/builder.py`). Claims a byte match to the Editing News extension v2.1.4 server at `v2.editingnews.com`. H.264 only in this code. Default multiplier 10. It does **not** copy the container; it rebuilds it:

1. `ftyp` brand `isom`, minor 512, compatible `isomiso2avc1mp41`.
2. Order becomes `ftyp` + 8-byte `free` + `moov` + `mdat`.
3. First video sample: NAL units kept only if type is 1 or 5 (non-IDR slice, IDR). SEI and other NALs in that sample are dropped.
4. `avcC` payload gains four bytes `fd f8 f8 00`.
5. Video `stts` becomes two runs: `orig_frames` at the original delta, then `orig_frames * (multiplier-1)` at the same delta. Declared duration grows by the multiplier. Video `mdhd` / `tkhd` durations are copied, not extended, so the sample table and the media header disagree.
6. `stsz` appends that many 8-byte sizes.
7. `stsc` gains one entry: first chunk = old chunk count + 1, one sample, description index 1.
8. Those extra chunks all point at one shared filler at the end of `mdat`.
9. Filler is 8 bytes: `00 00 00 04 00 00 00 00` (length 4, NAL type 0).
10. Audio handler rebuilt as `soun` / `SoundHandler`. Audio `mdhd` language set to `und` (`0x55C4`).
11. Audio `stts` last sample delta rewritten so the sum matches the edit-list duration; `tkhd` / `mdhd` audio durations updated to that.
12. `udta`/`meta`/`ilst`/`©cmt` comment. Default text `TK8vY5VqBA6hUlo1yuGvNA`.
13. `btrt` average bitrate recomputed from the (SEI-stripped) video bytes over the old duration. Audio bitrate fields rewritten the same way.

`stss`, `sdtp`, and `ctts` are copied if present. No duration is set to unknown.

### `irgifebry/NoBlur` — same idea, more codecs, in the browser

https://github.com/irgifebry/NoBlur (`src/mp4-normalize.mjs`, `src/mp4-inflate.mjs`, called from `app.js`). `app.js` calls `inflateSampleTableVideo(..., 10)` after normalize. The function's own default of 5 is not what the app uses.

Normalize, only if `moov` is after `mdat` or the major brand is not `isom`:

- H.264 `ftyp` (28 bytes): major `isom`, minor `0x200`, compatible `isom` `iso2` `mp41`.
- HEVC `ftyp` (32 bytes): major `iso4`, minor `0x200`, compatible `isom` `iso2` `hvc1` `mp41`.
- Then `moov`, then `mdat`, chunk offsets shifted.

Inflate, video track only:

- `stts` replaced by two runs at the average sample delta: real count, then `realCount * 9` fakes.
- `stsz` copies real sizes and appends dummy sizes. Dummy size by sample-entry fourcc: `avc1`/`avc3` 8, `hvc1`/`hev1` 16, `vp09` 4, `av01` 4, `mp4v` 8, else 8.
- `stsc` gains a final entry (first chunk = old chunk count + 1, 1 sample, description index 1).
- `stco` or `co64` grows by the fake count; every fake chunk offset is the original file size plus the `moov` growth (the dummy bytes are appended at EOF, and they are **not** one shared filler: padding length is `fakeCount * dummySize`).
- Parent `stbl`/`minf`/`mdia`/`trak`/`moov` sizes grow to match. If `moov` was already before `mdat`, other tracks' chunk offsets are shifted by the `moov` growth.

No encoder tag, no `avcC` append, no SEI strip, no audio-language change. A second mode re-encodes with ffmpeg.wasm (`minterpolate` to 60 fps, libx264 CRF 20, ultrafast, audio copy) and then runs the same inflate. That mode is a re-encode.

Issues on that repo (Aug–Oct 2026) report uploads stuck on Processing, forced to Only you, or rejected. That is the current public status of this recipe, not a lab result of ours.

### `paschafps/TikTok-Quality-Method` — timestamp scale, copy codecs

The git tree is a README only. Release `v2.0` (`TikTokQualityMethod_v2.zip`) is a batch file. The ffmpeg line is:

```
ffmpeg -y -itsscale <N> -i input -c:v copy -c:a copy output.mp4
```

`N` is 2, 6, or 12 from the menu. `-itsscale` multiplies input timestamps and does not re-encode. There is no box-level edit beyond what ffmpeg writes when it remuxes. No measurement of the TikTok result is in the repo.

### Haze — not this code

Public contract (`https://tikhaze.com/api-docs`, `https://tikhaze.com/docs`): one `ftyp`, one `moov`, one `mdat`, no `moof`, header ≤ 16 MB, H.264 or HEVC, AAC for Lite. The plan is applied to the header; `mdat` byte ranges are copied. Engines named in the client from the same-day JS read: 5.5, 6.0, 6.1, 6.2, Lite. Codecs on 6.0/6.1 include Dolby Vision sample entries (`dvh1`/`dvhe`); the others are `avc1`/`avc3`/`hvc1`/`hev1`. A second copy is rejected when `udta` already contains their encoder string. That read did not find hardcoded `mvhd`/`mdhd` timescale edits or a `colr` rewriter; those would live in the plan, which we did not fetch.

The live reference matches none of the clone recipes above (readable version-0 duration, `mp42` not `isom`/`iso4`, `moov` at the end, no inflated `stts`, Mainconcept names, Haze `©too`, second `mdat`). Copying tiktok-quality or NoBlur will not produce this file.

## Do Only me posts get HD at all?

**Not on the evidence we have.** The original-gear post is public. Only me, for the files the team already posted, produced a single 540p 576×1024 rendition and nothing else.

| Evidence | What it says | Confidence |
| --- | --- | --- |
| This reference | `privateItem` false, `secret` false, `forFriend` false, and the player exposes `original_2160_0` | High for this post |
| Haze help, "Still not HD after posting" | Don't post private. Set Who can watch to Everyone | High as their rule; they would not write it if private worked for them |
| Team Only me tests (re-encoded H.264 1080×1920, and SDR copies) | One rendition, 540p, 576×1024 | High for those files. They were not this HEVC file, so they don't prove a Haze file would also fail Only me |
| NoBlur issues, Aug 2026 | Ghost-frame posts forced to Only you or stuck processing, even if the user picked public | Medium, and it is a quarantine, not "private gets HD" |
| Reddit / Vague Pulse | Private first, public later, might hold quality | Low, contradicted by Haze's current text, no hashes |

We did not open an Only me post. The earlier attempt to pull a private test upload failed with an IP block, and this pass did not log in. So the remaining hole is: the same Haze file, posted twice, Only me versus Everyone. Until that exists, the working assumption is that Only me never leaves the single 540p transcode, and that the visibility flag is read at post time. Flipping a private post to public later is not a documented fix and is not what Haze tells people to do.

## Most likely exact conditions

For a post to be served the way this reference is served:

1. The file that hits TikTok is the prepared file. Desktop Studio or the posting API. Not the phone app, not an in-app sound, trim, or filter, not a second export.
2. Visibility is Everyone at post time. Only me stays on one ~540p H.264 rendition (576×1024 in the files already measured).
3. The file is inside the published ingest window (non-fragmented MP4 or MOV, H.264 or HEVC, 23–60 fps, sides 360–4096, duration that does not parse as over 60 minutes, under 4 GB) so the upload is accepted rather than rejected.
4. Something about the container makes the ladder job not run. The proven public switch is a version-1 `mvhd` whose 64-bit duration is all `0xFF`, with track durations left intact (zaclip's hashes). The Haze reference did **not** use that switch and was still stored intact, so at least one other container shape also skips the ladder. The shape TikTok actually stored for that post is the Premiere HEVC Main 10 file described above: readable 33.237 s movie duration, real 1971-frame table, HDR10 in the VUI, `mp42`, `moov` at the end, audio tracks flagged enabled but not in-movie, the extra 102-byte `mdat`, and their `©too` tag. Which of those fields the scheduler keys on is not known. Ghost-frame tables are a third, separate recipe and are not this file.
5. You can tell which path you got without guessing from sharpness. Passthrough: one gear, name `original_<n>_0`, `QualityType` 10000, `encodedType` `original`, `VQScore` 0, empty transcode id, byte size and encoder tag of the upload. Ladder: `encodedType` `normal`, gears `normal_*` / `adapt_*` / `lowest_*`, `QualityType` in the small integers (2, 14, 20, 25, 28 in the sample), bitrates near 1–3 Mbps, and a 1080p rung only if they emitted one. "HD" in a product sense has to mean the first of those, or a 720/1080 gear will be counted as success when the picture was still re-encoded.

What is not required, because this passthrough file doesn't have it and the failed ladder files did, or because a control already knocked it out: faststart, brand `isom`, a TikTok-style JSON encoder block, `colr` nclx, unknown movie duration, inflated sample tables, a large or verified account, and the high-quality-upload toggle by itself.

## What would falsify this

- The same bytes posted Only me showing `original_*` in the owner's own page JSON. That would drop the visibility rule.
- A Haze-tagged file whose `mvhd` duration is all `0xFF`. We don't have one; if the next served Haze file is version-1 unknown duration, then Max learned the zaclip switch and this reference was an older path.
- A correct-duration, single-audio, faststart H.264 file with no other header oddity coming back as `original_*`. That would mean the skip is account- or route-level and the container work is irrelevant. zaclip's rebuilt-but-correct-duration control is the evidence against that, on one account.
- This reference later growing `adapt_*` gears or losing the Haze tag. Processing is not always finished in the first minutes (zaclip saw numbers move after an hour). This post was a day old and still a single original gear, which is past that window, but a later re-encode is still possible if they backfill popular videos.

## Sources

Measured here:

- Page JSON and download of https://www.tiktok.com/@yessirskiedt/video/7706265753510546695 on 10 Nov 2026.
- `GET https://api.hazemethod.xyz/status` and `GET https://api.hazemethod.xyz/engine/backend?audio61=1` the same morning.
- Public JS: https://zaclip.com/src/mp4/build.js and https://zaclip.com/src/mp4/remux.js
- Public repos: https://github.com/BastienGimbert/tiktok-quality , https://github.com/irgifebry/NoBlur (including issues 2 and 6), https://github.com/paschafps/TikTok-Quality-Method release v2.0.

Haze, in their own words:

- https://tikhaze.com/docs (posting rules, private vs Everyone, app vs Studio, sounds)
- https://tikhaze.com/api-docs (header-only plan, engines, Lite's 720p ceiling)
- https://tikhaze.com/guides/what-is-haze-method
- https://tikhaze.com/guides/editing-news-alternative
- https://hazemethod.xyz/

Other public write-ups:

- zaclip tests: https://zaclip.com/guides/tiktok-upload-without-compression/ and https://zaclip.com/how-it-works/
- TikTok ingest spec: https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide
- Normal ladder dump: https://jpfefferlab.github.io/tiktokscraper/04_source.html (item `7420162633292205342`)
- Second ladder example: https://tbar-dl.com/video-sites/tiktok
- yt-dlp gear parsing and the 540-vs-576 note: https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py and https://github.com/yt-dlp/yt-dlp/issues/16532
- Editing News marketing (1080p60, no 4K claim on the page we saw): https://www.editingnews.com/
- ShortSync's ordinary-export guide, including their roundup of named methods: https://www.shortsync.app/resources/tiktok-upload-method-high-quality
- Upload120's own Studio guide (ladder-oriented: 1080p, H.264, AAC, bitrate at or under 20 Mbps, high-quality uploads left on): https://upload120.com/guides/upload-high-quality-tiktok/
- Reddit threads with the private-then-public claim and a CompressBase/WMV anecdote: https://www.reddit.com/r/VideoEditing/comments/1iqs5ry/tiktok_uploadind_method/ and https://www.reddit.com/r/upscaling/comments/1w4b15i/uploading_in_1080p60fps_to_tiktok_primarily/
- Visibility help (Everyone / Friends / Only you): https://support.tiktok.com/en/account-and-privacy/account-privacy-settings/video-visibility
- Stringers' note on Haze Check, including that they found no independent test of frame rates above the documented 60 fps cap: https://stringers.io/en/ext/chrome_gedohbknhnnjlamppdffclmbmeifdaco.html

Internal, not re-run this pass: the Only me 540p results, and the same-day read of Haze's client that found layout checks and the encoder string but not the plan's box writes. The private test file could not be re-downloaded (IP block, no login).
