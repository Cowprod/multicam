/* MultiCam — couche réseau (J01).
 * INACTIVE à J01 : le scope J01 n'active aucune fonction réseau.
 * L'annonce/la découverte mDNS et les échanges WebSocket/HTTP seront
 * implémentés à partir de J03 (transport regie). Pas d'implémentation J03 ici. */

(function (global) {
  "use strict";

  global.MultiCamNet = {
    enabled: false,
    start: function () {
      if (global.MultiCamNet.enabled) {
        return;
      }
      console.log("NET inactive au jalon J01");
    },
    stop: function () {}
  };
})(window);