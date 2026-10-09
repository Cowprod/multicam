/* MultiCam J11 — bootstrap du transfert média.
 *
 * Assemble les pièces (modèle pur + service + briques natives) et les câble au
 * monde réel : rôles du device, session/take courants (Storage sélectionnés,
 * réglages), transport WS, et déclenchement après STOP.
 *
 * Rôle du device (v1, priorité) : controller → master, capture → capture,
 * sinon storage. Un device multi-rôle (Master ET Storage) n'est pas géré par ce
 * bootstrap — un log explicite le signale.
 *
 * Déclenchement Capture : à chaque révision de la vue START, dès que le Take
 * local est STOPPED (le service START publie `localStoppedTake`), la Capture
 * calcule les empreintes, démarre le serveur média et annonce `media_ready` —
 * UNE SEULE FOIS par (session, take).
 *
 * Toutes les dépendances sont INJECTÉES : testable sans Cordova ni réseau. */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(root);
  } else {
    root.MultiCamTransferBoot = factory(root);
  }
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  function roleFor(cfg) {
    var en = (cfg && cfg.enabledSkills) || [];
    if (en.indexOf("controller") >= 0) return "master";
    if (en.indexOf("capture") >= 0) return "capture";
    if (en.indexOf("storage") >= 0) return "storage";
    return "";
  }

  function baseName(p) {
    var s = String(p || "");
    var i = s.lastIndexOf("/");
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function createTransferBoot(deps) {
    deps = deps || {};
    var cfg = deps.cfg || {};
    var ws = deps.ws || function () { return root.MultiCamSessionWs; };
    var startService = deps.startService || function () { return root.MultiCamStartService; };
    var sessionStore = deps.sessionStore || function () { return root.MultiCamSessionStore; };
    var storageNative = deps.storageNative || function () { return root.MultiCamStorage; };
    var nativeApi = deps.nativeApi || function () { return root.MultiCamTransferApi; };
    var modelMod = deps.transferModel || function () { return root.MultiCamTransferModel; };
    var serviceMod = deps.transferService || function () { return root.MultiCamTransferService; };
    var takeModel = deps.takeModel || function () { return root.MultiCamTakeModel; };
    var log = deps.log || function (l) { if (root.console) console.log(l); };

    var role = roleFor(cfg);
    var machine = null;
    var service = null;
    var bound = false;
    var builtFor = ""; /* "sid|take" de la machine courante */

    /* Contexte courant (session + take) : source unique des Storage/réglages. */
    var ctx = { sid: "", takeNumber: 0, take: null, loading: false };
    var announced = {};   /* "sid|take" -> true */
    var pausedOffers = {}; /* sourceDeviceId -> offre en attente (garde REC) */

    function sendOnWs(kind, extra) {
      var w = ws();
      var sid = (extra && extra.sessionId) || ctx.sid;
      if (!w || typeof w.broadcastTargeted !== "function" || !sid) return;
      w.broadcastTargeted(kind, { sessionId: sid }, extra);
    }

    function sendToWs(did, kind, extra) {
      var w = ws();
      var sid = (extra && extra.sessionId) || ctx.sid;
      if (!w || typeof w.sendToDevice !== "function" || !sid) return;
      w.sendToDevice(did, { sessionId: sid }, kind, extra);
    }

    /* ---------- chemins / suppression ---------- */

    function baseSystemPath() {
      var st = storageNative();
      if (!st || typeof st.systemPath !== "function" || typeof st.defaultPath !== "function") return "";
      var sp = st.systemPath(st.defaultPath());
      return sp || "";
    }

    function mediaRoot(sid, take) {
      var b = baseSystemPath();
      return b ? (b.replace(/\/$/, "") + "/MultiCam/" + sid + "/" + take) : "";
    }

    function destFor(sid, take, rel) {
      var relFull = "MultiCam/" + sid + "/" + take + "/" + rel;
      if (cfg.storage && cfg.storage.mode === "saf" && cfg.storage.treeUri) {
        return { treeUri: cfg.storage.treeUri, relPath: relFull };
      }
      var b = baseSystemPath();
      return { dest: b ? (b.replace(/\/$/, "") + "/" + relFull) : relFull };
    }

    /* Segments locaux d'un Take. V1 : le protocole START/J10 publie un seul
     * `path` (stop_state) — donc un seul segment tant que la segmentation n'est
     * pas en place. La liste est dérivée des FAITS, jamais inventée. */
    function listSegments() {
      var svc = startService();
      var m = svc && svc.machine ? svc.machine() : null;
      var v = m && m.view ? m.view() : null;
      var self = svc && svc.selfDid ? svc.selfDid() : "";
      var info = (v && v.stopStates && self) ? v.stopStates[self] : null;
      var path = (info && info.path) || (v && v.localStopInfo && v.localStopInfo.path) || "";
      if (!path) return [];
      return [{ rel: baseName(path), segmentIndex: 0, path: path }];
    }

    function deleteLocalFiles(paths) {
      if (!paths || !paths.length) return Promise.resolve();
      if (typeof root.resolveLocalFileSystemURL !== "function") return Promise.resolve();
      return Promise.all(paths.map(function (p) {
        return new Promise(function (resolve) {
          root.resolveLocalFileSystemURL(p, function (entry) {
            entry.remove(function () { resolve(true); }, function () { resolve(false); });
          }, function () { resolve(false); });
        });
      })).then(function (rs) {
        log("TRANSFER_LOCAL_DELETE_NATIVE files=" + paths.length + " removed=" + rs.filter(Boolean).length);
      });
    }

    /* ---------- contexte session/take ---------- */

    function takeOfSession(s) {
      if (!s || !Array.isArray(s.takes) || !s.takes.length) return null;
      var tm = takeModel();
      if (tm && typeof tm.takeAt === "function") {
        return tm.takeAt(s.takes, ctx.takeNumber) || s.takes[s.takes.length - 1];
      }
      return s.takes[s.takes.length - 1];
    }

    function loadCtx(sid, takeNumber) {
      if (!sid) return Promise.resolve(null);
      if (ctx.sid === sid && ctx.takeNumber === takeNumber && ctx.take) return Promise.resolve(ctx.take);
      if (ctx.loading) return Promise.resolve(ctx.take);
      var store = sessionStore();
      if (!store || typeof store.get !== "function") return Promise.resolve(null);
      ctx.loading = true;
      ctx.sid = sid;
      ctx.takeNumber = takeNumber || ctx.takeNumber;
      return Promise.resolve(store.get(sid)).then(function (s) {
        ctx.take = takeOfSession(s);
        ctx.loading = false;
        return ctx.take;
      }).catch(function () { ctx.loading = false; return null; });
    }

    /* ---------- deps modèle/service ---------- */

    function buildMachine() {
      return modelMod().createMachine({
        role: role, sid: ctx.sid, self: function () {
          var svc = startService();
          return svc && svc.selfDid ? svc.selfDid() : (cfg.deviceId || "");
        },
        takeNumber: ctx.takeNumber,
        log: log, send: sendOnWs, sendTo: sendToWs
      });
    }

    function buildService() {
      return serviceMod().createTransferService({
        model: machine,
        native: nativeApi(),
        role: role,
        self: function () {
          var svc = startService();
          return svc && svc.selfDid ? svc.selfDid() : (cfg.deviceId || "");
        },
        log: log,
        take: function () {
          return {
            sessionId: ctx.sid,
            takeNumber: ctx.takeNumber,
            storages: (ctx.take && ctx.take.storages) || []
          };
        },
        settings: function () {
          var st = (ctx.take && ctx.take.settings) || {};
          return {
            transferAuto: st.transferAuto !== false,
            deleteLocalAfterVerifiedReplication: st.deleteLocalAfterVerifiedReplication !== false
          };
        },
        paths: { mediaRoot: mediaRoot, destFor: destFor, listSegments: listSegments },
        isRecording: function () {
          var svc = startService();
          return !!(svc && svc.isRecording && svc.isRecording());
        },
        deleteLocal: deleteLocalFiles,
        generateToken: function () {
          var did = (startService() && startService().selfDid && startService().selfDid()) || cfg.deviceId || "mc";
          return did + "-" + Date.now().toString(36);
        }
      });
    }

    /* ---------- assemblage paresseux ---------- */

    /* Construit (ou reconstruit) machine+service pour le Take courant. Le
     * modèle fige sid/takeNumber à sa création : toute bascule de session/take
     * impose de réassembler pour que les messages portent le bon en-tête. */
    function ensure() {
      var k = ctx.sid + "|" + ctx.takeNumber;
      if (machine && service && builtFor === k) return service;
      machine = buildMachine();
      service = buildService();
      builtFor = k;
      log("TRANSFER_BOOT_READY role=" + role + " sid=" + ctx.sid + " take=" + ctx.takeNumber);
      return service;
    }

    /* ---------- déclencheurs ---------- */

    function maybeCaptureAnnounce(v) {
      if (role !== "capture") return Promise.resolve(null);
      if (!v || !v.localStoppedTake) return Promise.resolve(null);
      var key = ctx.sid + "|" + ctx.takeNumber;
      if (announced[key]) return Promise.resolve(null);
      announced[key] = true;
      log("TRANSFER_ANNOUNCE_TRIGGER sessionId=" + ctx.sid + " take=" + ctx.takeNumber);
      return Promise.resolve(ensure().captureAnnounce()).catch(function (e) {
        announced[key] = false;
        log("TRANSFER_ANNOUNCE_ERROR " + String((e && e.message) || e));
        return null;
      });
    }

    function onStartView(v) {
      if (!v || !v.sid) return Promise.resolve(null);
      return loadCtx(v.sid, v.takeNumber).then(function () {
        ensure();
        return maybeCaptureAnnounce(v);
      });
    }

    /* Rejoue les téléchargements mis en pause par la garde RECORDING. */
    function resumePaused() {
      Object.keys(pausedOffers).forEach(function (src) {
        var offer = pausedOffers[src];
        delete pausedOffers[src];
        ensure().storageRun(offer);
      });
    }

    /* ---------- entrée transport ---------- */

    function onTransferMessage(env) {
      if (!env || !env.sessionId) return Promise.resolve(false);
      /* Garde RECORDING : une offre reçue pendant un Take est mise en attente et
       * rejouée à la fin du Take (voir resumePaused) — on n'engage même pas le
       * téléchargement. */
      if (role === "storage" && env.kind === "transfer_offer") {
        var svc = startService();
        var rec = !!(svc && svc.isRecording && svc.isRecording());
        if (rec) {
          pausedOffers[env.sourceDeviceId] = env;
          log("TRANSFER_PAUSE source=" + env.sourceDeviceId + " reason=recording");
          return Promise.resolve(false);
        }
      }
      return loadCtx(env.sessionId, env.takeNumber).then(function () {
        return ensure().handle(env);
      });
    }

    function bind() {
      if (bound) return;
      bound = true;

      var w = ws();
      if (w && typeof w.setTransferBridge === "function") {
        w.setTransferBridge({ onTransferMessage: onTransferMessage });
      }

      var svc = startService();
      if (svc && typeof svc.onView === "function") {
        svc.onView(function (v) {
          onStartView(v);
          if (!(svc.isRecording && svc.isRecording())) resumePaused();
        });
      }
      log("TRANSFER_BOOT_ARMED role=" + role);
    }

    /* ---------- API UI ---------- */

    /* Vue agrégée pour l'écran 09 / la vue Storage : sources + transferts. */
    function view() {
      if (!machine) return { sid: ctx.sid, takeNumber: ctx.takeNumber, transfers: {}, sources: {} };
      return machine.view();
    }

    /* Réessai manuel : ré-émet l'offre du Master pour une source donnée. */
    function retry(sourceDeviceId) {
      if (role !== "master") return [];
      return service.masterOffer(sourceDeviceId);
    }

    return {
      bind: bind,
      view: view,
      retry: retry,
      role: function () { return role; },
      _ctx: ctx,
      _loadCtx: loadCtx,
      _onStartView: onStartView,
      _onTransferMessage: onTransferMessage,
      _resumePaused: resumePaused,
      _maybeCaptureAnnounce: maybeCaptureAnnounce,
      _machine: function () { return machine; },
      _service: function () { return service; }
    };
  }

  return { roleFor: roleFor, createTransferBoot: createTransferBoot };
});
