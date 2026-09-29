/* MultiCam — wrapper d'enregistrement natif J08 (caméra rear, PreviewSurface).
 *
 * Rôle STRICT de ce module : traduire le modèle pur (js/state/start-model.js)
 * en appels plugin cordova-plugin-camera-preview, et en retour des faits
 * HONNÊTES.
 * Aucune logique de plan, d'horloge ou d'arbitrage ici (décision 30.10) : le
 * modèle ne connaît que `startRecording`/`stopRecording`, ce module ne connaît
 * que le plugin.
 *
 * Séquence qualifiée (tests/plugin-lab + docs/QUALIFICATION-TECHNIQUE-V1) :
 *   1. startCamera({camera:"back", toBack:true, tapPhoto:false, tapFocus:false,
 *      previewDrag:false, storeToFile:false}) — la PreviewSurface native
 *      DOIT être créée avant l'enregistrement ; le WebView reste transparent ;
 *   2. au top du plan (instant unique) : startRecordVideo({cameraDirection,
 *      width, height, quality, withFlash, camcorderProfile}) ;
 *   3. arrêt : stopRecordVideo() puis stopCamera() (libère la caméra).
 *
 * Règles critiques de la référence caméra :
 *   - NE JAMAIS appeler takeSnapshot() pendant un enregistrement (callbacks
 *     invalidés) : J08 ne capture aucun JPEG, donc la règle est respectée par
 *     construction — toute tentative future doit passer par capturePreviewSurface ;
 *   - ne jamais announcer un START réussi sur la seule foi du callback : on
 *     mesure l'instant de l'accusé NATIF (`ackMs`) et on le rapporte au modèle,
 *     qui le journalise séparément de l'instant du top (`START_NATIVE_ACK`) ;
 *   - `camcorderProfile` n'accepte que 720P|1080P|2160P (validation Java) : une
 *     valeur absente est OMISE du payload (et non envoyée nulle).
 *
 * Toutes les fonctions renvoient des Promises et ne lèvent jamais dans le
 * WebView : un échec est un rejet porteur d'un message exploitable par le modèle
 * (START_LOCAL_ERROR status=ERROR) plutôt qu'une exception muette.
 *
 * ---------- J09 (§35.1) : preview permanente ≠ enregistrement ----------
 *
 * La preview locale est devenue le FOND PERMANENT de l'application sur un
 * device Capture ; sa durée de vie n'est donc plus pilotée par un plan de START
 * mais par `state/preview-service.js` (skill Capture + premier plan Android).
 * Ce module reste le SEUL possesseur de la caméra et expose désormais deux
 * notions explicitement séparées :
 *
 *   - la PREVIEW  (`prepared`) : surface native ouverte, image locale visible
 *     derrière le WebView. Elle survit à l'arrêt d'un enregistrement.
 *   - l'ENREGISTREMENT (`recording`) : MediaRecorder en cours sur la MÊME
 *     caméra. Il ne possède pas la caméra : il l'emprunte.
 *
 * Conséquence directe : `stopRecording()` ne ferme plus la caméra (§35.1
 * « quitter le REC ne signifie pas fermer la preview »). La fermeture
 * complète est une décision EXPLICITE, prise par le service de preview
 * (`stopPreview`) ou par un teardown (`teardown`). */

(function (global) {
  "use strict";

  var VALID_PROFILES = { "720P": true, "1080P": true, "2160P": true };

  var state = {
    prepared: false,       /* PreviewSurface créée par startCamera */
    preparing: false,      /* startCamera en vol (une seule surface par device) */
    preparePromise: null,  /* préparation en cours, partagée par tous les appelants */
    recording: false,      /* startRecordVideo a été appelé et n'a pas été arrêté */
    videoPath: "",         /* chemin renvoyé par stopRecordVideo (prise J09) */
    preparedFor: "",       /* startPlanId ayant motivé la préparation (traçabilité) */
    lastError: "",
    counter: 0             /* idempotence : un même startPlanId ne démarre qu'une fois */
  };

  function nowMs() { return Date.now(); }

  function log(l) { console.log(l); }

  function plugin() { return global.CameraPreview || null; }

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  /* Taille de la PreviewSurface : le viewport du WebView quand il est connu,
   * sinon l'écran, sinon 0 (le plugin décide alors). Défensif : ni un objet ni
   * une valeur négative ne doivent atteindre le payload natif. */
  function viewportPx(innerKey, screenKey) {
    var v = 0;
    try {
      v = isNum(global[innerKey]) ? global[innerKey] : 0;
      if (!v && global.screen) v = isNum(global.screen[screenKey]) ? global.screen[screenKey] : 0;
    } catch (e) { v = 0; }
    return v > 0 ? Math.round(v) : 0;
  }

  /* Résolution de la résolution d'enregistrement. Le Take porte la décision
   * (J06 → effectiveNativeProfile) ; à défaut d'information, on reste sur la
   * valeur qualifiée du POC (720p) plutôt que de deviner une résolution non
   * supportée par l'appareil. */
  function resolveSize(opts) {
    var o = opts || {};
    var w = isNum(o.width) ? o.width : 1280;
    var h = isNum(o.height) ? o.height : 720;
    if (w < 320 || h < 240 || (w % 2) || (h % 2)) {
      log("CAMERA_REC_RES_FALLBACK reason=invalid_size w=" + w + " h=" + h + " fallback=1280x720");
      w = 1280; h = 720;
    }
    return { width: w, height: h };
  }

  function resolveQuality(opts) {
    var q = (opts && opts.quality) || "medium";
    var norm = String(q).toUpperCase();
    if (norm === "LOW") return "low";
    if (norm === "HIGH") return "high";
    return "medium";
  }

  function resolveProfile(opts) {
    var p = opts && opts.profile;
    if (p && VALID_PROFILES[String(p).toUpperCase()]) return String(p).toUpperCase();
    if (p) log("CAMERA_REC_PROFILE_IGNORE profile=" + p + " reason=unsupported allowed=720P,1080P,2160P");
    return null;   /* absent = choix automatique du plugin */
  }

  /* ---------- préparation (hors top) ---------- */

  /* Crée la PreviewSurface native. Cette PRÉPARATION appartient au service
   * (start-service), pas au modèle : elle n'est jamais appelée depuis le top.
   * Idempotente : deux appels successifs (re-arm d'un plan) ne recréent pas la
   * surface. */
  function prepare(opts) {
    opts = opts || {};
    var cp = plugin();
    if (!cp || typeof cp.startCamera !== "function") {
      state.lastError = "plugin_unavailable";
      return Promise.reject(new Error("plugin_unavailable"));
    }
    if (state.prepared) {
      log("CAMERA_PREP_SKIP startPlanId=" + (opts.startPlanId || "—") + " reason=already_prepared");
      return Promise.resolve({ ok: true, preparedAtMs: state.preparedAtMs || 0, reused: true });
    }
    /* Une PreviewSurface par device : si startCamera est déjà en vol, on REJOINT
     * la préparation existante au lieu d'en lancer une seconde. Sans ce verrou,
     * une réévaluation de readiness périodique (le modèle rafraîchit ~5 fois/s
     * pendant le countdown) créerait des surfaces concurrentes. */
    if (state.preparing && state.preparePromise) {
      log("CAMERA_PREP_JOIN startPlanId=" + (opts.startPlanId || "—") + " reason=in_flight");
      return state.preparePromise;
    }
    var o = {
      x: 0,
      y: 0,
      width: viewportPx("innerWidth", "width"),
      height: viewportPx("innerHeight", "height"),
      camera: (cp.CAMERA_DIRECTION && cp.CAMERA_DIRECTION.BACK) || "back",
      toBack: true,             /* preview native DERRIÈRE le WebView (UI 07) */
      tapPhoto: false,          /* pas de photo : J08 n'en capture aucune */
      tapFocus: false,
      previewDrag: false,
      storeToFile: false
    };
    var t0 = nowMs();
    state.preparing = true;
    state.preparePromise = new Promise(function (resolve, reject) {
      cp.startCamera(o, function (r) {
        state.prepared = true;
        state.preparing = false;
        state.lastError = "";
        state.preparedAtMs = nowMs();
        state.preparedFor = opts.startPlanId || "";
        log("CAMERA_PREP_OK startPlanId=" + (opts.startPlanId || "—")
          + " camera=back toBack=1 dt=" + (state.preparedAtMs - t0) + "ms"
          + " detail=" + JSON.stringify(r || {}));
        resolve({ ok: true, preparedAtMs: state.preparedAtMs, reused: false });
      }, function (e) {
        state.preparing = false;
        state.lastError = String(e);
        log("CAMERA_PREP_KO startPlanId=" + (opts.startPlanId || "—") + " err=" + String(e));
        reject(new Error("camera_prepare_failed:" + String(e)));
      });
    }).then(function (r) {
      state.preparePromise = null;
      return r;
    }, function (e) {
      state.preparePromise = null;
      throw e;
    });
    return state.preparePromise;
  }

  /* Relâche la préparation (plan annulé, remplacé, non-participation). Ne
   * touche JAMAIS à un enregistrement en cours : c'est stopRecord() qui décide
   * de la libération. */
  function release(reason) {
    var cp = plugin();
    if (!state.prepared) return Promise.resolve({ ok: true, released: false });
    if (state.recording) {
      log("CAMERA_RELEASE_DEFERRED reason=" + (reason || "—") + " note=recording_in_progress");
      return Promise.resolve({ ok: false, released: false });
    }
    state.prepared = false;
    if (!cp || typeof cp.stopCamera !== "function") {
      log("CAMERA_RELEASE_SKIP reason=" + (reason || "—") + " note=no_plugin");
      return Promise.resolve({ ok: true, released: true });
    }
    return new Promise(function (resolve) {
      cp.stopCamera(function (r) {
        log("CAMERA_RELEASE_OK reason=" + (reason || "—") + " detail=" + JSON.stringify(r || {}));
        resolve({ ok: true, released: true });
      }, function (e) {
        log("CAMERA_RELEASE_KO reason=" + (reason || "—") + " err=" + String(e));
        resolve({ ok: false, released: true });
      });
    });
  }

  /* ---------- top ---------- */

  /* Démarre l'enregistrement AU TOP. Contrat de retour imposé par le modèle :
   *   { atMs, detail }   atMs = instant de l'accusé NATIF (mesuré ici),
   *   ou rejet => START_LOCAL_ERROR status=ERROR.
   * Le modèle se charge de calculer le delta vs top local et de le journaliser
   * (START_NATIVE_ACK) : ici on ne fait QUE la mesure. */
  function startRecording(opts) {
    opts = opts || {};
    var cp = plugin();
    if (!cp || typeof cp.startRecordVideo !== "function") {
      state.lastError = "plugin_unavailable";
      return Promise.reject(new Error("plugin_unavailable"));
    }
    if (state.recording) {
      /* Filet de sécurité : le modèle refuse déjà un double top pour un même
       * Take ; on refuse ici aussi, au niveau matériel. */
      log("CAMERA_REC_SKIP startPlanId=" + (opts.startPlanId || "—") + " reason=already_recording");
      return Promise.resolve({ atMs: nowMs(), detail: "already_recording" });
    }
    if (!state.prepared) {
      /* startRecordVideo sans PreviewSurface : on prépare puis on réessaie une
       * seule fois (défense contre un armement de plan qui aurait sauté la
       * préparation — jamais de double tentative). */
      return prepare({ startPlanId: opts.startPlanId }).then(function () {
        return startRecording(opts);
      });
    }
    var size = resolveSize(opts);
    var payload = {
      cameraDirection: (cp.CAMERA_DIRECTION && cp.CAMERA_DIRECTION.BACK) || "back",
      width: size.width,
      height: size.height,
      withFlash: false
      /* PAS de `quality` : le wrapper JS du plugin l'attend en NOMBRE 0-100
       * (un libellé J06 "medium" y provoquait un JSONException -> "JSON error")
       * et le natif l'ignore pour la vidéo : le réglage effectif est
       * `camcorderProfile`. Sans `quality`, le wrapper applique sa propre
       * valeur par défaut documentée (85). */
    };
    var profile = resolveProfile(opts);
    if (profile) payload.camcorderProfile = profile;   /* absent → plugin choisit */
    var t0 = nowMs();
    state.recording = true;
    state.counter += 1;
    log("CAMERA_REC_REQUEST startPlanId=" + (opts.startPlanId || "—")
      + " take=" + (opts.takeNumber || "—")
      + " w=" + payload.width + " h=" + payload.height
      + " quality=plugin_default"
      + " qualityLabel=" + resolveQuality(opts)
      + " profile=" + (profile || "auto")
      + " targetLocalMs=" + (isNum(opts.localTargetMs) ? opts.localTargetMs : "—"));
    return new Promise(function (resolve, reject) {
      cp.startRecordVideo(payload, function (r) {
        var ackMs = nowMs();
        log("CAMERA_REC_OK startPlanId=" + (opts.startPlanId || "—")
          + " take=" + (opts.takeNumber || "—")
          + " ackAtMs=" + ackMs
          + " callDt=" + (ackMs - t0) + "ms"
          + " detail=" + JSON.stringify(r || {}));
        resolve({ atMs: ackMs, detail: "startRecordVideo_ok" });
      }, function (e) {
        state.recording = false;
        state.lastError = String(e);
        log("CAMERA_REC_KO startPlanId=" + (opts.startPlanId || "—")
          + " take=" + (opts.takeNumber || "—")
          + " err=" + String(e) + " callDt=" + (nowMs() - t0) + "ms");
        reject(new Error("startRecordVideo_failed:" + String(e)));
      });
    });
  }

  /* Arrête l'enregistrement et RENVOIE la caméra à la preview permanente.
   * Retour : { atMs, path, detail } (le chemin du fichier est celui que J09
   * exploitera ; J08 le journalise seulement). Résout même si rien n'était
   * démarré (idempotent).
   *
   * J09 §35.1 : NE ferme PLUS la caméra. La preview est un fond permanent
   * dont la durée de vie appartient à `preview-service.js` ; seul un arrêt
   * explicite de cette preview (arrière-plan, skill Capture désactivée) la
   * ferme. Avant J09, cette fonction appelait `release("stopped")` et
   * extinguishait donc la preview au STOP. */
  function stopRecording() {
    var cp = plugin();
    if (!state.recording) {
      var t0 = nowMs();
      return Promise.resolve({ atMs: t0, path: state.videoPath || "", detail: "not_recording" });
    }
    state.recording = false;
    return new Promise(function (resolve, reject) {
      cp.stopRecordVideo(function (p) {
        var atMs = nowMs();
        state.videoPath = (typeof p === "string") ? p : "";
        log("CAMERA_REC_STOP_OK atMs=" + atMs + " path=" + (state.videoPath || "—")
          + " previewKept=" + (state.prepared ? 1 : 0));
        resolve({ atMs: atMs, path: state.videoPath, detail: "stopRecordVideo_ok" });
      }, function (e) {
        state.lastError = String(e);
        log("CAMERA_REC_STOP_KO err=" + String(e));
        reject(new Error("stopRecordVideo_failed:" + String(e)));
      });
    });
  }

  /* ---------- J09 §35.1 : cycle de vie de la preview permanente ---------- */

  /* Ouvre (ou réutilise) la preview locale. Idempotent : si la surface est
   * déjà là — cas normal au top d'un plan, la preview étant permanente — on
   * renvoie `reused:true` SANS rappeler startCamera. C'est ce qui garantit
   * l'absence de double ouverture (et donc de clignotement) au passage
   * COUNTDOWN → REC. */
  function startPreview(opts) {
    opts = opts || {};
    return prepare(opts).then(function (r) {
      var v = r || {};
      log("CAMERA_PREVIEW_OPEN startPlanId=" + (opts.startPlanId || "—")
        + " reused=" + (v.reused ? 1 : 0)
        + " dt=" + ((v.preparedAtMs || 0) - (opts.atMs || 0)) + "ms");
      return r;
    });
  }

  /* Ferme la preview locale (libère la caméra).
   *
   * REFUS CONSCIENT de fermer pendant un enregistrement : la caméra est alors
   * prêtée à MediaRecorder, et arrêter un REC parce que l'application passe en
   * arrière-plan est une décision de produit qui appartient au jalon J10
   * (STOP synchronisé), pas à J09. On diffère donc et on le journalise
   * honnêtement plutôt que de tuer un enregistrement en cours. */
  function stopPreview(reason) {
    return release(reason).then(function (r) {
      if (r && r.released === false) {
        log("CAMERA_PREVIEW_STOP_DEFERRED reason=" + (reason || "—") + " note=recording_in_progress");
      }
      return r;
    });
  }

  /* Fermeture COMPLÈTE et explicite : enregistrement puis preview. Réservé au
   * cycle de vie de l'application (arrière-plan prolongé, changement de
   * session, teardown de test) — jamais appelé par un simple STOP de plan. */
  function teardown(reason) {
    var r = reason || "teardown";
    if (!state.recording) return stopPreview(r);
    return stopRecording().then(function () { return stopPreview(r); },
      function () { return stopPreview(r); });
  }

  /* `preparing` et `lastError` sont exposés PARCE QUE le point d'évaluation de
   * readiness (start-service.captureReady) doit répondre de façon SYNCHRONE :
   * il lit l'état courant au lieu d'attendre une Promise, et constate donc
   * l'échec d'une préparation au tick suivant (~200 ms), bien avant le top. */
  function view() {
    return {
      prepared: state.prepared,
      preparing: state.preparing,
      recording: state.recording,
      videoPath: state.videoPath,
      preparedFor: state.preparedFor,
      lastError: state.lastError,
      starts: state.counter
    };
  }

  function isRecording() { return state.recording; }

  /* Réinitialise l'état JS (PAS le natif) — réservé au changement de session
   * quand aucune Préparation ni enregistrement n'est en cours. */
  function reset() {
    if (state.recording || state.prepared) {
      log("CAMERA_RESET_DEFERRED recording=" + state.recording + " prepared=" + state.prepared);
      return false;
    }
    state.videoPath = "";
    state.preparedFor = "";
    state.lastError = "";
    state.counter = 0;
    return true;
  }

  global.MultiCamCameraRecord = {
    prepare: prepare,
    release: release,
    startRecording: startRecording,
    stopRecording: stopRecording,
    startPreview: startPreview,
    stopPreview: stopPreview,
    teardown: teardown,
    view: view,
    isRecording: isRecording,
    reset: reset,
    VALID_PROFILES: VALID_PROFILES
  };
})(window);
