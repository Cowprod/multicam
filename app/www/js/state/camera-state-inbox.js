/* MultiCam — J09-07 : MÉMOIRE DE SUPERVISION de l'état caméra des Captures.
 *
 * §35.3 : « les Masters se CONVERGENT vers l'état RÉELLEMENT confirmé ». Cette
 * convergence repose sur des ÉVÉNEMENTS (`camera_state`), pas sur une
 * télémétrie périodique : un Master doit savoir qu'une Capture vient de basculer
 * même si sa télémétrie est en retard.
 *
 * ---------- CE QUE CE MODULE FAIT, ET PAS PLUS ----------
 *
 * Il ENREGISTRE le dernier état reçu par device. Il ne demande rien, ne
 * relance rien, ne déduit rien. En particulier il ne « complète » jamais un
 * champ manquant par un défaut plausible : un `activeCamera` absent reste
 * absent, et l'UI écrit « inconnu ». Un état received d'un device qu'on ne
 * supervise pas n'est pas un défaut — c'est simplement hors du périmètre de
 * l'écran qui le consulte.
 *
 * ---------- MONTÉE EN PUISSANCE (grow-only) ----------
 *
 * Deux enveloppes peuvent arriver dans l'ordre : `begin` (intention) puis
 * `confirm` (fait). On ne remplace donc JAMAIS un `switchingCamera` par une
 * valeur vide arrivée avant lui, ni un `activeCamera` par un `switching` : le
 * résultat de la bascule est toujours plus frais que son annonce.
 */

(function (global) {
  "use strict";

  var MAX_DEVICES = 16;

  /* deviceId -> dernier état connu */
  var BY_DEVICE = {};

  var listeners = [];

  function log(l) { console.log(l); }
  function nowMs() { return Date.now(); }

  function model() { return global.MultiCamCameraSwitchModel || null; }

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  /* Un champ texte n'est retenu que s'il appartient au modèle de caméras. */
  function safeCamera(v) {
    var m = model();
    var c = m ? m.normalizeCamera(v) : "";
    return c || "";
  }

  /* ---------- J09-08c : champs d'état du segment ----------
   *
   * Trois règles, appliquées sans exception :
   *
   *   - `recording` n'est retenu que s'il est un BOOLÉEN explicite. Le champ
   *     est un état instantané, pas une croissance : le garder « vrai » faute de
   *     information inventerait un enregistrement qui n'existe plus ;
   *   - `segmentState` n'est retenu que s'il appartient au vocabulaire du
   *     modèle. Un mot inconnu — ou un champ absent d'une Capture plus
   *     ancienne — ne doit jamais atteindre l'écran sous une forme que personne
   *     n'a prévue : l'état précédent est alors conservé, exactement comme pour
   *     `segmentIndex`. Une chaîne VIDE reste acceptée : c'est la publication
   *     « plus aucun segment en cours », pas une absence d'information ;
   *   - aucun des deux ne passe par la règle de fraîcheur `newer`, qui est faite
   *     pour l'annonce puis le résultat d'une bascule. Ces deux champs peuvent
   *     RECULER légitimement : un STOP ramène `segmentIndex` à 0,
   *     `segmentState` à "" et `recording` à false. Un paquet retardé ne doit
   *     donc pas ressusciter un état antérieur. */
  /* `null` = rien de recevable (champ absent, vocabulaire inconnu, modèle
   * absent). La chaîne vide, elle, est une valeur : « aucun segment ». */
  function safeSegmentState(v) {
    var m = model();
    if (!m || !m.SEG || typeof v !== "string") return null;
    if (v === m.SEG.RECORDING || v === m.SEG.CLOSED || v === m.SEG.FAILED) return v;
    if (v === "") return "";
    return null;
  }

  function safeCameras(v) {
    var m = model();
    if (!m || !Array.isArray(v)) return [];
    var out = [];
    v.forEach(function (x) {
      var c = safeCamera(x);
      if (c && m.CAMERAS.indexOf(c) >= 0 && out.indexOf(c) < 0) out.push(c);
    });
    out.sort(function (a, b) { return m.CAMERAS.indexOf(a) - m.CAMERAS.indexOf(b); });
    return out;
  }

  /* ---------- enregistrement ---------- */

  /* `env` est l'enveloppe `camera_state` telle que produite par le transport.
   * On refuse tout ce qui n'est pas auto-déclaré : une Capture ne peut
   *encoder que son PROPRE état (§ même invariant que `telemetry_update`). */
  function record(env) {
    if (!env || typeof env !== "object") return false;
    var did = env.deviceId;
    if (typeof did !== "string" || !did) return false;
    if (env.from !== did) {
      log("CAMERA_STATE_DROP did=" + did + " reason=not_self from=" + (env.from || "?"));
      return false;
    }
    var prev = BY_DEVICE[did] || {
      deviceId: did, sessionId: "", takeNumber: null,
      availableCameras: [], requestedCamera: "", switchingCamera: "",
      activeCamera: "", segmentIndex: 0, segmentState: "", recording: false,
      switchCount: 0,
      lastError: "", lastErrorCode: "", lastSwitchDurationMs: 0,
      updatedAtMs: 0, atMs: 0, phase: ""
    };

    var switching = safeCamera(env.switchingCamera);
    var requested = safeCamera(env.requestedCamera);
    var active = safeCamera(env.activeCamera);

    /* Croissance temporelle : on n'écrase jamais un fait confirmé par une
     * intention plus ancienne (paquet retardé, ordre réseau). */
    var newer = !prev.updatedAtMs || (env.updatedAtMs || nowMs()) >= prev.updatedAtMs;

    var next = {
      deviceId: did,
      sessionId: env.sessionId || prev.sessionId,
      takeNumber: (env.takeNumber == null) ? prev.takeNumber : env.takeNumber,
      availableCameras: safeCameras(env.availableCameras).length
        ? safeCameras(env.availableCameras) : prev.availableCameras,
      requestedCamera: newer ? (requested || prev.requestedCamera) : prev.requestedCamera,
      switchingCamera: newer ? switching : prev.switchingCamera,
      activeCamera: newer ? (active || prev.activeCamera) : prev.activeCamera,
      /* `segmentIndex` = index du segment EN COURS, 0 s'il n'y en a pas. C'est
       * un état instantané comme les deux suivants : il RECULE au STOP, donc il
       * ne passe pas par `newer`. */
      segmentIndex: isNum(env.segmentIndex) && env.segmentIndex >= 0
        ? Math.round(env.segmentIndex) : prev.segmentIndex,
      segmentState: (function () {
        var seg = safeSegmentState(env.segmentState);
        return (seg === null) ? prev.segmentState : seg;
      })(),
      recording: (typeof env.recording === "boolean") ? env.recording : prev.recording,
      switchCount: isNum(env.switchCount) && env.switchCount >= 0
        ? Math.round(env.switchCount) : prev.switchCount,
      lastError: newer ? (typeof env.lastError === "string" ? env.lastError : "") : prev.lastError,
      lastErrorCode: newer ? (typeof env.lastErrorCode === "string" ? env.lastErrorCode : "") : prev.lastErrorCode,
      lastSwitchDurationMs: isNum(env.lastSwitchDurationMs) && env.lastSwitchDurationMs >= 0
        ? Math.round(env.lastSwitchDurationMs) : prev.lastSwitchDurationMs,
      /* `atMs` = instant de MESURE côté Capture, `updatedAtMs` = instant de
       * RÉCEPTION. Les deux ne doivent pas être confondus : un délai réseau ne
       * doit pas se lire comme une donnée fraîche. */
      atMs: isNum(env.atMs) && env.atMs > 0 ? Math.round(env.atMs) : 0,
      updatedAtMs: isNum(env.updatedAtMs) && env.updatedAtMs > 0 ? Math.round(env.updatedAtMs) : nowMs(),
      /* J09-07 — `phase` est la phase du START (IDLE/COUNTDOWN/REC), telltale
       * de la Capture. Elle est RELAYEE telle quelle : le Master ne doit pas la
       * recomposer, il n'a pas le plan de START de la Capture. */
      phase: newer && typeof env.phase === "string" ? env.phase : prev.phase
    };

    /* Un `switchingCamera` vide est une FIN d'opération : elle n'a de sens que
     * si l'on connaît la caméra confirmée. Sans elle, on garde l'état précédent
     * plutôt que d'afficher une caméra vide au moment précis où ça bouge. */
    if (newer && !switching && !active && !next.activeCamera) {
      return false;
    }

    BY_DEVICE[did] = next;
    prune();
    emit(did);
    return true;
  }

  function prune() {
    var keys = Object.keys(BY_DEVICE);
    if (keys.length <= MAX_DEVICES) return;
    keys.sort(function (a, b) {
      return (BY_DEVICE[a].updatedAtMs || 0) - (BY_DEVICE[b].updatedAtMs || 0);
    });
    var drop = keys.length - MAX_DEVICES;
    for (var i = 0; i < drop; i++) delete BY_DEVICE[keys[i]];
  }

  function emit(did) {
    listeners.slice().forEach(function (fn) { try { fn(did); } catch (e) { } });
  }

  /* ---------- lecture ---------- */

  function forDevice(deviceId, sessionId) {
    var s = BY_DEVICE[deviceId];
    if (!s) return null;
    /* Un état d'une AUTRE session n'est jamais présenté comme l'état courant :
     * c'est la même règle que pour les frames et la télémétrie. */
    if (sessionId && s.sessionId && s.sessionId !== sessionId) return null;
    return copy(s);
  }

  function list(sessionId) {
    return Object.keys(BY_DEVICE)
      .map(function (k) { return forDevice(k, sessionId); })
      .filter(function (s) { return !!s; });
  }

  function copy(s) {
    var out = {};
    for (var k in s) {
      if (Object.prototype.hasOwnProperty.call(s, k)) {
        out[k] = (Array.isArray(s[k])) ? s[k].slice() : s[k];
      }
    }
    /* Un `busy` dérivé, jamais stocké : il expire tout seul. */
    out.busy = !!out.switchingCamera;
    /* `cameraPhase` est l'ÉTAT DE LA CAMÉRA, dérivé. Il ne doit surtout pas
     * s'appeler `phase` : ce nom désigne déjà la phase du START (IDLE /
     * COUNTDOWN / REC) et deux notions différentes sous un même mot ont
     * produit, sur le terrain, une supervision affichant « phase : FRONT ».
     * Le nommer `cameraPhase` rend la collision impossible à lire par erreur. */
    out.cameraPhase = out.switchingCamera
      ? ("switching:" + out.switchingCamera)
      : (out.activeCamera ? ("active:" + out.activeCamera) : "unknown");
    return out;
  }

  function clear() {
    BY_DEVICE = {};
    emit("");
  }

  global.MultiCamCameraStateInbox = {
    MAX_DEVICES: MAX_DEVICES,
    record: record,
    forDevice: forDevice,
    list: list,
    clear: clear,
    onEvent: function (fn) {
      if (typeof fn === "function" && listeners.indexOf(fn) < 0) listeners.push(fn);
    },
    offEvent: function (fn) {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    }
  };
})(window);