/* MultiCam J08 — tests de la GLUE (start-service + camera-record + pont WS).
 *
 * start-model.test.js vérifie le modèle PUR avec ses dépendances injectées.
 * Ce fichier vérifie l'autre moitié : que le service réel implémente
 * correctement ces dépendances contre les VRAIES formes de données de
 * l'application (vue ARM, store de session, broadcastTargeted, plugin caméra).
 * C'est ici que se voient les erreurs de raccordement : mauvais chemin de vue
 * (clock en map et non {peers}), offsets jamais mesurés, double préparation
 * caméra, top déclenché deux fois, reply de sonde non routée…
 *
 * Les trois modules testés sont des IIFE branchés sur `window` (pas de UMD) :
 * on les charge dans un contexte vm avec un `window` factice. Le modèle, lui,
 * est chargé DANS le même contexte pour que le service voie exactement le même
 * objet (pas de doublon de realm).
 *
 * Timers réels (setTimeout) et countdown à 0 s : le lead structurel J08 vaut
 * 300 ms, un bloc dure donc ~0,5 s. C'est volontaire : on veut éprouver la
 * chaîne de timers réelle, pas une horloge simulée.
 *
 * Blocs couverts (19) :
 *   1-4.  bind + pont START ; captureReady crée la PreviewSurface (une fois) ;
 *         release ; release refusé pendant un enregistrement ;
 *   5-9.  requestStart : refresh J07 avant verrouillage, startPlanId
 *         armCycleId#seq, lead structurel 300 ms (countdown 0), clockOffsets au
 *         signe J07 (jamais inversé), participants par rôle strict, top réel
 *         → UN startRecordVideo + START_NATIVE_ACK, stopLocal puis Take
 *         verrouillé (local_stopped_take) ;
 *   10-13. refus : clock_stale (rien n'est diffusé), no_remote_capture, caméra
 *         KO (bloqué AVANT tout plan), double demande (plan_active) ;
 *   14.   cancel Master → plan abandonné, aucun enregistrement ;
 *   15-16. adoption d'un plan distant par le pont, sonde NTP émise et réponse
 *         routée (signe local−créateur), sonde sans réponse → countdown
 *         dégradé honnête ;
 *   17-19. profil natif (1080P transmis, invalide omis), double démarrage
 *         refusé, chemin de fichier propagé à l'arrêt.
 *
 * Le modèle et le service partagent le MÊME contexte vm : une divergence de
 * forme de vue (clock en map, pas {peers}) ou d'offset non mesuré est donc
 * détectée ici, pas seulement en campagne sur appareil.
 *
 * Usage :  node session/start-service.test.js
 */

"use strict";

const path = require("path");
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "../../../app/www/js");
const A = "devA-master-capture";
const B = "devB-capture";
const C = "devC-capture";
const S = "devS-storage";
const SID = "sess-j08";

let blocks = 0;
async function block(title, fn) {
  blocks++;
  console.log("\n[" + String(blocks).padStart(2, "0") + "] " + title);
  await fn();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------- bac à sable : une application factice mais STRUCTURÉE comme la vraie ---------- */

function makeApp(opts) {
  opts = opts || {};
  const logs = [];
  const wire = [];              /* tout ce que le service veut envoyer */
  const camera = { calls: [], started: 0, stopped: 0, prepared: 0, released: 0, lastProfile: "absent" };
  const bridgeBox = { bridge: null };
  const peers = opts.peers || {};          /* did -> connecté ? */
  let clockSeq = 0;

  const session = {
    sessionId: SID,
    name: "Regie J08",
    state: "open",
    pin: "1234",
    masters: [{ deviceId: A, deviceName: "Cam A", endpoint: "10.0.0.1:45102" }],
    members: [
      { deviceId: A, enabledSkills: ["master", "capture"], sessionRoles: ["master"] },
      { deviceId: B, enabledSkills: ["capture"], sessionRoles: [] },
      { deviceId: C, enabledSkills: ["capture"], sessionRoles: [] },
      { deviceId: S, enabledSkills: ["storage"], sessionRoles: [] }
    ],
    takes: [{
      takeNumber: 3,
      captures: [A, B, C],
      storages: [S],
      /* FORME RÉELLEMENT PERSISTÉE (take-model.js) : les réglages d'un Take,
       * dont countdownSeconds, vivent dans `settings` — PAS au niveau du Take.
       * Une fixture qui plaçait countdownSeconds à la racine faisait passer le
       * test alors que l'app ne produit jamais cette forme : le choix 3 s ou
       * 10 s de l'écran 05 était donc ignoré au START. */
      settings: {
        video: { resolution: "FHD", quality: "HIGH", camera: "REAR", orientation: "LANDSCAPE" },
        audio: true,
        gpsProfile: "NORMAL",
        countdownSeconds: opts.countdownSeconds === undefined ? 0 : opts.countdownSeconds,
        transferAuto: true,
        deleteLocalAfterVerifiedReplication: true
      },
      status: "PREPARATION"
    }]
  };
  if (opts.takes) session.takes = opts.takes;

  /* Crochet d'horloge du service ARM : remplaçable par un test pour vérifier
   * que le START attend le rafraîchissement avant de verrouiller sa cible. */
  let armClockHook = () => Promise.resolve({ fresh: true, waitedMs: 0 });
  const armClock = (fn) => { armClockHook = fn; };

  const armView = {
    active: true,
    sid: SID,
    takeNumber: session.takes[0].takeNumber,
    armCycleId: opts.armCycleId || (SID + "#3#1"),
    devices: opts.onlyLocalCapture ? [{ did: A, deviceName: "Cam A", skills: [{ skill: "capture", status: "ok" }] }] : [
      { did: A, deviceName: "Cam A", skills: [{ skill: "capture", status: "ok" }] },
      { did: B, deviceName: "Cam B", skills: [{ skill: "capture", status: "ok" }] },
      { did: C, deviceName: "Cam C", skills: [{ skill: "capture", status: "ok" }] },
      { did: S, deviceName: "Store S", skills: [{ skill: "storage", status: "ok" }] }
    ],
    /* Forme RÉELLE de arm-model : clock est une MAP did -> échantillon. */
    clock: {},
    recEligible: true
  };
  /* Offsets « remote mesuré par le leader » : C_local − C_creator, convention J08. */
  const offsets = opts.offsets || { [B]: -250, [C]: 600 };
  Object.keys(offsets).forEach((did) => {
    armView.clock[did] = {
      status: "ok",
      message: "ok",
      offsetMs: offsets[did],
      rttMs: 12,
      dispersionMs: 2,
      samples: 5,
      lastSyncMs: Date.now() - (opts.clockAgeMs || 50)
    };
  });
  if (opts.clockAgeMs === 60000) {
    Object.keys(armView.clock).forEach((d) => { armView.clock[d].lastSyncMs = Date.now() - 60000; });
  }

  /* Tous les fakes vivent sur `window` : c'est le seul objet que le WebView
   * rend global, et donc le seul que les modules lisent. Le bac vm ne sert
   * qu'à fournir timers/console au contexte. */
  const win = {
    innerWidth: 1080,
    innerHeight: 1920,
    screen: { width: 1080, height: 1920 },
    MultiCamConfig: { get: () => ({ deviceId: A, deviceName: "Cam A", permissions: { camera: true } }) },
    MultiCamSessionStore: { get: (sid) => Promise.resolve(sid === SID ? JSON.parse(JSON.stringify(session)) : null) },
    session: session,
    MultiCamArmService: {
      view: () => armView,
      refresh: () => { armView.refreshCount = (armView.refreshCount || 0) + 1; },
      /* Même contrat que le vrai arm-service.js: ensureFreshClock expose une
       * promesse. Le comportement par défaut est une horloge déjà fraîche. */
      ensureFreshClock: function (t) { return armClockHook(t); }
    },
    MultiCamSessionWs: {
      status: () => ({ localDid: A, localName: "Cam A" }),
      connectedPeers: () => peers,
      setStartBridge: (b) => { bridgeBox.bridge = b; },
      broadcastTargeted: (kind, ses, extra) => {
        wire.push({ kind, sid: ses && ses.sessionId, extra: extra || null });
        logs.push("WIRE " + kind + " " + JSON.stringify(extra && extra.startPlanId || ""));
      }
    },
    /* Plugin natif factice : mêmes signatures que cordova-plugin-camera-preview. */
    CameraPreview: {
      CAMERA_DIRECTION: { BACK: "back" },
      startCamera: (o, ok, ko) => {
        camera.calls.push({ fn: "startCamera", o });
        if (opts.cameraKo) { ko("CAMERA_HARDWARE_ERROR"); return; }
        camera.prepared++;
        setTimeout(() => ok({ started: true }), 1);
      },
      stopCamera: (ok) => { camera.calls.push({ fn: "stopCamera" }); camera.released++; ok({ stopped: true }); },
      startRecordVideo: (o, ok, ko) => {
        camera.calls.push({ fn: "startRecordVideo", o });
        camera.started++;
        camera.lastProfile = Object.prototype.hasOwnProperty.call(o, "camcorderProfile") ? o.camcorderProfile : "absent";
        clockSeq++;
        if (opts.recKo) { ko("NO_CAMERA"); return; }
        setTimeout(() => ok({ recording: true }), 1);
      },
      stopRecordVideo: (ok) => {
        camera.calls.push({ fn: "stopRecordVideo" });
        camera.stopped++;
        ok("/storage/emulated/0/MultiCam/take-003.mp4");
      }
    }
  };
  win.console = { log: (l) => logs.push(String(l)) };
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.setInterval = setInterval;
  win.clearInterval = clearInterval;
  win.Date = Date;
  win.isFinite = isFinite;
  win.Promise = Promise;
  win.Math = Math;
  win.JSON = JSON;
  win.Object = Object;
  win.Array = Array;
  win.String = String;
  win.Number = Number;
  win.Error = Error;
  win.self = win;
  win.globalThis = win;
  win.window = win;

  /* Les timers doivent exister sur le CONTEXTE (le service appelle setTimeout
   * nu) ET sur window (le code applicatif y accède par window.setTimeout). */
  const sandbox = {
    window: win, self: win, globalThis: win,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: setInterval, clearInterval: clearInterval
  };
  vm.createContext(sandbox);
  /* Le contexte vm fournit un `console` FANTÔME (typé 'object' mais qui
   * n'écrit rien) : sans injection explicite, tous les logs du modèle
   * disparaissent et les assertions de journalisation deviennent fausses. */
  sandbox.console = win.console;

  ["state/start-model.js", "state/start-service.js", "native/camera-record.js"].forEach((rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    vm.runInContext(src, sandbox, { filename: rel });
  });
  /* Le modèle UMD s'est attaché sur `module` s'il existe — on n'en fournit pas :
   * il doit donc être sur window, comme dans le WebView. */
  assert.ok(win.MultiCamStartModel, "le modèle doit être attaché à window");
  assert.ok(win.MultiCamStartService, "le service doit être attaché à window");
  assert.ok(win.MultiCamCameraRecord, "le wrapper caméra doit être attaché à window");

  return { win, logs, wire, camera, armView, session, bridgeBox, peers, armClock };
}

function has(logs, sub) { return logs.some((l) => l.indexOf(sub) >= 0); }
function count(logs, sub) { return logs.filter((l) => l.indexOf(sub) >= 0).length; }
function one(logs, sub, msg) {
  const n = count(logs, sub);
  assert.strictEqual(n, 1, (msg || sub) + " (trouvé " + n + " fois)");
}

(async function main() {

  /* ---------- 1. pont transport + preparation caméra ---------- */
  {
    const app = makeApp();
    await block("bind() : machine créée + pont START branché sur le WS", async function () {
      app.win.MultiCamStartService.bind();
      assert.ok(app.win.MultiCamStartService.machine(), "machine accessible");
      assert.ok(app.bridgeBox.bridge, "setStartBridge a été appelé");
      assert.strictEqual(typeof app.bridgeBox.bridge.onStartMessage, "function");
      has(app.logs, "START_SERVICE_READY");
    });

    await block("captureReady : la PreviewSurface est réellement créée, une seule fois", async function () {
      const svc = app.win.MultiCamStartService;
      await svc.start(SID);
      svc.refreshReadiness();                       /* sans plan : aucun effet */
      const v1 = app.win.MultiCamCameraRecord.view();
      assert.strictEqual(v1.prepared, false, "aucune préparation sans plan");
      const r = await app.win.MultiCamCameraRecord.prepare({ startPlanId: "x#1" });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(app.camera.prepared, 1, "startCamera appelé une fois");
      const call = app.camera.calls.filter((c) => c.fn === "startCamera")[0];
      assert.strictEqual(call.o.camera, "back", "caméra arrière");
      assert.strictEqual(call.o.toBack, true, "preview native derrière le WebView");
      assert.strictEqual(call.o.tapPhoto, false, "aucune photo (takeSnapshot interdit en REC)");
      assert.strictEqual(call.o.width, 1080, "largeur viewport");
      await app.win.MultiCamCameraRecord.prepare({ startPlanId: "x#2" });
      assert.strictEqual(app.camera.prepared, 1, "préparation idempotente");
      has(app.logs, "CAMERA_PREP_SKIP");
    });

    await block("libération : annulé → stopCamera appelé, exactement une fois", async function () {
      await app.win.MultiCamCameraRecord.release("test_release");
      assert.strictEqual(app.camera.released, 1);
      assert.strictEqual(app.win.MultiCamCameraRecord.view().prepared, false);
    });

    await block("release refusé pendant un enregistrement (pas de caméra volée)", async function () {
      await app.win.MultiCamCameraRecord.prepare({ startPlanId: "y#1" });
      await app.win.MultiCamCameraRecord.startRecording({ startPlanId: "y#1", takeNumber: 3, localTargetMs: Date.now() });
      assert.strictEqual(app.camera.started, 1);
      const before = app.camera.released;
      await app.win.MultiCamCameraRecord.release("doit_echouer");
      assert.strictEqual(app.camera.released, before, "stopCamera NON appelé");
      has(app.logs, "CAMERA_RELEASE_DEFERRED");
      await app.win.MultiCamCameraRecord.stopRecording();
      assert.strictEqual(app.camera.stopped, 1, "stopRecordVideo appelé");
    });
  }

  /* ---------- 2. Creation de plan :offsets, lead, refus ---------- */
  {
    const app = makeApp();
    await block("requestStart : plan créé, horloge rafraîchie AVANT le verrouillage", async function () {
      const svc = app.win.MultiCamStartService;
      svc.bind();
      await svc.start(SID);
      const v = await svc.requestStart(SID);
      assert.strictEqual(app.armView.refreshCount, 1, "refreshArmClock appelé");
      assert.ok(v.startPlanId, "startPlanId attribué");
      assert.strictEqual(v.startPlanId, app.armView.armCycleId + "#1", "armCycleId#seq");
      assert.strictEqual(v.takeNumber, 3, "take courant");
      const plan = app.wire.filter((w) => w.kind === "start_plan")[0];
      assert.ok(plan, "start_plan diffusé");
      assert.strictEqual(plan.extra.plan.targetStartMs - plan.extra.plan.createdAtMs, 300,
        "countdown 0 → lead STRUCTUREL de 300 ms");
      assert.strictEqual(plan.extra.plan.countdownSeconds, 0);
      assert.strictEqual(plan.extra.plan.createdByDeviceId, A);
      has(app.logs, "START_PLAN_CREATED");
      has(app.logs, "START_REQUEST");
      has(app.logs, "START_CLOCK_FRESHNESS");
    });

    await block("plan : clockOffsets = mesure J07 du leader, signe NON inversé", async function () {
      const plan = app.wire.filter((w) => w.kind === "start_plan")[0].extra.plan;
      assert.deepStrictEqual(JSON.parse(JSON.stringify(plan.clockOffsets)), { [B]: -250, [C]: 600 });
      has(app.logs, "peer=" + B + " offsetMs=-250 ageMs=");
    });

    await block("participants : rôles STRICTS (Capture/Storage), pas de rôle nu", async function () {
      const plan = app.wire.filter((w) => w.kind === "start_plan")[0].extra.plan;
      const byRole = {};
      plan.participants.forEach((p) => { byRole[p.deviceId] = p.role; });
      assert.deepStrictEqual(JSON.parse(JSON.stringify(byRole)), { [A]: "capture", [B]: "capture", [C]: "capture", [S]: "storage" });
    });

    await block("top réel : UN startRecordVideo, delta journalisé, plan terminé", async function () {
      await sleep(700);
      assert.strictEqual(app.camera.started, 1, "startRecordVideo appelé EXACTEMENT une fois");
      assert.strictEqual(app.camera.prepared, 1, "aucune seconde préparation au top");
      has(app.logs, "START_LOCAL deviceId=" + A);
      has(app.logs, "status=OK");
      has(app.logs, "START_NATIVE_ACK");
      one(app.logs, "START_PLAN_COMPLETE");
      const states = app.wire.filter((w) => w.kind === "start_state").map((w) => w.extra.state);
      assert.ok(states.indexOf("ACCEPTED") >= 0, "état ACCEPTED publié");
      assert.ok(states.indexOf("STARTED") >= 0, "état STARTED publié après l'accusé natif");
    });

    await block("stopLocal : un seul stopRecordVideo, phase STOPPED, Take verrouillé", async function () {
      const svc = app.win.MultiCamStartService;
      await svc.stopLocal("test");
      assert.strictEqual(app.camera.stopped, 1, "stopRecordVideo appelé une fois");
      assert.ok(app.camera.released >= 1, "caméra libérée après l'arrêt");
      has(app.logs, "START_STOP_LOCAL");
      has(app.logs, "status=STOPPED");
      let err = null;
      try { await svc.requestStart(SID); } catch (e) { err = e.message; }
      assert.strictEqual(err, "local_stopped_take", "un Take arrêté ne se relance pas");
      has(app.logs, "reason=local_stopped_take");
    });
  }

  /* ---------- 3. refus : horloge perimee, camera KO, double plan ---------- */
  {
    const app = makeApp({ clockAgeMs: 60000 });
    await block("offset J07 périmé → plan REFUSÉ (clock_stale), rien n'est diffusé", async function () {
      const svc = app.win.MultiCamStartService;
      svc.bind();
      await svc.start(SID);
      let err = null;
      try { await svc.requestStart(SID); } catch (e) { err = e.message; }
      assert.strictEqual(err, "clock_stale");
      has(app.logs, "reason=clock_stale");
      assert.strictEqual(app.wire.filter((w) => w.kind === "start_plan").length, 0, "AUCUN plan diffusé");
      assert.strictEqual(app.camera.started, 0, "rien n'est enregistré");
    });
  }

  {
    const app = makeApp({ onlyLocalCapture: true });
    await block("aucune Capture distante sélectionnée → refus no_remote_capture", async function () {
      const svc = app.win.MultiCamStartService;
      svc.bind();
      await svc.start(SID);
      let err = null;
      try { await svc.requestStart(SID); } catch (e) { err = e.message; }
      assert.strictEqual(err, "no_remote_capture");
      assert.strictEqual(app.wire.filter((w) => w.kind === "start_plan").length, 0);
    });
  }

  {
    const app = makeApp({ cameraKo: true });
    await block("caméra KO → demande bloquée AVANT tout plan (pas de plan inutile)", async function () {
      const svc = app.win.MultiCamStartService;
      svc.bind();
      await svc.start(SID);
      let err = null;
      try { await svc.requestStart(SID); } catch (e) { err = e.message; }
      assert.strictEqual(err, "camera_prepare_failed");
      assert.strictEqual(app.wire.filter((w) => w.kind === "start_plan").length, 0, "aucun plan diffusé");
      has(app.logs, "START_REQUEST_BLOCKED");
      has(app.logs, "CAMERA_PREP_KO");
    });
  }

  {
    const app = makeApp();
    await block("double demande pendant le countdown → refusée (plan_active)", async function () {
      const svc = app.win.MultiCamStartService;
      svc.bind();
      await svc.start(SID);
      await svc.requestStart(SID);
      let err = null;
      try { await svc.requestStart(SID); } catch (e) { err = e.message; }
      assert.strictEqual(err, "plan_active");
      assert.strictEqual(app.wire.filter((w) => w.kind === "start_plan").length, 1, "un seul plan");
    });
  }

  /* ---------- 4. annulation + sonde NTP dirigee via le pont ---------- */
  {
    const app = makeApp();
    await block("cancel Master → plan abandonné, aucun startRecordVideo", async function () {
      const svc = app.win.MultiCamStartService;
      svc.bind();
      await svc.start(SID);
      await svc.requestStart(SID);
      await svc.cancel("master_cancel");
      assert.strictEqual(app.wire.filter((w) => w.kind === "start_cancel").length, 1, "annulation diffusée");
      has(app.logs, "START_CANCEL");
      has(app.logs, "START_PLAN_ABORTED");
      await sleep(600);
      assert.strictEqual(app.camera.started, 0, "RIEN n'a été enregistré après annulation");
      assert.ok(app.camera.released >= 1, "préparation relâchée");
    });
  }

  {
    /* Régression J08 : `lastSession` est épinglé à l'adoption d'un plan. Un
     * 2e START sur la MÊME session (après un « Nouveau Take ») servait ce cache
     * et.armait l'ANCIEN Take : le 1er START l'ayant arrêté, le modèle rejetait
     * `local_stopped_take` — impossible de relancer un enregistrement. */
    const app = makeApp();
    await block("2e START après Nouveau Take : session RELUE, Take courant ar[m]é", async function () {
      const svc = app.win.MultiCamStartService;
      svc.bind();
      await svc.start(SID);
      await svc.requestStart(SID);
      await svc.cancel("campagne");
      assert.strictEqual(app.session.takes.length, 1, "Take 3 seul au départ");
      /* Take 4 ajouté comme le fait l'écran 05 (« Nouveau Take »). */
      app.session.takes = app.session.takes.concat([{
        takeNumber: 4, captures: [A, B, C], storages: [S], countdownSeconds: 0, status: "PREPARATION"
      }]);
      const v = await svc.requestStart(SID);
      assert.strictEqual(v.takeNumber, 4, "le Take courant (4) est armé, pas le 3 arrêté");
      assert.strictEqual(app.logs.filter((l) => l.indexOf("reason=local_stopped_take") >= 0).length, 0,
        "aucun rejet local_stopped_take sur le Take 3 arrêté");
    });
  }

  {
    const app = makeApp();
    await block("plan distant reçu par le pont → adopté + sonde NTP-réponse routée", async function () {
      const svc = app.win.MultiCamStartService;
      svc.bind();
      await svc.start(SID);
      const bridge = app.bridgeBox.bridge;
      const plan = {
        startPlanId: SID + "#3#9#7",
        sessionId: SID,
        sessionName: "Regie J08",
        takeNumber: 3,
        armCycleId: SID + "#3#9",
        targetStartMs: Date.now() + 4000,
        countdownSeconds: 4,
        dispatchLeadMs: 4000,
        createdByDeviceId: "devD-master",
        createdAtMs: Date.now(),
        clockOffsets: {},
        participants: [{ deviceId: A, deviceName: "Cam A", role: "capture", takeNumber: 3 }]
      };
      await bridge.onStartMessage({ v: 1, kind: "start_plan", from: "devD-master", sessionId: SID, ts: Date.now(), plan: plan });
      const v = svc.view();
      assert.strictEqual(v.startPlanId, plan.startPlanId, "plan adopté");
      assert.strictEqual(v.phase, "COUNTDOWN");
      assert.strictEqual(v.isMaster, true, "A est Master de la session");
      assert.strictEqual(v.isCapture, true);
      has(app.logs, "START_PLAN_ACCEPTED");
      has(app.logs, "START_CLOCK_UNKNOWN");

      /* Ce device n'a pas d'offset dans le plan → il sonde le créateur. */
      const probes = app.wire.filter((w) => w.kind === "start_probe");
      assert.strictEqual(probes.length, 1, "une sonde émise vers le créateur");
      assert.strictEqual(probes[0].extra.target, "devD-master");

      /* Réponse de sonde : le reply doit être-adjusté en signe (peer−local
       *oggles → local−creator). */
      await bridge.onStartMessage({
        v: 1, kind: "start_probe_reply", from: "devD-master", sessionId: SID, ts: Date.now(),
        startPlanId: plan.startPlanId, requestId: probes[0].extra.requestId, t1: Date.now() - 30, t2: Date.now() - 20
      });
      const v2 = svc.view();
      assert.strictEqual(v2.countdownResolved, true, "offset résolu");
      assert.ok(typeof v2.offsetMs === "number", "offset numérique");
      has(app.logs, "START_PROBE deviceId=" + A);
      has(app.logs, "localMinusCreator=");

      /* annulation distante */
      await bridge.onStartMessage({
        v: 1, kind: "start_cancel", from: "devD-master", sessionId: SID, ts: Date.now(),
        startPlanId: plan.startPlanId, byDeviceId: "devD-master", reason: "master_cancel"
      });
      assert.strictEqual(svc.view().phase, "IDLE", "plan annulé");
      has(app.logs, "START_CANCEL");
    });
  }

  {
    const app = makeApp();
    await block("plan distant SANS reply de sonde → offset inconnu, countdown dégradé HONNÊTE", async function () {
      const svc = app.win.MultiCamStartService;
      svc.bind();
      await svc.start(SID);
      const plan = {
        startPlanId: SID + "#3#1#1", sessionId: SID, takeNumber: 3, armCycleId: SID + "#3#1",
        targetStartMs: Date.now() + 2000, countdownSeconds: 2, dispatchLeadMs: 2000,
        createdByDeviceId: "devE-master", createdAtMs: Date.now(), clockOffsets: {}, participants: []
      };
      await app.bridgeBox.bridge.onStartMessage({ v: 1, kind: "start_plan", from: "devE-master", sessionId: SID, ts: Date.now(), plan: plan });
      assert.strictEqual(svc.view().countdownResolved, false);
      has(app.logs, "START_CLOCK_UNKNOWN");
      has(app.logs, "probe_timeout");
    });
  }

  /* ---------- 5. profil natif + idempotence demarrage ---------- */
  {
    const app = makeApp();
    await block("profil natif : 1080P transmis, valeur invalide OMISE (pas de null cassant)", async function () {
      const cam = app.win.MultiCamCameraRecord;
      await cam.startRecording({ startPlanId: "p#1", takeNumber: 3, localTargetMs: Date.now(), profile: "1080P" });
      assert.strictEqual(app.camera.lastProfile, "1080P");
      await cam.stopRecording();
      await cam.startRecording({ startPlanId: "p#2", takeNumber: 3, localTargetMs: Date.now(), profile: "4K" });
      assert.strictEqual(app.camera.lastProfile, "absent", "profil non supporté → omis");
      has(app.logs, "CAMERA_REC_PROFILE_IGNORE");
      await cam.stopRecording();
    });

    await block("double startRecordVideo sans arrêt → ignoré (pas de REC fantôme)", async function () {
      const cam = app.win.MultiCamCameraRecord;
      const before = app.camera.started;
      await cam.startRecording({ startPlanId: "p#3", takeNumber: 3, localTargetMs: Date.now() });
      const again = await cam.startRecording({ startPlanId: "p#4", takeNumber: 3, localTargetMs: Date.now() });
      assert.strictEqual(app.camera.started, before + 1, "un seul vrai démarrage");
      assert.strictEqual(again.detail, "already_recording", "le second appel est refusé");
      has(app.logs, "CAMERA_REC_SKIP");
      await cam.stopRecording();
    });

    await block("chemin du fichier renvoyé par stopRecordVideo (traçabilité J09)", async function () {
      const r = await app.win.MultiCamCameraRecord.stopRecording();
      assert.ok(typeof r.path === "string", "chemin propagé");
      has(app.logs, "CAMERA_REC_STOP_OK");
    });
  }

  {
    /* Régression J08 : le countdown choisi sur l'écran 05 doit être celui du
     * plan. Il est PERSISTÉ dans take.settings.countdownSeconds (take-model.js),
     * jamais à la racine du Take. Un lecteur a `take.countdownSeconds` lit donc
     * toujours undefined et retombe sur 5 s : les choix 0/3/10 s étaient
     * ignorés en silence, pendant que l'UI affichait la valeur choisie. */
    for (const want of [0, 3, 5, 10]) {
      const app = makeApp({ countdownSeconds: want });
      await block("countdown choisi " + want + " s → le plan porte EXACTEMENT " + want + " s", async function () {
        const svc = app.win.MultiCamStartService;
        svc.bind();
        await svc.start(SID);
        await svc.requestStart(SID);
        const plan = app.wire.filter((w) => w.kind === "start_plan")[0].extra.plan;
        assert.strictEqual(plan.countdownSeconds, want,
          "countdownSeconds du plan = valeur choisie dans take.settings");
        if (want > 0) {
          assert.ok(plan.targetStartMs - plan.createdAtMs >= want * 1000,
            "la cible est au moins countdown s dans le futur");
        } else {
          assert.strictEqual(plan.targetStartMs - plan.createdAtMs, 300,
            "countdown 0 → lead STRUCTUREL de 300 ms");
        }
      });
    }
  }

  {
    /* L'idempotence de prepare() est couverte SEQUENTIELLEMENT (PREP_SKIP).
     * Sur le terrain, ARM et l'appui REC peuvent préparer en MÊME temps : sans
     * verrou `preparing`/`preparePromise`, deux startCamera natifs s'exécutent
     * (deux PreviewSurface). Instance neuve : le verrou est un état d'instance. */
    const app = makeApp();
    await block("2 preparations CONCURRENTES → un seul startCamera (garde de course)", async function () {
      const cam = app.win.MultiCamCameraRecord;
      const [a, b] = await Promise.all([
        cam.prepare({ startPlanId: "z#1" }),
        cam.prepare({ startPlanId: "z#2" })
      ]);
      assert.strictEqual(app.camera.calls.filter((c) => c.fn === "startCamera").length, 1,
        "un SEUL startCamera natif pour 2 prepare() concurrents");
      assert.strictEqual(app.camera.prepared, 1, "une seule préparation native");
      assert.ok(a.ok && b.ok, "les deux promesses résolvent OK");
      assert.ok(cam.view().prepared, "la PreviewSurface est prête pour les deux appelants");
    });
  }

  {
    /* Le modele doit verrouiller targetStart sur une horloge FRAICHE : si
     * refreshArmClock() ne resolvait pas avant le plan, le top partirait d'une
     * horloge périmée (symptôme : START_LOCAL très en écart de la cible). */
    const app = makeApp();
    await block("requestStart ATTEND l'horloge fraîche avant de verrouiller la cible", async function () {
      let release = null;
      const pending = new Promise(function (r) { release = r; });
      app.armClock(function () {
        return pending.then(function () { return { fresh: true, waitedMs: 7 }; });
      });
      const svc = app.win.MultiCamStartService;
      svc.bind();
      await svc.start(SID);
      const inFlight = svc.requestStart(SID);
      await sleep(30);
      assert.strictEqual(app.wire.filter((w) => w.kind === "start_plan").length, 0,
        "AUCUN plan tant que l'horloge n'est pas fraîche");
      release();
      const v = await inFlight;
      assert.ok(v.startPlanId, "plan créé une fois l'horloge fraîche");
      assert.strictEqual(app.wire.filter((w) => w.kind === "start_plan").length, 1, "un seul plan");
      has(app.logs, "START_SERVICE_CLOCK_READY");
    });
  }

  console.log("\nOK — " + blocks + " blocs, tous verts.");
  /* Sortie explicite : une machine restée en phase REC reprogramme son tick de
   * rafraîchissement (comportement voulu du modèle), ce qui laisse des timers
   * en attente et empêche Node de se terminer seul. Le plan de test est fini. */
  process.exit(0);
})().catch(function (err) {
  console.error("\n" + (err && err.stack || err));
  process.exit(1);
});
