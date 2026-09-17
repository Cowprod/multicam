/* MultiCam — services natifs (J01).
 * Couche natif minimum en J01 : integration build du plugin caméra patché PixelCopy.
 * cordova-plugin-device n'est pas installé à J01 ; son usage réel arrive en J02
 * (identité / écran Paramètres 14). getInfo() reste un probe gracieux. */

(function (global) {
  "use strict";

  global.MultiCamDevice = {
    getInfo: function () {
      if (global.device) {
        return {
          manufacturer: device.manufacturer || null,
          model: device.model || null,
          version: device.version || null,
          sdkVersion: device.sdkVersion || null,
          platform: device.platform || null
        };
      }
      return null;
    }
  };
})(window);