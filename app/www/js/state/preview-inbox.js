/* MultiCam — J09-04 : boîte de réception des previews sur le MASTER.
 *
 * CÔTÉ RÉCEPTION, et uniquement ça. Le WS (`net/session-ws.js`) route l'enveloppe
 * jusqu'ici ; ce module décide si elle est recevable et, si oui, la garde en
 * MÉMOIRE.
 *
 * LE CONTRAT EST DÉLIBÉRÉMENT MINIMAL — une mosaïque est hors périmètre (J09-05) :
 *   - UNE frame par `(sessionId, deviceId)`, la plus RÉCENTE. Jamais d'historique,
 *     jamais de file, jamais d'archive. Si une Capture se déconnecte, la master
 *     garde la dernière image connue, ce qui est utile, et rien de plus ;
 *   - `latest(sessionId, deviceId)` : lecture d'une frame ;
 *   - `onFrame(fn)` : un callback, appelé à chaque frame ACCEPTÉE. C'est le
 *     point d'entrée que l'UI utilisera plus tard — aujourd'hui il ne sert qu'à
 *     rendre le flux observable ;
 *   - `clearTake(sessionId, takeNumber)` : fin de take, purge.
 *
 * AUCUNE IMAGÉ N'EST INTERPRÉTÉE ICI : pas de décodage, pas de redimensionnement,
 * pas de calcul de couleur. `width`/`height` sont_recopiés tels quels — c'est la
 * CAPTURE qui les a lus dans son propre JPEG (voir state/preview-transport.js).
 *
 * SÉCURITÉ : une preview n'est acceptée que si cette session a le device local
 * comme MASTER. Une session tierce ne peut donc pas diffuser d'images vers ce
 * device, même si le message est syntaxiquement valide.
 */

"use strict";
(function (global) {

  var S = {
    bound: false,
    deviceId: "",
    isMasterOf: null,      /* (sessionId) -> boolean|Promise<boolean> */
    frames: {},            /* sessionId -> deviceId -> frame (UNE frame, pas d'historique) */
    listeners: [],
    stats: freshStats()
  };

  function freshStats() {
    return { received: 0, dropped: 0, droppedBy: {}, lastReceivedAtMs: 0, lastSeq: 0 };
  }

  function log() {
    try {
      var args = [];
      for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
      global.console.log(args.join(" "));
    } catch (e) {}
  }

  function nowMs() { return Date.now(); }

  function cfg() {
    return (global.MultiCamConfig && global.MultiCamConfig.get) ? global.MultiCamConfig.get() : null;
  }

  /* Rejet : TOUJOU journalisé avec le même mot que le WS et le transport, pour
   * qu'une grep unique (`PREVIEW_TRANSPORT_DROP`) suffise à expliquer une frame
   * perdue. La raison distingue le défaut de PROTOCOLE de l'absence de DROIT
   * (device non Master de cette session) : ce ne sont pas les mêmes bugs. */
  function drop(reason, env) {
    S.stats.dropped += 1;
    S.stats.droppedBy[reason] = (S.stats.droppedBy[reason] || 0) + 1;
    log("PREVIEW_TRANSPORT_DROP layer=preview_inbox reason=" + reason
      + " sessionId=" + ((env && env.sessionId) || "—")
      + " from=" + ((env && (env.deviceId || env.from)) || "—")
      + " seq=" + ((env && typeof env.seq === "number") ? env.seq : "—")
      + " dropped=" + S.stats.dropped);
    return false;
  }

  /* On ne se fie JAMAIS au champ `deviceId` seul : `from` est l'enveloppe, et
   * les deux doivent s'accorder quand ils sont tous deux présents. Une
   * usurpation de source est un défaut de protocole, pas un détail cosmétique. */
  function resolveSource(env) {
    var from = env.from || "";
    var dev = env.deviceId || "";
    if (from && dev && from !== dev) return null;
    return dev || from || "";
  }

  function storeOf(sessionId) {
    if (!S.frames[sessionId]) S.frames[sessionId] = {};
    return S.frames[sessionId];
  }

  function emitFrame(frame) {
    S.listeners.slice().forEach(function (fn) {
      try { fn(frame); } catch (e) {
        log("PREVIEW_FRAME_LISTENER_ERROR err=" + e);
      }
    });
  }

  /* ---------- API ---------- */

  function bind(options, isMasterOf) {
    var o = options || {};
    if (o.deviceId) S.deviceId = o.deviceId;
    else if (!S.deviceId) { var c = cfg(); S.deviceId = c ? c.deviceId : ""; }
    if (typeof isMasterOf === "function") S.isMasterOf = isMasterOf;
    else if (o.isMasterOf) S.isMasterOf = o.isMasterOf;
    S.bound = true;
    log("PREVIEW_INBOX_READY deviceId=" + (S.deviceId || "—") + " capacity=1_frame_per_device");
    return view();
  }

  /* Point d'entrée appelé par le pont du WS. Peut renvoyer une promesse (si le
   * contrôle « suis-je Master ? » est asynchrone) mais ne lève JAMAIS. */
  function accept(env) {
    try {
      if (!env || typeof env !== "object") return drop("not_an_envelope", env);
      if (!env.sessionId || typeof env.sessionId !== "string") return drop("missing_sessionId", env);
      if (!env.from) return drop("missing_source", env);
      var source = resolveSource(env);
      if (!source) return drop("missing_source", env);
      if (typeof env.seq !== "number" || !isFinite(env.seq)) return drop("bad_seq", env);
      if (typeof env.jpegBase64 !== "string" || !env.jpegBase64.length) return drop("missing_jpegBase64", env);
      if (env.mime && env.mime !== "image/jpeg") return drop("bad_mime", env);
      var sid = env.sessionId;

      /* DROIT : ce device doit être Master de cette session. */
      if (!S.isMasterOf) return drop("no_master_gate", env);
      var verdict;
      try {
        verdict = S.isMasterOf(sid);
      } catch (e) {
        return drop("master_gate_error", env);
      }
      return Promise.resolve(verdict).then(function (ok) {
        if (!ok) return drop("not_master_of_session", env);
        var frame = {
          sessionId: sid,
          deviceId: source,
          takeNumber: (typeof env.takeNumber === "number") ? env.takeNumber : null,
          startPlanId: env.startPlanId || "",
          seq: env.seq,
          capturedAt: env.capturedAt || 0,
          receivedAt: nowMs(),
          mime: env.mime || "image/jpeg",
          width: (typeof env.width === "number") ? env.width : null,
          height: (typeof env.height === "number") ? env.height : null,
          bytes: env.bytes || 0,
          jpegBase64: env.jpegBase64
        };
        /* UNE frame par Capture : la suivante écrase, sans file. */
        storeOf(sid)[source] = frame;
        S.stats.received += 1;
        S.stats.lastReceivedAtMs = frame.receivedAt;
        S.stats.lastSeq = frame.seq;
        log("PREVIEW_FRAME_RECEIVED sessionId=" + sid
          + " deviceId=" + source
          + " take=" + (frame.takeNumber === null ? "—" : frame.takeNumber)
          + " startPlanId=" + (frame.startPlanId || "—")
          + " seq=" + frame.seq
          + " bytes=" + frame.bytes
          + " width=" + (frame.width || "—") + " height=" + (frame.height || "—")
          + " sendToRxMs=" + (frame.capturedAt ? Math.max(0, frame.receivedAt - frame.capturedAt) : 0)
          + " total=" + S.stats.received);
        emitFrame(frame);
        return true;
      }, function () {
        return drop("master_gate_error", env);
      });
    } catch (e) {
      return drop("inbox_error", env);
    }
  }

  function latest(sessionId, deviceId) {
    var byDev = S.frames[sessionId];
    if (!byDev) return null;
    return byDev[deviceId] || null;
  }

  function deviceCount(sessionId) {
    var byDev = S.frames[sessionId];
    return byDev ? Object.keys(byDev).length : 0;
  }

  function deviceIds(sessionId) {
    var byDev = S.frames[sessionId];
    return byDev ? Object.keys(byDev) : [];
  }

  function onFrame(fn) {
    if (typeof fn === "function" && S.listeners.indexOf(fn) < 0) S.listeners.push(fn);
    return fn;
  }

  function offFrame(fn) {
    var i = S.listeners.indexOf(fn);
    if (i >= 0) S.listeners.splice(i, 1);
  }

  /* Fin de take : plus aucune image de ce take. Sans argument, toute la session. */
  function clearTake(sessionId, takeNumber) {
    var byDev = S.frames[sessionId];
    if (!byDev) return 0;
    var n = 0;
    if (typeof takeNumber !== "number") {
      n = Object.keys(byDev).length;
      delete S.frames[sessionId];
    } else {
      Object.keys(byDev).forEach(function (did) {
        var f = byDev[did];
        if (!f || f.takeNumber === takeNumber) { delete byDev[did]; n++; }
      });
      if (!Object.keys(byDev).length) delete S.frames[sessionId];
    }
    log("PREVIEW_INBOX_CLEAR sessionId=" + sessionId
      + " take=" + (typeof takeNumber === "number" ? takeNumber : "all") + " cleared=" + n);
    return n;
  }

  function clearSession(sessionId) { return clearTake(sessionId, null); }

  function reset() {
    S.frames = {};
    S.stats = freshStats();
    return true;
  }

  function stats() {
    return {
      received: S.stats.received,
      dropped: S.stats.dropped,
      droppedBy: JSON.parse(JSON.stringify(S.stats.droppedBy || {})),
      lastReceivedAtMs: S.stats.lastReceivedAtMs,
      lastSeq: S.stats.lastSeq,
      stored: Object.keys(S.frames).reduce(function (acc, sid) {
        return acc + Object.keys(S.frames[sid]).length;
      }, 0)
    };
  }

  function view() {
    return {
      bound: S.bound,
      deviceId: S.deviceId,
      sessions: Object.keys(S.frames).map(function (sid) {
        return { sessionId: sid, devices: deviceIds(sid) };
      }),
      stats: stats()
    };
  }

  global.MultiCamPreviewInbox = {
    bind: bind,
    accept: accept,
    latest: latest,
    deviceCount: deviceCount,
    deviceIds: deviceIds,
    onFrame: onFrame,
    offFrame: offFrame,
    clearTake: clearTake,
    clearSession: clearSession,
    reset: reset,
    stats: stats,
    view: view
  };
})(window);
