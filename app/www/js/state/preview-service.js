/* MultiCam — service de cycle de vie de la PREVIEW CAMÉRA LOCALE (J09 §35.1).
 *
 * Décision produit appliquée (MULTICAM_DECISIONS_REFERENCE.md §35.1) :
 * sur un device dont la skill Capture est activée et disponible, la preview
 * caméra locale est le FOND PERMANENT de l'application tant que celle-ci est au
 * premier plan. Elle n'est plus bornée au countdown ni au REC.
 *
 * ---------- POURQUOI UN SERVICE DISTINCT ----------
 *
 * Avant J09, l'ouverture de la caméra était une conséquence du plan de START
 * (`start-service.requestStart` → `prepareCapture`). C'était un effet de bord
 * d'un protocole, ce qui :
 *   - la rendait invisible sur les écrans 01 à 06 (aucun plan, donc pas de
 *     caméra) ;
 *   - liait sa durée de vie à celle d'un plan alors que §35.1 veut exactement
 *     l'inverse (la preview survit au STOP) ;
 *   - la faisait disparaître sur un simple annulation.
 *
 * Ce service est donc le SEUL décideur de l'ouverture/fermeture de la preview.
 * `state/start-service.js` ne prépare plus la caméra : il se contente de
 * CONSOMMER une preview qui est déjà là, et n'interrompt jamais le service
 * (pas de double `startCamera`, pas de clignotement au top).
 *
 * ---------- RÈGLE DE RÉCONCILIATION ----------
 *
 *   desired = camera disponible ET skill Capture active ET permission caméra
 *             OK ET application au premier plan
 *
 * L'état réel est celui que rapporte `MultiCamCameraRecord.view().prepared`.
 * À chaque événement (boot, pause, resume, changement de skill) le service
 * réconcilie `desired` avec `réel`. La décision est recalculée AU MOMENT DE
 * L'EXÉCUTION, pas au moment de l'appel : une rafale pause/resume se replie
 * donc sur son état final au lieu d'ouvrir puis refermer la caméra.
 *
 * ---------- TRANSPARENCE CONDITIONNELLE ----------
 *
 * Le fond de l'application n'est transparent QUE lorsque la preview est
 * réellement active : le service pose/retire la classe `camera-preview-active`
 * sur `<body>`, et le CSS (`css/app.css`) conditionne le fond opaque #111827 à
 * l'absence de cette classe. L'UI n'est donc jamais transparent « par
 * défaut », et aucun état d'erreur ne peut laisser croire à une image caméra.
 *
 * ---------- RÉFUS DE TUER UN ENREGISTREMENT ----------
 *
 * Une fermeture demandée pendant un MediaRecorder en cours est DIFFÉRÉE et
 * journalisée (`CAMERA_PREVIEW_STOP_DEFERRED`). Arrêter un REC parce que
 * l'application passe en arrière-plan est une décision de jalon J10 (STOP
 * synchronisé) ; J09 ne la prend pas. */

(function (global) {
  "use strict";

  var BODY_CLASS = "camera-preview-active";

  var S = {
    bound: false,
    foreground: true,
    active: false,
    error: "",
    lastReason: "boot",
    chain: null,          /* sérialise les réconciliations (anti-double-ouverture) */
    listeners: []
  };

  function log(l) { console.log(l); }

  function camera() { return global.MultiCamCameraRecord || null; }

  function config() {
    var c = global.MultiCamConfig;
    if (!c) return null;
    return typeof c.get === "function" ? c.get() : c;
  }

  /* ---------- conditions de possibilité ---------- */

  function captureSkillEnabled() {
    var c = config();
    if (!c || !Array.isArray(c.enabledSkills)) return false;
    return c.enabledSkills.indexOf("capture") >= 0;
  }

  /* La permission n'est lue que si elle a été RÉELLEMENT observée : une
   * configuration sans `permissions` ne vaut pas refus. Le cas défavorable
   * est de toute façon rattrapé par l'échec d'ouverture natif. */
  function cameraPermissionGranted() {
    var c = config();
    if (!c || !c.permissions) return true;
    if (c.permissions.camera === false) return false;
    if (c.permissions.cameraGranted === false) return false;
    return true;
  }

  function pluginAvailable() {
    var cp = global.CameraPreview;
    return !!(cp && typeof cp.startCamera === "function" && typeof cp.stopCamera === "function");
  }

  /* Renvoie { ok, reason } — `reason` est le motif PARSABLE du refus. */
  function desired() {
    if (!camera() || typeof camera().startPreview !== "function") {
      return { ok: false, reason: "recorder_unavailable" };
    }
    if (!pluginAvailable()) return { ok: false, reason: "plugin_unavailable" };
    if (!captureSkillEnabled()) return { ok: false, reason: "capture_skill_off" };
    if (!cameraPermissionGranted()) return { ok: false, reason: "camera_permission_missing" };
    if (!S.foreground) return { ok: false, reason: "background" };
    return { ok: true, reason: "" };
  }

  function nativeView() {
    var cam = camera();
    return (cam && typeof cam.view === "function") ? cam.view() : null;
  }

  function isActive() {
    var v = nativeView();
    return !!(v && v.prepared);
  }

  /* ---------- transparence de l'UI ---------- */

  /* La classe est posée sur <html> ET sur <body> : les deux portent un fond
   * opaque par défaut (#111827) et la règle de propagation des fonds CSS
   * afficherait celui de `html` sous un `body` transparent. */
  function syncBodyClass(active) {
    var d = global.document;
    if (!d) return;
    var targets = [d.documentElement, d.body];
    targets.forEach(function (el) {
      if (!el || !el.classList) return;
      if (active) el.classList.add(BODY_CLASS);
      else el.classList.remove(BODY_CLASS);
    });
  }

  /* ---------- réconciliation ---------- */

  function emit() {
    S.listeners.slice().forEach(function (fn) { try { fn(); } catch (e) {} });
  }

  function settle() {
    /* On relit l'état NATIF : une fermeture peut avoir été refusée/différée. */
    var active = isActive();
    var was = S.active;
    S.active = active;
    syncBodyClass(active);
    if (active !== was) {
      log("CAMERA_PREVIEW_STATE active=" + (active ? 1 : 0)
        + " recording=" + (isRecording() ? 1 : 0) + " reason=" + (S.lastReason || "—"));
      emit();
    }
    return active;
  }

  function isRecording() {
    var cam = camera();
    return !!(cam && typeof cam.isRecording === "function" && cam.isRecording());
  }

  function apply() {
    var want = desired();
    var cam = camera();
    var active = isActive();

    if (want.ok && !active) {
      S.error = "";
      log("CAMERA_PREVIEW_START reason=" + (S.lastReason || "—") + " camera=back toBack=1");
      return cam.startPreview({ reason: S.lastReason, atMs: Date.now() }).then(function (r) {
        S.error = "";
        log("CAMERA_PREVIEW_OK reused=" + ((r && r.reused) ? 1 : 0)
          + " recording=" + (isRecording() ? 1 : 0));
        settle();
      }, function (err) {
        S.error = String((err && err.message) || err);
        log("CAMERA_PREVIEW_ERROR reason=" + (S.lastReason || "—") + " err=" + S.error);
        /* Aucun faux état actif : le fond sombre reste appliqué. */
        settle();
      });
    }

    if (!want.ok && active) {
      log("CAMERA_PREVIEW_STOP reason=" + want.reason + (isRecording() ? " recording=1" : ""));
      return cam.stopPreview("preview:" + want.reason).then(function (r) {
        if (r && r.released === false) {
          log("CAMERA_PREVIEW_STOP_SKIPPED reason=" + want.reason + " note=recording_in_progress");
        } else {
          S.error = "";
        }
        settle();
      }, function (err) {
        S.error = String((err && err.message) || err);
        log("CAMERA_PREVIEW_STOP_ERROR reason=" + want.reason + " err=" + S.error);
        settle();
      });
    }

    /* Aucun transition : on ne fait que resynchroniser la classe (résilient). */
    settle();
    return Promise.resolve(S.active);
  }

  /* Sérialise : deux réconciliations ne peuvent jamais se chevaucher, donc
   * deux `startCamera()` concurrents sont structurellement impossibles. */
  function serialize(fn) {
    S.chain = (S.chain || Promise.resolve()).then(fn, fn);
    return S.chain;
  }

  function reconcile(reason) {
    S.lastReason = reason || S.lastReason || "";
    return serialize(apply);
  }

  /* ---------- liaison cycle de vie ---------- */

  function bind() {
    if (S.bound) return Promise.resolve(view());
    S.bound = true;
    S.foreground = true;

    var d = global.document;
    if (d && typeof d.addEventListener === "function") {
      d.addEventListener("pause", function () {
        S.foreground = false;
        S.lastReason = "pause";
        log("CAMERA_PREVIEW_LIFECYCLE event=pause foreground=0");
        reconcile("pause");
      }, false);
      d.addEventListener("resume", function () {
        S.foreground = true;
        S.lastReason = "resume";
        log("CAMERA_PREVIEW_LIFECYCLE event=resume foreground=1");
        reconcile("resume");
      }, false);
    }

    var cfg = global.MultiCamConfig;
    if (cfg && typeof cfg.onChange === "function") {
      cfg.onChange(function () {
        log("CAMERA_PREVIEW_LIFECYCLE event=config_change capture="
          + (captureSkillEnabled() ? 1 : 0));
        reconcile("config_change");
      });
    }

    S.lastReason = "boot";
    return reconcile("boot");
  }

  /* ---------- vue publique ---------- */

  function view() {
    var want = desired();
    return {
      active: isActive(),
      desired: want.ok,
      reason: want.reason,
      foreground: S.foreground,
      captureEnabled: captureSkillEnabled(),
      recording: isRecording(),
      error: S.error,
      bodyClass: BODY_CLASS
    };
  }

  global.MultiCamPreviewService = {
    bind: bind,
    reconcile: reconcile,
    view: view,
    isActive: isActive,
    onView: function (fn) {
      if (typeof fn === "function" && S.listeners.indexOf(fn) < 0) S.listeners.push(fn);
    },
    offView: function (fn) {
      var i = S.listeners.indexOf(fn);
      if (i >= 0) S.listeners.splice(i, 1);
    },
    BODY_CLASS: BODY_CLASS
  };
})(window);
