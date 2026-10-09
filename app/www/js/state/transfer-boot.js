/* MultiCam J11 — bootstrap du transfert média.
 *
 * Assemble les pièces (modèle pur + service + briques natives) et les câble au
 * monde réel : rôles du device, sessions/takes suivis (Storage sélectionnés,
 * réglages), transport WS, et déclenchement après STOP.
 *
 * Rôle du device (v1, priorité) : controller → master, capture → capture,
 * sinon storage. Un device multi-rôle (Master ET Storage) n'est pas géré par ce
 * bootstrap — un log explicite le signale.
 *
 * ---------- J11-UI-CONFORMANCE : registre multi-(session, take) ----------
 *
 * Une vue Storage validée (`ui/07-countdown/storage.html`) suit PLUSIEURS
 * sessions et plusieurs Takes SIMULTANÉMENT. Le premier assemblage ne tenait
 * qu'UNE machine : la réception d'un take N+1 écrasait le take N (perte de
 * progression, offre écrasée). On tient donc désormais un REGISTRE indexé par
 * « sid|take », et chaque entrée possède sa PROPRE machine/service — le
 * modèle fige l'en-tête de session à sa création, une machine ne peut donc pas
 * servir deux Takes. Aucune donnée partagée n'est dupliquée : les entrées
 * lisent les MÊMES dépendances injectées (WS, store, natif).
 *
 * `viewFor(sid, take)` / `views()` exposent le registre à la vue Storage ;
 * `view()`/`_machine()` restent le Take PRIMAIRE (dernier assemblé) pour
 * l'écran 09 et le retry, qui restent mono-Take par nature.
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

  function isNum(v) { return typeof v === "number" && isFinite(v); }

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
    var entries = {};      /* "sid|take" -> { sid, takeNumber, take, machine, service, loading } */
    var primary = null;    /* entrée du Take le plus récemment assemblé */
    var bound = false;
    var announced = {};    /* "sid|take" -> true */
    var pausedOffers = {}; /* "sid|take|src" -> offre en attente (garde REC) */
    var listeners = [];    /* fn() appelés à chaque changement de l'état transfert */

    function keyOf(sid, take) { return String(sid) + "|" + String(take); }

    function selfDid() {
      var svc = startService();
      return (svc && svc.selfDid && svc.selfDid()) || cfg.deviceId || "";
    }

    /* ---------- transport ---------- */

    function sendOnWs(kind, extra) {
      var w = ws();
      var sid = (extra && extra.sessionId) || (primary && primary.sid) || "";
      if (!w || typeof w.broadcastTargeted !== "function" || !sid) return;
      w.broadcastTargeted(kind, { sessionId: sid }, extra);
    }

    function sendToWs(did, kind, extra) {
      var w = ws();
      var sid = (extra && extra.sessionId) || (primary && primary.sid) || "";
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

    /* ---------- registre session/take ---------- */

    function entryOf(sid, takeNumber) {
      var k = keyOf(sid, takeNumber);
      if (!entries[k]) {
        entries[k] = { sid: sid, takeNumber: takeNumber, take: null, machine: null, service: null, loading: null };
      }
      return entries[k];
    }

    /* Charge (une fois) le Take d'une session depuis le store, sans écraser les
     * autres entrées — c'est ce qui permet de suivre plusieurs Takes. */
    function loadEntry(sid, takeNumber) {
      if (!sid) return Promise.resolve(null);
      var e = entryOf(sid, takeNumber);
      if (e.take) return Promise.resolve(e.take);
      if (e.loading) return e.loading;
      var store = sessionStore();
      if (!store || typeof store.get !== "function") return Promise.resolve(null);
      e.loading = Promise.resolve(store.get(sid)).then(function (s) {
        var takes = (s && s.takes) || [];
        var tm = takeModel();
        e.take = (tm && typeof tm.takeAt === "function")
          ? (tm.takeAt(takes, takeNumber) || takes[takes.length - 1] || null)
          : (takes[takes.length - 1] || null);
        e.loading = null;
        return e.take;
      }).catch(function () { e.loading = null; return null; });
      return e.loading;
    }

    /* ---------- assemblage par entrée ---------- */

    function buildMachine(e) {
      return modelMod().createMachine({
        role: role, sid: e.sid, self: selfDid,
        takeNumber: e.takeNumber,
        log: log, send: sendOnWs, sendTo: sendToWs
      });
    }

    function buildService(e) {
      return serviceMod().createTransferService({
        model: e.machine,
        native: nativeApi(),
        role: role,
        self: selfDid,
        log: log,
        take: function () {
          return {
            sessionId: e.sid,
            takeNumber: e.takeNumber,
            storages: (e.take && e.take.storages) || []
          };
        },
        settings: function () {
          var st = (e.take && e.take.settings) || {};
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
          return selfDid() ? (selfDid() + "-" + Date.now().toString(36)) : ("mc-" + Date.now().toString(36));
        }
      });
    }

    /* Assemble (ou rend) la machine+service d'un Take. Le registre évite tout
     * doublon : une même entrée n'est assemblée qu'une fois. */
    function ensureFor(sid, takeNumber) {
      var e = entryOf(sid, takeNumber);
      if (!e.machine || !e.service) {
        e.machine = buildMachine(e);
        e.service = buildService(e);
        log("TRANSFER_BOOT_READY role=" + role + " sid=" + sid + " take=" + takeNumber);
      }
      primary = e;
      return e.service;
    }

    /* ---------- notification UI ---------- */

    function notify() {
      listeners.slice().forEach(function (fn) {
        try { fn(); } catch (e) { log("TRANSFER_NOTIFY_ERROR " + String((e && e.message) || e)); }
      });
    }

    /* ---------- déclencheurs ---------- */

    function maybeCaptureAnnounce(v) {
      if (role !== "capture") return Promise.resolve(null);
      if (!v || !v.localStoppedTake) return Promise.resolve(null);
      var key = keyOf(v.sid, v.takeNumber);
      if (announced[key]) return Promise.resolve(null);
      announced[key] = true;
      log("TRANSFER_ANNOUNCE_TRIGGER sessionId=" + v.sid + " take=" + v.takeNumber);
      return Promise.resolve(ensureFor(v.sid, v.takeNumber).captureAnnounce()).catch(function (e) {
        announced[key] = false;
        log("TRANSFER_ANNOUNCE_ERROR " + String((e && e.message) || e));
        return null;
      }).then(function (r) { notify(); return r; });
    }

    function onStartView(v) {
      if (!v || !v.sid) return Promise.resolve(null);
      var take = v.takeNumber || 0;
      return loadEntry(v.sid, take).then(function () {
        ensureFor(v.sid, take);
        return maybeCaptureAnnounce(v);
      });
    }

    /* Rejoue les téléchargements mis en pause par la garde RECORDING. Chaque
     * offre est routée vers SON Take (registre), jamais vers le Take primaire. */
    function resumePaused() {
      Object.keys(pausedOffers).forEach(function (pk) {
        var offer = pausedOffers[pk];
        delete pausedOffers[pk];
        var take = isNum(offer.takeNumber) ? offer.takeNumber : 0;
        Promise.resolve(loadEntry(offer.sessionId, take)).then(function () {
          ensureFor(offer.sessionId, take).storageRun(offer);
        });
      });
      notify();
    }

    /* ---------- entrée transport ---------- */

    function onTransferMessage(env) {
      if (!env || !env.sessionId) return Promise.resolve(false);
      var take = isNum(env.takeNumber) ? env.takeNumber
        : ((primary && primary.sid === env.sessionId) ? primary.takeNumber : 0);
      /* Garde RECORDING : une offre reçue pendant un Take est mise en attente et
       * rejouée à la fin du Take (voir resumePaused) — on n'engage même pas le
       * téléchargement. */
      if (role === "storage" && env.kind === "transfer_offer") {
        var svc = startService();
        if (svc && svc.isRecording && svc.isRecording()) {
          pausedOffers[keyOf(env.sessionId, take) + "|" + env.sourceDeviceId] = env;
          log("TRANSFER_PAUSE source=" + env.sourceDeviceId + " reason=recording");
          return Promise.resolve(false);
        }
      }
      return loadEntry(env.sessionId, take).then(function () {
        return ensureFor(env.sessionId, take).handle(env);
      }).then(function (ok) {
        notify();
        return ok;
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

    function emptyView(sid, takeNumber) {
      return { sid: sid || "", takeNumber: takeNumber || 0, transfers: {}, sources: {} };
    }

    /* Vue du Take PRIMAIRE (écran 09, mono-Take). */
    function view() {
      if (!primary || !primary.machine) return emptyView();
      return primary.machine.view();
    }

    /* Vue d'un Take précis (vue Storage multi-Take), ou null si inconnu. */
    function viewFor(sid, takeNumber) {
      var e = entries[keyOf(sid, takeNumber)];
      return (e && e.machine) ? e.machine.view() : null;
    }

    /* Toutes les entrées connues (pour la vue Storage). Lecture seule. */
    function views() {
      return Object.keys(entries).map(function (k) {
        var e = entries[k];
        return { sid: e.sid, takeNumber: e.takeNumber, view: e.machine ? e.machine.view() : emptyView(e.sid, e.takeNumber) };
      });
    }

    /* Réessai manuel : ré-émet l'offre du Master pour une source donnée. */
    function retry(sourceDeviceId) {
      if (role !== "master" || !primary || !primary.service) return [];
      return primary.service.masterOffer(sourceDeviceId);
    }

    return {
      bind: bind,
      view: view,
      viewFor: viewFor,
      views: views,
      retry: retry,
      role: function () { return role; },
      onChange: function (fn) { if (typeof fn === "function" && listeners.indexOf(fn) < 0) listeners.push(fn); },
      offChange: function (fn) { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      _entries: function () { return entries; },
      _primary: function () { return primary; },
      _loadEntry: loadEntry,
      _ensureFor: ensureFor,
      _onStartView: onStartView,
      _onTransferMessage: onTransferMessage,
      _resumePaused: resumePaused,
      _maybeCaptureAnnounce: maybeCaptureAnnounce,
      _machine: function () { return primary ? primary.machine : null; },
      _service: function () { return primary ? primary.service : null; }
    };
  }

  return { roleFor: roleFor, createTransferBoot: createTransferBoot };
});
