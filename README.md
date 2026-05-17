# Upload120

**Local website for MP4 timing metadata patches.**

Upload120 is now a website-only tool. Drop an MP4, MOV, or M4V file into the static web page, choose a local method, and download a patched copy. The video stays on your device, and the frame data is not uploaded or re-encoded by Upload120.

---

## Current Website

- **Local processing** - all patching runs in the browser.
- **Multiple methods** - Balanced Sync, Extension Signal, Header Lite, and Classic Force.
- **Batch queue** - add multiple files and process them from one page.
- **Auto multiplier** - pick timing strength automatically from the detected FPS.
- **No install** - open `docs/index.html` directly or host the `docs/` folder as a static site.

For best results, upload the patched file from TikTok Web on a computer. Avoid in-upload edits, cropping, music, or mobile reposting because those steps can re-encode the file.

---

## Usage

1. Open `docs/index.html` in a browser or use the hosted static site.
2. Drop one or more video files into the page.
3. Choose a method and multiplier.
4. Click **Process** and download the patched file.

Everything runs locally. No telemetry, no server upload, and no account connection is required.

---

## Legacy Desktop Builds

Legacy desktop builds are outdated and kept only as archived older versions:

- `Upload120-1.2.0-arm64.dmg`
- `Upload120-1.2.0-arm64.pkg`
- `Upload120-1.2.0-arm64.zip`
- `Upload120-1.2.0-x64.exe`
- `Upload120-1.2.0-portable.exe`

They are not the current product, are not maintained in this repo anymore, and should be treated as old snapshots. Use the website for current behavior.

---

## Development

```bash
npm test
```

The tests cover the browser patcher and website wiring. There is no native app build pipeline in the current project.

---

## Credits

Made by [jx](https://jxffx.com) · [jxffx.com](https://jxffx.com)

Inspired by public MP4 container research and community upload-method work, including [120fps-method](https://github.com/ut0ku/120fps-method), [Kryp](https://kryptools.org/), [Maska](https://addons.mozilla.org/en-US/firefox/addon/maska-tiktok-upload-method/), [itzCrih](https://method.itzcrih.it/), and [Qualitymax](https://www.qualitymax.org/).

---

## License

MIT - see [LICENSE](LICENSE).
