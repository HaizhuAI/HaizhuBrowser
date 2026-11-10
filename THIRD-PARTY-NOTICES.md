# Third-Party Notices

## Factual reference data — OpenBrowser (sheying2013/OpenBrowser)

HaizhuBrowser's `src/main/personas.js` incorporates **factual data tables**
cross-checked against the upstream project:

- Chromium `ANGLE` WebGL vendor/renderer strings
- Stock OS font lists (Windows / macOS / Linux / Android)
- System speech-voice names (`Microsoft X - Language`, Apple voice names,
  Google TTS voices)
- Realistic media-device labels, locale/timezone presets
- GPU-class WebGL parameter limits (texture sizes, uniform blocks, etc.)

These are vendor-published facts, not copyrightable expression. **No upstream
code was copied** — all selection, derivation and injection logic is original.
Upstream is AGPL-3.0 (`LICENSE.chrome-power.txt`); verbatim reuse was rejected
to keep HaizhuBrowser under its own license. Audit record:
`docs/SECURITY-OPENBROWSER.md`.

## Other components

- **Electron** — MIT License (OpenJS Foundation)
- **EasyList / EasyPrivacy / EasyList-China** — used under their public
  subscription licenses for the adblock engine
- **Bing daily wallpaper** — fetched at runtime from bing.com for the
  new-tab page; copyright remains with the respective owners, used for
  personal/non-commercial display
