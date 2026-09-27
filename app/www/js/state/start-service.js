/* MultiCam — service J08 "Countdown + START synchronisé" (écrans 07 / 08).
 * Graisse applicative entre :
 *   - le modèle pur déterministe  → MultiCamStartModel.createMachine (start-model.js) ;
 *   - les faits locaux + natifs    → camera-record.js (startCamera/startRecordVideo),
 *                                   capture-capabilities, store, ARM (J07) ;
 *   - le transport WebSocket      → session-ws.js (setStartBridge + broadcastTargeted) ;
 *   - l'écran                     → ui/countdown.js (s'abonne à onView).
 *
 * Répartition des responsabilités (invariants J08) :
 *   - le MODÈLE est pur : horloge, timers, réseau, readiness et actions natives
 *     lui sont INJECTÉS. Il ne connaît ni Cordova, ni le store, ni le WS ;
 *   - le SERVICE implémente ces dépendances et possède seul les deux opérations
 *     à effet de bord matériel :
 *       · prepareCapture()  — création de la PreviewSurface AVANT le top
 *         (`startCamera({camera:"back",toBack:true})`) ;
 *       · releaseCapture()  — libération si le plan est annulé / remplacé /
 *         remplacé par un plan dont on n'est pas Capture ;
 *   - le STOP d'urgence local passe par le modèle (stopLocal), qui appelle
 *     `deps.stopRecording` : le service ne fait JAMAIS de stop en doublon.
 *
 * Un point d'évaluation unique pour la readiness locale : captureReady(). Il
 * ne se contente pas de dire « le modèle est prêt » : il prépare réellement la
 * caméra si nécessaire et traduit l'échec en cause affichable. Une Capture
 * exclue puis revenue à l'état est réintégrée automatiquement par le modèle
 * (refreshLocalReadiness), qui rappelle donc CE point.
 *
 * Journalisation parsable : START_* / COUNTDOWN_* / CAPTURE_* du modèle via
 * deps.log, plus START_SERVICE_* et CAMERA_* (camera-record).
 */

(function (global) {
  "use strict";

  var listeners = [];
  var bridgeHooked = false;
  var sessionCache = {};        /* sid -> session (évite un rechargement par message) */
  var lastSession = null;
  var lastArmCycleId = "";      /* armCycleId du plan local (préparation idempotente) */
  var PREP_RETRY_MS = 2000;      /* ne pas marteler une préparation en échec */
  var prepState = { inFlight: false, lastFailMs: 0 };

  function log(l) { console.log(l); }
  function nowMs() { return Date.now(); }
  function cfg() { return (global.MultiCamConfig && global.MultiCamConfig.get) ? global.MultiCamConfig.get() : null; }
  function ws() { return global.MultiCamSessionWs; }
  function store() { return global.MultiCamSessionStore; }
  function startModel() { return global.MultiCamStartModel; }
  function camera() { return global.MultiCamCameraRecord; }
  function armService() { return global.MultiCamArmService; }

  function selfDid() {
    var st = ws() && ws().status ? ws().status() : null;
    if (st && st.localDid) return st.localDid;
    var c = cfg();
    return (c && c.deviceId) || "";
  }

  function machine() { return global._mcStartMachine; }

  /* ---------- session ---------- */

  function loadSession(sid) {
    if (!sid) return Promise.resolve(null);
    if (lastSession && lastSession.sessionId === sid) return Promise.resolve(lastSession);
    if (!store() || !store().get) return Promise.resolve(null);
    return Promise.resolve(store().get(sid)).then(function (s) {
      if (s) {
        sessionCache[sid] = s;
        lastSession = s;
      }
      return s || null;
    });
  }

  /* Le modèle n'a que le sessionId : on retrouve l'objet pour le transport. */
  function sessionFor(sid) {
    if (lastSession && lastSession.sessionId === sid) return lastSession;
    if (sessionCache[sid]) return sessionCache[sid];
    return null;
  }

  function sendTargeted(sid, kind, extra) {
    var s = sessionFor(sid);
    if (!s) {
      log("START_SEND_DROP kind=" + kind + " sessionId=" + (sid || "—") + " reason=session_not_cached");
      return;
    }
    if (ws() && typeof ws().broadcastTargeted === "function") {
      ws().broadcastTargeted(kind, s, extra);
    }
  }

  /* ---------- rôles (source de vérité : session.masters / take) ---------- */

  function isMasterRole(did, ses) {
    var s = ses || lastSession;
    if (!s || !did) return false;
    return (s.masters || []).some(function (m) { return m.deviceId === did; });
  }

  function takeOf(ses) {
    var s = ses || lastSession;
    if (!s) return null;
    var takes = s.takes || [];
    return takes.length ? takes[takes.length - 1] : null;
  }

  function isStorageRole(did, ses) {
    var take = takeOf(ses);
    if (!take) return false;
    return (take.storages || []).indexOf(did) >= 0;
  }

  function isCaptureRole(did, ses) {
    var take = takeOf(ses);
    if (!take) return false;
    return (take.captures || []).indexOf(did) >= 0;
  }

  function countdownSecondsOf(take) {
    var v = take ? take.countdownSeconds : 5;
    return typeof v === "number" && isFinite(v) && v >= 0 ? v : 5;
  }

  /* ---------- J07 : horloge et readiness ARM ---------- */

  function armView() {
    var a = armService();
    return a && typeof a.view === "function" ? a.view() : null;
  }

  /* Rafraîchit l'horloge J07 AVANT le verrouillage de targetStart : le plan
   * n'est créé qu'avec des offsets frais (CLOCK_FRESH_MAX_AGE_MS).
   *
   * Le contrat de la machine START est une PROMÈSSE, et cette promesse doit
   * représenter un travail RÉELLEMENT fait : on attend donc les échantillons
   * d'horloge postérieurs à la demande (ensureFreshClock). Résoudre
   * immédiatement — comme le faisait une simple relance de boucle — laissait la
   * vérification de fraîcheur s'exécuter sur des échantillons déjà vieux, et le
   * modèle refusait alors le plan en `clock_stale` alors qu'un simple
   * ré-échantillonnage de ~1,5 s suffisait. Le timeout est borné : en cas
   * d'échec, on rend la main et c'est le modèle qui refuse, avec son motif. */
  function refreshArmClock() {
    var a = armService();
    if (!a) return Promise.resolve();
    if (typeof a.refresh === "function") {
      try { a.refresh(); } catch (e) { log("START_SERVICE_ARM_REFRESH_ERROR err=" + String((e && e.message) || e)); }
    }
    if (typeof a.ensureFreshClock !== "function") return Promise.resolve();
    return Promise.resolve(a.ensureFreshClock()).then(function (r) {
      log("START_SERVICE_CLOCK_READY fresh=" + ((r && r.fresh) ? 1 : 0)
        + " waitedMs=" + Math.round((r && r.waitedMs) || 0)
        + " reason=" + ((r && r.reason) || "—"));
      return r;
    }, function (err) {
      log("START_SERVICE_CLOCK_WAIT_ERROR err=" + String((err && err.message) || err));
    });
  }

  /* Offsets J07 au format attendu par le modèle : { did: {offsetMs, ageMs} }.
   * Le plan consomme local − créateur ; arm-model fournit l'offset mesuré par
   * le leader pour chaque capture distante, qui EST bien local − créateur vu de
   * cette capture. Le signe n'est PAS inversé ici (invariant de J07).
   *
   * `ageMs` est l'ÂGE DE L'ÉCHANTILLON, pas la latence réseau : arm-model
   * expose `lastSyncMs`, on en déduit l'âge localement. Sans lastSyncMs on
   * n'invente PAS un âge de 0 (ce qui rendrait la fraîcheur toujours vraie et
   * laisserait passer un offset non mesuré) : l'offset est alors omis, et le
   * modèle rejette le plan en `clock_stale` — le défaut estimators-safe. */
  function armClockOffsets() {
    var a = armService();
    var v = a && typeof a.view === "function" ? a.view() : null;
    var out = {};
    /* arm-model expose `clock` comme une MAP deviceId -> échantillon (pas un
     * objet { peers }). On accepte les deux formes par défense, mais la
     * référence est la map. */
    var clock = (v && v.clock) || {};
    if (clock.peers && typeof clock.peers === "object") clock = clock.peers;
    var now = nowMs();
    Object.keys(clock).forEach(function (did) {
      var p = clock[did];
      if (!p) return;
      if (typeof p.offsetMs !== "number") return;
      if (typeof p.lastSyncMs !== "number") {
        log("START_SERVICE_CLOCK_UNMEASURED peer=" + did + " reason=no_lastSyncMs");
        return;
      }
      var ageMs = now - p.lastSyncMs;
      if (ageMs < 0) ageMs = 0;              /* garde-fou : horloge en arrière */
      out[did] = { offsetMs: p.offsetMs, ageMs: ageMs };
    });
    return out;
  }

  /* Masters actuellement connectés : le modèle en a besoin pour détecter la
   * perte de TOUS les Masters après programmation (START_MASTER_LOST). */
  function connectedMasters(sid) {
    var w = ws();
    if (!w || typeof w.connectedPeers !== "function") return [];
    var peers = w.connectedPeers(sid || (lastSession && lastSession.sessionId) || null);
    var s = sessionFor(sid);
    return (s && s.masters ? s.masters : [])
      .map(function (m) { return m.deviceId; })
      .filter(function (did) {
        if (did === selfDid()) return true;              /* soi-même est toujours joignable */
        return !!(peers && peers[did]);
      });
  }

  /* ---------- préparation caméra (service, jamais le modèle) ---------- */

  function prepareCapture(startPlanId) {
    if (!camera() || typeof camera().prepare !== "function") {
      log("START_SERVICE_PREP_SKIP startPlanId=" + (startPlanId || "—") + " reason=no_recorder");
      return Promise.resolve({ ok: false, message: "recorder_unavailable" });
    }
    lastArmCycleId = startPlanId || lastArmCycleId;
    return camera().prepare({ startPlanId: startPlanId }).then(function (r) {
      log("START_SERVICE_PREP_OK startPlanId=" + (startPlanId || "—")
        + " preparedAtMs=" + ((r && r.preparedAtMs) || 0)
        + (r && r.reused ? " reused=1" : ""));
      return { ok: true, message: "prepared" };
    }, function (err) {
      log("START_SERVICE_PREP_KO startPlanId=" + (startPlanId || "—")
        + " err=" + String((err && err.message) || err));
      return { ok: false, message: "camera_prepare_failed" };
    });
  }

  function releaseCapture(reason) {
    if (!camera() || typeof camera().release !== "function") return Promise.resolve();
    return Promise.resolve(camera().release(reason)).catch(function () { });
  }

  /* ---------- readiness locale (point d'évaluation unique) ---------- */

  /* Vrai si CETTE Capture peut démarrer au top : le modèle de caméra est
   * disponible, la permissions caméra est accordée, la préparation a réussi.
   * Retour { ok, message } — message affichable et journalisable.
   *
   * CONTRACT SYNCHRONE. Le modèle pur consomme ce point dans son tick
   * (`r.ok !== false`) : renvoyer une Promise ici serait lue comme « prêt » et
   * masquerait TOUT échec de préparation. On répond donc sur l'ÉTAT COURANT du
   * wrapper, et la préparation est déclenchée SANS être attendue : le tick
   * suivant (~200 ms) constate le résultat. Le top est verrouillé à
   * +countdown ≥ 300 ms, donc un échec de préparation a toujours le temps
   * d'exclure la Capture avant lui. */
  function captureReady(sid, plan) {
    var self = selfDid();
    var ses = sessionFor(sid) || lastSession;
    if (!isCaptureRole(self, ses)) {
      /* Un Master simple / un Storage n'a aucun media : ce n'est PAS une
       * exclusion, ce n'est simplement pas une Capture. Le modèle n'appelle
       * ce point que pour les Captures, mais on reste défensif. */
      return { ok: true, message: "not_capture" };
    }
    var c = cfg();
    var perms = (c && c.permissions) || {};
    if (perms.camera === false || perms.cameraGranted === false) {
      return { ok: false, message: "camera_permission_missing" };
    }
    var cp = global.CameraPreview;
    if (!cp || typeof cp.startRecordVideo !== "function") {
      return { ok: false, message: "recorder_unavailable" };
    }
    if (camera() && camera().isRecording && camera().isRecording()) {
      return { ok: false, message: "already_recording" };
    }
    var cam = camera();
    var cv = (cam && typeof cam.view === "function") ? cam.view() : null;
    if (cv && cv.prepared) return { ok: true, message: "prepared" };
    if (cv && cv.preparing) return { ok: true, message: "preparing" };
    /* Préparation déjà tentée ET en échec : on exclut. On ne réessaie qu'après
     * PREP_RETRY_MS — une exclusion « readiness » reste réversible côté modèle,
     * mais on ne martèle pas startCamera à chaque tick (≈5 fois/s). */
    if (cv && cv.lastError && (nowMs() - prepState.lastFailMs) < PREP_RETRY_MS) {
      return { ok: false, message: "camera_prepare_failed" };
    }
    ensurePrepare(plan ? plan.startPlanId : null);
    return { ok: true, message: "preparing" };
  }

  /* Déclenche une préparation idempotente sans l'attendre (voir captureReady).
   * Le verrou protège contre deux évaluations de readiness dans la même
   * milliseconde ; l'idempotence réelle est celle du wrapper (CAMERA_PREP_JOIN). */
  function ensurePrepare(planId) {
    if (prepState.inFlight) return;
    prepState.inFlight = true;
    log("START_SERVICE_LATE_PREP startPlanId=" + (planId || "—"));
    prepareCapture(planId).then(function (r) {
      prepState.inFlight = false;
      if (r && r.ok === false) {
        prepState.lastFailMs = nowMs();
        log("START_SERVICE_LATE_PREP_KO startPlanId=" + (planId || "—") + " reason=" + r.message);
      }
    }, function (err) {
      prepState.inFlight = false;
      prepState.lastFailMs = nowMs();
      log("START_SERVICE_LATE_PREP_KO startPlanId=" + (planId || "—")
        + " reason=" + String((err && err.message) || err));
    });
  }

  /* ---------- dépendances du modèle ---------- */

  function buildDeps() {
    return {
      nowMs: nowMs,
      schedule: function (fn, ms) { return setTimeout(fn, ms); },
      clearSchedule: function (t) { if (t) clearTimeout(t); },
      loadSession: loadSession,
      selfDid: selfDid,
      isMasterRole: isMasterRole,
      storageRole: isStorageRole,
      lastTake: takeOf,
      countdownSecondsOf: countdownSecondsOf,
      armView: armView,
      refreshArmClock: refreshArmClock,
      armClockOffsets: armClockOffsets,
      connectedMasters: connectedMasters,
      captureReady: captureReady,
      sendStartPlan: function (ses, plan) { sendTargeted(ses.sessionId, "start_plan", { plan: plan }); },
      sendStartState: function (sid, msg) { sendTargeted(sid, "start_state", msg); },
      sendStartCancel: function (sid, msg) { sendTargeted(sid, "start_cancel", msg); },
      sendStartProbe: function (sid, msg) { sendTargeted(sid, "start_probe", msg); },
      startRecording: function (opts) {
        if (!camera() || typeof camera().startRecording !== "function") {
          return Promise.reject(new Error("recorder_unavailable"));
        }
        return Promise.resolve(camera().startRecording(opts));
      },
      stopRecording: function () {
        if (!camera() || typeof camera().stopRecording !== "function") return Promise.resolve(null);
        return Promise.resolve(camera().stopRecording());
      },
      log: log,
      onChange: function () {
        listeners.slice().forEach(function (fn) { try { fn(); } catch (e) {} });
      }
    };
  }

  /* ---------- pont transport ---------- */

  function hookBridge() {
    if (bridgeHooked || !ws() || typeof ws().setStartBridge !== "function") return;
    bridgeHooked = true;
    ws().setStartBridge({
      onStartMessage: function (env, reply) {
        var m = machine();
        if (!m) {
          log("START_SERVICE_IGNORE kind=" + env.kind + " reason=no_machine");
          return;
        }
        /* Le transport a déjà validé la STRUCTURE ; le modèle applique les
         * invariants métier (session connue, plan courant, offsets, rôle). */
        m.onIncoming(env, reply);
      }
    });
  }

  /* ---------- API publique ---------- */

  /* La machine est créée au BOOT (bind) pour répondre aux plans des autres
   * Masters même si aucun écran n'est ouvert : un plan reçu doit être adopté
   * (et sa caméra préparée) sans action utilisateur locale. */
  function bind() {
    if (global._mcStartMachine) return;
    if (!startModel() || !startModel().createMachine) {
      log("START_SERVICE_UNAVAILABLE reason=no_model");
      return;
    }
    global._mcStartMachine = startModel().createMachine(buildDeps());
    hookBridge();
    log("START_SERVICE_READY deviceId=" + selfDid());
  }

  /* Arme la session courante (le modèle s'active à la première adoption).
   * Renvoie une PROMESSSE de vue : la session est d'abord chargée depuis le
   * store, sinon les rôles (Master / Capture / Storage) seraient Lus sur une
   * session absente — donc tous faux, silencieusement. */
  function ensureSession(sid) {
    var target = sid || (lastSession && lastSession.sessionId) || null;
    if (target && lastSession && lastSession.sessionId === target) return Promise.resolve(lastSession);
    return loadSession(target).then(function (s) {
      if (s) lastSession = s;
      return s;
    });
  }

  function start(sid) {
    bind();
    var self = selfDid();
    return ensureSession(sid).then(function (s) {
      log("START_SERVICE_START sessionId=" + (sid || "—")
        + (s ? "" : " reason=session_absente")
        + " isMaster=" + (isMasterRole(self, s) ? 1 : 0)
        + " isCapture=" + (isCaptureRole(self, s) ? 1 : 0)
        + " isStorage=" + (isStorageRole(self, s) ? 1 : 0)
        + " countdown=" + (countdownSecondsOf(takeOf(s))));
      return view();
    });
  }

  /* Recharge FORCÉE depuis le store, en ignorant le cache `lastSession`.
   *
   * `lastSession` est épinglé au moment de l'adoption d'un plan. Or une même
   * session peut créer un Take N+1 et changer de rôles ENTRE deux START (le
   * bouton « Nouveau Take » de l'écran 05, un changement de rôles en session).
   * Servir le cache faisait alors :
   *   - rejeter le 2e START avec `local_stopped_take` sur l'ANCIEN Take 1
   *     (le 1er START l'avait arrêté) ;
   *   - lire le rôle Capture sur une session périmée, donc ne pas préparer la
   *     caméra (ou la préparer à tort).
   * Le START est le point où l'état doit être frais : on relit donc le store.
   */
  function reloadSession(sid) {
    var target = sid || (lastSession && lastSession.sessionId) || null;
    if (!target || !store() || !store().get) return Promise.resolve(lastSession || null);
    return Promise.resolve(store().get(target)).then(function (s) {
      if (s) {
        sessionCache[target] = s;
        lastSession = s;
      }
      return s || null;
    });
  }

  /* Démarrage déclenché par l'écran 07 (bouton REC). Le modèle rafraîchit
   * l'horloge, verrouille targetStart, crée/diffuse/adopte le plan. */
  function requestStart(sid) {
    bind();
    var m = machine();
    if (!m) return Promise.reject(new Error("no_machine"));
    var target = sid || (lastSession && lastSession.sessionId) || null;
    var self = selfDid();
    /* Session FRAICHE avant toute décision : le Take à armer et le rôle Capture
     * sont lus dessus, jamais sur le cache (voir reloadSession). */
    return reloadSession(target).then(function (ses) {
    /* Préparation AVANT le plan : la PreviewSurface doit exister avant que le
     * top puisse survenir (le top est verrouillé à +countdown, donc nous avons
     * le temps — mais on veut connaître un échec AVANT d'annoncer un plan). */
    /* IMPORTANT J08 : seul un DEVICE ayant le rôle Capture ouvre la PreviewSurface
     * et invoque CameraPreview. Un Master simple (non-Capture) NE PREPARE PAS la
     * caméra : il crée, diffuse et supervise le plan, sans consommer la caméra. */
    var selfRoleIsCapture = isCaptureRole(self, ses);
    var prepP = selfRoleIsCapture ? prepareCapture(null) : Promise.resolve({ ok: true, message: "not_capture" });
    return prepP.then(function (prep) {
      if (selfRoleIsCapture && prep.ok === false) {
        log("START_REQUEST_BLOCKED deviceId=" + self + " reason=" + prep.message);
        var e = new Error(prep.message || "capture_not_ready");
        e.userMessage = prep.message;
        throw e;
      }
      return m.requestStart({ sid: target });
    });
    }).then(function (v) {
      log("START_SERVICE_REQUEST_OK startPlanId=" + (v && v.startPlanId));
      return v;
    }, function (err) {
      log("START_SERVICE_REQUEST_KO err=" + String((err && err.message) || err)
        + " userMessage=" + String((err && err.userMessage) || "—"));
      throw err;
    });
  }

  function cancel(reason) {
    var m = machine();
    if (!m) return Promise.reject(new Error("no_machine"));
    return Promise.resolve(m.cancel(reason || "master_cancel")).then(function (v) {
      /* Plan annulé : plus rien ne sera enregistré, on relâche la préparation
       * (sauf si un enregistrement était déjà engagé). */
      releaseCapture("cancel:" + (reason || "master_cancel"));
      return v;
    });
  }

  /* STOP d'urgence (écran 08, Master isolé) ou arrêt du placeholder. */
  function stopLocal(reason) {
    var m = machine();
    if (!m) return Promise.reject(new Error("no_machine"));
    return Promise.resolve(m.stopLocal(reason || "emergency")).then(function (v) {
      releaseCapture("local_stop");
      return v;
    });
  }

  /* Réévalue l'éligibilité locale (exclusion / réintégration). L'UI l'appelle
   * périodiquement pendant le countdown ; le modèle ne fait rien si la phase
   * ne l'exige pas (aucun effet de bord inutile). */
  function refreshReadiness() {
    var m = machine();
    if (m && typeof m.refreshLocalReadiness === "function") m.refreshLocalReadiness();
  }

  function view() {
    var m = machine();
    var v = m ? m.view() : { active: false, phase: startModel ? startModel().PHASE_IDLE : "IDLE", rev: 0 };
    var cam = camera() && camera().view ? camera().view() : {};
    v.camera = cam;
    v.recording = !!cam.recording;
    return v;
  }

  function isActive() {
    var m = machine();
    return !!(m && m.isActive && m.isActive());
  }

  function isRecording() {
    return !!(camera() && camera().isRecording && camera().isRecording());
  }

  /* Session fermée / changement de Take : on ne laisse ni préparation ni
   * enregistrement dangling quand c'est possible sans arrêter un REC en cours. */
  function releaseIfIdle(reason) {
    if (isRecording()) {
      log("START_SERVICE_RELEASE_SKIP reason=" + (reason || "—") + " note=recording_in_progress");
      return Promise.resolve(false);
    }
    return releaseCapture(reason || "session_change").then(function () { return true; });
  }

  global.MultiCamStartService = {
    bind: bind,
    start: start,
    requestStart: requestStart,
    cancel: cancel,
    stopLocal: stopLocal,
    refreshReadiness: refreshReadiness,
    releaseIfIdle: releaseIfIdle,
    view: view,
    isActive: isActive,
    isRecording: isRecording,
    machine: machine,
    selfDid: selfDid,
    onView: function (fn) {
      if (typeof fn === "function" && listeners.indexOf(fn) < 0) listeners.push(fn);
    },
    offView: function (fn) {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    }
  };
})(window);
