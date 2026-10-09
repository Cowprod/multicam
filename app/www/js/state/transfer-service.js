/* MultiCam J11 — service de transfert (glue I/O, hors modèle pur).
 *
 * Le modèle `state/transfer-model.js` porte l'état et les invariants ; ce
 * service câble les EFFETS : serveur HTTP de la Capture, téléchargements natifs
 * reprenables du Storage, calcul SHA-256, suppression locale, et le lien avec le
 * Take (Storage sélectionnés, réglages, garde RECORDING).
 *
 * Toutes les dépendances sont INJECTÉES (modèle, natif, chemins, réglages,
 * horloge) : le service est testable sans Cordova.
 *
 * Rôles :
 *   capture : annonce ses segments après STOP (serveur + media_ready) et
 *             supprime ses originaux sur ordre vérifié.
 *   master  : offre le transfert aux Storage sélectionnés, agrège, et ordonne la
 *             suppression locale une fois toutes les destinations vérifiées.
 *   storage : exécute les téléchargements reprenables et publie progression et
 *             résultats.
 */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(root);
  } else {
    root.MultiCamTransferService = factory(root);
  }
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var MAX_ATTEMPTS = 3;

  function createTransferService(deps) {
    deps = deps || {};
    var model = deps.model;
    var native = deps.native;
    var self = deps.self || function () { return deps.deviceId || "self"; };
    var role = deps.role || "";
    var log = deps.log || function () {};
    var take = deps.take || function () { return { sessionId: "", takeNumber: 0, storages: [] }; };
    var settings = deps.settings || function () { return {}; };
    var paths = deps.paths || {};
    var isRecording = deps.isRecording || function () { return false; };
    var deleteLocal = deps.deleteLocal || function () { return Promise.resolve(); };
    var generateToken = deps.generateToken || function () { return Math.random().toString(36).slice(2, 12); };
    var port = deps.port || 8080;

    /* Serveur média de la Capture (un seul à la fois : un Take à la fois). */
    var server = { url: "", token: "", running: false };

    /* --------------------------------------------------------------- capture */

    /* À appeler quand le Take local est STOPPED : calcule les empreintes
     * (streaming natif), démarre le serveur média et annonce les segments. */
    var captureAnnounce = function () {
      if (role !== "capture") return Promise.resolve(null);
      var tk = take();
      var segs = (paths.listSegments ? paths.listSegments(tk.sessionId, tk.takeNumber) : []) || [];
      if (!segs.length) { log("TRANSFER_ANNOUNCE_SKIP reason=no_segments"); return Promise.resolve(null); }
      server.token = generateToken();
      return Promise.all(segs.map(function (s) {
        return native.sha256(s.path).then(function (r) {
          return { rel: s.rel, segmentIndex: s.segmentIndex || 0, bytes: r.bytes, sha256: r.sha256 };
        });
      })).then(function (files) {
        return native.serveStart({ root: paths.mediaRoot(tk.sessionId, tk.takeNumber), port: port, token: server.token })
          .then(function (url) {
            server.url = url;
            server.running = true;
            var m = /^https?:\/\/([^:\/]+):(\d+)/.exec(url || "");
            var host = m ? m[1] : "";
            var prt = m ? parseInt(m[2], 10) : port;
            log("TRANSFER_SERVE url=" + url + " files=" + files.length);
            return model.announceMedia({ host: host, port: prt, token: server.token, files: files });
          });
      }).catch(function (e) {
        log("TRANSFER_ANNOUNCE_ERROR error=" + (e && e.message ? e.message : e));
        return null;
      });
    };

    var serveStop = function () {
      if (!server.running) return Promise.resolve();
      server.running = false;
      server.url = "";
      return native.serveStop();
    };

    /* Suppression locale demandée par le Master : on supprime d'abord, PUIS on
     * laisse le modèle accuser réception (ack). */
    var captureHandleDelete = function (env) {
      var tk = take();
      var segs = (paths.listSegments ? paths.listSegments(tk.sessionId, tk.takeNumber) : []) || [];
      var list = segs.map(function (s) { return s.path; });
      return deleteLocal(list).then(function () {
        log("TRANSFER_LOCAL_DELETED take=" + tk.takeNumber + " files=" + list.length);
        return model.onIncoming(env);
      });
    };

    /* ------------------------------------------------------------------ master */

    var masterOffer = function (sourceDeviceId) {
      var tk = take();
      var st = settings();
      if (!st.transferAuto) { log("TRANSFER_OFFER_SKIP reason=manual source=" + sourceDeviceId); return []; }
      var storages = (tk.storages || []).filter(function (d) { return d && d !== sourceDeviceId; });
      if (!storages.length) { log("TRANSFER_OFFER_SKIP reason=no_storage source=" + sourceDeviceId); return []; }
      return model.offerTransfers(sourceDeviceId, storages);
    };

    var maybeRequestDelete = function (sourceDeviceId) {
      if (model.canDeleteLocal(sourceDeviceId, settings())) {
        model.requestDelete(sourceDeviceId);
        return true;
      }
      return false;
    };

    /* ----------------------------------------------------------------- storage */

    /* Exécute les téléchargements d'une offre, séquentiellement, avec reprise. */
    var storageRun = function (offer) {
      var tk = take();
      var files = (offer.files || []).slice().sort(function (a, b) {
        return (a.segmentIndex || 0) - (b.segmentIndex || 0);
      });
      var tkTake = tk.takeNumber;
      var chain = Promise.resolve();
      files.forEach(function (f) {
        chain = chain.then(function () {
          if (isRecording()) {
            log("TRANSFER_PAUSE take=" + tkTake + " reason=recording file=" + f.rel);
            return null; /* le service sera relancé après le Take */
          }
          return downloadWithRetry(offer, f, tkTake);
        });
      });
      return chain;
    };

    var downloadWithRetry = function (offer, f, tkTake) {
      var attempt = 0;
      var run = function () {
        attempt += 1;
        var offset = model.resumeOffset(offer.sourceDeviceId, self(), f.rel);
        var dest = paths.destFor ? paths.destFor(offer.sessionId || take().sessionId, tkTake, f.rel) : {};
        var base = "http://" + offer.host + ":" + offer.port + "/" + encodeURIComponent(f.rel);
        var opts = {
          url: base, token: offer.token, offset: offset, expectedBytes: f.bytes
        };
        applyDest(opts, dest);
        return native.download(opts, function (p) {
          model.reportFileProgress(offer.sourceDeviceId, f.rel, p.received);
        }).then(function (res) {
          model.reportResult(offer.sourceDeviceId, f.rel, model.PH_DONE, {
            bytes: res.received, sha256Destination: res.sha256
          });
          log("TRANSFER_FILE_DONE file=" + f.rel + " bytes=" + res.received);
          return true;
        }).catch(function (e) {
          var msg = e && e.message ? e.message : String(e);
          log("TRANSFER_FILE_ERROR file=" + f.rel + " attempt=" + attempt + " error=" + msg);
          if (attempt < MAX_ATTEMPTS) return run();
          model.reportResult(offer.sourceDeviceId, f.rel, model.PH_ERROR, { error: "download_failed" });
          return false;
        });
      };
      return run();
    };

    function applyDest(opts, dest) {
      if (!dest) return;
      if (dest.treeUri) { opts.treeUri = dest.treeUri; opts.relPath = dest.relPath; }
      else if (dest.dest) { opts.dest = dest.dest; }
    }

    /* ------------------------------------------------------------ dispatcher */

    /* Traite un message entrant : effets de bord PUIS application au modèle. */
    var handle = function (env) {
      if (!env || !env.kind) return Promise.resolve(false);
      if (role === "capture" && env.kind === model.K_TRANSFER_DELETE) {
        return captureHandleDelete(env);
      }
      var applied = model.onIncoming(env);
      if (!applied) return Promise.resolve(false);
      if (role === "master" && env.kind === model.K_MEDIA_READY) {
        masterOffer(env.deviceId);
      } else if (role === "master" && env.kind === model.K_TRANSFER_RESULT && env.state === model.PH_DONE) {
        maybeRequestDelete(env.sourceDeviceId);
      } else if (role === "storage" && env.kind === model.K_TRANSFER_OFFER) {
        return storageRun(env).then(function () { return true; });
      }
      return Promise.resolve(true);
    };

    return {
      captureAnnounce: captureAnnounce,
      serveStop: serveStop,
      masterOffer: masterOffer,
      maybeRequestDelete: maybeRequestDelete,
      storageRun: storageRun,
      handle: handle,
      server: server
    };
  }

  return {
    MAX_ATTEMPTS: MAX_ATTEMPTS,
    createTransferService: createTransferService
  };
});
