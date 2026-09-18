/* MultiCam — services natifs (J02).
 * Informations réelles de l'appareil via cordova-plugin-device, batterie via
 * cordova-plugin-battery-status, réseau (type + IPv4) via navigator.connection et
 * le plugiciel natif MultiCamPlatform. L'adresse IP est affichée à titre
 * d'information réseau ; elle ne constitue JAMAIS l'identité (deviceId protocole). */

(function (global) {
  "use strict";

  var APP_VERSION = "0.1.0";
  var lastBattery = null;

  function getInfo() {
    if (!global.device) return null;
    return {
      manufacturer: device.manufacturer || null,
      model: device.model || null,
      version: device.version || null,
      sdkVersion: device.sdkVersion || null,
      sdkNumber: parseInt(device.sdkVersion, 10) || 0,
      platform: device.platform || null,
      deviceUuid: device.uuid || null,
      cordovaVersion: device.cordova || null,
      appVersion: APP_VERSION
    };
  }

  function batteryStatus(cb) {
    if (!global.cordova) return;
    global.addEventListener("batterystatus", function (s) {
      lastBattery = { level: s.level, isPlugged: !!s.isPlugged };
      if (cb) cb(lastBattery);
    }, false);
    if (lastBattery && cb) cb(lastBattery);
    return lastBattery;
  }

  function networkType() {
    if (global.navigator && navigator.connection && navigator.connection.type) {
      return navigator.connection.type;
    }
    return null;
  }

  global.MultiCamDevice = {
    getInfo: getInfo,
    batteryStatus: batteryStatus,
    networkType: networkType,
    appVersion: APP_VERSION
  };
})(window);