/* MultiCam — J09-D4 : resynchronisation des ÉTATS métier après reconnexion
 * (Master → Capture). D3 a restauré le TRANSPORT (re-dial automatique après
 * coupure réseau). D4 constate que le transport à lui seul ne fait pas revenir
 * les ÉTATS : le socket retrouvé reste anonyme côté Capture (`peerDid` reste
 * `null`), la présence reste vide (`connectedPeers` désert → urgence figée) et
 * aucun `camera_state` ne repart — le Master garde l'état périmé qu'il avait au
 * moment de la coupure (enregistré/tournant alors que la Capture est stoppée).
 *
 * REPRODUCTION CAMPAGNE (logs J09-FINAL) :
 *   A (Master)  : `WS_RESYNC_SESSIONS … sessions=1` → le socket est re-dialé et
 *                 ouvert, puis PLUS RIEN. Aucun message métier n'est échangé,
 *                 et C ne republie jamais `camera_state`.
 *   C (Capture) : le 2e `WS_CONN_OPEN` n'est jamais suivi de `PEER_CONNECTED` ;
 *                 `connectedPeers(sid)` est vide pendant toute la coupure →
 *                 `showEmergencyStop` (start-model) reste rouge, les previews ne
 *                 partent plus, et la régie garde `recording:true / segmentIndex:1`
 *                 alors que la Capture est à `STOPPED`.
 *
 * CORRECTIF (fix j09, primitives existantes uniquement — aucune refonte) :
 *   1. `handleServerText` : `wasUnknown` est calculé AVANT l'écrasement de
 *      `peerDid` (l'ancien code affectait `entry.peerDid` puis testait
 *      `!entry.peerDid`, qui valait donc TOUJOURS faux → `PEER_CONNECTED`
 *      n'était jamais émis côté serveur, précisément là où passe la
 *      reconnexion). À la première identification sur une connexion serveur,
 *      on émet `PEER_CONNECTED` et on prévient le pont caméra via
 *      `onPeerIdentified`.
 *   2. `reSyncSessionsFor` : le resync historique ne s'adresse qu'aux MASTERS.
 *      Dans le sens Master→Capture, l'endpoint re-dialé porte un MEMBRE — on lui
 *      envoie donc un `sync_please` dirigé (`SYNC_PLEASE_SENT … note=redialed_member`),
 *      sinon le pair restauré ne parle jamais et le socket reste anonyme.
 *   3. camera-switch-service : `onPeerIdentified` relit la session du STORE
 *      (jamais du cache — le cache garde l'état du Take, et une session fermée
 *      pendant la coupure GAGNE) puis republie un SNAPSHOT d'état idempotent
 *      (`broadcastState("resync_peer")` : aucun compteur, aucune exécution,
 *      anti-replay conservé).
 *
 * CADRE DE LA CAMPAGNE : le même scénario est exposé en deux tests **A**
 * (transport — vert avant ET après le correctif) et **B** (business — rouge
 * AVANT le correctif, vert après). Un correctif qui casserait le transport
 * ferait rouge A : c'est la répétabilité de la reproduction.
 *
 * MODÈLE RÉEL (rien de fabriqué) :
 *   - session créée par `createSession()`, membre ajouté par `addMember()` avec
 *     `endpoint: device.wsEndpoint` (trajet écran 03) ;
 *   - les DEUX côtés exécutent les vrais modules : session-model, session-store,
 *     session-ws, camera-switch-model, camera-state-inbox, camera-switch-service ;
 *   - côté Capture : REAL `native/capture-capabilities.js` (inventaire caméras au
 *     REC), REAL store/session (le flux d'invitation donne la session à C — rien
 *     n'est injecté à la main) ;
 *   - Adaptateurs matériels simulés (le driver USB/CameraPreview est déjà une
 *     fausse `CameraPreview` dans le harness) :
 *       · `MultiCamCameraRecord` = double minimal lector de l'état natif
 *         (`view()/isRecording()/getCameraState()`). Le cycle de vie du recorder
 *         est couvert par les suites J09 ; D4 teste le PROTOCOLE et la
 *         reconvergence d'états, pas l'ouverture native.
 *       · `MultiCamStartService` = fake piloté par `plan` (sid/phase/take) — le
 *         vrai start-model/start-service ne sont pas chargés sur C dans D4
 *         (l'urgence `showEmergencyStop` est couverte par la suite start-model ;
 *         D4 s'arrête au niveau transport-of-truth `connectedPeers`, qui est
 *         EXACTEMENT la donnée que start-model relit à chaque tick REC).
 *   - Seuls le WebSocket client (A) et le wsserver (C) sont un pont duplex
 *     piloté : `openNow()/dropNow()` reproduisent l'ouverture/la coupure
 *     physique, et les hooks serveur de C sont les hooks réels de session-ws.
 *
 * Horloges : l'horloge de C n'est JAMAIS avancée au-delà du rattrapage de la
 * sonde native (le heartbeat de C ne part donc jamais et le scénario reste
 * déterministe avant ET après correctif) ; seul A est avancé de 1200 ms pour
 * laisser partir le retry 500 ms, comme en D3.
 */

"use strict";

function register(h) {
  const { describe, it, createEnv, loadAll, flush } = h;

  const A_DID = "aaaaaaaa-0000-0000-0000-00000000000a";   /* Master */
  const C_DID = "bbbbbbbb-0000-0000-0000-00000000000b";   /* Capture */
  const EP_C1 = "10.0.0.7:45102";                         /* endpoint découvert puis coupé */

  /* ---------- pont duplex A → C (vrai session-ws des deux côtés) ---------- */

  /* Le « serveur WebSocket » que session-ws démarre côté C : enregistre les
   * hooks réels pendant `start`, et route `send(conn, …)` vers le socket A
   * opposé (le conn que le faux WebSocket A a donné à `onOpen`). */
  function makeWsServer() {
    let hooks = null;
    const byUuid = {};
    return {
      sentWire: [],
      start(port, opts, ok) { hooks = opts; if (ok) ok("10.0.0.2", port); },
      stop() {},
      /* session-ws garde son PROPRE objet (uuid/peerDid/…), pas l'objet conn du
       * plugin : le routage retour passe donc par la seule clé stable, l'uuid. */
      openLink(conn, socket) { byUuid[conn.uuid] = socket; },
      send(entry, payload) {
        const env = JSON.parse(payload);
        this.sentWire.push(env);
        const a = entry && byUuid[entry.uuid];
        if (!a || typeof a.onmessage !== "function") return false;
        a.onmessage({ data: payload });
        return true;
      },
      hooks() { return hooks; }
    };
  }

  function makeBridgeWs(eA, srvC) {
    let seq = 0;
    function WS(url) {
      this.url = url;
      this.readyState = 0;              /* CONNECTING */
      this.sent = [];
      this.closedByUs = false;
      this._conn = null;
      eA.wsSockets.push(this);
    }
    WS.OPEN = 1; WS.CONNECTING = 0; WS.CLOSING = 2; WS.CLOSED = 3;
    WS.prototype.send = function (p) {
      this.sent.push(JSON.parse(p));
      const h = srvC.hooks();
      if (h.onMessage && this._conn) h.onMessage(this._conn, p);
      else eA.logs.push("WS_WIRE_DROP url=" + this.url + " kind=" + JSON.parse(p).kind);
    };
    WS.prototype.close = function () {
      if (this.readyState === 3) return;
      this.closedByUs = true;
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1000, reason: "" });
      const h = srvC.hooks();
      if (h.onClose && this._conn) h.onClose(this._conn, 1000, "", true);
    };
    WS.prototype.openNow = function () {
      if (this.readyState !== 0) return;
      this._conn = {
        uuid: "d4-" + (++seq),
        remoteAddr: "10.0.0.1:" + (40000 + seq),
        resource: this.url.replace(/^ws:\/\/[^/]*/, ""),
        __aSocket: this
      };
      this.readyState = 1;
      srvC.openLink(this._conn, this);
      /* Le serveur C accepte AVANT le handshake client (comme le vrai plugin :
       * `connectTo` résout ensuite et l'invitation part sur un conn déjà lié). */
      const h = srvC.hooks();
      if (h.onOpen) h.onOpen(this._conn);
      if (this.onopen) this.onopen();
    };
    WS.prototype.dropNow = function () {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.onerror) this.onerror({});
      if (this.onclose) this.onclose({ code: 1006, reason: "" });
      const h = srvC.hooks();
      if (h.onClose && this._conn) h.onClose(this._conn, 1006, "", false);
    };
    return WS;
  }

  /* ---------- environnements ---------- */

  function makeEnv(did, name, ip) {
    const e = createEnv({ fakeClock: true, skills: ["capture", "controller"] });
    e.wsSockets = [];
    e.MultiCamConfig = {
      get() { return { deviceId: did, deviceName: name }; },
      load() { return Promise.resolve({ deviceId: did }); }
    };
    e.MultiCamNative = { ipv4: () => Promise.resolve(ip) };
    loadAll(e, ["state/session-model.js", "state/session-store.js", "net/session-ws.js"]);
    e.ws = e.MultiCamSessionWs;
    e.ws.bind({ deviceId: did, deviceName: name });
    e.store = e.MultiCamSessionStore;
    return e;
  }

  /* Pile caméra RÉELLE (modèle + inbox + service) sur un env : côté Capture
   * elle REC et PUBLIE, côté Master elle s'abonne (le bridge `onCameraState`
   * alimente l'inbox). Le recorder et le plugin START sont des adaptateurs
   * simulés (voir l'en-tête). */
  function mountCam(e, plan) {
    loadAll(e, [
      "native/capture-capabilities.js",
      "state/camera-switch-model.js",
      "state/camera-state-inbox.js",
      "state/camera-switch-service.js"
    ]);
    /* Double du recorder : la seule lecture fiable de l'état natif, jamais une
     * écriture. Le seed et le stop pilotent ce knob, comme le ferait le natif. */
    const rec = { on: false, facing: "back" };
    e.CAM = rec;
    e.MultiCamCameraRecord = {
      isRecording() { return rec.on; },
      view() { return { activeFacing: rec.facing, recording: rec.on }; },
      getCameraState() {
        return Promise.resolve({
          available: true, facing: rec.facing, cameraId: 0, defaultCameraId: 0,
          numberOfCameras: 2, hasCamera: true,
          recording: rec.on,
          recordFilePath: rec.on ? "file:///storage/emulated/0/Movies/take.mp4" : ""
        });
      }
    };
    e.MultiCamStartService = {
      view() {
        return {
          active: true, phase: plan.phase, sid: plan.sid, takeNumber: plan.take,
          isMaster: false, isCapture: true, rev: 1
        };
      },
      phase() { return plan.phase; },
      selfDid() { return e.MultiCamConfig.get().deviceId; }
    };
    e.cordova = {
      exec(ok, ko, service, action) { if (ko) ko("action_non_supportee:" + action); }
    };
    e.svc = e.MultiCamCameraSwitchService;
    e.inbox = e.MultiCamCameraStateInbox;
    e.svc.bind();
    return rec;
  }

  /* ---------- helpers ---------- */

  function hasLog(e, re) { return e.logs.some((l) => re.test(l)); }
  function countLog(e, re) { return e.logs.filter((l) => re.test(l)).length; }
  function sliceSince(e, from, re) { return e.logs.slice(from || 0).filter((l) => re.test(l)); }
  let env = null;   /* pour le message d'échec */
  function eq(actual, want, msg) {
    if (actual !== want) {
      throw new Error((msg ? msg + " — " : "") + "attendu " + JSON.stringify(want)
        + ", obtenu " + JSON.stringify(actual) + "\n--- logs ---\n" + (env ? env.logText() : ""));
    }
  }
  function yes(v, msg) { eq(!!v, true, msg); }
  function no(v, msg) { eq(!!v, false, msg); }

  /* Scénario de COUPURE complet, identique AVANT et APRÈS correctif :
   *  1. session créée côté A, membre C découvert, dial, invitation acceptée par C
   *     (C obtient la VRAIE session + A en Master de transport, rien n'est
   *     injecté) ;
   *  2. C attaché au plan START (onStartView AVANT le dial, comme sur le terrain) ;
   *  3. seed du segment 1 par le vrai flux J09 : recorder marche + phase REC →
   *     `onRecordingStarted()` publie le `camera_state` vers A ;
   *  4. coupure physique de l'UNIQUE connexion ;
   *  5. C stoppe pendant l'outage (`onRecordingStopped(res ok)` → segment 1 clos,
   *     broadcast non routé) → A garde l'état périmé.
   * Horloge : seul A avance (retry 1200 ms). C n'avance qu'une fois (rattrapage
   * de la sonde native, hors du heartbeat) : son heartbeat 2000 ms ne tire donc
   * jamais — le scénario est déterministe dans les deux cas, comme en D3. */
  async function bootAndCut() {
    /* --- A : Master (transport + pile caméra en réception) --- */
    const eA = makeEnv(A_DID, "Regie", "10.0.0.1");
    env = eA;
    const planA = { sid: "", take: 1, phase: "IDLE" };
    mountCam(eA, planA);
    const srvC = makeWsServer();

    /* --- C : Capture (serveur de transport réel + pile caméra en publication) --- */
    const eC = makeEnv(C_DID, "Cam 07", "10.0.0.2");
    env = eC;
    const planC = { sid: "", take: 1, phase: "IDLE" };
    mountCam(eC, planC);
    /* C possède le wsserver réel (startServer) ; A possède le WebSocket du pont. */
    eC.cordova = {
      plugins: { wsserver: srvC },
      exec(eO, eK, srv, act) { if (eK) eK("action_non_supportee:" + act); }
    };
    eA.WebSocket = makeBridgeWs(eA, srvC);

    await flush();
    await eC.ws.ensureServer();          /* C écoute le vrai session-ws */
    await flush();

    /* Session + membre découvert (trajet écran 03 : endpoint transport fourni). */
    const s0 = await eA.ws.createSession("Tournage", {});
    const sid = s0.sessionId;
    planA.sid = sid; planC.sid = sid;
    await eA.ws.addMember(s0, {
      deviceId: C_DID, deviceName: "Cam 07", enabledSkills: ["capture"], endpoint: EP_C1
    }, ["capture"]);
    await flush();

    /* Attachement de C au Take AVANT le dial : `primeSession` échoue (la session
     * n'existe pas encore chez C) → résolu paresseusement dès que le flux
     * d'invitation a donné la session à C (cf. flux d'invitation réel). */
    eC.svc.onStartView({ active: true, sid, takeNumber: 1 });
    await flush();
    await eC.clock.advance(40);          /* sonde de disponibilité native */
    await flush();

    /* Dial → invitation acceptée → A identifie C (conn1) et C identifie A. */
    eq(eA.wsSockets[0].url, "ws://" + EP_C1, "le dial vise l'endpoint découvert");
    eA.wsSockets[0].openNow();
    await flush(12);

    const cHasSession = await eC.store.get(sid);
    yes(cHasSession && cHasSession.state === "open",
      "le flux d'invitation a donné la VRAIE session à C (aucune injection manuelle)");
    eq((cHasSession.masters || []).length, 1, "A est Master côté C après l'invitation");
    eq(cHasSession.masters[0].deviceId, A_DID, "et c'est bien A le Master transporté");

    /* Seed J09 réel : caméra confirmée + enregistrement + segment 1 publié vers A. */
    await eC.svc.syncActiveCamera("d4_seed");
    await flush();
    eC.CAM.on = true;
    planC.phase = "REC";
    eC.svc.onRecordingStarted();
    await flush(12);

    const seeded = eA.inbox.forDevice(C_DID, sid);
    yes(seeded, "le camera_state rec_started a atteint le Master");
    yes(seeded.recording === true, "état seed au Master : recording=true");
    eq(seeded.segmentIndex, 1, "état seed au Master : segmentIndex=1");
    eq(seeded.activeCamera, "REAR", "état seed au Master : activeCamera=REAR (relu natif)");

    /* Coupure physique de l'UNIQUE connexion. */
    eA.wsSockets[0].dropNow();
    await flush();

    /* STOP pendant l'outage : segment 1 clos, mais le broadcast n'est routé vers
     * personne (aucun Master identifié sur une connexion serveur) → le Master
     * garde son état périmé. */
    const cutAt = eC.logs.length;
    eC.CAM.on = false;
    planC.phase = "STOPPED";
    await eC.svc.onRecordingStopped({
      detail: "stopRecordVideo_ok",
      path: "file:///storage/emulated/0/Movies/take1.mp4",
      atMs: eC.clock.now()
    });
    await flush();

    const stale = eA.inbox.forDevice(C_DID, sid);
    yes(stale && stale.recording === true,
      "défaut campagne : A garde recording=true alors que C est STOPPED");
    eq(stale.segmentIndex, 1, "défaut campagne : A garde segmentIndex=1 après le STOP");
    eq(eC.ws.connectedPeers(sid)[A_DID] || null, null,
      "défaut campagne : plus aucun Master identifié côté C (urgence figée)");

    return { eA, eC, srvC, sid, planC, cutAt };
  }

  /* Reconnexion physique (D3) : le retry part après 500 ms, le socket est
   * restauré et déclenche `reSyncSessionsFor` tout seul. Rien d'autre n'est
   * piloté par le test. */
  async function reconnect(eA) {
    await eA.clock.advance(1200);         /* step 0 du retry (500 ms) */
    await flush();
    const again = eA.wsSockets[eA.wsSockets.length - 1];
    eq(again.url, "ws://" + EP_C1, "le retry vise le même endpoint connu");
    again.openNow();
    await flush(12);
    return again;
  }

  describe("J09-D4 — resynchronisation des états après reconnexion (Master → Capture)", () => {
    it("D4.1/A · transport : le socket est restauré et re-synchronise — sans action UI", async () => {
      const { eA, eC, sid } = await bootAndCut();
      env = eA;
      const again = await reconnect(eA);

      /* Transport (D3) : la connexion physique revient, seule et sans geste. */
      eq(eA.wsSockets.length, 2, "un seul socket de reconnexion");
      eq(again.readyState, 1, "le socket restauré est OPEN");
      yes(hasLog(eA, /WS_RETRY_SCHEDULE endpoint=10\.0\.0\.7:45102 .*sessions=1/),
        "le retry a été armé vers le membre connu");
      yes(hasLog(eA, /WS_RESYNC_SESSIONS endpoint=10\.0\.0\.7:45102 sessions=1/),
        "l'ouverture déclenche le resync transport de la session");
      eq(countLog(eC, /WS_CONN_OPEN uuid=d4-2/), 1,
        "C a accepté la nouvelle connexion");
      /* Ici, le socket est restauré... mais reste-t-il IDENTIFIÉ ? La réponse
       * (présence + états) est l'objet du test B ci-dessous. */
      eq(eA.wsSockets.filter((s) => s.readyState === 1).length, 1,
        "une seule connexion vivante après reconnexion");
    });

    it("D4.2/B · business : présence reconstruite et camera_state republié SANS action UI", async () => {
      const { eA, eC, srvC, sid, cutAt } = await bootAndCut();
      env = eA;
      await reconnect(eA);

      /* Présence : C re-identifie A sur la connexion restaurée (défaut D3 →
       * `peerDid` reste null) et A re-identifie C dès la réponse sync. */
      yes(eC.ws.connectedPeers(sid)[A_DID],
        "C a re-identifié le Master sur la connexion restaurée (présence)");
      yes(eA.ws.connectedPeers(sid)[C_DID],
        "A a re-identifié la Capture (présence, urgence levée côté start-model)");
      yes(hasLog(eC, /PEER_CONNECTED did=aaaaaaaa-0000-0000-0000-00000000000a via=ws_server/),
        "PEER_CONNECTED émis côté serveur à la première identification (wasUnknown correct)");

      /* Direction Master→Capture : le resync ciblé Membre est parti (D3 ne
       * dialait que les Masters, jamais les membres). */
      yes(hasLog(eA, /SYNC_PLEASE_SENT sessionId=.* to=bbbbbbbb-0000-0000-0000-00000000000b endpoint=10\.0\.0\.7:45102 note=redialed_member/),
        "le sync_please ciblé membre est parti (directions Master→Capture)");

      /* État métier : le Master reçoit un SNAPSHOT d'état et converge vers
       * STOPPED — sans aucun geste UI, sans replay de commandes. */
      yes(hasLog(eC, /CAMERA_STATE_RESYNC sessionId=.* reason=peer_identified/),
        "le pont caméra a republié l'état à l'identification du pair");
      yes(sliceSince(eC, cutAt, /CAMERA_STATE_TX .*masters=1/).length === 1,
        "le snapshot a trouvé un Master joignable et lui a été routé (masters=1), après la coupure");
      const st = eA.inbox.forDevice(C_DID, sid);
      yes(st, "le Master a reçu un camera_state après reconnexion");
      yes(st.recording === false, "convergence : recording=false (fin de l'enregistrement)");
      eq(st.segmentIndex, 0, "convergence : segmentIndex=0 (aucun segment en cours)");
      eq(st.segmentState, "", "convergence : segmentState vide");
      eq(st.phase, "STOPPED", "convergence : phase STOPPED relayée, reconvergence du plan");
      eq(st.switchCount, 0, "anti-replay : pas de bascule ré-exécutée (switchCount inchangé)");
      yes((st.updatedAtMs || 0) > 0, "la reconvergence a mis à jour l'instant de réception");

      no(srvC.sentWire.slice(cutAt ? 0 : 0).some((m) => m.kind === "camera_switch_request"),
        "aucune commande de bascule n'est rejouée pendant la reconvergence");
      no(hasLog(eC, /runCommand|CMDS/), "aucune exécution de commande inventée à la reconnexion");
    });

    it("D4.5 · pas de double publication, de ré-ouverture de segment ni de boucle de reconnexion", async () => {
      const { eA, eC, sid } = await bootAndCut();
      env = eA;
      await reconnect(eA);

      /* Un seul segment a été ouvert pendant tout le scénario. */
      eq(countLog(eC, /CAMERA_SEGMENT_OPEN (?!_SKIP)/), 1,
        "le segment 1 n'est ouvert qu'une fois (la reconnexion n'ouvre rien)");

      /* Aucune ré-exécution : l'inbox du Master porte l'état de la Capture,
       * pas un recompte inventé. */
      const st = eA.inbox.forDevice(C_DID, sid);
      yes(st && st.recording === false, "pas de résurrection de l'enregistrement");

      /* La session A est intacte : mêmes sid/PIN, un seul Master, un seul membre. */
      const after = await eA.store.get(sid);
      eq(after.sessionId, sid, "même sid (pas de session fabriquée)");
      eq(after.masters.length, 1, "pas de Master dupliqué");
      eq(after.members.length, 1, "pas de membre dupliqué");
      eq(after.state, "open", "la session reste ouverte");

      /* La reconnexion réussie ne laisse aucun retry ni aucun dial résiduel. */
      await eA.clock.advance(60000);
      await flush();
      eq(eA.wsSockets.length, 2, "une seule reconnexion, aucun socket supplémentaire");
      eq(countLog(eA, /WS_RESYNC_SESSIONS endpoint=10\.0\.0\.7:45102 sessions=1/), 1,
        "le resync ne repart pas en boucle sur un socket vivant");
      eq(eA.clock.pending(), 0, "aucun timer résiduel côté Master (pas de boucle)");
    });

    it("D4.6 · plusieurs coupures consécutives : reconvergence à chaque fois, sans accumulation", async () => {
      const { eA, eC, sid } = await bootAndCut();
      env = eA;

      async function assertConverged(turn) {
        yes(eA.ws.connectedPeers(sid)[C_DID], "présence C reconstruite (cycle " + turn + ")");
        yes(eC.ws.connectedPeers(sid)[A_DID], "présence A reconstruite (cycle " + turn + ")");
        const st = eA.inbox.forDevice(C_DID, sid);
        yes(st && st.recording === false, "inbox convergé (cycle " + turn + ")");
        eq(st.segmentIndex, 0, "segmentIndex=0 (cycle " + turn + ")");
      }

      /* Cycle 1 : reconnexion + convergence. */
      let again = await reconnect(eA);
      eq(again.readyState, 1, "cycle 1 : socket OPEN");
      await assertConverged(1);

      /* Cycle 2 : nouvelle coupure (le socket vivant tombe), nouveau retry. */
      eA.wsSockets[1].dropNow();
      await flush();
      await eA.clock.advance(1200);
      await flush();
      again = eA.wsSockets[2];
      again.openNow();
      await flush(12);
      eq(again.readyState, 1, "cycle 2 : socket OPEN");
      await assertConverged(2);

      /* Après stabilisation : deux re-dials au total, aucune accumulation ni
       * resync fantôme. */
      await eA.clock.advance(60000);
      await flush();
      eq(eA.wsSockets.length, 3, "socket initial + 2 re-dials, rien de plus");
      eq(countLog(eA, /WS_RESYNC_SESSIONS endpoint=10\.0\.0\.7:45102 sessions=1/), 2,
        "un resync par reconnexion réelle, jamais plus");
      eq(eA.clock.pending(), 0, "aucun timer résiduel après deux cycles");
    });

    it("D4.7 · closed wins : une session fermée pendant la coupure ne republie ni ne ressuscite", async () => {
      const { eA, eC, sid, cutAt } = await bootAndCut();
      env = eA;

      /* C ferme SA session pendant l'outage (closeSession sans restriction de
       * rôle : le transport l'autorise côté serveur). Le Master, lui, croit
       * toujours la session ouverte → il re-diale à la coupure. */
      await eC.ws.closeSession(await eC.store.get(sid));
      await flush();

      await reconnect(eA);

      /* C identifie le Master, mais la session est fermée : closed wins — le
       * snapshot n'est PAS republié, et C le dit explicitement. */
      yes(hasLog(eC, /CAMERA_STATE_RESYNC_SKIP .*reason=session_closed/),
        "le pont caméra relit le STORE (pas le cache) et saute la republication sous session fermée");
      no(hasLog(eC, /CAMERA_STATE_RESYNC sessionId=.* reason=peer_identified/),
        "aucun republish d'état sous une session fermée");
      eq(sliceSince(eC, cutAt, /CAMERA_STATE_TX .*masters=[1-9]/).length, 0,
        "aucun camera_state routé n'est émis après la coupure pendant closed-wins (seul le broadcast STOP à masters=0 est légitime)");

      /* Le Master fusionne l'état fermé de son côté (sync de retour). */
      const closed = await eA.store.get(sid);
      eq(closed.state, "closed", "le Master a appris la fermeture via le sync de retour");

      /* L'inbox du Master conserve l'état périmé d'AVANT la coupure (jamais de
       * message inventé pour une session fermée). */
      const still = eA.inbox.forDevice(C_DID, sid);
      yes(still && still.recording === true, "closed wins : rien n'est republié, l'inbox reste figée à l'avant-coupure");
      eq(still.segmentIndex, 1, "closed wins : état antérieur préservé");

      /* Aucune boucle de résurrection : la session fermée n'est plus référencée
       * par openSessionsFor → aucun re-dial, aucun resync fantôme. */
      await eA.clock.advance(60000);
      await flush();
      eq(eA.wsSockets.length, 2, "socket initial + le re-dial unique (aucune résurrection)");
      eq(countLog(eA, /WS_RESYNC_SESSIONS endpoint=10\.0\.0\.7:45102 sessions=1/), 1,
        "un seul resync, déclenché par le seul re-dial ; la session fermée ne renvoie plus rien");
      eq(eA.clock.pending(), 0, "aucun timer résiduel après closed wins");
    });
  });
}

module.exports = { register };