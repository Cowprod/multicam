/* MultiCam — passerelle JS vers le plugiciel SAF qualifié (J02).
 * chooseDirectory / testWrite / listPersisted / getTreeName sont des actions
 * réelles du plugiciel natif (write/delete POC qualifié, extension J02 getTreeName). */

(function (global) {
  "use strict";

  global.MultiCamSafApi = {
    chooseDirectory: function () {
      return new Promise(function (resolve, reject) {
        if (!global.cordova || !global.MultiCamSaf) { reject(new Error("MultiCamSaf_unavailable")); return; }
        MultiCamSaf.chooseDirectory(resolve, reject);
      });
    },
    testWrite: function (uri) {
      return new Promise(function (resolve, reject) {
        if (!global.cordova || !global.MultiCamSaf) { reject(new Error("MultiCamSaf_unavailable")); return; }
        MultiCamSaf.testWrite(uri, resolve, reject);
      });
    },
    listPersisted: function () {
      return new Promise(function (resolve, reject) {
        if (!global.cordova || !global.MultiCamSaf) { reject(new Error("MultiCamSaf_unavailable")); return; }
        MultiCamSaf.listPersisted(resolve, reject);
      });
    },
    getTreeName: function (uri) {
      return new Promise(function (resolve, reject) {
        if (!global.cordova || !global.MultiCamSaf) { reject(new Error("MultiCamSaf_unavailable")); return; }
        MultiCamSaf.getTreeName(uri, resolve, reject);
      });
    }
  };
})(window);