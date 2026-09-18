/* MultiCam — passerelle JS vers le plugiciel natif MultiCamPlatform (J02).
 * Actions réelles : espace libre (StatFs), IPv4/réseau, accès aux extras Intent
 * (hook de test — builds debug uniquement). Aucune donnée simulée. */

(function (global) {
  "use strict";

  function call(action, args, onSuccess, onError) {
    if (!global.cordova || !global.MultiCamPlatform) {
      if (onError) onError(new Error("MultiCamPlatform_unavailable"));
      return;
    }
    cordova.exec(onSuccess, onError, "MultiCamPlatform", action, args || []);
  }

  global.MultiCamNative = {
    freeSpace: function (path) {
      return new Promise(function (resolve, reject) {
        call("freeSpace", [path], resolve, reject);
      });
    },
    ipv4: function () {
      return new Promise(function (resolve, reject) {
        call("ipv4", [], resolve, reject);
      });
    },
    intentExtra: function (name) {
      return new Promise(function (resolve, reject) {
        call("intentExtra", [name], function (v) { resolve(v || null); }, reject);
      });
    }
  };
})(window);