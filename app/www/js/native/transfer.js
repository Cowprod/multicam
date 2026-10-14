/* MultiCam J11 — passerelle JS vers les briques natives de transfert média.
 *
 * - ServerSide  : cordova.plugins.CorHttpd (plugin vendorié, Range/206, token).
 * - DataSide    : MultiCamTransfer (SHA-256 streaming + download reprenable).
 *
 * Toutes les I/O média restent natives ; ces fonctions ne manipulent que des
 * métadonnées et des chemins. Testables via `global.__transferNative` (fake). */

(function (global) {
  "use strict";

  function httpd() {
    if (global.__transferNative && global.__transferNative.httpd) return global.__transferNative.httpd;
    return (global.cordova && global.cordova.plugins) ? global.cordova.plugins.CorHttpd : null;
  }

  function transfer() {
    if (global.__transferNative && global.__transferNative.transfer) return global.__transferNative.transfer;
    return global.MultiCamTransfer || null;
  }

  global.MultiCamTransferApi = {
    available: function () {
      return !!(httpd() && transfer());
    },

    /* Démarre le serveur média sur `root` ; rend l'URL LAN. */
    serveStart: function (opts) {
      return new Promise(function (resolve, reject) {
        var h = httpd();
        if (!h) { reject(new Error("CorHttpd_unavailable")); return; }
        h.startServer({
          www_root: opts.root,
          port: opts.port,
          localhost_only: false,
          token: opts.token || ""
        }, resolve, function (err) { reject(new Error("serve_start_failed: " + err)); });
      });
    },

    serveStop: function () {
      return new Promise(function (resolve, reject) {
        var h = httpd();
        if (!h) { resolve(); return; }
        h.stopServer(resolve, function (err) { reject(new Error("serve_stop_failed: " + err)); });
      });
    },

    /* MultiCam D-SERVE: autorise UN Take sur le serveur média unique.
     * `opts` = { sessionId, takeNumber, root, token }. */
    serveRegister: function (opts) {
      return new Promise(function (resolve, reject) {
        var h = httpd();
        if (!h) { reject(new Error("CorHttpd_unavailable")); return; }
        h.registerTake({
          sessionId: opts.sessionId,
          takeNumber: opts.takeNumber,
          root: opts.root,
          token: opts.token || ""
        }, resolve, function (err) { reject(new Error("serve_register_failed: " + err)); });
      });
    },

    /* MultiCam D-SERVE: retire l'autorisation d'UN Take. Le serveur média et
     * les autres Takes ne sont PAS affectés. */
    serveUnregister: function (opts) {
      return new Promise(function (resolve, reject) {
        var h = httpd();
        if (!h) { reject(new Error("CorHttpd_unavailable")); return; }
        h.unregisterTake({
          sessionId: opts.sessionId,
          takeNumber: opts.takeNumber
        }, resolve, function (err) { reject(new Error("serve_unregister_failed: " + err)); });
      });
    },

    /* Empreinte SHA-256 streaming d'un fichier. */
    sha256: function (path) {
      return new Promise(function (resolve, reject) {
        var t = transfer();
        if (!t) { reject(new Error("MultiCamTransfer_unavailable")); return; }
        t.sha256(path, resolve, function (err) { reject(new Error("sha256_failed: " + err)); });
      });
    },

    /* Déplace un segment enregistré (cache) vers l'arborescence média servie.
     * Rend `{dest, bytes}` ; `dest` est le chemin réellement écrit. */
    stage: function (src, dest) {
      return new Promise(function (resolve, reject) {
        var t = transfer();
        if (!t) { reject(new Error("MultiCamTransfer_unavailable")); return; }
        t.stage(src, dest, resolve, function (err) { reject(new Error("stage_failed: " + err)); });
      });
    },

    /* Suppression locale d'un fichier. Rend `{removed, path}`. */
    remove: function (path) {
      return new Promise(function (resolve, reject) {
        var t = transfer();
        if (!t) { reject(new Error("MultiCamTransfer_unavailable")); return; }
        t.remove(path, resolve, function (err) { reject(new Error("remove_failed: " + err)); });
      });
    },

    /* GET reprenable. `onProgress({received,total})`. */
    download: function (opts, onProgress) {
      return new Promise(function (resolve, reject) {
        var t = transfer();
        if (!t) { reject(new Error("MultiCamTransfer_unavailable")); return; }
        t.download(opts, onProgress || function () {}, resolve, function (err) {
          reject(new Error("download_failed: " + err));
        });
      });
    }
  };
})(typeof self !== "undefined" ? self : this);
