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

  function isNum(v) { return typeof v === "number" && isFinite(v); }

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
    /* Backoff injectable entre deux tentatives de téléchargement. Par défaut
     * IDENTITÉ (aucune attente) pour ne pas ralentir les tests ; le boot injecte
     * un vrai délai progressif afin d'absorber les coupures transitoires. */
    var delay = deps.delay || function () { return Promise.resolve(); };

    /* MultiCam D-SERVE: serveur média UNIQUE, partagé au niveau boot entre les
     * Takes. `deps.server` est injecté par la couche boot ; à défaut on crée un
     * état local (tests). `tokens` mémorise le token de chaque Take pour le
     * réutiliser à chaque ré-annonce (le token d'un Take ne change pas). */
    var server = deps.server || { running: false, url: "", host: "", port: 0, tokens: {} };
    if (!server.tokens) server.tokens = {};

    function serverKey(sessionId, takeNumber) {
      return String(sessionId == null ? "" : sessionId) + "/" + takeNumber;
    }

    /* Démarre le serveur média partagé s'il ne tourne pas déjà (idempotent :
     * plusieurs Takes/Capture réutilisent la même instance et le même port). */
    function ensureServer(root) {
      if (server.running) return Promise.resolve(server);
      return native.serveStart({ root: root, port: port, token: "" }).then(function (url) {
        server.url = url;
        server.running = true;
        var m = /^https?:\/\/([^:\/]+):(\d+)/.exec(url || "");
        server.host = m ? m[1] : "";
        server.port = m ? parseInt(m[2], 10) : port;
        return server;
      });
    }

    function encodeRel(rel) {
      return String(rel).split("/").map(encodeURIComponent).join("/");
    }

    /* --------------------------------------------------------------- capture */

    /* À appeler quand le Take local est STOPPED : calcule les empreintes
     * (streaming natif), démarre le serveur média et annonce les segments. */
    /* Segments locaux, STAGÉS si le staging est disponible (le fichier
     * enregistré vit dans le cache interne, mais le serveur sert le dossier
     * média définitif). `stageSegments` rend une promesse de liste ; à défaut
     * on retombe sur `listSegments` (synchrone) pour rester testable. */
    function segmentList() {
      var tk = take();
      var p = (paths.stageSegments
        ? paths.stageSegments(tk.sessionId, tk.takeNumber)
        : Promise.resolve(paths.listSegments ? paths.listSegments(tk.sessionId, tk.takeNumber) : []));
      return Promise.resolve(p).then(function (segs) { return segs || []; });
    }

    var captureAnnounce = function () {
      if (role !== "capture") return Promise.resolve(null);
      var tk = take();
      return segmentList().then(function (segs) {
        if (!segs.length) { log("TRANSFER_ANNOUNCE_SKIP reason=no_segments"); return null; }
        var key = serverKey(tk.sessionId, tk.takeNumber);
        var tkToken = server.tokens[key] || (server.tokens[key] = generateToken());
        var root = paths.mediaRoot(tk.sessionId, tk.takeNumber);
        return Promise.all(segs.map(function (s) {
          return native.sha256(s.path).then(function (r) {
            return { rel: s.rel, segmentIndex: s.segmentIndex || 0, bytes: r.bytes, sha256: r.sha256 };
          });
        })).then(function (files) {
          return ensureServer(root).then(function (sv) {
            return native.serveRegister({
              sessionId: tk.sessionId,
              takeNumber: tk.takeNumber,
              root: root,
              token: tkToken
            }).then(function () {
              log("TRANSFER_SERVE url=" + sv.url + " take=" + tk.takeNumber + " files=" + files.length);
              return model.announceMedia({ host: sv.host, port: sv.port, token: tkToken, files: files });
            });
          });
        });
      }).catch(function (e) {
        log("TRANSFER_ANNOUNCE_ERROR error=" + (e && e.message ? e.message : e));
        return null;
      });
    };

    /* Arrêt du serveur partagé. Réservé à la fermeture de session (ou onDestroy
     * natif) : jamais sur une simple suppression de Take. */
    var serveStop = function () {
      if (!server.running) return Promise.resolve();
      server.running = false;
      server.url = "";
      server.host = "";
      server.port = 0;
      server.tokens = {};
      return native.serveStop();
    };

    /* Suppression locale demandée par le Master : on supprime d'abord, on
     * retire ensuite l'autorisation du Take (le serveur et les AUTRES Takes
     * restent actifs), PUIS on laisse le modèle accuser réception (ack).
     *
     * J14-C01 / D3 — deux règles fermes :
     *  1. La cible est identifiée par (session, Take) porté par la DEMANDE, et
     *     résolue dans les segments STAGÉS de ce Take — JAMAIS via la vue du Take
     *     « courant » (vidée à l'acceptation du Take suivant, ce qui rendait la
     *     suppression silencieusement vide : `files=0`).
     *  2. L'ACK n'est émis que si la suppression est RÉELLEMENT confirmée. Sinon
     *     la demande est DIFFÉRÉE (conservée), JAMAIS acquittée : le Master ne
     *     doit pas croire un média supprimé à tort.
     */

    /* Segments stagés d'un Take précis, + est-ce un Take connu de cette Capture.
     * `paths.listSegmentsFor`/`paths.hasTake` sont fournis par le boot ; à défaut
     * on retombe sur `listSegments` (tests, anciens appels). */
    function deleteTargets(sid, tk) {
      if (typeof paths.listSegmentsFor === "function") {
        var segs = paths.listSegmentsFor(sid, tk) || [];
        var known = (typeof paths.hasTake === "function") ? !!paths.hasTake(sid, tk) : segs.length > 0;
        return { known: known, paths: segs.map(function (s) { return s.path; }).filter(Boolean) };
      }
      var legacy = paths.listSegments ? (paths.listSegments(sid, tk) || []) : [];
      return { known: true, paths: legacy.map(function (s) { return s.path; }).filter(Boolean) };
    }

    /* Demandes de suppression DIFFÉRÉES (REC en cours, take inconnu, échec
     * transitoire). Conservées jusqu'à confirmation effective ou abandon. */
    var deferredDeletes = {}; /* "session/take" -> { env, sid, takeNumber, attempts } */
    var DELETE_MAX_ATTEMPTS = 5;

    function deferDelete(env, sid, tk, reason) {
      var pk = serverKey(sid, tk);
      var e = deferredDeletes[pk] || { env: env, sid: sid, takeNumber: tk, attempts: 0 };
      e.env = env || e.env; /* garder la dernière demande connue */
      e.attempts += 1;
      if (e.attempts > DELETE_MAX_ATTEMPTS) {
        delete deferredDeletes[pk];
        log("TRANSFER_LOCAL_DELETE_FAILED take=" + tk + " attempts=" + e.attempts + " reason=" + (reason || "unknown"));
        model.reportDeleteFailed(env, "delete_failed");
        return false;
      }
      deferredDeletes[pk] = e;
      log("TRANSFER_LOCAL_DELETE_DEFER take=" + tk + " reason=" + (reason || "unknown") + " attempt=" + e.attempts);
      return true;
    }

    var captureHandleDelete = function (env) {
      var sid = (env && env.sessionId) || take().sessionId;
      var tk = isNum(env && env.takeNumber) ? env.takeNumber : take().takeNumber;
      if (env && env.sourceDeviceId && env.sourceDeviceId !== self()) return Promise.resolve(false);
      /* Ne JAMAIS supprimer pendant un enregistrement : on conserve la demande
       * et on la rejouera dans des conditions sûres (voir `retryDeferredDeletes`). */
      if (isRecording()) { deferDelete(env, sid, tk, "recording"); return Promise.resolve(false); }
      return doCaptureDelete(env, sid, tk).then(function (done) {
        if (!done) deferDelete(env, sid, tk, "not_confirmed");
        return done;
      });
    };

    /* Tente la suppression ; rend `true` si (et seulement si) l'ACK a été émis. */
    function doCaptureDelete(env, sid, tk) {
      var t = deleteTargets(sid, tk);
      if (!t.known) return Promise.resolve(false);
      return Promise.resolve(deleteLocal(t.paths)).then(function (res) {
        var ok = !res || res.ok !== false;
        if (!ok) {
          log("TRANSFER_LOCAL_DELETE_RETRY take=" + tk
            + " removed=" + ((res && res.removed) || 0) + " failed=" + ((res && res.failed) || 0));
          return false;
        }
        var removed = (res && isNum(res.removed)) ? res.removed : t.paths.length;
        log("TRANSFER_LOCAL_DELETED take=" + tk + " files=" + t.paths.length + " removed=" + removed);
        delete server.tokens[serverKey(sid, tk)];
        var unreg = server.running
          ? native.serveUnregister({ sessionId: sid, takeNumber: tk })
          : Promise.resolve();
        return unreg.then(function () { model.onIncoming(env); return true; });
      });
    }

    /* Rejoue les suppressions différées (appelé par le watchdog de boot quand
     * l'appareil est de nouveau dans des conditions sûres : Take terminé). */
    var retryDeferredDeletes = function () {
      var keys = Object.keys(deferredDeletes);
      if (!keys.length) return Promise.resolve(0);
      if (isRecording()) return Promise.resolve(0);
      var done = 0;
      var chain = Promise.resolve();
      keys.forEach(function (pk) {
        chain = chain.then(function () {
          var e = deferredDeletes[pk];
          if (!e) return null;
          return doCaptureDelete(e.env, e.sid, e.takeNumber).then(function (okd) {
            if (okd) { delete deferredDeletes[pk]; done += 1; }
            else { deferDelete(e.env, e.sid, e.takeNumber, "not_confirmed"); }
            return null;
          });
        });
      });
      return chain.then(function () { return done; });
    };

    var hasDeferredDeletes = function () { return Object.keys(deferredDeletes).length; };

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

    /* Garde anti-double : un Storage ne relance jamais DEUX téléchargements
     * concurremment vers la même source. Le transport peut livrer une offre en
     * double (deux sockets par pair) ; sans cette garde, deux `download` natifs
     * écriraient dans le MÊME fichier destination en parallèle. L'état se
     * purge à la fin de la chaîne (succès OU échec), donc le retry manuel
     * (Réessayer, écran 09) peut relancer un transfert terminé en erreur. */
    var runningRuns = {}; /* sourceDeviceId -> true pendant la chaîne */

    /* Exécute les téléchargements d'une offre, séquentiellement, avec reprise. */
    var storageRun = function (offer) {
      var rk = (offer && offer.sourceDeviceId) || "";
      if (runningRuns[rk]) {
        log("TRANSFER_RUN_SKIP take=" + take().takeNumber + " source=" + rk + " reason=in_progress");
        return Promise.resolve();
      }
      runningRuns[rk] = true;
      var run = function () {
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
      return run().then(
        function (r) { delete runningRuns[rk]; return r; },
        function (e) { delete runningRuns[rk]; throw e; }
      );
    };

    var downloadWithRetry = function (offer, f, tkTake) {
      var attempt = 0;
      var run = function () {
        attempt += 1;
        var offset = model.resumeOffset(offer.sourceDeviceId, self(), f.rel);
        var dest = paths.destFor ? paths.destFor(offer.sessionId || take().sessionId, tkTake, offer.sourceDeviceId, f.rel) : {};
        var sid = offer.sessionId || take().sessionId;
        var base = "http://" + offer.host + ":" + offer.port + "/"
          + encodeURIComponent(sid) + "/" + encodeURIComponent(String(tkTake)) + "/" + encodeRel(f.rel);
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
          /* Ne PAS masquer la cause réelle derrière un « download_failed »
           * générique (J14-C01 / D2) : on préfixe pour rester filtrable mais on
           * conserve le message (ex. « download_truncated », ProtocolException). */
          if (attempt < MAX_ATTEMPTS) return delay(attempt).then(run);
          model.reportResult(offer.sourceDeviceId, f.rel, model.PH_ERROR,
            { error: "download_failed" + (msg ? ": " + msg : "") });
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
      retryDeferredDeletes: retryDeferredDeletes,
      hasDeferredDeletes: hasDeferredDeletes,
      handle: handle,
      server: server
    };
  }

  return {
    MAX_ATTEMPTS: MAX_ATTEMPTS,
    createTransferService: createTransferService
  };
});
