/* MultiCam - cadrage continu lie aux sessions ouvertes.
 * Une Capture publie des JPEG tant que sa camera native est prete, meme
 * avant REC et apres STOP. Le recorder et les transferts restent independants.
 * Aucune boucle supplementaire: signaux session, camera et START existants.
 */
(function (global) {
  "use strict";
  var S = { bound: false, did: "", busy: false, pending: false, lastSignal: "" };
  function log(s) { try { global.console.log(s); } catch (e) {} }
  function smp() { return global.MultiCamPreviewSampler; }
  function cam() { return global.MultiCamCameraRecord; }
  function store() { return global.MultiCamSessionStore; }

  function chosen(list) {
    var best = null;
    (list || []).forEach(function (ses) {
      if (!ses || ses.state !== "open" || !ses.sessionId) return;
      if (!(ses.members || []).some(function (m) { return m && m.deviceId === S.did; })) return;
      var takes = ses.takes || [];
      var take = takes.length ? takes[takes.length - 1] : null;
      if (!take || !Array.isArray(take.captures) || take.captures.indexOf(S.did) < 0) return;
      if (!(typeof take.takeNumber === "number" && take.takeNumber > 0)) return;
      if (!best || (ses.updatedAtMs || 0) > (best.session.updatedAtMs || 0))
        best = { session: ses, take: take };
    });
    return best;
  }

  function reconcile(reason) {
    if (!S.bound || !smp() || !store() || typeof store().list !== "function")
      return Promise.resolve(false);
    if (S.busy) { S.pending = true; return Promise.resolve(false); }
    S.busy = true;
    return Promise.resolve().then(function () { return store().list(); }).then(function (sessions) {
      var target = chosen(sessions);
      var v = smp().view();
      var cv = cam() && cam().view ? cam().view() : null;
      var pv = global.MultiCamPreviewService && global.MultiCamPreviewService.view
        ? global.MultiCamPreviewService.view() : null;

      if (!target || !cv || !cv.prepared || !pv || !pv.foreground || !pv.captureEnabled) {
        if (v.running && v.previewOnly) smp().stop("framing_unavailable:" + reason);
        return false;
      }
      /* REC est exclusivement pilote par start-service a l'accuse natif.
       * Ne jamais remplacer un sampler REC ou appeler MediaRecorder ici. */
      if (cv.recording || (v.running && !v.previewOnly)) return false;
      var start = global.MultiCamStartService;
      var sv = start && start.view ? start.view() : null;
      if (sv && sv.active && sv.sid === target.session.sessionId && sv.phase === "REC")
        return false;

      if (v.running && v.previewOnly &&
          v.sessionId === target.session.sessionId &&
          Number(v.takeNumber) === target.take.takeNumber) return true;

      var started = smp().start({
        sessionId: target.session.sessionId,
        takeNumber: target.take.takeNumber,
        startPlanId: "",
        previewOnly: true,
        reason: "framing_" + (reason || "change")
      });
      if (started) log("FRAMING_START sessionId=" + target.session.sessionId +
        " take=" + target.take.takeNumber + " deviceId=" + S.did);
      return started;
    }).catch(function (err) {
      log("FRAMING_RECONCILE_ERROR reason=" + reason + " error=" +
        String((err && err.message) || err));
      return false;
    }).then(function (result) {
      S.busy = false;
      if (S.pending) {
        S.pending = false;
        reconcile("coalesced");
      }
      return result;
    });
  }

  function observeStart() {
    var svc = global.MultiCamStartService;
    if (!svc || typeof svc.onView !== "function") return;
    svc.onView(function () {
      var v = svc.view ? svc.view() : {};
      var cv = cam() && cam().view ? cam().view() : {};
      var sv = smp() && smp().view ? smp().view() : {};
      var signal = [v.sid || "", v.phase || "", cv.recording ? "1" : "0",
        cv.prepared ? "1" : "0", sv.running ? "1" : "0",
        sv.previewOnly ? "1" : "0"].join("|");
      if (signal === S.lastSignal) return;
      S.lastSignal = signal;
      reconcile("start_state");
    });
  }

  function bind(cfg) {
    if (S.bound) return Promise.resolve(true);
    var c = cfg || (global.MultiCamConfig && global.MultiCamConfig.get
      ? global.MultiCamConfig.get() : {}) || {};
    if (!c.deviceId) return Promise.resolve(false);
    S.did = c.deviceId;
    S.bound = true;
    var ws = global.MultiCamSessionWs;
    if (ws && typeof ws.onChanged === "function") {
      ws.onChanged(function () { reconcile("session_changed"); });
    }
    var ps = global.MultiCamPreviewService;
    if (ps && typeof ps.onView === "function") {
      ps.onView(function () { reconcile("camera_ready"); });
    }
    if (global.document && typeof global.document.addEventListener === "function") {
      global.document.addEventListener("resume", function () { reconcile("resume"); }, false);
    }
    observeStart();
    log("FRAMING_READY deviceId=" + S.did);
    return reconcile("boot");
  }

  global.MultiCamPreviewFramingService = {
    bind: bind,
    reconcile: reconcile,
    chosen: chosen
  };
})(window);
