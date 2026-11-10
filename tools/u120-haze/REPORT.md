# Haze layout replica

The tool in this directory copies an H.264 or HEVC + AAC MP4 and rewrites the container around those samples. It does not re-encode. Checked against the file TikTok serves for `https://www.tiktok.com/@yessirskiedt/video/7706265753510546695` (192,532,067 bytes, HEVC Main 10, 2160×3840, 60 fps, AAC-LC).

## What the tool changes

From a normal ffmpeg file it writes:

- `ftyp` major `mp42`, minor 0, compatible brands `mp42`, `mp41`.
- Sample data first, then a 102-byte `mdat` whose payload is `21 10 04 60 8c 1c` repeated 17 times, then `moov`.
- Creation and modification times set to 0. Movie timescale 1000. Video media timescale 60000, with `stts` / `ctts` scaled by the same ratio. Audio timescale left at the AAC rate (48000 on every file tested here).
- One edit per track, `media_time` 0, rate 1. When the video edit had been skipping a positive media time, that value is subtracted from the composition offsets so the first displayed frame stays at time 0.
- Video track flags 7. Both audio track flags 1. Alternate group 0. Track ids 1, 2, 3 and `next_track_id` 4.
- A second AAC track that points at the same chunk offsets and sample sizes as the first. If the input already has that pair, it is kept, including a second `mp4a` sample entry and a different last `stsc` description index.
- `sdtp` on the video track: `0x24` on sync samples, `0x10` on the others.
- The visual compressor name cleared.
- SEI NAL arrays removed from `hvcC` only. Sample payloads are not opened.
- Movie `udta` replaced by a single `©too` / `data` (UTF-8) tag: `Upload120 Studio Method https://upload120.com`.

Handlers, `colr`, `pasp`, `btrt`, `fiel`, language, and the parameter sets themselves are kept.

## Proof the samples did not change

| file | video samples | audio samples | decoded picture MD5, input and output |
| --- | --- | --- | --- |
| HEVC Main 10 3840×2160 60 fps, bt709 | 120/120 | 95/95, both tracks | `8fe05170dd25c413b171c87ce0d4e143` |
| H.264 High 1920×1080 60 fps, bt709, B-frames | 120/120 | 95/95, both tracks | `1eb1e870a64255a2a787984acc6da891` |
| H.264 High 1280×720 60 fps, bt709 | 60/60 | 48/48, both tracks | `ed3286fd6b65e2d6e0c09ee811e9be34` |
| the served reference, retagged | 1971/1971 | 1558/1558, both tracks | not re-decoded; sample hashes match |

ffprobe on the HEVC output is still `hevc Main 10, yuv420p10le, bt709/bt709/bt709, tv, 60/1`. The H.264 output is still `High, yuv420p, bt709/bt709/bt709, 60/1`. No HDR signaling was added.

Running the tool on the served file changes 3 bytes of payload plus the size fields that contain them. Atom paths are identical (72 shared, none added, none removed). The only text change is `©too`, from `Haze Quality Method https://hazemethod.xyz` (42 bytes) to our tag (45 bytes). The 17 audio samples that live in the second `mdat` stay addressed and hash-identical. `stsc` description index 2 on the first audio track's last chunk is preserved.

## Diff against the served file

Layout fields that match on the ffmpeg outputs: `ftyp`, top-level order, the 102-byte `mdat` bytes, zero times, movie timescale 1000, video timescale 60000, audio timescale 48000, edit `media_time` 0, video flags 7, audio flags 1, identity matrices, two audio tracks sharing offsets, `sdtp` present, only our `©too`, `next_track_id` 4.

Fields that differ because the media is different, not because the layout step missed them: durations, dimensions, sample counts, `stts` row counts, language (`und` vs `eng`), handler name (`VideoHandler` / `SoundHandler` vs Mainconcept Pascal strings), codec (`avc1` vs `hvc1` on the H.264 tests), `hvcC` bytes, `colr` / `pasp` / `btrt` / `fiel` present here and absent there.

On the HEVC test, after the SEI array is removed, `hvcC` is 3 arrays, profile 2, level 153, 10-bit 4:2:0, 113 bytes. The reference record is the same shape at 118 bytes, with tier High instead of Main. That bit is inside the SPS.

The reference's second `mdat` is not an unused marker. Its 102 bytes are 17 audio samples of 6 bytes each (`21 10 04 60 8c 1c`), in chunks 199 and 200. 1,541 real AAC frames stay in the big `mdat`; those 17 sit in the small one. The first audio track's last chunk uses sample-description index 2 (the longer `esds`). The tool writes the same 102 bytes on every output. It only points sample tables at them when the input already did. Inventing 17 new audio samples would make the sample list differ from the input.

Full trees and field tables: `artifacts/*.validate.txt` and `artifacts/reference-retag.validate.txt`.

## What cannot be matched without changing sample bytes

These are properties of the Mainconcept bitstream in the served file. Copying samples cannot create them, and forging them in the headers would either rewrite NALs or describe a stream the encoder did not produce.

- Every reference frame starts with an access-unit delimiter (HEVC NAL 35). The test samples do not.
- Parameter sets are repeated in-band on each reference sync sample (NAL 32/33/34). The test samples only carry them in `hvcC`.
- Reference sync NALs are IDR_W_RADL (19), every 30 frames. The HEVC test has one IDR_N_LP (20) and one CRA (21). There is no SEI in the reference samples. The H.264 tests still contain one AVC SEI (NAL 6) inside a sample.
- Color in the reference comes from the HEVC VUI: bt2020 / smpte2084 / bt2020nc, tv. The test inputs are SDR bt709 in both the VUI and a `colr` box. The tool does not retag that.
- SPS details that follow from the encoder (tier, cropping, CTU, reference picture sets) live in those parameter-set bytes.
- B-frames, when the source has them, keep their composition offsets. The reference has none.
- Handler names, the `alis` data handler, and the second `mp4a` decoder config are Premiere leftovers. They are preserved when the input already has them (the retag run) and are not synthesized onto an ffmpeg file.
- AAC priming: ffmpeg's edit list skips one frame (`media_time` 1024). The tool sets `media_time` to 0, so that priming frame is inside the presented duration (about 21 ms). The sample bytes are unchanged. The served file was already at `media_time` 0.

Nothing here was uploaded or posted.
