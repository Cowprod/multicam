# AGENTS.md — MultiCam

## Project

Multi-device LAN video capture on Android via Apache Cordova. Multiple phones record HD video locally; a "Regie/Master" console controls them and receives periodic JPEG preview snapshots (~1 fps via Android PixelCopy). **All documentation is in French. Code and agent instructions in English.**

Current state: pre-implementation. UI mockups validated, technical qualification complete, V1 dev plan (J01–J14) ready to execute. Only code in repo is `tests/plugin-lab/` (qualification POC). `app/` is empty placeholder.

## Commands

### plugin-lab (the only buildable code)

```bash
cd tests/plugin-lab
./setup-android.sh          # full idempotent build+install+run (npm install, platform add, plugins, pixelcopy patch, build, deploy)
```

Clean rebuild:
```bash
cd tests/plugin-lab
rm -rf platforms plugins node_modules
./setup-android.sh
```

PixelCopy patch re-application (after plugin reinstall or platform recreate):
```bash
cd tests/plugin-lab
python3 pixelcopy-patch/apply_pixelcopy_patch.py .
cordova prepare android
cordova build android
```

Verify patch survived a build:
```bash
grep -R "capturePreviewSurface" platforms/android
```

### UI mockups

No build step. Static HTML with CDN dependencies (Bootstrap 5, Font Awesome 6, jQuery). Serve with any static server or open directly in browser. Entrypoint: `ui/index.html`.

### No lint / format / typecheck / CI / pre-commit

None exist. Do not run `npm audit fix --force` (causes dependency breakage).

## Architecture

```
ui/              → static validated mockups (reference specs, not production code)
app/             → future production Cordova app (empty)
tests/plugin-lab → working Cordova POC on Android (the only runnable code)
docs/            → technical specs, dev plan, skills/roles architecture
```

- **Cordova layering:** UI → camera service (Cordova) → transport (regie). Plugin-lab is explicitly not the production architecture.
- **No database.** Data model is JSON manifests (`session.json`, `take.json`) by design.
- **Android-only.** iOS is future/out-of-scope.

## Camera plugin — critical gotchas

The camera plugin (`cordova-plugin-camera-preview`) is installed from GitHub master and **patched in place** by `pixelcopy-patch/apply_pixelcopy_patch.py` to add `capturePreviewSurface()` (PixelCopy). Key rules from the camera reference (`AGENTS.md` inside `multicam-camera-reference-v1.0.zip`):

1. **Never use `CameraPreview.takeSnapshot()` during `startRecordVideo()`** — callbacks are invalidated.
2. **Use `CameraPreview.capturePreviewSurface({quality}, success, error)`** (PixelCopy) for images during REC.
3. **Camera preview is native SurfaceView, not DOM.** You cannot `canvas.drawImage(div)`. WebView must be transparent, `toBack: true`.
4. Keep the patch in `pixelcopy-patch/`; **re-apply after every plugin reinstall or platform recreate**.
5. **Validate JPEG content**, not just callback success.
6. **DON'T run `npm audit fix --force`** — breaks Cordova xcode dependency.

The zip `multicam-camera-reference-v1.0.zip` also contains `docs/TECHNICAL_REFERENCE.md`, `docs/VALIDATED_TESTS.md`, `docs/KNOWN_LIMITATIONS.md`, and a verification script `scripts/check_pixelcopy_patch.sh`.

## Decision hierarchy

When specs conflict: **do not improvise**. Flag the conflict and wait for a decision.

Source priority (from `MULTICAM_DECISIONS_REFERENCE.md` §28):
1. `MULTICAM_DECISIONS_REFERENCE.md` — master decision log
2. `AGENTS.md` inside `multicam-camera-reference-v1.0.zip` — camera technical rules
3. `docs/PLAN-DEVELOPPEMENT-V1.md` — dev plan with milestone structure
4. `docs/SKILLS-AND-ROLES.md` — architecture reference
5. Each `ui/NN-*/README.md` — invariants per screen

## Developer workflow

- **adb is freely authorized** on all connected Android devices (install, screenshot, logcat, force-stop, disconnect).
- **Milestone completion requires device proof**: screenshots, logs, artifacts stored in `tests/e2e/validation/JXX-<milestone>/` (structure defined in dev plan, not yet created).
- **Distributed events must use parsable logging** (e.g. `START_REQUEST target=…`, `CLOCK_SYNC peer=… offset=… rtt=…`, or JSONL).
- **Work on one milestone at a time.** Do not start J(n+1) until J(n) has been validated **PASS** or an explicit decision has been made to defer a failed criterion.
## Quick reference

| What | Where |
|---|---|
| Root README | `README.md` (French) |
| Master decisions | `MULTICAM_DECISIONS_REFERENCE.md` |
| Dev plan (J01–J14) | `docs/PLAN-DEVELOPPEMENT-V1.md` |
| Skills/roles arch | `docs/SKILLS-AND-ROLES.md` |
| Camera rules | `multicam-camera-reference-v1.0.zip` → `AGENTS.md` |
| Qualification results | `docs/QUALIFICATION-TECHNIQUE-V1.md` |
| Only runnable code | `tests/plugin-lab/` |
| SAF plugin | `tests/plugin-lab/local-plugins/cordova-plugin-multicam-saf/` |
| UI specs | `ui/NN-screen-name/` (10 validated screens) |
