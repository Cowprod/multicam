/* MultiCam — point d'entrée application (J02).
 * Exigence journalisation distribuée : tous les événements importants en format
 * lisible/parsable (ex : APP_BOOT ...). Aucune donnée de démo n'est fabriquée.
 * Boot asynchrone : la configuration persistante (config.json) est chargée et
 * source de vérité avant le rendu de l'écran 01. J02 ne démarre pas J03. */

(function (global) {
  "use strict";

  function logBoot(cfg, dev) {
    console.log("APP_BOOT app=" + "MultiCam"
      + " version=" + ((dev && dev.appVersion) || global.MultiCamDevice.appVersion)
      + " deviceId=" + cfg.deviceId
      + " deviceName=" + cfg.deviceName
      + " supportedSkills=[" + cfg.supportedSkills.join(",") + "]"
      + " enabledSkills=[" + cfg.enabledSkills.join(",") + "]"
      + " storage=" + cfg.storage.mode);
  }

  function debugTestHook(cfg) {
    if (!(global.cordova && global.MultiCamNative)) return Promise.resolve(null);
    return global.MultiCamNative.intentExtra("mcTestSkill").then(function (skill) {
      if (!skill) return null;
      console.log("TEST_HOOK skill=" + skill + " intentExtra=mcTestSkill");
      return global.MultiCamConfig.setSkill(skill, true).then(function () {
        console.log("TEST_HOOK result=" + skill + " unexpectedly_allowed");
      }).catch(function (err) {
        console.log("TEST_HOOK result=REJECTED reason=" + String((err && err.message) || err));
      });
    }).catch(function () {
      return null;
    });
  }

  function boot() {
    global.MultiCamConfig.load().then(function (cfg) {
      var dev = global.MultiCamDevice.getInfo();
      logBoot(cfg, dev);

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

      debugTestHook(cfg);
    }).catch(function (err) {
      console.log("APP_ERROR " + String((err && err.message) || err));
    });
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
    global.MultiCamConfig.load().then(function (cfg) {
      global.MultiCamHome.render(cfg);
      global.MultiCamHome.bind();
      console.log("HOME_RENDER deviceName=" + cfg.deviceName + " run=web");
    });
  }
})(window);