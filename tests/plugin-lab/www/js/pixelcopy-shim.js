/* MultiCam Qualification Lab - PixelCopy bridge fallback
 * The native plugin is patched with the capturePreviewSurface action.
 * This shim exposes the JS method even if Cordova keeps the upstream CameraPreview.js wrapper.
 */
(function () {
  "use strict";

  function installShim() {
    if (!window.CameraPreview || typeof window.cordova === "undefined" || typeof cordova.exec !== "function") {
      return false;
    }

    if (typeof window.CameraPreview.capturePreviewSurface === "function") {
      return true;
    }

    window.CameraPreview.capturePreviewSurface = function (opts, onSuccess, onError) {
      opts = opts || {};
      var quality = parseInt(opts.quality, 10);
      if (!Number.isFinite(quality) || quality < 0 || quality > 100) quality = 85;
      cordova.exec(onSuccess, onError, "CameraPreview", "capturePreviewSurface", [quality]);
    };

    return true;
  }

  installShim();
  document.addEventListener("deviceready", installShim, false);
}());
