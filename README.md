# Upload120

**Patch MP4 videos for 60/120 fps TikTok uploads, with a built-in post composer.**

Current version: **1.1.0**

Upload120 rewrites two metadata fields inside an MP4 (`mvhd` and `mdhd`) so TikTok's upload pipeline sees the video as standard-rate footage. Your real frames pass through untouched. In testing, this can help preserve high-FPS playback and reduce some of the harsh compression that often happens to 60/120 fps uploads.

<img width="2500" height="1080" alt="Upload120" src="https://github.com/user-attachments/assets/8d6181ee-750e-442f-8dba-2c2350df3cfc" />

## Download

Download the latest macOS or Windows build from [Releases](../../releases).

The patched file should be uploaded from a **computer**. The TikTok mobile app may re-encode the file and reset the metadata.

## Features

- **One-click patching**: drop a video, pick a multiplier, process it in seconds.
- **Batch processing**: queue multiple files and process them together.
- **120 fps default**: 4× multiplier pre-selected for 120 fps sources.
- **Auto multiplier**: optionally let the app pick the right divider per file.
- **Built-in TikTok composer**: log in once, attach your video, write a caption, set privacy/comments/duet/stitch, and post without opening a browser.
- **Saved hashtag library**: build a tag bank and add tags to any caption with one click.
- **Auto-post**: the app drives the TikTok web pipeline and clicks Post for you.
- **Progress tracking**: live stage indicator from attaching the file through posting.
- **History**: recent patched files listed in Settings, click to reveal in Finder/Explorer.

## How it works

MP4 files store timing in two header atoms:

| Atom | Role |
| --- | --- |
| `mvhd` | Movie header: overall timescale and duration |
| `mdhd` | Media header: per-track timescale and duration |

Upload120 divides both timescale and duration by your chosen multiplier, usually 4× for 120 fps footage. The frame data is unchanged. Only the metadata that describes when each frame plays is rewritten.

The goal is to make TikTok treat the video like lower-FPS footage while keeping the real frames inside the file. Depending on TikTok's current upload behavior, this may produce sharper playback, less blocking, less banding, or fewer high-FPS smoothing artifacts.

## Installation

https://github.com/user-attachments/assets/3ab280cd-3fd2-4e6b-98fa-f0cae628a9c4

### macOS

Download the latest `.dmg` or `.pkg` from [Releases](../../releases) and open it.

- **DMG**: drag Upload120 to your Applications folder.
- **PKG**: double-click and follow the installer. This is usually the easiest option.

macOS may warn about an unnotarized app. Right-click the app and choose **Open** to proceed.

### Windows

Download the `.exe` installer from [Releases](../../releases) and run it.

A portable `.exe` is also available.

## Usage

1. **Patch tab**: drop your video or click **Choose Files**. Select a multiplier. Click **Process**.
2. **Post tab**: click the arrow icon on any finished item, or pick a file manually.
3. Connect TikTok once. Your session is saved locally.
4. Write your caption, add hashtags, set options, and click **Upload to TikTok**.
5. Upload120 drives TikTok's web upload flow. Progress is shown in the app.

## Building from source

```bash
git clone https://github.com/williamm0/Upload120
cd Upload120
npm install

# Run in dev mode
npm run dev

# Build macOS arm64
npm run build:mac

# Build Windows x64
npm run build:win
```

Artifacts land in `dist/`.

## Privacy

Everything runs locally. Upload120 does not upload your videos anywhere except through TikTok when you choose to post. It does not include telemetry.

## Credits

Made by [jx](https://jxffx.com) · [jxffx.com](https://jxffx.com)

Inspired by the original [120fps-method](https://github.com/ut0ku/120fps-method) by ut0ku. Reimplemented from scratch with a proper ISO BMFF atom-tree parser, batch processing, a built-in composer, and a refined interface.

## License

MIT. See [LICENSE](LICENSE).
