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
  function isStr(v) { return typeof v === "string" && v.length > 0; }

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
    var journalMod = deps.transferJournal || function () { return root.MultiCamTransferJournal; };
    var discoveryMod = deps.discovery || function () { return root.MultiCamDiscovery; };
    var catalogueMod = deps.catalogueModel || function () { return root.MultiCamMediaCatalogueModel; };
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

    /* STAGING : le recorder écrit directement dans files/recordings, et
     * le serveur média sert MultiCam/<sid>/<take>/. Une copie est préparée
     * avant le hash et le serveur. La source est conservée : sa publication
     * SAF peut être en cours simultanément. stagedMap rend cette copie
     * idempotente et identifie la cible servie pour la politique de rétention. */
    var stagedMap = {}; /* "sid|take|rel" -> chemin stagé */

    var sourceIndex = {};
    var SOURCE_INDEX_KEY = "multicam.local-recordings.v1";
    try { sourceIndex = JSON.parse(root.localStorage && root.localStorage.getItem(SOURCE_INDEX_KEY) || "{}"); } catch (e) {}

    function rememberSegments(sid, take, segs) {
      if (!segs.length) return segs;
      sourceIndex[keyOf(sid, take)] = segs;
      try { if (root.localStorage) root.localStorage.setItem(SOURCE_INDEX_KEY, JSON.stringify(sourceIndex)); }
      catch (e) { log("TRANSFER_SOURCE_INDEX_ERROR " + String(e)); }
      return segs;
    }

    function privateRecordingsDir() {
      if (deps.privateRecordingsDir) return deps.privateRecordingsDir;
      var data = root.cordova && root.cordova.file && root.cordova.file.dataDirectory;
      return data ? data.replace(/^file:\/\//, "").replace(/\/$/, "") + "/recordings" : "";
    }

    function localSegments(sid, take) {
      var indexed = sourceIndex[keyOf(sid, take)];
      if (indexed && indexed.length) return Promise.resolve(indexed);
      var e = entries[keyOf(sid, take)];
      var summary = e && e.take && e.take.summary;
      var info = summary && summary.stopStates && summary.stopStates[selfDid()];
      if (info && info.path) return Promise.resolve(rememberSegments(sid, take, [{rel: baseName(info.path), segmentIndex: 0, path: info.path}]));
      var svc = startService(), view = svc && svc.view && svc.view();
      var segs = view && view.sid === sid && view.takeNumber === take ? listSegments() : [];
      if (segs.length) return Promise.resolve(rememberSegments(sid, take, segs));
      // Migration of recordings made before the local index: the existing
      // per-take staging tree proves the relative name. Prefer its complete
      // private original when a failed staging copy left an incomplete file.
      var dir = privateRecordingsDir(), media = mediaRoot(sid, take), nat = nativeApi();
      if (!dir || !media || !nat || !nat.listDir) return Promise.resolve([]);
      var reps = summary && summary.replications || {};
      var totals = Object.keys(reps).filter(function (k) { return reps[k].sourceDeviceId === selfDid(); }).map(function (k) { return reps[k].total; });
      var expected = totals.filter(function (n) { return n > 0; })[0] || 0;
      if (!expected) return Promise.resolve([]);
      return Promise.all([nat.listDir(media), nat.listDir(dir)]).then(function (lists) {
        var staged = lists[0].entries || [], originals = lists[1].entries || [];
        if (staged.length !== 1) return []; // Multi-segment migrations require their index.
        var name = staged[0].name;
        if (!name || name.indexOf("/") >= 0 || !/\.mp4$/i.test(name)) return [];
        var original = originals.filter(function (f) { return !f.dir && f.name === name && f.bytes === expected; })[0];
        if (!original) return [];
        log("TRANSFER_SOURCE_INDEX_RECOVERED sid=" + sid + " take=" + take + " rel=" + name + " bytes=" + expected);
        return rememberSegments(sid, take, [{rel: name, segmentIndex: 0, path: dir + "/" + name}]);
      }).catch(function () { return []; });
    }

    function stageSegments(sid, take) {
      return localSegments(sid, take).then(function (segs) {
      if (!segs.length) return [];
      // Finalized private recordings are served through an exact allowlist.
      // Keep them out of stagedMap: automatic staging cleanup must not delete them.
      if (segs.every(function (s) { return /\/files\/recordings\//.test(s.path); })) return segs;
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
      });
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
        localHost: function () {
          var d = discoveryMod();
          var ds = d && d.status && d.status();
          return ds && ds.ipv4 || "";
        },
        take: function () {
          var t = e.take || {};
          return {
            sessionId: e.sid,
            takeNumber: e.takeNumber,
            storages: t.storages || [],
            captures: t.captures || [],
            status: t.status || "",
            summary: t.summary || {}
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
          listSegmentsFor: listSegmentsFor, hasTake: hasTake,
          /* J17-A : lecture seule du dossier d'une Capture source. Le listing
           * natif accepte un chemin absolu nu (comme remove/sha256) — le HTML5
           * File API résout mal ces chemins sur stockage externe. */
          listDir: function (dir) {
            var nat = nativeApi();
            if (!nat || typeof nat.listDir !== "function") return Promise.reject(new Error("list_unavailable"));
            return Promise.resolve(nat.listDir(dir)).then(function (r) {
              return (r && Array.isArray(r.entries)) ? r.entries : [];
            });
          }
        },
        /* J17-A : le serveur média ne peut servir que des chemins réels. En
         * mode SAF les fichiers vivent dans une arborescence DocumentFile :
         * on le dit explicitement au lieu de fabriquer un catalogue vide. */
        storageMode: function () { return (cfg.storage && cfg.storage.mode) || "path"; },
        catalogueModel: function () { return catalogueMod(); },
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
        },
        /* J15 : horloge/jitter injectables ; `statDest` donne taille+SHA du
         * partiel (reconcil. 416) ; `onWaiting` planifie la prochaine séquence. */
        now: nowMs,
        rand: deps.rand,
        onWaiting: function (info) { scheduleResume(e, info); },
        statDest: function (dest) {
          var nat = nativeApi();
          if (nat && typeof nat.statDest === "function") return nat.statDest(dest).catch(function () { return null; });
          var p = dest && (dest.dest || dest.relPath);
          if (!nat || !p || typeof nat.sha256 !== "function") return Promise.resolve(null);
          return Promise.resolve(nat.sha256(p)).then(function (r) { return r || null; }, function () { return null; });
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
        /* J15 / §7 : restauration du journal AVANT le watchdog et le coordinateur,
         * sinon un transfert interrompu serait marqué `stale` avant d'être
         * simplement repris. La taille disque reste autoritaire. */
        if (role === "storage") e.restoring = restoreEntryFromJournal(e);
      }
      primary = e;
      return e.service;
    }

    /* Restaure l'état récupérable d'une entrée depuis le journal, puis planifie
     * les reprises (le scan de secours reprendra le relais). */
    function restoreEntryFromJournal(e) {
      var j = journalFor();
      if (!j || typeof j.restore !== "function" || typeof e.machine.restoreFromJournal !== "function") return;
      return Promise.resolve(j.restore(e.sid, e.takeNumber, selfDid())).then(function (res) {
        if (!res || !res.ok || !res.doc) return;
        var n = e.machine.restoreFromJournal(res.doc);
        if (n > 0) {
          log("TRANSFER_JOURNAL_APPLIED sid=" + e.sid + " take=" + e.takeNumber + " files=" + n);
          notify();
          resumeScan();
        }
      }, function () {});
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
      scheduleJournalPersist();
      listeners.slice().forEach(function (fn) {
        try { fn(); } catch (e) { log("TRANSFER_NOTIFY_ERROR " + String((e && e.message) || e)); }
      });
    }

    /* ---------- journal technique (J15 / §7) ---------- */

    var journal = null;
    var JOURNAL_COALESCE_MS = 1000;
    var journalTimer = null;

    function journalFor() {
      if (journal) return journal;
      var mod = journalMod();
      if (!mod || typeof mod.createTransferJournal !== "function") return null;
      journal = mod.createTransferJournal({ log: log, coalesceMs: JOURNAL_COALESCE_MS, fs: deps.journalFs, setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout });
      return journal;
    }

    /* Sérialise l'état RÉCUPÉRABLE d'un Take (Storage uniquement) et le persiste.
     * `immediate` pour les transitions terminales (done/error). */
    function persistJournalFor(e, immediate) {
      if (role !== "storage" || !e || !e.machine) return;
      var j = journalFor();
      var mod = journalMod();
      if (!j || !mod || typeof mod.buildDoc !== "function") return;
      var st = (e.machine.state && (typeof e.machine.state === "function" ? e.machine.state() : e.machine.state)) || {};
      var doc = mod.buildDoc({
        sessionId: e.sid, takeNumber: e.takeNumber, storageDeviceId: selfDid(),
        manifestId: st.manifestId || "",
        transfers: st.transfers || {}, endpoint: {
          host: serverState.host, port: serverState.port
        }, nowMs: nowMs()
      });
      j.save(doc, !!immediate);
    }

    function scheduleJournalPersist() {
      if (role !== "storage" || !primary) return;
      /* Transitions TERMINALES : écriture immédiate (§7.2) — un crash juste après
       * un `done` ne doit pas perdre la preuve. Le coalescé reste pour la
       * progression. */
      if (typeof primary.machine.hasTerminalTransfers === "function"
          && primary.machine.hasTerminalTransfers()
          && typeof primary.machine.hasPendingTransfers === "function"
          && !primary.machine.hasPendingTransfers()) {
        persistJournalFor(primary, true);
        return;
      }
      if (journalTimer !== null) return;
      var setT = deps.setTimeout || (typeof setTimeout !== "undefined" ? setTimeout : null);
      if (!setT) return;
      journalTimer = setT(function () {
        journalTimer = null;
        persistJournalFor(primary, false);
      }, JOURNAL_COALESCE_MS);
      if (journalTimer && typeof journalTimer.unref === "function") journalTimer.unref();
    }

    /* Force une écriture IMMÉDIATE (état terminal) : flush du coalescé + save. */
    function flushJournal(immediate) {
      if (role !== "storage") return Promise.resolve(0);
      var j = journalFor();
      var setT = deps.setTimeout || (typeof setTimeout !== "undefined" ? setTimeout : null);
      if (journalTimer !== null && setT) { /* on laisse le timer courir : il relira l'état */ }
      var ops = Object.keys(entries).map(function (k) {
        var e = entries[k];
        if (!e.machine) return Promise.resolve();
        return persistJournalFor(e, immediate !== false);
      });
      return Promise.all(ops).then(function () {
        return j ? j.flush() : 0;
      });
    }

    /* J16-A — projection PERSISTABLE de l'état des réplications.
     *
     * `transfers` : vue du modèle de transfert (clé "src|storage"). On en
     * retient un état par COUPLE, ce qui est l'unité affichée par l'écran 09
     * (« une barre par Storage attendu ») et l'unité qui permet de rouvrir un
     * Take passé sans rien déduire d'un état global.
     *
     * `prev` : réplications déjà persistées. L'horodatage n'est rafraîchi que
     * si le FAIT a changé (état/octets/pourcentage/erreur) : inutile de faire
     * diverger deux Masters sur une simple estampille. */
    function replicationsOf(transfers, prev) {
      var out = {};
      var old = prev || {};
      Object.keys(transfers || {}).forEach(function (k) {
        var tr = transfers[k];
        if (!tr || !tr.sourceDeviceId || !tr.storageDeviceId) return;
        var bytes = Number(tr.bytes) || 0;
        var total = Number(tr.total) || 0;
        var percent = Number(tr.percent) || 0;
        var state = tr.state || "pending";
        var error = tr.error || "";
        var before = old[k];
        // A newly assembled observer may know the pair before its manifest.
        // That absence must never replace previously persisted size/progress.
        if (before && before.total > 0 && total === 0 && (!tr.files || !tr.files.length)) {
          out[k] = before;
          return;
        }
        var same = before
          && before.state === state
          && before.error === error
          && before.bytes === bytes
          && before.total === total
          && before.percent === percent;
        out[k] = {
          sourceDeviceId: tr.sourceDeviceId,
          storageDeviceId: tr.storageDeviceId,
          state: state,
          error: error,
          bytes: bytes,
          total: total,
          percent: percent,
          updatedAtMs: same ? before.updatedAtMs : Date.now()
        };
      });
      return out;
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
        var done = 0, error = 0, waiting = 0, totalFiles = 0, bytes = 0, totalBytes = 0;
        keys.forEach(function (k) {
          var tr = transfers[k];
          if (!tr) return;
          var f = tr.files || [];
          totalFiles += f.length;
          bytes += Number(tr.bytes) || 0;
          totalBytes += Number(tr.total) || 0;
          if (tr.state === "done") done += 1;
          if (tr.state === "error") error += 1;
          if (tr.state === "waiting_network") waiting += 1;
        });
        /* J15 : une attente réseau n'est PAS terminale ; elle s'affiche mais
         * n'écrase jamais un `done`/`error` déjà acquis. */
        var transferState = "TRANSFERRING";
        if (error > 0) transferState = "ERROR";
        else if (keys.length > 0 && done === keys.length) transferState = "TERMINATED";
        else if (waiting > 0) transferState = "WAITING_NETWORK";
        var summary = t2.summary ? JSON.parse(JSON.stringify(t2.summary)) : {
          stoppedAtMs: 0, durationMs: 0, stopReason: "", transferState: "", transferError: "",
          transferBytes: 0, transferTotal: 0, transferPercent: 0, transfers: {},
          stopStates: {}, replications: {}
        };
        summary.transferState = transferState;
        summary.transferBytes = bytes;
        summary.transferTotal = totalBytes || bytes;
        summary.transferPercent = (totalBytes > 0) ? Math.round((bytes / totalBytes) * 100) : (keys.length > 0 ? (done * 100 / keys.length) : 0);
        if (transferState === "ERROR" && error > 0) summary.transferError = "transfer_error";
        /* J16-A — l'état de CHAQUE réplication (couple Capture → Storage) est
         * conservé, pas seulement l'état GLOBAL agrégé. C'est indispensable
         * pour rouvrir un Take passé : l'état global ne dit pas quel Storage a
         * reçu quoi. On ne modifie RIEN au transfert lui-même — on ne fait que
         * conserver ce que le modèle de transfert connaît déjà. */
        summary.replications = replicationsOf(transfers, summary.replications);
        /* Les faits d'arrêt (par Capture) écrits par le service START sont
         * conservés : la fin des transferts ne doit jamais les effacer. */
        if (!summary.stopStates) summary.stopStates = {};
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
          onTransferMessage(offer);
        });
      });
      notify();
    }

    /* ---------- ResumeCoordinator (J15 / §5) ----------
     * Reprend AUTOMATIQUEMENT les transferts en attente réseau. Garanties :
     *  - UN SEUL run actif par CLÉ `(sid|take|src|rel)` ;
     *  - file BORNÉE (pas d'explosion mémoire) ;
     *  - le VERROU est acquis AVANT la planification du délai et libéré en
     *    `finally` (donc même si le run échoue) ;
     *  - timers NON accumulatifs : une clé déjà planifiée n'est pas replanifiée ;
     *  - un échec de reprise repasse en `waiting_network` (jamais terminal). */
    var resumeLocks = {};   /* "sid|take|src|rel" -> true (run planifié/en cours) */
    var resumeTimers = {};  /* "sid|take|src|rel" -> timer */
    var MAX_RESUME_QUEUE = isNum(deps.maxResumeQueue) ? deps.maxResumeQueue : 64;

    function resumeKey(sid, take, src, rel) {
      return keyOf(sid, take) + "|" + src + "|" + rel;
    }

    /* Reçoit une notification d'attente du service : planifie la reprise.
     * `delayMs` = échéance (now + backoff) fournie par `nextAttemptAtMs`. */
    function scheduleResume(e, info) {
      if (!e || !info || !info.sourceDeviceId || !info.rel) return false;
      var rk = resumeKey(e.sid, e.takeNumber, info.sourceDeviceId, info.rel);
      if (resumeLocks[rk]) {
        log("TRANSFER_RESUME_SKIP src=" + info.sourceDeviceId + " rel=" + info.rel + " reason=already_planned");
        return false;
      }
      if (Object.keys(resumeLocks).length >= MAX_RESUME_QUEUE) {
        log("TRANSFER_RESUME_QUEUE_FULL size=" + Object.keys(resumeLocks).length);
        return false;
      }
      /* Verrou AVANT de planifier (empêche les doublons de timers). */
      resumeLocks[rk] = true;
      var at = nowMs();
      var when = isNum(info.nextAttemptAtMs) ? info.nextAttemptAtMs : (at + nextResumeBackoff(e, info));
      var waitMs = Math.max(0, when - at);
      var setT = deps.setTimeout || (typeof setTimeout !== "undefined" ? setTimeout : null);
      if (!setT) { delete resumeLocks[rk]; return false; }
      var timer = setT(function () {
        delete resumeTimers[rk];
        /* Le verrou doit couvrir TOUTE l'opération asynchrone : on le libère
         * lorsque `runResume` a RÉELLEMENT terminé (succès ou échec), pas au
         * retour synchrone de l'appel. Sinon une reconnexion pendant le
         * téléchargement planifierait un run concurrent. */
        var p;
        try { p = runResume(e, rk, info); }
        catch (err) { log("TRANSFER_RESUME_ERR " + String((err && err.message) || err)); delete resumeLocks[rk]; return; }
        Promise.resolve(p).then(function () { delete resumeLocks[rk]; },
          function (err) {
            log("TRANSFER_RESUME_ERR " + String((err && err.message) || err));
            delete resumeLocks[rk];
          });
      }, waitMs);
      if (timer && typeof timer.unref === "function") timer.unref();
      resumeTimers[rk] = timer;
      log("TRANSFER_RESUME_PLANNED src=" + info.sourceDeviceId + " rel=" + info.rel + " inMs=" + waitMs);
      return true;
    }

    function nextResumeBackoff(e, info) {
      var svc = e && e.service;
      if (svc && typeof svc.nextBackoffMs === "function") {
        return svc.nextBackoffMs(1);
      }
      return 5000;
    }

    /* Rejoue les fichiers EN ATTENTE d'une source via `storageRun`, avec
     * `mode:"retry"` (le modèle réactive l'attente sans détruire les terminaux). */
    function runResume(e, rk, info) {
      if (!e || !e.service || !e.machine) return Promise.resolve(false);
      /* Ne pas transférer pendant un RECORDING : on replanifie plus tard, la
       * pause est légitime (§5). */
      var svc = startService();
      if (svc && svc.isRecording && svc.isRecording()) {
        log("TRANSFER_RESUME_DEFER src=" + info.sourceDeviceId + " rel=" + info.rel + " reason=recording");
        return Promise.resolve(false);
      }
      var offer = buildResumeOffer(e, info.sourceDeviceId, [info.rel]);
      /* Endpoint/token inconnus (ex. après un redémarrage, avant toute nouvelle
       * annonce) : on NE lance PAS un téléchargement voué à l'échec. Le
       * transfert reste `waiting_network` et sera repris à la prochaine annonce
       * (déclencheur réseau / scan). */
      if (!offer) {
        log("TRANSFER_RESUME_NO_ENDPOINT src=" + info.sourceDeviceId + " rel=" + info.rel);
        return Promise.resolve(false);
      }
      if (typeof e.service.storageRun !== "function") return Promise.resolve(false);
      log("TRANSFER_RESUME_RUN src=" + info.sourceDeviceId + " rel=" + info.rel + " manifest=" + (offer.manifestId || ""));
      return Promise.resolve(e.service.storageRun(offer)).then(function () {
        notify();
        return true;
      }, function (err) {
        log("TRANSFER_RESUME_ERR src=" + info.sourceDeviceId + " error=" + String((err && err.message) || err));
        return false;
      });
    }

    /* Construit une offre de reprise (un sous-ensemble de fichiers) à partir des
     * FAITS connus du Take (endpoint du serveur média partagé, token).
     *
     * CONTRAT de `view().transfers` : clés `src|storage`, objets exposant
     * `sourceDeviceId`/`storageDeviceId`, et `files` = TABLEAU de projections
     * `{ rel, segmentIndex, bytes, received, sha256, state, error }`. */
    function buildResumeOffer(e, src, rels) {
      var v = e.machine.view();
      var all = (v && v.transfers) || {};
      var tr = null;
      var keys = Object.keys(all);
      for (var i = 0; i < keys.length; i++) {
        var cand = all[keys[i]];
        if (cand && cand.sourceDeviceId === src) { tr = cand; break; }
      }
      if (!tr) return null;
      var endpoint = e.machine.state && e.machine.state.offers && e.machine.state.offers[src];
      if (!endpoint) return null;
      var token = endpoint.token || "";
      var byRel = {};
      (tr.files || []).forEach(function (f) { if (f && f.rel) byRel[f.rel] = f; });
      var files = [];
      (rels || []).forEach(function (rel) {
        var f = byRel[rel];
        if (!f) return;
        files.push({ rel: rel, bytes: f.bytes, sha256: f.sha256, segmentIndex: f.segmentIndex || 0 });
      });
      if (!files.length) return null;
      /* Sans endpoint ni token exploitables (redémarrage, avant nouvelle annonce
       * réseau), l'offre est INEXPLOITABLE : on rend `null` pour NE PAS lancer un
       * téléchargement voué à l'échec. Le transfert reste récupérable et sera
       * repris à la prochaine annonce (déclencheur réseau / scan de secours). */
      if (!endpoint.host || !endpoint.port || !token) return null;
      return {
        sessionId: e.sid, takeNumber: e.takeNumber,
        sourceDeviceId: src, files: files,
        host: endpoint.host, port: endpoint.port, token: token,
        manifestId: tr.manifestId || "", mode: "retry"
      };
    }

    /* Scan de SECOURS (§5) : toutes les `RECONCILE_CYCLE_MS`, replanifie toute
     * attente non verrouillée (le filet de sécurité si un `onWaiting` a été
     * perdu). Idempotent grâce aux verrous. */
    function resumeScan() {
      if (role !== "storage") return 0;
      var now = nowMs();
      var planned = 0;
      Object.keys(entries).forEach(function (k) {
        var e = entries[k];
        if (!e.machine || !e.service) return;
        if (typeof e.machine.waitingTransfers !== "function") return;
        e.machine.waitingTransfers(now).forEach(function (w) {
          var rels = (w.rels && w.rels.length) ? w.rels : (w.rel ? [w.rel] : []);
          rels.forEach(function (rel) {
            var rk = resumeKey(e.sid, e.takeNumber, w.sourceDeviceId, rel);
            if (resumeLocks[rk]) return;
            /* Compter UNIQUEMENT les reprises réellement acceptées par le
             * coordinateur (SKIP/file pleine/absence de timer = refus). */
            if (scheduleResume(e, {
              sourceDeviceId: w.sourceDeviceId, rel: rel,
              cause: w.cause, nextAttemptAtMs: now
            })) {
              planned += 1;
            }
          });
        });
      });
      if (planned) log("TRANSFER_RESUME_SCAN planned=" + planned);
      return planned;
    }

    /* Rejoue immédiatement les attentes au retour du réseau (déclenché par la
     * découverte). Ne fait que PLANIFIER ; un seul run par clé. */
    var captureRefresh = {};
    function refreshCaptureMedia(force) {
      if (role !== "capture") return Promise.resolve();
      var svc = startService();
      if (svc && svc.isRecording && svc.isRecording()) return Promise.resolve();
      var store = sessionStore();
      if (!store || typeof store.list !== "function") return Promise.resolve();
      return store.list().then(function (sessions) {
        var tasks = [];
        sessions.filter(function (s) { return s.state === "open"; }).forEach(function (s) {
          (s.takes || []).forEach(function (t) {
            var info = t.summary && t.summary.stopStates && t.summary.stopStates[selfDid()];
            var indexed = sourceIndex[keyOf(s.sessionId, t.takeNumber)];
            var stopped = info && info.state === "STOPPED" || ["STOPPED", "TERMINATED", "COMPLETED", "ERROR"].indexOf(t.status) >= 0;
            if ((t.captures || []).indexOf(selfDid()) < 0 || (!indexed && !stopped)) return;
            var key = keyOf(s.sessionId, t.takeNumber);
            var prev = captureRefresh[key];
            if (prev && (prev.pending || (!force && nowMs() - prev.at < 10000))) return;
            var slot = captureRefresh[key] = {pending: true, at: nowMs()};
            tasks.push(loadEntry(s.sessionId, t.takeNumber).then(function () {
              return ensureFor(s.sessionId, t.takeNumber).captureAnnounce();
            }).then(function () { slot.pending = false; }, function () { slot.pending = false; }));
          });
        });
        return Promise.all(tasks);
      }).catch(function (e) { log("TRANSFER_REFRESH_ERROR " + String(e)); });
    }

    function onNetworkChange() {
      refreshCaptureMedia();
      if (role !== "storage") return 0;
      /* Libère les verrous dont le timer a été annulé (reconnexion) pour rejouer. */
      return resumeScan();
    }


    /* ---------- J17-A : catalogue média (Master ↔ Storage) ---------- */

    /* Dernier catalogue CONNU par Storage, jamais effacé par une absence :
     * une entrée `pending` conserve `reply` (historique) et l'état `offline`
     * est calculé à la lecture depuis `connectedPeers`. */
    var catalogueEntries = {}; /* "sid|take|storage" -> { state, reply, requestId, requestedAtMs } */

    function catalogueKey(sid, take, sto) {
      return keyOf(sid, take) + "|" + sto;
    }

    /* Autorisation : seul un MASTER DE LA SESSION peut demander un catalogue.
     * La liste vient du modèle de session persisté, jamais de l'IP. */
    function isMasterOf(sid, did) {
      var store = sessionStore();
      if (!store || typeof store.get !== "function" || !sid || !did) return Promise.resolve(false);
      return Promise.resolve(store.get(sid)).then(function (s) {
        var ms = (s && s.masters) || [];
        for (var i = 0; i < ms.length; i++) {
          if (ms[i] && ms[i].deviceId === did) return true;
        }
        return false;
      }, function () { return false; });
    }

    /* STORAGE : répond au Master avec un catalogue issu du DISQUE réel. */
    function onMediaCatalogueRequest(env, reply) {
      if (role !== "storage") return Promise.resolve(false);
      var sid = env.sessionId;
      var takeNumber = isNum(env.takeNumber) ? env.takeNumber : -1;
      if (!sid || takeNumber < 0) return Promise.resolve(false);
      return isMasterOf(sid, env.from).then(function (ok) {
        if (!ok) {
          log("MEDIA_CATALOGUE_DENY sessionId=" + sid + " take=" + takeNumber
            + " from=" + (env.from || "?") + " reason=not_master");
          return false;
        }
        return loadEntry(sid, takeNumber).then(function (t) {
          if (!t) {
            sendCatalogueReply(reply, env, { ok: false, reason: "unknown_take", takeNumber: takeNumber });
            return false;
          }
          if ((t.storages || []).indexOf(selfDid()) < 0) {
            sendCatalogueReply(reply, env, { ok: false, reason: "not_selected", takeNumber: takeNumber });
            log("MEDIA_CATALOGUE_DENY sessionId=" + sid + " take=" + takeNumber + " reason=not_selected");
            return false;
          }
          return ensureFor(sid, takeNumber).storageCatalogue({
            sessionId: sid, takeNumber: takeNumber, sources: t.captures || []
          }).then(function (cat) {
            var extra = {
              takeNumber: takeNumber,
              requestId: env.requestId || "",
              ok: !!cat.ok,
              reason: cat.reason || "",
              endpoint: cat.endpoint || null,
              token: cat.token || "",
              sources: cat.sources || []
            };
            sendCatalogueReply(reply, env, extra);
            log("MEDIA_CATALOGUE_SERVED sessionId=" + sid + " take=" + takeNumber
              + " from=" + (env.from || "?") + " ok=" + (cat.ok ? 1 : 0)
              + " reason=" + (cat.reason || "—"));
            return !!cat.ok;
          });
        });
      });
    }

    function sendCatalogueReply(reply, env, extra) {
      if (typeof reply !== "function") {
        log("MEDIA_CATALOGUE_REPLY_DROP take=" + (extra && extra.takeNumber) + " reason=no_transport");
        return;
      }
      extra = extra || {};
      if (env && env.requestId && !extra.requestId) extra.requestId = env.requestId;
      reply("media_catalogue_reply", extra);
    }

    /* MASTER : enregistre la réponse d'un Storage SÉLECTIONNÉ pour ce Take. */
    function onMediaCatalogueReply(env) {
      if (role !== "master") return Promise.resolve(false);
      var sid = env.sessionId;
      var takeNumber = isNum(env.takeNumber) ? env.takeNumber : -1;
      var sto = env.from || "";
      if (!sid || takeNumber < 0 || !sto) return Promise.resolve(false);
      return loadEntry(sid, takeNumber).then(function (t) {
        if (!t) return false;
        if ((t.storages || []).indexOf(sto) < 0) {
          log("MEDIA_CATALOGUE_IGNORE sessionId=" + sid + " take=" + takeNumber
            + " from=" + sto + " reason=not_selected");
          return false;
        }
        var k = catalogueKey(sid, takeNumber, sto);
        var prev = catalogueEntries[k] || {};
        /* Une réponse d'une requête ANTÉRIEURE ne doit pas écraser la plus
         * récente : on ne compare que si les deux requestId sont connus. */
        if (env.requestId && prev.requestId && env.requestId !== prev.requestId) {
          log("MEDIA_CATALOGUE_IGNORE sessionId=" + sid + " take=" + takeNumber
            + " from=" + sto + " reason=stale_request");
          return false;
        }
        var ok = env.ok !== false;
        catalogueEntries[k] = {
          state: ok ? "ready" : "error",
          reply: {
            ok: ok,
            reason: env.reason || "",
            endpoint: env.endpoint || null,
            token: env.token || "",
            sources: Array.isArray(env.sources) ? env.sources : [],
            atMs: nowMs()
          },
          requestId: prev.requestId || env.requestId || "",
          requestedAtMs: prev.requestedAtMs || 0
        };
        var n = 0;
        catalogueEntries[k].reply.sources.forEach(function (s) {
          n += (s && Array.isArray(s.files)) ? s.files.length : 0;
        });
        log("MEDIA_CATALOGUE_REPLY sessionId=" + sid + " take=" + takeNumber
          + " storage=" + sto + " ok=" + (ok ? 1 : 0) + " reason=" + (env.reason || "—")
          + " files=" + n);
        notify();
        return true;
      });
    }

    /* MASTER : demande le catalogue à CHAQUE Storage sélectionné du Take.
     * Aucune requête pour un Take non arrêté : le Storage refuserait, et une
     * lecture pendant REC serait un défaut. */
    function requestCatalogue(sid, takeNumber) {
      if (role !== "master") return Promise.resolve(false);
      return loadEntry(sid, takeNumber).then(function (t) {
        if (!t) return false;
        var cm = catalogueMod();
        if (cm && typeof cm.takeStopped === "function" && !cm.takeStopped(t)) {
          log("MEDIA_CATALOGUE_SKIP sessionId=" + sid + " take=" + takeNumber + " reason=take_not_stopped");
          return false;
        }
        var storages = (t.storages || []).filter(function (d) { return isStr(d); });
        if (!storages.length) {
          log("MEDIA_CATALOGUE_SKIP sessionId=" + sid + " take=" + takeNumber + " reason=no_storage");
          return false;
        }
        var reqId = "mc-" + nowMs().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
        storages.forEach(function (sto) {
          var k = catalogueKey(sid, takeNumber, sto);
          var prev = catalogueEntries[k] || {};
          /* On GARDE la dernière réponse connue : une absence de réponse ne
           * doit jamais effacer l'historique du Take. */
          catalogueEntries[k] = {
            state: "pending",
            reply: prev.reply || null,
            requestId: reqId,
            requestedAtMs: nowMs()
          };
          sendToWs(sto, "media_catalogue_request", {
            sessionId: sid, takeNumber: takeNumber, requestId: reqId
          });
          log("MEDIA_CATALOGUE_REQUEST sessionId=" + sid + " take=" + takeNumber
            + " storage=" + sto + " requestId=" + reqId);
        });
        notify();
        return true;
      });
    }

    /* MASTER : modèle de consultation du Take (aucune I/O média). */
    function catalogueFor(sid, takeNumber) {
      return loadEntry(sid, takeNumber).then(function (t) {
        if (!t) return null;
        return Promise.resolve(sessionStore().get(sid)).then(function (session) {
          var peers = {};
          var w = ws();
          if (w && typeof w.connectedPeers === "function") {
            try { peers = w.connectedPeers(sid) || {}; } catch (e) { peers = {}; }
          }
          var cats = {};
          var requested = {};
          (t.storages || []).forEach(function (sto) {
            var e = catalogueEntries[catalogueKey(sid, takeNumber, sto)];
            if (!e) return;
            if (e.reply) cats[sto] = e.reply;
            if (e.state === "pending") requested[sto] = true;
          });
          var online = {};
          (t.storages || []).forEach(function (sto) { online[sto] = !!peers[sto]; });
          var cm = catalogueMod();
          if (!cm || typeof cm.buildView !== "function") return null;
          return cm.buildView({
            take: t, session: session || {}, online: online,
            catalogues: cats, requested: requested
          });
        });
      });
    }

    function onTransferMessage(env, reply) {
      if (!env || !env.sessionId) return Promise.resolve(false);
      /* J17-A : deux kinds ADDITIFS, routés avant le cycle J15 (ils ne
       * modifient aucun état de transfert). */
      if (env.kind === "media_catalogue_request") return onMediaCatalogueRequest(env, reply);
      if (env.kind === "media_catalogue_reply") return onMediaCatalogueReply(env);
      var take = isNum(env.takeNumber) ? env.takeNumber
        : ((primary && primary.sid === env.sessionId) ? primary.takeNumber : 0);
      /* J15 (§7.1) : une offre porte l'ENDPOINT du serveur média (host/port/token).
       * On le mémorise pour que la reprise automatique puisse le réutiliser plus
       * tard, même après un redémarrage où la mémoire vive est perdue. */
      if (role === "storage" && env.kind === "transfer_offer") {
        var svc = startService();
        if (svc && svc.isRecording && svc.isRecording()) {
          pausedOffers[keyOf(env.sessionId, take) + "|" + env.sourceDeviceId] = env;
          log("TRANSFER_PAUSE source=" + env.sourceDeviceId + " reason=recording");
          return Promise.resolve(false);
        }
      }
      return loadEntry(env.sessionId, take).then(function (tk) {
        if (role === "storage" && env.kind === "media_ready") {
          if (!tk || (tk.captures || []).indexOf(env.deviceId) < 0 || (tk.storages || []).indexOf(selfDid()) < 0
              || (env.from && env.from !== env.deviceId) || (tk.settings && tk.settings.transferAuto === false)) return false;
          var offer = Object.assign({}, env, {kind: "transfer_offer", sourceDeviceId: env.deviceId, storageDeviceId: selfDid()});
          return onTransferMessage(offer);
        }
        var service = ensureFor(env.sessionId, take);
        var entry = entries[keyOf(env.sessionId, take)];
        return Promise.resolve(entry.restoring).then(function () { return service.handle(env); });
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
    var RECONCILE_CYCLE_MS = isNum(deps.reconcileCycleMs) ? deps.reconcileCycleMs : 120000;
    var watchdogTimer = null;
    var stuckState = {};     /* "sid|take|src|storage" -> { count, baseAt, frozenAt } */
    var lastReidentify = 0;  /* throttling de la réconciliation de maillage */
    var lastReconcilePurge = 0;

    var capturePeerRefresh = {};
    function onPeerIdentified(env) {
      var peer = env && (env.from || env.deviceId) || "";
      var now = nowMs();
      if (!capturePeerRefresh[peer] || now - capturePeerRefresh[peer] >= REIDENTIFY_THROTTLE_MS) {
        capturePeerRefresh[peer] = now;
        refreshCaptureMedia(true);
      }
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
          if (typeof e.machine.rebroadcastWaitingStates === "function") {
            n += e.machine.rebroadcastWaitingStates();
          }
        }
      });
      if (n) log("TRANSFER_RESYNC_TRIGGER role=" + role + " peer=" + (cameFrom || "") + " count=" + n);
      return n;
    }

    /* Reconnexion du transport LOCAL (socket WS rétablie) : le Storage re-diffuse
     * ses issues terminales et ses états d'attente (§10 : « réémission à la
     * reconnexion réaligne les deux vues »). */
    function onTransportReconnect() {
      refreshCaptureMedia(true);
      if (role !== "storage") return 0;
      var n = 0;
      Object.keys(entries).forEach(function (k) {
        var e = entries[k];
        if (e.machine) n += e.machine.rebroadcastTerminalResults();
        if (e.machine && typeof e.machine.rebroadcastWaitingStates === "function") {
          n += e.machine.rebroadcastWaitingStates();
        }
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
      /* Purge cyclique des compteurs gelés (stuckState) toutes les 120 s : un
       * run qui serait bloqué pendant longtemps peut être ré-essayé à nouveau
       * sans rester figé dans le gel. */
      if (now - lastReconcilePurge >= RECONCILE_CYCLE_MS) {
        lastReconcilePurge = now;
        stuckState = {};
        /* Scan de secours du coordinateur de reprise (J15 / §5) : la reprise d'un
         * transfert en attente ne doit PAS dépendre du seul `onWaiting` (qui peut
         * être perdu). Idempotent grâce aux verrous par clé. */
        resumeScan();
      }
      var acted = 0;
      Object.keys(entries).forEach(function (entryKey) {
        var e = entries[entryKey];
        if (!e.machine || !e.service) return;
        e.machine.staleTransfers(STUCK_MS, now).forEach(function (s) {
          if (role === "master") { applyMasterStuck(entryKey, e, s, now); acted += 1; }
          else if (role === "storage") {
            /* J15 : ne pas marquer en ERROR sur simple blocage. Transmettre une
             * attente réseau : le ResumeCoordinator traitera au retour du réseau.
             * Le watchdog maintient toutefois la détection d'inaction. */
            if (typeof e.machine.markTransferWaiting === "function") {
              e.machine.markTransferWaiting(s.sourceDeviceId, s.storageDeviceId, "stalled", now, 0);
              acted += 1;
            } else if (e.machine.markTransferStuck) {
              e.machine.markTransferStuck(s.sourceDeviceId, s.storageDeviceId, "stalled", now);
              acted += 1;
            }
          }
        });
      });
      if (acted) notify();
      return acted;
    }

    /* Master : relance bornée avec backoff, puis marque en attente réseau (pas en
     * ERROR). À l'expiration de la séquence, on LOGUE `TRANSFER_RECONCILE_WAIT` et
     * on GÈLE le compteur (gelé par `frozenAt` + purge cyclique 120 s). */
    function applyMasterStuck(entryKey, e, s, now) {
      var sk = entryKey + "|" + s.sourceDeviceId + "|" + s.storageDeviceId;
      var st = stuckState[sk] || { count: 0, baseAt: s.updatedAtMs, frozenAt: 0 };
      if (st.frozenAt && (now - st.frozenAt < RECONCILE_CYCLE_MS)) return;
      if (st.frozenAt) { st.count = 0; st.baseAt = s.updatedAtMs; st.frozenAt = 0; }
      if (st.count > 0 && s.updatedAtMs > st.baseAt) st = { count: 0, baseAt: s.updatedAtMs, frozenAt: 0 };
      if (st.count >= STUCK_MAX_REOFFERS) {
        if (typeof e.machine.markTransferWaiting === "function") {
          e.machine.markTransferWaiting(s.sourceDeviceId, s.storageDeviceId, "stalled", now, 0);
        }
        stuckState[sk] = { count: st.count, baseAt: st.baseAt, frozenAt: now };
        log("TRANSFER_RECONCILE_WAIT source=" + s.sourceDeviceId + " storage=" + s.storageDeviceId + " staleMs=" + s.staleMs);
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
      /* J15 / §5 : le retour du réseau déclenche la reprise des attentes. */
      var disc = discoveryMod();
      if (disc && typeof disc.onNetworkChange === "function") {
        disc.onNetworkChange(function () { onNetworkChange(); });
      }
      startWatchdog();
      refreshCaptureMedia();

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
      return primary.service.masterOffer(sourceDeviceId, "retry");
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
      /* J17-A : consultation des originaux archivés sur les Storages. */
      requestCatalogue: requestCatalogue,
      catalogueFor: catalogueFor,
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
      _resumeScan: resumeScan,
      _scheduleResume: scheduleResume,
      _onNetworkChange: onNetworkChange,
      _persistJournal: persistJournalFor,
      _flushJournal: flushJournal,
      _journalFor: journalFor,
      _restoreEntryFromJournal: restoreEntryFromJournal,
      _maybeCaptureAnnounce: maybeCaptureAnnounce,
      _machine: function () { return primary ? primary.machine : null; },
      _service: function () { return primary ? primary.service : null; }
    };
  }

  return { roleFor: roleFor, createTransferBoot: createTransferBoot };
});
