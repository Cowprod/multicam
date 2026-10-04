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

  /* Modèle REAR/FRONT <-> direction du plugin. Le plugin ne connaît que
   * "back"/"front" et résout lui-même le cameraId (CameraActivity
   * .setDefaultCameraId) : cette table est donc le SEUL endroit du projet où les
   * deux vocabulaires se rencontrent. */
  var FACING_DIR = { REAR: "back", FRONT: "front" };
  /* `fromDir` sert sur deux vocabulaires : les directions NATIVES ("back") ET
   * les facings du modèle ("REAR"). Il faut donc accepter les deux écritures —
   * sans l'entrée "rear", `fromDir("REAR")` rendait "" et la vérification
   * post-bascule comparait une cible vide, faisant échouer toute bascule vers
   * l'arrière alors même que le natif avait réussi. */
  var DIR_FACING = { back: "REAR", rear: "REAR", front: "FRONT" };

  /* J09-08b4 : une valeur INCONNUE rend `""`, plus `back`. Cette fonction ne
   * traduit plus une absence en fait — la seule direction inventée de tout le
   * wrapper est celle de l'OUVERTURE (`prepare`), qui en a besoin et se fait
   * relire juste après. */
  function toDir(facing) {
    var up = String(facing || "").toUpperCase();
    return FACING_DIR[up] || "";
  }

  function fromDir(dir) {
    return DIR_FACING[String(dir || "").toLowerCase()] || "";
  }

  var state = {
    prepared: false,       /* PreviewSurface créée par startCamera */
    preparing: false,      /* startCamera en vol (une seule surface par device) */
    preparePromise: null,  /* préparation en cours, partagée par tous les appelants */
    recording: false,      /* startRecordVideo a été appelé et n'a pas été arrêté */
    videoPath: "",         /* chemin renvoyé par stopRecordVideo (prise J09) */
    /* ---------- J09-08b2 : arrêt NON CONFIRMÉ ----------
     *
     * Un `stopRecordVideo` en erreur ne prouve pas que le recorder s'est arrêté.
     * Tant que ce drapeau est levé, `videoPath` ne désigne plus rien de fiable :
     * le chemin mémorisé appartient au segment PRÉCÉDENT, et le renvoyer ferait
     * rattacher un faux fichier au segment courant. On le refuse donc. */
    stopUnconfirmed: false,
    preparedFor: "",       /* startPlanId ayant motivé la préparation (traçabilité) */
    lastError: "",
    counter: 0,            /* idempotence : un même startPlanId ne démarre qu'une fois */
    /* ---------- J09-07 : caméra réellement ouverte ---------- */
    /* `activeFacing` n'est écrit qu'à partir d'un fait NATIF
     * (`getCameraState` / `switchCameraTo`), jamais à partir d'une intention :
     * il alimente le modèle `camera-switch-model` qui refuse d'afficher une
     * bascule avant sa confirmation (§35.3 « pas de faux ACK »). */
    activeFacing: "",
    switchInFlight: null,  /* Promise de bascule : UNE seule opération physique */
    switchCounter: 0,
    /* Derniers RÉGLAGES d'enregistrement réellement appliqués. La segmentation
     * (§35.3) redémarre un segment, pas une session : il doit donc corriger
     * UNIQUEMENT la caméra et tout le reste doit être identique. Mémoriser les
     * opts ici évite qu'un `switchSegmented` rejoue un profil par défaut et
     * produise un segment de définition différente du précédent. */
    lastRecOpts: null
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
    /* La caméra d'ouverture est celle DÉJÀ connue (J09-07), sinon celle
     * demandée, sinon REAR (comportement J08 inchangé). Résoudre une caméra
     * DIFFÉRENTE à cet endroit coûtait une CRÉATION de SurfaceView ;
     * `switchCameraTo` reconfigure la surface existante sans la détruire.
     *
     * J09-08b4 : c'est le SEUL endroit du wrapper où une direction peut être
     * inventée, et il faut bien qu'il en invente une — sans direction, le natif
     * n'ouvre rien et le plan ne peut même pas être armé. Ce n'est donc pas une
     * affirmation : le résultat est relu par `settleFacingOnPrepare`, et c'est
     * cette relecture, jamais cette intention, qui alimente ensuite
     * `activeCamera` et la caméra des segments. */
    var o = {
      x: 0,
      y: 0,
      width: viewportPx("innerWidth", "width"),
      height: viewportPx("innerHeight", "height"),
      camera: toDir(state.activeFacing || opts.camera || "REAR"),
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
          + " camera=" + toDir(state.activeFacing || opts.camera || "REAR") + " toBack=1 dt=" + (state.preparedAtMs - t0) + "ms"
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
      if (!r.reused) return settleFacingOnPrepare().then(function () { return r; }, function () { return r; });
      return r;
    }, function (e) {
      state.preparePromise = null;
      throw e;
    });
    return state.preparePromise;
  }

  /* Établit le FAIT « quelle caméra filme » juste après l'ouverture de la
   * surface.
   *
   * `startCamera` a réussi avec une direction DEMANDÉE, ce qui est une
   * intention : le natif a pu verrouiller l'autre caméra (§35.1 — c'est
   * exactement pour ça que `switchCameraTo` corrige ensuite `defaultCameraId`).
   * Sans cette relecture, `activeFacing` resterait vide et le premier
   * `switchSegmented` rapporterait `from: ""` — un segment dont on ignore la
   * caméra d'origine. On préfère une lecture de plus au Take qu'une donnée
   * fausse. Un échec n'est pas bloquant : la bascule suivante corrigera l'état. */
  function settleFacingOnPrepare() {
    /* Le shim D'ABORD : sans lui, `getCameraState` peut manquer sur le wrapper
     * si le build n'a pas embarqué le JS plugin patché (voir setup-android.sh),
     * et cette fonction rendrait `false` en silence — donc `activeFacing`
     * resterait vide, le premier segment rapporterait `from: ""`, et le modèle
     * rattacherait le fichier à la MAUVAISE caméra. Constaté sur le terrain. */
    installSwitchShim();
    if (typeof global.CameraPreview === "undefined"
      || !global.CameraPreview || typeof global.CameraPreview.getCameraState !== "function") {
      return Promise.resolve(false);
    }
    return getCameraState().then(function (r) {
      if (!r || !r.available) {
        log("CAMERA_FACING_UNKNOWN reason=" + ((r && r.reason) || "—"));
        return false;
      }
      log("CAMERA_FACING_SET facing=" + (r.facing || "—")
        + " cameraId=" + r.cameraId + " count=" + r.numberOfCameras);
      return true;
    }, function () { return false; });
  }

  /* ---------- J09-08b4 : facing de l'enregistrement, relu et fail closed ----------
   *
   * Appelée par `startRecording` au moment de construire le payload. Elle ne
   * sert qu'à ça : établir le fait, ou constater son absence.
   *
   *   - facing déjà confirmé → il est rendu tel quel, sans appel natif (le
   *   chemin nominal ne coûte donc RIEN) ;
   *   - facing inconnu    → une relecture native est tentée. C'est le même
   *   `getCameraState` qui alimente `activeFacing` : s'il répond, le fait est
   *   établi et utilisé comme tel ;
   *   - relecture impossible ou muette → `""`. L'inconnu reste inconnu, et
   *   surtout : `opts.camera` n'est jamais consulté. Une intention ne devient
   *   jamais un fait, même sous pression d'un top de Take. */
  function settleFacingForRecord() {
    /* Toujours une promesse : l'appelant enchaîne sans se demander si la
     * relecture a eu lieu ou non. */
    if (state.activeFacing) return Promise.resolve(state.activeFacing);
    if (typeof global.CameraPreview === "undefined"
      || !global.CameraPreview || typeof global.CameraPreview.getCameraState !== "function") {
      return Promise.resolve("");
    }
    /* Le shim d'abord : sans lui, `getCameraState` peut manquer sur un build
     * qui n'a pas embarqué le JS patché, et l'appel se refuserait en silence —
     * donc un facing resterait inconnu sans qu'aucune erreur ne remonte. */
    installSwitchShim();
    return getCameraState().then(function (r) {
      if (!r || !r.available) {
        log("CAMERA_FACING_UNKNOWN reason=" + ((r && r.reason) || "—")
          + " context=startRecordVideo");
        return "";
      }
      return state.activeFacing || "";
    }, function () { return ""; });
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
    /* ---------- J09-08b4 : plus de caméra DEMANDÉE à l'enregistrement ----------
     *
     * Jusque-là : `activeFacing || fromDir(opts.camera) || "REAR"`. La caméra
     * demandée — puis, à défaut, REAR — servait de valeur de remplacement, donc
     * de faux fait. Or une intention n'est pas une preuve : au top d'un Take,
     * si la relecture native n'a encore rien donné, le segment 1 se voyait
     * attribuer REAR alors que personne n'avait vu quelle caméra filme. Sur
     * l'écran du Master's, un segment REAR filmé en FRONT est indétectable —
     * personne ne peut plus savoir que l'image est mal attribuée.
     *
     * Règle : la direction annoncée est celle LUE au natif, ou `""` — inconnu.
     * Jamais la demande, jamais une constante.
     *
     * Le natif tolère cette absence sans risque : sur ce plugin, `startRecord`
     * ignore la chaîne reçue et enregistre avec la caméra DÉJÀ ouverte
     * (`mCamera`, profil choisi sur `defaultCameraId`). La direction du payload
     * est donc une étiquette de traçabilité, pas une sélection — et `""` ne
     * fait basculer personne.
     *
     * `prepare()` fait exception et garde son choix : c'est l'OUVERTURE de la
     * surface, là où une instruction est unavoidable. Elle est immédiatement
     * suivie d'une relecture (`settleFacingOnPrepare`), donc ce qui est publié
     * ensuite reste un fait. */
    /* La relecture est ASYNCHRONE : le payload ne peut donc pas être construit
     * avant qu'elle ait répondu. On enchaîne sur sa réponse au lieu de le
     * remplir en amont avec une valeur devinée. */
    return settleFacingForRecord().then(function (facing) {
      log("CAMERA_REC_FACING source=" + (facing ? "confirmed" : "native_unknown")
        + " facing=" + (facing || "—")
        + (facing ? "" : " note=no_confirmed_facing"));
      var payload = {
        cameraDirection: toDir(facing),
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
      state.lastRecOpts = {
        width: size.width,
        height: size.height,
        quality: opts.quality,
        profile: profile,
        takeNumber: opts.takeNumber,
        startPlanId: opts.startPlanId || ""
      };
      var t0 = nowMs();
      state.recording = true;
      state.counter += 1;
      log("CAMERA_REC_REQUEST startPlanId=" + (opts.startPlanId || "—")
        + " take=" + (opts.takeNumber || "—")
        + " camera=" + facing
        + " w=" + payload.width + " h=" + payload.height
        + " quality=plugin_default"
        + " qualityLabel=" + resolveQuality(opts)
        + " profile=" + (profile || "auto")
        + " targetLocalMs=" + (isNum(opts.localTargetMs) ? opts.localTargetMs : "—"));
      return new Promise(function (resolve, reject) {
        cp.startRecordVideo(payload, function (r) {
          var ackMs = nowMs();
          state.stopUnconfirmed = false;
          log("CAMERA_REC_OK startPlanId=" + (opts.startPlanId || "—")
            + " take=" + (opts.takeNumber || "—")
            + " ackAtMs=" + ackMs
            + " callDt=" + (ackMs - t0) + "ms"
            + " detail=" + JSON.stringify(r || {}));
          resolve({ atMs: ackMs, detail: "startRecordVideo_ok" });
        }, function (e) {
          var raw = String(e);
          state.lastError = raw;
          log("CAMERA_REC_KO startPlanId=" + (opts.startPlanId || "—")
            + " take=" + (opts.takeNumber || "—")
            + " err=" + raw + " callDt=" + (nowMs() - t0) + "ms");
          /* J09-08b2 : le callback d'erreur ne dit PAS si un recorder a été
           * CRÉÉ. `startRecordVideo` peut avoir ouvert un MediaRecorder puis avoir
           * échoué (fichier impossible, erreur d'enregistreur) — ou n'avoir rien
           * fait du tout. Les deux cas partagent le même callback, donc on ne les
           * devine pas : on RELIT l'état natif. C'est la seule preuve disponible,
           * et son ABSENCE vaut refus — sans elle, aucun segment ne sera ouvert. */
          return recheckRecorder(function (nat) {
            var started = (nat.available && nat.recording === true);
            /* `state.recording` avait été posé à `true` par-dessus un démarrage
             * demandé : on ne le garde que si le natif le confirme. Une relecture
             * impossible laisse l'état à `false` — fail closed, aucun recorder
             * n'est annoncé sans fait. */
            state.recording = started;
            if (started && nat.path) state.videoPath = nat.path;
            state.stopUnconfirmed = false;
            log("CAMERA_REC_KO_FACT recorderStarted=" + (started ? 1 : 0)
              + " path=" + (nat.path || "—")
              + " note=" + (nat.available ? "state_reread" : "state_unreadable"));
            reject(segError("start_failed", raw, {
              recorderStarted: started,
              recorderPath: started ? (nat.path || "") : ""
            }));
          });
        });
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
      /* J09-08b2 : un arrêt précédent a échoué sans être confirmé. Le chemin
       * mémorisé date du segment D'AVANT : le renvoyer rattacherait un fichier
       * périmé au segment courant. On le déclare absent plutôt que périmé. */
      if (state.stopUnconfirmed) {
        log("CAMERA_REC_STOP_UNCONFIRMED path=— note=no_confirmed_closure");
        return Promise.resolve({ atMs: t0, path: "", detail: "stop_unconfirmed" });
      }
      return Promise.resolve({ atMs: t0, path: state.videoPath || "", detail: "not_recording" });
    }
    state.recording = false;
    return new Promise(function (resolve, reject) {
      cp.stopRecordVideo(function (p) {
        var atMs = nowMs();
        state.videoPath = (typeof p === "string") ? p : "";
        state.stopUnconfirmed = false;
        log("CAMERA_REC_STOP_OK atMs=" + atMs + " path=" + (state.videoPath || "—")
          + " previewKept=" + (state.prepared ? 1 : 0));
        resolve({ atMs: atMs, path: state.videoPath, detail: "stopRecordVideo_ok" });
      }, function (e) {
        var raw = String(e);
        state.lastError = raw;
        /* J09-08b2 : même méthode que pour un démarrage refusé — on relit le
         * natif, car « le callback d'erreur a fired » ne veut pas dire « le
         * recorder est arrêté ». Sans relecture, l'état reste celui du dernier
         * fait : le segment n'est pas déclaré clos. */
        return recheckRecorder(function (nat) {
          if (nat.available) state.recording = (nat.recording === true);
          /* Tout `videoPath` devient PÉRIMÉ : il désigne le segment précédent. */
          state.videoPath = "";
          state.stopUnconfirmed = true;
          log("CAMERA_REC_STOP_KO err=" + raw
            + " recorderRunning=" + (state.recording ? 1 : 0)
            + " note=" + (nat.available ? "state_reread" : "state_unreadable"));
          reject(segError("stop_failed", raw, {
            closed: false,
            closedPath: "",
            closedAtMs: 0,
            recorderRunning: state.recording === true
          }));
        });
      });
    });
  }

  /* ---------- J09-08b2 : faits de segmentation sur un échec ----------
   *
   * `startRecordVideo` et `stopRecordVideo` ne distinguent pas « rien ne s'est
   * passé » de « quelque chose a commencé puis a échoué » : un seul callback
   * d'erreur pour les deux. Les deux DISCRIMINANTS qui décident de l'identité
   * des segments doivent donc venir d'une RELECTURE de l'état natif :
   *
   *   `recorderStarted`  un recorder a été RÉELLEMENT créé. C'est le SEUL motif
   *                       d'ouvrir un segment : sans cette preuve, un
   *                       `restart_failed` ne fabrique pas de N+1 fantôme.
   *   `closed`           la clôture du segment N est CONFIRMÉE (chemin + instant).
   *
   * Absents, ils valent `false`. C'est une décision fail closed : on préfère un
   * segment en trop à un index consommé par un fichier qui n'a jamais existé. */
  function segError(code, raw, facts) {
    var f = facts || {};
    var e = nativeError(code, raw, f.detail || null);
    e.stopAttempted = f.stopAttempted === true;
    e.closed = f.closed === true;
    e.closedPath = (typeof f.closedPath === "string") ? f.closedPath : "";
    e.closedAtMs = (typeof f.closedAtMs === "number") ? f.closedAtMs : 0;
    e.recorderStarted = f.recorderStarted === true;
    e.recorderPath = (typeof f.recorderPath === "string") ? f.recorderPath : "";
    e.recorderRunning = f.recorderRunning === true;
    e.from = (typeof f.from === "string") ? f.from : "";
    e.to = (typeof f.to === "string") ? f.to : "";
    return e;
  }

  /* Relecture de l'état natif APRÈS un refus : la seule preuve de ce qu'ont
   * réellement fait les callbacks. Appelle toujours le rappel, et n'échoue
   * jamais — une absence de fait est un fait absent, pas une exception. */
  function recheckRecorder(cb) {
    return getCameraState().then(function (nat) {
      if (!nat || !nat.available) { cb({ available: false, recording: false, path: "" }); return; }
      cb({
        available: true,
        recording: nat.recording === true,
        path: (typeof nat.recordFilePath === "string") ? nat.recordFilePath : ""
      });
    }, function () {
      cb({ available: false, recording: false, path: "" });
    });
  }

  /* ---------- J09-07 §35.2 / §35.3 : état natif et bascule de caméra ----------
   *
   * Deux actions greffées par `app/camera-patches/apply_camera_switch_patch.py` :
   *
   *   `getCameraState()`      → FAIT : quel facing est réellement verrouillé,
   *                             combien de caméras existent, la preview est-elle
   *                             posée, un recorder est-il en cours.
   *   `switchCameraTo(facing)`→ bascule CIBLEE et confirmée. L'API upstream
   *                             `switchCamera()` ne vise aucune caméra et ne
   *                             confirme rien ; elle est donc INUTILISABLE ici.
   *
   * Les erreurs natives arrivent en JSON (`{"ok":false,"error":"…"}`) : on les
   * décode pour exposer un `code` stable au modèle, au lieu de laisser remonter
   * une chaîne libre que ni l'ACK ni l'UI ne pourraient exploiter.
   */

  /* Installe les shims JS si le wrapper Cordova a été construit sans les
   * méthodes patchées (build sans patch, ou plugin reinstallé). */
  function installSwitchShim() {
    var cp = plugin();
    if (!cp || typeof global.cordova === "undefined" || typeof global.cordova.exec !== "function") {
      return false;
    }
    if (typeof cp.switchCameraTo !== "function") {
      cp.switchCameraTo = function (facing, onSuccess, onError) {
        global.cordova.exec(onSuccess, onError, "CameraPreview", "switchCameraTo", [facing]);
      };
    }
    if (typeof cp.getCameraState !== "function") {
      cp.getCameraState = function (onSuccess, onError) {
        global.cordova.exec(onSuccess, onError, "CameraPreview", "getCameraState", []);
      };
    }
    return true;
  }

  function decodeNativeError(e) {
    var raw = String(e);
    try {
      var o = JSON.parse(raw);
      if (o && o.error) return { code: String(o.error), raw: raw };
    } catch (x) { /* message natif libre */ }
    return { code: "", raw: raw };
  }

  /* Fait natif brut, sans interprétation. Résout TOUJOURS (jamais de rejet) :
   * l'absence de fait est un fait absent, pas une exception — l'appelant
   * décide du refus. */
  function getCameraState() {
    installSwitchShim();
    var cp = plugin();
    if (!cp || typeof cp.getCameraState !== "function") {
      return Promise.resolve({ available: false, reason: "plugin_unavailable" });
    }
    return new Promise(function (resolve) {
      cp.getCameraState(function (res) {
        var r = res || {};
        var facing = fromDir(r.facing);
        /* Une LECTURE native est un fait : elle rafraîchit le facing mémorisé.
         * Sans cela, `activeFacing` ne serait établi qu'après une bascule, et le
         * premier `switchSegmented` rapporterait `from: ""`. On n'écrit que si
         * le natif a répondu quelque chose d'exploitable — une valeur vide ne
         * remplace jamais une valeur connue. */
        if (facing) state.activeFacing = facing;
        resolve({
          available: true,
          facing: facing,
          cameraId: (typeof r.cameraCurrentlyLocked === "number") ? r.cameraCurrentlyLocked : -1,
          defaultCameraId: (typeof r.defaultCameraId === "number") ? r.defaultCameraId : -1,
          numberOfCameras: (typeof r.numberOfCameras === "number") ? r.numberOfCameras : 0,
          hasCamera: r.hasCamera === true,
          recording: r.recording === true,
          recordFilePath: typeof r.recordFilePath === "string" ? r.recordFilePath : ""
        });
      }, function (e) {
        resolve({ available: false, reason: String(e) });
      });
    });
  }

  /* Bascule CIBLEE d'une seule caméra physique, SANS segmentation : c'est la
   * primitive bas niveau. Le facing actif n'est mis à jour que sur un retour
   * natif `ok:true` — une promesse résolue ne prouve donc jamais à elle seule
   * que la caméra a changé. */
  function switchCameraTo(facing) {
    installSwitchShim();
    var cp = plugin();
    /* Fail-closed AVANT le moindre appel natif : `toDir` retombe sur REAR pour
     * une valeur inconnue, donc une caméra hors modèle se traduirait par une
     * bascule SILENCIEUSE vers l'arrière. Le modèle de caméras est la seule
     * autorité ; une valeur qu'il ne reconnaît pas est un bug ou une corruption,
     * pas une intention. */
    if (!FACING_DIR[String(facing || "").toUpperCase()]) {
      return Promise.reject(nativeError("unknown_camera",
        "caméra " + String(facing) + " hors modèle"));
    }
    var want = toDir(facing);
    if (!cp || typeof cp.switchCameraTo !== "function") {
      return Promise.reject(nativeError("plugin_unavailable", "switchCameraTo indisponible"));
    }
    if (!state.prepared) {
      return Promise.reject(nativeError("camera_off", "aucune PreviewSurface à reconfigurer"));
    }
    var t0 = nowMs();
    return new Promise(function (resolve, reject) {
      cp.switchCameraTo(want, function (res) {
        var r = res || {};
        var confirmed = fromDir(r.facing);
        var atMs = nowMs();
        if (!confirmed) {
          reject(nativeError("switch_failed", "confirmation sans facing", r));
          return;
        }
        state.activeFacing = confirmed;
        state.switchCounter += 1;
        state.lastError = "";
        log("CAMERA_SWITCH_OK target=" + fromDir(want) + " confirmed=" + confirmed
          + " alreadyActive=" + (r.alreadyActive ? 1 : 0)
          + " cameraId=" + (r.cameraCurrentlyLocked == null ? "—" : r.cameraCurrentlyLocked)
          + " nativeMs=" + (r.durationMs == null ? "—" : r.durationMs)
          + " callDt=" + (atMs - t0) + "ms");
        resolve({
          ok: true,
          alreadyActive: r.alreadyActive === true,
          confirmed: confirmed,
          cameraId: (typeof r.cameraCurrentlyLocked === "number") ? r.cameraCurrentlyLocked : -1,
          atMs: atMs,
          durationMs: (typeof r.durationMs === "number") ? r.durationMs : (atMs - t0)
        });
      }, function (e) {
        var d = decodeNativeError(e);
        state.lastError = d.raw;
        log("CAMERA_SWITCH_KO target=" + fromDir(want) + " code=" + (d.code || "—")
          + " err=" + d.raw + " callDt=" + (nowMs() - t0) + "ms");
        reject(nativeError(d.code || "switch_failed", d.raw));
      });
    });
  }

  function nativeError(code, raw, detail) {
    var e = new Error(code + ":" + String(raw));
    e.code = code;
    e.raw = String(raw);
    e.detail = detail || null;
    return e;
  }

  /* ---------- LA SEGMENTATION (§35.3) ----------
   *
   * Séquence IMPÉRATIVE, dans cet ordre exact, et aucune autre :
   *
   *   1. arrêter PROPREMENT le recorder courant  → fichier N finalisé
   *   2. basculer la caméra                     → confirmation native
   *   3. relire l'état natif                   → confirmation INDÉPENDANTE
   *   4. démarrer immédiatement un recorder     → segment N+1
   *
   * Le Take reste REC pendant toute l'opération ; aucune autre Capture n'est
   * touchée. Si l'étape 4 échoue on NE revient PAS à l'ancienne caméra : le
   * segment est perdu, et il est plus honnête de le dire que d'en enregistrer
   * un sous un facing qui n'est plus le sien.
   *
   * L'INDEX d'un segment n'est pas décidé ici : c'est l'orchestrateur qui le
   * porte, et il l'attribue à l'ouverture (§J09-08b1). Ce wrapper ne fait que
   * rendre les deux faits de clôture dont l'index dépend — le chemin du fichier
   * et l'instant exact de l'arrêt.
   *
   * ---------- J09-08b2 : ce qu'un ÉCHEC doit rapporter ----------
 *
 * Une séquence d'opérations peut échouer n'importe où, et l'échec ne dit pas
 * ce qui a déjà eu lieu. Chaque rejet porte donc les faits observés :
 *
 *   stopAttempted   la fermeture du segment N a été tentée ;
 *   closed          elle est CONFIRMÉE (chemin + instant disponibles) ;
 *   recorderStarted un recorder N+1 a RÉELLEMENT été créé (relecture native
 *                   après l'échec du démarrage) ;
 *   from / to       caméras de départ et d'arrivée, cette dernière étant
    *                   publiée uniquement après la relecture INDÉPENDANTE.
 *
    * Ces champs valent `false` tant qu'ils ne sont pas prouvés. C'est ce qui
   * permet à l'orchestrateur de ne RIEN inscrire sur un refus, de closer le seul
   * segment N sur une bascule confirmée, et de n'ouvrir un N+1 que sur une preuve.
   *
   * `switchInFlight` sérialise : deux commandes concurrentes partagent la même
   * bascule et ne peuvent pas se chevaucher sur le même MediaRecorder.
   */
  function switchSegmented(opts) {
    opts = opts || {};
    var facing = String(opts.camera || "").toUpperCase();
    /* Même garde qu'au niveau primitif, mais AVANT `stopRecording()` : sinon un
     * facing invalide ferait fermer le segment N sans jamais rouvrir de segment,
     * c'est-à-dire un Take corrompu. */
    if (!FACING_DIR[facing]) {
      /* `segError` et non `nativeError` : TOUT rejet de `switchSegmented` porte
       * le jeu complet de faits, y compris ceux qui valent `false`. Un appelant
       * ne doit pas avoir à deviner ce qu'un refus laisse intact. */
      return Promise.reject(segError("unknown_camera",
        "caméra " + String(opts.camera) + " hors modèle"));
    }
    var wasRecording = state.recording;
    /* La caméra de DÉPART est mémorisée À L'ENTRÉE, avant toute écriture : dès
     * que `switchCameraTo` réussit, `state.activeFacing` vaut déjà la cible, et
     * le lire après donnerait `from === to`. Or c'est `from` qui clôt le segment
     * N côté orchestrateur — un `from` faux ferait rattacher le fichier au
     * mauvais index et fausserait le décompte de segments du Take. */
    var fromFacing = state.activeFacing || "";
    var gapStartMs = nowMs();

    if (state.switchInFlight) {
      log("CAMERA_SWITCH_REFUSE target=" + facing + " code=switch_in_progress");
      return Promise.reject(segError("switch_in_progress", "bascule déjà en cours"));
    }

    /* J09-08b2 : les faits de segmentation sont ACCUMULÉS pendant l'opération,
     * puis rattachés à l'erreur quelle qu'elle soit. Sans eux l'orchestrateur ne
     * peut pas distinguer trois situations qu'un `restart_failed` ne distingue
     * pas : rien n'a été touché, le segment N est clos, ou un N+1 existe. C'est
     * cette distinction qui décide si un index a été consommé. */
    var facts = {
      stopAttempted: false,
      closed: false, closedPath: "", closedAtMs: 0,
      recorderStarted: false, recorderPath: "",
      from: fromFacing, to: ""
    };

    var op = Promise.resolve()
      .then(function () {
        /* --- 1. segment N --- */
        if (!wasRecording) {
          log("CAMERA_SWITCH_SEGMENT_SKIP target=" + facing + " reason=not_recording mode=preview_only");
          return { closed: null, closedAtMs: 0 };
        }
        facts.stopAttempted = true;
        return stopRecording().then(function (r) {
          facts.closed = true;
          facts.closedPath = (r && r.path) || "";
          facts.closedAtMs = (r && r.atMs) || nowMs();
          log("CAMERA_SWITCH_SEGMENT_CLOSED target=" + facing
            + " path=" + (facts.closedPath || "—")
            + " stopDt=" + (r && r.atMs ? (r.atMs - gapStartMs) : 0) + "ms");
          return { closed: facts.closedPath, closedAtMs: facts.closedAtMs };
        }, function (err) {
          /* L'arrêt est tenté et NON CONFIRMÉ : la caméra n'est même pas
           * basculée. On propage un `stop_failed` discriminable plutôt que le
           * message brut, pour que l'orchestrateur sache que la clôture n'a
           * pas eu lieu — et qu'il ne referme donc pas le segment N. */
          throw segError("stop_failed", String((err && err.message) || err), {
            stopAttempted: true,
            recorderRunning: !!(err && err.recorderRunning === true)
          });
        });
      })
      .then(function (closed) {
        /* --- 2. bascule --- */
        return switchCameraTo(facing).then(function (sw) {
          /* --- 3. relecture INDÉPENDANTE de l'état natif --- *
           *
           * C'est LE POINT UNIQUE où la caméra active est confirmée, et il ne
           * se trouve pas dans le callback de `switchCameraTo` : celui-ci peut
           * annoncer une cible que le natif n'a pas atteinte (§35.1). La
           * relecture, elle, fait foi — et elle corrige au passage le facing
           * mémorisé, que le callback optimiste venait d'écrire. */
          return getCameraState().then(function (nat) {
            if (!nat.available) {
              /* Relecture IMPOSSIBLE : rien n'est confirmé, donc rien n'est
               * rapporté. `facts.to` reste vide et l'appelant garde son état —
               * fail closed, plutôt qu'un facing deviné. */
              throw nativeError("state_unavailable", "getCameraState a échoué: " + (nat.reason || "—"));
            }
            /* J09-08b3 : `to` est la caméra RÉELLEMENT active, lue au natif —
             * jamais la caméra DEMANDÉE. Les deux diffèrent quand le pilote
             * n'atterrit pas sur la cible : c'est alors la relecture qui
             * devient le fait à publier, y compris sur un échec. */
            facts.to = nat.facing;
            if (nat.facing !== fromDir(facing)) {
              throw nativeError("switch_failed",
                "relecture native " + (nat.facing || "—") + " != demandé " + fromDir(facing));
            }
            /* La caméra d'arrivée est CONFIRMÉE : c'est elle qu'un éventuel
             * segment N+1 portera, jamais la caméra demandée. */
            return { closed: closed, sw: sw, nat: nat };
          });
        });
      })
      .then(function (r) {
        /* --- 4. segment N+1 --- */
        if (!wasRecording) {
          return {
            ok: true, segmented: false, restarted: false,
            /* J09-08b3 : `to` vient de la RELECTURE (fait), jamais de la cible
             * demandée (intention) — même quand il n'y a pas de segmentation,
             * la caméra publiée doit être celle qui filme. */
            from: fromFacing, to: facts.to,
            closedPath: r.closed.closed,
            /* J09-08b1 : l'instant de clôture du fichier doit remonter avec lui,
             * sinon le segment clôturé par la bascule porterait un `stoppedAt`
             * inconnu. Aucun segment ne peut être inventé, mais un fait déjà mesuré
             * ne doit pas être perdu. */
            closedAtMs: r.closed.closedAtMs || 0,
            closedConfirmed: false,
            recorderStarted: false,
            gapMs: nowMs() - gapStartMs,
            atMs: nowMs(), alreadyActive: r.sw.alreadyActive === true
          };
        }
        /* On repart des réglages du segment COURANT et on ne change que la
         * caméra : si le `camcorderProfile` mémorisé n'est pas supporté par la
         * NOUVELLE caméra, le natif refuse (PROFILE_NOT_SUPPORTED) et la bascule
         * est signalée en `restart_failed` — jamais un segment silencieux d'une
         * autre définition. */
        var prev = state.lastRecOpts || {};
        var restart = {
          startPlanId: opts.startPlanId || prev.startPlanId || "",
          takeNumber: (opts.takeNumber == null) ? prev.takeNumber : opts.takeNumber,
          localTargetMs: opts.localTargetMs,
          width: prev.width,
          height: prev.height,
          quality: prev.quality,
          profile: prev.profile,
          camera: fromDir(facing)
        };
        return startRecording(restart).then(function () {
          facts.recorderStarted = true;
          return {
            ok: true, segmented: true, restarted: true,
            from: fromFacing, to: facts.to,
            closedPath: facts.closedPath,
            closedAtMs: facts.closedAtMs || 0,
            closedConfirmed: true,
            recorderStarted: true,
            gapMs: nowMs() - gapStartMs,
            atMs: nowMs(), alreadyActive: r.sw.alreadyActive === true
          };
        }, function (err) {
          /* Le seul fait qui décide de l'existence d'un segment N+1 : la
           * RELECTURE faite par `startRecording` après son échec. Sans elle,
           * `recorderStarted` reste `false` et aucun N+1 n'est inventé. */
          facts.recorderStarted = !!(err && err.recorderStarted === true);
          facts.recorderPath = (err && err.recorderPath) || "";
          throw segError("restart_failed", String((err && err.message) || err), {
            detail: (err && err.detail) || null
          });
        });
      });

    state.switchInFlight = op.then(function (res) {
      state.switchInFlight = null;
      log("CAMERA_SWITCH_SEGMENT_OK target=" + fromDir(facing)
        + " segmented=" + (res.segmented ? 1 : 0)
        + " restarted=" + (res.restarted ? 1 : 0)
        + " closedPath=" + (res.closedPath || "—")
        + " gapMs=" + res.gapMs);
      return res;
    }, function (err) {
      state.switchInFlight = null;
      /* Rattachement des faits à l'erreur : l'orchestrateur décide sur eux, il
       * ne les redécouvre pas. Un refus antérieur à toute opération matérielle
       * porte donc `closed:false` et `recorderStarted:false` — l'absence de
       * preuve, pas une preuve d'absence d'effet. */
      if (err && typeof err === "object") {
        err.stopAttempted = facts.stopAttempted;
        err.closed = facts.closed;
        err.closedPath = facts.closedPath;
        err.closedAtMs = facts.closedAtMs;
        err.recorderStarted = facts.recorderStarted;
        err.recorderPath = facts.recorderPath;
        err.from = facts.from;
        err.to = facts.to;
      }
      log("CAMERA_SWITCH_SEGMENT_KO target=" + fromDir(facing)
        + " code=" + ((err && err.code) || "—") + " err=" + String((err && err.message) || err)
        + " stopAttempted=" + (facts.stopAttempted ? 1 : 0)
        + " closed=" + (facts.closed ? 1 : 0)
        + " closedPath=" + (facts.closedPath || "—")
        + " recorderStarted=" + (facts.recorderStarted ? 1 : 0)
        + " to=" + (facts.to || "—")
        + " recording=" + (state.recording ? 1 : 0));
      throw err;
    });
    return state.switchInFlight;
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
      starts: state.counter,
      /* J09-07 */
      activeFacing: state.activeFacing,
      switching: !!state.switchInFlight,
      switches: state.switchCounter
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
    /* Le natif n'a plus de caméra ouverte : le facing mémorisé n'a plus de
     * référence. La prochaine `prepare()` repart de son `opts.camera` explicite. */
    state.activeFacing = "";
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
    /* J09-07 */
    getCameraState: getCameraState,
    switchCameraTo: switchCameraTo,
    switchSegmented: switchSegmented,
    installSwitchShim: installSwitchShim,
    view: view,
    isRecording: isRecording,
    reset: reset,
    VALID_PROFILES: VALID_PROFILES
  };
})(window);
