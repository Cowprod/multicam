/* MultiCam — J09-03 : échantillonneur de preview locale pendant REC
 * (Producteur PixelCopy ~1 img/s, SANS transport réseau).
 *
 * Ces tests pilotent une horloge VIRTUELLE (`createEnv({fakeClock:true})`) :
 * la cadence nominale est de 1000 ms, on ne peut donc pas la qualifier en
 * attendant de vraies secondes. Ce qui est vérifié ici est la LOGIQUE de
 * planification (rythme, anti-concurrence, cycle de vie, compteurs) ;
 * la cadence RÉELLE est qualifiée par le smoke physique.
 *
 * Couverture (les 9 points exigés) :
 *   S1. start en REC            → première capture demandée
 *   S2. cadence                 → ~1 demande / seconde
 *   S3. capture en vol au tick  → AUCUNE 2e capture concurrente
 *   S4. stop()                  → plus aucune capture
 *   S5. double start()          → une seule boucle
 *   S6. erreur PixelCopy        → boucle continue + compteur incrémenté
 *   S7. sortie de REC           → sampler arrêté
 *   S8. background / preview    → sampler arrêté
 *   S9. retour REC              → sampler neuf, sans timer résiduel
 */

"use strict";

function register(h) {
  const { describe, it, createEnv, loadAll, flush } = h;

  const SID = "SESS01";
  const TAKE = 7;

  /* ---------- environnement ---------- */

  function boot(opts) {
    opts = opts || {};
    const env = createEnv(Object.assign({
      fakeClock: true,
      skills: ["capture"],
      pixelCopyMode: "manual"
    }, opts));
    loadAll(env, [
      "native/pixelcopy.js",
      "native/camera-record.js",
      "state/preview-service.js",
      "state/preview-sampler.js"
    ]);
    env.sampler = env.MultiCamPreviewSampler;
    return env;
  }

  /* Les accusés natifs (startCamera, startRecordVideo, stopRecordVideo) passent
   * par les timers de l'env : avec une horloge virtuelle ils ne se déclenchent
   * QUE pendant `clock.advance()`. On lance donc l'appel, on avance l'horloge,
   * puis on await le résultat — sinon on deadlock. */
  async function native(env, fn) {
    const p = fn();
    await env.clock.advance(20);
    return p;
  }

  /* Amène le device Capture en REC (preview native ouverte + MediaRecorder).
   * C'est l'état réel au top d'un plan : `recording` ET `prepared`. */
  async function enterRec(env) {
    await native(env, () => env.MultiCamCameraRecord.prepare({ startPlanId: "P1" }));
    await native(env, () => env.MultiCamCameraRecord.startRecording({ startPlanId: "P1" }));
  }

  async function leaveRec(env) {
    await native(env, () => env.MultiCamCameraRecord.stopRecording());
  }

  function startSampler(env) {
    return env.sampler.start({ sessionId: SID, takeNumber: TAKE, startPlanId: "P1" });
  }

  /* ---------- micro-assertions ---------- */

  function eq(actual, want, msg) {
    if (actual !== want) {
      throw new Error((msg ? msg + " — " : "") + "attendu " + want + ", obtenu " + actual);
    }
  }
  function ok(cond, msg) { if (!cond) throw new Error(msg || "condition fausse"); }

  function logLines(env, re) { return env.logs.filter((l) => re.test(l)); }
  function stats(env) { return env.sampler.view().stats; }

  /* ══════════════ 0. PÉRIMÈTRE : la preview ne capture pas ══════════════
   *
   * Garde-fou de conception : avant J09-03 la brique PixelCopy était qualifiée
   * mais SANS AUCUN appelant produit. L'échantillonnage a une responsabilité
   * DÉDIÉE (`state/preview-sampler.js`) ; ni la preview permanente ni
   * l'enregistreur ne doivent appeler `capturePreviewSurface` tout seuls. Ce
   * bloc échouerait si on avait collé un `setInterval` dans la preview service.
   */
  describe("J09-03 · périmètre de responsabilité", () => {
    it("R1. preview permanente + REC n'appellent JAMAIS capturePreviewSurface seuls", async () => {
      const env = createEnv({ skills: ["capture"] });
      loadAll(env, ["native/camera-record.js", "state/preview-service.js"]);
      await env.MultiCamPreviewService.bind();
      await flush(12);
      const p = env.MultiCamCameraRecord.startRecording({ startPlanId: "R1" });
      await flush(8); await p;
      const s = env.MultiCamCameraRecord.stopRecording();
      await flush(8); await s;
      eq(env.CameraPreview.calls.capturePreviewSurface, 0,
        "l'échantillonnage a une responsabilité dédiée : ni la preview ni "
        + "l'enregistreur ne doivent déclencher de capture");
    });

    it("R2. un sampler actif est le SEUL à déclencher des captures", async () => {
      const env = boot();
      await enterRec(env);
      eq(env.CameraPreview.calls.capturePreviewSurface, 0,
        "avant start(), aucune capture : le REC seul ne suffit pas");
      startSampler(env);
      eq(env.CameraPreview.calls.capturePreviewSurface, 1,
        "la capture vient bien du sampler");
    });
  });

  /* ══════════════ 1. start en REC ══════════════ */
  describe("J09-03 · démarrage en REC", () => {
    it("S1. start() en REC déclenche immédiatement la première capture", async () => {
      const env = boot();
      await enterRec(env);
      eq(startSampler(env), true, "le sampler doit démarrer en REC");
      eq(env.CameraPreview.calls.capturePreviewSurface, 1, "une capture doit être demandée");
      eq(env.sampler.view().running, true, "le sampler tourne");
      eq(env.sampler.view().seq, 1, "seq démarre à 1");
      eq(env.sampler.view().inFlight, true, "la capture est en vol");
      eq(stats(env).requested, 1, "requested=1");
    });

    it("S1b. start() HORS REC est refusé (la preview permanente ne suffit pas)", async () => {
      const env = boot();
      await native(env, () => env.MultiCamCameraRecord.prepare({ startPlanId: "P0" }));
      /* preview native ACTIVE mais pas d'enregistrement : la règle de cycle de
       * vie interdit de sampler « juste parce que la preview est ouverte ». */
      eq(env.MultiCamCameraRecord.view().prepared, true, "la preview doit être active");
      eq(startSampler(env), false, "start hors REC doit être refusé");
      eq(env.CameraPreview.calls.capturePreviewSurface, 0, "aucune capture demandée");
      ok(/PREVIEW_CAPTURE_START .*status=REFUSED reason=not_recording/.test(env.logText()),
        "le refus doit être journalisé avec un motif parsable");
    });
  });

  /* ══════════════ 2. cadence ══════════════ */
  describe("J09-03 · cadence nominale", () => {
    it("S2. ~1 capture par seconde, rythme stable sur 10 s", async () => {
      const env = boot({ pixelCopyMode: "auto", pixelCopyLatencyMs: 90 });
      await enterRec(env);
      startSampler(env);
      /* La 1re image part à t0, puis une par seconde ancrée. Sur 9 s
       * d'avance : t0, t+1000 … t+9000 = 10 demandes ; on avance de 200 ms de
       * plus pour que la dernière (latence 90 ms) soit bien revenue. */
      await env.clock.advance(9200);
      const v = env.sampler.view();
      eq(v.stats.requested, 10, "10 demandes en 9 s (1/s)");
      eq(v.stats.ok, 10, "10 succès");
      eq(v.stats.error, 0, "aucune erreur");
      eq(v.stats.skipped, 0, "aucun skip : la latence (90 ms) reste sous l'intervalle");

      /* Rythme réel des INSTANTS DE DEMANDE, mesuré sur l'horloge virtuelle. */
      const req = v.samples.map((s) => s.requestedAt);
      const gaps = req.slice(1).map((t, i) => t - req[i]);
      const all = [req[1] - req[0]].concat(gaps);
      ok(all.every((g) => g === 1000),
        "chaque écart entre demandes doit valoir exactement 1000 ms (pas de dérive) — "
        + JSON.stringify(all));
    });

    it("S2b. la cadence ne dérive pas malgré une capture lente", async () => {
      const env = boot({ pixelCopyMode: "auto", pixelCopyLatencyMs: 400 });
      await enterRec(env);
      startSampler(env);
      await env.clock.advance(6000);
      const req = env.sampler.view().samples.map((s) => s.requestedAt);
      const gaps = req.slice(1).map((t, i) => t - req[i]);
      ok(gaps.every((g) => g === 1000),
        "une latence de 400 ms ne doit pas décaler la grille — écarts: " + JSON.stringify(gaps));
    });
  });

  /* ══════════════ 3. anti-concurrence ══════════════ */
  describe("J09-03 · aucune capture concurrente", () => {
    it("S3. capture encore en vol au tick suivant → SKIP, pas de 2e capture", async () => {
      const env = boot();               /* mode manual : la capture ne revient pas */
      await enterRec(env);
      startSampler(env);
      eq(env.CameraPreview.calls.capturePreviewSurface, 1, "capture 1 demandée");
      eq(env.sampler.view().inFlight, true, "capture 1 toujours en vol");

      await env.clock.advance(1000);   /* tick n°2 alors que la 1 est en vol */
      eq(env.CameraPreview.calls.capturePreviewSurface, 1,
        "AUCUNE 2e capture ne doit partir tant que la 1re n'est pas revenue");
      eq(env.sampler.view().stats.skipped, 1, "le skip doit être compté");
      ok(/PREVIEW_CAPTURE_SKIP .*seq=2 reason=capture_in_flight/.test(env.logText()),
        "le SKIP doit être journalisé avec son motif");
      eq(env.CameraPreview.pixelCopy.maxInFlight, 1, "maxInFlight doit rester à 1");

      /* Une fois la 1re revenue, la cadence repart. */
      env.CameraPreview.pixelCopy.settle("ok");
      await env.clock.advance(0);
      eq(env.sampler.view().inFlight, false, "verrou libéré");
      eq(env.sampler.view().stats.ok, 1, "la capture revenue est comptée OK");
    });

    it("S3b. le chien de garde libère le verrou si le natif ne rappelle jamais", async () => {
      const env = boot();
      await enterRec(env);
      startSampler(env);
      eq(env.sampler.view().inFlight, true, "capture en vol");
      /* CALLBACK_TIMEOUT_MS = 2500 : le verrou doit être relâché, sinon la
       * boucle se bloquerait définitivement et silencieusement. */
      await env.clock.advance(2500);
      eq(env.sampler.view().inFlight, false, "le chien de garde doit libérer le verrou");
      eq(env.sampler.view().stats.noCallback, 1, "l'absence de callback doit être tracée");
      ok(/PREVIEW_CAPTURE_ERROR .*reason=no_callback/.test(env.logText()),
        "l'absence de callback doit être journalisée");
      /* et la boucle repart normalement */
      await env.clock.advance(1000);
      eq(env.CameraPreview.calls.capturePreviewSurface, 2, "la cadence doit repartir");
    });
  });

  /* ══════════════ 4. stop ══════════════ */
  describe("J09-03 · arrêt", () => {
    it("S4. stop() → plus aucune capture, et idempotent", async () => {
      const env = boot({ pixelCopyMode: "auto", pixelCopyLatencyMs: 0 });
      await enterRec(env);
      startSampler(env);
      await env.clock.advance(3000);
      const before = env.CameraPreview.calls.capturePreviewSurface;
      ok(before > 0, "des captures ont eu lieu avant l'arrêt");

      eq(env.sampler.stop("test"), true, "stop doit arrêter le sampler");
      eq(env.sampler.view().running, false, "plus en marche");
      eq(env.sampler.view().timerPending, false, "plus aucun timer");

      await env.clock.advance(5000);
      eq(env.CameraPreview.calls.capturePreviewSurface, before,
        "aucune capture ne doit être demandée après stop()");

      ok(/PREVIEW_CAPTURE_STOP .*reason=test/.test(env.logText()),
        "l'arrêt doit être journalisé avec son motif");
      /* Idempotence */
      eq(env.sampler.stop("test"), false, "un second stop() doit être sans effet");
      eq(env.clock.pending(), 0, "aucun timer résiduel après stop()");
    });

    it("S4b. le compte rendu de stop() porte les compteurs du run", async () => {
      const env = boot({ pixelCopyMode: "auto", pixelCopyLatencyMs: 0 });
      await enterRec(env);
      startSampler(env);
      await env.clock.advance(4000);
      env.sampler.stop("fin");
      const line = logLines(env, /PREVIEW_CAPTURE_STOP/)[0];
      ok(/seq=5 requested=5 ok=5/.test(line),
        "compteurs du run attendus dans le log (t0 + 4 ticks) — " + line);
      ok(/error=0 skipped=0/.test(line), "aucune erreur ni skip attendu — " + line);
    });
  });

  /* ══════════════ 5. double start ══════════════ */
  describe("J09-03 · démarrage unique", () => {
    it("S5. double start() sur la même cible → une seule boucle", async () => {
      const env = boot({ pixelCopyMode: "auto", pixelCopyLatencyMs: 0 });
      await enterRec(env);
      eq(startSampler(env), true, "1er start");
      eq(startSampler(env), false, "2e start sur la même cible doit être refusé");
      await env.clock.advance(1000);
      eq(env.CameraPreview.calls.capturePreviewSurface, 2,
        "une seule boucle malgré le double start (t0 + 1 tick, pas 2 en parallèle)");
      eq(env.CameraPreview.pixelCopy.maxInFlight, 1, "aucune concurrence");
      ok(/PREVIEW_CAPTURE_START .*status=SKIPPED reason=already_running/.test(env.logText()),
        "le refus de double start doit être journalisé");
    });
  });

  /* ══════════════ 6. erreur PixelCopy ══════════════ */
  describe("J09-03 · robustesse aux erreurs", () => {
    it("S6. erreur PixelCopy → compteur incrémenté, boucle intacte", async () => {
      const env = boot({ pixelCopyMode: "auto", pixelCopyLatencyMs: 0, pixelCopyFailWith: "surface_invalide" });
      await enterRec(env);
      startSampler(env);
      await env.clock.advance(1000);
      eq(env.sampler.view().stats.error, 2, "compteur d'erreur incrémenté (t0 + tick)");
      eq(env.sampler.view().stats.ok, 0, "aucun succès");
      eq(env.sampler.view().running, true, "la boucle doit survivre à l'erreur");
      ok(/PREVIEW_CAPTURE_ERROR .*reason=surface_invalide/.test(env.logText()),
        "l'erreur doit être tracée avec son motif");

      /* Le tick suivant doit être honoré : on ne s'arrête pas sur l'erreur. */
      await env.clock.advance(2000);
      eq(env.sampler.view().stats.error, 4, "l'erreur ne doit pas casser la boucle");
      eq(env.sampler.view().running, true, "toujours en marche");
    });

    it("S6b. payload vide → erreur tracée, pas de faux succès", async () => {
      const env = boot({ pixelCopyMode: "auto", pixelCopyLatencyMs: 0 });
      await enterRec(env);
      startSampler(env);
      env.CameraPreview.pixelCopy.pending[0].settle("ok", "");
      await env.clock.advance(0);
      eq(env.sampler.view().stats.ok, 0, "un payload vide n'est pas un succès");
      eq(env.sampler.view().stats.error, 1, "payload vide = erreur");
      ok(/PREVIEW_CAPTURE_ERROR .*reason=empty_payload/.test(env.logText()),
        "le payload vide doit être journalisé");
    });

    it("S6c. les mesures d'une image réussie sont exploitables", async () => {
      const env = boot({ pixelCopyMode: "auto", pixelCopyLatencyMs: 120, pixelCopyBase64Length: 4000 });
      await enterRec(env);
      startSampler(env);
      await env.clock.advance(1000);
      const s = env.sampler.view().samples[0];
      ok(s && s.ok, "l'échantillon doit être un succès");
      eq(s.durationMs, 120, "durationMs = latence PixelCopy mesurée");
      eq(s.base64Length, 4000, "base64Length mesuré");
      eq(s.bytes, 3000, "bytes décodés déduits du base64 (4000/4*3)");
      ok(/PREVIEW_CAPTURE_OK .*durationMs=120 bytes=3000 base64Length=4000/.test(env.logText()),
        "le log OK doit porter durationMs/bytes/base64Length");
    });
  });

  /* ══════════════ 7. sortie de REC ══════════════ */
  describe("J09-03 · sortie de REC", () => {
    it("S7. sortie de REC → sampler arrêté (sync)", async () => {
      const env = boot({ pixelCopyMode: "auto", pixelCopyLatencyMs: 0 });
      await enterRec(env);
      startSampler(env);
      await env.clock.advance(2000);
      ok(env.sampler.view().running, "le sampler tourne pendant le REC");

      await leaveRec(env);                 /* stopRecording → recording=false */
      env.sampler.sync("rec_end");
      eq(env.sampler.view().running, false, "le sampler doit s'arrêter à la sortie du REC");

      const before = env.CameraPreview.calls.capturePreviewSurface;
      await env.clock.advance(5000);
      eq(env.CameraPreview.calls.capturePreviewSurface, before,
        "plus aucune capture après la sortie du REC");
      ok(/PREVIEW_CAPTURE_STOP .*reason=not_recording/.test(env.logText()),
        "l'arrêt doit être motivé par la fin du REC");
    });

    it("S7b. le REC venu à échéance arrête le sampler via la réconciliation", async () => {
      const env = boot({ pixelCopyMode: "auto", pixelCopyLatencyMs: 0 });
      await enterRec(env);
      startSampler(env);
      await env.clock.advance(2000);
      await leaveRec(env);
      env.sampler.sync("phase_changed");
      eq(env.sampler.view().running, false, "arrêt attendu");
      eq(env.sampler.view().timerPending, false, "plus de timer");
    });
  });

  /* ══════════════ 8. background / preview inactive ══════════════ */
  describe("J09-03 · arrière-plan et preview inactive", () => {
    it("S8. preview libérée → sampler arrêté", async () => {
      const env = boot({ pixelCopyMode: "auto", pixelCopyLatencyMs: 0 });
      await enterRec(env);
      startSampler(env);
      await env.clock.advance(2000);
      ok(env.sampler.view().running, "le sampler tourne");

      /* La caméra devient indisponible (ex. permission révoquée, skill off,
       * teardown) : `prepared` passe à false. */
      await native(env, () => env.MultiCamCameraRecord.teardown("test"));
      env.sampler.sync("preview_lost");
      eq(env.sampler.view().running, false, "le sampler doit s'arrêter si la preview tombe");
      ok(/PREVIEW_CAPTURE_STOP .*reason=(preview_inactive|not_recording)/.test(env.logText()),
        "l'arrêt doit être motivé par la perte de preview ou de REC");
      const before = env.CameraPreview.calls.capturePreviewSurface;
      await env.clock.advance(5000);
      eq(env.CameraPreview.calls.capturePreviewSurface, before, "aucune capture ensuite");
    });

    it("S8b. arrière-plan AVEC caméra encore vivante → le sampler continue (J10)", async () => {
      const env = boot({ pixelCopyMode: "auto", pixelCopyLatencyMs: 0 });
      await native(env, () => env.MultiCamPreviewService.bind());
      await enterRec(env);
      startSampler(env);
      await env.clock.advance(1000);

      env.CameraPreview.pause();          /* arrière-plan */
      await env.clock.advance(20);
      /* §35.1 diffère la libération de la caméra pendant un REC : la preview
       * reste donc vivante et le sampler doit continuer (décision J10). */
      eq(env.MultiCamCameraRecord.view().prepared, true, "la caméra doit être conservée");
      eq(env.sampler.view().running, true, "le sampler doit survivre en arrière-plan");
      await env.clock.advance(1000);
      eq(env.CameraPreview.calls.capturePreviewSurface, 3,
        "la cadence continue en arrière-plan (t0 + 2 ticks)");
    });
  });

  /* ══════════════ 9. retour REC ══════════════ */
  describe("J09-03 · nouveau REC", () => {
    it("S9. retour REC → sampler neuf, sans timer résiduel, compteurs remis à zéro", async () => {
      const env = boot({ pixelCopyMode: "auto", pixelCopyLatencyMs: 0 });
      await enterRec(env);
      startSampler(env);
      await env.clock.advance(3000);
      const run1 = env.sampler.view().stats.requested;
      ok(run1 >= 3, "des captures ont eu lieu pendant le 1er REC");

      await leaveRec(env);
      env.sampler.stop("rec_end");
      eq(env.clock.pending(), 0, "aucun timer résiduel après le 1er REC");
      const seqRun1 = env.sampler.view().seq;

      /* Nouveau REC. */
      await native(env, () => env.MultiCamCameraRecord.startRecording({ startPlanId: "P2" }));
      startSampler(env);
      eq(env.sampler.view().stats.requested, 1, "les compteurs du nouveau run repartent de zéro");
      /* J09-D1 : MÊME session → la séquence NE repart pas de 1. C'est le
       * compteur que le Master compare à son `lastFrameSeq` (anti-replay) :
       * une remise à zéro gèle la vignette le temps du rattrapage. */
      eq(env.sampler.view().seq, seqRun1 + 1,
        "J09-D1 : la séquence du run 2 CONTINUE celle du run 1 (jamais de retour en arrière)");
      eq(env.sampler.view().runs, 2, "deux runs comptabilisés");
      eq(env.CameraPreview.pixelCopy.maxInFlight, 1, "aucune concurrence entre les deux runs");

      await env.clock.advance(2000);
      eq(env.sampler.view().stats.requested, 3, "la cadence du 2e REC est propre (t0 + 2 ticks)");
      /* Un seul timer de planification à tout moment. */
      ok(env.clock.pending() <= 2, "pas de timer résiduel cumulé — pending=" + env.clock.pending());
    });

    it("S9b. changer de Take relance un sampler propre", async () => {
      const env = boot({ pixelCopyMode: "auto", pixelCopyLatencyMs: 0 });
      await enterRec(env);
      env.sampler.start({ sessionId: SID, takeNumber: 1, startPlanId: "P1" });
      await env.clock.advance(2000);

      /* Nouveau Take alors que le sampler tourne : restart, pas doublon. */
      eq(env.sampler.start({ sessionId: SID, takeNumber: 2, startPlanId: "P2" }), true,
        "un nouveau Take doit (re)démarrer le sampler");
      eq(env.sampler.view().takeNumber, "2", "le take courant doit être à jour");
      eq(env.sampler.view().stats.requested, 1, "compteurs remis à zéro");
      ok(/PREVIEW_CAPTURE_STOP .*reason=restart:new_take/.test(env.logText()),
        "l'ancien run doit être arrêté proprement avant le nouveau");
    });
  });

  /* ══════════════ 10. INTÉGRATION PRODUIT (PHASE 2) ══════════════
   *
   * On pilote la VRAIE machine de START (`state/start-service.js` +
   * `state/start-model.js`) avec un plan délégué, pour prouver que :
   *   - le sampler démarre après l'accusé NATIF du REC (phase REC effective) ;
   *   - il ne démarre NI pendant le COUNTDOWN, NI sur un simple start();
   *   - il s'arrête sur le STOP local ;
   *   - sa vie ne dépend d'aucun rendu d'écran.
   */
  describe("J09-03 · intégration sur le cycle START/REC réel", () => {
    const DID = "dddddddd-0000-0000-0000-00000000000d";   /* ce device */
    const SID2 = "SESS02";

    function bootStart(opts) {
      opts = opts || {};
      const env = createEnv(Object.assign({
        fakeClock: true,
        skills: ["capture"],
        pixelCopyMode: "auto",
        pixelCopyLatencyMs: 0
      }, opts));
      loadAll(env, [
        "native/pixelcopy.js",
        "native/camera-record.js",
        "state/preview-service.js",
        "state/preview-sampler.js",
        "state/start-model.js",
        "state/start-service.js"
      ]);
      /* Store minimal : ce device est Master ET Capture de SESS02. */
      const sessions = {};
      sessions[SID2] = {
        sessionId: SID2, state: "open", name: "S",
        masters: [{ deviceId: DID, endpoint: "10.0.0.2:45102" }],
        members: [{ deviceId: DID, roles: ["master", "capture"] }]
      };
      env.MultiCamSessionStore = {
        get(sid) { return Promise.resolve(sessions[sid] || null); },
        list() { return Promise.resolve(Object.keys(sessions).map((k) => sessions[k])); },
        save(s) { sessions[s.sessionId] = s; return Promise.resolve(s); }
      };
      env.MultiCamConfig = {
        get() { return { deviceId: DID, deviceName: "Cap", enabledSkills: ["capture"], permissions: {} }; },
        load() { return Promise.resolve({ deviceId: DID }); },
        onChange() {}
      };
      env.MultiCamArmService = {
        view() { return { active: false, offsetMs: 0, inRange: true, armedCycleId: "C1" }; },
        refreshClock() { return Promise.resolve(null); }
      };
      env.MultiCamSessionWs = {
        status() { return { localDid: DID }; },
        broadcastTargeted() { return 0; },
        onView() {},
        isActive() { return false; }
      };
      env.MultiCamNet = { start() {}, stop() {} };
      env.sampler = env.MultiCamPreviewSampler;
      return env;
    }

    /* Plan délégué au format attendu par le modèle (startPlanId à 4 segments,
     * offset d'horloge connu, participant explicite). Le top est fixé par
     * l'appelant ; countdown 0 → le REC démarre au top. */
    function plan(startMs, role) {
      return {
        startPlanId: "PLAN1#1#1#1",
        sessionId: SID2, takeNumber: 3,
        targetStartMs: startMs, countdownSeconds: 0,
        clockOffsets: (function () { var o = {}; o[DID] = 0; return o; })(),
        participants: [{ deviceId: DID, role: role || "capture" }],
        createdByDeviceId: DID + "-peer",
        profile: "720P", createdAtMs: startMs - 1000
      };
    }


    it("S10. le sampler ne démarre PAS avant l'entrée effective en REC", async () => {
      const env = bootStart();
      env.MultiCamStartService.bind();
      await env.clock.advance(5);
      const m = env.MultiCamStartService.machine();

      await m.onIncoming({
        kind: "start_plan", from: DID + "-p", sessionId: SID2,
        plan: plan(env.clock.now() + 3000)
      });
      await env.clock.advance(500);
      eq(m.state.phase, "COUNTDOWN", "on doit être en COUNTDOWN avant le top");
      eq(env.sampler.view().running, false, "aucun échantillonnage pendant le COUNTDOWN");
      eq(env.CameraPreview.calls.capturePreviewSurface, 0, "aucune capture avant le REC");

      /* Top. */
      for (let i = 0; i < 40 && m.state.phase !== "REC"; i++) {
        await env.clock.advance(200);
        m.tickNow();
      }
      eq(m.state.phase, "REC", "le device doit être en REC");
      eq(env.sampler.view().running, true, "le sampler doit démarrer à l'entrée en REC");
      eq(env.CameraPreview.calls.capturePreviewSurface, 1, "première capture demandée");
      ok(/PREVIEW_CAPTURE_START .*status=OK/.test(env.logText()),
        "PREVIEW_CAPTURE_START journalisé");
      /* L'ordre est net : accusé natif du REC PUIS démarrage du sampler. */
      const recOk = env.logs.findIndex((l) => /CAMERA_REC_OK/.test(l));
      const smpStart = env.logs.findIndex((l) => /PREVIEW_CAPTURE_START .*status=OK/.test(l));
      ok(recOk >= 0 && smpStart > recOk,
        "le sampler doit démarrer APRÈS l'accusé natif du REC");
    });

    it("S11. le STOP local arrête le sampler et le REC", async () => {
      const env = bootStart();
      env.MultiCamStartService.bind();
      await env.clock.advance(5);
      const m = env.MultiCamStartService.machine();
      await m.onIncoming({
        kind: "start_plan", from: DID + "-p", sessionId: SID2,
        plan: plan(env.clock.now() + 3000)
      });
      for (let i = 0; i < 40 && m.state.phase !== "REC"; i++) {
        await env.clock.advance(200);
        m.tickNow();
      }
      eq(m.state.phase, "REC", "REC attendu");
      await env.clock.advance(3000);
      ok(env.sampler.view().stats.ok >= 2, "des captures ont eu lieu pendant le REC");

      /* `stopLocal` attend l'accusé natif de `stopRecordVideo`, qui passe par
       * les timers virtuels : on avance l'horloge avant de l'attendre. */
      const stopping = m.stopLocal("test");
      await env.clock.advance(20);
      await stopping;
      eq(m.state.phase, "STOPPED", "le device doit être STOPPED");
      eq(env.sampler.view().running, false, "le sampler doit être arrêté au STOP");
      eq(env.sampler.view().timerPending, false, "plus aucun timer");
      ok(/PREVIEW_CAPTURE_STOP .*reason=rec_stop/.test(env.logText()),
        "l'arrêt doit être motivé par l'arrêt du REC");

      const before = env.CameraPreview.calls.capturePreviewSurface;
      await env.clock.advance(5000);
      eq(env.CameraPreview.calls.capturePreviewSurface, before, "plus aucune capture après le STOP");
    });

    it("S12. un device NON-Capture ne déclenche pas de capture", async () => {
      const env = bootStart();
      /* Cette fois le device n'est QUE master dans la session. */
      env.MultiCamSessionStore.get = function (sid) {
        return Promise.resolve(sid === SID2 ? {
          sessionId: SID2, state: "open", name: "S",
          masters: [{ deviceId: DID, endpoint: "10.0.0.2:45102" }],
          members: [{ deviceId: DID, roles: ["master"] }]
        } : null);
      };
      env.MultiCamStartService.bind();
      await env.clock.advance(5);
      const m = env.MultiCamStartService.machine();
      await m.onIncoming({
        kind: "start_plan", from: DID + "-p", sessionId: SID2,
        plan: plan(env.clock.now() + 3000, "master")
      });
      for (let i = 0; i < 40 && m.state.phase !== "REC"; i++) {
        await env.clock.advance(200);
        m.tickNow();
      }
      eq(env.CameraPreview.calls.startRecordVideo, 0, "un device non-Capture n'enregistre pas");
      eq(env.CameraPreview.calls.capturePreviewSurface, 0,
        "et donc ne produit aucune image de preview");
    });
  });

  /* ══════════════ J09-D1 · monotonie de la séquence ══════════════ */
  describe("J09-D1 · la séquence ne repart jamais à 0 dans une session", () => {
    /* L'ordre des `ok` EST l'ordre des `seq` que le Master reçoit et compare à
     * son `lastFrameSeq` (anti-replay, live-model). */
    function record(env) {
      const seqs = [];
      env.sampler.onEvent(function (type, ev) { if (type === "ok") seqs.push(ev.seq); });
      return seqs;
    }

    function monotone(list, msg) {
      for (let i = 1; i < list.length; i++) {
        if (!(list[i] > list[i - 1])) {
          throw new Error(msg + " — seq[" + (i - 1) + "]=" + list[i - 1]
            + " puis seq[" + i + "]=" + list[i]);
        }
      }
    }

    it("D1.1 une bascule (suspend → reprise) ne remet PAS la séquence à 0", async () => {
      const env = boot({ pixelCopyMode: "auto", pixelCopyLatencyMs: 0 });
      await enterRec(env);
      const seqs = record(env);
      startSampler(env);
      await env.clock.advance(3000);
      ok(seqs.length >= 3, "previews produites avant la bascule — " + seqs.length);
      const avant = seqs[seqs.length - 1];

      /* EXACTEMENT ce que fait camera-switch-service : `suspendSampling()` →
       * `stop()` avant toute opération physique, puis `resumeSampling()` →
       * `start()` après la confirmation native, avec les MÊMES identifiants. */
      env.sampler.stop("camera_switch:before_switch");
      eq(env.sampler.start({
        sessionId: SID, takeNumber: TAKE, startPlanId: "P1",
        reason: "camera_switch:after"
      }), true, "la reprise de l'échantillonnage doit démarrer");

      eq(env.sampler.view().runs, 2, "la bascule a bien relancé le sampler");
      eq(env.sampler.view().stats.requested, 1,
        "les compteurs de RUN restent remis à zéro (ce n'est PAS la séquence)");
      ok(env.sampler.view().seq > avant,
        "la séquence doit CONTINUER après la bascule (avant=" + avant
        + ", après=" + env.sampler.view().seq + ")");

      const avantCount = seqs.length;
      await env.clock.advance(3000);
      ok(seqs.length >= avantCount + 2, "previews produites après la bascule — "
        + (seqs.length - avantCount));
      monotone(seqs, "J09-D1 : la séquence doit être strictement croissante de bout en bout");
      ok(env.sampler.view().seq >= seqs[seqs.length - 1],
        "view().seq suit la dernière image demandée");
    });

    it("D1.2 une NOUVELLE session repart bien de l'état initial", async () => {
      const env = boot({ pixelCopyMode: "auto", pixelCopyLatencyMs: 0 });
      await enterRec(env);
      startSampler(env);
      await env.clock.advance(3000);
      ok(env.sampler.view().seq > 1, "la première session a bien avancé — seq="
        + env.sampler.view().seq);

      env.sampler.stop("session_end");
      eq(env.sampler.start({ sessionId: "SESS02", takeNumber: 1, startPlanId: "Q1" }),
        true, "une session nouvelle démarre normalement");
      eq(env.sampler.view().seq, 1,
        "une session nouvelle repart de l'état initial (c'est le Master qui "
        + "reconstruit ses slots, live-model.setTake)");
    });
  });

  /* ══════════════ garde-fous produit ══════════════ */
  describe("J09-03 · périmètre", () => {
    it("P1. le sampler ne touche à aucun transport réseau", async () => {
      const env = boot({ pixelCopyMode: "auto", pixelCopyLatencyMs: 0 });
      await enterRec(env);
      startSampler(env);
      await env.clock.advance(3000);
      const v = env.sampler.view();
      /* Rien de ce qui est exposé ne doit permettre l'envoi d'une image : la
       * sonde locale expose une image, mais AUCUN module réseau n'est chargé
       * ni appelé par le sampler. */
      ok(v.stats.ok >= 2, "des captures ont eu lieu");
      ok(!/sendOn|WebSocket|broadcast/.test(env.logText()),
        "le sampler ne doit produire aucun log de transport");
      ok(typeof env.MultiCamSessionWs === "undefined",
        "le sampler ne doit charger aucun module de transport");
    });

    it("P2. peek() n'expose qu'UNE image locale, jamais une archive", async () => {
      const env = boot({ pixelCopyMode: "auto", pixelCopyLatencyMs: 0, pixelCopyBase64Length: 1000 });
      await enterRec(env);
      startSampler(env);
      await env.clock.advance(4000);
      const p = env.sampler.peek();
      ok(p && typeof p.base64 === "string", "peek doit renvoyer la dernière image");
      eq(p.base64.length, 1000, "taille de la dernière image");
      /* Les métadonnées ne contiennent JAMAIS de base64. */
      env.sampler.view().samples.forEach((s) => {
        ok(s.base64 === undefined && s.base64Length !== undefined,
          "samples ne doit contenir que des métadonnées, pas d'image");
      });
      env.sampler.stop("fin");
      eq(env.sampler.peek(), null, "la sonde est vidée à l'arrêt");
    });
  });
}

module.exports = { register };
