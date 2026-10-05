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
  const { describe, it, createEnv, loadAll, flush, fakeDom } = h;

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

it("M10. `attachToTake` repart de zéro pour un NOUVEAU Take", () => {
      const env = bootModel();
      let st = env.M.createState(SID);
      st = env.M.openSegment(st, { camera: "REAR", startedAtMs: 900 });
      st = env.M.closeCurrentSegment(st, { path: "/tmp/a.mp4", stoppedAtMs: 1000 });
      st.switchCount = 3;
      st.activeCamera = "FRONT";
      const next = env.M.attachToTake(st, SID, TAKE + 1, 2000);
      eq(next.currentSegment, null, "aucun segment en cours n'est celui du Take précédent");
      eq(next.segments.length, 0, "l'historique ne mélange pas deux plans");
      eq(env.M.currentIndex(next), 0, "et le compteur repart de zéro");
      eq(env.M.nextSegmentIndex(next), 1, "le prochain segment du nouveau Take est le 1");
      eq(next.switchCount, 3, "switchCount est un diagnostic CUMULATIF du device, pas un état du Take");
      eq(next.switchingCamera, "", "et aucune bascule ne survit au changement de Take");
      /* La caméra ACTIVE est un fait physique : elle ne s'efface pas parce
       * qu'un nouveau plan commence. */
      eq(next.activeCamera, "FRONT", "la caméra ne se réinitialise pas entre deux Takes");
    });

    /* Regression du terrain : le segment se clot APRES la bascule, donc
     * `activeCamera` vaut deja la CIBLE. Le segment porte donc SA caméra de
     * depart — celle releue AVANT la bascule — et jamais la cible. */
    it("M11. un segment NE FABRIQUE PAS sa caméra de départ", () => {
      const env = bootModel();
      let st = stateWith(["REAR", "FRONT"]);
      st = env.M.openSegment(st, { camera: "REAR", startedAtMs: 900 });
      st = env.M.beginSwitch(st, { commandId: "cs-test-1" }, "FRONT", 1000);
      st = env.M.confirmSwitch(st, "FRONT", "FRONT", 1100);
      eq(st.activeCamera, "FRONT", "la cible est desormais l'actif");
      /* Aucune caméra de depart n'est fournie à la clôture : on ne l'invente pas. */
      const closed = env.M.closeCurrentSegment(st, { path: "/tmp/seg1.mp4", stoppedAtMs: 1200 });
      eq(closed.segments[0].camera, "REAR",
        "pas de repli sur la cible : le segment garde la caméra relue à son ouverture");
      eq(closed.segments[0].path, "/tmp/seg1.mp4");
      eq(closed.segments[0].segmentIndex, 1, "et il porte l'index qu'il avait à l'ouverture");
    });

    it("M11b. une caméra de départ RELUE est conservée telle quelle", () => {
      const env = bootModel();
      let st = stateWith(["REAR", "FRONT"]);
      st = env.M.openSegment(st, { camera: "REAR", startedAtMs: 900 });
      st = env.M.beginSwitch(st, { commandId: "cs-test-1" }, "FRONT", 1000);
      st = env.M.confirmSwitch(st, "FRONT", 1100);
      const closed = env.M.closeCurrentSegment(st, {
        path: "/tmp/seg1.mp4", camera: "REAR", stoppedAtMs: 1200
      });
      eq(closed.segments[0].camera, "REAR",
        "le segment porte la camera RELUE, pas la cible");
      eq(closed.segments[0].startedAtMs, 900, "et son instant d'ouverture, pas celui de la bascule");
    });
  });

  /* ══════════════════ P · identité des segments (J09-08b1) ══════════════════ */

  /* Ces tests verrouillent la SÉQUENCE, pas seulement chaque étape : c'est
   * l'enchaînement 1 → 2 → 3 qui satisfait la décision produit, et une
   * transition correcte prise isolément peut composer une suite fausse. */

  function idxs(st) { return st.segments.map((s) => s.segmentIndex); }

  /* Un Take filmé en trois segments, deux bascules, un STOP. */
  function takeInThreeSegments(env) {
    const M = env.M;
    let st = M.attachToTake(M.createState(SID), SID, TAKE, 0);
    st = M.openSegment(st, { camera: "REAR", startedAtMs: 1000 });
    const first = st.currentSegment.segmentIndex;
    st = M.closeCurrentSegment(st, { path: "/tmp/seg1.mp4", stoppedAtMs: 2000 });
    st = M.openSegment(st, { camera: "FRONT", startedAtMs: 3000 });
    const second = st.currentSegment.segmentIndex;
    st = M.closeCurrentSegment(st, { path: "/tmp/seg2.mp4", stoppedAtMs: 4000 });
    st = M.openSegment(st, { camera: "REAR", startedAtMs: 5000 });
    const third = st.currentSegment.segmentIndex;
    st = M.closeCurrentSegment(st, { path: "/tmp/seg3.mp4", stoppedAtMs: 6000 });
    return { state: st, opened: [first, second, third] };
  }

  describe("J09-08b1 · identité des segments — index attribué à l'ouverture", () => {
    it("P1. le premier segment d'un Take est le segment 1", () => {
      const env = bootModel();
      const st0 = env.M.attachToTake(env.M.createState(SID), SID, TAKE, 0);
      eq(st0.currentSegment, null, "rien n'est ouvert avant le top");
      eq(env.M.currentIndex(st0), 0, "0 n'est pas un index : c'est l'absence de segment");
      const st = env.M.openSegment(st0, { camera: "REAR", startedAtMs: 1000 });
      eq(st.currentSegment.segmentIndex, 1, "le premier segment d'un Take vaut 1");
      eq(st.currentSegment.camera, "REAR", "il porte la caméra RÉELLEMENT ouverte");
      eq(st.currentSegment.path, "", "son fichier n'existe pas encore : aucun chemin n'est deviné");
      eq(st.currentSegment.startedAtMs, 1000);
      eq(st.currentSegment.stoppedAtMs, 0);
      eq(st.segments.length, 0, "l'historique ne contient pas le segment en cours");
    });

    it("P2. une bascule clôture le 1 et ouvre le 2", () => {
      const env = bootModel();
      let st = env.M.attachToTake(env.M.createState(SID), SID, TAKE, 0);
      st = env.M.openSegment(st, { camera: "REAR", startedAtMs: 1000 });
      st = env.M.closeCurrentSegment(st, { path: "/tmp/seg1.mp4", stoppedAtMs: 2000 });
      st = env.M.openSegment(st, { camera: "FRONT", startedAtMs: 3000 });
      eq(idxs(st).join(","), "1", "l'historique contient le segment fermé");
      eq(env.M.currentIndex(st), 2, "et le segment en cours est le 2");
      eq(st.segments[0].path, "/tmp/seg1.mp4", "le chemin reste attaché au fichier qui l'a produit");
      eq(st.segments[0].camera, "REAR", "et au segment 1, pas au segment 2");
    });

    it("P3. une seconde bascule clôture le 2 et ouvre le 3", () => {
      const env = bootModel();
      let st = env.M.attachToTake(env.M.createState(SID), SID, TAKE, 0);
      st = env.M.openSegment(st, { camera: "REAR", startedAtMs: 1000 });
      st = env.M.closeCurrentSegment(st, { path: "/tmp/seg1.mp4", stoppedAtMs: 2000 });
      st = env.M.openSegment(st, { camera: "FRONT", startedAtMs: 3000 });
      st = env.M.closeCurrentSegment(st, { path: "/tmp/seg2.mp4", stoppedAtMs: 4000 });
      st = env.M.openSegment(st, { camera: "REAR", startedAtMs: 5000 });
      eq(idxs(st).join(","), "1,2", "l'historique est ORDONNÉ et sans trou");
      eq(env.M.currentIndex(st), 3, "le segment en cours est le 3");
    });

    it("P4. le STOP clôture le dernier : historique [1,2,3], plus rien en cours", () => {
      const env = bootModel();
      const r = takeInThreeSegments(env);
      eq(r.opened.join(","), "1,2,3", "les trois segments se sont ouverts dans l'ordre");
      eq(idxs(r.state).join(","), "1,2,3", "le STOP clôt le dernier : aucun fichier sans index");
      eq(env.M.currentIndex(r.state), 0, "plus aucun segment en cours");
      eq(r.state.currentSegment, null);
      eq(r.state.segments[2].path, "/tmp/seg3.mp4",
        "le fichier du segment 3 est rattaché au segment 3, pas à l'index du suivant");
    });

    it("P5. chaque segment porte la caméra qui a réellement enregistré", () => {
      const env = bootModel();
      const r = takeInThreeSegments(env);
      eq(r.state.segments.map((s) => s.camera).join(","), "REAR,FRONT,REAR",
        "REAR → FRONT → REAR, dans l'ordre des segments");
      eq(r.state.segments.map((s) => s.path).join(","),
        "/tmp/seg1.mp4,/tmp/seg2.mp4,/tmp/seg3.mp4",
        "et chaque chemin va avec SON segment");
    });

    it("P6. aucun index n'est réutilisé dans un même Take", () => {
      const env = bootModel();
      let st = env.M.attachToTake(env.M.createState(SID), SID, TAKE, 0);
      st = env.M.openSegment(st, { camera: "REAR", startedAtMs: 1000 });
      st = env.M.closeCurrentSegment(st, { path: "/tmp/seg1.mp4", stoppedAtMs: 2000 });
      /* Une clôture SANS segment ouvert ne doit consommer aucun numéro. */
      st = env.M.closeCurrentSegment(st, { stoppedAtMs: 2500 });
      eq(idxs(st).join(","), "1", "une clôture sans segment n'invente pas d'entrée");
      /* Le segment suivant ne peut pas reprendre un numéro déjà porté. */
      const reopened = env.M.openSegment(st, { camera: "FRONT", startedAtMs: 3000 });
      eq(env.M.currentIndex(reopened), 2, "l'historique n'a pas bougé : il reste un seul segment");
      eq(idxs(reopened).join(","), "1");
      const all = idxs(reopened).concat([env.M.currentIndex(reopened)]);
      eq(new Set(all).size, all.length, "deux segments d'un même Take ne partagent jamais un index");
    });

    it("P7. un nouveau Take recommence à 1", () => {
      const env = bootModel();
      const r = takeInThreeSegments(env);
      const next = env.M.attachToTake(r.state, SID, TAKE + 1, 7000);
      eq(env.M.nextSegmentIndex(next), 1, "le compteur de segments est propre à un Take");
      eq(next.segments.length, 0);
      eq(env.M.currentIndex(env.M.openSegment(next, { camera: "REAR", startedAtMs: 8000 })), 1);
    });

    it("P8. un STOP sans switch donne un historique [1]", () => {
      const env = bootModel();
      let st = env.M.attachToTake(env.M.createState(SID), SID, TAKE, 0);
      st = env.M.openSegment(st, { camera: "REAR", startedAtMs: 1000 });
      st = env.M.closeCurrentSegment(st, { path: "/tmp/only.mp4", stoppedAtMs: 9000 });
      eq(idxs(st).join(","), "1", "un Take sans bascule produit UN segment, indexé 1");
      eq(env.M.currentIndex(st), 0);
      eq(st.segments[0].stoppedAtMs, 9000, "clos par le STOP : il porte son instant de fin");
    });

    it("P9. un segment déjà ouvert n'en ouvre pas un second", () => {
      const env = bootModel();
      let st = env.M.attachToTake(env.M.createState(SID), SID, TAKE, 0);
      st = env.M.openSegment(st, { camera: "REAR", startedAtMs: 1000 });
      const again = env.M.openSegment(st, { camera: "FRONT", startedAtMs: 1100 });
      eq(env.M.currentIndex(again), 1, "un Take ne filme qu'avec un recorder : un seul segment ouvert");
      eq(again.currentSegment.camera, "REAR", "et le segment ouvert n'a pas changé de caméra");
    });

    it("P10. un segment porte tous les champs exigés, même inconnus", () => {
      const env = bootModel();
      let st = env.M.attachToTake(env.M.createState(SID), SID, TAKE, 0);
      st = env.M.openSegment(st, { startedAtMs: 1000 });
      st = env.M.closeCurrentSegment(st, { stoppedAtMs: 2000 });
      const seg = st.segments[0];
      ["segmentIndex", "camera", "path", "startedAtMs", "stoppedAtMs"]
        .forEach((k) => yes(k in seg, "champ manquant sur un segment : " + k));
      eq(seg.camera, "", "une caméra non relue reste inconnue");
      eq(seg.path, "", "un fichier non confirmé reste sans chemin");
      eq(seg.startedAtMs, 1000);
      eq(seg.stoppedAtMs, 2000);
    });

    it("P11. la vue publie l'index du segment EN COURS, pas un compteur de fermés", () => {
      const env = bootModel();
      let st = env.M.attachToTake(env.M.createState(SID), SID, TAKE, 0);
      st = env.M.openSegment(st, { camera: "REAR", startedAtMs: 1000 });
      st = env.M.closeCurrentSegment(st, { path: "/tmp/seg1.mp4", stoppedAtMs: 2000 });
      st = env.M.openSegment(st, { camera: "FRONT", startedAtMs: 3000 });
      const v = env.M.view(st, { recording: true });
      eq(v.segmentIndex, 2, "le 2 est en cours : c'est lui que l'écran doit afficher");
      eq(v.segmentCount, 2, "l'historique et le segment courant ensemble");
      eq(v.currentSegment.camera, "FRONT");
      eq(v.segments.map((s) => s.segmentIndex).join(","), "1");
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
   * reste couvert par session-ws-multiplex.test.js — SAUF l'identité de session
   * elle-même (J09-08f), que ce stub rejoue fidèlement sur demande. */

  /* ---------- J09-08f : routage fidèle à `session-ws.js` ----------
   *
   * `broadcastCameraState(session, extra)` ne transporte pas la session : il s'en
   * sert pour ROUTER. Un Master n'est atteint que s'il est dans `session.masters`
   * ET marqué dans la session (`inSession`). On rejoue ces deux filtres, la
   * dé-duplication et l'exclusion de soi, dans l'ordre du code réel : c'est le
   * seul moyen de voir passer de `masters=0` à `masters=1`. */
  function routeMasters(session, routePeers, selfDid) {
    const peers = (routePeers && typeof routePeers === "object") ? routePeers : {};
    const sid = (session && session.sessionId) || "";
    const masters = (session && session.masters) || [];
    const seen = {};
    let sent = 0;
    Object.keys(peers).forEach((did) => {
      const entry = peers[did];
      if (!entry || entry.connected === false) return;
      if (!did || did === selfDid || seen[did]) return;
      if (entry.sessions && !entry.sessions[sid]) return;          /* inSession */
      if (!masters.some((m) => m && m.deviceId === did)) return;    /* isMasterDevice */
      sent += 1;
      seen[did] = true;
    });
    return sent;
  }

  /* Le journal EXACT de `CAMERA_STATE_TX` : c'est cette ligne qui a gelé le
   * défaut (`masters=0`), donc c'est elle qu'on doit retrouver. */
  function routedLog(rec) {
    const extra = rec.env || {};
    return "CAMERA_STATE_TX sessionId=" + ((rec.session && rec.session.sessionId) || "")
      + " deviceId=" + (extra.deviceId || "—")
      + " activeCamera=" + (extra.activeCamera || "—")
      + " switchingCamera=" + (extra.switchingCamera || "—")
      + " masters=" + rec.masters;
  }

  /* La session S2 existe pour l'ISOLATION : DEV-5 y est Master, et DEV-5 n'a
   * rien à faire dans le trafic d'une Capture de S1. */
  const SID2 = "SESS02";
  const FOREIGN_MASTER = "DEV-5";

  function session2() {
    return {
      sessionId: SID2,
      name: "Autre tournage",
      state: "open",
      members: [{ deviceId: FOREIGN_MASTER }],
      masters: [{ deviceId: FOREIGN_MASTER }],
      takes: [{ takeNumber: 1, captures: [FOREIGN_MASTER] }]
    };
  }

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
        const rec = {
          broadcast: true, kind: "camera_state", env: extra, session: session || null
        };
        if (!opts.routing) { sent.push(rec); return true; }
        /* J09-08f : `opts.routing` rejoue le routage et le journal réels —
         * un stub qui accepte N'IMPORTE QUELLE session ne peut pas compter de
         * Master, donc ne peut pas voir le défaut. */
        rec.masters = routeMasters(session, opts.routePeers, extra.deviceId);
        env.logs.push(routedLog(rec));
        sent.push(rec);
        return rec.masters > 0;   /* session-ws : `return sent > 0` */
      }
    };
    env.MultiCamSessionWs = env.ws;

    /* Le store et le plan START sont les DEUX sources que le service relit à
     * chaque exécution : on les fournit donc comme sur le terrain, plutôt que
     * d'écrire dans l'état interne du service. J09-08f : le store peut contenir
     * PLUSIEURS sessions (c'est le cas réel — S1 et S2 se suivent), et le plan
     * START est l'autorité du `sessionId` local. */
    const sessions = opts.sessions || { [SID]: sessionWithTake() };
    env.MultiCamSessionStore = {
      get(sid) { return Promise.resolve(sessions[sid] || null); }
    };
    env.MultiCamStartService = {
      view() {
        return {
          active: true, phase: "REC", sid: opts.planSid || SID, takeNumber: TAKE,
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

  /* J09-08f : l'ATTACHEMENT au plan START — le seul moment où la Capture
   * possède la session complète du Take AVANT d'enregistrer. Sur le terrain il
   * se produit pendant le countdown, à des centaines de reprises ; ici on le
   * joue une fois, puis on laisse l'amorçage de session se résoudre. */
  async function attachTake(env) {
    env.svc.onStartView(env.MultiCamStartService.view());
    await flush();
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
      eq(r.segmentIndex, 2, "ainsi que l'index du segment désormais EN COURS");
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
      eq(v.segmentIndex, 0, "aucun segment en cours après un reset");
      eq(v.switchingCamera, "", "pas de bascule fantôme affichée après un reset");
    });
  });

  /* ══════════════════ S12 · identité des segments, en service (J09-08b1) ══════════════════ */

  /* Ces tests traversent le VRAI chemin natif : `camera-record` pilote le faux
   * plugin (stop → switch → relecture → restart) et le service indexe. Un
   * modèle correct mais jamais appelé par le service ne prouverait rien — c'est
   * l'enchaînement qui est la décision produit.
   *
   * L'ouverture et la clôture du segment 1 sont déclenchées par les MÊMES hooks
   * que le start-service appelle (`onRecordingStarted` / `onRecordingStopped`) :
   * on reproduit ici le contrat, pas la machine de START. */
  describe("J09-08b1 · service — indexation d'un Take complet", () => {
    async function top(env) {
      await adv(env, () => env.MultiCamCameraRecord.prepare({ startPlanId: "P1" }));
      await adv(env, () => env.MultiCamCameraRecord.startRecording({
        startPlanId: "P1", takeNumber: TAKE
      }));
      /* Comme le start-service, sur l'accusé natif du top. */
      env.svc.onRecordingStarted();
      return env;
    }

    /* Un chemin différent par fichier : c'est ce qui prouve qu'un index suit
     * SON fichier et pas seulement sa position. */
    function nameFile(env, n) { env.CameraPreview.videoPath = "file:///cache/videoTmp_" + n + ".mp4"; }

    function hist(v) { return v.segments.map((s) => s.segmentIndex).join(","); }

    it("S12. START → switch → switch → STOP : segments 1, 2, 3, tous clôturés", async () => {
      const env = await top(bootService());

      let v = env.svc.view();
      eq(v.segmentIndex, 1, "au top, le fichier en cours EST le segment 1");
      eq(v.currentSegment.camera, "REAR", "il filme avec la caméra réellement ouverte");
      eq(v.currentSegment.path, "", "et son fichier n'existe pas encore");
      eq(hist(v), "", "rien n'est clôturé : l'historique est vide");

      nameFile(env, 10);
      const r1 = await adv(env, () => env.svc.requestSwitch("FRONT"));
      yes(r1.ok, "le premier switch aboutit");
      eq(r1.segmentIndex, 2, "après le 1er switch, le NOUVEAU fichier est le segment 2");
      eq(r1.closedSegmentIndex, 1, "et le fichier clos était le segment 1");
      eq(r1.closedPath, "file:///cache/videoTmp_10.mp4");

      v = env.svc.view();
      eq(hist(v), "1", "un seul segment clôturé");
      eq(v.segmentIndex, 2, "le segment 2 est en cours");
      eq(v.currentSegment.camera, "FRONT");
      eq(v.segments[0].camera, "REAR", "le segment 1 porte la caméra qui a filmé");
      eq(v.segments[0].path, "file:///cache/videoTmp_10.mp4",
        "et le chemin du fichier réellement produit");
      yes(v.segments[0].stoppedAtMs > 0, "le segment clos par la bascule porte son instant de fin");
      yes(v.segments[0].startedAtMs > 0, "et son instant d'ouverture");
      yes(v.segments[0].startedAtMs <= v.segments[0].stoppedAtMs,
        "un segment ne peut pas s'être arrêté avant d'avoir démarré");

      nameFile(env, 11);
      const r2 = await adv(env, () => env.svc.requestSwitch("REAR"));
      yes(r2.ok, "le second switch aboutit");
      eq(r2.segmentIndex, 3, "après le 2e switch, le nouveau fichier est le segment 3");
      eq(r2.closedSegmentIndex, 2);

      v = env.svc.view();
      eq(hist(v), "1,2", "deux segments clôturés, dans l'ordre");
      eq(v.segmentIndex, 3);

      /* STOP : le segment 3 est clôturé comme les deux autres. */
      nameFile(env, 12);
      await adv(env, () => env.MultiCamCameraRecord.stopRecording()
        .then((res) => { env.svc.onRecordingStopped(res); }));

      v = env.svc.view();
      eq(v.segmentIndex, 0, "plus aucun segment en cours après le STOP");
      eq(v.currentSegment, null);
      eq(hist(v), "1,2,3", "AUCUN fichier produit par ce Take ne reste sans index");
      eq(v.segments.map((s) => s.path).join(","),
        "file:///cache/videoTmp_10.mp4,file:///cache/videoTmp_11.mp4,file:///cache/videoTmp_12.mp4",
        "chaque chemin va avec son propre index");
      eq(v.segments.map((s) => s.camera).join(","), "REAR,FRONT,REAR",
        "et chaque segment porte la caméra qui l'a réellement enregistré");
      eq(env.svc.view().segmentCount, 3);
    });

    it("S13. un STOP sans switch donne un unique segment 1", async () => {
      const env = await top(bootService());
      eq(env.svc.view().segmentIndex, 1);
      nameFile(env, 20);
      await adv(env, () => env.MultiCamCameraRecord.stopRecording()
        .then((res) => { env.svc.onRecordingStopped(res); }));
      const v = env.svc.view();
      eq(hist(v), "1");
      eq(v.segments[0].path, "file:///cache/videoTmp_20.mp4");
      eq(v.segments[0].camera, "REAR");
      eq(v.segmentIndex, 0);
    });

    it("S14. un double top n'ouvre pas un second segment", async () => {
      const env = await top(bootService());
      env.svc.onRecordingStarted();
      const v = env.svc.view();
      eq(v.segmentIndex, 1, "un seul segment ouvert pour un seul Take");
      eq(hist(v), "", "et toujours aucun segment clôturé");
      if (!/CAMERA_SEGMENT_OPEN_SKIP reason=already_open/.test(env.logText())) {
        throw new Error("un second top doit être journalisé comme refusé");
      }
    });

    it("S15. un nouveau plan repart de 1", async () => {
      const env = await top(bootService());
      nameFile(env, 30);
      await adv(env, () => env.svc.requestSwitch("FRONT"));
      eq(env.svc.view().segmentIndex, 2);
      env.svc.onStartView({ active: true, sid: SID, takeNumber: TAKE + 1 });
      const v = env.svc.view();
      eq(v.segmentIndex, 0, "le nouveau Take n'hérite d'aucun segment en cours");
      eq(hist(v), "", "ni d'un historique qui n'est pas le sien");
      env.svc.onRecordingStarted();
      eq(env.svc.view().segmentIndex, 1, "et son premier segment est le 1");
    });
  });

  /* ══════════════════ J09-08b2 · échecs de segmentation ══════════════════ */

  /* Un échec de bascule est le seul moment où l'identité d'un segment peut être
   * perdue : la caméra a pu changer, le recorder s'arrêter, un fichier se
   * finaliser. Ces tests traversent le VRAI chemin natif (faux plugin compris) et
   * vérifient trois choses, dans tous les cas :
   *
   *   - l'IDENTITÉ : un segment porte toujours son index, et l'historique ne
   *     présente jamais comme finalisé un fichier dont la fin est inconnue ;
   *   - l'INDEX : aucun numéro n'est consommé ni réutilisé par un échec, et le
   *     segment suivant est N+1 ou N+2 SELON qu'un recorder a réellement été
   *     créé — jamais par hasard ;
   *   - le DISCRIMINANT : sans relecture prouvant la création d'un recorder, on
   *     n'ouvre rien. C'est la règle fail closed qui rend les deux précédentes
   *     tenables.
   *
   * Le natif ne distingue pas « rien ne s'est passé » de « un recorder a été
   * créé puis a échoué » : les deux partagent le callback d'erreur. Le faux
   * reproduit cette ambiguïté (`failRecordAfterStart`), et c'est la RELECTURE de
   * `getCameraState` qui tranche. */
  describe("J09-08b2 · échecs de segmentation — identité du segment et index", () => {
    async function top(env) {
      await adv(env, () => env.MultiCamCameraRecord.prepare({ startPlanId: "P1" }));
      await adv(env, () => env.MultiCamCameraRecord.startRecording({
        startPlanId: "P1", takeNumber: TAKE
      }));
      env.svc.onRecordingStarted();
      return env;
    }

    function nameFile(env, n) { env.CameraPreview.videoPath = "file:///cache/videoTmp_" + n + ".mp4"; }
    function hist(v) { return v.segments.map((s) => s.segmentIndex).join(","); }
    function states(v) { return v.segments.map((s) => s.state).join(","); }
    function uniq(v) {
      const all = v.segments.map((s) => s.segmentIndex);
      if (v.currentSegment) all.push(v.currentSegment.segmentIndex);
      return new Set(all).size === all.length;
    }

    /* Une tentative DOIT échouer : le rejet est capturé avant l'avancée de
     * l'horloge, sinon Node le traite comme non géré et tue la suite. */
    async function tryAdv(env, fn, ms) {
      const guarded = Promise.resolve().then(fn).then((v) => ({ v }), (e) => ({ e }));
      await env.clock.advance(ms || 40);
      return guarded;
    }

    /* ---------- A · arrêt non confirmé ---------- */

    it("A1. un arrêt NON CONFIRMÉ ne clôture aucun segment et ne consomme aucun index", async () => {
      const env = await top(bootService());
      nameFile(env, 40);
      env.CameraPreview.failStop = "STOP_TIMEOUT";

      const stopped = await tryAdv(env, () => env.MultiCamCameraRecord.stopRecording());
      yes(stopped.e, "un arrêt en erreur doit remonter en erreur");
      eq(stopped.e.code, "stop_failed");
      eq(stopped.e.closed, false, "la clôture n'est PAS confirmée : c'est le fait décisif");
      eq(stopped.e.closedPath, "", "et aucun chemin n'est produit");
      eq(stopped.e.recorderRunning, true,
        "la relecture dit que le recorder tourne toujours : l'arrêt a échoué sans rien arrêter");
      /* Contrat du start-service : un arrêt en erreur passe par
       * `onRecordingStopFailed`, JAMAIS par `onRecordingStopped`. */
      env.svc.onRecordingStopFailed(stopped.e);

      const v = env.svc.view();
      eq(v.segmentIndex, 1, "le segment reste EN COURS : un arrêt raté ne le fait pas disparaître");
      eq(v.currentSegment.segmentIndex, 1, "et il reste IDENTIFIABLE");
      eq(v.currentSegment.state, "failed", "son état le dit : la fin du fichier n'est pas confirmée");
      eq(v.currentSegment.failureCode, "stop_failed");
      eq(hist(v), "", "l'historique ne présente aucun fichier comme finalisé");
      eq(v.segmentCount, 1, "mais le Take compte bien un segment de moins qu'un STOP réussi");
      yes(uniq(v));
    });

    it("A2. la reprise referme LE MÊME segment : pas de saut, pas de doublon", async () => {
      const env = await top(bootService());
      nameFile(env, 41);
      env.CameraPreview.failStop = "STOP_TIMEOUT";
      const stopped = await tryAdv(env, () => env.MultiCamCameraRecord.stopRecording());
      env.svc.onRecordingStopFailed(stopped.e);

      env.CameraPreview.failStop = null;
      nameFile(env, 42);
      const res = await adv(env, () => env.MultiCamCameraRecord.stopRecording()
        .then((r) => { env.svc.onRecordingStopped(r); return r; }));
      eq(res.detail, "stopRecordVideo_ok");
      let v = env.svc.view();
      eq(hist(v), "1", "la reprise referme le segment 1 : aucun index sauté");
      eq(v.segments[0].path, "file:///cache/videoTmp_42.mp4", "et lui attribue LE BON fichier");
      eq(v.segments[0].state, "closed");
      eq(v.segments[0].failureCode, "stop_failed",
        "l'échec antérieur reste porté par le segment : le fait observé ne s'efface pas");
      eq(v.segmentIndex, 0);

      /* Le segment suivant du Take vaut 2 : l'échec n'a consommé aucun numéro. */
      env.svc.onRecordingStarted();
      eq(env.svc.view().segmentIndex, 2,
        "un arrêt raté ne fait pas sauter un index : le suivant est N+1");
    });

    it("A3. le wrapper ne rend JAMAIS un chemin périmé après un arrêt raté", async () => {
      /* Un arrêt RÉUSSI, puis un segment redémarré : c'est le seul contexte où
       * `videoPath` désigne un fichier qui n'est PAS celui du segment courant. */
      const env = await enterRec(bootRecord());
      env.CameraPreview.videoPath = "/tmp/seg1.mp4";
      await native(env, () => env.rec.stopRecording());
      await native(env, () => env.rec.startRecording({ startPlanId: "P1", takeNumber: TAKE }));
      eq(env.rec.view().videoPath, "/tmp/seg1.mp4", "le chemin mémorisé est celui du segment précédent");

      env.CameraPreview.failStop = "STOP_TIMEOUT";
      let err = null;
      try { await native(env, () => env.rec.stopRecording()); } catch (e) { err = e; }
      yes(err, "un arrêt en erreur ne doit jamais résoudre");
      eq(err.code, "stop_failed");
      eq(err.closed, false);
      eq(err.closedPath, "");
      eq(err.closedAtMs, 0);
      yes(env.rec.isRecording(),
        "la relecture dit que le recorder tourne : l'état publié reste le dernier fait connu");
      eq(env.rec.view().videoPath, "",
        "le chemin du segment précédent est purgé : il ne décrit plus rien de courant");
    });

    it("A4. un arrêt raté dont le recorder a DISPARU ne rend pas non plus de chemin", async () => {
      const env = await enterRec(bootRecord({ failStopDropsRecorder: true }));
      env.CameraPreview.videoPath = "/tmp/seg1.mp4";
      await native(env, () => env.rec.stopRecording());
      await native(env, () => env.rec.startRecording({ startPlanId: "P1", takeNumber: TAKE }));
      env.CameraPreview.failStop = "STOP_TIMEOUT";

      let err = null;
      try { await native(env, () => env.rec.stopRecording()); } catch (e) { err = e; }
      eq(err.code, "stop_failed");
      eq(err.recorderRunning, false, "la relecture dit qu'aucun recorder ne tourne");
      no(env.rec.isRecording());

      const again = await native(env, () => env.rec.stopRecording());
      eq(again.detail, "stop_unconfirmed", "un arrêt déjà raté ne se déguise pas en arrêt propre");
      eq(again.path, "", "et il ne rend surtout pas le fichier du segment précédent");
    });

    /* ---------- B · redémarrage refusé avant toute création ---------- */

    it("B1. un redémarrage refusé AVANT création ne fabrique aucun segment", async () => {
      const env = await top(bootService());
      nameFile(env, 50);
      env.CameraPreview.failRecord = true;

      const r = await adv(env, () => env.svc.requestSwitch("FRONT"));
      no(r.ok, "le switch doit échouer");
      eq(r.code, "restart_failed", "et le motif est celui du REDÉMARRAGE, pas un refus générique");
      /* J09-08b3 : la bascule NATIVE a réussi et la relecture l'atteste. Le
       * redémarrage, lui, a échoué — ce sont deux faits distincts, et c'est la
       * caméra qui l'emporte : la cible est publiée. La segmentation reste
       * celle de J09-08b2 (rien n'est ouvert, aucun index consommé). */
      eq(r.camera, "FRONT", "la caméra publiée est celle qui FILME, pas celle qui filmeait");
      eq(env.svc.view().activeCamera, "FRONT", "et l'état du service l'a adoptée, lui aussi");

      const v = env.svc.view();
      eq(hist(v), "1", "N rejoint l'historique : un fichier réellement produit ne peut pas être perdu");
      eq(v.segments[0].path, "file:///cache/videoTmp_50.mp4");
      eq(v.segments[0].state, "closed");
      eq(v.segments[0].camera, "REAR", "et il porte SA caméra de départ, pas la cible");
      eq(v.currentSegment, null, "AUCUN N+1 fantôme : rien n'a été créé");
      eq(v.segmentIndex, 0);
      eq(v.segmentState, "");
      eq(v.activeCamera, "FRONT",
        "le natif confirme FRONT : même sans segment ouvert, c'est la caméra publiée");
      no(env.MultiCamCameraRecord.isRecording(), "le natif confirme qu'aucun recorder ne tourne");
      yes(uniq(v));
    });

    it("B2. après un redémarrage refusé, le segment suivant est bien N+1", async () => {
      const env = await top(bootService());
      nameFile(env, 51);
      env.CameraPreview.failRecord = true;
      no((await adv(env, () => env.svc.requestSwitch("FRONT"))).ok);
      eq(env.svc.view().segmentIndex, 0, "rien n'est en cours après le refus");

      env.CameraPreview.failRecord = false;
      nameFile(env, 52);
      await adv(env, () => env.MultiCamCameraRecord.startRecording({
        startPlanId: "P1", takeNumber: TAKE
      }));
      env.svc.onRecordingStarted();
      eq(env.svc.view().segmentIndex, 2,
        "le refus n'a consommé aucun index : le prochain fichier est le segment 2");
      eq(hist(env.svc.view()), "1");
    });

    it("B3. un échec de bascule APRÈS la clôture referme N, sans créer de N+1", async () => {
      const env = await top(bootService({ failSwitch: "CAMERA_DISCONNECTED" }));
      nameFile(env, 53);
      const r = await adv(env, () => env.svc.requestSwitch("FRONT"));
      no(r.ok);
      eq(r.code, "switch_failed", "c'est la bascule qui a échoué, pas le redémarrage");
      eq(r.camera, "REAR", "et la cible ne s'est pas declarée acquise à tort");

      const v = env.svc.view();
      eq(hist(v), "1", "le segment N est clos et il le dit");
      eq(v.segments[0].path, "file:///cache/videoTmp_53.mp4");
      eq(v.segmentCount, 1);
      eq(v.currentSegment, null, "et rien n'est ouvert à la place");
      eq(v.activeCamera, "REAR", "la caméra n'a pas bougé : la bascule n'est pas confirmée");
    });

    /* ---------- C · recorder N+1 créé puis échec ---------- */

    it("C1. un N+1 RÉELLEMENT créé reste le segment en cours, marqué en échec", async () => {
      const env = await top(bootService());
      nameFile(env, 60);
      env.CameraPreview.nextPath = "file:///cache/videoTmp_61.mp4";
      env.CameraPreview.failRecordAfterStart = true;

      const r = await adv(env, () => env.svc.requestSwitch("FRONT"));
      no(r.ok, "le switch doit échouer");
      eq(r.code, "restart_failed");

      const v = env.svc.view();
      eq(hist(v), "1", "le segment N est clos, il a produit un fichier");
      eq(v.segmentIndex, 2, "et le N+1 EXISTE : son index lui revient, il n'est pas jeté");
      eq(v.currentSegment.state, "failed", "mais sa fin n'est pas confirmée : il est marqué en échec");
      eq(v.segmentState, "failed");
      eq(v.currentSegment.camera, "FRONT", "il porte la caméra CONFIRMÉE, jamais la demandée");
      eq(v.activeCamera, "FRONT",
        "et l'ACTIF va dans le même sens : un seul fait, pas deux caméras en conflit");
      eq(v.currentSegment.path, "file:///cache/videoTmp_61.mp4", "son chemin est conservé quand il est connu");
      eq(v.currentSegment.failureCode, "restart_failed");
      yes(v.currentSegment.failedAtMs > 0);
      eq(v.segmentCount, 2, "deux segments, un seul clôturé");
      yes(env.MultiCamCameraRecord.isRecording(), "et le recorder existe bien : la relecture le dit");
      yes(uniq(v));
    });

    it("C2. après un N+1 en échec, le fichier suivant est N+2", async () => {
      const env = await top(bootService());
      nameFile(env, 63);
      env.CameraPreview.failRecordAfterStart = true;
      no((await adv(env, () => env.svc.requestSwitch("FRONT"))).ok);
      eq(env.svc.view().segmentIndex, 2);

      env.CameraPreview.failRecordAfterStart = false;
      nameFile(env, 64);
      const r2 = await adv(env, () => env.svc.requestSwitch("REAR"));
      yes(r2.ok, "la bascule suivante repart d'un état cohérent");
      eq(r2.closedSegmentIndex, 2, "c'est le N+1 en échec qui est clos");
      eq(r2.closedPath, "file:///cache/videoTmp_64.mp4",
        "et son fichier est celui produit par l'arrêt qui a, lui, abouti");
      eq(r2.segmentIndex, 3, "le nouveau fichier est le segment 3 : N+2, aucun index sauté");

      const v = env.svc.view();
      eq(hist(v), "1,2", "l'historique est ordonné et sans trou");
      eq(v.currentSegment.camera, "REAR");
      eq(v.currentSegment.state, "recording");
      yes(uniq(v));
    });

    /* ---------- D · STOP après un échec ---------- */

    it("D1. un STOP après un échec referme le Take sans doublon d'index", async () => {
      const env = await top(bootService());
      nameFile(env, 70);
      env.CameraPreview.nextPath = "file:///cache/videoTmp_71.mp4";
      env.CameraPreview.failRecordAfterStart = true;
      no((await adv(env, () => env.svc.requestSwitch("FRONT"))).ok);
      eq(env.svc.view().segmentIndex, 2);

      env.CameraPreview.failRecordAfterStart = false;
      nameFile(env, 72);
      await adv(env, () => env.MultiCamCameraRecord.stopRecording()
        .then((r) => { env.svc.onRecordingStopped(r); }));

      const v = env.svc.view();
      eq(hist(v), "1,2", "les DEUX segments produits sont clôturés, aucun n'est perdu");
      eq(states(v), "closed,closed", "le fichier du N+1 a bien été finalisé par le STOP");
      eq(v.segments[1].path, "file:///cache/videoTmp_72.mp4",
        "et il porte LE fichier réel, pas le chemin du segment précédent");
      eq(v.segments[1].failureCode, "restart_failed", "l'échec de création reste tracé");
      eq(v.segmentIndex, 0);
      eq(v.currentSegment, null);
      yes(uniq(v), "aucun index partagé entre deux segments du même Take");

      /* Et le Take peut continuer : le numéro suivant est 3. */
      nameFile(env, 73);
      await adv(env, () => env.MultiCamCameraRecord.startRecording({
        startPlanId: "P1", takeNumber: TAKE
      }));
      env.svc.onRecordingStarted();
      eq(env.svc.view().segmentIndex, 3, "le max observé fait la loi : jamais de réutilisation");
    });

    it("D2. un STOP après un redémarrage refusé n'ajoute RIEN à l'historique", async () => {
      const env = await top(bootService());
      nameFile(env, 74);
      env.CameraPreview.failRecord = true;
      no((await adv(env, () => env.svc.requestSwitch("FRONT"))).ok);
      eq(hist(env.svc.view()), "1");

      /* Aucun recorder ne tourne : l'arrêt ne peut rien clôturer de plus. */
      env.CameraPreview.failRecord = false;
      await adv(env, () => env.MultiCamCameraRecord.stopRecording()
        .then((r) => { env.svc.onRecordingStopped(r); }));
      const v = env.svc.view();
      eq(hist(v), "1", "pas de segment fantôme au STOP : rien n'était en cours");
      eq(v.segmentIndex, 0);
      eq(v.segments.length, 1);
      yes(uniq(v));
      yes(env.logText().indexOf("CAMERA_SEGMENT_FINAL_SKIP reason=no_current_segment") >= 0,
        "et le Skip est journalisé : un STOP sans segment est dit, pas silencieusement absorbé");
    });

    it("D3. le STOP du start-service signale l'échec au modèle ET remonte l'erreur", async () => {
      /* Le câblage réel : c'est le start-service qui appelle le hook d'échec. On
       * capture les `deps` qu'il construit pour appeler le VRAI `stopRecording`. */
      const env = bootService({ failStop: "STOP_TIMEOUT" });
      loadAll(env, ["state/start-model.js", "state/start-service.js"]);
      let deps = null;
      env.MultiCamStartModel = {
        createMachine(d) { deps = d; return { view: () => ({ active: false, phase: "IDLE", rev: 0 }), isActive: () => false }; }
      };
      env.MultiCamStartService.bind();
      yes(deps && typeof deps.stopRecording === "function", "le start-service doit construire ses deps");

      await top(env);
      let err = null;
      try { await adv(env, () => deps.stopRecording()); } catch (e) { err = e; }
      yes(err, "l'erreur doit remonter au modèle : un STOP raté ne peut pas sembler réussi");
      eq(err.code, "stop_failed");
      const v = env.svc.view();
      eq(v.segmentIndex, 1, "et le segment reste en cours");
      eq(v.currentSegment.state, "failed", "marqué en échec par le hook du start-service");
      eq(hist(v), "");
    });

    /* ---------- E · états explicites ---------- */

    it("E1. le cycle nominal donne `recording` puis `closed`, sans autre état", async () => {
      const env = await top(bootService());
      let v = env.svc.view();
      eq(v.currentSegment.state, "recording", "un segment qui film est `recording`");
      eq(v.segmentState, "recording", "et la vue l'expose sans traverser le segment");

      nameFile(env, 80);
      await adv(env, () => env.svc.requestSwitch("FRONT"));
      v = env.svc.view();
      eq(states(v), "closed", "le segment clos par la bascule est `closed`");
      eq(v.currentSegment.state, "recording", "et le suivant repart en `recording`");

      nameFile(env, 81);
      await adv(env, () => env.MultiCamCameraRecord.stopRecording()
        .then((r) => { env.svc.onRecordingStopped(r); }));
      v = env.svc.view();
      eq(states(v), "closed,closed");
      eq(v.segmentState, "", "plus rien en cours : pas d'état à afficher");
    });

    it("E2. le modèle : un échec conserve l'index, l'historique, et n'ouvre rien", () => {
      const env = bootModel();
      const M = env.M;
      eq(M.SEG.RECORDING, "recording");
      eq(M.SEG.CLOSED, "closed");
      eq(M.SEG.FAILED, "failed");

      let st = M.attachToTake(M.createState(SID), SID, TAKE, 0);
      st = M.openSegment(st, { camera: "REAR", startedAtMs: 1000 });
      const failed = M.markSegmentFailed(st, { failureCode: "stop_failed", failedAtMs: 1500 });
      eq(failed.currentSegment.segmentIndex, 1, "le segment garde SON index");
      eq(failed.currentSegment.state, M.SEG.FAILED);
      eq(failed.currentSegment.failureCode, "stop_failed");
      eq(failed.currentSegment.failedAtMs, 1500);
      eq(failed.segments.length, 0, "l'historique ne reçoit pas un fichier non finalisé");
      eq(M.currentIndex(failed), 1, "et il reste le segment EN COURS");
      eq(M.nextSegmentIndex(failed), 2, "l'échec ne consomme aucun numéro");

      /* Une clôture ultérieure referme LE MÊME segment, échec compris. */
      const closed = M.closeCurrentSegment(failed, { path: "/tmp/seg1.mp4", stoppedAtMs: 2000 });
      eq(closed.segments.length, 1);
      eq(closed.segments[0].segmentIndex, 1);
      eq(closed.segments[0].state, M.SEG.CLOSED);
      eq(closed.segments[0].failureCode, "stop_failed", "le fait observé reste porté");
      eq(M.currentIndex(closed), 0);

      /* Sans segment ouvert, un échec n'invente rien. */
      const none = M.markSegmentFailed(closed, { failureCode: "stop_failed" });
      eq(none.segments.length, 1, "aucune entrée ajoutée");
      eq(none.currentSegment, null);
    });

    it("E3. le modèle : deux échecs successifs ne créent toujours qu'un index", () => {
      const env = bootModel();
      const M = env.M;
      let st = M.attachToTake(M.createState(SID), SID, TAKE, 0);
      st = M.openSegment(st, { camera: "REAR", startedAtMs: 1000 });
      st = M.markSegmentFailed(st, { failureCode: "restart_failed", failedAtMs: 1100 });
      st = M.markSegmentFailed(st, { failureCode: "stop_failed", failedAtMs: 1200 });
      eq(st.segments.length, 0, "aucun segment rejoindra l'historique sans clôture confirmée");
      eq(M.currentIndex(st), 1, "et un seul index est en jeu");
      eq(M.nextSegmentIndex(st), 2);
      eq(st.currentSegment.failureCode, "stop_failed", "le dernier échec constaté est celui qui compte");
    });

    /* ---------- F · fail closed ---------- */

    it("F1. un refus SANS effet physique ne touche à aucun segment", async () => {
      const env = await top(bootService({ physicalCameras: ["back"] }));
      await adv(env, () => env.svc.refreshAvailability());
      const r = await adv(env, () => env.svc.requestSwitch("FRONT"));
      no(r.ok);
      eq(r.code, env.MultiCamCameraSwitchModel.ERR.CAMERA_NOT_AVAILABLE);

      const v = env.svc.view();
      eq(v.segmentIndex, 1, "le segment est intact");
      eq(v.currentSegment.state, "recording", "et toujours en cours d'enregistrement");
      eq(hist(v), "", "aucune clôture, aucune invention");
      eq(env.CameraPreview.calls.stopRecordVideo, 0, "rien n'a été touché côté matériel");
    });

    it("F2. une erreur SANS FAITS n'inscrit rien : l'absence de preuve n'est pas une preuve", async () => {
      const env = await top(bootService());
      nameFile(env, 90);
      /* Un échec qui ne rapporte AUCUN fait : on ne peut rien déduire, donc on
       * n'inscrit rien. C'est le cas le plus défensif possible. */
      const real = env.MultiCamCameraRecord.switchSegmented;
      env.MultiCamCameraRecord.switchSegmented = function () { return Promise.reject(new Error("boom")); };
      const r = await tryAdv(env, () => env.svc.requestSwitch("FRONT"));
      no(r.v.ok);
      eq(r.v.code, "switch_failed", "sans code, c'est le refus générique — jamais un succès");
      env.MultiCamCameraRecord.switchSegmented = real;

      const v = env.svc.view();
      eq(v.segmentIndex, 1, "le segment reste en cours");
      eq(v.currentSegment.state, "recording", "et l'on n'invente pas un échec non constaté");
      eq(hist(v), "");
      eq(v.currentSegment.path, "", "aucun chemin n'est attribué à un fichier non finalisé");
    });

    it("F3. un refus avant toute opération ne porte AUCUN fait de segmentation", async () => {
      const env = await enterRec(bootRecord());
      let err = null;
      try { await native(env, () => env.rec.switchSegmented({ camera: "before" })); }
      catch (e) { err = e; }
      eq(err.code, "unknown_camera");
      eq(err.stopAttempted, false, "rien n'a été tenté");
      eq(err.closed, false);
      eq(err.closedPath, "");
      eq(err.recorderStarted, false, "et surtout AUCUNE preuve de création : rien ne sera ouvert");
      yes(env.rec.isRecording(), "le recorder d'origine n'a pas été touché");
    });
  });

  /* ══════════════════ J09-08b3 · cohérence de `activeCamera` ══════════════════ */

  /* Une bascule est une opération en DEUX temps : le natif change de caméra,
   * puis le recorder repart sur la nouvelle. Ces deux temps peuvent réussir ou
   * échouer séparément — et l'échec du second ne dit rien du premier.
   *
   * Tant que `activeCamera` a suivi le résultat GLOBAL de l'opération, un
   * `restart_failed` annonçait au Master's l'ancienne caméra pendant que
   * l'appareil filmait avec l'autre. Un Master's qui recadre sur cette valeur
   * cadre une image qu'il n'a pas : l'erreur coûte cher, en temps de tournage.
   *
   * Ces tests fixent donc la règle unique : **`activeCamera` est la caméra lue
   * au natif, jamais l'intention.** Elle est la SEULE authority qui décide, et
   * elle reste vraie que le redémarrage réussisse ou échoue. */
  describe("J09-08b3 · cohérence de `activeCamera` après une bascule", () => {
    async function top(env) {
      await adv(env, () => env.MultiCamCameraRecord.prepare({ startPlanId: "P1" }));
      await adv(env, () => env.MultiCamCameraRecord.startRecording({
        startPlanId: "P1", takeNumber: TAKE
      }));
      env.svc.onRecordingStarted();
      return env;
    }
    function nameFile(env, n) { env.CameraPreview.videoPath = "file:///cache/videoTmp_" + n + ".mp4"; }
    function hist(v) { return v.segments.map((s) => s.segmentIndex).join(","); }

    /* ---------- A · les deux temps réussissent ---------- */

    it("A. switch natif OK + restart OK : activeCamera = cible et recording = true", async () => {
      const env = await top(bootService());
      nameFile(env, 80);

      const r = await adv(env, () => env.svc.requestSwitch("FRONT"));
      yes(r.ok, "rien n'a échoué : l'ACK est un succès");
      eq(r.camera, "FRONT");
      const v = env.svc.view();
      eq(v.activeCamera, "FRONT");
      yes(v.recording, "le recorder repart, et c'est dit");
      eq(v.segmentState, "recording");
      eq(v.segmentIndex, 2, "l'indexation reste celle de J09-08b1");
      eq(hist(v), "1");
    });

    /* ---------- B · la bascule réussit, le redémarrage échoue ---------- */

    it("B. switch OK + restart KO AVANT création : la cible est publiée, rien n'est ouvert", async () => {
      const env = await top(bootService());
      nameFile(env, 81);
      env.CameraPreview.failRecord = true;

      const r = await adv(env, () => env.svc.requestSwitch("FRONT"));
      no(r.ok, "le redémarrage a échoué : l'ACK reste un ÉCHEC");
      eq(r.code, "restart_failed");
      eq(r.camera, "FRONT", "la caméra publiée est celle que le natif a réellement ouverte");
      const v = env.svc.view();
      eq(v.activeCamera, "FRONT");
      no(v.recording, "et rien n'enregistre : aucun faux ACCÈS au REC");
      eq(v.currentSegment, null, "aucun segment n'a été créé, donc rien à publier comme failed");
      eq(v.segmentState, "");
      eq(hist(v), "1", "le fichier réellement produit reste à l'histoire");
    });

    it("B'. switch OK + restart KO APRÈS création : segment failed, et le REC reste le fait relu", async () => {
      const env = await top(bootService());
      nameFile(env, 82);
      env.CameraPreview.nextPath = "file:///cache/videoTmp_83.mp4";
      env.CameraPreview.failRecordAfterStart = true;

      const r = await adv(env, () => env.svc.requestSwitch("FRONT"));
      no(r.ok, "l'opération d'ensemble reste un échec — on n'invente pas de succès");
      eq(r.code, "restart_failed");
      eq(r.camera, "FRONT");
      const v = env.svc.view();
      eq(v.activeCamera, "FRONT");
      eq(v.segmentState, "failed", "le segment existe et sa fin est inconnue : il le dit");
      eq(v.currentSegment.camera, "FRONT", "segment et actif portent la MÊME caméra");
      eq(v.currentSegment.path, "file:///cache/videoTmp_83.mp4");
      /* Le natif, relu, dit qu'un recorder tourne. Le publier `false` serait un
       * menteur d'un autre genre : le Master's croirait à tort que rien
       * n'écrit sur la carte pendant qu'un fichier s'écrit. `recording` est donc
       * le FAIT, et l'honnêteté se paie ici par `ok:false` + `segmentState`. */
      yes(v.recording, "la relecture dit qu'un recorder tourne : on ne le déclare pas arrêté");
      yes(env.MultiCamCameraRecord.isRecording(), "et le wrapper lui non plus");
    });

    /* ---------- C · la bascule native échoue ---------- */

    it("C. switch natif KO : activeCamera reste l'ancienne caméra RÉELLEMENT active", async () => {
      const env = await top(bootService());
      nameFile(env, 84);
      /* Une bascule réussie d'abord, pour que « l'ancienne » ne soit pas REAR. */
      yes((await adv(env, () => env.svc.requestSwitch("FRONT"))).ok);
      eq(env.svc.view().activeCamera, "FRONT");

      env.CameraPreview.failSwitch = "CAMERA_DISCONNECTED";
      const r = await adv(env, () => env.svc.requestSwitch("REAR"));
      no(r.ok);
      eq(r.code, "switch_failed");
      eq(r.camera, "FRONT",
        "la cible REAR n'a jamais été ouverte : elle ne peut pas devenir l'actif");
      eq(env.svc.view().activeCamera, "FRONT", "l'actif reste donc FRONT — la vérité");
    });

    /* ---------- D · la relecture fait foi ---------- */

    it("D. callback et relecture CONTRADICTOIRES : c'est la relecture qui fait foi", async () => {
      /* Le faux annonce la cible dans son callback mais n'atterrit pas dessus :
       * c'est le cas réel d'un pilote qui revient en arrière. */
      const env = await enterRec(bootRecord({ switchLandsOn: "back" }));
      await native(env, () => env.rec.prepare({ startPlanId: "P1" }));
      await native(env, () => env.rec.startRecording({ startPlanId: "P1", takeNumber: TAKE }));

      let err = null;
      try { await native(env, () => env.rec.switchSegmented({ camera: "front" })); }
      catch (e) { err = e; }
      yes(err, "la commande n'a pas été exécutée comme demandée : elle échoue");
      eq(err.code, "switch_failed");
      eq(err.to, "REAR", "le fait rapporté est la caméra RELUE, pas celle demandée");
      eq(env.rec.view().activeFacing, "REAR",
        "et le facing mémorisé suit la relecture : le callback optimiste n'a pas fait foi");
    });

    /* ---------- E · demandé ≠ confirmé ---------- */

    it("E. requestedCamera != confirmedCamera : activeCamera = confirmedCamera, jamais la cible", async () => {
      const env = await top(bootService());
      nameFile(env, 85);
      /* Le device est en REAR et la cible FRONT, mais le natif ne bouge pas. */
      env.CameraPreview.switchLandsOn = "back";

      const r = await adv(env, () => env.svc.requestSwitch("FRONT"));
      no(r.ok);
      eq(r.code, "switch_failed");
      eq(r.camera, "REAR", "la cible demandée n'est jamais adoptée comme active");
      const v = env.svc.view();
      eq(v.activeCamera, "REAR");
      eq(v.requestedCamera, "FRONT", "la DEMANDE reste tracée : elle ne vaut pas fait");
      eq(v.switchingCamera, "", "et plus aucune bascule n'est en vol");
      eq(v.segments[0].camera, "REAR", "le segment clos garde SA caméra de départ");
      no(v.recording, "le natif confirme qu'aucun recorder ne tourne");
    });

    /* ---------- F · l'indexation n'a pas bougé ---------- */

    it("F. l'adoption de la caméra ne consomme AUCUN index", async () => {
      /* B : rien n'est créé → le suivant reste N+1. */
      const b = await top(bootService());
      nameFile(b, 86);
      b.CameraPreview.failRecord = true;
      no((await adv(b, () => b.svc.requestSwitch("FRONT"))).ok);
      eq(b.svc.view().activeCamera, "FRONT", "la caméra, elle, a bien bougé");
      eq(hist(b.svc.view()), "1");
      eq(b.svc.view().segmentIndex, 0);

      b.CameraPreview.failRecord = false;
      nameFile(b, 87);
      await adv(b, () => b.MultiCamCameraRecord.startRecording({
        startPlanId: "P1", takeNumber: TAKE
      }));
      b.svc.onRecordingStarted();
      eq(b.svc.view().segmentIndex, 2, "le prochain segment est N+1 : aucun numéro sauté");

      /* B' : un N+1 réel existe → le suivant est N+2. */
      const c = await top(bootService());
      nameFile(c, 88);
      c.CameraPreview.failRecordAfterStart = true;
      no((await adv(c, () => c.svc.requestSwitch("FRONT"))).ok);
      eq(c.svc.view().segmentIndex, 2, "le N+1 réel garde son index");
      eq(c.svc.view().activeCamera, "FRONT");

      c.CameraPreview.failRecordAfterStart = false;
      nameFile(c, 89);
      const ok = await adv(c, () => c.svc.requestSwitch("REAR"));
      yes(ok.ok, "la bascule suivante repart d'un état cohérent");
      eq(ok.closedSegmentIndex, 2, "c'est le N+1 en échec qui est clos");
      eq(ok.segmentIndex, 3, "et le nouveau fichier est N+2");
      eq(hist(c.svc.view()), "1,2", "l'historique reste ordonné et sans trou");
    });
  });

  /* ══════════════════ J09-08b4 · plus de caméra demandée ══════════════════ */

  /* Au top d'un Take, la caméra demandée n'est qu'une INTENTION : le natif a pu
   * ouvrir l'autre (§35.1 — c'est même pour ça que la bascule ciblee existe).
   * `startRecording` gardait pourtant ce filet : `activeFacing || demande ||
   * "REAR"`. Une intention utilisée comme fait a deux conséquences concretes :
   *
   *   - le segment 1 se voyait attribuer REAR alors que personne n'avait vu
   *     quelle caméra filme ;
   *   - le Master's ne pouvait plus distinguer « filmé en REAR » de « non
   *     vérifié » : l'erreur devenait invisible au lieu d'être visible.
   *
   * Ces tests vérifient qu'une caméra inconnue reste inconnue, et que seule une
   * RELECTURE — jamais une demande, jamais une constante — peut renseigner le
   * premier segment d'un Take. */
  describe("J09-08b4 · la caméra d'un segment ne peut pas venir d'une demande", () => {
    async function top(env) {
      await adv(env, () => env.MultiCamCameraRecord.prepare({ startPlanId: "P1" }));
      await adv(env, () => env.MultiCamCameraRecord.startRecording({
        startPlanId: "P1", takeNumber: TAKE
      }));
      env.svc.onRecordingStarted();
      return env;
    }

    /* ---------- A · le natif a parlé ---------- */

    it("A. facing natif connu : le segment 1 porte la caméra RELUE", async () => {
      const env = await top(bootService());

      eq(env.MultiCamCameraRecord.view().activeFacing, "REAR",
        "la relecture de préparation a établi le fait");
      const v = env.svc.view();
      eq(v.currentSegment.segmentIndex, 1);
      eq(v.currentSegment.camera, "REAR", "le segment porte la caméra réellement ouverte");
      eq(env.CameraPreview.lastRecordOptions.cameraDirection, "back",
        "le natif reçoit la direction confirmée");
      /* `activeCamera` du MODÈLE reste vide au top : c'est le comportement J09-07
       * documenté en S8b — il se remplit à la première relecture de service ou
       * à la première bascule. Ce qui compte ici, c'est que la valeur qu'il
       * prendra ensuite soit le MÊME fait, jamais la demande. */
      await adv(env, () => env.svc.syncActiveCamera());
      eq(env.svc.view().activeCamera, "REAR",
        "l'actif vient de la relecture, il ne dérive pas de la demande");
    });

    /* ---------- B et C · le natif n'a rien dit ---------- */

    it("B. facing natif INCONNU + demande REAR : le segment ne peut pas valoir REAR", async () => {
      const env = await top(bootService({ failState: "STATE_KO" }));

      eq(env.MultiCamCameraRecord.view().activeFacing, "",
        "aucune relecture n'a abouti : la caméra reste inconnue");
      eq(env.CameraPreview.lastRecordOptions.cameraDirection, "",
        "et le natif ne reçoit AUCUNE direction : pas de REAR fabriqué");
      const v = env.svc.view();
      no(v.currentSegment.camera === "REAR", "la demande ne vaut pas preuve de caméra active");
      eq(v.currentSegment.camera, "", "le segment assume son caméra inconnue");
      eq(v.segmentIndex, 1, "le segment existe et reste numéroté : l'inconnu n'est pas un trou");
      yes(env.MultiCamCameraRecord.isRecording(), "l'enregistrement, lui, a bien démarré");
    });

    it("C. facing natif INCONNU + demande FRONT : le segment ne peut pas valoir FRONT", async () => {
      const env = await bootService({ failState: "STATE_KO" });
      await adv(env, () => env.MultiCamCameraRecord.prepare({ startPlanId: "P1" }));
      /* La caméra demandée est le FRONT : c'est elle qu'un repli laisserait
       * fuiter si l'inconnu n'était pas respecté. */
      await adv(env, () => env.MultiCamCameraRecord.startRecording({
        startPlanId: "P1", takeNumber: TAKE, camera: "FRONT"
      }));
      env.svc.onRecordingStarted();

      eq(env.CameraPreview.lastRecordOptions.cameraDirection, "",
        "aucune direction n'est transmise : ni back, ni front");
      const v = env.svc.view();
      no(v.currentSegment.camera === "FRONT", "une intention ne devient jamais un fait");
      eq(v.currentSegment.camera, "");
      eq(v.segmentIndex, 1);
    });

    /* ---------- D · la relecture arrive à temps ---------- */

    it("D. relecture native disponible au démarrage : c'est sa valeur qui prevails", async () => {
      const env = bootService({ failState: "STATE_KO" });
      await adv(env, () => env.MultiCamCameraRecord.prepare({ startPlanId: "P1" }));
      eq(env.MultiCamCameraRecord.view().activeFacing, "", "au départ, rien n'est connu");

      /* Le natif redevient lisible, et il filme en FRONT — alors que le plan
       * demande REAR. C'est le cas réel : une caméra verrouillée par un autre
       * processus, ou un pilote qui impose son choix. */
      env.CameraPreview.failState = null;
      env.CameraPreview.activeFacing = "front";
      await adv(env, () => env.MultiCamCameraRecord.startRecording({
        startPlanId: "P1", takeNumber: TAKE, camera: "REAR"
      }));
      env.svc.onRecordingStarted();

      eq(env.MultiCamCameraRecord.view().activeFacing, "FRONT",
        "la relecture fait foi, et la demande REAR n'a rien dit");
      eq(env.CameraPreview.lastRecordOptions.cameraDirection, "front",
        "la direction transmise est celle RELUE, pas celle demandée");
      eq(env.svc.view().currentSegment.camera, "FRONT",
        "le segment porte la caméra qui filme réellement");
      await adv(env, () => env.svc.syncActiveCamera());
      eq(env.svc.view().activeCamera, "FRONT",
        "et l'actif converge vers le même fait — surtout pas vers le REAR demandé");
    });

    /* ---------- E · rien d'autre n'a bougé ---------- */

    it("E. le switch normal et les index sont intacts", async () => {
      const env = await top(bootService());

      const a = await adv(env, () => env.svc.requestSwitch("FRONT"));
      yes(a.ok);
      eq(env.CameraPreview.lastRecordOptions.cameraDirection, "front",
        "après une bascule confirmée, la direction est celle du facing confirmé");
      const b = await adv(env, () => env.svc.requestSwitch("REAR"));
      yes(b.ok);
      eq(env.CameraPreview.lastRecordOptions.cameraDirection, "back");

      const v = env.svc.view();
      eq(v.segments.map((s) => s.segmentIndex).join(","), "1,2", "deux segments clôturés, dans l'ordre");
      eq(v.segments.map((s) => s.camera).join(","), "REAR,FRONT",
        "chacun porte la caméra qui a réellement filmé");
      eq(v.segmentIndex, 3, "le segment en cours est N+1 du dernier : aucun index consommé");
      eq(v.currentSegment.camera, "REAR");
      eq(v.activeCamera, "REAR");
    });
  });

  describe("J09-08c · publication réseau — le segment et la caméra RÉELS", () => {
    /* Ce que la Capture DIFFUSE n'a rien à voir avec ce qu'elle INTENTIONNE.
     * On vérifie donc le dernier `camera_state` émis, pas l'écran : un Master's
     * ne peut afficher que ce qui a été publié. */
    async function top(env) {
      /* J09-08f : sur le terrain, le plan START ATTACHE le Take (et amorce
       * l'identité de session) bien avant le REC. On le reproduit ici, sinon le
       * premier `camera_state` n'aurait pas de session à router — exactement le
       * défaut gelé par `060fd88`. */
      await attachTake(env);
      await adv(env, () => env.MultiCamCameraRecord.prepare({ startPlanId: "P1" }));
      /* Le plan de START sonde l'inventaire avant d'enregistrer : ce que la
       * Capture publie doit déjà porter un inventaire PROBE, jamais une liste
       * de caméras « connues puis devinées ». */
      await adv(env, () => env.svc.refreshAvailability());
      await adv(env, () => env.MultiCamCameraRecord.startRecording({
        startPlanId: "P1", takeNumber: TAKE
      }));
      env.svc.onRecordingStarted();
      return env;
    }
    function nameFile(env, n) { env.CameraPreview.videoPath = "file:///cache/videoTmp_" + n + ".mp4"; }
    function pub(env, reason) {
      const all = reqs(env, "camera_state");
      const found = reason ? all.filter((p) => p.env.reason === reason) : all;
      yes(found.length, "un camera_state a bien été publié" + (reason ? " (" + reason + ")" : ""));
      return found[found.length - 1].env;
    }
    function noSegments(env, tag) {
      const all = reqs(env, "camera_state");
      for (let i = 0; i < all.length; i++) {
        const e = all[i].env;
        no("segments" in e, tag + ": aucun catalogue de segments n'est publié (paquet #" + i + ")");
        no("currentSegment" in e, tag + ": le segment en cours ne voyage pas en clair");
      }
    }

    /* ---------- A · ouverture du segment 1 ---------- */

    it("A. REC démarre : activeCamera confirmée, segmentIndex 1, segmentState recording", async () => {
      const env = await top(bootService());

      const e = pub(env, "rec_started");
      eq(e.activeCamera, "REAR", "la caméra publiée est celle RELUE au natif");
      eq(e.segmentIndex, 1, "le segment EN COURS est le premier : l'index est né avec lui");
      eq(e.segmentState, "recording");
      eq(e.recording, true, "et l'enregistrement est une relecture, pas une intention");
      eq((e.availableCameras || []).join(","), "REAR,FRONT",
        "l'inventaire reste l'inventaire probes");
      noSegments(env, "A");

      /* Un Master's ne doit pas attendre la première bascule pour savoir que
       * la Capture filme : sans cet événement, l'ouverture resterait invisible. */
      eq(pub(env, "rec_started").atMs > 0, true, "l'instant de mesure accompagne l'état");
    });

    /* ---------- B et C · les bascules ---------- */

    it("B. bascule réussie : nouvelle activeCamera, segmentIndex 2, recording", async () => {
      const env = await top(bootService());
      nameFile(env, 30);

      const r = await adv(env, () => env.svc.requestSwitch("FRONT"));
      yes(r.ok);

      const e = pub(env, "switch_confirmed");
      eq(e.activeCamera, "FRONT", "la caméra publiée est celle qui filme MAINTENANT");
      eq(e.segmentIndex, 2, "le nouveau segment est N+1 : l'ancien index n'est pas recyclé");
      eq(e.segmentState, "recording");
      eq(e.recording, true);
      noSegments(env, "B");
    });

    it("C. seconde bascule : segmentIndex 3, l'historique n'est pas transmis", async () => {
      const env = await top(bootService());
      nameFile(env, 31);
      await adv(env, () => env.svc.requestSwitch("FRONT"));
      await adv(env, () => env.svc.requestSwitch("REAR"));

      const e = pub(env, "switch_confirmed");
      eq(e.activeCamera, "REAR");
      eq(e.segmentIndex, 3);
      eq(e.segmentState, "recording");
      noSegments(env, "C");
      eq(env.svc.view().segments.length, 2,
        "les deux segments clos existent côté Capture — et restent côté Capture");
    });

    /* ---------- D · STOP ---------- */

    it("D. STOP : segmentIndex 0 et segmentState vide, sans inventer de segment", async () => {
      const env = await top(bootService());
      nameFile(env, 32);

      await adv(env, () => env.MultiCamCameraRecord.stopRecording()
        .then((res) => { env.svc.onRecordingStopped(res); }));

      const e = pub(env, "stop");
      eq(e.segmentIndex, 0, "plus aucun segment en cours : 0, pas le dernier index vu");
      eq(e.segmentState, "", "et pas un état fantou");
      eq(e.recording, false, "le REC est fini : la relecture le dit");
      eq(e.activeCamera, "REAR", "la caméra reste un fait, même après la clôture");
      noSegments(env, "D");
    });

    it("D2. STOP en échec : le segment reste en failed, il n'est ni effacé ni maquillé", async () => {
      const env = await top(bootService());
      nameFile(env, 33);
      env.CameraPreview.failStop = "STOP_TIMEOUT";

      let failed = null;
      try {
        await adv(env, () => env.MultiCamCameraRecord.stopRecording());
      } catch (e) {
        failed = e;
      }
      yes(failed, "l'arrêt a bien échoué");
      env.svc.onRecordingStopFailed(failed || {});

      const e = pub(env, "stop_failed");
      eq(e.segmentIndex, 1, "le segment existe encore : sa fin est inconnue, pas fausse");
      eq(e.segmentState, "failed");
      eq(e.recording, true,
        "le natif dit que le recorder tourne : le publié doit le dire aussi, "
        + "sinon le Master's croit à un silence alors qu'un fichier s'écrit");
      noSegments(env, "D2");
    });

    /* ---------- E et F · échecs ---------- */

    it("E. restart_failed après bascule native confirmée : la NOUVELLE caméra est publiée", async () => {
      const env = await top(bootService());
      nameFile(env, 34);
      env.CameraPreview.failRecord = true;   /* KO avant création du segment */

      const r = await adv(env, () => env.svc.requestSwitch("FRONT"));
      no(r.ok);
      eq(r.code, "restart_failed");

      const e = pub(env, "switch_failed");
      eq(e.activeCamera, "FRONT",
        "le natif a ouvert la FRONT : l'ancien REAR ne peut plus être publié");
      eq(e.segmentIndex, 0, "aucun segment n'a été créé : il n'y a rien à nommer");
      eq(e.segmentState, "", "donc pas de « failed » sur un segment imaginaire");
      eq(e.recording, false);
    });

    it("E2. restart_failed APRÈS création : segment failed, segmentIndex 2", async () => {
      const env = await top(bootService());
      nameFile(env, 35);
      env.CameraPreview.nextPath = "file:///cache/videoTmp_36.mp4";
      env.CameraPreview.failRecordAfterStart = true;

      const r = await adv(env, () => env.svc.requestSwitch("FRONT"));
      no(r.ok);
      eq(r.code, "restart_failed");

      const e = pub(env, "switch_failed");
      eq(e.activeCamera, "FRONT");
      eq(e.segmentIndex, 2, "le segment a bien été ouvert par le natif : il est nommé");
      eq(e.segmentState, "failed", "et sa fin est inconue, ce qui se dit");
      eq(e.recording, true);
    });

    it("F. bascule native KO : la caméra DEMANDÉE n'est jamais publiée comme active", async () => {
      const env = await top(bootService());
      nameFile(env, 37);
      env.CameraPreview.failSwitch = true;

      const r = await adv(env, () => env.svc.requestSwitch("FRONT"));
      no(r.ok);

      const e = pub(env, "switch_failed");
      eq(e.activeCamera, "REAR", "l'actif reste la caméra qui filme réellement");
      no(e.activeCamera === "FRONT",
        "une caméra demandée n'est un fait qu'une fois relue au natif");
      eq(e.requestedCamera, "FRONT",
        "la DEMANDE reste publiée comme demande : c'est le seul endroit où elle a sa place");
      /* Le segment 1 avait été RÉELLEMENT clôturé avant la bascule (son fichier
       * existe, il est indexé) et le redémarrage n'a jamais eu lieu : aucun
       * segment n'est donc en cours. Publier 1/« recording » inventerait un
       * enregistrement qui n'existe pas. */
      eq(e.segmentIndex, 0, "plus de segment en cours : l'index du dernier segment clos "
        + "ne peut pas servir d'index courant");
      eq(e.segmentState, "");
      eq(e.recording, false, "et plus rien n'enregistre — le natif le dit");
      eq(env.svc.view().segments.map((sg) => sg.segmentIndex + ":" + sg.state).join(","), "1:closed",
        "le fichier réellement produit reste nommé, en historique");
    });

    /* ---------- G · réception côté Master's ---------- */

    it("G. le Master's conserve EXACTEMENT ce qui a été publié", async () => {
      const env = await top(bootService());
      const inbox = env.MultiCamCameraStateInbox;
      nameFile(env, 38);
      await adv(env, () => env.svc.requestSwitch("FRONT"));
      await adv(env, () => env.MultiCamCameraRecord.stopRecording()
        .then((res) => { env.svc.onRecordingStopped(res); }));

      /* On rejoue ce que le transport transmet : l'enveloppe ajoute `from`
       * (l'auteur) et son instant de réception, jamais un fait de segment. */
      const states = reqs(env, "camera_state");
      yes(states.length >= 3, "ouverture, bascule et STOP ont tous publié");
      let t = 1000;
      states.forEach((p) => {
        t += 100;
        yes(inbox.record(Object.assign({ from: p.env.deviceId, updatedAtMs: t }, p.env)),
          "un paquet bien formé est retenu");
      });

      const s = inbox.forDevice(env.svc.view().deviceId, SID);
      const last = states[states.length - 1].env;
      eq(s.activeCamera, last.activeCamera, "la caméra confirmée, ni plus ni moins");
      eq(s.segmentIndex, last.segmentIndex);
      eq(s.segmentState, last.segmentState);
      eq(s.recording, last.recording);
      eq(s.availableCameras.join(","), (last.availableCameras || []).join(","));
      eq(s.segmentIndex, 0, "et le Master's sait que le Take s'est arrêté");
      eq(s.recording, false);
    });

    it("G2. l'inbox refuse un segmentState inconnu et garde le précédent", async () => {
      const env = await top(bootService());
      const inbox = env.MultiCamCameraStateInbox;
      const did = env.svc.view().deviceId;

      function in4(o) {
        return inbox.record(Object.assign({
          sessionId: SID, deviceId: did, from: did,
          activeCamera: "REAR", availableCameras: ["REAR", "FRONT"],
          segmentIndex: 1, segmentState: "recording", recording: true,
          updatedAtMs: 2000
        }, o));
      }

      yes(in4({}), "un état complet passe");
      eq(inbox.forDevice(did, SID).segmentState, "recording");

      /* Un vocabulaire qu'aucun segment ne peut produire : on ne l'invente pas. */
      yes(in4({ segmentState: "RECHARGEMENT" }), "le paquet reste recevable");
      eq(inbox.forDevice(did, SID).segmentState, "recording",
        "mais l'état précédent est conservé : un mot inconnu ne l'écrase pas");

      /* `recording` doit être un booléen : une chaîne n'est pas une preuve. */
      yes(in4({ recording: "true", updatedAtMs: 2200 }), "paquet recevable");
      eq(inbox.forDevice(did, SID).recording, true,
        "et l'enregistrement connu reste le seul fait retenu");

      /* La chaîne VIDE, elle, est une publication : « plus aucun segment ». */
      yes(in4({ segmentIndex: 0, segmentState: "", recording: false, updatedAtMs: 2400 }),
        "le STOP est recevable");
      const s = inbox.forDevice(did, SID);
      eq(s.segmentIndex, 0);
      eq(s.segmentState, "", "un segment terminé ne laisse pas d'état fantôme");
      eq(s.recording, false, "et le Master's ne croit plus à un enregistrement");
    });
  });

  /* ══════════════════ D · UI : ce qui est AFFICHÉ ══════════════════ */

  /* J09-08d : jusqu'ici, la publication (J09-08c) et la réception de
   * `camera_state` étaient justes, mais RIEN ne les affichait : la modal
   * Master ne montrait ni l'état du segment ni l'enregistrement, et la vue
   * locale Capture n'affichait rien du tout. Ces tests lisent donc le TEXTE
   * réellement projeté dans le DOM, pas seulement le descripteur. */
  describe("J09-08d · UI — l'état caméra/segment réellement affiché", () => {
    /* Les ids que `live.js` et `live-detail.js` écrivent : le reste du DOM
     * n'existe pas dans ce test, et c'est sans importance — un `byId` qui rend
     * null est une projection absente, pas une erreur. */
    const UI_IDS = [
      "liveGrid", "liveSession", "liveTake", "liveTimer", "liveCount", "livePhase",
      "liveEmpty", "liveLocalCam", "liveDetailModal", "ldName", "ldState", "ldRecorder",
      "ldBattery", "ldStorage", "ldNetwork", "ldTelemetryAge", "ldPreviewAge",
      "ldSkillVideo", "ldSkillAudio", "ldSkillGps", "ldCamBox", "ldCamState",
      "ldCamActions", "ldCamNote", "ldIncidents", "ldImage", "ldNoImg", "ldClose"
    ];

    function withDom(env) {
      const dom = fakeDom(UI_IDS);
      env.document = dom;
      env.window.document = dom;
      return dom;
    }

    /* Vue LOCALE : le service est celui de CE device, donc la mosaïque et la
     * modal lisent le même état que la Capture. */
    function bootUi(opts) {
      const env = bootService(opts);
      loadAll(env, ["state/live-model.js", "ui/live.js", "ui/live-detail.js"]);
      const dom = withDom(env);
      const model = env.MultiCamLiveModel;
      model.bind({
        localDid: ME,
        getParticipants: (sid) => (sid === SID
          ? [{ deviceId: ME, deviceName: ME, role: "capture" },
            { deviceId: CAP, deviceName: CAP, role: "capture" }]
          : [])
      });
      model.setTake(SID, TAKE);
      model.syncParticipants();
      model.setLiveness(ME, true);
      model.setLiveness(CAP, true);
      env.uiDom = dom;
      env.liveModel = model;
      env.live = env.MultiCamLiveScreen;
      env.detail = env.MultiCamLiveDetail;
      return env;
    }

    /* Vue SUPERVISION : ce device est un Master SANS Capture locale, et l'état
     * qu'il affiche vient d'un `camera_state` reçu — c'est le chemin du test C'. */
    function bootSup() {
      const env = createEnv({ skills: ["capture", "controller"] });
      loadAll(env, [
        "state/camera-switch-model.js", "state/camera-state-inbox.js",
        "state/live-model.js", "ui/live.js", "ui/live-detail.js"
      ]);
      const dom = withDom(env);
      const model = env.MultiCamLiveModel;
      model.bind({
        localDid: OTHER,
        getParticipants: (sid) => (sid === SID
          ? [{ deviceId: CAP, deviceName: CAP, role: "capture" }] : [])
      });
      model.setTake(SID, TAKE);
      model.syncParticipants();
      model.setLiveness(CAP, true);
      env.uiDom = dom;
      env.liveModel = model;
      env.live = env.MultiCamLiveScreen;
      env.detail = env.MultiCamLiveDetail;
      env.inbox = env.MultiCamCameraStateInbox;
      return env;
    }

    /* Ce que l'écran RÉELLEMENT écrit : en-tête local + modal du même device,
     * lus dans le DOM. Une capture pour MEMOIRE aussi, sinon un test pourrait
     * passer sur un descripteur que la peinture n'utilise pas. */
    function shot(env, deviceId) {
      const did = deviceId || ME;
      const mv = env.liveModel.view();
      const v = env.live.render(mv, {
        nowMs: 1000, recStartedAtMs: 0, sessionName: "Tournage", phase: "REC"
      });
      const opened = env.detail.open(did);
      return {
        header: env.uiDom.byId.liveLocalCam.textContent,
        modal: env.uiDom.byId.ldCamState.textContent,
        note: env.uiDom.byId.ldCamNote.textContent,
        cam: (opened && opened.camera) || null,
        actions: (opened && opened.cameraActions) || [],
        tiles: v.tiles,
        grid: env.uiDom.byId.liveGrid,
        view: v
      };
    }

    function noInvented(text, what) {
      no(text.indexOf("segment 0") >= 0, "jamais « segment 0 » : le segment 0 n'existe pas (" + what + ")");
      no(text.indexOf("segment 0 ") >= 0, what);
    }

    async function top(env) {
      await adv(env, () => env.MultiCamCameraRecord.prepare({ startPlanId: "P1" }));
      await adv(env, () => env.svc.refreshAvailability());
      await adv(env, () => env.MultiCamCameraRecord.startRecording({
        startPlanId: "P1", takeNumber: TAKE
      }));
      env.svc.onRecordingStarted();
      return env;
    }
    function nameFile(env, n) { env.CameraPreview.videoPath = "file:///cache/videoTmp_" + n + ".mp4"; }

    /* ---------- A · REC initial ---------- */

    it("A. REC initial : caméra confirmée, segment 1, enregistrement", async () => {
      const env = await top(bootUi());
      const r = shot(env);

      eq(r.header, "Caméra Arrière · segment 1 · enregistrement",
        "l'en-tête local affiche les TROIS faits, dans cet ordre");
      eq(r.modal, r.header, "la modal dit exactement la même chose : une seule source");
      eq(r.cam.active, "REAR");
      eq(r.cam.segmentIndex, 1);
      eq(r.cam.segmentState, "recording");
      eq(r.cam.recording, true);
      eq(r.cam.hasSegment, true);
      noInvented(r.header, "A");
      noInvented(r.modal, "A/modal");
    });

    it("A2. la mosaïque garde son ordre et sa structure", async () => {
      const env = await top(bootUi());
      const r = shot(env);
      eq(r.view.count, 2, "deux vignettes : le device local et la Capture distante");
      eq(r.grid.children.length, 2, "une vignette par Capture, pas une ligne ajoutée par fait");
      eq(r.tiles.map((t) => t.deviceId).join(","), ME + "," + CAP,
        "l'ordre vient du plan de START, il n'a pas bougé");
      eq(r.tiles.map((t) => t.badges.length).join(","), "0,0",
        "aucun badge textuel n'est ajouté à la vignette");
      eq(r.actions.length, 2, "les deux contrôles caméra existent toujours");
    });

    /* ---------- B · après bascule ---------- */

    it("B. après bascule : nouvelle caméra, segment 2, enregistrement", async () => {
      const env = await top(bootUi());
      nameFile(env, 60);
      const sw = await adv(env, () => env.svc.requestSwitch("FRONT"));
      yes(sw.ok);
      const r = shot(env);

      eq(r.header, "Caméra Selfie · segment 2 · enregistrement");
      eq(r.modal, r.header);
      eq(r.cam.active, "FRONT", "c'est la caméra RELUE qui s'affiche");
      eq(r.cam.segmentIndex, 2);
      eq(r.cam.segmentState, "recording");
      eq(r.cam.recording, true);
    });

    /* ---------- C · segment en échec ---------- */

    it("C. restart_failed après création : segment failed, et la NOUVELLE caméra reste visible", async () => {
      const env = await top(bootUi());
      nameFile(env, 61);
      env.CameraPreview.nextPath = "file:///cache/videoTmp_62.mp4";
      env.CameraPreview.failRecordAfterStart = true;

      const sw = await adv(env, () => env.svc.requestSwitch("FRONT"));
      no(sw.ok);
      eq(sw.code, "restart_failed");
      const r = shot(env);

      eq(r.cam.active, "FRONT",
        "le natif a ouvert la FRONT : l'échec du redémarrage ne la fait pas disparaître");
      eq(r.cam.segmentState, "failed");
      eq(r.cam.segmentIndex, 2, "le segment réellement créé garde SON index");
      eq(r.cam.recording, true,
        "le natif confirme un recorder vivant : l'écran ne peut pas écrire « n'enregistre »");
      eq(r.header, "Caméra Selfie · segment 2 en échec · enregistrement");
      eq(r.modal, r.header);
      noInvented(r.header, "C");
    });

    it("C'. failed + recording=false : l'écran montre la caméra ET dit l'échec", () => {
      const env = bootSup();
      /* Ce que la Capture publie quand son recorder est mort en laissant un
       * segment ouvert : la caméra reste un fait, l'échec aussi. */
      yes(env.inbox.record({
        sessionId: SID, deviceId: CAP, from: CAP, phase: "REC",
        availableCameras: ["REAR", "FRONT"],
        activeCamera: "FRONT", requestedCamera: "REAR",
        segmentIndex: 2, segmentState: "failed", recording: false,
        lastErrorCode: "restart_failed", lastError: "restart_failed:true",
        atMs: 1000, updatedAtMs: 1000
      }), "le camera_state est recevable");

      const r = shot(env, CAP);
      eq(r.cam.source, "supervision", "le Master lit l'état PUBLIE par la Capture");
      eq(r.cam.active, "FRONT");
      eq(r.cam.segmentState, "failed");
      eq(r.cam.recording, false);
      eq(r.modal, "Caméra Selfie · segment 2 en échec · n'enregistre pas");
      noInvented(r.modal, "C'/modal");
      eq(r.note.indexOf("Segment 2 en échec") >= 0, true,
        "la note explique l'échec : sans elle, l'opérateur croirait à une bascule ratée");
      eq(r.header, "", "un Master sans Capture locale n'affiche pas de ligne locale");
    });

    /* ---------- D · STOP ---------- */

    it("D. STOP : « aucun segment actif », jamais « segment 0 »", async () => {
      const env = await top(bootUi());
      nameFile(env, 63);
      await adv(env, () => env.MultiCamCameraRecord.stopRecording()
        .then((res) => { env.svc.onRecordingStopped(res); }));

      const r = shot(env);
      eq(r.cam.segmentIndex, 0, "le fait reste 0");
      eq(r.cam.hasSegment, false);
      eq(r.cam.segmentState, "", "et il n'y a plus d'état de segment à afficher");
      eq(r.cam.recording, false);
      eq(r.header, "Caméra Arrière · aucun segment actif · n'enregistre pas");
      eq(r.modal, r.header);
      noInvented(r.header, "D");
      noInvented(r.modal, "D/modal");
    });

    /* ---------- E · caméra inconnue ---------- */

    it("E. activeCamera inconnue : état neutre, jamais REAR ni FRONT", async () => {
      const env = await top(bootUi({ failState: "STATE_KO" }));
      const r = shot(env);

      eq(r.cam.known, false, "aucun état caméra n'a été publié : le service n'a rien confirmé");
      eq(r.cam.active, "", "et donc aucune caméra à afficher");
      eq(r.header, "Caméra inconnue", "état neutre, et rien d'autre : ni caméra, "
        + "ni segment, ni enregistrement — aucun de ces faits n'est connu");
      eq(r.modal, r.header);
      no(r.header.indexOf("Arrière") >= 0, "aucune caméra ne peut être inventée (en-tête)");
      no(r.modal.indexOf("Arrière") >= 0, "aucune caméra ne peut être inventée (modal)");
      no(r.modal.indexOf("Selfie") >= 0, "ni l'autre caméra, non plus");
      eq(r.actions.length, 0, "sans inventaire confirmé, aucun bouton de bascule : "
        + "l'état neutre se lit aussi dans les contrôles");
    });

    /* ---------- F · bascule en vol ---------- */

    it("F. pendant une bascule : « Changement… », et l'actif reste lisible", async () => {
      /* `switchLatencyMs` élevé : la confirmation native arrive 5 s plus tard,
       * donc la bascule est observable — on ne lit pas un état qu'on a
       * laissé filer. */
      const env = await top(bootUi({ switchLatencyMs: 5000 }));
      /* La bascule n'est PAS attendue : on lit l'écran pendant qu'elle vole.
       * L'horloge virtuelle n'avance pas (flush ne déclenche que les microtâches),
       * donc la bascule reste en vol le temps de la lecture. */
      env.svc.requestSwitch("FRONT");
      /* On avance l'horloge NATIVE par pas de 1 ms jusqu'à ce que la bascule
       * soit engagée : la confirmation est à 5 s, donc elle ne peut pas
       * arriver pendant cette lecture. */
      for (let i = 0; i < 60 && !env.svc.view().switchingCamera; i++) {
        await flush(1);
        await env.clock.advance(1);
      }
      yes(env.svc.view().switchingCamera, "la bascule est bien en vol au moment de la lecture");
      const r = shot(env);

      eq(r.cam.switching, "FRONT", "la cible est en vol");
      eq(r.cam.active, "REAR", "l'actif, lui, n'a pas encore bougé");
      eq(r.cam.changing, true);
      eq(r.header.indexOf("Changement vers Selfie…") >= 0, true,
        "l'en-tête annonce le changement : « attendu " + r.header + " »");
      eq(r.modal.indexOf("Changement vers Selfie…") >= 0, true);
      eq(r.modal.indexOf("Caméra Arrière") >= 0, true,
        "et il rappelle la caméra qui filme EN ATTENDANT");
      eq(r.actions.length, 2, "les contrôles existent toujours");
      eq(r.actions.every((a) => a.disabled), true,
        "pendant une bascule, aucun bouton n'est actif : c'est le service qui refuse");
    });

    /* ---------- G · demandée ≠ active ---------- */

    it("G. requestedCamera n'est jamais présentée comme la caméra réelle", async () => {
      const env = await top(bootUi());
      nameFile(env, 64);
      env.CameraPreview.failSwitch = true;

      const sw = await adv(env, () => env.svc.requestSwitch("FRONT"));
      no(sw.ok, "la bascule native a échoué");

      const r = shot(env);
      eq(r.cam.requested, "FRONT", "la demande existe");
      eq(r.cam.active, "REAR", "mais le fait reste l'ancienne caméra");
      eq(r.header, "Caméra Arrière · aucun segment actif · n'enregistre pas");
      eq(r.modal, r.header);
      no(r.modal.indexOf("Caméra Selfie") >= 0,
        "la caméra DEMANDÉE ne peut pas s'afficher comme active : " + r.modal);
      no(r.header.indexOf("Caméra Selfie") >= 0,
        "ni dans l'en-tête : " + r.header);
      eq(r.actions.map((a) => a.active).join(","), "true,false",
        "c'est l'active qui allume son bouton, pas la demandée");
    });
  });

  /* ══════════════════ J09-08f · identité de session des publications ══════════════════ */

  describe("J09-08f · le premier camera_state doit atteindre les Masters", () => {
    /* Le défaut gelé par `060fd88` : au segment 1, la Capture publiait sous
     * `{ sessionId }` — un objet sans `masters`. `isMasterDevice()` y répondait
     * faux pour TOUT le monde, et le journal disait `masters=0`. Le Master ne
     * recevait rien jusqu'à la première bascule, qui rechargeait la session par
     * un autre chemin. Ces tests rejouent le ROUTAGE réel, pas un stub permissif. */

    /* Le réseau de terrain : la Capture et le Master connectés et marqués dans
     * la session du Take. DEV-1 (nous) et DEV-2 (Capture) ne sont pas Masters ;
     * DEV-3 en est un. */
    function netFor(sid, extra) {
      return Object.assign({
        [CAP]: { connected: true, sessions: { [sid]: {} } },
        [OTHER]: { connected: true, sessions: { [sid]: {} } }
      }, extra || {});
    }

    async function rec(env) {
      await attachTake(env);
      await adv(env, () => env.MultiCamCameraRecord.prepare({ startPlanId: "P1" }));
      await adv(env, () => env.MultiCamCameraRecord.startRecording({
        startPlanId: "P1", takeNumber: TAKE
      }));
      env.svc.onRecordingStarted();
      await flush();
      return env;
    }
    function boot(sid, opts) {
      const o = Object.assign({ routing: true }, opts || {});
      if (!("routePeers" in o)) o.routePeers = netFor(sid || SID);
      return bootService(o);
    }
    function lastPub(env, reason) {
      const all = reqs(env, "camera_state");
      const found = reason ? all.filter((p) => p.env.reason === reason) : all;
      yes(found.length, "un camera_state a bien été publié" + (reason ? " (" + reason + ")" : ""));
      return found[found.length - 1];
    }

    /* ---------- A et B · le segment 1 ---------- */

    it("A. le segment 1 atteint les Masters de la session", async () => {
      const env = await rec(boot(SID));

      const p = lastPub(env, "rec_started");
      eq(p.masters, 1, "le Master de la session reçoit l'ouverture du segment 1");
      eq(p.session.sessionId, SID, "publié sous l'identité du Take, pas sous un objet vide");
    });

    it("B. le premier paquet porte le segment 1 RÉEL", async () => {
      const env = await rec(boot(SID));

      const p = lastPub(env, "rec_started");
      eq(p.env.activeCamera, "REAR", "la caméra relue au natif");
      eq(p.env.segmentIndex, 1, "le premier segment, né avec l'enregistrement");
      eq(p.env.segmentState, "recording");
      eq(p.env.recording, true);
      eq(p.env.takeNumber, TAKE, "et il est rattaché à son Take");
    });

    /* ---------- C · aucune session à router ---------- */

    it("C. une session sans Master donne masters=0, et RIEN n'est inventé", async () => {
      const sansMaster = sessionWithTake();
      sansMaster.masters = [];
      const env = await rec(boot(SID, { sessions: { [SID]: sansMaster } }));

      const p = lastPub(env, "rec_started");
      eq(p.masters, 0, "personne n'est Master : personne n'est visé");
      eq(p.session.sessionId, SID, "la session reste celle du Take");
      eq((p.session.masters || []).length, 0,
        "aucun Master n'a été AJOUTÉ à la session pour forcer un envoi");
      eq(env.svc.broadcastState("sonde"), false,
        "et une publication sans Master reste un échec assumé, pas un envoi");
    });

    /* ---------- D et E · la vie du Take ---------- */

    it("D. la première bascule réutilise EXACTEMENT la même identité de session", async () => {
      const env = await rec(boot(SID));
      env.CameraPreview.videoPath = "file:///cache/videoTmp_70.mp4";
      const ouverture = lastPub(env, "rec_started");

      await adv(env, () => env.svc.requestSwitch("FRONT"));

      const sw = lastPub(env, "switch_confirmed");
      eq(sw.session, ouverture.session,
        "même objet de session d'une publication à l'autre : aucune relecture divergente");
      eq(sw.masters, 1, "et le routage reste entier");
      eq(sw.env.segmentIndex, 2);
    });

    it("E. le STOP est routé comme l'ouverture", async () => {
      const env = await rec(boot(SID));
      env.CameraPreview.videoPath = "file:///cache/videoTmp_71.mp4";

      await adv(env, () => env.MultiCamCameraRecord.stopRecording()
        .then((res) => { env.svc.onRecordingStopped(res); }));

      const p = lastPub(env, "stop");
      eq(p.masters, 1, "la fin du Take atteint le Master");
      eq(p.env.segmentIndex, 0, "plus aucun segment en cours");
      eq(p.env.recording, false);
      eq(p.session.sessionId, SID);
    });

    /* ---------- F · isolation ---------- */

    it("F. une Capture de S1 ne route JAMAIS vers le Master de S2", async () => {
      const env = await rec(boot(SID, {
        sessions: { [SID]: sessionWithTake(), [SID2]: session2() },
        /* DEV-5 est connecté et Master — mais de S2 seulement. */
        routePeers: netFor(SID, {
          [FOREIGN_MASTER]: { connected: true, sessions: { [SID2]: {} } }
        })
      }));

      const p = lastPub(env, "rec_started");
      eq(p.masters, 1, "seul le Master de S1 est visé, pas le Master de S2");
      eq(p.session.sessionId, SID, "l'identité publiée est S1");
      for (const q of reqs(env, "camera_state")) {
        eq(q.session.sessionId, SID, "aucune publication sous une autre session");
      }
    });

    it("F2. changer de session ne réutilise pas l'identité précédente", async () => {
      const env = await rec(boot(SID2, {
        planSid: SID2,
        sessions: { [SID]: sessionWithTake(), [SID2]: session2() },
        routePeers: netFor(SID, {
          [FOREIGN_MASTER]: { connected: true, sessions: { [SID2]: {} } }
        })
      }));

      const p = lastPub(env, "rec_started");
      eq(p.session.sessionId, SID2, "l'identité suit le plan START courant, pas un cache d'avant");
      eq(p.masters, 1, "DEV-5, Master de S2, reçoit le paquet ; le Master de S1 ne le peut pas");
    });

    /* ---------- G · le défaut lui-même ---------- */

    it("G. `CAMERA_STATE_TX … masters=0` n'est plus produit au segment 1", async () => {
      const env = await rec(boot(SID));

      const lignes = env.logs.filter((l) => l.indexOf("CAMERA_STATE_TX") === 0);
      yes(lignes.length, "le routage est journalisé");
      eq(lignes[0].indexOf("sessionId=" + SID) > 0, true, lignes[0]);
      eq(lignes[0].indexOf("activeCamera=REAR") > 0, true, lignes[0]);
      eq(lignes[0].indexOf("masters=1") > 0, true,
        "le segment 1 part chez un Master — c'est la ligne qui gelait le défaut : " + lignes[0]);
      for (const l of lignes) {
        no(l.indexOf("masters=0") > 0, "aucun Masters=0 alors qu'un Master existe : " + l);
      }
    });

    /* ---------- H · pas de session, pas de fausse identité ---------- */

    it("H. sans session lisible, l'état n'est PAS publié sous une session inventée", async () => {
      const env = await rec(boot(SID, { sessions: {} }));

      eq(reqs(env, "camera_state").length, 0,
        "aucun paquet : une session sans `masters` ne route que vers personne");
      const ligne = env.logs.filter((l) => l.indexOf("CAMERA_STATE_NOT_PUBLISHED") === 0);
      yes(ligne.length, "et le refus est journalisé");
      eq(ligne[0].indexOf("cause=session_identity_unknown") > 0, true, ligne[0]);
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