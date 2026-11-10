# u120-haze

Rebuild an H.264 or HEVC + AAC MP4 so the container matches the file TikTok is serving for the Haze example. Picture and audio sample payloads are copied. Nothing is re-encoded.

```
python3 u120_haze.py INPUT.mp4 OUTPUT.mp4
python3 validate.py --input INPUT.mp4 --output OUTPUT.mp4 --reference HAZE.mp4
```

`validate.py` prints an atom-by-atom path diff and a track-by-track field diff against the reference, and a SHA-256 of every sample against the input. Exit status is non-zero if a sample changed, the layout rules failed, or SDR input came out with HDR signaling.

The encoder tag written into `©too` is `Upload120 Studio Method https://upload120.com`.

`make_samples.sh` regenerates the short SDR test inputs in `artifacts/`. The `.out.mp4` files and `.validate.txt` reports next to them are the runs checked in with this tool.
