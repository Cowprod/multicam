/* MultiCam — J09-03 : ÉCHANTILLONNEUR DE PREVIEW PÉRIODIQUE pendant REC.
 *
 * Producteur LOCAL d'images de preview à ~1 img/s, via PixelCopy, pour un device
 * Capture en enregistrement. Cette mission qualifie le PRODUCTEUR ; elle ne
 * transporte RIEN sur le réseau (le transport WS du JPEG est une mission
 * ultérieure, J09-04).
 *
 * ---------- POURQUOI UN SERVICE, ET PAS UN setInterval DANS L'UI ----------
 *
 * La cadence n'est pas une tâche d'affichage : elle doit survivre à un
 * changement d'écran (07 → 08), être pilotée par la phase du START, s'arrêter
 * quand la caméra disparaît, et ne jamais doubler une capture encore en vol.
 * Tout cela est de la logique de cycle de vie, pas de rendu. L'écran ne fait
 * qu'afficher `view()`.
 *
 * ---------- RÈGLE DE CYCLE DE VIE (mission J09-03) ----------
 *
 * La boucle ne tourne QUE si TOUTES ces conditions sont réunies :
 *
 *   1. phase = REC              → `MultiCamCameraRecord.view().recording`
 *   2. preview native active    → `.prepared` (la SurfaceView existe)
 *   3. PixelCopy disponible     → méthode native présente
 *   4. au premier plan           → `preview-service.view().foreground`
 *
 * Elle s'arrête donc sur : sortie de REC, device STOPPED, caméra/preview
 * indisponible, passage en arrière-plan AU MOMENT où la caméra est libérée,
 * ou changement de session/Take. Elle ne tourne PAS simplement parce que la
 * preview permanente est ouverte sur l'accueil : sans REC, `start()` est refusé.
 *
 * Note d'arbitrage sur l'arrière-plan : §35.1 diffère la libération de la
 * caméra pendant un REC (le STOP global est une décision de J10). La caméra
 * reste donc VIVANTE en arrière-plan pendant l'enregistrement ; le sampler
 * continue, ce qui est le comportement voulu (un device Capture rangé dans une
 * poche doit encore alimenter la mosaïque). Il s'arrête dès que `prepared`
 * passe à false — c'est le cas qui compte vraiment.
 *
 * ---------- ANTI-CONCURRENCE (deux verrous distincts) ----------
 *
 *   - UN SEUL `setTimeout` de planification, replanifié après chaque cycle
 *     (jamais deux timers) ;
 *   - `inFlight` : si la capture précédente n'est pas revenue, le tick compte
 *     un SKIP et ne lance RIEN. Ce verrou survit à un `stop()`/`start()` : un
 *     PixelCopy natif déjà lancé ne peut pas être annulé, donc on ne relance
 *     jamais par-dessus. C'est la garantie « 0 capture concurrente ».
 *
 * ---------- CADENCE SANS DÉRIVE ----------
 *
 * Les échéances sont ancrées sur `startedAtMs + n * intervalMs`, pas
 * accumulées par `now + interval` à chaque tick : la latence de PixelCopy
 * (~90 ms) ne s'accumule donc pas et la cadence ne dérive pas. Si un cycle
 * dépasse l'intervalle, l'échéance suivante est déjà échue et le tick
 * correspondant est rattrapé sans former de backlog infini.
 *
 * ---------- GARDE-FOU NATIF ----------
 *
 * `capturePreviewSurface` ne garantit AUCUN callback : si la SurfaceView est
 * invalide, le natif appelle l'erreur, mais une perte de callback est
 * théoriquement possible. Un chien de garde libère donc le verrou après
 * `CALLBACK_TIMEOUT_MS` et compte l'absence, sinon la boucle se bloquerait
 * définitivement et le nombre de captures s'arrêterait sans trace.
 *
 * ---------- QUALITÉ ----------
 *
 * `QUALITY = 60` : c'est la valeur effectivement qualifiée au lab
 * (tests/plugin-lab, `TEST.SNAPSHOT_QUALITY`, run d'endurance 300 s / 300 OK).
 * Le natif n'est pas modifié pour optimiser la taille dans cette mission.
 *
 * ---------- PÉRIMÈTRE ----------
 *
 * AUCUN réseau ici. Les images ne sortent pas du device. `peek()` expose la
 * DERNIÈRE image en mémoire (une seule, remplacée à chaque succès) comme sonde
 * locale pour la future mission de transport et pour l'extraction d'échantillons
 * en validation ; ce n'est pas une archive. `samples` ne garde que de la
 * MÉTADATIQUE (jamais de base64), bornée à MAX_SAMPLES entrées.
 */

(function (global) {
  "use strict";

  var INTERVAL_MS = 1000;            /* cadence nominale entre demandes */
  var QUALITY = 60;                  /* valeur qualifiée au lab */
  var CALLBACK_TIMEOUT_MS = 2500;    /* absence de callback = erreur tracée */
  var MAX_SAMPLES = 400;             /* métadonnées bornées (sans base64) */

  var S = {
    running: false,
    bound: false,
    foreground: true,
    sessionId: "",
    takeNumber: "",
    startPlanId: "",
    intervalMs: INTERVAL_MS,
    quality: QUALITY,
    timer: null,          /* UN SEUL timer de planification */
    inFlight: false,      /* capture native en cours */
    watchdog: null,
    seq: 0,
    runs: 0,
    startedAtMs: 0,
    nextDueAtMs: 0,
    samples: [],
    last: null,           /* { seq, base64, bytes } — SONDE, une seule image */
    stats: null,
    listeners: []
  };

  function nowMs() { return Date.now(); }
  function log(l) { console.log(l); }
  function camera() { return global.MultiCamCameraRecord || null; }
  function previewService() { return global.MultiCamPreviewService || null; }

  function freshStats() {
    return {
      requested: 0, ok: 0, error: 0, skipped: 0, noCallback: 0,
      durSum: 0, durMin: 0, durMax: 0, bytesSum: 0, bytesMin: 0, bytesMax: 0,
      lastError: "", lastErrorAtMs: 0
    };
  }
  S.stats = freshStats();

  function emit(type, payload) {
    S.listeners.slice().forEach(function (fn) {
      try { fn(type, payload); } catch (e) {}
    });
  }

  function ctx() {
    return "sessionId=" + (S.sessionId || "—") + " take=" + (S.takeNumber || "—")
      + " startPlanId=" + (S.startPlanId || "—");
  }

  /* ---------- PixelCopy ---------- */

  /* Installe le shim si le wrapper Cordova a été construit sans la méthode
   * patchée, puis renvoie le point d'entrée ou `null`. */
  function pixelcopy() {
    var shim = global.MultiCamPixelCopy;
    if (shim && typeof shim.installShim === "function") {
      try { shim.installShim(); } catch (e) {}
    }
    var cp = global.CameraPreview;
    return (cp && typeof cp.capturePreviewSurface === "function") ? cp : null;
  }

  /* Le natif renvoie du base64 brut, éventuellement enveloppé par un data URL,
   * parfois encapsulé dans un tableau (Cordova). On ne garde que le base64. */
  function normalize(data) {
    var raw = (Array.isArray(data) && data.length) ? data[0] : data;
    if (typeof raw !== "string") return "";
    if (raw.indexOf("data:image/") === 0) {
      var c = raw.indexOf(",");
      return c >= 0 ? raw.substring(c + 1) : raw;
    }
    return raw;
  }

  /* Taille décodée exacte déduite de la longueur base64 (et de son remplissage). */
  function base64Bytes(b64) {
    if (typeof b64 !== "string" || !b64.length) return 0;
    var pad = 0;
    if (b64.charAt(b64.length - 1) === "=") pad = (b64.charAt(b64.length - 2) === "=") ? 2 : 1;
    return (Math.floor(b64.length / 4) * 3) - pad;
  }

  function trackMax(prev, v) { return (prev > 0 && prev >= v) ? prev : v; }
  function trackMin(prev, v) { return (prev === 0 || v < prev) ? v : prev; }

  /* ---------- conditions de possibilité ---------- */

  function isForeground() {
    var ps = previewService();
    if (ps && typeof ps.view === "function") {
      var v = ps.view();
      if (v && typeof v.foreground === "boolean") return v.foreground;
    }
    return S.foreground;
  }

  /* Renvoie { ok, reason } — `reason` est le motif PARSABLE du refus/arrêt. */
  function gate() {
    var cam = camera();
    if (!cam || typeof cam.view !== "function") return { ok: false, reason: "recorder_unavailable" };
    var v = cam.view();
    if (!v || !v.recording) return { ok: false, reason: "not_recording" };
    if (!v.prepared) return { ok: false, reason: "preview_inactive" };
    if (!pixelcopy()) return { ok: false, reason: "pixelcopy_unavailable" };
    if (!isForeground() && !v.prepared) return { ok: false, reason: "background" };
    return { ok: true, reason: "" };
  }

  /* ---------- capture ---------- */

  function capture() {
    var cp = pixelcopy();
    if (!cp) { stop("pixelcopy_unavailable"); return; }

    var seq = ++S.seq;
    var requestedAt = nowMs();
    var sid = S.sessionId, take = S.takeNumber, planId = S.startPlanId;
    var stamp = "sessionId=" + (sid || "—") + " take=" + (take || "—") + " seq=" + seq;
    var settled = false;

    S.inFlight = true;
    S.stats.requested += 1;

    function release() {
      S.inFlight = false;
      if (S.watchdog !== null) { clearTimeout(S.watchdog); S.watchdog = null; }
    }

    /* Chien de garde : le natif ne garantit pas de callback. */
    S.watchdog = setTimeout(function () {
      if (settled) return;
      settled = true;
      var completedAt = nowMs();
      release();
      S.stats.error += 1;
      S.stats.noCallback += 1;
      S.stats.lastError = "no_callback";
      S.stats.lastErrorAtMs = completedAt;
      S.samples.push({ seq: seq, ok: false, reason: "no_callback", requestedAt: requestedAt, completedAt: completedAt, durationMs: completedAt - requestedAt });
      trimSamples();
      log("PREVIEW_CAPTURE_ERROR " + stamp + " startPlanId=" + (planId || "—")
        + " durationMs=" + (completedAt - requestedAt) + " reason=no_callback");
      emit("error", { seq: seq, reason: "no_callback", durationMs: completedAt - requestedAt, sessionId: sid, takeNumber: take });
      emit("change", view());
    }, CALLBACK_TIMEOUT_MS);

    try {
      cp.capturePreviewSurface({ quality: S.quality }, function (data) {
        if (settled) return;   /* callback tardif après chien de garde */
        settled = true;
        var completedAt = nowMs();
        var b64 = normalize(data);
        var durationMs = completedAt - requestedAt;
        release();
        if (!b64) {
          S.stats.error += 1;
          S.stats.lastError = "empty_payload";
          S.stats.lastErrorAtMs = completedAt;
          S.samples.push({ seq: seq, ok: false, reason: "empty_payload", requestedAt: requestedAt, completedAt: completedAt, durationMs: durationMs, base64Length: 0, bytes: 0 });
          trimSamples();
          log("PREVIEW_CAPTURE_ERROR " + stamp + " startPlanId=" + (planId || "—")
            + " durationMs=" + durationMs + " reason=empty_payload");
          emit("error", { seq: seq, reason: "empty_payload", durationMs: durationMs, sessionId: sid, takeNumber: take });
          emit("change", view());
          return;
        }
        var bytes = base64Bytes(b64);
        S.stats.ok += 1;
        S.stats.durSum += durationMs;
        S.stats.durMin = trackMin(S.stats.durMin, durationMs);
        S.stats.durMax = trackMax(S.stats.durMax, durationMs);
        S.stats.bytesSum += bytes;
        S.stats.bytesMin = trackMin(S.stats.bytesMin, bytes);
        S.stats.bytesMax = trackMax(S.stats.bytesMax, bytes);
        /* Sonde locale : UNE image, remplacée à chaque succès (pas d'archive). */
        S.last = { seq: seq, base64: b64, bytes: bytes, completedAt: completedAt };
        S.samples.push({ seq: seq, ok: true, requestedAt: requestedAt, completedAt: completedAt, durationMs: durationMs, base64Length: b64.length, bytes: bytes });
        trimSamples();
        log("PREVIEW_CAPTURE_OK " + stamp + " startPlanId=" + (planId || "—")
          + " durationMs=" + durationMs + " bytes=" + bytes + " base64Length=" + b64.length);
        emit("ok", { seq: seq, durationMs: durationMs, bytes: bytes, base64Length: b64.length, base64: b64, sessionId: sid, takeNumber: take, startPlanId: planId, capturedAt: completedAt, completedAt: completedAt });
        emit("change", view());
      }, function (e) {
        if (settled) return;
        settled = true;
        var completedAt = nowMs();
        var durationMs = completedAt - requestedAt;
        var reason = String(e);
        release();
        S.stats.error += 1;
        S.stats.lastError = reason;
        S.stats.lastErrorAtMs = completedAt;
        S.samples.push({ seq: seq, ok: false, reason: reason, requestedAt: requestedAt, completedAt: completedAt, durationMs: durationMs });
        trimSamples();
        log("PREVIEW_CAPTURE_ERROR " + stamp + " startPlanId=" + (planId || "—")
          + " durationMs=" + durationMs + " reason=" + reason);
        emit("error", { seq: seq, reason: reason, durationMs: durationMs, sessionId: sid, takeNumber: take });
        emit("change", view());
      });
    } catch (e) {
      /* Une exception synchrone ne doit pas casser la boucle : on la trace
       * comme une erreur et on repart au tick suivant. */
      if (!settled) {
        settled = true;
        var completedAt = nowMs();
        var durationMs = completedAt - requestedAt;
        var reason = "throw:" + String((e && e.message) || e);
        release();
        S.stats.error += 1;
        S.stats.lastError = reason;
        S.stats.lastErrorAtMs = completedAt;
        log("PREVIEW_CAPTURE_ERROR " + stamp + " startPlanId=" + (planId || "—")
          + " durationMs=" + durationMs + " reason=" + reason);
        emit("error", { seq: seq, reason: reason, durationMs: durationMs, sessionId: sid, takeNumber: take });
        emit("change", view());
      }
    }
  }

  function trimSamples() {
    if (S.samples.length > MAX_SAMPLES) S.samples.splice(0, S.samples.length - MAX_SAMPLES);
  }

  /* ---------- planification ---------- */

  function scheduleNext() {
    if (!S.running) return;
    var delay = S.nextDueAtMs - nowMs();
    if (delay < 0) delay = 0;
    S.timer = setTimeout(tick, delay);
  }

  function tick() {
    S.timer = null;
    if (!S.running) return;
    /* Ancrage fixe : l'échéance avance d'exactement un intervalle, la latence
     * de la capture précédente n'entre pas dans le calcul. */
    S.nextDueAtMs += S.intervalMs;

    var g = gate();
    if (!g.ok) { stop(g.reason); return; }

    if (S.inFlight) {
      S.stats.skipped += 1;
      log("PREVIEW_CAPTURE_SKIP " + ctx() + " seq=" + (S.seq + 1) + " reason=capture_in_flight");
      emit("skip", { reason: "capture_in_flight", sessionId: S.sessionId, takeNumber: S.takeNumber });
      emit("change", view());
      scheduleNext();
      return;
    }

    capture();
    scheduleNext();
  }

  /* ---------- API ---------- */

  /* Démarre la boucle. Idempotent pour une MÊME cible : un second `start()`
   * pendant un REC déjà échantillonné ne crée pas de second timer. */
  function start(opts) {
    opts = opts || {};
    var sid = opts.sessionId || "";
    var take = (opts.takeNumber == null) ? "" : String(opts.takeNumber);

    if (S.running && S.sessionId === sid && S.takeNumber === take) {
      log("PREVIEW_CAPTURE_START " + ctx() + " status=SKIPPED reason=already_running");
      return false;
    }
    if (S.running) stop("restart:" + (opts.reason || "new_take"));

    var g = gate();
    if (!g.ok) {
      log("PREVIEW_CAPTURE_START sessionId=" + (sid || "—") + " take=" + (take || "—")
        + " status=REFUSED reason=" + g.reason);
      return false;
    }

    S.sessionId = sid;
    S.takeNumber = take;
    S.startPlanId = opts.startPlanId || "";
    S.intervalMs = (typeof opts.intervalMs === "number" && opts.intervalMs > 0) ? opts.intervalMs : INTERVAL_MS;
    S.quality = (typeof opts.quality === "number") ? opts.quality : QUALITY;
    S.seq = 0;
    S.runs += 1;
    S.stats = freshStats();
    S.samples = [];
    S.running = true;
    S.startedAtMs = nowMs();
    S.nextDueAtMs = S.startedAtMs + S.intervalMs;

    log("PREVIEW_CAPTURE_START " + ctx()
      + " status=OK intervalMs=" + S.intervalMs + " quality=" + S.quality
      + " atMs=" + S.startedAtMs);

    /* Première image immédiate (le premier frame du REC n'a pas à attendre
     * un intervalle), puis cadence ancrée. */
    capture();
    scheduleNext();
    emit("start", { sessionId: sid, takeNumber: take, startPlanId: S.startPlanId, atMs: S.startedAtMs });
    emit("change", view());
    return true;
  }

  /* Arrêt PROPRE et IDEMPOTENT : plus jamais aucun timer, donc plus aucune
   * capture demandée. Le verrou `inFlight` n'est volontairement PAS forcé : un
   * PixelCopy natif lancé ne s'annule pas, et le relâcher ici autoriserait une
   * capture concurrente au prochain `start()`. */
  function stop(reason) {
    if (S.timer !== null) { clearTimeout(S.timer); S.timer = null; }
    if (!S.running) return false;
    S.running = false;
    var runMs = S.startedAtMs ? (nowMs() - S.startedAtMs) : 0;
    var st = S.stats;
    log("PREVIEW_CAPTURE_STOP " + ctx()
      + " reason=" + (reason || "—")
      + " seq=" + S.seq + " requested=" + st.requested + " ok=" + st.ok
      + " error=" + st.error + " skipped=" + st.skipped
      + " inFlight=" + (S.inFlight ? 1 : 0) + " runMs=" + runMs);
    emit("stop", { reason: reason || "", sessionId: S.sessionId, takeNumber: S.takeNumber, seq: S.seq, runMs: runMs, stats: view().stats });
    emit("change", view());
    S.last = null;      /* la sonde n'est pas conservée après l'arrêt */
    return true;
  }

  /* Réconciliation DÉFENSIVE : à appeler à chaque changement d'état externe
   * (phase, preview, foreground). Arrête si une condition de la règle de cycle
   * de vie n'est plus réunie. */
  function sync(reason) {
    if (!S.running) return false;
    var g = gate();
    if (!g.ok) {
      log("PREVIEW_CAPTURE_SYNC " + ctx() + " trigger=" + (reason || "—") + " action=stop reason=" + g.reason);
      return stop(g.reason);
    }
    return true;
  }

  function view() {
    var st = S.stats;
    var avgDur = st.ok ? Math.round(st.durSum / st.ok) : 0;
    var avgBytes = st.ok ? Math.round(st.bytesSum / st.ok) : 0;
    var runMs = S.running && S.startedAtMs ? (nowMs() - S.startedAtMs) : 0;
    return {
      running: S.running,
      inFlight: S.inFlight,
      sessionId: S.sessionId,
      takeNumber: S.takeNumber,
      startPlanId: S.startPlanId,
      intervalMs: S.intervalMs,
      quality: S.quality,
      runs: S.runs,
      seq: S.seq,
      runMs: runMs,
      timerPending: S.timer !== null,
      avgDurationMs: avgDur,
      avgBytes: avgBytes,
      stats: {
        requested: st.requested, ok: st.ok, error: st.error, skipped: st.skipped,
        noCallback: st.noCallback, lastError: st.lastError,
        durMin: st.durMin, durMax: st.durMax,
        bytesMin: st.bytesMin, bytesMax: st.bytesMax
      },
      samples: S.samples.slice()
    };
  }

  /* Sonde locale : la DERNIÈRE image réussie, ou null. Une seule image en
   * mémoire, jamais une archive — c'est le point d'entrée de la future mission
   * de transport, et le moyen d'extraire des échantillons en validation. */
  function peek() { return S.last; }

  function reset() {
    stop("reset");
    S.samples = [];
    S.stats = freshStats();
    S.seq = 0;
    S.runs = 0;
    S.startedAtMs = 0;
    S.nextDueAtMs = 0;
    return true;
  }

  function bind() {
    if (S.bound) return Promise.resolve(view());
    S.bound = true;
    var d = global.document;
    if (d && typeof d.addEventListener === "function") {
      d.addEventListener("pause", function () {
        S.foreground = false;
        sync("pause");
      }, false);
      d.addEventListener("resume", function () {
        S.foreground = true;
        sync("resume");
      }, false);
    }
    var ps = previewService();
    if (ps && typeof ps.onView === "function") {
      ps.onView(function () { sync("preview_view"); });
    }
    return Promise.resolve(view());
  }

  global.MultiCamPreviewSampler = {
    INTERVAL_MS: INTERVAL_MS,
    QUALITY: QUALITY,
    CALLBACK_TIMEOUT_MS: CALLBACK_TIMEOUT_MS,
    MAX_SAMPLES: MAX_SAMPLES,
    bind: bind,
    start: start,
    stop: stop,
    sync: sync,
    view: view,
    peek: peek,
    reset: reset,
    gate: gate,
    onEvent: function (fn) {
      if (typeof fn === "function" && S.listeners.indexOf(fn) < 0) S.listeners.push(fn);
    },
    offEvent: function (fn) {
      var i = S.listeners.indexOf(fn);
      if (i >= 0) S.listeners.splice(i, 1);
    }
  };
})(window);
