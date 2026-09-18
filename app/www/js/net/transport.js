/* MultiCam — couche réseau (J03).
 * Façade applicative au-dessus de la découverte LAN mDNS (MultiCamDiscovery).
 * J01/J02 : inactive. J03 : active réellement l'annonce + la découverte
 * _multicam._tcp. (plugin local cordova-plugin-multicam-nsd), la table de peers
 * keyée deviceId et le fallback stale défensif. Les échanges sessions/WS seront
 * implémentés à partir de J04 (transport regie), hors scope J03. */

(function (global) {
  "use strict";

  var D = null;
  if (global.MultiCamDiscovery) D = global.MultiCamDiscovery;

  global.MultiCamNet = {
    enabled: !!D,
    start: function () {
      if (!D || !D.start) {
        if (global.MultiCamNet.enabled) {
          console.log("NET inactive au jalon J01/J02");
        }
        return Promise.resolve();
      }
      return D.start().catch(function () {});
    },
    stop: function () {
      if (!D || !D.stop) return;
      D.stop().catch(function () {});
    },
    reannounce: function () {
      if (!D || !D.reannounce) return Promise.resolve();
      return D.reannounce();
    },
    status: function () {
      return D ? D.status() : { enabled: false, running: false };
    },
    peers: function () {
      return D ? D.peers() : [];
    }
  };
})(window);