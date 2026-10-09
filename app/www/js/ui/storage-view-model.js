/* MultiCam J11 — projection PURE de la vue Storage (`ui/07-countdown/storage.html`).
 *
 * La vue Storage validée suit PLUSIEURS sessions et plusieurs Takes, groupés par
 * session (activité récente en tête), chaque Take repliable, avec des devices
 * (Captures) et leurs segments. Cette projection transforme des DONNÉES BRUTES
 * (sessions du store + vues transfert/phase) en un modèle de rendu déterministe.
 *
 * Elle est SANS DOM et SANS effet de bord : elle CONSOMME l'état existant
 * (`transferFor` par Take, `phaseFor` par Take), elle ne tient pas de second
 * modèle d'état. C'est la vue DOM (`ui/storage-view.js`) qui l'affiche.
 *
 * Sources de vérité : `ui/07-countdown/README.md` + `storage.html` (VALIDÉS),
 * et le modèle transfert (`transfer-model.js` : états pending/transferring/
 * verifying/done/error ; `files` = segments d'une Capture). */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.MultiCamStorageViewModel = factory();
  }
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var UNITS = ["o", "Ko", "Mo", "Go", "To"];

  var PHASE_PREPARATION = "PREPARATION";
  var PHASE_ARM = "ARM";
  var PHASE_COUNTDOWN = "COUNTDOWN";
  var PHASE_REC = "REC";
  var PHASE_TRANSFER = "STOPPED";   /* Take terminé, réplication en cours */
  var PHASE_COMPLETE = "COMPLET";
  var PHASE_ERROR = "ERROR";

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  function splitBytes(n) {
    if (!isNum(n) || n <= 0) return { value: "0", unit: "o" };
    var i = 0, v = n;
    while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
    var dec = (v >= 100 || i === 0) ? 0 : 1;
    return { value: v.toFixed(dec).replace(".", ","), unit: UNITS[i] };
  }

  function formatBytes(n) {
    var s = splitBytes(n);
    return s.value + " " + s.unit;
  }

  /* "1,8 / 2,6 Go" (unité factorisée) — jamais deux fois la même unité. */
  function progressPair(bytes, total) {
    var a = splitBytes(bytes), b = splitBytes(total);
    if (a.unit === b.unit) return a.value + " / " + b.value + " " + b.unit;
    return a.value + " " + a.unit + " / " + b.value + " " + b.unit;
  }

  function pad3(n) { n = Math.max(0, Math.floor(n || 0)); return ("000" + n).slice(-3); }

  function mmss(ms) {
    var sec = Math.max(0, Math.floor((isNum(ms) ? ms : 0) / 1000));
    var m = Math.floor(sec / 60), s = sec % 60;
    return ("0" + m).slice(-2) + ":" + ("0" + s).slice(-2);
  }

  function stateStyle(state) {
    if (state === "done") return "text-success";
    if (state === "error") return "text-danger";
    if (state === "verifying") return "text-info";
    if (state === "transferring") return "text-warning";
    return "muted";
  }

  function stateText(state) {
    if (state === "done") return "Reçu · vérifié";
    if (state === "error") return "Erreur";
    if (state === "verifying") return "Vérification";
    if (state === "transferring") return "Transfert";
    return "En attente";
  }

  /* Indexe les transferts d'UN Storage : sourceDeviceId -> transfert. */
  function indexTransfers(transferView, self) {
    var out = {};
    var transfers = (transferView && transferView.transfers) || {};
    Object.keys(transfers).forEach(function (k) {
      var t = transfers[k];
      if (!t || t.storageDeviceId !== self) return;
      out[t.sourceDeviceId] = t;
    });
    return out;
  }

  function nameMap(session) {
    var out = {};
    var members = (session && session.members) || [];
    members.forEach(function (m) {
      if (!m || !m.deviceId) return;
      out[m.deviceId] = m.deviceName || m.deviceId;
    });
    return out;
  }

  function segmentOf(f, i) {
    var total = isNum(f.bytes) ? f.bytes : 0;
    var received = isNum(f.received) ? Math.min(f.received, total) : 0;
    var pct = total > 0 ? Math.min(100, Math.floor((received * 100) / total)) : 0;
    var known = total > 0;
    return {
      rel: f.rel, segmentIndex: isNum(f.segmentIndex) ? f.segmentIndex : i,
      label: "Segment " + ((isNum(f.segmentIndex) ? f.segmentIndex : i) + 1),
      state: f.state, stateText: stateText(f.state), stateClass: stateStyle(f.state),
      bytes: received, total: total, sizeKnown: known, percent: pct,
      progressText: known ? (progressPair(received, total) + " · " + pct + "%") : ""
    };
  }

  function deviceOf(deviceId, name, transfer) {
    var out = {
      deviceId: deviceId, name: name || deviceId,
      state: "pending", stateText: "En attente", stateClass: "muted",
      received: false, sizeKnown: false, bytes: 0, total: 0, percent: 0,
      progressText: "", segments: []
    };
    if (!transfer) return out;
    var total = isNum(transfer.total) ? transfer.total : 0;
    var bytes = isNum(transfer.bytes) ? Math.min(transfer.bytes, total) : 0;
    var pct = isNum(transfer.percent) ? transfer.percent : (total > 0 ? Math.min(100, Math.floor((bytes * 100) / total)) : 0);
    var known = total > 0;
    out.state = transfer.state;
    out.stateText = stateText(transfer.state);
    out.stateClass = stateStyle(transfer.state);
    out.received = transfer.state === "done";
    out.sizeKnown = known;
    out.bytes = bytes; out.total = total; out.percent = pct;
    /* Progression QUALITATIVE avant taille connue, puis octets + %. */
    out.progressText = known
      ? (progressPair(bytes, total) + " · " + pct + "%")
      : (transfer.state === "transferring" || transfer.state === "verifying" ? "Transfert" : "");
    out.segments = (transfer.files || []).map(segmentOf);
    return out;
  }

  function normalizePhase(raw) {
    if (!raw) return null;
    var p = raw.phase;
    if (p === "COUNTDOWN") return { phase: PHASE_COUNTDOWN, digit: isNum(raw.digit) ? raw.digit : 0 };
    if (p === "REC") return { phase: PHASE_REC, recStartedAtMs: raw.recStartedAtMs || 0, recElapsedMs: raw.recElapsedMs || 0 };
    if (p === "EXCLUDED") return { phase: PHASE_ERROR };
    if (p === "STOPPED") return { phase: PHASE_TRANSFER };
    if (p === "IDLE") return { phase: PHASE_PREPARATION };
    return null;
  }

  /* Phase du Take : l'état START actif prime (Countdown/REC) ; sinon on dérive
   * la phase de l'ÉTAT DES TRANSFERTS (jamais inventée). */
  function derivePhase(rawPhase, anyError, allDone, anyActivity) {
    var n = normalizePhase(rawPhase);
    if (n && (n.phase === PHASE_COUNTDOWN || n.phase === PHASE_REC)) return n;
    if (n && n.phase === PHASE_ERROR) return n;
    if (anyError) return { phase: PHASE_ERROR };
    if (allDone) return { phase: PHASE_COMPLETE };
    if (anyActivity) return { phase: PHASE_TRANSFER };
    return { phase: PHASE_PREPARATION };
  }

  function badgeFor(phase, nowMs) {
    if (phase.phase === PHASE_COUNTDOWN) return { cls: "text-bg-danger", text: String(phase.digit || ""), kind: "countdown" };
    if (phase.phase === PHASE_REC) {
      var ms = phase.recElapsedMs || (phase.recStartedAtMs ? (nowMs - phase.recStartedAtMs) : 0);
      return { cls: "text-bg-danger", text: "REC " + mmss(ms), kind: "rec" };
    }
    if (phase.phase === PHASE_ERROR) return { cls: "text-bg-danger", text: "Erreur", kind: "error" };
    if (phase.phase === PHASE_COMPLETE) return { cls: "bg-success", text: "Complet", kind: "done" };
    if (phase.phase === PHASE_TRANSFER) return { cls: "text-bg-warning", text: "Transfert", kind: "transfer" };
    if (phase.phase === PHASE_ARM) return { cls: "text-bg-info", text: "ARM", kind: "arm" };
    return { cls: "text-bg-secondary", text: "Préparation", kind: "prep" };
  }

  function takeOf(sid, take, self, members, transfersFor, phaseFor, nowMs, collapsed) {
    var takeNumber = take.takeNumber || 0;
    var key = sid + "|" + takeNumber;
    var byDevice = indexTransfers(transfersFor(sid, takeNumber), self);
    var captures = Array.isArray(take.captures) ? take.captures.slice() : [];

    var devices = captures.map(function (did) {
      return deviceOf(did, members[did], byDevice[did]);
    });
    var expected = devices.length;
    var received = devices.filter(function (d) { return d.received; }).length;
    var anyError = devices.some(function (d) { return d.state === "error"; });
    var anyActivity = Object.keys(byDevice).length > 0;
    var allDone = expected > 0 && devices.every(function (d) { return d.received; });

    var phase = derivePhase(phaseFor(sid, takeNumber), anyError, allDone, anyActivity);
    var badge = badgeFor(phase, nowMs);

    return {
      sessionId: sid, takeNumber: takeNumber, key: key,
      label: "Take " + pad3(takeNumber),
      open: collapsed[key] === true ? false : (collapsed[key] === false ? true : false),
      phase: phase.phase,
      badge: badge,
      openLabel: phase.phase === PHASE_REC ? "Enregistrement en cours" : (phase.phase === PHASE_TRANSFER ? "Réplication en cours" : ""),
      expectedDevices: expected,
      receivedDevices: received,
      hasActivity: anyActivity,
      showExpected: !anyActivity && expected > 0,
      expectedText: expected + (expected > 1 ? " devices attendus" : " device attendu"),
      summaryText: anyActivity ? (received + "/" + expected + " reçus") : "Storage sélectionné",
      devices: devices
    };
  }

  function storageInfo(si) {
    si = si || {};
    var freeBytes = isNum(si.freeBytes) ? si.freeBytes : 0;
    var net = si.networkType || "";
    return {
      name: si.name || "",
      freeBytes: freeBytes,
      freeText: freeBytes > 0 ? (formatBytes(freeBytes) + " libres") : "",
      networkType: net,
      networkText: net === "wifi" ? "Wi-Fi" : (net === "ethernet" ? "Ethernet" : ""),
      wifiQuality: si.wifiQuality || ""
    };
  }

  /* build(input) — projection pure.
   *   input.sessions     : sessions du store (avec takes, members, updatedAtMs)
   *   input.self         : deviceId du Storage courant
   *   input.transfersFor : (sid, takeNumber) => vue transfert ou null
   *   input.phaseFor     : (sid, takeNumber) => { phase, digit, recStartedAtMs… } ou null
   *   input.storageInfo  : { name, freeBytes, networkType, wifiQuality }
   *   input.collapsed    : { sid|take -> bool } (état replié de l'UI)
   *   input.nowMs        : horloge injectée (timers REC) */
  function build(input) {
    input = input || {};
    var self = input.self || "";
    var nowMs = isNum(input.nowMs) ? input.nowMs : Date.now();
    var collapsed = input.collapsed || {};
    var transfersFor = input.transfersFor || function () { return null; };
    var phaseFor = input.phaseFor || function () { return null; };
    var sessions = Array.isArray(input.sessions) ? input.sessions.slice() : [];

    /* Un Storage ne suit que les Takes auxquels il est RATTACHÉ (sélection
     * `take.storages`). Aucune invention : un Take sans ce Storage n'est pas de
     * sa responsabilité. `storageOnly:false` lève le filtre (tests/API). */
    var storageOnly = input.storageOnly !== false;
    function belongs(t) {
      if (!storageOnly || !self) return true;
      return (t.storages || []).indexOf(self) >= 0;
    }

    var sorted = sessions.map(function (s) {
      var takes = Array.isArray(s.takes) ? s.takes.filter(belongs) : [];
      var activity = isNum(s.updatedAtMs) ? s.updatedAtMs : 0;
      takes.forEach(function (t) { if (t && isNum(t.updatedAtMs) && t.updatedAtMs > activity) activity = t.updatedAtMs; });
      return { s: s, activity: activity, takes: takes };
    }).filter(function (e) { return e.takes.length > 0 || !storageOnly || !self; })
      .sort(function (a, b) { return b.activity - a.activity; });

    var groups = sorted.map(function (e, idx) {
      var s = e.s;
      var sid = s.sessionId || "";
      var members = nameMap(s);
      var takes = e.takes.slice()
        .sort(function (a, b) { return (b.takeNumber || 0) - (a.takeNumber || 0); });
      return {
        sessionId: sid,
        name: s.name || "Session",
        activityMs: e.activity,
        activityText: idx === 0 ? "activité récente" : "activité antérieure",
        open: collapsed[sid] === true ? false : (collapsed[sid] === false ? true : idx === 0),
        takes: takes.map(function (t) {
          return takeOf(sid, t, self, members, transfersFor, phaseFor, nowMs, collapsed);
        })
      };
    });

    return { self: self, storage: storageInfo(input.storageInfo), sessions: groups };
  }

  return {
    PHASE_PREPARATION: PHASE_PREPARATION,
    PHASE_ARM: PHASE_ARM,
    PHASE_COUNTDOWN: PHASE_COUNTDOWN,
    PHASE_REC: PHASE_REC,
    PHASE_TRANSFER: PHASE_TRANSFER,
    PHASE_COMPLETE: PHASE_COMPLETE,
    PHASE_ERROR: PHASE_ERROR,
    formatBytes: formatBytes,
    progressPair: progressPair,
    mmss: mmss,
    stateText: stateText,
    stateStyle: stateStyle,
    build: build
  };
});
