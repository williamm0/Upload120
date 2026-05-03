# Upload120

**Patch MP4 videos for 60/120 fps TikTok uploads — with a built-in post composer.**

Upload120 rewrites two metadata fields inside an MP4 (`mvhd` and `mdhd`) so TikTok's upload pipeline sees the video as standard-rate footage. Your real frames pass through untouched, but the platform preserves the full 60/120 fps for playback — and the compression path is significantly softer, meaning noticeably sharper video too.

<img width="2500" height="1080" alt="Upload120" src="https://github.com/user-attachments/assets/8d6181ee-750e-442f-8dba-2c2350df3cfc" />

---

## Features

- **One-click patching** — drop a video, pick a multiplier, process. Done in seconds.
- **Batch processing** — queue multiple files and process them all at once.
- **120 fps default** — 4× multiplier pre-selected for 120 fps sources.
- **Auto multiplier** — optionally let the app pick the right divider per file.
- **Built-in TikTok composer** — log in once, then attach your video, write a caption, set privacy/comments/duet/stitch, and post without ever opening a browser.
- **Saved hashtag library** — build a tag bank and add tags to any caption with one click.
- **Auto-post** — the app silently drives the TikTok web pipeline and clicks Post for you.
- **Progress tracking** — live stage indicator from "attaching file" through "posted ✓".
- **History** — recent patched files listed in Settings, click to reveal in Finder/Explorer.

---

## How It Works

MP4 files store timing in two header atoms:

| Atom | Role |
|------|------|
| `mvhd` | Movie header — overall timescale + duration |
| `mdhd` | Media header (per track) — track timescale + duration |

Upload120 divides both timescale and duration by your chosen multiplier (default 4×). The frame data is unchanged — only the metadata that describes *when* each frame plays.

TikTok reads the rewritten headers and treats the file as 30 fps footage. Because it distributes its bitrate budget over fewer *apparent* frames, each real frame gets more data. The file also skips TikTok's high-FPS temporal-smoothing pipeline (which normally blends or drops frames at 60+ fps).

**Three quality improvements stack up:**

1. **Higher per-frame bitrate** — same bitrate budget over 4× fewer apparent frames = sharper detail, less blocking, less banding.
2. **Softer compression path** — the high-FPS pipeline is bypassed; your original frames pass through closer to source.
3. **Reduced motion-quantisation** — apparent "slow motion" means calmer motion vectors; edges and textures stay clean.

> The patched file must be uploaded from a **computer**. The TikTok mobile app forces a re-encode that resets the metadata regardless.

---

## Installation

https://github.com/user-attachments/assets/3ab280cd-3fd2-4e6b-98fa-f0cae628a9c4

### macOS

Download the latest `.dmg` or `.pkg` from [Releases](../../releases) and open it.

- **DMG** — drag Upload120 to your Applications folder.
- **PKG** — double-click and follow the installer. **Best alternative**

> macOS will warn about an unnotarised app. Right-click the app and choose **Open** to proceed.

### Windows

Download the `.exe` installer from [Releases](../../releases) and run it.

A portable `.exe` (no install needed) is also available.

---

## Building from Source

```bash
git clone https://github.com/jxffx/upload120
cd upload120
npm install

# Run in dev mode
npm run dev

# Build macOS (arm64)
npm run build:mac

# Build Windows (x64) — requires Wine on macOS/Linux
npm run build:win
```

Artifacts land in `dist/`.

---

## Usage

1. **Patch tab** — drop your video (or click *choose files*). Select a multiplier. Click **Process**.
2. **Post tab** — click the arrow icon on any done item, or pick a file manually. Connect TikTok once (session is saved). Write your caption, add hashtags, set options, and click **Upload to TikTok**.
3. Upload120 silently drives TikTok's web pipeline. Progress is shown in the app. No browser window opens.

---

## Credits

Made by [jx](https://jxffx.com) · [jxffx.com](https://jxffx.com)

Inspired by the original [120fps-method](https://github.com/ut0ku/120fps-method) by ut0ku. Reimplemented from scratch with a proper ISO BMFF atom-tree parser, batch processing, a built-in composer, and a refined interface.

Everything runs locally. No uploads, no telemetry, no data leaves your computer.

---

## License

MIT — see [LICENSE](LICENSE).
