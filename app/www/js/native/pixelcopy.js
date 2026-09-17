/* MultiCam — brique PixelCopy qualifiée (lab tests/plugin-lab, validée en qualification V1).
 * Le plugin cordova-plugin-camera-preview est installé à un commit upstream épinglé
 * puis patché par app/pixelcopy-patch/apply_pixelcopy_patch.py qui ajoute l'action
 * native capturePreviewSurface (PixelCopy). Ce shim re-expose la méthode JS dans le
 * cas où la fabrication Cordova garderait le wrapper CameraPreview.js sans la méthode.
 * Aucun appel caméra en J01 : le mécanisme complet (REC + ~1 img/s) est exercé en J09. */

(function (global) {
  "use strict";

  var PLUGIN_NAME = "CameraPreview";

  function installShim() {
    if (!global.CameraPreview || typeof global.cordova === "undefined" || typeof cordova.exec !== "function") {
      return false;
    }
    if (typeof global.CameraPreview.capturePreviewSurface === "function") {
      return true;
    }
    global.CameraPreview.capturePreviewSurface = function (opts, onSuccess, onError) {
      opts = opts || {};
      var quality = parseInt(opts.quality, 10);
      if (!Number.isFinite(quality) || quality < 0 || quality > 100) quality = 85;
      cordova.exec(onSuccess, onError, PLUGIN_NAME, "capturePreviewSurface", [quality]);
    };
    return true;
  }

  function isMethodAvailable() {
    return !!(global.CameraPreview && typeof global.CameraPreview.capturePreviewSurface === "function");
  }

  global.MultiCamPixelCopy = {
    isMethodAvailable: isMethodAvailable,
    installShim: installShim
  };

  document.addEventListener("deviceready", installShim, false);
})(window);