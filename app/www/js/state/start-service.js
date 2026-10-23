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
 * ---------- J09 §35.1 : la preview n'est plus une propriété du plan ----------
 *
 * La preview caméra locale est devenue le FOND PERMANENT d'un device Capture
 * (skill Capture active + application au premier plan). Sa durée de vie
 * appartient désormais à `state/preview-service.js`, et plus à un plan de
 * START. Conséquences dans CE module :
 *   - `prepareCapture()` reste le seul point de CONSOMMATION de la caméra au
 *     top, mais il est idempotent : la preview étant déjà ouverte, il renvoie
 *     `reused:true` sans rappeler `startCamera` (aucun clignotement, aucune
 *     seconde caméra) ;
 *   - la fin d'un plan (annulation, STOP local) n'appelle PLUS `releaseCapture` :
 *     un plan abandonné ne doit pas éteindre le fond caméra (§35.1) ;
 *   - `releaseIfIdle()` ne ferme plus la caméra : il demande au service de
 *     preview de ré-évaluer son besoin.
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
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function cfg() { return (global.MultiCamConfig && global.MultiCamConfig.get) ? global.MultiCamConfig.get() : null; }
  function ws() { return global.MultiCamSessionWs; }
  function store() { return global.MultiCamSessionStore; }
  function startModel() { return global.MultiCamStartModel; }
  function camera() { return global.MultiCamCameraRecord; }
  function sampler() { return global.MultiCamPreviewSampler || null; }
  function camSwitch() { return global.MultiCamCameraSwitchService || null; }
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

  /* Countdown affiché au START : le choix de l'opérateur (écran 05) est
   * PERSISTÉ DANS LES RÉGLAGES du Take — `take.settings.countdownSeconds`
   * (take-model.js : sanitizeTake / setSetting). Il n'existe AUCUN champ
   * `take.countdownSeconds` : le lire à la racine renvoyait toujours
   * undefined, donc 0/3/10 s étaient ignorés en silence et le START retombait
   * sur 5 s pendant que l'UI affichait la valeur choisie.
   * Repli 5 s (défaut modèle) UNIQUEMENT si la valeur est absente ou
   * inexploitable — et une valeur absente mais impostée est journalisée. */
  var COUNTDOWN_DEFAULT_SECONDS = 5;
  function countdownSecondsOf(take) {
    var s = take && take.settings ? take.settings : null;
    var v = s ? s.countdownSeconds : undefined;
    if (typeof v === "number" && isFinite(v) && v >= 0) return v;
    if (v !== undefined && v !== null) {
      log("START_COUNTDOWN_INVALID deviceId=" + selfDid()
        + " value=" + String(v) + " fallbackSeconds=" + COUNTDOWN_DEFAULT_SECONDS);
    }
    return COUNTDOWN_DEFAULT_SECONDS;
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

  /* J09 §35.1 — PLUS AUCUN APPELANT.
   *
   * La fermeture de la caméra n'appartient plus à ce module : c'est
   * `state/preview-service.js` qui décide de la durée de vie de la preview
   * (skill Capture + premier plan). Appeler cette fonction depuis la fin d'un
   * plan — annulation, STOP local, changement de Take — éteindrait le fond
   * caméra, ce que §35.1 interdit explicitement.
   *
   * Conservée et exportée comme point de fermeture EXPLICITE, pour les jalons
   * qui en auront besoin (teardown d'application, fermeture de session
   * volontaire). Ne pas la réintroduire dans `cancel` / `stopLocal`. */
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
      /* J10 : STOP coordonné — mêmes canaux ciblés que le protocole START. */
      sendStopRequest: function (sid, msg) { sendTargeted(sid, "stop_request", msg); },
      sendStopState: function (sid, msg) { sendTargeted(sid, "stop_state", msg); },
      /* Vivacité réelle d'un pair dans CETTE session : sert à lever un incident
       * STOP à sa reconnexion (maquette ui/08 §6). Ne confond jamais liveness
       * et état : un pair connecté sans stop_state reste en incident s'il ne
       * répond pas (le levé n'a lieu qu'à la reconnexion constatée). */
      peerConnected: function (did) {
        if (!did || !ws() || typeof ws().connectedPeers !== "function") return false;
        var peers = ws().connectedPeers(lastSession ? lastSession.sessionId : null) || {};
        return !!peers[did];
      },
      /* J09-03 : le sampler de preview démarre UNIQUEMENT après l'accusé natif
       * du REC (donc en phase REC effective) et s'arrête dès que le
       * `stopRecording` est appelé. Il ne touche pas au protocole WS et sa vie
       * n'est pas liée au rendu UI. */
      startRecording: function (opts) {
        if (!camera() || typeof camera().startRecording !== "function") {
          return Promise.reject(new Error("recorder_unavailable"));
        }
        var o = opts || {};
        return Promise.resolve(camera().startRecording(opts)).then(function (res) {
          /* J09-08b1 : le segment 1 s'ouvre ICI, et nulle part ailleurs. C'est
           * le seul endroit du code où un recorder démarre pour un Take — le
           * redémarrage d'un segment passe par `camera-record`, jamais par ce
           * point. L'index est donc attribué une fois par Take, au bon moment. */
          var cs = camSwitch();
          if (cs && typeof cs.onRecordingStarted === "function") cs.onRecordingStarted();
          var smp = sampler();
          if (smp && typeof smp.start === "function") {
            smp.start({
              sessionId: o.sessionId || "",
              takeNumber: o.takeNumber,
              startPlanId: o.startPlanId || "",
              reason: "rec_ack"
            });
          }
          return res;
        });
      },
      stopRecording: function () {
        if (!camera() || typeof camera().stopRecording !== "function") return Promise.resolve(null);
        var smp = sampler();
        if (smp && typeof smp.stop === "function") smp.stop("rec_stop");
        /* Le retour natif porte le `path` du fichier finalisé : c'est le seul
         * fait qui rattache un index à un fichier. Il est transmis AU MOMENT de
         * l'arrêt, parce qu'après `stopRecording` plus personne ne le connaît —
         * `camera-record` ne conserve qu'un chemin unique, déjà écrasé au
         * segment suivant. */
        return Promise.resolve(camera().stopRecording()).then(function (res) {
          var cs = camSwitch();
          if (cs && typeof cs.onRecordingStopped === "function") cs.onRecordingStopped(res || {});
          return res;
        }, function (err) {
          /* J09-08b2 : un arrêt NON CONFIRMÉ ne clôture AUCUN segment. Le
           * segment reste en cours et identifiable, l'historique ne bouge pas et
           * aucun index n'est consommé. L'erreur est ensuite REMONTÉE à
           * l'identique : le modèle doit toujours voir l'échec du STOP. */
          var cs = camSwitch();
          if (cs && typeof cs.onRecordingStopFailed === "function") cs.onRecordingStopFailed(err || {});
          throw err;
        });
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
    /* J09 §35.1 : la fin d'un plan n'éteint PAS la preview locale. La caméra est
     * le fond permanent d'un device Capture ; elle est possédée par
     * `preview-service.js` et survit à l'annulation. Libérer ici éteindrait le
     * fond caméra à chaque plan abandonné. */
    return Promise.resolve(m.cancel(reason || "master_cancel"));
  }

  /* STOP d'urgence (écran 08, Master isolé) ou arrêt du placeholder.
   * Même règle qu'au cancel : l'enregistrement s'arrête, la preview reste. */
  function stopLocal(reason) {
    var m = machine();
    if (!m) return Promise.reject(new Error("no_machine"));
    return Promise.resolve(m.stopLocal(reason || "emergency"));
  }

  /* STOP global coordonné J10 : déclenché par le Master (bouton STOP de
   * l'écran 08). Le modèle verrouille targetStopMs, diffuse le stop_request et
   * exécute le top d'arrêt local. La preview (fond permanent §35.1) reste. */
  function requestStop(reason) {
    var m = machine();
    if (!m) return Promise.reject(new Error("no_machine"));
    return Promise.resolve(m.requestStop(reason || "master_stop"));
  }

  /* Réévalue l'éligibilité locale (exclusion / réintégration). L'UI l'appelle
   * périodiquement pendant le countdown ; le modèle ne fait rien si la phase
   * ne l'exige pas (aucun effet de bord inutile). */
  function refreshReadiness() {
    var m = machine();
    if (m && typeof m.refreshLocalReadiness === "function") m.refreshLocalReadiness();
  }

   var lastPersistedStopKey = "";
  /* J16-A — signature des états d'arrêt déjà persistés (cf. `persistStopIfNeeded`). */
  var lastPersistedStopSig = null;

  var stopPersistHooks = [];
  function registerStopPersistHook(fn) {
    if (typeof fn === "function" && stopPersistHooks.indexOf(fn) < 0) stopPersistHooks.push(fn);
  }

  /* J16-A — signature DÉTERMINISTE des états d'arrêt connus : elle ne change
   * que si un FAIT nouveau est apparu (une Capture de plus a confirmé). Elle
   * sert de garde-fou d'écriture : on ne réécrit le résumé que lorsqu'il y a
   * réellement du nouveau. */
  function stopStatesSignature(states) {
    if (!states || typeof states !== "object") return "";
    var dids = Object.keys(states).sort();
    return dids.map(function (did) {
      var st = states[did] || {};
      return did + ":" + (st.state || "") + ":" + (isNum(st.actualMs) ? st.actualMs : "") + ":" + (isNum(st.deltaMs) ? st.deltaMs : "");
    }).join(";");
  }

  /* J16-A — états d'arrêt PAR CAPTURE, normalisés pour la persistance.
   * L'assainissement est celui du modèle de Take (source unique de vérité) ;
   * à défaut, une copie minimale mais HONNête (aucune valeur inventée). */
  function stopStatesOf(states, prevSummary) {
    var tm = global.MultiCamTakeModel;
    var out;
    if (tm && typeof tm.sanitizeStopStateMap === "function") {
      out = tm.sanitizeStopStateMap(states || {});
    } else {
      out = {};
      Object.keys(states || {}).forEach(function (did) {
        var st = states[did];
        if (!st || typeof st !== "object") return;
        out[did] = {
          deviceId: typeof st.deviceId === "string" ? st.deviceId : did,
          state: typeof st.state === "string" && st.state ? st.state : "STOPPED",
          stopId: typeof st.stopId === "string" ? st.stopId : "",
          actualMs: isNum(st.actualMs) ? st.actualMs : null,
          localTargetMs: isNum(st.localTargetMs) ? st.localTargetMs : null,
          deltaMs: isNum(st.deltaMs) ? st.deltaMs : null,
          path: typeof st.path === "string" ? st.path : "",
          reason: typeof st.reason === "string" ? st.reason : "",
          receivedAtMs: isNum(st.receivedAtMs) && st.receivedAtMs > 0 ? st.receivedAtMs : 0
        };
      });
    }
    /* Un état déjà persisté et toujours connu n'est jamais perdu. */
    var prev = (prevSummary && prevSummary.stopStates) || {};
    Object.keys(prev).forEach(function (did) {
      if (!out[did] && prev[did]) out[did] = prev[did];
    });
    return out;
  }
  function triggerStopPersist(v) {
    try {
      for (var i = 0; i < stopPersistHooks.length; i++) {
        try { stopPersistHooks[i](v); } catch (e) {}
      }
    } catch (e) {}
  }
   var pendingStop = null;

   var _autoCheck = null;
  function _ensureAutoCheck() {
    if (_autoCheck) return;
    _autoCheck = setInterval(function () {
      try {
        var m = machine();
        var mv = m && m.view ? m.view() : null;
        var v = view();
        var sm = startModel && startModel();
        if ((mv && (mv.phase === "STOPPED" || mv.stopExecuted)) || (v && (v.phase === "STOPPED" || v.stopExecuted)) || (sm && v.phase === sm.PHASE_STOPPED)) {
          var ps = pendingStop || {};
          if (mv) { if (mv.sid) ps.sid = mv.sid; if (mv.takeNumber != null) ps.takeNumber = mv.takeNumber; if (mv.stopId) ps.stopId = mv.stopId; if (mv.stopStates) ps.stopStates = mv.stopStates; }
          if (v) { if (v.sid) ps.sid = v.sid; if (v.takeNumber != null) ps.takeNumber = v.takeNumber; }
          if (lastSession && lastSession.takes && lastSession.takes.length && ps.takeNumber == null) ps.takeNumber = lastSession.takes[lastSession.takes.length-1].takeNumber;
          ps.stopExecuted = true;
          pendingStop = ps;
          persistStopIfNeeded(pendingStop);
          try { clearInterval(_autoCheck); _autoCheck = null; } catch (e) {}
        }
      } catch (e) {}
    }, 400);
  }
  try { setTimeout(_ensureAutoCheck, 100); } catch (e) {}

  function persistStopIfNeeded(v) {
     if (!v) return Promise.resolve(null);
     var sid = v.sid;
     if (!sid && lastSession && lastSession.sessionId) sid = lastSession.sessionId;
     var takeNum = v.takeNumber;
     if (takeNum == null || takeNum === undefined || takeNum === "") {
       if (lastSession && lastSession.takes && lastSession.takes.length) {
         takeNum = lastSession.takes[lastSession.takes.length - 1].takeNumber;
       } else {
         takeNum = 0;
       }
     }
     var stopId = v.stopId || (v.localStopInfo && v.localStopInfo.stopId) || "";
     if (!v.stopExecuted && !(v.phase === "STOPPED" || (startModel && startModel().PHASE_STOPPED && v.phase === startModel().PHASE_STOPPED))) {
       // still may need to persist if we have stop states
     }
     if (!sid) {
       log("TAKE_PERSIST_STOP_SKIP reason=no_sid take=" + takeNum + " stopId=" + stopId);
       return Promise.resolve(null);
     }
     var key = sid + "|" + takeNum + "|" + stopId;
     /* J16-A — signature des états d'arrêt CONNUS. Le garde-fou historique
      * (clé sid|take|stopId) empêche d'écrire le même arrêt mille fois ; la
      * signature autorise en revanche UNE réécriture par confirmation
      * supplémentaire (une Capture qui confirme APRÈS l'arrêt tardif). Le
      * nombre d'écritures reste BORNÉ par le nombre de Captures du Take —
      * ce n'est pas une source d'orage réseau (cf. J14-B02 : l'orage venait
      * de la PROGRESSION de transfert, pas de l'arrêt). */
     var stopSig = stopStatesSignature(v.stopStates);
     if (key === lastPersistedStopKey && stopSig === lastPersistedStopSig) return Promise.resolve(null);
     var storeApi = store();
     var wsApi = ws();
     if (!storeApi || typeof storeApi.get !== "function" || !wsApi || typeof wsApi.upsertTake !== "function") return Promise.resolve(null);
     return Promise.resolve(storeApi.get(sid)).then(function (ses) {
       if (!ses) {
         log("TAKE_PERSIST_STOP_SKIP reason=no_session sid=" + sid);
         return null;
       }
       sessionCache[sid] = ses;
       lastSession = ses;
       if (v.takeNumber == null || v.takeNumber === undefined || v.takeNumber === "") {
         var lt = ses.takes && ses.takes.length ? ses.takes[ses.takes.length - 1] : null;
         if (lt) takeNum = lt.takeNumber;
       } else {
         takeNum = v.takeNumber || 0;
       }
       var take = null;
       var takes = ses.takes || [];
       for (var i = 0; i < takes.length; i++) {
         if (takes[i] && takes[i].takeNumber === takeNum) { take = takes[i]; break; }
       }
       if (!take && takes.length) {
         take = takes[takes.length - 1];
         takeNum = take.takeNumber;
       }
       if (!take) return null;
        lastPersistedStopKey = key;
        lastPersistedStopSig = stopSig;
       var tm = global.MultiCamTakeModel;
       var t2 = tm ? JSON.parse(JSON.stringify(take)) : JSON.parse(JSON.stringify(take));
       var wantStatus = tm && tm.STATUS_TERMINATED ? tm.STATUS_TERMINATED : "TERMINATED";
       if (t2.status !== wantStatus)        if (t2.status !== wantStatus && t2.status !== "TERMINATED") t2.status = wantStatus;
       t2.updatedByDeviceId = selfDid() || t2.updatedByDeviceId || "";
       t2.updatedAtMs = nowMs();
        var summary = {
          stoppedAtMs: (v.localStopInfo && (isNum(v.localStopInfo.stopAtMs) || isNum(v.localStopInfo.actualMs))) ? (v.localStopInfo.stopAtMs || v.localStopInfo.actualMs)
            : (v.stop && (isNum(v.stop.stopAtMs) || isNum(v.stop.actualMs))) ? (v.stop.stopAtMs || v.stop.actualMs) : nowMs(),
          durationMs: isNum(v.stopDurationMs) ? v.stopDurationMs : (isNum(v.recElapsedMs) ? v.recElapsedMs : 0),
          stopReason: (v.stop && v.stop.reason) || "",
          transferState: (t2.summary && t2.summary.transferState) || "",
          transferError: (t2.summary && t2.summary.transferError) || "",
          transferBytes: (t2.summary && t2.summary.transferBytes) || 0,
          transferTotal: (t2.summary && t2.summary.transferTotal) || 0,
          transferPercent: (t2.summary && t2.summary.transferPercent) || 0,
          transfers: (t2.summary && t2.summary.transfers) ? JSON.parse(JSON.stringify(t2.summary.transfers)) : {},
          /* J16-A — les faits d'arrêt PAR CAPTURE sont conservés (ils étaient
           * perdus : seuls les vivants les connaissaient). C'est ce qui permet
           * d'afficher l'état final d'une Capture sur un Take PASSÉ. */
          stopStates: stopStatesOf(v.stopStates, t2.summary),
          /* J16-A — les faits de RÉPLICATION (couple Capture → Storage) sont
           * conservés tels quels : l'arrêt ne doit jamais les effacer. */
          replications: (t2.summary && t2.summary.replications) ? JSON.parse(JSON.stringify(t2.summary.replications)) : {}
        };
       var hasStopStates = v.stopStates && Object.keys(v.stopStates).length;
       if (hasStopStates && Object.keys(summary.transfers).length === 0) {
         Object.keys(v.stopStates).forEach(function (did) {
           var st = v.stopStates[did];
           if (!st) return;
           summary.transfers[did] = {
             state: "STOPPED",
             bytes: 0,
             total: 0,
             percent: 0,
             error: "",
             startedAtMs: 0,
             updatedAtMs: st.receivedAtMs || st.actualMs || nowMs(),
             completedAtMs: st.receivedAtMs || st.actualMs || nowMs()
           };
         });
       }
       t2.summary = summary;
       return wsApi.upsertTake(ses, t2).then(function () {
       pendingStop = null;
       try { triggerStopPersist({ sid: sid, takeNumber: takeNum, stopId: stopId, stopExecuted: true, stopStates: v.stopStates, localStopInfo: v.localStopInfo, stop: v.stop, stopDurationMs: v.stopDurationMs, recElapsedMs: v.recElapsedMs }); } catch (e) {}
       log("TAKE_PERSIST_STOP sid=" + v.sid + " take=" + takeNum + " stopId=" + (v.stopId || "") + " status=" + (t2.status||""));
     }).catch(function (e) {
       log("TAKE_PERSIST_STOP_ERR " + String((e && e.message) || e));
     });
     }).catch(function (e) {
       log("TAKE_PERSIST_STOP_LOAD_ERR sid=" + v.sid + " err=" + String((e && e.message) || e));
     });
   }

   function view() {
     var m = machine();
     var v = m ? m.view() : { active: false, phase: startModel ? startModel().PHASE_IDLE : "IDLE", rev: 0 };
     var cam = camera() && camera().view ? camera().view() : {};
     v.camera = cam;
     v.recording = !!cam.recording;
     /* J09-07 : l'écran REC de la Capture a besoin de l'état caméra CONFIRMÉ.
      * On le publie ici — et pas dans `camera` — pour que la ligne « Caméra »
      * reste celle de la PRÉPARATION (J08), qui est une autre question. */
     var cs = global.MultiCamCameraSwitchService;
     v.cameraSwitch = (cs && typeof cs.view === "function") ? cs.view() : null;
     try {
       var mv = null;
       if (m && typeof m.view === "function") mv = m.view();
       var should = false;
       if (v) {
         if (v.stopExecuted) should = true;
         if (v.phase === "STOPPED") should = true;
       }
       if (mv) {
         if (mv.stopExecuted) should = true;
         if (mv.phase === "STOPPED") should = true;
         if (!v.sid && mv.sid) v.sid = mv.sid;
         if (v.takeNumber == null && mv.takeNumber != null) v.takeNumber = mv.takeNumber;
         if (!v.stopId && mv.stopId) v.stopId = mv.stopId;
       }
       var sm = startModel && startModel();
       if (sm && (v.phase === sm.PHASE_STOPPED || (mv && mv.phase === sm.PHASE_STOPPED))) should = true;
       if (should || pendingStop || (mv && mv.phase === "STOPPED") || v.phase === "STOPPED") {
         pendingStop = pendingStop || { sid: v.sid, takeNumber: v.takeNumber, stopId: v.stopId || (v.localStopInfo && v.localStopInfo.stopId) || "", stopExecuted: true, stopStates: v.stopStates, localStopInfo: v.localStopInfo, stop: v.stop, stopDurationMs: v.stopDurationMs, recElapsedMs: v.recElapsedMs };
         // merge current v
         if (v.sid) pendingStop.sid = v.sid;
         if (mv && mv.sid) pendingStop.sid = mv.sid;
         if (v.takeNumber != null) pendingStop.takeNumber = v.takeNumber;
         if (mv && mv.takeNumber != null) pendingStop.takeNumber = mv.takeNumber;
         if (lastSession && lastSession.takes && lastSession.takes.length) pendingStop.takeNumber = pendingStop.takeNumber != null ? pendingStop.takeNumber : lastSession.takes[lastSession.takes.length-1].takeNumber;
         if (v.stopId) pendingStop.stopId = v.stopId;
         if (mv && mv.stopId) pendingStop.stopId = mv.stopId;
         if (v.stopStates) pendingStop.stopStates = v.stopStates;
         if (mv && mv.stopStates) pendingStop.stopStates = mv.stopStates;
         if (v.localStopInfo) pendingStop.localStopInfo = v.localStopInfo;
         if (v.stop) pendingStop.stop = v.stop;
         if (v.stopDurationMs != null) pendingStop.stopDurationMs = v.stopDurationMs;
         if (v.recElapsedMs != null) pendingStop.recElapsedMs = v.recElapsedMs;
         pendingStop.stopExecuted = true;
         persistStopIfNeeded(pendingStop);
       }
     } catch (e) {}
     return v;
   }

  function isActive() {
    var m = machine();
    return !!(m && m.isActive && m.isActive());
  }

  /* J09-07 — Accésseur ÉTROIT, volontairement distinct de `view()`.
   * `view()` publie `cameraSwitch`, qui appelle `camera-switch-service.view()` ;
   * si ce dernier lit le phase via `view()`, les deux s'appellent et la pile
   * explose (constaté sur le terrain : « Maximum call stack size exceeded »).
   * Tout module qui a besoin de la phase doit donc passer par ici, et par la
   * machine — jamais par la vue agrégée. */

  function forcePersistLastTake(reason, sidOpt) {
    var storeApi = store();
    var wsApi = ws();
    if (!storeApi || typeof storeApi.get !== "function" || !wsApi || typeof wsApi.upsertTake !== "function") {
      return Promise.reject(new Error("missing_deps"));
    }
    var sid = sidOpt || (lastSession && lastSession.sessionId);
    if (!sid) return Promise.reject(new Error("no_sid"));
    return Promise.resolve(storeApi.get(sid)).then(function (ses) {
      if (!ses) return Promise.reject(new Error("no_session"));
      lastSession = ses;
      sessionCache[sid] = ses;
      var take = ses.takes && ses.takes.length ? ses.takes[ses.takes.length - 1] : null;
      if (!take) return Promise.reject(new Error("no_take"));
      var tm = global.MultiCamTakeModel;
      var t2 = tm ? JSON.parse(JSON.stringify(take)) : JSON.parse(JSON.stringify(take));
      var wantStatus = tm && tm.STATUS_TERMINATED ? tm.STATUS_TERMINATED : "TERMINATED";
      t2.status = wantStatus;
      t2.updatedByDeviceId = selfDid() || t2.updatedByDeviceId || "";
      t2.updatedAtMs = nowMs();
      var summary = t2.summary ? JSON.parse(JSON.stringify(t2.summary)) : {};
      summary.stoppedAtMs = summary.stoppedAtMs || nowMs();
      summary.durationMs = summary.durationMs || 0;
      summary.stopReason = reason || "debug";
      if (!summary.transfers) summary.transfers = {};
      t2.summary = summary;
      return wsApi.upsertTake(ses, t2).then(function () {
        log("TAKE_PERSIST_STOP sid=" + ses.sessionId + " take=" + t2.takeNumber + " stopId=debug");
      });
    });
  }

  function phase() {
    var m = machine();
    if (m && typeof m.view === "function") return m.view().phase || "";
    return startModel ? startModel().PHASE_IDLE : "";
  }

  function isRecording() {
    return !!(camera() && camera().isRecording && camera().isRecording());
  }

  /* J09 §35.1 : ce point NE ferme plus la caméra. La preview permanente est
   * possédée par `preview-service.js` (skill Capture + premier plan) ; un
   * changement de session, un plan annulé ou un STOP local n'ont aucune
   * raison de l'éteindre. La fonction demande donc au service de preview de
   * RÉÉVALUER son besoin, et rien d'autre. */
  function releaseIfIdle(reason) {
    if (isRecording()) {
      log("START_SERVICE_RELEASE_SKIP reason=" + (reason || "—") + " note=recording_in_progress");
      return Promise.resolve(false);
    }
    var pv = global.MultiCamPreviewService;
    if (!pv || typeof pv.reconcile !== "function") return Promise.resolve(false);
    return Promise.resolve(pv.reconcile(reason || "session_change")).then(function () { return true; });
  }

  global.MultiCamStartService = {
    bind: bind,
    start: start,
    requestStart: requestStart,
    cancel: cancel,
    stopLocal: stopLocal,
    requestStop: requestStop,
    refreshReadiness: refreshReadiness,
    releaseIfIdle: releaseIfIdle,
    view: view,
    isActive: isActive,
    isRecording: isRecording,
    phase: phase,
    machine: machine,
    registerStopPersistHook: registerStopPersistHook,
    selfDid: selfDid,
    onView: function (fn) {
      if (typeof fn === "function" && listeners.indexOf(fn) < 0) listeners.push(fn);
    },
    offView: function (fn) {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    forcePersistLastTake: forcePersistLastTake
  };
})(window);
