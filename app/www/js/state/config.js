/* MultiCam — etat local (J01).
 * Valeurs TEMPORAIRES non persistantes (J01). L'identite persistante (deviceId,
 * nom modifiable, skills activees persistees, stockage) est traitee en J02. */

(function (global) {
  "use strict";

  var CONFIG = {
    appName: "MultiCam",
    version: "0.1.0",
    deviceName: "Cam 07",
    supportedSkills: ["capture", "storage", "controller"],
    enabledSkills: ["capture", "storage", "controller"]
  };

  var SKILL_META = {
    capture: { icon: "fa-video", label: "Capture" },
    storage: { icon: "fa-hard-drive", label: "Storage" },
    controller: { icon: "fa-sliders", label: "Master" }
  };

  global.MultiCamConfig = {
    get: function () { return CONFIG; },
    isControllerEnabled: function () { return CONFIG.enabledSkills.indexOf("controller") >= 0; },
    skillMeta: SKILL_META
  };
})(window);