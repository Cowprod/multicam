/* MultiCam — service J07 "ARM distribué + synchronisation d'horloge" (écran 06).
 * Graisse applicative entre :
 *   - le modèle pur déterministe  → MultiCamArmModel.createMachine (arm-model.js) ;
 *   - les faits natifs locaux     → capture-capabilities / native / storage / saf /
 *                                   cordova.plugins.diagnostic (AUCUNE logique ARM
 *                                   dans les plugins — décision 30.10) ;
 *   - le transport WebSocket      → session-ws.js (pont réponses dirigées) ;
 *   - l'écran                     → ui/arm.js (s'abonne à onView).
 *
 * Un seul point d'évalution "faits" (assessSelf) : le device s'auto-évalue (caps
 * natives, permissions réellement requises par l'effectif, écriture stockage) et
 * renvoie des vérifications SANS connexion/synchronisation — ces deux lignes sont
 * ajoutées par le REQUEUR (seul à connaître sa connectivité et l'offset horloge).
 *
 * Journalisation parsable : ARM_*, CLOCK_SYNC*, REC_ELIGIBILITY (via deps.log du
 * modèle) + ARM_SELF_ASSESS_ERROR / ARM_FACTS_* (ci-dessous).
 */

(function (global) {
  "use strict";

  var listeners = [];
  var bridgeHooked = false;

  function log(l) { console.log(l); }
  function nowMs() { return Date.now(); }
  function cfg() { return (global.MultiCamConfig && global.MultiCamConfig.get) ? global.MultiCamConfig.get() : null; }
  function ws() { return global.MultiCamSessionWs; }
  function store() { return global.MultiCamSessionStore; }
  function armModel() { return global.MultiCamArmModel; }

  function selfDid() {
    var st = ws() && ws().status ? ws().status() : null;
    if (st && st.localDid) return st.localDid;
    var c = cfg();
    return (c && c.deviceId) || "";
  }

  /* Accessibilité du device depuis CE Master (soi-même → toujours vrai). */
  function isConnected(did, activeSid) {
    if (did === selfDid()) return true;
    var w = ws();
    if (!w || typeof w.connectedPeers !== "function") return false;
    var peers = w.connectedPeers(activeSid || null);
    return !!(peers && peers[did]);
  }

  function hasSelected(take, field, did) {
    var arr = (take && take[field]) || [];
    return arr.indexOf(did) >= 0;
  }

  /* ---------- faits natifs locaux ---------- */

  function gatherStorage() {
    var c = cfg();
    var mode = (c && c.storage && c.storage.mode) || "internal";
    var treeUri = (c && c.storage && c.storage.treeUri) || "";
    var freeBytes = null;
    var writable = false;
    function freeP() {
      if (mode === "saf") return Promise.resolve(null);
      if (!global.MultiCamNative || !global.MultiCamNative.freeSpace || !global.MultiCamStorage) return Promise.resolve(null);
      var p = global.MultiCamStorage.systemPath(global.MultiCamStorage.defaultPath());
      if (!p) return Promise.resolve(null);
      return global.MultiCamNative.freeSpace(p).then(function (r) {
        freeBytes = (r && typeof r.availableBytes === "number") ? r.availableBytes : null;
      }).catch(function () { freeBytes = null; });
    }
    function writeP() {
      if (mode === "saf") {
        if (!global.MultiCamSafApi || !treeUri) return Promise.resolve(false);
        return global.MultiCamSafApi.testWrite(treeUri).then(function (r) {
          writable = !!(r && r.ok && r.bytes > 0);
        }).catch(function () { writable = false; });
      }
      if (!global.MultiCamStorage || !global.MultiCamStorage.writeProbe) return Promise.resolve(false);
      return global.MultiCamStorage.writeProbe().then(function () { writable = true; }).catch(function () { writable = false; });
    }
    return Promise.all([freeP(), writeP()]).then(function () {
      return { freeBytes: freeBytes, writable: writable, storageMode: mode };
    });
  }

  /* Permissions réellement requises par l'EFFECTIF (audio/gps effectifs) via
   * cordova.plugins.diagnostic. null = impossibles à vérifier (hors Cordova). */
  function gatherPerms(effective) {
    var D = global.cordova && global.cordova.plugins && global.cordova.plugins.diagnostic;
    if (!D || !D.permissionStatus || !global.MultiCamArmModel) return Promise.resolve(null);
    var KEY = {
      CAMERA: D.permission && D.permission.CAMERA,
      RECORD_AUDIO: D.permission && D.permission.RECORD_AUDIO,
      ACCESS_FINE_LOCATION: D.permission && D.permission.ACCESS_FINE_LOCATION
    };
    var required = global.MultiCamArmModel.requirePermissions(effective || { audio: true, gpsProfile: "NORMAL" });
    var qs = required.filter(function (k) { return KEY[k]; }).map(function (k) {
      return new Promise(function (resolve) {
        try {
          D.getPermissionAuthorizationStatus(function (status) {
            var granted = status === D.permissionStatus.GRANTED;
            resolve([k, granted ? "GRANTED" : status]);
          }, function () { resolve([k, "UNKNOWN"]); }, KEY[k]);
        } catch (e) {
          resolve([k, "UNKNOWN"]);
        }
      });
    });
    return Promise.all(qs).then(function (rows) {
      var m = {};
      rows.forEach(function (r) { m[r[0]] = r[1]; });
      return m;
    }, function () { return null; });
  }

  function probeCaps(session) {
    var cc = global.MultiCamCaptureCapabilities;
    if (!cc || !cc.capabilitiesFor) return Promise.resolve({ unknown: true });
    return cc.capabilitiesFor(selfDid(), session).then(function (caps) {
      return (caps && !caps.unknown) ? caps : { unknown: true };
    }).catch(function () {
      return { unknown: true };
    });
  }

  /* Évaluation auto-déclarative de CE device pour (session, take). Retourne
   * [{ deviceId, skill, checks }] pour les skills sélectionnées de soi-même.
   * Les lignes connexion/synchronisation sont ajoutées par le REQUEUR. */
  function assessSelf(session, take) {
    var self = selfDid();
    var results = [];
    if (!self) return Promise.resolve([]);
    var isCapture = hasSelected(take, "captures", self);
    var isStorage = hasSelected(take, "storages", self);
    if (!isCapture && !isStorage) return Promise.resolve([]);
    var am = armModel();
    return probeCaps(session).then(function (caps) {
      var tm = global.MultiCamTakeModel;
      var eff;
      if (!tm) {
        eff = { capsUnknown: true, audio: true, gpsProfile: "NORMAL", fallback: false, requestOnly: true };
      } else {
        eff = tm.effectiveForCapture(take, caps, self);
      }
      return Promise.all([gatherStorage(), gatherPerms(eff)]).then(function (all) {
        var st = all[0], perms = all[1];
        if (isCapture) {
          var nativeProfile = (tm && !caps.unknown) ? tm.effectiveNativeProfile(take, caps, self) : null;
          var supportedRes = (!caps.unknown && caps.cameras)
            ? (caps.cameras[(eff.camera || "REAR").toLowerCase()] || [])
            : [];
          results.push({
            deviceId: self,
            skill: "capture",
            checks: am.assessCapture({
              capsUnknown: !!caps.unknown,
              supportedRes: supportedRes,
              effective: eff,
              nativeProfile: nativeProfile,
              perms: perms,
              freeBytes: st.freeBytes,
              probeOk: st.writable
            })
          });
        }
        if (isStorage) {
          results.push({
            deviceId: self,
            skill: "storage",
            checks: am.assessStorage({
              connected: true,
              freeBytes: st.freeBytes,
              writable: st.writable,
              storageMode: st.storageMode
            })
          });
        }
        return results;
      });
    }).catch(function (err) {
      log("ARM_SELF_ASSESS_ERROR err=" + String((err && err.message) || err));
      return results;
    });
  }

  /* ---------- machine + pont transport ---------- */

  function machine() { return global._mcArmMachine; }

  function buildDeps(activeSidRef) {
    return {
      nowMs: nowMs,
      schedule: function (fn, ms) { return setTimeout(fn, ms); },
      clearSchedule: function (t) { if (t) clearTimeout(t); },
      loadSession: function (sid) {
        if (!store() || !store().get) return Promise.resolve(null);
        return Promise.resolve(store().get(sid)).then(function (s) { return s || null; });
      },
      selfDid: selfDid,
      isConnected: function (did) { return isConnected(did, activeSidRef.sid); },
      assessSelf: assessSelf,
      sendArmRequest: function (session, req) {
        if (ws() && typeof ws().broadcastTargeted === "function") ws().broadcastTargeted("arm_request", session, req);
      },
      sendClockRequest: function (session, req) {
        if (ws() && typeof ws().broadcastTargeted === "function") ws().broadcastTargeted("clock_sync", session, req);
      },
      log: log,
      onChange: function () {
        listeners.slice().forEach(function (fn) { try { fn(); } catch (e) {} });
      }
    };
  }

  function hookBridge() {
    if (bridgeHooked || !ws() || typeof ws().setArmBridge !== "function") return;
    bridgeHooked = true;
    var activeSidRef = { sid: null };
    ws().setArmBridge({
      onArmRequest: function (env, reply) {
        var m = global._mcArmMachine;
        if (!m) return;
        m.onIncoming({
          kind: "arm_request",
          sessionId: env.sessionId,
          armCycleId: env.armCycleId,
          takeNumber: env.takeNumber,
          targets: env.targets || []
        }, reply);
      },
      onArmResult: function (env) {
        var m = global._mcArmMachine;
        if (!m) return;
        m.onIncoming({
          kind: "arm_result",
          sessionId: env.sessionId,
          armCycleId: env.armCycleId,
          takeNumber: env.takeNumber,
          deviceId: env.deviceId,
          skill: env.skill,
          checks: env.checks,
          generatedAtMs: env.generatedAtMs || nowMs()
        });
      },
      onClockSync: function (env, reply) {
        var m = global._mcArmMachine;
        if (!m) return;
        m.onIncoming({
          kind: "clock_sync",
          sessionId: env.sessionId,
          armCycleId: env.armCycleId,
          requestId: env.requestId,
          target: env.target
        }, reply);
      },
      onClockReply: function (env) {
        var m = global._mcArmMachine;
        if (!m) return;
        m.onIncoming({
          kind: "clock_sync_reply",
          sessionId: env.sessionId,
          armCycleId: env.armCycleId,
          requestId: env.requestId,
          from: env.from,
          target: env.target,
          t1: env.t1,
          t2: env.t2
        });
      }
    });
  }

  /* La machine est créée au boot (bind) pour pouvoir RÉPONDRE aux requêtes ARM des
   * autres Masters même sans écran ARM ouvert. start() ne fait que l'activer. */
  var activeSidRef = { sid: null };

  function bind() {
    if (global._mcArmMachine) return;
    var deps = buildDeps(activeSidRef);
    global._mcArmMachine = global.MultiCamArmModel.createMachine(deps);
    hookBridge();
    log("ARM_SERVICE_READY deviceId=" + selfDid());
  }

  function start(sid) {
    bind();
    var m = global._mcArmMachine;
    activeSidRef.sid = sid;
    return m.start(sid);
  }

  global.MultiCamArmService = {
    bind: bind,
    start: start,
    refresh: function () {
      var m = global._mcArmMachine;
      if (m) m.refresh();
    },
    cancel: function (reason) {
      var m = global._mcArmMachine;
      if (m) m.cancel(reason || "user");
    },
    view: function () {
      var m = global._mcArmMachine;
      return m ? m.view() : { active: false, devices: [], clock: {}, recEligible: false, incidents: [], incidentsEmpty: true, rev: 0 };
    },
    machine: function () { return global._mcArmMachine || null; },
    isActive: function () {
      var m = global._mcArmMachine;
      return !!(m && m.isActive && m.isActive());
    },
    onView: function (fn) {
      if (typeof fn === "function" && listeners.indexOf(fn) < 0) listeners.push(fn);
    },
    offView: function (fn) {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    }
  };
})(window);