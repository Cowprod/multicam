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

    /* J14-B02 — anti-tempête. Chaque message de transfert entrant (dont la
     * progression) appelait `notify()` → `updateTakeFromTransfers()` →
     * `upsertTake()` → broadcast du sharedView COMPLET + `notifyChanged()`. En
     * 4 devices avec 2 Captures qui transfèrent, ce chemin soutenait la boucle
     * d'annonces. On COALESCE l'écriture de la progression (leading + trailing) :
     * la 1re passe, les suivantes sont regroupées, et un flush de fin de fenêtre
     * garantit que l'état TERMINAL (done/error) est toujours persisté. */
    var PERSIST_COALESCE_MS = 1000;
    var persistTimer = null;
    var persistLastAt = 0;
    var persistDirty = false;

    /* MultiCam D-SERVE: état du serveur média UNIQUE, partagé par TOUS les
     * Takes/services du boot. `tokens` associe "sid/take" → token ; il ne doit
     * jamais être dupliqué par entrée, sinon les autorisations divergent. */
    var serverState = { running: false, url: "", host: "", port: 0, tokens: {} };

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

    /* J14-B03 : la destination d'un segment DOIT être unique par Capture. Le
     * nom de fichier seul (`videoTmp.mp4`) est identique pour toutes les
     * Captures d'un Take : sans le deviceId source dans le chemin, deux
     * Captures écrivant vers le même Storage se collisionnent (fichier partagé,
     * écritures entremêlées, SHA-256 destination ≠ source). L'arborescence
     * devient Session / Take / <sourceDeviceId> / <segment>. */
    function destFor(sid, take, sourceDeviceId, rel) {
      var relFull = "MultiCam/" + sid + "/" + take + "/" + sourceDeviceId + "/" + rel;
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

    /* STAGING : la Capture écrit dans le cache interne
     * (`cache/videoTmp_N.mp4`, cf. CameraPreview.java) alors que le serveur
     * média sert `MultiCam/<sid>/<take>/`. On déplace donc chaque segment vers
     * son emplacement définitif AVANT le calcul SHA-256 et le démarrage du
     * serveur — sinon le serveur répond 500 (dossier inexistant). Le map
     * `stagedMap` rend l'opération idempotente : un même (sid,take,rel) n'est
     * déplacé qu'une fois, et la suppression locale ultérieure retrouve la
     * cible même si la source a disparu. */
    var stagedMap = {}; /* "sid|take|rel" -> chemin stagé */

    function stageSegments(sid, take) {
      var segs = listSegments();
      if (!segs.length) return Promise.resolve([]);
      var root = mediaRoot(sid, take);
      if (!root) return Promise.resolve(segs);
      var nat = nativeApi();
      return Promise.all(segs.map(function (s) {
        var key = keyOf(sid, take) + "|" + s.rel;
        var target = root.replace(/\/$/, "") + "/" + s.rel;
        if (stagedMap[key]) {
          return { rel: s.rel, segmentIndex: s.segmentIndex, path: stagedMap[key] };
        }
        if (s.path === target) {
          stagedMap[key] = target;
          return { rel: s.rel, segmentIndex: s.segmentIndex, path: target };
        }
        if (!nat || typeof nat.stage !== "function") return s;
        return nat.stage(s.path, target).then(function (r) {
          var finalPath = (r && r.dest) || target;
          stagedMap[key] = finalPath;
          log("TRANSFER_STAGE_OK rel=" + s.rel + " dest=" + finalPath);
          return { rel: s.rel, segmentIndex: s.segmentIndex, path: finalPath };
        }, function (e) {
          log("TRANSFER_STAGE_ERROR rel=" + s.rel + " error=" + String((e && e.message) || e));
          return s;
        });
      }));
    }

    /* Segments STAGÉS d'un Take précis (identifié par session+Take), indépendants
     * du Take « courant » : base de la suppression ciblée (J14-C01 / D3). La clé
     * `sid|take|rel` mémorise l'emplacement définitif même après disparition de
     * la source, donc la suppression retrouve SA cible à tout moment. */
    function listSegmentsFor(sid, take) {
      var prefix = keyOf(sid, take) + "|";
      var out = [];
      Object.keys(stagedMap).forEach(function (k) {
        if (k.indexOf(prefix) === 0) out.push({ rel: k.slice(prefix.length), segmentIndex: 0, path: stagedMap[k] });
      });
      return out;
    }

    /* Cette Capture a-t-elle annoncé (donc stagé) un média pour ce Take ? */
    function hasTake(sid, take) {
      return !!announced[keyOf(sid, take)] || listSegmentsFor(sid, take).length > 0;
    }

    /* Suppression locale des segments. Le NATIF d'abord (verdict réel, et il
     * accepte un chemin absolu nu) ; sinon repli sur l'API File HTML5 (résout
     * mal les chemins nus du stockage externe : `removed=0` observé).
     * Rend un RÉSULTAT exploitable `{ok, removed, failed, requested}` : le
     * service n'émet l'ACK de suppression que si `ok` est vrai (J14-C01 / D3). */
    function deleteLocalFiles(paths) {
      if (!paths || !paths.length) {
        return Promise.resolve({ ok: true, removed: 0, failed: 0, requested: 0 });
      }
      var nat = nativeApi();
      var useNative = nat && typeof nat.remove === "function";
      return Promise.all(paths.map(function (p) {
        if (useNative) {
          return nat.remove(p).then(function (r) {
            /* `removed` OU « déjà absent » (idempotence) = succès. */
            return !!(r && (r.removed || r.existed === false));
          }, function () { return false; });
        }
        if (typeof root.resolveLocalFileSystemURL !== "function") return Promise.resolve(false);
        return new Promise(function (resolve) {
          root.resolveLocalFileSystemURL(p, function (entry) {
            entry.remove(function () { resolve(true); }, function () { resolve(false); });
          }, function () { resolve(false); });
        });
      })).then(function (rs) {
        var removed = rs.filter(Boolean).length;
        var failed = rs.length - removed;
        log("TRANSFER_LOCAL_DELETE_NATIVE files=" + paths.length + " removed=" + removed);
        return { ok: failed === 0, removed: removed, failed: failed, requested: paths.length };
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
        now: deps.now,
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
        server: serverState,
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
        paths: {
          mediaRoot: mediaRoot, destFor: destFor,
          listSegments: listSegments, stageSegments: stageSegments,
          listSegmentsFor: listSegmentsFor, hasTake: hasTake
        },
        /* Backoff entre tentatives : absorb les coupures réseau transitoires
         * sans saturer (J14-C01 / D2). */
        delay: function (attempt) {
          var ms = Math.min(4000, 500 * Math.pow(2, Math.max(0, (attempt || 1) - 1)));
          return new Promise(function (r) { setTimeout(r, ms); });
        },
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

    function scheduleTakePersist() {
      persistDirty = true;
      if (persistTimer !== null) return;
      var now = Date.now();
      if ((now - persistLastAt) >= PERSIST_COALESCE_MS) {
        flushTakePersist();
      } else {
        persistTimer = setTimeout(function () {
          persistTimer = null;
          flushTakePersist();
        }, PERSIST_COALESCE_MS - (now - persistLastAt));
      }
    }

    function flushTakePersist() {
      if (!persistDirty) return;
      persistDirty = false;
      persistLastAt = Date.now();
      try { updateTakeFromTransfers(); } catch (e) {}
    }

    function notify() {
      /* L'AFFICHAGE (listeners) reste immédiat : l'UI de transfert doit suivre
       * la progression en temps réel. Seule la PERSISTANCE de session (qui
       * broadcast à tous les pairs) est coalescée. */
      scheduleTakePersist();
      listeners.slice().forEach(function (fn) {
        try { fn(); } catch (e) { log("TRANSFER_NOTIFY_ERROR " + String((e && e.message) || e)); }
      });
    }

    function updateTakeFromTransfers() {
      var wsApi = ws();
      var storeApi = sessionStore();
      var takeMod = takeModel();
      if (!wsApi || typeof wsApi.upsertTake !== "function" || !storeApi || typeof storeApi.get !== "function" || !takeMod) return;
      if (!primary || !primary.sid || !primary.machine) return;
      var v = primary.machine.view();
      if (!v || !v.transfers) return;
      storeApi.get(primary.sid).then(function (ses) {
        if (!ses) return;
        var takes = ses.takes || [];
        var take = null;
        for (var i = 0; i < takes.length; i++) {
          if (takes[i] && takes[i].takeNumber === (primary.takeNumber || 0)) { take = takes[i]; break; }
        }
        if (!take) return;
        var t2 = JSON.parse(JSON.stringify(take));
        t2.updatedAtMs = Date.now();
        var keys = Object.keys(v.transfers);
        var transfers = v.transfers;
        var done = 0, error = 0, totalFiles = 0, bytes = 0, totalBytes = 0;
        keys.forEach(function (k) {
          var tr = transfers[k];
          if (!tr) return;
          var f = tr.files || [];
          totalFiles += f.length;
          bytes += Number(tr.bytes) || 0;
          totalBytes += Number(tr.total) || 0;
          if (tr.state === "done") done += 1;
          if (tr.state === "error") error += 1;
        });
        var transferState = "TRANSFERRING";
        if (error > 0 && done === 0 && keys.length > 0) transferState = "ERROR";
        else if (error > 0 && done > 0) transferState = "ERROR";
        else if (keys.length > 0 && done === keys.length) transferState = "TERMINATED";
        var summary = t2.summary ? JSON.parse(JSON.stringify(t2.summary)) : {
          stoppedAtMs: 0, durationMs: 0, stopReason: "", transferState: "", transferError: "",
          transferBytes: 0, transferTotal: 0, transferPercent: 0, transfers: {}
        };
        summary.transferState = transferState;
        summary.transferBytes = bytes;
        summary.transferTotal = totalBytes || bytes;
        summary.transferPercent = (totalBytes > 0) ? Math.round((bytes / totalBytes) * 100) : (keys.length > 0 ? (done * 100 / keys.length) : 0);
        if (transferState === "ERROR" && error > 0) summary.transferError = "transfer_error";
        if (t2.status !== takeMod.STATUS_TERMINATED) {
          if (transferState === "TERMINATED") t2.status = takeMod.STATUS_TERMINATED;
          else if (transferState === "ERROR") t2.status = takeMod.STATUS_ERROR;
        }
        t2.summary = summary;
        wsApi.upsertTake(ses, t2).catch(function (e) { log("TAKE_TRANSFER_PERSIST_ERR " + String((e && e.message) || e)); });
      }).catch(function (e) { log("TAKE_TRANSFER_PERSIST_SERR " + String((e && e.message) || e)); });
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

    /* ---------- réconciliation & détection de blocage (J14-C01 / D1) ---------- */

    var nowMs = deps.now || function () { return Date.now(); };
    var setI = deps.setInterval || (typeof setInterval !== "undefined" ? setInterval : null);
    var clearI = deps.clearInterval || (typeof clearInterval !== "undefined" ? clearInterval : null);
    var WATCHDOG_MS = isNum(deps.watchdogMs) ? deps.watchdogMs : 5000;
    var STUCK_MS = isNum(deps.stuckMs) ? deps.stuckMs : 45000;
    var STUCK_MAX_REOFFERS = isNum(deps.stuckMaxReoffers) ? deps.stuckMaxReoffers : 3;
    var REIDENTIFY_THROTTLE_MS = isNum(deps.reidentifyThrottleMs) ? deps.reidentifyThrottleMs : 10000;
    var watchdogTimer = null;
    var stuckState = {};     /* "sid|take|src|storage" -> { count, baseAt } */
    var lastReidentify = 0;  /* throttling de la réconciliation de maillage */

    /* Un pair vient de se (ré)identifier sur une connexion restaurée — miroir de
     * `resyncCameraState`. Le Master RE-OFFRE un transfert non terminal (l'offre
     * initiale a pu être perdue pendant la coupure) ; le Storage RE-DIFFUSE ses
     * issues terminales (le résultat a pu être perdu). Throttlé : le maillage
     * livre plusieurs évènements par pair, on ne veut pas de tempête (J14-B02). */
    function onPeerIdentified(env) {
      var now = nowMs();
      if (now - lastReidentify < REIDENTIFY_THROTTLE_MS) return 0;
      lastReidentify = now;
      var cameFrom = env && (env.from || env.deviceId);
      var n = 0;
      Object.keys(entries).forEach(function (k) {
        var e = entries[k];
        if (!e.machine || !e.service) return;
        if (role === "master") {
          if (cameFrom && e.machine.state.sources[cameFrom]) { e.service.masterOffer(cameFrom); n += 1; }
        } else if (role === "storage") {
          n += e.machine.rebroadcastTerminalResults();
        }
      });
      if (n) log("TRANSFER_RESYNC_TRIGGER role=" + role + " peer=" + (cameFrom || "") + " count=" + n);
      return n;
    }

    /* Reconnexion du transport LOCAL (socket WS rétablie) : le Storage re-diffuse
     * ses issues terminales. S'il n'y a encore aucun destinataire joignable, la
     * ré-émission est inoffensive et sera retentée au prochain pair identifié. */
    function onTransportReconnect() {
      if (role !== "storage") return 0;
      var n = 0;
      Object.keys(entries).forEach(function (k) {
        var e = entries[k];
        if (e.machine) n += e.machine.rebroadcastTerminalResults();
      });
      if (n) log("TRANSFER_RESYNC_RECONNECT role=" + role + " count=" + n);
      return n;
    }

    /* Un tick : rejoue les suppressions DIFFÉRÉES devenues sûres, puis débloque
     * les transferts figés. Jamais pendant un RECORDING : la « pause » d'un
     * téléchargement pendant un Take est LÉGITIME, pas un échec. */
    function watchdogTick(atMs) {
      var svc = startService();
      var recording = !!(svc && svc.isRecording && svc.isRecording());
      Object.keys(entries).forEach(function (k) {
        var e = entries[k];
        if (e.service && role === "capture" && typeof e.service.retryDeferredDeletes === "function") {
          e.service.retryDeferredDeletes();
        }
      });
      if (recording) return 0;
      var now = isNum(atMs) ? atMs : nowMs();
      var acted = 0;
      Object.keys(entries).forEach(function (entryKey) {
        var e = entries[entryKey];
        if (!e.machine || !e.service) return;
        e.machine.staleTransfers(STUCK_MS, now).forEach(function (s) {
          if (role === "master") { applyMasterStuck(entryKey, e, s, now); acted += 1; }
          else if (role === "storage") {
            if (e.machine.markTransferStuck(s.sourceDeviceId, s.storageDeviceId, "stalled", now)) acted += 1;
          }
        });
      });
      if (acted) notify();
      return acted;
    }

    /* Master : relance bornée avec backoff, puis marque en échec. Une progression
     * reçue (updatedAtMs avance) remet le compteur à zéro. */
    function applyMasterStuck(entryKey, e, s, now) {
      var sk = entryKey + "|" + s.sourceDeviceId + "|" + s.storageDeviceId;
      var st = stuckState[sk] || { count: 0, baseAt: s.updatedAtMs };
      if (st.count > 0 && s.updatedAtMs > st.baseAt) st = { count: 0, baseAt: s.updatedAtMs };
      if (st.count >= STUCK_MAX_REOFFERS) {
        e.machine.markTransferStuck(s.sourceDeviceId, s.storageDeviceId, "stalled", now);
        delete stuckState[sk];
        log("TRANSFER_STUCK_FINAL source=" + s.sourceDeviceId + " storage=" + s.storageDeviceId + " staleMs=" + s.staleMs);
        return;
      }
      if (s.staleMs >= STUCK_MS * (st.count + 1)) {
        st.count += 1;
        st.baseAt = s.updatedAtMs;
        stuckState[sk] = st;
        log("TRANSFER_STUCK_REOFFER source=" + s.sourceDeviceId + " storage=" + s.storageDeviceId + " attempt=" + st.count);
        e.service.masterOffer(s.sourceDeviceId);
      } else {
        stuckState[sk] = st;
      }
    }

    function startWatchdog() {
      if (watchdogTimer !== null || !setI) return;
      watchdogTimer = setI(function () {
        try { watchdogTick(); } catch (e) { log("TRANSFER_WATCHDOG_ERR " + String((e && e.message) || e)); }
      }, WATCHDOG_MS);
      /* Ne pas retenir le process (Node) — l'horloge est aussi pilotable en test. */
      if (watchdogTimer && typeof watchdogTimer.unref === "function") watchdogTimer.unref();
    }

    function stopWatchdog() {
      if (watchdogTimer === null) return;
      if (clearI) clearI(watchdogTimer);
      watchdogTimer = null;
    }

    function bind() {
      if (bound) return;
      bound = true;

      var w = ws();
      if (w && typeof w.setTransferBridge === "function") {
        w.setTransferBridge({
          onTransferMessage: onTransferMessage,
          onPeerIdentified: onPeerIdentified,
          onTransportReconnect: onTransportReconnect
        });
      }
      startWatchdog();

      var svc = startService();
      if (svc && typeof svc.onView === "function") {
        /* Le service START notifie ses écouteurs SANS argument
         * (`listeners.slice().forEach(fn => fn())`) : on relit donc la vue
         * courante nous-mêmes, sinon `v` serait toujours `undefined` et
         * l'annonce Capture ne se déclencherait jamais au STOP. */
        svc.onView(function () {
          var v = (svc.view && svc.view()) || null;
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

    /* MultiCam D-SERVE: arrête le serveur média partagé UNIQUEMENT s'il ne reste
     * plus aucun Take autorisé (fermeture de session). À NE PAS appeler sur une
     * suppression de Take : celle-ci retire une autorisation, pas le serveur. */
    function stopServerIfIdle() {
      if (!serverState.running) return Promise.resolve();
      if (Object.keys(serverState.tokens).length > 0) return Promise.resolve();
      var api = nativeApi();
      serverState.running = false;
      serverState.url = "";
      serverState.host = "";
      serverState.port = 0;
      serverState.tokens = {};
      if (api && typeof api.serveStop === "function") return api.serveStop();
      return Promise.resolve();
    }

    return {
      bind: bind,
      view: view,
      viewFor: viewFor,
      views: views,
      retry: retry,
      stopServerIfIdle: stopServerIfIdle,
      role: function () { return role; },
      onChange: function (fn) { if (typeof fn === "function" && listeners.indexOf(fn) < 0) listeners.push(fn); },
      offChange: function (fn) { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      _entries: function () { return entries; },
      _primary: function () { return primary; },
      _loadEntry: loadEntry,
      _ensureFor: ensureFor,
      _onStartView: onStartView,
      _onTransferMessage: onTransferMessage,
      _onPeerIdentified: onPeerIdentified,
      _onTransportReconnect: onTransportReconnect,
      _watchdogTick: watchdogTick,
      _startWatchdog: startWatchdog,
      _stopWatchdog: stopWatchdog,
      _resumePaused: resumePaused,
      _maybeCaptureAnnounce: maybeCaptureAnnounce,
      _machine: function () { return primary ? primary.machine : null; },
      _service: function () { return primary ? primary.service : null; }
    };
  }

  return { roleFor: roleFor, createTransferBoot: createTransferBoot };
});
