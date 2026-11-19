/* Shared device media + telemetry projection for Home, Session, Take, REC and post-REC.
 * No synthetic frames; capability and freshness are independent of connectivity.
 */
(function (global) {
  "use strict";
  var MAX_FRAME_AGE_MS = 5000;
  function finite(v) { return typeof v === "number" && isFinite(v); }
  function project(input) {
    input = input || {};
    var now = finite(input.nowMs) ? input.nowMs : Date.now();
    var t = input.telemetry || null, f = input.frame || null;
    var hasCamera = !!input.hasCamera;
    var frameReceivedAt = f && (finite(f.receivedAt) ? f.receivedAt : finite(f.capturedAt) ? f.capturedAt : null);
    var frameAgeMs = frameReceivedAt !== null ? Math.max(0, now - frameReceivedAt) : null;
    var image = hasCamera && f && typeof f.jpegBase64 === "string" &&
      f.jpegBase64.length > 0 && frameAgeMs !== null && frameAgeMs <= MAX_FRAME_AGE_MS ? f : null;
    var battery = t && finite(t.batteryLevel) ? Math.max(0, Math.min(100, Math.round(t.batteryLevel))) : null;
    var freeBytes = t && finite(t.freeBytes) && t.freeBytes >= 0 ? t.freeBytes : null;
    var totalBytes = t && finite(t.totalBytes) && t.totalBytes > 0 ? t.totalBytes : null;
    var freePercent = freeBytes !== null && totalBytes !== null
      ? Math.max(0, Math.min(100, Math.round(100 * freeBytes / totalBytes))) : null;
    return {
      deviceId: String(input.deviceId || ""),
      name: String(input.name || input.deviceId || "Appareil inconnu"),
      roles: Array.isArray(input.roles) ? input.roles.slice() : [],
      connected: input.connected === true,
      hasCamera: hasCamera,
      image: image,
      frameAgeMs: frameAgeMs,
      previewStatus: !hasCamera ? "no_camera" : image ? "live" :
        input.connected === false ? "offline" : "waiting",
      batteryLevel: battery,
      batteryCharging: t && typeof t.batteryCharging === "boolean" ? t.batteryCharging : null,
      freeBytes: freeBytes,
      totalBytes: totalBytes,
      freePercent: freePercent,
      telemetryAgeMs: t && finite(t.atMs) ? Math.max(0, now - t.atMs) : null
    };
  }
  function statusLabel(v) {
    return v.previewStatus === "no_camera" ? "Pas de caméra" :
      v.previewStatus === "offline" ? "Hors ligne" :
      v.previewStatus === "live" ? "" : "En attente du flux";
  }
  global.MultiCamDeviceMedia = { project: project, statusLabel: statusLabel, MAX_FRAME_AGE_MS: MAX_FRAME_AGE_MS };
})(window);
