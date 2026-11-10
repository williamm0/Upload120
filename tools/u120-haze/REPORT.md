# Audio structure that makes the original file the one served

The tool in this directory copies an H.264 or HEVC + AAC MP4 and adds the audio structure confirmed on four served Haze and ShoreUploader files. TikTok's audio ingest fails on that structure, and the picture is then the file that was uploaded. The tool does not re-encode, and it does not rewrite video sample bytes or the video sample entry.

Checked against the file TikTok serves for `https://www.tiktok.com/@yessirskiedt/video/7706265753510546695` (192,532,067 bytes).

## What the default run changes

From a normal ffmpeg file it writes:

- A second AAC track with the same `stco`, `stsz`, and `stts` as the first. `next_track_id` becomes 4.
- A second `mp4a` in the first audio track. Its `esds` uses the padded `80 80 80` descriptor lengths, and the DecoderSpecificInfo is exactly `11 80 04 c0 40 00 20 00` (AAC-LC, 48 kHz, channel config 0, program config with one side pair and no front). The duplicate track keeps the single original entry.
- 17 silent stereo AAC frames, `21 10 04 60 8c 1c` (6 bytes each), appended after the real audio in a second `mdat`. They are two chunks, 9 then 8. The chunk of 8 uses sample entry 2 on the first audio track and sample entry 1 on the duplicate. 17 × 1024 / 48000 is 0.3627 s, so the audio edit ends about 0.36 s after the picture.
- `ftyp` major `mp42`, minor 0, brands `mp42`, `mp41`. Media data immediately after `ftyp`, the silent `mdat` next, `moov` last.
- Creation and modification times set to 0. Video track flags 7, audio track flags 1. The movie timescale, the video timescale, and the video edit list stay as the source wrote them. The movie duration follows the longer audio edit.
- `©too` replaced with `Upload120 Studio Method https://upload120.com`.

Video sample tables, the compressor name, `hvcC` (including any SEI array the encoder stored there), `sdtp`, `colr`, and the parameter sets are left alone. Chunk offsets move only because the `mdat` moves.

A file that already has this tail, the side-pair entry, and the shared second track is not given a second copy of any of them. Running the tool on the served file changes the tag text and the size fields that contain it: 192,532,067 bytes becomes 192,532,070. Atom paths are identical (72 shared, none added, none removed). All 1,971 video samples and all 1,558 audio samples hash the same, including the 17 frames that already live in the second `mdat`. Running it again on one of our own outputs is byte-identical.

`--sdi2-count 7` is the other split seen in the ShoreUploader files (last 7 frames on entry 2). The default is the Haze split of 8. `--no-silent-frames`, `--no-second-entry`, and `--no-duplicate-audio` each remove one of the three pieces.

## Proof the picture did not change

| file | video samples | audio | decoded picture MD5, input and output |
| --- | --- | --- | --- |
| H.264 High 1920×1080 60 fps, bt709, B-frames | 120/120 | 95 original + 17 silent, both tracks | `1eb1e870a64255a2a787984acc6da891` |
| HEVC Main 10 3840×2160 60 fps, bt709 | 120/120 | 95 original + 17 silent, both tracks | `8fe05170dd25c413b171c87ce0d4e143` |
| H.264 High 1280×720 60 fps, bt709 | 60/60 | 48 original + 17 silent, both tracks | `ed3286fd6b65e2d6e0c09ee811e9be34` |
| the served reference, retagged | 1971/1971 | 1558/1558, both tracks | sample hashes match |

The video sample entry is byte-identical to the input on each of those, including the 2,401-byte `hvcC` (4 arrays) on the HEVC test. ffprobe on that output is still `hevc Main 10, yuv420p10le, bt709/bt709/bt709, tv, 60/1`. The 1080p output is still `h264 High, yuv420p, bt709/bt709/bt709, 60/1`. No HDR signaling was added.

On the 2-second files the audio edit is 2362 ms and the video edit is 2000 ms. On the 1-second file the audio edit is 1362 ms and the video edit is 1000 ms. The gap is the 17 silent frames. ffmpeg's one-frame priming (`media_time` 1024) stays where the source put it.

## How the audio lines up with the served file

Same on our outputs and on the reference:

- two audio tracks, shared sample offsets and sizes
- first track `stsd` is two `mp4a`, second track is one
- second entry's AudioSpecificConfig is `11 80 04 c0 40 00 20 00`, written with padded descriptor lengths
- last 17 samples are `21 10 04 60 8c 1c`, in the second `mdat`
- first audio track: chunk of 9 on entry 1, chunk of 8 on entry 2 (`stsc` last index 2, then 1 on the duplicate)
- audio timescale 48000, flags 1, video flags 7, `next_track_id` 4, `ftyp` `mp42`/`mp41`, `moov` at the end

Different because the media is different: durations, frame size, sample counts (95+17 here, 1541+17 there), language, handler name, codec, `hvcC` bytes, and the extra `colr` / `pasp` / `btrt` boxes ffmpeg writes. The reference video edit starts at media time 0; ffmpeg's starts at 512 (video) and 1024 (audio). Those values are left as the encoder wrote them.

## What stays a property of the source bitstream

Once audio ingest fails, the served picture is the uploaded picture. These differences are in the coded samples. Copying the samples keeps them, and they are not part of the audio structure:

- The reference frames start with an access-unit delimiter and repeat parameter sets in band. The test samples do not.
- Reference sync NALs are IDR_W_RADL. The HEVC test has one IDR_N_LP and one CRA. The H.264 tests still contain their SEI inside a sample.
- The reference color comes from the HEVC VUI (bt2020 / smpte2084 / bt2020nc). The test inputs are SDR bt709 in the VUI and in `colr`. The tool does not retag that.
- B-frames, when the source has them, keep their composition offsets.
- Handler names stay `VideoHandler` / `SoundHandler` on an ffmpeg file, and the Mainconcept names on the served file.

Nothing here was uploaded or posted.

Full trees and field tables: `artifacts/*.validate.txt` and `artifacts/reference-retag.validate.txt`.
