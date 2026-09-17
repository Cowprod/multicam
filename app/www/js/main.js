/* MultiCam — point d'entrée application (J01).
 * Exigence journalisation distribuee : tous les evenements importants en format
 * lisible/parsable (ex : APP_BOOT ...). Aucune donnee de demo n'est fabriquee. */

(function (global) {
  "use strict";

  function boot() {
    var cfg = global.MultiCamConfig.get();

    console.log("APP_BOOT app=" + cfg.appName
      + " version=" + cfg.version
      + " deviceName=" + cfg.deviceName
      + " supportedSkills=[" + cfg.supportedSkills.join(",") + "]"
      + " enabledSkills=[" + cfg.enabledSkills.join(",") + "]");

    var dev = global.MultiCamDevice.getInfo();
    if (dev) {
      console.log("APP_BOOT platform=" + dev.platform
        + " model=" + dev.model
        + " android=" + dev.version
        + " sdk=" + dev.sdkVersion);
    }

    global.MultiCamPixelCopy.installShim();
    console.log("PIXELCOPY_READY method=" + (global.MultiCamPixelCopy.isMethodAvailable() ? "1" : "0"));

    global.MultiCamNet.start();

    global.MultiCamHome.render(cfg);
    global.MultiCamHome.bind();

    console.log("HOME_RENDER deviceName=" + cfg.deviceName
      + " controllerEnabled=" + (global.MultiCamConfig.isControllerEnabled() ? "1" : "0")
      + " recentSessions=0 lanSessions=0");
  }

  function onReady() {
    try {
      boot();
    } catch (err) {
      console.log("APP_ERROR " + String((err && err.message) || err));
    }
  }

  if (global.cordova) {
    document.addEventListener("deviceready", onReady, false);
  } else {
    console.log("APP_NOT_CORDOVA run=web");
  }
})(window);