/* MultiCam — J09-07 : changement de caméra pendant REC (§35.1 → §35.3).
 *
 * Ce que la suite vérifie, et pourquoi chaque point existe :
 *
 *   M*. MODÈLE PUR — ce qui est autorisé, ce qui est refusé, et le fait que
 *       l'inventaire est fail-closed. Un modèle qui « devine » une présence de
 *       caméra produirait un ACK mensonger : le pire des défauts ici.
 *
 *   N*. FRONTIÈRE NATIVE — l'ordre des opérations réelles et les DEUX
 *       confirmations indépendantes. §35.1 impose stop → switch → relecture →
 *       restart ; une implémentation qui annonce la cible avant la relecture
 *       passerait tous les tests d'UI et aucun test natif.
 *
 *   S*. SERVICE + TRANSPORT — qui a le droit d'ordonner, ce qui est segmenté,
 *       ce qui est idempotent, et le fait que l'ACK ne part qu'après le Fait.
 *
 * Deux conventions du modèle, reprises telles quelles ici :
 *   - les caméras sont `REAR` / `FRONT` en MAJUSCULES (la couche native
 *     convertit en `back` / `front` au dernier moment) ;
 *   - `session.members` est une liste d'OBJETS `{deviceId}`.
 *
 * Le faux plugin sépare `physicalCameras` (ce qui EXISTE) de `activeFacing`
 * (ce qui FILME). Sans cette séparation, `getCameraState` renverrait la valeur
 * qu'on vient d'écrire, et une confirmation optimiste passerait tous les tests.
 */

"use strict";

function register(h) {
  const { describe, it, createEnv, loadAll, flush } = h;

  const ME = "DEV-1";
  const CAP = "DEV-2";
  const OTHER = "DEV-3";
  const STRANGER = "DEV-999";
  const SID = "SESS01";
  const TAKE = 7;

  /* ---------- micro-assertions ---------- */

  function eq(actual, want, msg) {
    if (actual !== want) {
      throw new Error((msg ? msg + " — " : "") + "attendu " + JSON.stringify(want)
        + ", obtenu " + JSON.stringify(actual));
    }
  }
  function yes(v, msg) { if (!v) throw new Error(msg || "condition fausse"); }
  function no(v, msg) { eq(!!v, false, msg); }

  /* ---------- modèle pur ---------- */

  function bootModel() {
    const env = createEnv({ skills: ["capture", "controller"] });
    loadAll(env, ["native/capture-capabilities.js", "state/camera-switch-model.js"]);
    env.M = env.MultiCamCameraSwitchModel;
    return env;
  }

  function session() {
    return {
      sessionId: SID,
      name: "Tournage",
      state: "open",
      members: [{ deviceId: ME }, { deviceId: CAP }, { deviceId: OTHER }],
      masters: [{ deviceId: ME }, { deviceId: OTHER }]
    };
  }

  function takeOf(captures) {
    return {
      takeNumber: TAKE,
      captures: captures || [CAP]
    };
  }

  /* Session porteuse d'un Take, comme le store la rend. */
  function sessionWithTake() {
    const s = session();
    s.takes = [takeOf([ME, CAP])];
    return s;
  }

  function stateWith(cameras, active) {
    const st = bootModel().M.createState(SID);
    st.availableCameras = cameras.slice();
    st.activeCamera = active || "";
    return st;
  }

  const ORDER = "stopRecordVideo>switchCameraTo>getCameraState>startRecordVideo";

  /* ══════════════════ M · modèle pur ══════════════════ */

  describe("J09-07 · modèle — validation et inventaire", () => {
    it("M1. une caméra hors modèle est refusée, jamais devinée", () => {
      const env = bootModel();
      eq(env.M.normalizeCamera("front"), "FRONT");
      eq(env.M.normalizeCamera("back"), "REAR");
      eq(env.M.normalizeCamera("LENS_FACING_FRONT"), "FRONT", "le natif peut nommer autrement");
      eq(env.M.normalizeCamera("before"), "", "aucune valeur inventée");
      eq(env.M.normalizeCamera(""), "");
      eq(env.M.normalizeCamera(null), "");
      eq(env.M.normalizeCamera(3), "", "un nombre n'est pas une caméra");
    });

    it("M2. l'inventaire BRUT donne les caméras PHYSIQUES, pas les résolutions", () => {
      const env = bootModel();
      const av = env.M.availableFromRaw({
        cameras: [{ facing: "front", widths: [] }, { facing: "back", widths: ["1920x1080"] }]
      });
      yes(av.known, "une réponse brute lisible EST une information");
      eq(av.cameras.join(","), "REAR,FRONT",
        "l'ordre du modèle est stable, même si le natif énumère à l'envers");
    });

    it("M3. l'inventaire est FAIL-CLOSED : forme J06, erreur, absence", () => {
      const env = bootModel();
      /* La forme J06 {rear:[résolutions]} NE PROUVE PAS la présence physique :
       * une arrière sans profil 1080P y verrait une liste vide. */
      no(env.M.availableFromRaw({ cameras: { rear: ["1920x1080"], front: [] } }).known,
        "la forme normalisée ne dit rien de la présence physique");
      eq(env.M.availableFromRaw({ cameras: { rear: ["1920x1080"] } }).cameras.length, 0);

      /* Un device qui répond mais ne trouve aucune caméra : connu, vide. */
      const empty = env.M.availableFromRaw({ cameras: [] });
      yes(empty.known, "une réponse vide est une réponse");
      eq(empty.cameras.length, 0, "et elle ne doit rien inventer");

      /* Un device qui ERRE : inconnu, jamais « aucune caméra ». */
      no(env.M.availableFromRaw({ cameras: [{ facing: "back", error: "CAMERA_ERROR" }] }).known,
        "une erreur native ne vaut pas absence de caméra");
      eq(env.M.availableFromRaw(null).known, false);
      eq(env.M.availableFromRaw({}).known, false);
      eq(env.M.availableFromRaw({ cameras: [{ facing: "sideways" }] }).cameras.length, 0);
    });

    it("M4. un émetteur non-Master est refusé", () => {
      const env = bootModel();
      const r = env.M.validateAuthority(
        { sessionId: SID, takeNumber: TAKE, targetDeviceId: CAP, camera: "FRONT", commandId: "c1" },
        { session: session(), take: takeOf(), isMaster: false, captureRole: true, actorDeviceId: OTHER }
      );
      no(r.ok);
      eq(r.code, env.M.ERR.NOT_MASTER, "tous les Masters ont la MÊME autorité, tous les autres aucune");
    });

    it("M5. une cible qui n'est pas Capture du Take est refusée", () => {
      const env = bootModel();
      const r = env.M.validateAuthority(
        { sessionId: SID, takeNumber: TAKE, targetDeviceId: OTHER, camera: "FRONT", commandId: "c2" },
        { session: session(), take: takeOf(), isMaster: true, captureRole: false, actorDeviceId: ME }
      );
      no(r.ok);
      eq(r.code, env.M.ERR.TARGET_NOT_CAPTURE,
        "un Storage ou un Master simple n'a pas de caméra à piloter");
    });

    it("M6. session, cible et joignabilité sont recoupées AVANT la caméra", () => {
      const env = bootModel();
      const base = { session: session(), take: takeOf(), isMaster: true, captureRole: true, actorDeviceId: ME };
      const mk = (o) => Object.assign(
        { sessionId: SID, takeNumber: TAKE, targetDeviceId: CAP, camera: "FRONT", commandId: "c" }, o);

      eq(env.M.validateAuthority(mk({ sessionId: "SESS02" }), base).code,
        env.M.ERR.SESSION_MISMATCH);
      eq(env.M.validateAuthority(mk({ takeNumber: 9 }), base).code,
        env.M.ERR.TAKE_MISMATCH);
      eq(env.M.validateAuthority(mk({ targetDeviceId: STRANGER }), base).code,
        env.M.ERR.TARGET_UNKNOWN);
      eq(env.M.validateAuthority(mk({ targetDeviceId: "" }), base).code,
        env.M.ERR.TARGET_REQUIRED);
      eq(env.M.validateAuthority(mk({ connected: false }), Object.assign({}, base, { connected: false })).code,
        env.M.ERR.TARGET_DISCONNECTED,
        "un device déconnecté ne peut RIEN confirmer : refuser est fail-closed");
      yes(env.M.validateAuthority(mk({}), base).ok,
        "un Master ordonnant à une Capture du Take est légitime");
    });

    it("M7. caméra indisponible → refus, et un inventaire INCONNU aussi", () => {
      const env = bootModel();
      const ctx = (st) => ({
        session: session(), take: takeOf(), isMaster: true, captureRole: true,
        actorDeviceId: ME, state: st
      });
      const cmd = { sessionId: SID, takeNumber: TAKE, targetDeviceId: CAP, camera: "FRONT", commandId: "c3" };

      const onlyRear = stateWith(["REAR"], "REAR");
      eq(env.M.validate(cmd, ctx(onlyRear)).code, env.M.ERR.CAMERA_NOT_AVAILABLE,
        "on ne segmentation pas un fichier pour une bascule impossible");

      const unknown = env.M.createState(SID);
      no(env.M.validate(cmd, ctx(unknown)).ok,
        "inventaire inconnu → refus, pas d'optimisme");
      eq(env.M.validate(cmd, ctx(unknown)).code, env.M.ERR.CAMERA_NOT_AVAILABLE);

      eq(env.M.validate(
        Object.assign({}, cmd, { camera: "before" }), ctx(onlyRear)).code,
        env.M.ERR.UNKNOWN_CAMERA, "une caméra hors modèle n'atteint même pas la disponibilité");
    });

    it("M8. idempotence : la caméra DÉJÀ active est un SUCCÈS sans action matérielle", () => {
      const env = bootModel();
      const st = stateWith(["REAR", "FRONT"], "FRONT");
      const ctx = (s2) => ({
        session: session(), take: takeOf(), isMaster: true, captureRole: true,
        actorDeviceId: ME, state: s2
      });
      const same = env.M.validate(
        { sessionId: SID, takeNumber: TAKE, targetDeviceId: CAP, camera: "FRONT", commandId: "c4" }, ctx(st));
      yes(same.ok, "l'ordre est satisfait : la demande porte sur l'état courant");
      yes(same.idempotent, "et il est marqué idempotent, pas exécuté");
      eq(same.reason, "already_active");

      /* Une bascule RÉELLEMENT en cours ne doit jamais être déclarée « déjà
       * active » sur la seule foi de l'intention : c'est le cas le plus
       * dangereux, parce qu'un segment venait d'être fermé. */
      const busy = stateWith(["REAR", "FRONT"], "FRONT");
      busy.switchingCamera = "REAR";
      const r = env.M.validate(
        { sessionId: SID, takeNumber: TAKE, targetDeviceId: CAP, camera: "REAR", commandId: "c5" }, ctx(busy));
      eq(r.code, env.M.ERR.SWITCH_IN_PROGRESS, "une seule bascule physique par device");

      const other = env.M.validate(
        { sessionId: SID, takeNumber: TAKE, targetDeviceId: CAP, camera: "REAR", commandId: "c6" }, ctx(st));
      yes(other.ok && !other.idempotent, "basculer vers l'autre caméra reste possible");
    });

    it("M9. une preview fermée rend la bascule impossible", () => {
      const env = bootModel();
      const st = stateWith(["REAR", "FRONT"], "REAR");
      const r = env.M.validate(
        { sessionId: SID, takeNumber: TAKE, targetDeviceId: CAP, camera: "FRONT", commandId: "c7" },
        {
          session: session(), take: takeOf(), isMaster: true, captureRole: true,
          actorDeviceId: ME, state: st, cameraPrepared: false
        });
      eq(r.code, env.M.ERR.CAMERA_OFF, "on RECONFIGURE une preview, on ne l'ouvre pas");
    });

    it("M10. `attachToTake` remet le compteur de segments à zéro pour un NOUVEAU Take", () => {
      const env = bootModel();
      const st = env.M.createState(SID);
      st.segmentIndex = 3;
      st.switchCount = 3;
      st.activeCamera = "FRONT";
      const next = env.M.attachToTake(st, SID, TAKE + 1, 1000);
      eq(next.segmentIndex, 0, "les segments sont comptés par Take, pas par session");
      eq(next.switchCount, 3, "switchCount est un diagnostic CUMULATIF du device, pas un état du Take");
      eq(next.switchingCamera, "", "et aucune bascule ne survit au changement de Take");
      /* La caméra ACTIVE est un fait physique : elle ne s'efface pas parce
       * qu'un nouveau plan commence. */
      eq(next.activeCamera, "FRONT", "la caméra ne se réinitialise pas entre deux Takes");
    });

    /* Regression du terrain : le segment se clot APRES la bascule, donc
     * `activeCamera` vaut deja la CIBLE. Reprendre cette valeur pour
     * `fromCamera` produisait `from === to` et rattachait le fichier a la
     * mauvaise camera. Une depart inconnue reste inconnue. */
    it("M11. un segment NE FABRIQUE PAS sa caméra de départ", () => {
      const env = bootModel();
      let st = stateWith(["REAR", "FRONT"]);
      st = env.M.beginSwitch(st, { commandId: "cs-test-1" }, "FRONT", 1000);
      st = env.M.confirmSwitch(st, "FRONT", "FRONT", 1100);
      eq(st.activeCamera, "FRONT", "la cible est desormais l'actif");
      const closed = env.M.closeSegment(st, {
        segmentIndex: 1, path: "/tmp/seg0.mp4",
        /* `fromFacing` inconnu : le segment precedent filmait bien une
         * camera, mais on ne l'a pas reellement relue. */
        fromCamera: "", toCamera: "FRONT",
        closedAtMs: 1200, durationMs: 90
      });
      eq(closed.lastSegment.fromCamera, "",
        "pas de repli sur la cible : on ne devine pas un fait de depart");
      eq(closed.lastSegment.toCamera, "FRONT");
      eq(closed.lastSegment.path, "/tmp/seg0.mp4");
    });

    it("M11b. une caméra de départ RELUE est conservée telle quelle", () => {
      const env = bootModel();
      let st = stateWith(["REAR", "FRONT"]);
      st = env.M.beginSwitch(st, { commandId: "cs-test-1" }, "FRONT", 1000);
      st = env.M.confirmSwitch(st, "FRONT", 1100);
      const closed = env.M.closeSegment(st, {
        segmentIndex: 1, path: "/tmp/seg0.mp4",
        fromCamera: "REAR", toCamera: "FRONT",
        closedAtMs: 1200, durationMs: 90
      });
      eq(closed.lastSegment.fromCamera, "REAR",
        "le segment porte la camera RELUE, pas la cible");
      eq(closed.lastSegment.toCamera, "FRONT");
    });
  });

  /* ══════════════════ N · frontière native ══════════════════ */

  function bootRecord(opts) {
    opts = opts || {};
    const env = createEnv(Object.assign({ skills: ["capture"], fakeClock: true }, opts));
    loadAll(env, [
      "native/capture-capabilities.js",
      "native/camera-record.js",
      "state/camera-switch-model.js",
      "state/preview-service.js"
    ]);
    env.rec = env.MultiCamCameraRecord;
    return env;
  }

  /* Les accusés natifs passent par les timers de l'env : avec une horloge
   * virtuelle ils ne se déclenchent QUE pendant `advance()`.
   *
   * Le Gestionnaire de rejet est attaché AVANT `advance()`, et non après : une
   * promesse rejetée pendant l'avancée de l'horloge serait alors « non
   * gérée » une milliseconde, ce que Node transforme en exception de processus
   * et qui tuerait la suite entière au lieu d'atteindre le `try/catch` du test.
   * On transporte donc le résultat dans un enveloppe, et on rejoue l'échec
   * après coup : même sémantique, aucune fenêtre de fuite. */
  async function native(env, fn) {
    const guarded = Promise.resolve(fn()).then(
      (v) => ({ value: v }),
      (e) => ({ error: e })
    );
    await env.clock.advance(40);
    const r = await guarded;
    if (r && r.error) throw r.error;
    return r.value;
  }

  async function enterRec(env) {
    await native(env, () => env.MultiCamPreviewService.bind());
    await native(env, () => env.rec.prepare({ startPlanId: "P1" }));
    await native(env, () => env.rec.startRecording({ startPlanId: "P1", takeNumber: TAKE }));
    env.CameraPreview.recording = true;
    env.CameraPreview.ops.length = 0;
    return env;
  }

  function ops(env) { return env.CameraPreview.ops.join(">"); }

  describe("J09-07 · frontière native — ordre et confirmations", () => {
    it("N1. switchSegmented : stop → switch → RELECTURE → restart, dans cet ordre", async () => {
      const env = await enterRec(bootRecord());
      const r = await native(env, () => env.rec.switchSegmented({ camera: "FRONT" }));
      eq(ops(env), ORDER,
        "l'ordre est la SPÉCIFICATION de §35.1, pas un détail d'implémentation");
      yes(r.ok, "la bascule a réussi");
      eq(r.segmented, true, "un segment a été ouvert");
      eq(r.from, "REAR", "la caméra de départ est celle d'AVANT, pas la cible");
      eq(r.to, "FRONT", "la caméra d'arrivée est la cible demandée");
      yes(r.closedPath, "le segment N a bien produit un fichier");
    });

    it("N2. hors REC : aucun fichier produit, et la preview seule est reconfigurée", async () => {
      const env = await enterRec(bootRecord());
      await native(env, () => env.rec.stopRecording());
      env.CameraPreview.ops.length = 0;
      /* Compteurs pris APRÈS la sortie de REC : c'est la bascule qui ne doit
       * rien déclencher, pas la sortie de REC elle-même. */
      const stops = env.CameraPreview.calls.stopRecordVideo;
      const starts = env.CameraPreview.calls.startRecordVideo;
      const r = await native(env, () => env.rec.switchSegmented({ camera: "FRONT" }));
      eq(r.segmented, false, "pas de segmentation hors enregistrement");
      eq(env.CameraPreview.calls.stopRecordVideo, stops,
        "aucun appel stopRecordVideo supplémentaire : on ne fabrique pas de fichier vide");
      eq(env.CameraPreview.calls.startRecordVideo, starts,
        "et on ne redémarre pas un enregistrement qui n'existait pas");
      eq(ops(env), "switchCameraTo>getCameraState", "seule la preview est reconfigurée");
      eq(r.from, "REAR");
      eq(r.to, "FRONT");
    });

    it("N3. activeFacing ne bouge que sur un FAIT natif, jamais sur une promesse", async () => {
      const env = await enterRec(bootRecord({ failSwitch: "CAMERA_DISCONNECTED" }));
      const before = env.rec.view().activeFacing;
      let err = null;
      try { await native(env, () => env.rec.switchSegmented({ camera: "FRONT" })); }
      catch (e) { err = e; }
      yes(err, "un échec natif doit remonter en erreur, pas en succès silencieux");
      eq(env.rec.view().activeFacing, before,
        "la caméra annoncée n'a pas bougé : rien n'a été confirmé");
      eq(env.CameraPreview.activeFacing, "back", "et le natif est bien resté sur la caméra arrière");
      /* Le recorder a été arrêté pour rien : c'est l'état réel, et il doit être
       * dit tel quel plutôt que maquillé en succès. */
      no(env.rec.isRecording(), "le segment a bien été fermé, la bascule non");
    });

    it("N4. getCameraState est une RELECTURE, et son échec est distinct d'un état", async () => {
      const env = await enterRec(bootRecord());
      const st = await native(env, () => env.rec.getCameraState());
      yes(st.available, "l'état natif est disponible");
      eq(st.facing, "REAR", "et il décrit la caméra réellement verrouillée");
      eq(st.cameraId, 0);
      eq(st.defaultCameraId, 0, "defaultCameraId suit la bascule, sinon le profil serait faux");
      eq(st.numberOfCameras, 2);

      env.CameraPreview.failState = "STATE_UNAVAILABLE";
      const bad = await native(env, () => env.rec.getCameraState());
      no(bad.available, "une relecture en échec n'est pas un état");
      eq(bad.reason, "STATE_UNAVAILABLE", "et sa raison est conservée");
    });

    it("N5. sans le patch natif, la bascule échoue au lieu de le prétendre", async () => {
      const env = await enterRec(bootRecord());
      delete env.CameraPreview.switchCameraTo;
      let err = null;
      try { await native(env, () => env.rec.switchSegmented({ camera: "FRONT" })); }
      catch (e) { err = e; }
      yes(err, "sans switchCameraTo, la bascule doit échouer");
      eq(err.code, "plugin_unavailable");
      eq(env.rec.view().activeFacing, "REAR");
    });

    it("N6. les réglages du segment sont conservés, seule la caméra change", async () => {
      const env = await enterRec(bootRecord());
      const before = Object.assign({}, env.CameraPreview.lastRecordOptions);
      await native(env, () => env.rec.switchSegmented({ camera: "FRONT" }));
      const after = env.CameraPreview.lastRecordOptions;
      eq(after.width, before.width, "la définition ne change pas d'un segment à l'autre");
      eq(after.height, before.height);
      eq(after.quality, before.quality);
      eq(after.cameraDirection, "front", "seule la caméra demandée diffère");
      eq(before.cameraDirection, "back");
      yes(after.takeNumber === TAKE || before.takeNumber === undefined,
        "le Take reste celui du plan en cours");
    });

    it("N7. un segment N ne s'ouvre jamais avant la fermeture du segment N-1", async () => {
      const env = await enterRec(bootRecord());
      /* On ne vide PAS le journal entre les deux bascule : c'est justement
       * l'entrelacement qu'on cherche à détecter. */
      await native(env, () => env.rec.switchSegmented({ camera: "FRONT" }));
      await native(env, () => env.rec.switchSegmented({ camera: "REAR" }));
      eq(ops(env), ORDER + ">" + ORDER,
        "deux segments ne peuvent jamais se chevaucher : chaque segment est "
        + "fermé avant que le suivant ne s'ouvre");
      eq(env.CameraPreview.switchTargets.join(","), "front,back",
        "et les deux bascules ont bien eu lieu, dans l'ordre demandé");
    });

    it("N8. un facing hors modèle est refusé AVANT de fermer le segment", async () => {
      const env = await enterRec(bootRecord());
      let err = null;
      try { await native(env, () => env.rec.switchSegmented({ camera: "before" })); }
      catch (e) { err = e; }
      yes(err, "une valeur hors modèle ne doit jamais atteindre le natif");
      eq(err.code, "unknown_camera");
      eq(env.CameraPreview.calls.stopRecordVideo, 0,
        "refuser AVANT stopRecording : sinon le Take perdrait un segment");
      yes(env.rec.isRecording(), "l'enregistrement courant est intact");
    });

    it("N9. le compteur de segments suit les bascules RÉUSSIES", async () => {
      const env = await enterRec(bootRecord());
      eq(env.rec.view().switches, 0);
      await native(env, () => env.rec.switchSegmented({ camera: "FRONT" }));
      eq(env.rec.view().switches, 1);
      eq(env.rec.view().activeFacing, "FRONT");
      env.CameraPreview.failSwitch = "CAMERA_ERROR";
      let err = null;
      try { await native(env, () => env.rec.switchSegmented({ camera: "REAR" })); }
      catch (e) { err = e; }
      yes(err);
      eq(env.rec.view().switches, 1, "une bascule échouée ne s'ajoute pas");
      eq(env.rec.view().activeFacing, "FRONT");
    });
  });

  /* ══════════════════ S · service + transport ══════════════════ */

  /* Un WS simulé : on ne teste pas la socket, on teste le CONTRAT d'envoi
   * (cible unique, kind, ACK) que le service doit respecter. Le routage réel
   * reste couvert par session-ws-multiplex.test.js. */
  function bootService(opts) {
    opts = opts || {};
    const env = createEnv(Object.assign(
      { skills: ["capture", "controller"], fakeClock: true }, opts));
    loadAll(env, [
      "native/capture-capabilities.js",
      "native/camera-record.js",
      "state/camera-switch-model.js",
      "state/camera-state-inbox.js",
      "state/camera-switch-service.js"
    ]);
    env.svc = env.MultiCamCameraSwitchService;

    const sent = [];
    env.ws = {
      sent,
      /* Par défaut la cible EST joignable : `connectedPeers` est la seule
       * source de vérité sur la joignabilité, et un `{}` ferait refuser tous les
       * ordres (fail-closed) — ce qui est testé séparément par S4. */
      connectedPeers() {
        return ("peers" in opts) ? opts.peers : { [CAP]: { connected: true } };
      },
      sendToDevice(deviceId, session, kind, extra) {
        sent.push({ to: deviceId, kind, env: extra });
        return opts.wsSendOk === false ? false : true;
      },
      reply(cmd, extra) {
        sent.push({ reply: true, kind: "camera_switch_result", env: extra });
        return true;
      },
      broadcastCameraState(session, extra) {
        sent.push({ broadcast: true, kind: "camera_state", env: extra });
        return true;
      }
    };
    env.MultiCamSessionWs = env.ws;

    /* Le store et le plan START sont les DEUX sources que le service relit à
     * chaque exécution : on les fournit donc comme sur le terrain, plutôt que
     * d'écrire dans l'état interne du service. */
    const ses = sessionWithTake();
    env.MultiCamSessionStore = {
      get(sid) { return Promise.resolve(sid === SID ? ses : null); }
    };
    env.MultiCamStartService = {
      view() {
        return {
          active: true, phase: "REC", sid: SID, takeNumber: TAKE,
          isMaster: true, isCapture: opts.isCapture === true, rev: 1
        };
      }
    };

    /* `capture-capabilities.js` refuse de sonder si `cordova` est absent : sur
     * le terrain, sa présence prouve que le plugin est bien installé. On fournit
     * donc un stub minimal — la SONDE passe ensuite par le faux plugin, ce qui
     * est justement ce que S6 veut prouver (le chemin natif, pas une fixture). */
    env.cordova = {
      exec(ok, ko, service, action) {
        if (ko) ko("action_non_supportee:" + action);
      }
    };

    env.svc.bind();
    return env;
  }

  function reqs(env, kind) {
    return env.ws.sent.filter((s) => s.kind === kind);
  }

  /* Les sondes natives passent par les timers de l'env, donc par l'horloge
   * VIRTUELLE : sans `advance`, leur Promise ne se résout jamais. On avance
   * puis on rend le résultat, comme pour les accusés d'enregistrement. Le
   * gestionnaire de rejet est attaché avant l'avance, sinon un échec natif
   * deviendrait un rejet non géré et tuerait la suite. */
  async function adv(env, fn, ms) {
    const guarded = Promise.resolve(fn()).then((v) => ({ v: v }), (e) => ({ e: e }));
    await env.clock.advance(ms || 40);
    const r = await guarded;
    if (r && r.e) throw r.e;
    return r.v;
  }

  describe("J09-07 · service — autorité, segmentation, ACK", () => {
    /* `requestSwitchRemote` n'est PAS une promesse de succès : elle attend
     * l'ACK de la cible. On l'appelle donc sans l'attendre, on vérifie ce qui
     * est PARTI, puis on simule l'ACK et on attend le verdict. */
    /* L'envoi passe par `resolveCurrent()`, qui relit le store : il est donc
     * asynchrone. On laisse les promesses se résoudre avant d'inspecter ce qui
     * est parti — sinon on mesurerait le timing du test, pas le code. */
    async function order(env, opts) {
      const p = env.svc.requestSwitchRemote(opts);
      await flush(6);
      return { p: p, sent: reqs(env, "camera_switch_request") };
    }

    function ackOk(env, q, extra) {
      env.svc.onAck(Object.assign({
        sessionId: SID, commandId: q[0].env.commandId, ok: true,
        activeCamera: "FRONT", segmentIndex: 2
      }, extra || {}));
    }

    it("S1. un Master ordonne à une Capture du Take : l'ordre PART, adressé", async () => {
      const env = bootService();
      const { p, sent } = await order(env, { targetDeviceId: CAP, camera: "FRONT" });
      eq(sent.length, 1, "UNE commande, une seule");
      eq(sent[0].to, CAP, "et elle est adressée à la cible, pas diffusée");
      eq(sent[0].env.camera, "FRONT");
      yes(sent[0].env.commandId, "une commande sans commandId n'est pas corrélable");
      eq(sent[0].env.sessionId, SID);
      eq(sent[0].env.takeNumber, TAKE);
      eq(sent[0].env.targetDeviceId, CAP,
        "la cible est dans la commande elle-même, pas seulement dans le canal");
      eq(sent[0].to, CAP, "et le canal est bien celui de la cible");

      ackOk(env, sent);
      const r = await p;
      yes(r.ok, "l'ACK de la Capture conclut l'ordre");
      eq(r.camera, "FRONT", "et il porte la caméra CONFIRMÉE par la cible");
      eq(r.segmentIndex, 2, "ainsi que le nouveau numéro de segment");
    });

    it("S2. une cible qui n'est pas Capture du Take est refusée SANS émission", async () => {
      const env = bootService();
      const r = await env.svc.requestSwitchRemote({ targetDeviceId: OTHER, camera: "FRONT" });
      no(r.ok);
      eq(r.code, env.MultiCamCameraSwitchModel.ERR.TARGET_NOT_CAPTURE);
      eq(env.ws.sent.length, 0, "rien ne part sur le réseau : le refus est local et gratuit");
    });

    it("S3. une cible inconnue de la session est refusée SANS émission", async () => {
      const env = bootService();
      const r = await env.svc.requestSwitchRemote({ targetDeviceId: STRANGER, camera: "FRONT" });
      no(r.ok);
      eq(r.code, env.MultiCamCameraSwitchModel.ERR.TARGET_UNKNOWN);
      eq(env.ws.sent.length, 0);
    });

    it("S4. une cible DÉCONNECTÉE est refusée avant l'envoi", async () => {
      const env = bootService({ peers: {} });   /* personne n'est joignable */
      const r = await env.svc.requestSwitchRemote({ targetDeviceId: CAP, camera: "FRONT" });
      no(r.ok, "un device joignable par personne ne peut rien confirmer");
      eq(r.code, env.MultiCamCameraSwitchModel.ERR.TARGET_DISCONNECTED);
      eq(env.ws.sent.length, 0);
    });

    it("S5. un WS qui n'aboutit pas est signalé, pas avalé", async () => {
      const env = bootService({ wsSendOk: false });
      const r = await env.svc.requestSwitchRemote({ targetDeviceId: CAP, camera: "FRONT" });
      no(r.ok, "un envoi non abouti ne doit jamais être un succès");
      yes(r.code, "et toujours avec un code");
    });

    it("S5b. sans ACK, le Master NE RÉPOND PAS « fait » : il expire en « indécidable »", async () => {
      const env = bootService();
      const { p, sent } = await order(env, { targetDeviceId: CAP, camera: "FRONT" });
      eq(sent.length, 1, "la commande est bien partie");
      /* On avance l'horloge de plus que le délai d'ACK SANS produire de réponse :
       * c'est le cas le plus dangereux en production (cible disparue entre
       * l'envoi et l'exécution). */
      await env.clock.advance(env.svc.ACK_TIMEOUT_MS + 100);
      const r = await p;
      no(r.ok, "aucun ACK ne signifie aucun fait");
      eq(r.code, "ack_timeout");
      yes(r.inconclusive, "et le verdict est INCONCLUANT : ni succès, ni échecAvéré");
      yes(r.sent, "l'envoi a bien eu lieu : le Master ne doit pas prétendre le contraire");
    });

    it("S5c. un ACK en ÉCHEC est transmis tel quel, code compris", async () => {
      const env = bootService();
      const { p, sent } = await order(env, { targetDeviceId: CAP, camera: "FRONT" });
      env.svc.onAck({
        sessionId: SID, commandId: sent[0].env.commandId, ok: false,
        code: "camera_not_available", message: "FRONT absent"
      });
      const r = await p;
      no(r.ok);
      eq(r.code, "camera_not_available", "le code de la Capture doit remonter INTACT");
      yes(r.message, "et son message, pour que l'écran puisse l'afficher");
    });

    it("S6. l'inventaire vient de la SONDE BRUTE, jamais de la forme J06", async () => {
      const env = bootService({ physicalCameras: ["back", "front"] });
      await adv(env, () => env.svc.refreshAvailability());
      yes(env.CameraPreview.calls.getCaptureCapabilities >= 1,
        "la disponibilité doit être lue dans la réponse native brute");
      eq(env.svc.view().availableCameras.join(","), "REAR,FRONT");
    });

    it("S7. un device SANS caméra front n'annonce que ce qu'il a", async () => {
      const env = bootService({ physicalCameras: ["back"] });
      await adv(env, () => env.svc.refreshAvailability());
      const v = env.svc.view();
      eq(v.availableCameras.join(","), "REAR");
      no(v.availableCameras.indexOf("FRONT") >= 0, "une caméra absente ne doit jamais être proposée");
    });

    it("S8. l'inventaire relu au bridge est celui de l'état NATIF", async () => {
      const env = bootService({ physicalCameras: ["back", "front"], activeFacing: "front" });
      await adv(env, () => env.svc.refreshAvailability());
      await adv(env, () => env.svc.syncActiveCamera());
      eq(env.svc.view().activeCamera, "FRONT",
        "la caméra annoncée doit venir de getCameraState, pas de la direction nominally demandée");
    });

    /* Regression du terrain : au boot la camera n'est pas encore preparee, donc
     * `activeCamera` reste vide jusqu'a la premiere bascule. Le segment clos
     * porte alors `fromCamera:""` alors que le natif, lui, sait qu'on filme en
     * REAR. Une information reelle perdue, sans qu'aucune erreur ne remonte. */
    it("S8b. une bascule ADOPTE le facing natif avant de partir", async () => {
      const env = bootService({ physicalCameras: ["back", "front"], activeFacing: "back" });
      eq(env.svc.view().activeCamera, "",
        "au boot, rien n'est encore relu : on ne devine pas");
      await adv(env, () => env.svc.refreshAvailability());
      await adv(env, () => env.svc.syncActiveCamera("before_switch"));
      eq(env.svc.view().activeCamera, "REAR",
        "la bascule relit l'etat NATIF et non la cible demandee");
    });

    it("S9. la vue du service expose exactement ce dont l'écran a besoin", () => {
      const env = bootService();
      const v = env.svc.view();
      ["activeCamera", "switchingCamera", "requestedCamera", "availableCameras",
        "busy", "segmentIndex", "lastError", "lastErrorCode", "lastSwitchDurationMs"]
        .forEach((k) => yes(k in v, "champ manquant pour l'écran REC : " + k));
      eq(typeof v.busy, "boolean", "busy est dérivé, donc jamais contradictoire");
      eq(v.busy, false, "aucune bascule en vol au repos");
    });

    it("S10. `onStartView` attache le service au Take, sans le deviner", () => {
      const env = bootService();
      env.svc.onStartView({ active: true, sid: SID, takeNumber: TAKE });
      eq(env.svc.view().sessionId, SID);
      eq(env.svc.view().takeNumber, TAKE);
      /* Un plan INACTIF ne doit jamais réattacher : sinon une vue résiduelle
       * ferait croire qu'un plan est en cours. */
      env.svc.reset();
      env.svc.onStartView({ active: false, sid: SID, takeNumber: TAKE });
      eq(env.svc.view().takeNumber, null, "aucun Take courant après un plan inactif");
    });

    it("S11. reset() efface l'état et ne laisse aucune bascule en vol", async () => {
      const env = bootService();
      const { p, sent } = await order(env, { targetDeviceId: CAP, camera: "FRONT" });
      ackOk(env, sent);
      await p;
      env.svc.reset();
      const v = env.svc.view();
      eq(v.busy, false, "aucune bascule ne survit à un reset");
      eq(v.segmentIndex, 0);
      eq(v.switchingCamera, "", "pas de bascule fantôme affichée après un reset");
    });
  });

  /* ══════════════════ B · mémoire de supervision ══════════════════ */

  describe("J09-07 · mémoire de supervision — convergence des Masters", () => {
    function bootInbox() {
      const env = createEnv({ skills: ["capture", "controller"] });
      loadAll(env, ["state/camera-switch-model.js", "state/camera-state-inbox.js"]);
      return env;
    }

    it("B1. l'état reçu est celui du device, la phase REC RELAYÉE", () => {
      const env = bootInbox();
      const inbox = env.MultiCamCameraStateInbox;
      inbox.record({
        sessionId: SID, deviceId: CAP, from: CAP, availableCameras: ["REAR", "FRONT"],
        activeCamera: "REAR", segmentIndex: 1, phase: "REC", atMs: 1000, updatedAtMs: 1000
      });
      const s = inbox.forDevice(CAP, SID);
      eq(s.activeCamera, "REAR");
      eq(s.phase, "REC",
        "la phase du START est RELAYEE : le Master n'a pas le plan de la Capture");
      eq(s.cameraPhase, "active:REAR",
        "l'etat de la CAMERA est derive, et vit sous un nom qui ne peut pas "
        + "confondre phase de START et facing");
      eq(s.atMs, 1000, "l'instant de MESURE est conserve, distinct de la reception");
      eq(s.busy, false);
      eq(s.segmentIndex, 1);
    });

    /* Regression du terrain : avant, `phase` derivait de `activeCamera`, et la
     * supervision Master's affichait « phase : FRONT ». Deux notions sous un
     * meme nom — le nommer `cameraPhase` rend la confusion impossible. */
    it("B1b. `phase` ne peut plus valoir un facing", () => {
      const env = bootInbox();
      const inbox = env.MultiCamCameraStateInbox;
      inbox.record({
        sessionId: SID, deviceId: CAP, from: CAP, availableCameras: ["REAR", "FRONT"],
        activeCamera: "FRONT", phase: "REC", atMs: 1000, updatedAtMs: 1000
      });
      const s = inbox.forDevice(CAP, SID);
      eq(s.phase === "REAR" || s.phase === "FRONT", false,
        "un facing ne peut pas se lire comme une phase de START");
      eq(s.phase, "REC");
      eq(s.cameraPhase, "active:FRONT");
    });

    it("B1c. sans phase relayee, la phase reste INCONNUE (jamais devinee)", () => {
      const env = bootInbox();
      const inbox = env.MultiCamCameraStateInbox;
      inbox.record({
        sessionId: SID, deviceId: CAP, from: CAP,
        availableCameras: ["REAR"], activeCamera: "REAR", atMs: 1000, updatedAtMs: 1000
      });
      const s = inbox.forDevice(CAP, SID);
      eq(s.phase, "", "le Master ne deduit pas la phase du START : il ne l'a pas");
    });

    it("B2. pendant une bascule, la phase l'annonce sans fixer l'actif", () => {
      const env = bootInbox();
      const inbox = env.MultiCamCameraStateInbox;
      inbox.record({
        sessionId: SID, deviceId: CAP, from: CAP,
        availableCameras: ["REAR", "FRONT"], activeCamera: "REAR", updatedAtMs: 1000
      });
      inbox.record({
        sessionId: SID, deviceId: CAP, from: CAP,
        switchingCamera: "FRONT", requestedCamera: "FRONT", updatedAtMs: 1100
      });
      const s = inbox.forDevice(CAP, SID);
      eq(s.busy, true, "« occupée » est DÉRIVÉ de switchingCamera, donc jamais périmé");
      eq(s.cameraPhase, "switching:FRONT");
      eq(s.phase, "", "et la phase de START n'est pas devinee pour autant");
      eq(s.activeCamera, "REAR",
        "la cible n'est PAS devenue l'active : le fait n'est pas encore établi");
    });

    it("B3. un paquet qui encode l'état d'un AUTRE device est refusé", () => {
      const env = bootInbox();
      const inbox = env.MultiCamCameraStateInbox;
      inbox.record({ sessionId: SID, deviceId: CAP, from: CAP, activeCamera: "REAR", updatedAtMs: 1000 });
      no(inbox.record({ sessionId: SID, deviceId: CAP, from: ME, activeCamera: "FRONT", updatedAtMs: 2000 }),
        "même invariant que pour la télémétrie : on n'encode que son propre état");
      eq(inbox.forDevice(CAP, SID).activeCamera, "REAR", "et l'état précédent survit");
    });

    it("B4. un état d'une AUTRE session n'est jamais présenté comme le courant", () => {
      const env = bootInbox();
      const inbox = env.MultiCamCameraStateInbox;
      inbox.record({ sessionId: SID, deviceId: CAP, from: CAP, activeCamera: "FRONT", updatedAtMs: 1000 });
      yes(inbox.forDevice(CAP, SID), "l'état de la session courante est visible");
      eq(inbox.forDevice(CAP, "SESS02"), null, "celui d'une autre session est invisible");
      eq(inbox.list("SESS02").length, 0, "et il ne pollue pas une autre vue");
    });

    it("B5. un paquet RETARDÉ n'écrase pas un fait plus frais", () => {
      const env = bootInbox();
      const inbox = env.MultiCamCameraStateInbox;
      /* La confirmation (1100) arrive avant l'intention (1000) : ordre réseau
       * possible sur deux sockets. Le fait confirmé doit gagner. */
      inbox.record({ sessionId: SID, deviceId: CAP, from: CAP, activeCamera: "FRONT", updatedAtMs: 1100 });
      inbox.record({ sessionId: SID, deviceId: CAP, from: CAP, switchingCamera: "FRONT", updatedAtMs: 1000 });
      const s = inbox.forDevice(CAP, SID);
      eq(s.activeCamera, "FRONT");
      eq(s.switchingCamera, "", "une intention périmée ne doit pas rouvrir une bascule fantôme");
      eq(s.busy, false);
    });

    /* ------------------------------------------------------------------
     * Non-régression : les deux vues RÉCIPROQUES.
     *
     * `start-service.view()` publie `cameraSwitch`, donc il appelle
     * `camera-switch-service.view()`. Si ce dernier lit sa phase via
     * `start-service.view()`, on obtient une récursion infinie — invisible
     * depuis les tests unitaires, parce qu'ils stubent la vue du start-service
     * au lieu de charger le vrai module. Constaté sur le terrain, sur les deux
     * devices, avec « RangeError: Maximum call stack size exceeded ».
     *
     * Ce test charge donc les DEUX modules réels : c'est la seule façon
     * d'attraper un cycle qui ne traverse pas les stubs.
     * ------------------------------------------------------------------ */
    it("B7. les deux vues se répondent SANS se rappeler elles-mêmes", () => {
      const env = createEnv({ skills: ["capture", "controller"] });
      loadAll(env, [
        "native/camera-record.js",
        "state/preview-service.js",
        "state/start-service.js",
        "state/camera-switch-model.js",
        "state/camera-switch-service.js"
      ]);
      env._mcStartMachine = {
        view() { return { active: false, phase: "IDLE", rev: 0 }; },
        isActive() { return false; }
      };

      /* Sans état, `view()` prend le chemin court : c'est déjà un test, mais il
       * ne prouve rien sur la phase. On installe donc une session + un Take
       * réels pour emprunter le chemin complet, celui qui appelle le start-service. */
      env.MultiCamSessionStore = {
        current() { return sessionWithTake(); }
      };
      env.MultiCamCameraSwitchService.bind();
      env.MultiCamCameraSwitchService.onStartView({ active: true, sid: SID, takeNumber: TAKE });

      /* Les deux sens, dans les deux ordres : un cycle ne dépend pas de l'ordre
       * d'appel, et l'UI appelle la vue caméra en premier sur la Capture. */
      const b = env.MultiCamCameraSwitchService.view();
      eq(b.phase, "IDLE",
        "la vue caméra relit la phase par l'accésseur étroit, sans ré-entrer dans view()");
      eq(b.unknown, false, "et on est bien sur le chemin complet, pas le chemin court");

      const a = env.MultiCamStartService.view();
      eq(a.cameraSwitch !== null, true,
        "la vue du start-service publie bien l'état caméra");
      eq(a.cameraSwitch.phase, "IDLE", "et la même phase y est cohérente");
    });

    it("B6. un device sans état reste INCONNU, pas « REAR »", () => {
      const env = bootInbox();
      eq(env.MultiCamCameraStateInbox.forDevice(CAP, SID), null);
      eq(env.MultiCamCameraStateInbox.list(SID).length, 0,
        "aucune entrée sans fait : l'UI écrit « inconnu », elle n'invente pas");
    });
  });
}

module.exports = { register };