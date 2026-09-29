/* MultiCam — J09-02 : cycle de vie de la preview caméra locale permanente
 * (décision §35.1).
 *
 * Ces tests sont écrits CONTRE L'API CIBLE : au moment de leur création le
 * module `state/preview-service.js` n'existe pas et `camera-record.js` ferme
 * encore la caméra avec l'enregistreur — ils doivent donc être ROUGES.
 *
 * Couverture : A→H du cahier des charges.
 *   A. Capture actif + foreground  → preview demandée automatiquement
 *   B. device non-Capture          → preview jamais demandée
 *   C. Capture + background        → preview libérée
 *   D. retour foreground           → preview relancée
 *   E. skill Capture désactivée    → preview arrêtée
 *   F. REC alors preview déjà active→ pas de second startCamera
 *   G. STOP REC                    → recording s'arrête, preview ACTIVE
 *   H. échec permission/ouverture  → fallback sombre, pas de faux "actif"
 */

"use strict";

function register(h) {
  const { describe, it, createEnv, loadAll, flush } = h;
  /* eslint-disable no-unused-vars */

  /* Construit un env avec les modules reellement livres dans app/www/js. */
  function boot(opts) {
    opts = opts || {};
    const env = createEnv(opts);
    loadAll(env, [
      "native/camera-record.js",
      "state/preview-service.js"
    ]);
    return env;
  }

  function classOn(env) {
    return env.document.body._classes.has("camera-preview-active");
  }

  async function bind(env) {
    env.MultiCamPreviewService.bind();
    await flush(12);
  }

  /* ------------------------------------------------------------------ *
   * Rouge « comportemental » : ne charge QUE le code livré en J08, et
   * vérifie qu'il ne sait PAS encore satisfaire §35.1. Ces tests échouent
   * sur un comportement réel, pas sur un fichier manquant.
   * ------------------------------------------------------------------ */
  describe("J09-02 · état J08 livré (rouge attendu)", () => {
    it("R1. J08 arrête la preview en même temps que l'enregistreur (violation §35.1)", async () => {
      const env = createEnv({ skills: ["capture"] });
      loadAll(env, ["native/camera-record.js"]);
      await env.MultiCamCameraRecord.prepare({ startPlanId: "R1" });
      await env.MultiCamCameraRecord.startRecording({ startPlanId: "R1" });
      await flush(8);
      await env.MultiCamCameraRecord.stopRecording();
      await flush(8);
      if (env.CameraPreview.calls.stopCamera !== 0) {
        throw new Error("J08 appelle stopCamera au STOP (" + env.CameraPreview.calls.stopCamera
          + ") — le STOP doit laisser la preview permanente ouverte");
      }
    });

    it("R2. J08 n'expose aucun point d'entrée de preview permanente", () => {
      const env = createEnv({ skills: ["capture"] });
      loadAll(env, ["native/camera-record.js"]);
      const cam = env.MultiCamCameraRecord;
      if (typeof cam.startPreview !== "function" || typeof cam.stopPreview !== "function") {
        throw new Error("camera-record.js n'expose pas startPreview()/stopPreview() "
          + "— la preview permanente n'a pas de cycle de vie propre");
      }
    });

    it("R3. J08 n'a aucune transparence conditionnelle (body toujours opaque)", () => {
      const env = createEnv({ skills: ["capture"] });
      loadAll(env, ["native/camera-record.js"]);
      /* Le CSS J08 (`html,body{background:#111827}`) est statique : aucun état
       * d'interface ne peut le rendre transparent. On vérifie donc que le code
       * JS livré ne pose aucun marqueur d'état de preview. */
      if (env.document.body._classes.size !== 0) {
        throw new Error("J08 ne pose aucune classe d'état sur le body");
      }
      if (/camera-preview-active/.test(env.logText())) {
        throw new Error("J08 journalise déjà un état de preview");
      }
    });
    /* (R4 — fond CSS inconditionnel — a rempli son rôle de témoin de l'état
     * J08 ; le contrat attendu est désormais couvert par I2.) */
  });

  describe("J09-02 · preview locale permanente (décision §35.1)", () => {
    it("A. Capture actif + app au premier plan → preview demandée au boot", async () => {
      const env = boot({ skills: ["capture", "controller"] });
      await bind(env);
      const v = env.MultiCamPreviewService.view();
      if (env.CameraPreview.calls.startCamera !== 1) {
        throw new Error("startCamera attendu 1, obtenu " + env.CameraPreview.calls.startCamera);
      }
      if (!v.active) throw new Error("preview attendue active");
      if (!v.desired) throw new Error("desired attendu true");
      if (!classOn(env)) throw new Error("classe camera-preview-active absente du body");
      if (!env.MultiCamCameraRecord.view().prepared) {
        throw new Error("camera-record ne rapporte pas prepared=true");
      }
    });

    it("A2. options natives : caméra arrière, toBack, pas de capture photo", async () => {
      const env = boot();
      await bind(env);
      const o = env.CameraPreview.lastStartOptions;
      if (!o) throw new Error("startCamera non appelé");
      if (o.toBack !== true) throw new Error("toBack attendu true, obtenu " + o.toBack);
      if (o.camera !== "back") throw new Error("camera attendue 'back', obtenu " + o.camera);
      if (o.storeToFile !== false) throw new Error("storeToFile attendu false");
      if (o.tapPhoto !== false) throw new Error("tapPhoto attendu false");
    });

    it("B. device sans skill Capture → la caméra n'est jamais ouverte", async () => {
      const env = boot({ skills: ["controller", "storage"] });
      await bind(env);
      if (env.CameraPreview.calls.startCamera !== 0) {
        throw new Error("startCamera ne doit jamais être appelé, obtenu " + env.CameraPreview.calls.startCamera);
      }
      if (env.MultiCamPreviewService.view().active) throw new Error("preview ne doit pas être active");
      if (classOn(env)) throw new Error("classe camera-preview-active posée à tort");
    });

    it("C. Capture actif + passage en arrière-plan → preview libérée", async () => {
      const env = boot();
      await bind(env);
      if (env.CameraPreview.calls.startCamera !== 1) throw new Error("prérequis A");
      env.CameraPreview.pause();
      await flush(12);
      if (env.CameraPreview.calls.stopCamera !== 1) {
        throw new Error("stopCamera attendu 1, obtenu " + env.CameraPreview.calls.stopCamera);
      }
      if (env.MultiCamPreviewService.view().active) throw new Error("preview encore active en background");
      if (classOn(env)) throw new Error("classe camera-preview-active non retirée");
    });

    it("D. retour au premier plan → preview relancée automatiquement", async () => {
      const env = boot();
      await bind(env);
      env.CameraPreview.pause();
      await flush(12);
      env.CameraPreview.resume();
      await flush(12);
      if (env.CameraPreview.calls.startCamera !== 2) {
        throw new Error("2e startCamera attendu, obtenu " + env.CameraPreview.calls.startCamera);
      }
      if (!env.MultiCamPreviewService.view().active) throw new Error("preview non reprise");
      if (!classOn(env)) throw new Error("classe camera-preview-active non reposée");
    });

    it("D2. pause/resume répétés en rafale → jamais de double ouverture", async () => {
      const env = boot();
      await bind(env);
      for (let i = 0; i < 5; i++) {
        env.CameraPreview.pause();
        env.CameraPreview.resume();
        await flush(4);
      }
      await flush(12);
      const st = env.CameraPreview.calls.startCamera - env.CameraPreview.calls.stopCamera;
      if (st !== 1) {
        throw new Error("il doit rester exactement 1 preview ouverte, solde=" + st);
      }
    });

    it("E. désactivation de la skill Capture → preview arrêtée", async () => {
      const env = boot();
      await bind(env);
      await env.MultiCamConfig.setSkill("capture", false);
      await env.MultiCamPreviewService.reconcile("test_skill_off");
      await flush(12);
      if (env.CameraPreview.calls.stopCamera !== 1) {
        throw new Error("stopCamera attendu 1, obtenu " + env.CameraPreview.calls.stopCamera);
      }
      if (env.MultiCamPreviewService.view().active) throw new Error("preview encore active");
      if (classOn(env)) throw new Error("classe camera-preview-active non retirée");
    });

    it("F. démarrage REC alors que la preview est déjà active → pas de 2e startCamera", async () => {
      const env = boot();
      await bind(env);
      if (env.CameraPreview.calls.startCamera !== 1) throw new Error("prérequis A");
      await env.MultiCamCameraRecord.prepare({ startPlanId: "P1" });
      await env.MultiCamCameraRecord.startRecording({ startPlanId: "P1" });
      await flush(8);
      if (env.CameraPreview.calls.startCamera !== 1) {
        throw new Error("startCamera supplémentaire inutile, obtenu " + env.CameraPreview.calls.startCamera);
      }
      if (env.CameraPreview.calls.startRecordVideo !== 1) throw new Error("startRecordVideo non appelé");
      if (!env.MultiCamCameraRecord.view().prepared) throw new Error("preview perdue pendant le REC");
    });

    it("F2. startRecording sans préparation préalable réutilise la preview permanente", async () => {
      const env = boot();
      await bind(env);
      /* simule une perte d'état JS : la preview native est ouverte, l'ignore */
      await env.MultiCamCameraRecord.startRecording({ startPlanId: "P2" });
      await flush(10);
      if (env.CameraPreview.calls.startCamera !== 1) {
        throw new Error("la préparation implicite doit RÉUTILISER la preview, startCamera=" + env.CameraPreview.calls.startCamera);
      }
      if (env.CameraPreview.calls.startRecordVideo !== 1) throw new Error("startRecordVideo non appelé");
    });

    it("G. STOP REC → l'enregistrement s'arrête MAIS la preview reste active", async () => {
      const env = boot();
      await bind(env);
      await env.MultiCamCameraRecord.startRecording({ startPlanId: "P3" });
      await flush(8);
      const r = await env.MultiCamCameraRecord.stopRecording();
      await flush(8);
      if (env.CameraPreview.calls.stopRecordVideo !== 1) throw new Error("stopRecordVideo attendu 1");
      if (env.MultiCamCameraRecord.view().recording) throw new Error("recording encore actif après STOP");
      if (env.CameraPreview.calls.stopCamera !== 0) {
        throw new Error("le STOP ne doit PAS fermer la preview, stopCamera=" + env.CameraPreview.calls.stopCamera);
      }
      if (!env.MultiCamCameraRecord.view().prepared) throw new Error("preview perdue après STOP");
      if (!env.MultiCamPreviewService.view().active) throw new Error("service preview inactif après STOP");
      if (!classOn(env)) throw new Error("classe camera-preview-active retirée à tort après STOP");
      if (!r.path) throw new Error("chemin vidéo absent du retour de stopRecording");
    });

    it("H. échec d'ouverture de la caméra → pas de faux état actif, fond sombre", async () => {
      const env = createEnv({ skills: ["capture"], failStartCamera: "CAMERA_BUSY" });
      loadAll(env, ["native/camera-record.js", "state/preview-service.js"]);
      await bind(env);
      const v = env.MultiCamPreviewService.view();
      if (v.active) throw new Error("preview ne doit PAS être rapportée active après un échec");
      /* La cause native doit être PRÉSERVÉE dans l'erreur exposée (le wrapper
       * camera-record préfixe son propre motif, on vérifie le contenu). */
      if (!v.error || v.error.indexOf("CAMERA_BUSY") < 0) {
        throw new Error("la cause native CAMERA_BUSY doit être conservée, obtenu " + v.error);
      }
      if (classOn(env)) throw new Error("classe camera-preview-active posée malgré l'échec");
      if (!/CAMERA_PREVIEW_ERROR/.test(env.logText())) throw new Error("log CAMERA_PREVIEW_ERROR absent");
    });

    it("H2. permission caméra refusée → preview jamais demandée", async () => {
      const env = createEnv({
        skills: ["capture"],
        config: {
          _cfg: { deviceId: "DEV-1", deviceName: "Cam 07", enabledSkills: ["capture"], supportedSkills: ["capture", "storage", "controller"], permissions: { camera: false } },
          load() { return Promise.resolve(this._cfg); },
          get() { return this._cfg; },
          setSkill() { return Promise.resolve(this._cfg); },
          skillMeta: {},
          onChange() {}
        }
      });
      loadAll(env, ["native/camera-record.js", "state/preview-service.js"]);
      await bind(env);
      if (env.CameraPreview.calls.startCamera !== 0) {
        throw new Error("startCamera ne doit pas être appelé sans permission, obtenu " + env.CameraPreview.calls.startCamera);
      }
      if (env.MultiCamPreviewService.view().active) throw new Error("preview active sans permission");
      if (classOn(env)) throw new Error("classe camera-preview-active posée sans permission");
    });

    it("H3. après un échec, un retour au premier plan peut retenter", async () => {
      const env = createEnv({ skills: ["capture"], failStartCamera: "TEMPORARY" });
      loadAll(env, ["native/camera-record.js", "state/preview-service.js"]);
      await bind(env);
      if (env.MultiCamPreviewService.view().active) throw new Error("prérequis : échec");
      env.CameraPreview.setFailStartCamera(null);
      env.CameraPreview.resume();
      await flush(14);
      if (!env.MultiCamPreviewService.view().active) throw new Error("la reprise après échec doit fonctionner");
    });

    it("I. transparence conditionnelle : fond opaque hors preview active", async () => {
      const env = boot({ skills: ["controller"] });
      await bind(env);
      /* pas de classe → le fond sombre #111827 reste appliqué par le CSS */
      if (classOn(env)) throw new Error("classe posée sans preview");
    });

    it("I2. la transparence est portée par une règle d'état explicite dans app.css", () => {
      const fs = require("fs");
      const path = require("path");
      const css = fs.readFileSync(path.join(__dirname, "..", "www", "css", "app.css"), "utf8");
      if (!/html\.camera-preview-active,body\.camera-preview-active\{background:transparent\}/.test(css)) {
        throw new Error("app.css doit conditionner la transparence à l'état camera-preview-active");
      }
      if (!/html,body\{[^}]*background:#111827/.test(css)) {
        throw new Error("le fond sombre #111827 doit rester le défaut SANS preview");
      }
      if (!/body\.camera-preview-active \.vig\{/.test(css)) {
        throw new Error("le voile doit être renforcé au-dessus d'une image caméra réelle");
      }
    });

    it("I3. la classe est posée sur <html> ET <body> (propagation des fonds CSS)", async () => {
      const env = boot();
      await bind(env);
      if (!env.document.documentElement._classes.has("camera-preview-active")) {
        throw new Error("classe absente de <html> — le fond #111827 de html resterait visible");
      }
      env.CameraPreview.pause();
      await flush(12);
      if (env.document.documentElement._classes.has("camera-preview-active")) {
        throw new Error("classe non retirée de <html>");
      }
    });

    it("J. logs parsables CAMERA_PREVIEW_START / STOP", async () => {
      const env = boot();
      await bind(env);
      const l = env.logText();
      if (!/CAMERA_PREVIEW_START/.test(l)) throw new Error("log CAMERA_PREVIEW_START absent");
      env.CameraPreview.pause();
      await flush(12);
      if (!/CAMERA_PREVIEW_STOP/.test(env.logText())) throw new Error("log CAMERA_PREVIEW_STOP absent");
    });
  });

  /* ------------------------------------------------------------------ *
   * Intégration start-service : la fin d'un plan ne doit PLUS éteindre la
   * preview permanente (§35.1). Ces tests chargent le VRAI start-service
   * avec une machine de START stubée.
   * ------------------------------------------------------------------ */
  describe("J09-02 · intégration start-service (fin de plan ≠ fermeture)", () => {
    function bootFull() {
      const env = createEnv({ skills: ["capture", "controller"] });
      loadAll(env, [
        "native/camera-record.js",
        "state/preview-service.js",
        "state/start-service.js"
      ]);
      env._mcStartMachine = {
        cancel() { return Promise.resolve({ active: false }); },
        /* Le vrai start-model fait exactement ceci dans stopLocal() :
         * il appelle `deps.stopRecording`. Le stub doit donc être FIDÈLE à ce
         * contrat, sinon on testerait le stub et non le service. */
        stopLocal() {
          return env.MultiCamCameraRecord.stopRecording().then(function () {
            return { active: false };
          });
        },
        view() { return { active: false, phase: "IDLE", rev: 0 }; },
        isActive() { return false; }
      };
      return env;
    }

    it("K. cancel() du plan → la preview permanente reste ouverte", async () => {
      const env = bootFull();
      await env.MultiCamPreviewService.bind();
      await flush(12);
      if (env.CameraPreview.calls.startCamera !== 1) throw new Error("prérequis A");
      await env.MultiCamStartService.cancel("test_cancel");
      await flush(12);
      if (env.CameraPreview.calls.stopCamera !== 0) {
        throw new Error("cancel() ne doit pas fermer la preview, stopCamera=" + env.CameraPreview.calls.stopCamera);
      }
      if (!env.MultiCamPreviewService.view().active) throw new Error("preview éteinte par cancel()");
    });

    it("L. stopLocal() → l'enregistrement s'arrête, la preview reste", async () => {
      const env = bootFull();
      await env.MultiCamPreviewService.bind();
      await flush(12);
      await env.MultiCamCameraRecord.startRecording({ startPlanId: "L1" });
      await flush(8);
      await env.MultiCamStartService.stopLocal("test_stop");
      await flush(8);
      if (env.MultiCamCameraRecord.view().recording) throw new Error("recording non arrêté");
      if (env.CameraPreview.calls.stopCamera !== 0) {
        throw new Error("stopLocal() ne doit pas fermer la preview, stopCamera=" + env.CameraPreview.calls.stopCamera);
      }
      if (!env.MultiCamPreviewService.view().active) throw new Error("preview éteinte par stopLocal()");
    });

    it("M. un REC pendant un ordre de fermeture (background) ne tue pas le REC", async () => {
      const env = bootFull();
      await env.MultiCamPreviewService.bind();
      await flush(12);
      await env.MultiCamCameraRecord.startRecording({ startPlanId: "M1" });
      await flush(8);
      env.CameraPreview.pause();
      await flush(12);
      /* §35.1 : la fermeture est différée, jamais un arrêt silencieux du REC
       * (cette décision appartient à J10). */
      if (!env.MultiCamCameraRecord.view().recording) {
        throw new Error("le REC ne doit pas être arrêté par un passage en arrière-plan (décision J10)");
      }
      if (!/CAMERA_PREVIEW_STOP_DEFERRED/.test(env.logText())) {
        throw new Error("la fermeture différée doit être journalisée");
      }
    });

    it("N. l'état journalisé reflète l'état RÉEL (pas une constante)", async () => {
      const env = bootFull();
      await env.MultiCamPreviewService.bind();
      await flush(12);
      if (!/CAMERA_PREVIEW_STATE active=1/.test(env.logText())) {
        throw new Error("ouverture : attendu CAMERA_PREVIEW_STATE active=1");
      }      env.CameraPreview.pause();
      await flush(12);
      if (!/CAMERA_PREVIEW_STATE active=0/.test(env.logText())) {
        throw new Error("fermeture : la télémétrie doit annoncer active=0, pas une valeur figée");
      }
    });
  });
}

module.exports = { register };
