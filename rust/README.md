# MeetingCopilot native audio (napi-rs)

Native audio capture for the **optional** `audio.captureBackend = 'native'`
path (upgrade P1.5). Windows: WASAPI shared-mode loopback of the default
render device (the system mix — no BlackHole/virtual-device needed). Mic
capture via cpal works cross-platform. Output is 16 kHz mono f32 in 100 ms
frames — byte-identical to what the renderer's Web Audio pipeline sends, so
the ASR host treats both paths the same.

## Status

**This artifact is optional.** The app ships and runs perfectly without it:
when `resources/native/meeting-copilot-audio.node` is missing, the loader
(electron/audio/nativeCapture.ts) reports `native unavailable` and the app
falls back to the Web Audio path automatically. The default
`audio.captureBackend` is `webaudio`.

The Rust code targets `napi@2` + `wasapi@0.15` + `cpal@0.15` and follows the
wasapi loopback example, but it has NOT been compiled in CI yet — first build
on a machine with the Rust toolchain is expected to surface minor API drift
in the `wasapi` crate (its surface has moved between 0.14/0.15). Fix-ups are
expected to be mechanical (import paths / method names).

## Build

Prereqs: Rust stable (`rustup`), Node >= 20. From the repo root:

```bash
npm install            # brings in @napi-rs/cli via rust/package.json? no —
cd rust && npm install # @napi-rs/cli lives here
npm run build:release  # writes ../resources/native/meeting-copilot-audio.node
```

Then set 设置 → 高级 → 音频采集后端 to `native` (Windows) or use the mic on
any platform. Packaging includes the artifact via electron-builder
`extraResources` — but only when the file exists (CI conditionally skips).

## Why not cpal for loopback?

cpal (0.15) has no WASAPI loopback support — an input stream on the render
device is not exposed. The `wasapi` crate talks to WASAPI directly and is the
standard loopback approach; the plan sketch that assumed `cpal` loopback does
not compile (that was the point of rewriting this layer).
