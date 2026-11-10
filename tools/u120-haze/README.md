# u120-haze

Copy an H.264 or HEVC + AAC MP4 and add the audio structure that makes TikTok serve the original file. The picture is not re-encoded. Video sample payloads and the video sample entry stay as the source wrote them.

The default adds three things, the same three on the served Haze and ShoreUploader files:

- a second AAC track that points at the same samples
- a second `mp4a` entry on the first audio track, AudioSpecificConfig `11 80 04 c0 40 00 20 00` (one side pair, no front channel)
- 17 silent AAC frames, `21 10 04 60 8c 1c`, stored in a second `mdat`. The last 8 use the second sample entry. The duplicate track keeps every frame on entry 1.

```
python3 u120_haze.py INPUT.mp4 OUTPUT.mp4
python3 validate.py --input INPUT.mp4 --output OUTPUT.mp4 --reference HAZE.mp4
```

`validate.py` checks that structure, prints an atom-by-atom and track-by-track diff against the reference, and hashes every sample against the input. Exit status is non-zero if a video sample changed, the original audio samples changed, the silent tail or the side-pair config is missing, or SDR input came out with HDR signaling.

Audio must be stereo AAC-LC at 48000 Hz. That is the rate the fixed config describes.

Each step can be switched off for a private comparison: `--no-silent-frames`, `--no-second-entry`, `--no-duplicate-audio`, `--keep-flags`, `--keep-times`, `--keep-ftyp`, `--faststart`, `--no-tag`. `--sdi2-count 7` puts the last 7 silent frames on the second entry instead of the last 8.

The `©too` tag written by default is `Upload120 Studio Method https://upload120.com`.

`make_samples.sh` regenerates the short SDR test inputs in `artifacts/`. The `.out.mp4` files and `.validate.txt` reports next to them are the runs checked in with this tool.
