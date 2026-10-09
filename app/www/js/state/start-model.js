/* MultiCam — modèle pur J08 : Countdown + START synchronisé (écran 07).
 * Module "UMD-lite" (même convention que arm-model.js / take-model.js) :
 * window.MultiCamStartModel pour l'app, require() en Node pour les tests
 * déterministes (tests/plugin-lab/session/start-model.test.js).
 *
 * Périmètre PUR — aucun DOM, WebSocket, natif, ni Date.now implicite (horloge et
 * timers arrivent via les dépendances de createMachine ; les helpers math sont
 * purs). Règles figées : mission J08 + maquette validée ui/07-countdown.
 *
 *  - Un plan START est AUTO-SUFFISANT : il porte l'instant cible ABSOLU dans
 *    l'horloge de son créateur + les offsets J07 mesurés. CONVENTION DE SIGNE
 *    (invariant J08) : tout offset stocké par le modèle vaut
 *    C_local − C_createur (positif = « mon horloge est en avance »), et le top
 *    local vaut localTop = targetStart + offset. C'est exactement ce que le
 *    leader J07 mesure (offsetOf = pair − local, donc pour la clé « moi » on
 *    obtient C_moi − C_leader). La sonde NTP locale rend la convention J07
 *    (pair − local) : elle est donc NEGÉE à l'arrivée. Deux bases de temps
 *    confondues ici produiraient un faux top de 2×l'offset — d'où ce commentaire.
 *    Aucune dépendance réseau à l'instant du top : la perte de TOUS les Masters
 *    après programmation n'annule donc pas le départ.
 *  - Arbitrage multi-Master déterministe : deux plans concurrents → le
 *    startPlanId lexicographiquement LE PLUS GRAND gagne (fonction pure du plan,
 *    donc même verdict sur tous les devices, sans confiance horloge croisée) ;
 *    le perdant abandonne son countdown (START_PLAN_SUPERSEDED).
 *  - Idempotence : déduplication par deviceId + startPlanId (plan, état, exécution).
 *  - Countdown dérivé du temps restant (jamais un setInterval indépendant) :
 *    chiffre = ceil(restant / 1000) borné [1..countdownSeconds] → 5→4→3→2→1,
 *    JAMAIS 0. Countdown 0 s → ÉCRAN 07 ENTIÈREMENT SAUTÉ (targetStart =
 *    now + MIN_DISPATCH_LEAD_MS, le délai structurel de propagation du plan,
 *    constante nommée et journalisée — jamais un délai caché).
 *  - Exclusion / réintégration : une Capture ERROR ou indisponible avant le top
 *    quitte le countdown (erreur locale + cause, aucun bouton) et le signale
 *    (CAPTURE_EXCLUDED) ; si elle redevient prête AVANT le top elle réintègre
 *    automatiquement (CAPTURE_REINTEGRATED). Le rendu Master reste SILENCIEUX.
 *    L'exclusion « offset_inconnu » n'est JAMAIS réintégrable : sans offset
 *    mesuré, aucun top physique honnête n'est possible.
 *  - Zéro Capture démarrable avant le top → annulation AUTOMATIQUE globale
 *    (START_CANCEL reason=no_startable_capture) + retour ARM.
 *  - Seuls les Masters peuvent annuler (n'importe lequel) ; l'annulation est un
 *    MESSAGE, donc un device sans Master ne peut pas perdre son plan. Valable
 *    JUSQU'AU TOP : après le top le départ est engagé (START_CANCEL_IGNORE
 *    reason=already_started) — l'arrêt coordonné est le protocole J09/J10.
 *  - STOP local d'urgence (post-top, aucun Master connecté) : confirmation
 *    obligatoire, n'arrête QUE la Capture locale, place la Capture en STOPPED
 *    local et interdit tout redémarrage dans le MÊME Take.
 *  - STOP global coordonné (J10) : réservé aux Masters (tous égaux, §30.9).
 *    Le Master verrouille un instant cible ABSOLU targetStopMs dans SON horloge
 *    (now + STOP_LEAD_MS), le diffuse avec les MÊMES offsets J07 que le plan
 *    (stop_request), chaque Capture l'exécute à SON top local
 *    (localTargetStop = targetStop + offset) et publie un stop_state
 *    (STOPPED, deltaMs, path). Idempotence par stopId (un seul STOP par plan),
 *    AUCUN compte à rebours visible, session OUVERTE après STOP. Sans stop_state
 *    avant targetStop + STOP_ACK_TIMEOUT_MS, le Master marque la Capture en
 *    INCIDENT (levé par un stop_state tardif ou par la reconnexion du device).
 *    Un device déjà STOPPED qui reçoit un stop_request pour ce Take répond par
 *    un stop_state idempotent (late ack) — jamais un redémarrage.
 *  - UN SEUL START local par Take et par device : un plan concurrent pour un
 *    Take déjà démarré localement est REFUSÉ (START_PLAN_DROP
 *    reason=local_already_started) — c'est la barrière anti-double-REC.
 *  - START local : log START_LOCAL à l'instant exact du top (delta vs top local),
 *    puis exécution de l'action d'enregistrement réelle (dépendance) et
 *    START_NATIVE_ACK à l'accusé natif (deux mesures par device, aucune
 *    simulation : l'ack natif n'est jamais rebaptisé « top »).
 *
 * Journalisation parsable via deps.log (liste EXHAUSTIVE, format
 * `<EVENT> deviceId=… startPlanId=… take=… key=value`) :
 *   START_PLAN_CREATED, START_PLAN_ACCEPTED, START_PLAN_DUPLICATE,
 *   START_PLAN_SUPERSEDED, START_PLAN_REPLACED, START_PLAN_DROP, START_PLAN_ERROR,
 *   START_PLAN_ABORTED, START_PLAN_COMPLETE, START_REQUEST, START_REJECTED,
 *   START_ACCEPTED, START_STATE, COUNTDOWN_STATE, CAPTURE_EXCLUDED,
 *   CAPTURE_REINTEGRATED, START_LOCAL, START_LOCAL_ERROR, START_NATIVE_ACK,
 *   START_CANCEL, START_CANCEL_REJECT, START_CANCEL_IGNORE, START_STOP_LOCAL,
 *   START_CLOCK_FRESHNESS, START_MASTER_LOST, START_PROBE, START_PROBE_IGNORE,
 *   START_PROBE_UNKNOWN,
 *  et J10 (STOP coordonné) : STOP_REQUEST (format exigé par le plan :
 *  sessionId / take), STOP_REQUEST_IGNORE, STOP_REQUEST_ACCEPTED, STOP_STATE,
 *  STOP_LOCAL (format exigé par le plan : sessionId / take / actual), STOP_ACK,
 *  STOP_INCIDENT, STOP_RECONNECTED, STOP_STATE_REPUBLISH, STOP_LOCAL_ERROR.
 *
 * Frontière de responsabilité : la PRÉPARATION caméra (démarrage du preview
 * natif exigé par CameraPreview.startRecordVideo) et l'arrêt de cette préparation
 * appartiennent au service (start-service) : le modèle reste pur et se contente
 * de sonder deps.captureReady(session, take) pendant le countdown.
 */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(root);
  } else {
    root.MultiCamStartModel = factory(root);
  }
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  /* ---------- constantes J08 ---------- */

  var TICK_MS = 200;                 /* rafraîchissement d'affichage / surveillance */
  var MIN_DISPATCH_LEAD_MS = 300;    /* countdown = 0 s : délai STRUCTUREL de propagation */
  var PROBE_TIMEOUT_MS = 600;        /* résolution d'offset d'un Master non participant */
  var CLOCK_FRESH_MAX_AGE_MS = 12000;/* fraîcheur J07 exigée pour verrouiller targetStart */
  var EARLY_TOLERANCE_MS = 2;        /* ré-armement si le timer JS sonne trop tôt */
  var STOP_LEAD_MS = 500;            /* J10 : délai STRUCTUREL entre stop_request et targetStopMs */
  var STOP_ACK_TIMEOUT_MS = 3000;    /* J10 : incident si pas de stop_state avant target + ce délai */
  var STARTABLE = { READY: true, WARNING: true };
  var PHASE_IDLE = "IDLE";
  var PHASE_COUNTDOWN = "COUNTDOWN";
  var PHASE_REC = "REC";
  var PHASE_STOPPED = "STOPPED";
  var PHASE_EXCLUDED = "EXCLUDED";   /* exclusion figée (top passé ou offset inconnu) */
  var STATE_ACCEPTED = "ACCEPTED";
  var STATE_EXCLUDED = "EXCLUDED";
  var STATE_REINTEGRATED = "REINTEGRATED";
  var STATE_STARTED = "STARTED";
  var STATE_FAILED = "FAILED";
  var STATE_STOPPED = "STOPPED";

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  /* ---------- identité de plan ---------- */

  /* startPlanId = armCycleId + "#" + seq (séquence locale du créateur, ≥1).
   * armCycleId encodes déjà session#take#tentative : un plan est donc unique par
   * (session, take, cycle ARM, rang) et l'arbitrage lexicographique est total. */
  function planId(armCycleId, seq) {
    return String(armCycleId) + "#" + String(seq);
  }

  function isPlanFmt(id) {
    if (typeof id !== "string" || !id) return false;
    var parts = id.split("#");
    if (parts.length !== 4) return false;
    if (!/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3])) return false;
    return parts[0].length > 0;
  }

  /* Comparaison TOTAL et déterministe de deux startPlanId, par SEGMENTS :
   * sessionId (texte) puis take, cycle et rang en NUMÉRIQUE.
   * Une comparaison purement lexicographique serait FAUSSE : "#10" < "#2"
   * ferait alors gagner un plan plus ancien à un plan plus récent. L'ordre
   * retenu est monotone dans l'ordre de création (take/cycle/rang croissants),
   * donc le plan le plus RÉCENT gagne toujours — sans horloge croisée. */
  function comparePlanId(a, b) {
    if (a === b) return 0;
    var pa = String(a).split("#");
    var pb = String(b).split("#");
    if (pa.length !== pb.length) return pa.length - pb.length;
    for (var i = 0; i < pa.length; i++) {
      var na = /^\d+$/.test(pa[i]);
      var nb = /^\d+$/.test(pb[i]);
      if (na && nb) {
        var d = Number(pa[i]) - Number(pb[i]);
        if (d) return d < 0 ? -1 : 1;
      } else if (pa[i] !== pb[i]) {
        return pa[i] < pb[i] ? -1 : 1;
      }
    }
    return 0;
  }

  /* Verdict pur et TOTAL sur deux plans concurrents : le plus grand identifiant
   * gagne. Aucune horloge croisée, aucun état local → même résultat partout. */
  function choosePlanId(a, b) {
    if (!a) return b;
    if (!b) return a;
    return comparePlanId(a, b) > 0 ? a : b;
  }

  /* ---------- temps (pur) ---------- */

  /* Formule NTP de J07 (arm-model.offsetOf) : Pair − Local, positif = le pair
   * est en avance. Consommée par onIncoming, qui la NEGÉE pour aligner le
   * modèle sur la convention « Local − Créateur » du plan. */
  function probeOffset(t0, t1, t2, t3) { return ((t1 - t0) + (t2 - t3)) / 2; }

  /* Top local = instant cible ABSOLU exprimé dans L'horloge de CE device :
   * localTop = targetStart (horloge du créateur) + (C_local − C_createur). */
  function localTopMs(plan, offsetMs) {
    if (!plan || !isNum(plan.targetStartMs)) return null;
    return plan.targetStartMs + (isNum(offsetMs) ? offsetMs : 0);
  }

  /* Chiffre affiché : ceil(restant/1000) borné à [1..max] — jamais 0. */
  function digitFor(remainingMs, maxSeconds) {
    if (!isNum(remainingMs) || remainingMs <= 0) return 0;
    var d = Math.ceil(remainingMs / 1000);
    if (d < 1) d = 1;
    if (isNum(maxSeconds) && d > maxSeconds) d = maxSeconds;
    return d;
  }

  function fmtClock(ms) {
    if (!isNum(ms)) return "—";
    var d = new Date(ms);
    function p(n, w) { return String(n).padStart ? String(n).padStart(w || 2, "0") : ("0" + n).slice(-(w || 2)); }
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) + "." + p(d.getMilliseconds(), 3);
  }

  /* ---------- machine déterministe ---------- */

  /* deps = {
   *   nowMs(): number,
   *   schedule(fn, ms): token, clearSchedule(token): void,
   *   loadSession(sid): Promise<session|undefined>,
   *   selfDid(): string,
   *   isConnected(did): bool,
   *   isMasterRole(did, session): bool,          // sessionRoles
   *   captureRole(did, session): bool,
   *   storageRole(did, session): bool,
   *   lastTake(session): object,
   *   armView(): object|null,                     // vue J07 du leader (éligibilité)
   *   armClockOffsets(): { did: {offsetMs, ageMs} },
   *   refreshArmClock(): Promise<void>,            // re-solve J07 avant verrouillage
   *   countdownSecondsOf(take): number,
   *   captureReady(session, plan): {ok, message},  // readiness locale au top
   *   startRecording(req): Promise<{atMs, detail}>,
   *   stopRecording(): Promise<{atMs, detail}>,
   *   connectedMasters(sid): [deviceId],
*   sendStartPlan(session, plan), sendStartCancel(session, msg),
 *   sendStartState(session, msg), sendStartProbe(session, msg),
 *   sendStopRequest(session, txn), sendStopState(session, stop_state),
 *   peerConnected(did): bool,       // J10 : vivacité (incident levé à la reconnexion)
 *   log(line): void, onChange?(): void
   * } */
  function createMachine(deps) {
    var now = deps.nowMs || function () { return 0; };
    var sched = deps.schedule || function () { return null; };
    var clearSched = deps.clearSchedule || function () {};
    var self = deps.selfDid || function () { return ""; };
    var log = deps.log || function () {};

    var state = {
      sid: null,
      plan: null,
      planId: null,
      seq: 0,
      leader: false,
      isMaster: false,
      isCapture: false,
      isStorage: false,
      phase: PHASE_IDLE,
      offsetMs: 0,
      offsetKnown: false,
      localTopMs: null,
      remainingMs: null,
      digit: 0,
      showCountdown: false,
      excluded: false,
      excludeMessage: "",
      excludeKind: "",            /* "readiness" (réintégrable) | "offset" (définitif) */
      peers: {},                 /* did -> { state, message } */
      seenStates: {},            /* "did|planId|state" -> true (idempotence) */
      topFired: false,
      planCompleteLogged: false,
      recStartedAtMs: 0,
      recElapsedMs: 0,
      lastStart: null,           /* { actualMs, deltaMs, status, ackMs, ackDeltaMs } */
      localStartedTakes: {},     /* takeNumber -> true (UN seul START local par Take) */
      localStoppedTakes: {},     /* takeNumber -> true (STOP local, pas de redémarrage) */
      stoppedTakeNumber: 0,      /* Take du STOP local en cours (affichage) */
      noMasterSinceMs: 0,
      masterLostLogged: false,
      showEmergencyStop: false,
      /* ---------- J10 : STOP coordonné ---------- */
      stop: null,                 /* transaction STOP active : stopId, targetStopMs, offsets… */
      stopLocalTargetMs: null,    /* top local d'arrêt (targetStopMs + offset local) */
      stopError: "",
      stopStates: {},             /* did -> stop_state reçu (STOPPED, deltaMs, path, actualMs) */
      seenStopStates: {},         /* "did|stopId" -> true (idempotence des stop_state) */
      seenStops: {},              /* stopId -> true (idempotence des stop_request) */
      stopIncidents: {},          /* did -> true (pas de stop_state avant le timeout d'ack) */
      stopExecuted: false,
      stopTimer: null,
      stopAckTimer: null,
      localStopInfo: null,        /* résultat du STOP local / coordonné (républ. idempotente) */
      tickTimer: null,
      topTimer: null,
      probeTimer: null,
      pendingProbe: null,
      rev: 0
    };

    var bump = function () {
      state.rev++;
      if (deps.onChange) deps.onChange();
    };

    var selfIsParticipantCapture = function (plan) {
      if (!plan || !Array.isArray(plan.participants)) return false;
      for (var i = 0; i < plan.participants.length; i++) {
        if (plan.participants[i] && plan.participants[i].deviceId === self() && plan.participants[i].role === "capture") return true;
      }
      return false;
    };

    var sessionName = function () {
      if (state.plan && typeof state.plan.sessionName === "string") return state.plan.sessionName;
      return "";
    };

    var startablePeerCaptures = function (plan) {
      var out = [];
      if (!plan || !Array.isArray(plan.participants)) return out;
      plan.participants.forEach(function (p) {
        if (!p || p.role !== "capture") return;
        if (state.localStoppedTakes[p.takeNumber || (plan && plan.takeNumber)] === true) return;
        var st = (p.deviceId === self())
          ? (state.excluded ? STATE_EXCLUDED : STATE_ACCEPTED)
          : ((state.peers[p.deviceId] || {}).state || STATE_ACCEPTED);
        if (st === STATE_EXCLUDED || st === STATE_FAILED) return;
        out.push(p.deviceId);
      });
      return out;
    };

    var clearTimers = function () {
      if (state.tickTimer) { clearSched(state.tickTimer); state.tickTimer = null; }
      if (state.topTimer) { clearSched(state.topTimer); state.topTimer = null; }
      if (state.probeTimer) { clearSched(state.probeTimer); state.probeTimer = null; }
      if (state.stopTimer) { clearSched(state.stopTimer); state.stopTimer = null; }
      if (state.stopAckTimer) { clearSched(state.stopAckTimer); state.stopAckTimer = null; }
    };

    var peerCountMsg = function () {
      var n = 0;
      Object.keys(state.peers).forEach(function (k) { if (state.peers[k] && state.peers[k].state) n++; });
      return n;
    };

    /* START_PLAN_COMPLETE : UN SEUL tir par plan (jamais un log par tick). */
    var logPlanComplete = function (reason) {
      if (!state.plan || state.planCompleteLogged) return;
      state.planCompleteLogged = true;
      log("START_PLAN_COMPLETE deviceId=" + self() + " startPlanId=" + state.planId
        + " take=" + state.plan.takeNumber + " reason=" + reason
        + " peers=" + peerCountMsg());
    };

    /* ---------- affichage : projection dans le temps (tick) ---------- */

    var scheduleTick = function () {
      if (state.tickTimer) { clearSched(state.tickTimer); state.tickTimer = null; }
      state.tickTimer = sched(tick, TICK_MS);
    };

    var scheduleTopTimer = function () {
      if (state.topTimer) { clearSched(state.topTimer); state.topTimer = null; }
      if (state.localTopMs == null) return;
      var rem = state.localTopMs - now();
      state.topTimer = sched(onTopTimer, Math.max(0, rem));
    };

    var onTopTimer = function () {
      state.topTimer = null;
      if (state.phase !== PHASE_COUNTDOWN || !state.plan || state.topFired) return;
      var rem = (state.localTopMs == null) ? 0 : (state.localTopMs - now());
      if (rem > EARLY_TOLERANCE_MS) { scheduleTopTimer(); return; }
      fireTop();
    };

    var tick = function () {
      state.tickTimer = null;
      /* J08 / D1 : le tick est le SEUL rythme qui fait vivre le temps à l'écran
       * (chiffre du countdown, puis timer REC). Il doit donc prévenir le
       * subscriber — c'est `bump()` qui appelle deps.onChange(), relayé par
       * start-service jusqu'à main.js:onStartView() qui redessine. Sans ce
       * bump(), l'état descendait correctement (COUNTDOWN_STATE journalisé) mais
       * #cdDigitMaster restait figé sur le premier chiffre.
       *
       * On ne notifie que ce qui CHANGE : une fois par changement de chiffre,
       * et pendant le REC une fois par tick (recElapsedMs est une horloge
       * continue). Rien hors COUNTDOWN/REC — un tick n'y est d'ailleurs jamais
       * reprogrammé. Le modèle reste la source unique du temps : aucun timer
       * d'interface n'est ajouté, le rythme reste TICK_MS. */
      var notify = false;
      if (state.phase === PHASE_COUNTDOWN && state.plan && !state.topFired) {
        state.remainingMs = (state.localTopMs == null) ? null : (state.localTopMs - now());
        var d = digitFor(state.remainingMs, state.plan.countdownSeconds);
        if (d > 0 && d !== state.digit) {
          state.digit = d;
          notify = true;
          log("COUNTDOWN_STATE deviceId=" + self() + " startPlanId=" + state.planId
            + " take=" + state.plan.takeNumber + " digit=" + d
            + " remainingMs=" + Math.round(state.remainingMs));
        }
        /* auto-annulation (leader) : plus aucune Capture démarrable avant le top */
        if (state.leader) autoCancelIfNone();
        /* readiness locale de la Capture (caméra/native) : exclusion OU
         * réintégration, AVANT le top uniquement. */
        if (state.isCapture) refreshLocalReadiness();
        /* filet de sécurité : le top n'a jamais été tiré (timer perdu) */
        if (state.remainingMs != null && state.remainingMs <= -2000) {
          logPlanComplete("stale_timer_no_start");
          abortPlan("stale_timer_no_start", false);
        }
      } else if (state.phase === PHASE_REC && state.recStartedAtMs) {
        var elapsedBefore = state.recElapsedMs;
        state.recElapsedMs = now() - state.recStartedAtMs;
        if (state.recElapsedMs !== elapsedBefore) notify = true;
        state.showEmergencyStop = state.isCapture && connectedMasters().length === 0;
      } else if (state.phase === PHASE_STOPPED && state.stop) {
        /* fenêtre ack encore couverte : un pair reconnecté sort de l'incident
         * sans que son stop_state ne soit nécessairement re-spédié. */
        if (clearReconnectedIncidents()) notify = true;
      }
      /* perte de TOUS les Masters : journalisée une fois, le plan local survit
       * (J08 : le départ est déjà programmé, rien ne l'annule implicitement). */
      if (state.plan && (state.phase === PHASE_COUNTDOWN || state.phase === PHASE_REC)
        && !state.masterLostLogged && connectedMasters().length === 0) {
        state.masterLostLogged = true;
        log("START_MASTER_LOST deviceId=" + self() + " startPlanId=" + state.planId
          + " take=" + state.plan.takeNumber + " phase=" + state.phase
          + " remainingMs=" + (state.remainingMs == null ? "—" : Math.round(state.remainingMs))
          + " countdownContinues=1");
      }
      if (notify) bump();
      if (state.phase === PHASE_COUNTDOWN || state.phase === PHASE_REC
        || (state.phase === PHASE_STOPPED && stopAckWindowOpen())) scheduleTick();
    };

    function connectedMasters() {
      if (!deps.connectedMasters) return [];
      var arr = deps.connectedMasters(state.sid) || [];
      return arr.filter(function (d) { return d !== self(); });
    }

    /* ---------- J10 : fenêtre d'acquittement du STOP ----------
     *
     * `stopAckWindowOpen()` borne la surveillance après un STOP coordonné : la
     * Capture est toujours en train d'exécuter son top d'arrêt. Tant qu'elle
     * dure, le tick reste programmé même en phase STOPPED (c'est sa seule
     * exception au « plus de tick après le top »).
     * `clearReconnectedIncidents()` honore la règle de la maquette (§6) : une
     * Capture qui ne confirme pas son STOP reste marquée « incident » jusqu'à
     * son STOP tardif OU sa reconnexion. Une reconnexion constatée lève
     * l'incident sans jamais tenter un redémarrage. */
    function stopAckWindowOpen() {
      var t = state.stop;
      if (!t) return false;
      /* La fenêtre reste ouverte tant qu'un incident n'est pas résolu : c'est
       * le seul tick qui « veille » sur le retour d'une Capture. Sinon, un
       * incident né à l'échéance exacte (`now >= targetStop + timeout`) ne
       * pourrait JAMAIS être levé par reconnexion — aucun tick ne
       * s'exécuterait après. La surveillance s'arrête donc d'elle-même dès
       * que plus aucun incident ne subsiste (ou à la fin du plan). */
      if (Object.keys(state.stopIncidents).length > 0) return true;
      return now() < t.targetStopMs + STOP_ACK_TIMEOUT_MS;
    }

    var clearReconnectedIncidents = function () {
      var changed = false;
      Object.keys(state.stopIncidents).forEach(function (did) {
        if (state.stopStates[did]) { delete state.stopIncidents[did]; changed = true; return; }
        if (deps.peerConnected && deps.peerConnected(did)) {
          delete state.stopIncidents[did];
          changed = true;
          log("STOP_RECONNECTED deviceId=" + self()
            + " stopId=" + String(state.stop && state.stop.stopId)
            + " peer=" + did + " note=incident_leve");
        }
      });
      return changed;
    };

    var autoCancelIfNone = function () {
      if (!state.plan || state.topFired) return;
      var startable = startablePeerCaptures(state.plan);
      if (startable.length) return;
      log("START_CANCEL sessionId=" + state.sid + " startPlanId=" + state.planId
        + " take=" + state.plan.takeNumber + " by=" + self() + " reason=no_startable_capture");
      abortPlan("no_startable_capture", true);
    };

    /* ---------- adoption d'un plan ---------- */

    var resolveOffset = function (plan, cb) {
      var off = plan.clockOffsets || {};
      if (isNum(off[self()])) {
        state.offsetMs = off[self()];
        state.offsetKnown = true;
        return cb();
      }
      if (plan.createdByDeviceId === self()) {
        /* Le créateur du plan EST la référence : offset 0 par construction
         * (convention J07 : la référence locale a un delta de 0). */
        state.offsetMs = 0;
        state.offsetKnown = true;
        return cb();
      }
      /* Master non participant (ou Capture non mesurée) : une sonde NTP courte
       * vers le créateur, bornée. Échec → countdown dégradé MAIS honnête
       * (START_PROBE_UNKNOWN) : le device n'exécute alors AUCUN top physique. */
      if (!deps.sendStartProbe) {
        state.offsetMs = 0;
        state.offsetKnown = false;
        return cb();
      }
      state.pendingProbe = { seq: (state.pendingProbe ? state.pendingProbe.seq + 1 : 1), t0: now() };
      var p = state.pendingProbe;
      deps.sendStartProbe(state.sid, { startPlanId: plan.startPlanId, requestId: p.seq, target: plan.createdByDeviceId });
      state.probeTimer = sched(function () {
        state.probeTimer = null;
        if (state.pendingProbe !== p || state.planId !== plan.startPlanId) return;
        state.pendingProbe = null;
        state.offsetMs = 0;
        state.offsetKnown = false;
        log("START_PROBE_UNKNOWN deviceId=" + self() + " startPlanId=" + plan.startPlanId
          + " target=" + plan.createdByDeviceId + " timeoutMs=" + PROBE_TIMEOUT_MS);
        cb();
      }, PROBE_TIMEOUT_MS);
    };

    var adoptPlan = function (plan, opts) {
      opts = opts || {};
      if (!plan || !isPlanFmt(plan.startPlanId) || !isNum(plan.targetStartMs)) {
        log("START_PLAN_DROP reason=malformed planId=" + (plan && plan.startPlanId));
        return;
      }
      if (state.planId === plan.startPlanId) {
        log("START_PLAN_DUPLICATE deviceId=" + self() + " startPlanId=" + plan.startPlanId);
        return;
      }
      if (state.localStartedTakes[plan.takeNumber] === true) {
        /* Ce device a DÉJÀ démarré l'enregistrement de ce Take : il ne peut
         * surtout pas suivre un autre plan pour le même Take (sinon double
         * REC). Un plan pour un autre Take reste accepté. */
        log("START_PLAN_DROP deviceId=" + self() + " startPlanId=" + plan.startPlanId
          + " take=" + plan.takeNumber + " reason=local_already_started");
        return;
      }
      if (state.planId && choosePlanId(plan.startPlanId, state.planId) === state.planId) {
        log("START_PLAN_SUPERSEDED deviceId=" + self() + " startPlanId=" + plan.startPlanId
          + " kept=" + state.planId);
        return;
      }
      if (state.planId) {
        log("START_PLAN_REPLACED deviceId=" + self() + " old=" + state.planId + " new=" + plan.startPlanId);
        clearTimers();
      }
      state.sid = plan.sessionId;
      state.plan = plan;
      state.planId = plan.startPlanId;
      state.leader = plan.createdByDeviceId === self();
      state.isMaster = !!opts.isMaster;
      state.isCapture = selfIsParticipantCapture(plan);
      state.isStorage = !!opts.isStorage;
      state.phase = PHASE_COUNTDOWN;
      state.topFired = false;
      state.digit = 0;
      state.remainingMs = null;
      state.recStartedAtMs = 0;
      state.recElapsedMs = 0;
      state.lastStart = null;
      state.excluded = false;
      state.excludeMessage = "";
      state.excludeKind = "";
      state.showCountdown = plan.countdownSeconds > 0;
      state.peers = {};
      state.seenStates = {};
      state.planCompleteLogged = false;
      state.masterLostLogged = false;
      /* J10 : tout plan (futur) part sans STOP résiduel. Un nouveau Take peut
       * ainsi remplacer un plan STOPPED et repartir de zéro. */
      state.stop = null;
      state.stopLocalTargetMs = null;
      state.stopError = "";
      state.stopStates = {};
      state.seenStopStates = {};
      state.seenStops = {};
      state.stopIncidents = {};
      state.stopExecuted = false;
      state.localStopInfo = null;
      log("START_PLAN_ACCEPTED deviceId=" + self() + " startPlanId=" + plan.startPlanId
        + " sessionId=" + plan.sessionId + " take=" + plan.takeNumber
        + " leader=" + (state.leader ? 1 : 0) + " countdown=" + plan.countdownSeconds
        + " target=" + fmtClock(plan.targetStartMs));

      resolveOffset(plan, function () {
        if (state.planId !== plan.startPlanId) return;
        planClockReady();
      });
      bump();
    };

    /* Point UNIQUE d'entrée en countdown une fois l'horloge résolue (offset
     * fourni par le plan, référence locale, ou sonde NTP réussie / échouée) :
     * calcule le top local, projette le premier chiffre, arme tick + top.
     * Un device participant ne démarre JAMAIS un top sans offset connu
     * (dégradé = honnête, jamais un faux ±50 ms). */
    var planClockReady = function () {
      if (state.phase !== PHASE_COUNTDOWN || !state.plan) return;
      var plan = state.plan;
      state.localTopMs = localTopMs(plan, state.offsetMs);
      state.remainingMs = (state.localTopMs == null) ? null : (state.localTopMs - now());
      if (plan.countdownSeconds > 0) {
        var d0 = digitFor(state.remainingMs, plan.countdownSeconds);
        if (d0 > 0 && d0 !== state.digit) {
          state.digit = d0;
          log("COUNTDOWN_STATE deviceId=" + self() + " startPlanId=" + state.planId
            + " take=" + plan.takeNumber + " digit=" + d0
            + " remainingMs=" + Math.round(state.remainingMs));
        }
      }
      if (state.isCapture && !state.offsetKnown) {
        excludeSelf("offset_inconnu", "offset");
      } else {
        if (state.localTopMs != null) scheduleTopTimer();
        if (state.isCapture) {
          log("START_ACCEPTED deviceId=" + self() + " startPlanId=" + state.planId
            + " take=" + plan.takeNumber + " offsetMs=" + Math.round(state.offsetMs)
            + " offsetKnown=" + (state.offsetKnown ? 1 : 0)
            + " localTop=" + fmtClock(state.localTopMs) + " countdown=" + plan.countdownSeconds);
          publishState(STATE_ACCEPTED, "");
        }
      }
      scheduleTick();
      bump();
    };

    /* ---------- exclusion / réintégration ---------- */

    var excludeSelf = function (message, kind) {
      if (state.phase !== PHASE_COUNTDOWN || !state.plan) return;
      if (state.excluded) return;
      state.excluded = true;
      state.excludeMessage = message || "indisponible";
      state.excludeKind = kind || "readiness";
      /* Le timer de top RESTE armé : (a) une Capture exclue peut encore
       * réintégrer avant le top, (b) au top elle journalise START_LOCAL
       * status=SKIPPED (preuve qu'elle n'a pas démarré) puis
       * START_PLAN_COMPLETE reason=excluded. */
      log("CAPTURE_EXCLUDED deviceId=" + self() + " startPlanId=" + state.planId
        + " take=" + state.plan.takeNumber + " kind=" + state.excludeKind
        + " reason=" + state.excludeMessage
        + " remainingMs=" + (state.remainingMs == null ? "—" : Math.round(state.remainingMs)));
      publishState(STATE_EXCLUDED, state.excludeMessage);
      bump();
    };

    var reintegrateSelf = function (message) {
      if (state.phase !== PHASE_COUNTDOWN || !state.plan) return;
      if (!state.excluded) return;
      if (state.excludeKind === "offset") return;         /* définitif : jamais de faux top */
      if (state.localTopMs == null || now() >= state.localTopMs) return; /* top déjà passé */
      state.excluded = false;
      state.excludeMessage = "";
      state.excludeKind = "";
      state.localTopMs = localTopMs(state.plan, state.offsetMs);
      state.remainingMs = state.localTopMs - now();
      if (state.localTopMs != null) scheduleTopTimer();
      log("CAPTURE_REINTEGRATED deviceId=" + self() + " startPlanId=" + state.planId
        + " take=" + state.plan.takeNumber + " remainingMs=" + Math.round(state.remainingMs)
        + (message ? " note=" + message : ""));
      publishState(STATE_REINTEGRATED, message || "");
      bump();
    };

    /* État d'un pair : dédupliqué par deviceId + startPlanId + state. */
    var applyPeerState = function (msg) {
      if (!state.plan || msg.startPlanId !== state.planId) return false;
      if (!msg.deviceId || msg.deviceId === self()) return false;
      var key = msg.deviceId + "|" + msg.startPlanId + "|" + msg.state;
      if (state.seenStates[key]) return false;
      state.seenStates[key] = true;
      var prev = (state.peers[msg.deviceId] || {}).state || "";
      state.peers[msg.deviceId] = { state: msg.state, message: msg.message || "" };
      log("START_STATE deviceId=" + self() + " startPlanId=" + state.planId
        + " peer=" + msg.deviceId + " state=" + msg.state
        + (prev ? " from=" + prev : "") + (msg.message ? " message=" + msg.message : ""));
      if (state.leader && state.phase === PHASE_COUNTDOWN) autoCancelIfNone();
      bump();
      return true;
    };

    var publishState = function (st, message) {
      if (!state.plan || !deps.sendStartState) return;
      deps.sendStartState(state.sid, {
        startPlanId: state.planId,
        takeNumber: state.plan.takeNumber,
        deviceId: self(),
        state: st,
        message: message || ""
      });
    };

    /* ---------- top ---------- */

    var fireTop = function () {
      if (state.topFired || !state.plan) return;
      state.topFired = true;
      if (state.topTimer) { clearSched(state.topTimer); state.topTimer = null; }
      if (state.excluded) {
        /* Une Capture exclue ne démarre RIEN et ne peut plus réintégrer : son
         * countdown est clos, l'erreur locale reste affichée. */
        state.phase = PHASE_EXCLUDED;
        state.digit = 0;
        state.showEmergencyStop = false;
        log("START_LOCAL deviceId=" + self() + " startPlanId=" + state.planId
          + " target=" + fmtClock(state.localTopMs) + " actual=" + fmtClock(now())
          + " status=SKIPPED reason=" + (state.excludeMessage || "excluded"));
        logPlanComplete("excluded");
        bump();
        return;
      }
      var actualMs = now();
      var deltaMs = actualMs - (state.localTopMs == null ? actualMs : state.localTopMs);
      state.localStartedTakes[state.plan.takeNumber] = true;
      state.phase = PHASE_REC;
      state.recStartedAtMs = actualMs;
      state.recElapsedMs = 0;
      state.lastStart = { actualMs: actualMs, deltaMs: deltaMs, status: "OK", ackMs: null, ackDeltaMs: null };
      state.digit = 0;
      if (!state.isCapture) {
        /* Un Master non participant n'a aucun media à démarrer : il ne peut donc
         * PAS annoncer un START_LOCAL « OK » (jamais de faux top physique). */
        state.lastStart.status = "OBSERVER";
        log("START_LOCAL deviceId=" + self() + " startPlanId=" + state.planId
          + " target=" + fmtClock(state.localTopMs) + " actual=" + fmtClock(actualMs)
          + " deltaMs=" + Math.round(deltaMs) + " status=OBSERVER note=no_capture");
        logPlanComplete("started_observer");
        bump();
        return;
      }
      log("START_LOCAL deviceId=" + self() + " startPlanId=" + state.planId
        + " take=" + state.plan.takeNumber + " target=" + fmtClock(state.localTopMs)
        + " actual=" + fmtClock(actualMs) + " deltaMs=" + Math.round(deltaMs)
        + " countdown=" + state.plan.countdownSeconds + " status=OK");
      logPlanComplete("started");
      if (!deps.startRecording) {
        log("START_LOCAL_ERROR deviceId=" + self() + " startPlanId=" + state.planId + " reason=no_recorder");
        state.lastStart.status = "ERROR";
        publishState(STATE_FAILED, "no_recorder");
        bump();
        return;
      }
      /* L'ack natif peut arriver APRÈS l'abandon du plan (annulation,
       * remplacement de plan, STOP local) : il est alors orphelin. On le
       * journalise sans jamais réécrire l'état d'un plan qui n'est plus le
       * sien — et sans laisser une exception remonter dans le WebView. */
      var topPlanId = state.planId;
      var topTakeNumber = state.plan.takeNumber;
      var topTargetMs = state.localTopMs;
      Promise.resolve(deps.startRecording({
        startPlanId: topPlanId,
        takeNumber: topTakeNumber,
        sessionId: state.plan.sessionId,
        localTargetMs: topTargetMs,
        profile: state.plan.profile || null
      })).then(function (res) {
        var ackMs = (res && isNum(res.atMs)) ? res.atMs : now();
        var ackDeltaMs = ackMs - (topTargetMs == null ? ackMs : topTargetMs);
        if (state.planId !== topPlanId || !state.lastStart) {
          log("START_NATIVE_ACK deviceId=" + self() + " startPlanId=" + topPlanId
            + " take=" + topTakeNumber + " ack=" + fmtClock(ackMs)
            + " deltaMs=" + Math.round(ackDeltaMs) + " planAbandoned=1");
          return;
        }
        state.lastStart.ackMs = ackMs;
        state.lastStart.ackDeltaMs = ackDeltaMs;
        log("START_NATIVE_ACK deviceId=" + self() + " startPlanId=" + topPlanId
          + " take=" + topTakeNumber + " ack=" + fmtClock(ackMs)
          + " deltaMs=" + Math.round(ackDeltaMs)
          + (res && res.detail ? " detail=" + res.detail : ""));
        publishState(STATE_STARTED, "");
        bump();
      }).catch(function (err) {
        if (state.planId !== topPlanId || !state.lastStart) {
          log("START_LOCAL_ERROR deviceId=" + self() + " startPlanId=" + topPlanId
            + " take=" + topTakeNumber
            + " err=" + String((err && err.message) || err) + " planAbandoned=1");
          return;
        }
        state.lastStart.status = "ERROR";
        log("START_LOCAL_ERROR deviceId=" + self() + " startPlanId=" + topPlanId
          + " take=" + topTakeNumber + " err=" + String((err && err.message) || err));
        publishState(STATE_FAILED, String((err && err.message) || err));
        bump();
      });
      bump();
    };

    /* ---------- annulation ---------- */

    var abortPlan = function (reason, broadcast, keepPhase) {
      if (!state.plan) return;
      var plan = state.plan;
      clearTimers();
      state.pendingProbe = null;
      if (broadcast && deps.sendStartCancel) {
        deps.sendStartCancel(state.sid, {
          startPlanId: state.planId,
          byDeviceId: self(),
          reason: reason
        });
      }
      log("START_PLAN_ABORTED deviceId=" + self() + " startPlanId=" + state.planId
        + " take=" + plan.takeNumber + " reason=" + reason);
      state.plan = null;
      state.planId = null;
      state.leader = false;
      state.phase = keepPhase === true ? PHASE_STOPPED : PHASE_IDLE;
      state.localTopMs = null;
      state.remainingMs = null;
      state.digit = 0;
      state.showCountdown = false;
      state.excluded = false;
      state.excludeMessage = "";
      state.excludeKind = "";
      state.peers = {};
      state.seenStates = {};
      state.offsetMs = 0;
      state.offsetKnown = false;
      state.topFired = false;
      state.planCompleteLogged = false;
      state.showEmergencyStop = false;
      /* J10 : un plan abandonné (annulation, remplacement) n'emporte aucun STOP
       * résiduel ; pour un arrêt propre, la phase reste STOPPED (keepPhase). */
      state.stop = null;
      state.stopLocalTargetMs = null;
      state.stopError = "";
      state.stopStates = {};
      state.seenStopStates = {};
      state.seenStops = {};
      state.stopIncidents = {};
      state.stopExecuted = false;
      state.localStopInfo = null;
      bump();
    };

    /* ---------- J10 : STOP coordonné ----------
     *
     * Un STOP global (maquette ui/08 §4) est un MESSAGE, comme le cancel : il
     * ne dépend d'aucun état local, donc un device qui ne l'a pas reçu n'est
     * jamais bloqué dans son enregistrement par un Master absent. Tous les
     * Masters sont égaux (§30.9 : n'importe lequel peut déclencher).
     *
     *  - stopId = startPlanId + "#stop" : UN SEUL STOP par plan, quel que soit
     *    le Master qui l'émet (l'arbitrage est le même partout).
     *  - targetStopMs est un instant ABSOLU dans l'horloge du CRÉATEUR, comme
     *    targetStart en J08 ; chaque device exécute stopRecording à
     *    localTargetStop = targetStopMs + offset(soi) (mêmes offsets J07 que
     *    le plan : une seule source d'horloge).
     *  - Chaque device participant publie un stop_state (STOPPED, actualMs,
     *    deltaMs, path). Le Master qui a créé le STOP marque en INCIDENT toute
     *    Capture sans stop_state avant targetStopMs + STOP_ACK_TIMEOUT_MS ;
     *    l'incident est levé par un stop_state tardif ou par la reconnexion.
     *  - Un device déjà STOPPED (urgence locale ou STOP reçu deux fois) répond à
     *    un stop_request par un stop_state idempotent : jamais un redémarrage.
     */

    function stopFromPlan(reason) {
      var plan = state.plan;
      return {
        stopId: String(plan.startPlanId) + "#stop",
        startPlanId: plan.startPlanId,
        takeNumber: plan.takeNumber,
        targetStopMs: now() + STOP_LEAD_MS,
        createdByDeviceId: self(),
        clockOffsets: (plan && plan.clockOffsets) || {},
        dispatchLeadMs: STOP_LEAD_MS,
        reason: reason || "master_stop"
      };
    }

    /* Offset de CE device dans une map { did: offsetMs } de convention
     * C_local − C_createur ; le créateur vaut 0 par construction. */
    function localOffsetIn(offsets) {
      if (!offsets) return 0;
      if (isNum(offsets[self()])) return offsets[self()];
      return 0;
    }

    function localStopTargetMs(txn) {
      if (!txn || !isNum(txn.targetStopMs)) return null;
      return txn.targetStopMs + localOffsetIn(txn.clockOffsets);
    }

    var clearStopTimers = function () {
      if (state.stopTimer) { clearSched(state.stopTimer); state.stopTimer = null; }
      if (state.stopAckTimer) { clearSched(state.stopAckTimer); state.stopAckTimer = null; }
    };

    var publishStopState = function (txn, info) {
      if (!state.plan || !deps.sendStopState) return;
      if (txn && txn.startPlanId !== state.planId) return;
      deps.sendStopState(state.sid, {
        stopId: (txn && txn.stopId) || "",
        startPlanId: state.planId,
        takeNumber: state.plan.takeNumber,
        deviceId: self(),
        state: STATE_STOPPED,
        actualMs: info.actualMs,
        localTargetMs: info.localTargetMs,
        deltaMs: info.deltaMs,
        path: info.path || "",
        reason: (txn && txn.reason) || info.reason || ""
      });
    };

    var logStopLocal = function (takeNumber, info, txn, plan) {
      var reason = String((txn && txn.reason) || info.reason || "user");
      /* Ligne J08 conservée (parité de télémétrie avec la suite existante). */
      log("START_STOP_LOCAL deviceId=" + self()
        + " startPlanId=" + String((plan && plan.startPlanId) || "—")
        + " take=" + takeNumber + " reason=" + reason
        + " at=" + fmtClock(info.actualMs));
      /* Ligne J10 exigée par le plan : sessionId / take / actual. */
      var line = "STOP_LOCAL sessionId=" + state.sid + " take=" + takeNumber
        + " actual=" + fmtClock(info.actualMs)
        + " startPlanId=" + String((plan && plan.startPlanId) || "—")
        + " stopId=" + String((txn && txn.stopId) || "—");
      if (isNum(info.localTargetMs)) {
        line += " localTarget=" + fmtClock(info.localTargetMs)
          + " deltaMs=" + Math.round(info.deltaMs);
      }
      line += " path=" + (info.path || "—") + " reason=" + reason;
      log(line);
    };

    /* Arrivée commune du STOP (coordonné ou urgence locale) : verrouille le
     * Take en local, bascule en STOPPED EN CONSERVANT le plan (l'écran d'arrêt
     * reste affichable, et le nouveau Take remplacera ensuite le plan) et
     * publie le stop_state. `txn` est null pour une urgence locale. */
    var enterStopped = function (info, txn) {
      var plan = state.plan;
      var takeNumber = plan ? plan.takeNumber : state.stoppedTakeNumber;
      state.localStoppedTakes[takeNumber] = true;
      state.stoppedTakeNumber = takeNumber;
      state.phase = PHASE_STOPPED;
      state.showEmergencyStop = false;
      state.stopExecuted = true;
      state.stopError = "";
      state.localStopInfo = {
        stopId: (txn && txn.stopId) || "",
        actualMs: info.actualMs,
        localTargetMs: info.localTargetMs,
        deltaMs: info.deltaMs,
        path: info.path || ""
      };
      state.stopStates[self()] = {
        deviceId: self(),
        state: STATE_STOPPED,
        stopId: state.localStopInfo.stopId,
        actualMs: info.actualMs,
        localTargetMs: info.localTargetMs,
        deltaMs: info.deltaMs,
        path: info.path || "",
        reason: (txn && txn.reason) || info.reason || ""
      };
      logStopLocal(takeNumber, info, txn, plan);
      if (txn) publishStopState(txn, info);
    };

    /* Exécution de l'arrêt local à l'instant cible (top d'arrêt). */
    var executeStop = function (txn) {
      if (state.stopTimer) { clearSched(state.stopTimer); state.stopTimer = null; }
      if (!state.plan || txn.startPlanId !== state.planId) return;
      if (state.stopExecuted || state.phase === PHASE_STOPPED) return;
      if (state.phase !== PHASE_REC) {
        log("STOP_LOCAL deviceId=" + self() + " startPlanId=" + state.planId
          + " take=" + txn.takeNumber + " at=" + fmtClock(now())
          + " status=SKIPPED phase=" + state.phase);
        return;
      }
      if (!state.isCapture) {
        /* Master non participant : aucun media à finaliser. Son STOP_LOCAL est
         * un OBSERVER (comme au START) — jamais un faux arrêt physique. */
        enterStopped({ actualMs: now(), localTargetMs: null, deltaMs: null, path: "", reason: txn.reason }, txn);
        bump();
        return;
      }
      var txnId = txn.stopId;
      var startPlanIdAtCall = state.planId;
      var localTargetMs = state.stopLocalTargetMs;
      if (!deps.stopRecording) {
        log("STOP_LOCAL_ERROR deviceId=" + self() + " startPlanId=" + state.planId
          + " stopId=" + txn.stopId + " reason=no_recorder");
        state.stopError = "no_recorder";
        bump();
        return;
      }
      Promise.resolve(deps.stopRecording()).then(function (res) {
        if (state.planId !== startPlanIdAtCall || !state.plan) {
          log("STOP_NATIVE_ACK deviceId=" + self() + " stopId=" + txnId + " planAbandoned=1");
          return;
        }
        var actualMs = (res && isNum(res.atMs)) ? res.atMs : now();
        var deltaMs = isNum(localTargetMs) ? (actualMs - localTargetMs) : null;
        enterStopped({
          actualMs: actualMs,
          localTargetMs: localTargetMs,
          deltaMs: deltaMs,
          path: (res && res.path) || "",
          reason: txn.reason
        }, txn);
        bump();
      }).catch(function (err) {
        if (state.planId !== startPlanIdAtCall || !state.plan) return;
        state.stopError = String((err && err.message) || err);
        log("STOP_LOCAL_ERROR deviceId=" + self() + " startPlanId=" + state.planId
          + " stopId=" + txn.stopId + " err=" + state.stopError);
        bump();
      });
    };

    /* Acquisition d'une transaction STOP (locale ou reçue). Idempotente par
     * stopId : deux Masters concurrents convergent vers LE MÊME arrêt. */
    var adoptStop = function (txn) {
      if (!txn || !txn.stopId || !txn.startPlanId || !isNum(txn.targetStopMs)) {
        log("STOP_REQUEST_IGNORE deviceId=" + self() + " reason=malformed");
        return false;
      }
      if (state.seenStops[txn.stopId]) return false;
      if (!state.plan || txn.startPlanId !== state.planId) {
        log("STOP_REQUEST_IGNORE deviceId=" + self() + " stopId=" + txn.stopId
          + " startPlanId=" + txn.startPlanId + " active=" + (state.planId || "none")
          + " reason=plan_mismatch");
        return false;
      }
      if (state.phase !== PHASE_REC) {
        log("STOP_REQUEST_IGNORE deviceId=" + self() + " stopId=" + txn.stopId
          + " startPlanId=" + txn.startPlanId + " take=" + txn.takeNumber
          + " reason=phase phase=" + state.phase);
        return false;
      }
      state.seenStops[txn.stopId] = true;
      state.stop = {
        stopId: txn.stopId,
        startPlanId: txn.startPlanId,
        takeNumber: txn.takeNumber,
        targetStopMs: txn.targetStopMs,
        createdByDeviceId: txn.createdByDeviceId || "",
        clockOffsets: txn.clockOffsets || {},
        dispatchLeadMs: txn.dispatchLeadMs,
        reason: txn.reason || "master_stop"
      };
      state.stopLocalTargetMs = localStopTargetMs(state.stop);
      state.stopError = "";
      clearStopTimers();
      state.stopTimer = sched(function () {
        state.stopTimer = null;
        executeStop(state.stop);
      }, Math.max(0, state.stopLocalTargetMs - now()));
      if (state.stop.createdByDeviceId === self()) {
        /* La détection d'incident tourne sur l'horloge du CRÉATEUR : c'est lui
         * qui connaît targetStopMs sans conversion. */
        state.stopAckTimer = sched(onStopAckTimeout,
          Math.max(0, (state.stop.targetStopMs + STOP_ACK_TIMEOUT_MS) - now()));
      }
      log("STOP_REQUEST_ACCEPTED deviceId=" + self() + " stopId=" + txn.stopId
        + " startPlanId=" + txn.startPlanId + " take=" + txn.takeNumber
        + " by=" + state.stop.createdByDeviceId
        + " target=" + fmtClock(state.stop.targetStopMs)
        + " localTarget=" + fmtClock(state.stopLocalTargetMs)
        + " dispatchLeadMs=" + state.stop.dispatchLeadMs
        + " reason=" + state.stop.reason);
      bump();
      return true;
    };

    /* Timeout d'acquittement (UNIQUEMENT le Master créateur) : toute Capture
     * participant au plan sans stop_state à échéance est marquée INCIDENT. */
    var onStopAckTimeout = function () {
      state.stopAckTimer = null;
      var txn = state.stop;
      if (!txn) return;
      if (now() < txn.targetStopMs + STOP_ACK_TIMEOUT_MS) {
        state.stopAckTimer = sched(onStopAckTimeout, (txn.targetStopMs + STOP_ACK_TIMEOUT_MS) - now());
        return;
      }
      flagStopIncidents(txn);
      bump();
      /* Un incident vient de naître À L'ÉCHÉANCE : la fenêtre de tick pouvait
       * s'être refermée au même instant. On relance explicitement la boucle
       * (stopAckWindowOpen reste vrai tant qu'un incident subsiste) pour qu'une
       * reconnexion de la Capture puisse le lever. */
      if (Object.keys(state.stopIncidents).length > 0) scheduleTick();
    };

    var flagStopIncidents = function (txn) {
      if (!state.plan || txn.startPlanId !== state.planId) return;
      var flagged = false;
      state.plan.participants.forEach(function (p) {
        if (!p || p.role !== "capture") return;
        if (p.deviceId === self()) return;
        if (state.stopStates[p.deviceId]) return;
        if (state.stopIncidents[p.deviceId]) return;
        var off = (txn.clockOffsets && isNum(txn.clockOffsets[p.deviceId])) ? txn.clockOffsets[p.deviceId] : 0;
        state.stopIncidents[p.deviceId] = true;
        flagged = true;
        log("STOP_INCIDENT deviceId=" + self() + " stopId=" + txn.stopId
          + " take=" + txn.takeNumber + " peer=" + p.deviceId
          + " reason=no_stop_state at=" + fmtClock(now())
          + " expectedLocal=" + fmtClock(txn.targetStopMs + off));
      });
      return flagged;
    };

    /* Ack STOP idempotent d'un device déjà STOPPED (late ack J10 : un
     * stop_request re-tombé sur un Take déjà arrêté ne redémarre JAMAIS ; il
     * répond avec son dernier stop_state). */
    var republishStopState = function (env) {
      var info = state.localStopInfo;
      if (!info || !info.actualMs) {
        log("STOP_STATE_REPUBLISH_SKIP deviceId=" + self() + " stopId=" + env.stopId
          + " reason=no_local_stop_info take=" + env.takeNumber);
        return;
      }
      if (!deps.sendStopState) return;
      deps.sendStopState(state.sid, {
        stopId: env.stopId || (state.stop && state.stop.stopId) || "",
        startPlanId: env.startPlanId,
        takeNumber: env.takeNumber,
        deviceId: self(),
        state: STATE_STOPPED,
        actualMs: info.actualMs,
        localTargetMs: info.localTargetMs,
        deltaMs: info.deltaMs,
        path: info.path || "",
        reason: "late_ack"
      });
      log("STOP_STATE_REPUBLISH deviceId=" + self() + " stopId=" + (env.stopId || "?")
        + " take=" + env.takeNumber + " reason=idempotent_late_ack");
    };

    var applyStopState = function (msg) {
      if (!state.plan || msg.startPlanId !== state.planId) {
        log("STOP_STATE_IGNORE deviceId=" + self() + " stopId=" + (msg.stopId || "?")
          + " startPlanId=" + (msg.startPlanId || "?") + " active=" + (state.planId || "none"));
        return false;
      }
      if (!msg.deviceId) return false;
      var key = msg.deviceId + "|" + String(msg.stopId || "");
      if (state.seenStopStates[key]) return false;
      state.seenStopStates[key] = true;
      state.stopStates[msg.deviceId] = {
        deviceId: msg.deviceId,
        state: msg.state || STATE_STOPPED,
        stopId: msg.stopId || "",
        actualMs: isNum(msg.actualMs) ? msg.actualMs : null,
        localTargetMs: isNum(msg.localTargetMs) ? msg.localTargetMs : null,
        deltaMs: isNum(msg.deltaMs) ? msg.deltaMs : null,
        path: msg.path || "",
        reason: msg.reason || "",
        receivedAtMs: now()
      };
      if (state.stopIncidents[msg.deviceId]) {
        delete state.stopIncidents[msg.deviceId];
      }
      log("STOP_STATE deviceId=" + self() + " stopId=" + (msg.stopId || "?")
        + " take=" + (state.plan.takeNumber) + " peer=" + msg.deviceId
        + " state=" + (msg.state || STATE_STOPPED)
        + (isNum(msg.deltaMs) ? " deltaMs=" + Math.round(msg.deltaMs) : ""));
      bump();
      return true;
    };

    /* ---------- API publique ---------- */

    /* Déclenchement REC côté Master : rafraîchit l'horloge J07, verrouille
     * targetStart, crée le plan, le diffuse, puis l'adopte (le Master starter
     * est aussi Capture s'il est sélectionné dans le Take). */
    function requestStart(opts) {
      opts = opts || {};
      var sid = opts.sid || state.sid;
      if (!sid) return Promise.reject(new Error("no_session"));
      /* J10 : un plan STOPPED peut être remplacé par le plan d'un NOUVEAU Take
       * (le Take courant est verrouillé par localStoppedTakes, jamais ici). */
      if (state.plan && state.phase !== PHASE_IDLE && state.phase !== PHASE_STOPPED) {
        log("START_REJECTED sessionId=" + sid + " reason=plan_active startPlanId=" + state.planId);
        return Promise.reject(new Error("plan_active"));
      }
      return Promise.resolve(deps.loadSession(sid)).then(function (ses) {
        if (!ses) {
          log("START_REJECTED sessionId=" + sid + " reason=unknown_session");
          throw new Error("unknown_session");
        }
        var take = deps.lastTake ? deps.lastTake(ses) : null;
        if (!take) {
          log("START_REJECTED sessionId=" + sid + " reason=no_take");
          throw new Error("no_take");
        }
        if (state.localStoppedTakes[take.takeNumber]) {
          log("START_REJECTED sessionId=" + sid + " take=" + take.takeNumber + " reason=local_stopped_take");
          throw new Error("local_stopped_take");
        }
        if (state.localStartedTakes[take.takeNumber] === true && state.phase === PHASE_REC) {
          log("START_REJECTED sessionId=" + sid + " take=" + take.takeNumber + " reason=local_already_started");
          throw new Error("local_already_started");
        }
        var master = deps.isMasterRole ? deps.isMasterRole(self(), ses) : true;
        if (!master) {
          log("START_REJECTED sessionId=" + sid + " take=" + take.takeNumber + " reason=not_master");
          throw new Error("not_master");
        }
        return refreshClockThenPlan(ses, take, master);
      });
    }

    var refreshClockThenPlan = function (ses, take, master) {
      var armV = deps.armView ? deps.armView() : null;
      var remoteCaptures = [];
      if (armV && Array.isArray(armV.devices)) {
        armV.devices.forEach(function (d) {
          (d.skills || []).forEach(function (sk) {
            if (sk.skill === "capture" && d.did !== self()) remoteCaptures.push(d.did);
          });
        });
      }
      if (!remoteCaptures.length) {
        log("START_REJECTED sessionId=" + ses.sessionId + " take=" + take.takeNumber
          + " reason=no_remote_capture");
        throw new Error("no_remote_capture");
      }
      var ready = deps.refreshArmClock ? Promise.resolve(deps.refreshArmClock()) : Promise.resolve();
      return ready.then(function () {
        var offsets = deps.armClockOffsets ? (deps.armClockOffsets() || {}) : {};
        var clockOffsets = {};
        var stale = [];
        remoteCaptures.forEach(function (did) {
          var o = offsets[did] || {};
          if (!isNum(o.offsetMs)) {
            stale.push(did);
            return;
          }
          clockOffsets[did] = o.offsetMs;
          log("START_CLOCK_FRESHNESS deviceId=" + self() + " peer=" + did
            + " offsetMs=" + Math.round(o.offsetMs) + " ageMs=" + Math.round(o.ageMs || 0)
            + " maxAgeMs=" + CLOCK_FRESH_MAX_AGE_MS
            + " ok=" + ((o.ageMs || 0) <= CLOCK_FRESH_MAX_AGE_MS ? 1 : 0));
          if ((o.ageMs || 0) > CLOCK_FRESH_MAX_AGE_MS) stale.push(did);
        });
        if (stale.length) {
          log("START_REJECTED sessionId=" + ses.sessionId + " take=" + take.takeNumber
            + " reason=clock_stale peers=[" + stale.join(",") + "]");
          throw new Error("clock_stale");
        }
        var countdownSeconds = deps.countdownSecondsOf ? deps.countdownSecondsOf(take) : 5;
        if (!isNum(countdownSeconds) || countdownSeconds < 0) countdownSeconds = 0;
        var leadMs = countdownSeconds > 0 ? (countdownSeconds * 1000) : MIN_DISPATCH_LEAD_MS;
        var createdAtMs = now();
        var targetStartMs = createdAtMs + leadMs;
        state.seq += 1;
        /* armCycleId encodes session#take#tentative (J07) ; le startPlanId ajoute
         * le seq local → 4 segments, segments 1..3 NUMÉRIQUES (isPlanFmt).
         * Sans cycle ARM actif, la tentative vaut 0 — un reste non numérique
         * produirait un plan rejeté comme malformed par TOUS les devices,
         * y compris le créateur : degradation silencieuse inacceptable. */
        var armCycleId = armCycleIdFor();
        if (!armCycleId) {
          armCycleId = ses.sessionId + "#" + take.takeNumber + "#0";
          log("START_PLAN_NO_ARM_CYCLE deviceId=" + self() + " sessionId=" + ses.sessionId
            + " take=" + take.takeNumber + " attempt=0 note=start_sans_arme");
        }
        var participants = [];
        if (armV && Array.isArray(armV.devices)) {
          armV.devices.forEach(function (d) {
            /* Rôle STRICT issu des compétences J07 : un device sans skill
             * capture/storage (Master simple) n'est PAS participant — il ne
             * doit jamais compter dans les Captures démarrables ni exiger un
             * offset frais. Il suit le plan en observateur. */
            var isCap = (d.skills || []).some(function (sk) { return sk.skill === "capture"; });
            var isSto = !isCap && (d.skills || []).some(function (sk) { return sk.skill === "storage"; });
            if (!isCap && !isSto) return;
            participants.push({
              deviceId: d.did,
              deviceName: d.deviceName,
              role: isCap ? "capture" : "storage",
              takeNumber: take.takeNumber
            });
          });
        }
        var plan = {
          startPlanId: planId(armCycleId, state.seq),
          sessionId: ses.sessionId,
          sessionName: ses.name,
          takeNumber: take.takeNumber,
          armCycleId: armCycleId,
          targetStartMs: targetStartMs,
          countdownSeconds: countdownSeconds,
          dispatchLeadMs: leadMs,
          createdByDeviceId: self(),
          createdAtMs: createdAtMs,
          clockOffsets: clockOffsets,
          participants: participants
        };
        log("START_PLAN_CREATED deviceId=" + self() + " startPlanId=" + plan.startPlanId
          + " sessionId=" + plan.sessionId + " take=" + plan.takeNumber
          + " countdown=" + plan.countdownSeconds + " dispatchLeadMs=" + plan.dispatchLeadMs
          + " target=" + fmtClock(plan.targetStartMs)
          + " participants=[" + participants.map(function (p) { return p.deviceId + ":" + p.role; }).join(",") + "]");
        log("START_REQUEST sessionId=" + plan.sessionId + " take=" + plan.takeNumber
          + " startPlanId=" + plan.startPlanId + " by=" + self()
          + " targetStart=" + fmtClock(plan.targetStartMs) + " countdown=" + plan.countdownSeconds);
        /* Adoption AVANT diffusion : le leader doit être prêt à recevoir les
         * start_state que les pairs publient en adoptant à leur tour. */
        adoptPlan(plan, { isMaster: true, isStorage: !!state.isStorage });
        if (deps.sendStartPlan) deps.sendStartPlan(ses, plan);
        return view();
      });
    };

    function armCycleIdFor() {
      var armV = deps.armView ? deps.armView() : null;
      return (armV && armV.armCycleId) ? armV.armCycleId : null;
    }

    /* Annulation globale : réservée aux Masters, n'importe lequel. */
    function cancel(reason) {
      if (!state.plan) {
        log("START_CANCEL_REJECT reason=no_plan deviceId=" + self());
        return Promise.reject(new Error("no_plan"));
      }
      if (state.topFired) {
        log("START_CANCEL_REJECT sessionId=" + state.sid + " startPlanId=" + state.planId
          + " by=" + self() + " reason=already_started");
        return Promise.reject(new Error("already_started"));
      }
      var ses = state.sid;
      return Promise.resolve(deps.loadSession(ses)).then(function (s) {
        var master = deps.isMasterRole ? deps.isMasterRole(self(), s) : true;
        if (!master) {
          log("START_CANCEL_REJECT sessionId=" + ses + " startPlanId=" + state.planId
            + " by=" + self() + " reason=not_master");
          throw new Error("not_master");
        }
        log("START_CANCEL sessionId=" + ses + " startPlanId=" + state.planId
          + " take=" + state.plan.takeNumber + " by=" + self()
          + " reason=" + (reason || "master_cancel"));
        abortPlan(reason || "master_cancel", true);
        return view();
      });
    }

    /* STOP local : urgence (aucun Master connecté) ou arrêt du placeholder.
     * N'arrête QUE la Capture locale et verrouille le Take (pas de
     * redémarrage). Depuis J10, le plan est CONSERVÉ en phase STOPPED pour que
     * l'écran d'arrêt reste affichable — un nouveau Take le remplacera. */
    function stopLocal(reason) {
      if (state.phase !== PHASE_REC) {
        log("START_STOP_LOCAL deviceId=" + self() + " startPlanId=" + (state.planId || "—")
          + " reason=" + (reason || "user") + " status=ignored phase=" + state.phase);
        return Promise.resolve(view());
      }
      var txn = state.stop || null;
      var localTargetMs = state.stopLocalTargetMs;
      return Promise.resolve(deps.stopRecording ? deps.stopRecording() : null).then(function (res) {
        var actualMs = (res && isNum(res.atMs)) ? res.atMs : now();
        var deltaMs = isNum(localTargetMs) ? (actualMs - localTargetMs) : null;
        enterStopped({
          actualMs: actualMs,
          localTargetMs: localTargetMs,
          deltaMs: deltaMs,
          path: (res && res.path) || "",
          reason: reason || "emergency"
        }, txn);
        bump();
        return view();
      });
    }

    /* STOP global coordonné (J10) : déclenché par UN Master (tous égaux).
     * Verrouille targetStopMs, diffuse le stop_request, l'adopte localement.
     * Un Master qui reçoit déjà un STOP actif pour ce plan converge (idempotent). */
    function requestStop(reason) {
      if (!state.plan) {
        log("STOP_REJECTED deviceId=" + self() + " reason=no_plan");
        return Promise.reject(new Error("no_plan"));
      }
      if (state.phase === PHASE_STOPPED) {
        log("STOP_REQUEST_IGNORE deviceId=" + self() + " stopId=" + (state.stop && state.stop.stopId)
          + " take=" + state.plan.takeNumber + " reason=already_stopped phase=" + state.phase);
        return Promise.resolve(view());
      }
      if (!state.topFired || state.phase !== PHASE_REC) {
        log("STOP_REJECTED deviceId=" + self() + " startPlanId=" + state.planId
          + " take=" + (state.plan ? state.plan.takeNumber : 0)
          + " reason=not_recording phase=" + state.phase);
        return Promise.reject(new Error("not_recording"));
      }
      var sid = state.sid;
      var planIdAtCall = state.planId;
      var takeNumber = state.plan ? state.plan.takeNumber : 0;
      var already = state.stop && state.stop.stopId === String(planIdAtCall) + "#stop";
      if (already) {
        log("STOP_REQUEST_IGNORE deviceId=" + self() + " stopId=" + state.stop.stopId
          + " take=" + takeNumber + " reason=stop_active");
        return Promise.resolve(view());
      }
      return Promise.resolve(deps.loadSession(sid)).then(function (ses) {
        var master = deps.isMasterRole ? deps.isMasterRole(self(), ses) : true;
        if (!master) {
          log("STOP_REJECTED sessionId=" + sid + " startPlanId=" + planIdAtCall
            + " take=" + takeNumber + " reason=not_master");
          throw new Error("not_master");
        }
        var txn = stopFromPlan(reason);
        log("STOP_REQUEST sessionId=" + sid + " take=" + takeNumber + " stopId=" + txn.stopId
          + " startPlanId=" + txn.startPlanId + " by=" + self()
          + " target=" + fmtClock(txn.targetStopMs) + " dispatchLeadMs=" + txn.dispatchLeadMs
          + " reason=" + txn.reason);
        if (deps.sendStopRequest) deps.sendStopRequest(sid, txn);
        adoptStop(txn);
        return view();
      });
    }

    /* Rafraîchissement de l'éligibilité locale pendant le countdown.
     * Exclusion OU réintégration (avant le top exclusivement) : une Capture
     * exclue pour indisponibilité revient automatiquement dès que la caméra
     * redevient prête. Une exclusion « offset » reste définitive. */
    function refreshLocalReadiness() {
      if (state.phase !== PHASE_COUNTDOWN || !state.plan || !state.isCapture) return;
      var r = deps.captureReady ? deps.captureReady(state.sid, state.plan) : { ok: true, message: "" };
      var ok = !r || r.ok !== false;
      if (!ok) { excludeSelf((r && r.message) || "indisponible", "readiness"); return; }
      if (state.excluded) reintegrateSelf((r && r.message) || "ready_again");
    }

    var onIncoming = function (env, reply) {
      if (!env) return;

      if (env.kind === "start_plan") {
        if (!env.plan || !env.plan.startPlanId) {
          log("START_PLAN_DROP reason=malformed from=" + (env.from || "?"));
          return;
        }
        var s = env.plan;
        var role = { isMaster: false, isStorage: false };
        return Promise.resolve(deps.loadSession(s.sessionId)).then(function (ses) {
          if (!ses) {
            log("START_PLAN_DROP sessionId=" + s.sessionId + " reason=unknown_session from=" + (env.from || "?"));
            return;
          }
          role.isMaster = deps.isMasterRole ? deps.isMasterRole(self(), ses) : false;
          role.isStorage = deps.storageRole ? deps.storageRole(self(), ses) : false;
          adoptPlan(s, role);
        }).catch(function (err) {
          log("START_PLAN_ERROR sessionId=" + (s.sessionId || "?") + " err=" + String((err && err.message) || err));
        });
      }

      if (env.kind === "start_cancel") {
        if (!state.plan || env.startPlanId !== state.planId) {
          log("START_CANCEL_IGNORE startPlanId=" + (env.startPlanId || "?") + " active=" + (state.planId || "none"));
          return;
        }
        if (state.topFired) {
          log("START_CANCEL_IGNORE sessionId=" + state.sid + " startPlanId=" + state.planId
            + " by=" + (env.byDeviceId || env.from || "?") + " reason=already_started phase=" + state.phase);
          return;
        }
        log("START_CANCEL sessionId=" + state.sid + " startPlanId=" + state.planId
          + " take=" + state.plan.takeNumber + " by=" + (env.byDeviceId || env.from || "?")
          + " reason=" + (env.reason || "master_cancel"));
        abortPlan(env.reason || "master_cancel", false);
        return;
      }

      if (env.kind === "start_state") {
        applyPeerState(env);
        return;
      }

      if (env.kind === "stop_request") {
        if (!state.plan || env.startPlanId !== state.planId) {
          log("STOP_REQUEST_IGNORE deviceId=" + self()
            + " stopId=" + (env.stopId || "?") + " startPlanId=" + (env.startPlanId || "?")
            + " active=" + (state.planId || "none") + " reason=plan_mismatch");
          return;
        }
        if (state.phase === PHASE_STOPPED && state.localStoppedTakes[env.takeNumber] === true) {
          /* Take déjà arrêté localement : late ack idempotent, JAMAIS de
           * redémarrage (exigence J10 : reconnect/double-STOP sans reprise). */
          republishStopState(env);
          return;
        }
        adoptStop(env);
        return;
      }

      if (env.kind === "stop_state") {
        applyStopState(env);
        return;
      }

      if (env.kind === "start_probe") {
        /* Réponse NTP courte du créateur du plan (t1 = reçu, t2 = émis). */
        if (!state.plan || env.startPlanId !== state.planId) return;
        if (env.target !== self()) return;
        if (reply) reply("start_probe_reply", { startPlanId: state.planId, requestId: env.requestId, t1: now(), t2: now() });
        return;
      }

      if (env.kind === "start_probe_reply") {
        var p = state.pendingProbe;
        if (!p || p.seq !== env.requestId || !state.plan || env.startPlanId !== state.planId) {
          log("START_PROBE_IGNORE requestId=" + (env.requestId === undefined ? "?" : env.requestId)
            + " active=" + (state.planId || "none"));
          return;
        }
        if (state.probeTimer) { clearSched(state.probeTimer); state.probeTimer = null; }
        state.pendingProbe = null;
        var t3 = now();
        if (!isNum(env.t1) || !isNum(env.t2)) {
          log("START_PROBE_UNKNOWN deviceId=" + self() + " startPlanId=" + state.planId + " reason=malformed");
          planClockReady();
          return;
        }
        /* probeOffset() applique la formule NTP de J07 : Pair − Local. Le plan,
         * lui, consomme Local − Créateur (C_local − C_createur) pour porter le
         * top local = targetStart + offset. On convertit donc explicitement le
         * signe — le sens du décalage est un invariant de J08, pas un détail. */
        var peerMinusLocal = probeOffset(p.t0, env.t1, env.t2, t3);
        state.offsetMs = -peerMinusLocal;
        state.offsetKnown = true;
        log("START_PROBE deviceId=" + self() + " startPlanId=" + state.planId
          + " peer=" + state.plan.createdByDeviceId
          + " peerMinusLocal=" + Math.round(peerMinusLocal) + "ms"
          + " localMinusCreator=" + Math.round(state.offsetMs) + "ms"
          + " rtt=" + Math.round(((t3 - p.t0) - (env.t2 - env.t1))) + "ms");
        planClockReady();
        return;
      }
    };

    var view = function () {
      return {
        active: !!state.plan,
        phase: state.phase,
        sid: state.sid,
        sessionName: sessionName(),
        takeNumber: state.plan ? state.plan.takeNumber : 0,
        armCycleId: state.plan ? state.plan.armCycleId : null,
        startPlanId: state.planId,
        leader: state.leader,
        isMaster: state.isMaster,
        isCapture: state.isCapture,
        isStorage: state.isStorage,
        countdownSeconds: state.plan ? state.plan.countdownSeconds : 0,
        showCountdown: state.showCountdown && state.phase === PHASE_COUNTDOWN && !state.excluded,
        offsetMs: state.offsetMs,
        offsetKnown: state.offsetKnown,
        countdownResolved: state.offsetKnown,
        targetStartMs: state.plan ? state.plan.targetStartMs : null,
        localTopMs: state.localTopMs,
        remainingMs: state.remainingMs,
        digit: state.digit,
        excluded: state.excluded,
        excludeMessage: state.excludeMessage,
        peers: state.peers,
        peerStates: peerCountMsg(),
        startableCaptures: state.plan ? startablePeerCaptures(state.plan).length : 0,
        recStartedAtMs: state.recStartedAtMs,
        recElapsedMs: state.recElapsedMs,
        lastStart: state.lastStart,
        showEmergencyStop: state.showEmergencyStop,
        localStoppedTake: !!state.localStoppedTakes[state.plan ? state.plan.takeNumber : state.stoppedTakeNumber],
        localStartedTake: !!state.localStartedTakes[state.plan ? state.plan.takeNumber : state.stoppedTakeNumber],
        stoppedTakeNumber: state.stoppedTakeNumber,
        /* ---------- J10 : STOP coordonné ---------- */
        stop: state.stop,
        stopId: state.stop ? state.stop.stopId : "",
        stopActive: !!state.stop,
        stopExecuted: state.stopExecuted,
        stopError: state.stopError,
        stopStates: state.stopStates,
        stopIncidents: state.stopIncidents,
        stopIncidentDids: Object.keys(state.stopIncidents),
        localStopInfo: state.localStopInfo,
        stopDurationMs: (state.localStopInfo && isNum(state.localStopInfo.actualMs) && isNum(state.recStartedAtMs))
          ? Math.max(0, state.localStopInfo.actualMs - state.recStartedAtMs) : 0,
        selfDid: self(),
        rev: state.rev
      };
    };

    return {
      requestStart: requestStart,
      cancel: cancel,
      stopLocal: stopLocal,
      requestStop: requestStop,
      refreshLocalReadiness: refreshLocalReadiness,
      onIncoming: onIncoming,
      view: view,
      state: state,
      isActive: function () { return state.phase === PHASE_COUNTDOWN || state.phase === PHASE_REC || state.phase === PHASE_STOPPED; },
      isExcluded: function () { return state.phase === PHASE_EXCLUDED; },
      isLeader: function () { return state.leader; },
      currentPlanId: function () { return state.planId; },
      tickNow: function () { tick(); }
    };
  }

  /* ---------- export ---------- */

  return {
    TICK_MS: TICK_MS,
    MIN_DISPATCH_LEAD_MS: MIN_DISPATCH_LEAD_MS,
    PROBE_TIMEOUT_MS: PROBE_TIMEOUT_MS,
    CLOCK_FRESH_MAX_AGE_MS: CLOCK_FRESH_MAX_AGE_MS,
    PHASE_IDLE: PHASE_IDLE,
    PHASE_COUNTDOWN: PHASE_COUNTDOWN,
    PHASE_REC: PHASE_REC,
    PHASE_STOPPED: PHASE_STOPPED,
    PHASE_EXCLUDED: PHASE_EXCLUDED,
    STATE_ACCEPTED: STATE_ACCEPTED,
    STATE_EXCLUDED: STATE_EXCLUDED,
    STATE_REINTEGRATED: STATE_REINTEGRATED,
    STATE_STARTED: STATE_STARTED,
    STATE_FAILED: STATE_FAILED,
    STATE_STOPPED: STATE_STOPPED,
    STOP_LEAD_MS: STOP_LEAD_MS,
    STOP_ACK_TIMEOUT_MS: STOP_ACK_TIMEOUT_MS,
    planId: planId,
    isPlanFmt: isPlanFmt,
    choosePlanId: choosePlanId,
    comparePlanId: comparePlanId,
    probeOffset: probeOffset,
    localTopMs: localTopMs,
    digitFor: digitFor,
    fmtClock: fmtClock,
    createMachine: createMachine
  };
});
