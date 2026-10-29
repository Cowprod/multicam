# Physical STOP and transfer validation — 2026-10-29

Devices: Cam 07 controller, Cam 01/02/03 captures, Samsung storage. Session `ZNDBPUEH` on the offline recording router.

The 38-minute take exposed a STOP acknowledgement bug: the native recorders had finalized their MP4s, but JavaScript awaited multi-GB local exports before acknowledging STOP. The controller and capture screens therefore remained in REC and delayed transfer startup. All three original videos subsequently reached storage with matching SHA-256 checksums (17,132,171,527 bytes total). `long-files.json` records ffprobe metadata and successful first/last-frame decoding; this is not a full-duration decode.

The correction acknowledges native STOP independently of public export, records new MP4s directly in private durable storage, and preserves the source during HTTP staging. Export completion cannot overwrite the path of a newer take. A separate concurrency issue found during validation is fixed by serializing SAF directory creation. Manual transfer retry now propagates retry mode.

Physical checks:

- `stop-ack-c0d8514d7d87.json`: native STOP acknowledgement in 494 ms while public export was still pending.
- `stop-fixed-validation.json`: actual ARM / REC / STOP / next-take buttons, all three STOP acknowledgements in 1,120 ms; all three previews present.
- `stop-final-validation.json`: repeated actual UI flow after the SAF correction; all three STOP acknowledgements in 1,090 ms, next take 4 in PREPARATION.
- `stop-final-state-*.json`: three captures have both JavaScript and native recording false, exports saved; controller shows three concurrent transfers done at 100%, with SHA-256 values and no errors.

The corrected build was physically retested with short takes; the 38-minute take predates this correction. This validation does not establish frame-accurate synchronization or guarantee unattended operation. Full JavaScript suite: 562 passed, 0 failed. Android debug builds succeeded and updates preserved app data. Controller and storage received the final fixes; captures received the native STOP/durable-source correction.
