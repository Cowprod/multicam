/* MultiCam — J09-04 : transport des previews JPEG vers les Masters.
 *
 * COUCHE DE SERVICE, entre le producteur (state/preview-sampler.js, J09-03) et
 * le transport (net/session-ws.js). Elle a TROIS responsabilités et pas une de
 * plus :
 *
 *   1. TRANSFORMER une image locale en ENVELOPPE DE PROTOCOLE (`preview_frame`)
 *      — c'est ici, et seulement ici, qu'on lit la taille du JPEG pourvoyé par
 *      la Capture. Le réseau ne décode jamais une image.
 *   2. DÉCIDER QUOI NE PAS ENVOYER — session inconnue, session fermée, aucun
 *      Master connecté. Une preview perdue est acceptable ; l'enregistrement ne
 *      doit jamais en pâtir.
 *   3. APPLIQUER LA BACKPRESSURE « LATEST FRAME WINS » : au plus UNE image en
 *      vol et UN slot d'attente, qui remplace son contenu. Jamais de file
 *      infinie, jamais d'accumulation de JPEG périmés.
 *
 * Elle ne connaît NI la mosaïque, NI la grille, NI les rôles d'UI. Les rôles
 * sont lus dans la session (`masters[]`) et appliqués par le transport.
 */

"use strict";
(function (global) {

  var MAX_JSON_BYTES_WARN = 96 * 1024;   /* garde-fou de debit, pas un plafond dur */

  var S = {
    bound: false,
    enabled: true,
    held: false,          /* test/transport occupe : rien ne part (1 slot reste) */
    busy: false,          /* envoi en cours */
    pending: null,        /* UN slot : la frame la plus recente l'occupe */
    sessionId: "",
    takeNumber: null,
    startPlanId: "",
    deviceId: "",
    listeners: [],
    stats: freshStats()
  };

  function freshStats() {
    return {
      submitted: 0, sent: 0, dropped: 0,
      droppedBy: {},
      recipients: 0,
      nonMastersSkipped: 0, otherSessionSkipped: 0, selfSkipped: 0, unknownPeerSkipped: 0, notOpenSkipped: 0,
      duplicateConnsSkipped: 0,
      jpegBytesSum: 0, jpegBytesMin: 0, jpegBytesMax: 0,
      jsonBytesSum: 0, jsonBytesMin: 0, jsonBytesMax: 0,
      sendMsSum: 0, sendMsMax: 0,
      lastDropReason: "", lastDropAtMs: 0, lastSentAtMs: 0, lastSeq: 0, lastJsonBytes: 0,
      runs: 0
    };
  }

  function log() {
    try {
      var args = [];
      for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
      global.console.log(args.join(" "));
    } catch (e) {}
  }

  function nowMs() {
    return Date.now();
  }

  /* Le sampler raisonne en `takeNumber` TEXTE ("4") ; le protocole veut un
   * nombre. La conversion se fait ici, à la frontière, pour que ni le sampler
   * ni le WS n'aient à le savoir. */
  function takeNum(v) {
    if (typeof v === "number") return v;
    if (v === "" || v == null) return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function cfg() {
    return (global.MultiCamConfig && global.MultiCamConfig.get) ? global.MultiCamConfig.get() : null;
  }

  function ws() { return global.MultiCamSessionWs || null; }
  function store() { return global.MultiCamSessionStore || null; }
  function sampler() { return global.MultiCamPreviewSampler || null; }
  function inbox() { return global.MultiCamPreviewInbox || null; }

  function trackMin(cur, v) { return (!cur || v < cur) ? v : cur; }
  function trackMax(cur, v) { return (!cur || v > cur) ? v : cur; }

  /* ---------- base64 ---------- */

  function b64Bytes(b64) {
    if (typeof b64 !== "string" || !b64) return 0;
    var pad = 0;
    if (b64.slice(-2) === "==") pad = 2;
    else if (b64.slice(-1) === "=") pad = 1;
    return Math.floor(b64.length * 3 / 4) - pad;
  }

  /* Taille d'un JPEG lue DANS L'ENTETE (segment SOF), sur la Capture.
   * Ce n'est PAS un décodage d'image : on lit 2 marqueurs et 4 octets, et
   * uniquement avant le marqueur SOS. Le réseau ne fait jamais ce travail. */
  function jpegSize(b64) {
    try {
      if (typeof b64 !== "string" || b64.length < 8) return null;
      var raw = global.atob(b64);
      var n = raw.length;
      if (raw.charCodeAt(0) !== 0xff || raw.charCodeAt(1) !== 0xd8) return null;
      var i = 2;
      while (i + 3 < n) {
        if (raw.charCodeAt(i) !== 0xff) { i++; continue; }
        var marker = raw.charCodeAt(i + 1);
        /* SOI / TEM / RSTn : pas de segment */
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        if (marker === 0xd9) break;         /* EOI */
        if (marker === 0xda) break;         /* SOS : le SOF est toujours avant */
        var len = (raw.charCodeAt(i + 2) << 8) | raw.charCodeAt(i + 3);
        var isSof = marker >= 0xc0 && marker <= 0xcf
          && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
          if (i + 9 >= n) return null;
          var h = (raw.charCodeAt(i + 5) << 8) | raw.charCodeAt(i + 6);
          var w = (raw.charCodeAt(i + 7) << 8) | raw.charCodeAt(i + 8);
          if (!w || !h) return null;
          return { width: w, height: h };
        }
        if (len < 2) return null;
        i += 2 + len;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /* ---------- validation ---------- */

  /* Structure de l'image produite par le sampler. Rien d'obligatoire qui ne
   * soit pas nécessaire au Master pour afficher une frame. */
  function normalizeFrame(frame) {
    if (!frame || typeof frame !== "object") return null;
    if (!frame.sessionId || typeof frame.sessionId !== "string") return null;
    if (typeof frame.seq !== "number" || !isFinite(frame.seq)) return null;
    if (typeof frame.jpegBase64 !== "string" || !frame.jpegBase64.length) return null;
    var mime = frame.mime || "image/jpeg";
    if (mime !== "image/jpeg") return null;
    var bytes = (typeof frame.bytes === "number" && frame.bytes > 0) ? frame.bytes : b64Bytes(frame.jpegBase64);
    if (!bytes) return null;
    var out = {
      sessionId: frame.sessionId,
      deviceId: frame.deviceId || S.deviceId || (cfg() ? cfg().deviceId : "") || "",
      takeNumber: (typeof frame.takeNumber === "number") ? frame.takeNumber : null,
      startPlanId: frame.startPlanId || "",
      seq: frame.seq,
      capturedAt: (typeof frame.capturedAt === "number") ? frame.capturedAt : 0,
      mime: mime,
      bytes: bytes,
      jpegBase64: frame.jpegBase64
    };
    /* Taille absente du message amont : on la lit ICI, une fois, sur la source. */
    var w = frame.width, h = frame.height;
    if (!(typeof w === "number" && typeof h === "number" && w > 0 && h > 0)) {
      var sz = jpegSize(out.jpegBase64);
      w = sz ? sz.width : null;
      h = sz ? sz.height : null;
    }
    out.width = w;
    out.height = h;
    return out;
  }

  /* ---------- DROP (jamais une exception vers le chemin du REC) ---------- */

  function drop(reason, seq) {
    S.stats.dropped += 1;
    S.stats.droppedBy[reason] = (S.stats.droppedBy[reason] || 0) + 1;
    S.stats.lastDropReason = reason;
    S.stats.lastDropAtMs = nowMs();
    log("PREVIEW_FRAME_DROP reason=" + reason
      + " sessionId=" + (S.sessionId || "—")
      + " take=" + (S.takeNumber === null ? "—" : S.takeNumber)
      + " seq=" + ((typeof seq === "number") ? seq : "—")
      + " dropped=" + S.stats.dropped
      + " pending=" + (S.pending ? 1 : 0));
    return "dropped";
  }

  /* ---------- backpressure : « latest frame wins » ---------- */

  function enqueue(frame) {
    /* UN slot. Si une frame attend déjà, elle est PÉRIMÉE : la nouvelle la
     * remplace. C'est « latest wins » et ça borne la file à 1. */
    if (S.pending) {
      drop("superseded");
    }
    S.pending = frame;
    drain();
    return "queued";
  }

  function drain() {
    if (!S.pending) return;
    if (S.busy || S.held) return;          /* transport occupé : rien ne part */
    var frame = S.pending;
    S.pending = null;
    S.busy = true;
    var t0 = nowMs();
    var res = null;
    try {
      res = ws().sendPreviewFrame(resolveSessionCache(), frame);
    } catch (e) {
      S.busy = false;
      drop("transport_error");
      if (S.pending) drain();
      return;
    }
    S.busy = false;
    recordSend(res, frame, nowMs() - t0);
    if (S.pending) drain();
  }

  function recordSend(res, frame, sendMs) {
    var r = res || {};
    S.stats.nonMastersSkipped += r.nonMastersSkipped || 0;
    S.stats.otherSessionSkipped += r.otherSessionSkipped || 0;
    S.stats.selfSkipped += r.selfSkipped || 0;
    S.stats.unknownPeerSkipped += r.unknownPeerSkipped || 0;
    S.stats.notOpenSkipped += r.notOpenSkipped || 0;
    S.stats.duplicateConnsSkipped += r.duplicatesSkipped || 0;

    if (!r.sent) {
      drop(r.reason || "no_master_connected", frame.seq);
      return;
    }
    var st = S.stats;
    st.sent += 1;
    st.recipients += r.recipients || 0;
    st.lastSeq = frame.seq;
    st.lastSentAtMs = nowMs();
    st.jpegBytesSum += frame.bytes;
    st.jpegBytesMin = trackMin(st.jpegBytesMin, frame.bytes);
    st.jpegBytesMax = trackMax(st.jpegBytesMax, frame.bytes);
    st.jsonBytesSum += r.jsonBytes || 0;
    st.jsonBytesMin = trackMin(st.jsonBytesMin, r.jsonBytes || 0);
    st.jsonBytesMax = trackMax(st.jsonBytesMax, r.jsonBytes || 0);
    st.sendMsSum += sendMs;
    st.sendMsMax = trackMax(st.sendMsMax, sendMs);

    log("PREVIEW_FRAME_SENT sessionId=" + frame.sessionId
      + " take=" + (frame.takeNumber === null ? "—" : frame.takeNumber)
      + " startPlanId=" + (frame.startPlanId || "—")
      + " seq=" + frame.seq
      + " peers=" + (r.recipients || 0)
      + " jpegBytes=" + frame.bytes
      + " jsonBytes=" + (r.jsonBytes || 0)
      + " width=" + (frame.width || "—") + " height=" + (frame.height || "—")
      + " sendMs=" + sendMs
      + " atMs=" + st.lastSentAtMs);
    if ((r.jsonBytes || 0) > MAX_JSON_BYTES_WARN) {
      log("PREVIEW_FRAME_BIG jsonBytes=" + r.jsonBytes + " seq=" + frame.seq
        + " note=frame_volumineuse_ignoree");
    }
  }

  /* La session résolue sert au filtre des destinataires (les Masters). On la
   * mémorise le temps de l'envoi : le transport ne fait AUCUNE requête store. */
  var sessionCache = null;
  function resolveSessionCache() { return sessionCache; }
  function setSessionCache(s) { sessionCache = s; }

  /* ---------- API publique ---------- */

  /* Point d'entrée unique : une frame locale. Ne lève JAMAIS. */
  function submit(frame, reason) {
    S.stats.submitted += 1;
    if (!S.enabled) return drop("disabled");
    try {
      var f = normalizeFrame(frame);
      if (!f) return drop("invalid_frame");
      var sid = f.sessionId;
      var st = store();
      if (!st || typeof st.get !== "function") return drop("no_store");
      var p;
      try {
        p = Promise.resolve(st.get(sid));
      } catch (e) {
        return drop("store_error");
      }
      /* La résolution est ASYNCHRONE : elle ne doit jamais retarder le REC.
       * Le `seq` est mémorisé ici pour qu'une résolution tardive n'écrase pas
       * une frame plus récente déjà en attente. */
      var wanted = f.seq;
      return Promise.resolve(p).then(function (s) {
        try {
          /* « latest wins » : si une frame plus récente est déjà en attente,
           * cette frame-là est périmée. */
          if (S.pending && S.pending.seq > wanted) return drop("superseded", wanted);
          if (!s) return drop("unknown_session", wanted);
          if (s.state !== "open") return drop("session_not_open", wanted);
          S.sessionId = sid;
          S.takeNumber = f.takeNumber;
          S.startPlanId = f.startPlanId;
          setSessionCache(s);
          return enqueue(f);
        } catch (e) {
          return drop("transport_error", wanted);
        }
      }, function () {
        return drop("store_error", wanted);
      });
    } catch (e) {
      return drop("transport_error");
    }
  }

  function flush() {
    if (S.held) return false;
    drain();
    return true;
  }

  function setEnabled(v) { S.enabled = !!v; return S.enabled; }
  function isEnabled() { return S.enabled; }

  function stats() {
    var s = S.stats;
    return {
      submitted: s.submitted, sent: s.sent, dropped: s.dropped,
      droppedBy: JSON.parse(JSON.stringify(s.droppedBy || {})),
      recipients: s.recipients,
      nonMastersSkipped: s.nonMastersSkipped,
      otherSessionSkipped: s.otherSessionSkipped,
      selfSkipped: s.selfSkipped,
      unknownPeerSkipped: s.unknownPeerSkipped,
      notOpenSkipped: s.notOpenSkipped,
      duplicateConnsSkipped: s.duplicateConnsSkipped,
      jpegBytes: { sum: s.jpegBytesSum, min: s.jpegBytesMin, max: s.jpegBytesMax,
        avg: s.sent ? Math.round(s.jpegBytesSum / s.sent) : 0 },
      jsonBytes: { sum: s.jsonBytesSum, min: s.jsonBytesMin, max: s.jsonBytesMax,
        avg: s.sent ? Math.round(s.jsonBytesSum / s.sent) : 0 },
      sendMs: { sum: s.sendMsSum, max: s.sendMsMax,
        avg: s.sent ? Math.round(s.sendMsSum / s.sent) : 0 },
      lastSeq: s.lastSeq, lastSentAtMs: s.lastSentAtMs,
      lastDropReason: s.lastDropReason, lastDropAtMs: s.lastDropAtMs,
      pendingDepth: S.pending ? 1 : 0,
      busy: !!S.busy || !!S.held,
      enabled: S.enabled,
      runs: s.runs
    };
  }

  function view() {
    var st = stats();
    var ib = inbox();
    return {
      sessionId: S.sessionId,
      takeNumber: S.takeNumber,
      startPlanId: S.startPlanId,
      deviceId: S.deviceId,
      pendingDepth: st.pendingDepth,
      busy: st.busy,
      enabled: S.enabled,
      stats: st,
      inbox: ib && typeof ib.view === "function" ? ib.view() : null
    };
  }

  function reset() {
    S.pending = null;
    S.busy = false;
    S.held = false;
    S.stats = freshStats();
    var ib = inbox();
    if (ib && typeof ib.reset === "function") ib.reset();
    return true;
  }

  function emit(type, payload) {
    S.listeners.slice().forEach(function (fn) {
      try { fn(type, payload); } catch (e) {}
    });
  }

  /* ---------- branchement ----------
   *
   * UN SEUL abonnement au sampler, avec un aiguillage par type d'événement.
   * S'abonner trois fois à trois gestionnaires qui ignorent le type donnait
   * trois « début de run » par image : les compteurs de mesure étaient
   * réinitialisés en boucle et le rapport de smoke devenait faux. Le type est
   * donc dispatché ICI, une fois.
   */
  function onSamplerMessage(type, ev) {
    if (type === "ok") { onSamplerFrame(ev); return; }
    if (type === "start") { onSamplerStart(ev); return; }
    if (type === "stop") { onSamplerStop(ev); return; }
  }

  function onSamplerFrame(ev) {
    if (!ev) return;
    S.deviceId = S.deviceId || (cfg() ? cfg().deviceId : "");
    submit({
      sessionId: ev.sessionId,
      takeNumber: takeNum(ev.takeNumber),
      startPlanId: ev.startPlanId,
      seq: ev.seq,
      capturedAt: ev.completedAt,
      mime: "image/jpeg",
      bytes: ev.bytes,
      jpegBase64: ev.base64
    }, "sampler_ok");
  }

  function onSamplerStart(ev) {
    if (!ev) return;
    /* Nouveau REC : on remet les compteurs à zéro pour que la mesure du smoke
     * porte sur UN run, pas sur la vie du device. */
    S.stats = freshStats();
    S.stats.runs = (S.stats.runs || 0) + 1;
    S.sessionId = ev.sessionId || "";
    S.takeNumber = takeNum(ev.takeNumber);
    S.startPlanId = ev.startPlanId || "";
    S.pending = null;
    S.busy = false;
    log("PREVIEW_FRAME_RUN_START sessionId=" + S.sessionId + " take=" + (S.takeNumber === null ? "—" : S.takeNumber)
      + " startPlanId=" + (S.startPlanId || "—"));
    emit("run_start", { sessionId: S.sessionId, takeNumber: S.takeNumber });
  }

  function onSamplerStop(ev) {
    var st = stats();
    log("PREVIEW_FRAME_RUN_STOP sessionId=" + (S.sessionId || "—")
      + " take=" + (S.takeNumber === null ? "—" : S.takeNumber)
      + " sent=" + st.sent + " dropped=" + st.dropped
      + " recipients=" + st.recipients
      + " jpegAvgBytes=" + st.jpegBytes.avg + " jsonAvgBytes=" + st.jsonBytes.avg
      + " sendAvgMs=" + st.sendMs.avg);
    emit("run_stop", { sessionId: S.sessionId, stats: st });
  }

  function masterIn(session, did) {
    if (!session || !did) return false;
    return (session.masters || []).some(function (m) { return m && m.deviceId === did; });
  }

  /* Porte de réception, côté MASTER : « suis-je Master de CETTE session ? ».
   *
   * Elle est fermée par défaut. Une session non présente en cache est vérifiée
   * dans le store ; sans store, ou si le store échoue, la réponse est NON. Une
   * porte ouverte par défaut accepterait le `preview_frame` que n'importe quel
   * peer connected pourrait annoncer avec un `sessionId` quelconque — donc
   * diffuser des images d'une session tierce. Le rôle est une information de
   * session, pas une hypothèse de protocole. */
  function isMasterOf(sessionId) {
    var c = cfg();
    var did = c ? c.deviceId : "";
    if (!did || !sessionId) return false;
    var cached = sessionCache;
    if (cached && cached.sessionId === sessionId) return masterIn(cached, did);
    var st = store();
    if (!st || typeof st.get !== "function") return false;
    try {
      return Promise.resolve(st.get(sessionId)).then(function (s) {
        return masterIn(s, did);
      }, function () {
        return false;
      });
    } catch (e) {
      return false;
    }
  }

  function bind() {
    if (S.bound) return Promise.resolve(view());
    S.bound = true;
    var c = cfg();
    S.deviceId = c ? c.deviceId : "";

    var ib = inbox();
    if (ib && typeof ib.bind === "function") {
      ib.bind({ deviceId: S.deviceId }, isMasterOf);
    }
    var w = ws();
    if (w && typeof w.setPreviewBridge === "function") {
      w.setPreviewBridge({
        onPreviewFrame: function (e) {
          var box = inbox();
          if (!box) return null;
          return box.accept(e);
        }
      });
    }
    var smp = sampler();
    if (smp && typeof smp.onEvent === "function") {
      smp.onEvent(onSamplerMessage);
    }
    log("PREVIEW_FRAME_READY deviceId=" + (S.deviceId || "—")
      + " pendingSlot=1 policy=latest_frame_wins");
    return Promise.resolve(view());
  }

  global.MultiCamPreviewTransport = {
    bind: bind,
    submit: submit,
    flush: flush,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    stats: stats,
    view: view,
    reset: reset,
    jpegSize: jpegSize,
    onEvent: function (fn) {
      if (typeof fn === "function" && S.listeners.indexOf(fn) < 0) S.listeners.push(fn);
    },
    /* Crochet de test : simule un transport occupé (le slot d'attente reste
     * occupé, rien ne part). `flush()` après relâche. */
    __test_hold: function (v) { S.held = !!v; return S.held; }
  };
})(window);
