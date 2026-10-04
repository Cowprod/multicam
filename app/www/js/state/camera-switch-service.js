/* MultiCam — J09-07 : SERVICE d'orchestration du changement de caméra.
 *
 * Graisse entre le modèle pur (`state/camera-switch-model.js`) et les faits
 * matériels (`native/camera-record.js`), le transport (`net/session-ws.js`) et
 * les écrans. Répartition STRICTE des responsabilités :
 *
 *   - le MODÈLE décide : quelles caméras existent, si une commande est
 *     recevable, à quoi ressemble l'état après une transition ;
 *   - le WRAPPER natif décide : ce que la caméra et le MediaRecorder font
 *     réellement, et rend un fait (`getCameraState`) ;
 *   - CE service fait le reste : il lit la session, résout les rôles, suspend
 *     l'échantillonnage PixelCopy pendant la bascule, demande la SEGMENTATION,
 *     confirme, journalise et propage l'état confirmé à tous les Masters.
 *
 * ---------- §35.2 : qui peut agir, et sur qui ----------
 *
 *   - tous les Masters ont la MÊME autorité : un Master simple comme un
 *     Master+Capture envoient la même commande et obtiennent le même traitement ;
 *   - seule une CIBLE qui est Capture du Take courant peut changer de caméra ;
 *   - une Capture qui n'est pas Master ne s'auto-pilote pas : elle reçoit la
 *     commande par le WS et emprunte EXACTEMENT le même chemin de validation.
 *
 * ---------- §35.3 : PixelCopy ne doit jamais mentir ----------
 *
 * Pendant une bascule, la PreviewSurface est reconfigurée. Une image PixelCopy
 * capturée avant la bascule mais affichée après montrerait l'ANCIENNE caméra sous
 * une nouvelle étiquette. On suspend donc l'échantillonneur AVANT toute
 * opération physique et on ne le reprend qu'APRÈS la confirmation native et le
 * redémarrage du segment — jamais avant.
 *
 * ---------- J09-08b1 : l'identité des segments ----------
 *
 * Ce module est le SEUL propriétaire de l'indexation d'un Take. Le segment
 * s'ouvre à l'ouverture du recorder (top), se clôture à la bascule ou au STOP,
 * et porte toujours son index. Le champ `segmentIndex` publié dans les ACK et
 * dans `camera_state` désigne le segment EN COURS : il ne compte plus les
 * segments fermés.
 */

(function (global) {
  "use strict";

  var listeners = [];
  var bridgeHooked = false;
  var lastSession = null;
  var lastTake = null;
  /* Promesses des Masters en attente d'ACK, indexées par commandId. */
  var PENDING = {};

  function model() { return global.MultiCamCameraSwitchModel || null; }
  function camera() { return global.MultiCamCameraRecord || null; }
  function sampler() { return global.MultiCamPreviewSampler || null; }
  function startService() { return global.MultiCamStartService || null; }
  function caps() { return global.MultiCamCaptureCapabilities || null; }
  function ws() { return global.MultiCamSessionWs; }
  function store() { return global.MultiCamSessionStore; }

  function log(l) { console.log(l); }
  function nowMs() { return Date.now(); }

  var S = { state: null, bound: false };

  function selfDid() {
    var ss = startService();
    if (ss && typeof ss.selfDid === "function") {
      var d = ss.selfDid();
      if (d) return d;
    }
    var c = global.MultiCamConfig;
    var v = (c && typeof c.get === "function") ? c.get() : c;
    return (v && v.deviceId) || "";
  }

  function freshState() {
    var m = model();
    if (m) return m.createState(selfDid());
    /* Le modèle est absent : on ne fabrique pas un état parallel qui pourrait
     * diverger du sien. La vue exposera alors « aucune information ». */
    return null;
  }

  function st() {
    if (!S.state) S.state = freshState();
    return S.state;
  }

  function set(next) {
    S.state = next;
    listeners.slice().forEach(function (fn) { try { fn(); } catch (e) { } });
    return next;
  }

  /* ---------- rôles (source de vérité : la session) ---------- */

  function isMasterOf(ses, did) {
    if (!ses || !did) return false;
    return (ses.masters || []).some(function (m) { return m.deviceId === did; });
  }

  function isCaptureOf(take, did) {
    if (!take || !did) return false;
    return (take.captures || []).indexOf(did) >= 0;
  }

  function lastTakeOf(ses) {
    if (!ses || !Array.isArray(ses.takes) || !ses.takes.length) return null;
    return ses.takes[ses.takes.length - 1];
  }

  function connected(did, sid) {
    var w = ws();
    if (!w || typeof w.connectedPeers !== "function") return true;   /* fail-open historique */
    if (did === selfDid()) return true;
    var peers = w.connectedPeers(sid || null);
    return !!(peers && peers[did]);
  }

  function recordingNow() {
    var cam = camera();
    return !!(cam && typeof cam.isRecording === "function" && cam.isRecording());
  }

  /* ---------- chargement de session ---------- */

  /* Relit le store à chaque exécution : un cache de session est la cause
   * classique d'un refusPapers incohérent (rôles périmés), et une bascule de
   * caméra n'est pas une opération à 1 ms près. */
  function loadSession(sid) {
    if (!sid) return Promise.resolve(null);
    if (!store() || typeof store().get !== "function") return Promise.resolve(null);
    return Promise.resolve(store().get(sid)).then(function (s) { return s || null; })
      .catch(function () { return null; });
  }

  /* Le plan START courant est la seule source du (sessionId, takeNumber) locals :
   * on ne le devine pas depuis le store, qui peut contenir plusieurs Takes. */
  function currentPlan() {
    var ss = startService();
    if (!ss || typeof ss.view !== "function") return null;
    try {
      var v = ss.view();
      if (!v || !v.active) return null;
      return { sid: v.sid || "", takeNumber: (v.takeNumber == null ? null : v.takeNumber) };
    } catch (e) { return null; }
  }

  /* Résout la session + le Take courant en une fois. */
  function resolveCurrent() {
    var plan = currentPlan();
    if (!plan || !plan.sid) {
      return Promise.resolve({ session: lastSession, take: lastTake, plan: plan });
    }
    return loadSession(plan.sid).then(function (ses) {
      var take = lastTakeOf(ses);
      if (ses) { lastSession = ses; lastTake = take; }
      return { session: ses, take: take, plan: plan };
    });
  }

  /* ---------- inventaire des caméras ---------- */

  /* On lit la FORME BRUTE de `getCaptureCapabilities` : la normalisation J06 ne
   * garde que des résolutions par facing, et ferait passer une caméra sans
   * profil 720P/1080P/2160P pour INEXISTANTE. */
  function refreshAvailability() {
    var m = model();
    var c = caps();
    if (!m || !st()) return Promise.resolve([]);
    if (!c || typeof c.probeRaw !== "function") {
      log("CAMERA_AVAILABILITY_UNAVAILABLE reason=no_probe_raw");
      return Promise.resolve(st().availableCameras.slice());
    }
    return Promise.resolve(c.probeRaw()).then(function (r) {
      var probe = m.availableFromRaw(r);
      if (!probe.known) {
        /* Inventaire inconnu : on NE REMPLACE PAS un inventaire déjà connu — une
         * erreur transitoire ne doit pas rendre le device inutilisable. */
        log("CAMERA_AVAILABILITY_UNKNOWN reason=capabilities_unreadable"
          + " kept=" + st().availableCameras.length);
        return st().availableCameras.slice();
      }
      set(m.applyAvailability(st(), probe));
      log("CAMERA_AVAILABILITY_OK deviceId=" + selfDid()
        + " cameras=" + probe.cameras.join(","));
      return probe.cameras;
    }).catch(function (err) {
      log("CAMERA_AVAILABILITY_ERROR reason=" + String((err && err.message) || err));
      return st().availableCameras.slice();
    });
  }

  /* Adopte un état natif comme `activeCamera`. SEUL endroit, hors confirmation
   * de bascule, où cette valeur s'écrit : au boot et à chaque reprise, pour que
   * la régie n'affiche pas « caméra inconnue » alors que la caméra est ouverte
   * depuis le premier plan. */
  function syncActiveCamera(reason) {
    var m = model();
    var cam = camera();
    if (!m || !st() || !cam || typeof cam.getCameraState !== "function") return Promise.resolve(null);
    return Promise.resolve(cam.getCameraState()).then(function (nat) {
      if (!nat || !nat.available || !nat.facing) return null;
      var before = st().activeCamera;
      set(m.applyConfirmed(st(), nat.facing, nowMs(), true));
      if (before !== nat.facing) {
        log("CAMERA_ACTIVE_SYNC reason=" + (reason || "—") + " from=" + (before || "—")
          + " to=" + nat.facing + " cameraId=" + (nat.cameraId == null ? "—" : nat.cameraId));
      }
      return nat;
    });
  }

  /* ---------- suspension / reprise de l'échantillonnage ---------- */

  function suspendSampling(reason) {
    var s = sampler();
    if (!s || typeof s.stop !== "function") return;
    s.stop("camera_switch:" + (reason || "—"));
    log("CAMERA_SAMPLER_SUSPEND reason=" + (reason || "—")
      + " running=" + ((typeof s.view === "function" && s.view().running) ? 1 : 0));
  }

  /* Reprise APRÈS la confirmation native ET le redémarrage du segment : une
   * image reprise avant produirait des frames de l'ancienne caméra. */
  function resumeSampling(reason) {
    var s = sampler();
    if (!s || typeof s.start !== "function") return;
    if (!recordingNow()) {
      log("CAMERA_SAMPLER_RESUME_SKIPPED reason=" + (reason || "—") + " note=not_recording");
      return;
    }
    var cur = st();
    /* Le `startPlanId` est relu chez le SAMPLER, pas recopié ici : c'est lui
     * qui l'a reçu du plan de START, et lui seul sait s'il a changé depuis. Une
     * copie dans notre état vieillirait en silence, et une preview reprise sous
     * un identifiant de plan périmé ne serait plus rattachable à son Take. */
    var sv = (typeof s.view === "function") ? s.view() : {};
    s.start({
      sessionId: (sv.sessionId || cur.sessionId || ""),
      takeNumber: (sv.takeNumber != null) ? sv.takeNumber : cur.takeNumber,
      startPlanId: sv.startPlanId || "",
      reason: "camera_switch:" + (reason || "—")
    });
    log("CAMERA_SAMPLER_RESUME reason=" + (reason || "—") + " activeCamera=" + (cur.activeCamera || "—"));
  }

  /* ---------- exécution d'une bascule ---------- */

  /* Ne renvoie jamais `ok:true` sans fait natif : la confirmation relit
   * `getCameraState` et compare au facing demandé (fait dans
   * `camera-record.switchSegmented`). C'est ce qui rend impossible un faux ACK
   * sur un callback Cordova qui aurait renvoyé l'état d'AVANT bascule. */
  function execute(cmd, ctx, requested) {
    var m = model();
    var cam = camera();
    var s = st();

    set(m.beginSwitch(s, cmd, requested, nowMs()));
    log("CAMERA_SWITCH_BEGIN sessionId=" + (cmd.sessionId || "—")
      + " take=" + (ctx.take && ctx.take.takeNumber != null ? ctx.take.takeNumber : "—")
      + " commandId=" + (cmd.commandId || "—")
      + " target=" + cmd.targetDeviceId
      + " requested=" + requested
      + " active=" + (s.activeCamera || "—")
      + " recording=" + (recordingNow() ? 1 : 0));

    suspendSampling(requested);

    var opts = {
      startPlanId: "",
      takeNumber: ctx.take ? ctx.take.takeNumber : null,
      camera: requested
    };

return Promise.resolve(cam.switchSegmented(opts)).then(function (res) {
      var conf = m.confirmSwitch(st(), requested, res.to, nowMs());
      conf = m.recordSwitchDuration(conf, res.gapMs, nowMs());
      /* J09-08b1 : le segment qui vient d'être fermé rejoint l'historique AVEC
       * SON index et SA caméra (`res.from`, lue avant la bascule), puis le
       * segment suivant s'ouvre avec l'index SUIVANT. `segmentIndex` publié
       * plus bas désigne donc le segment EN COURS — celui dont le recorder
       * vient de repartir — et non le fichier qui vient de être clôturé. */
      var closedIndex = 0;
      if (res.segmented) {
        conf = m.closeCurrentSegment(conf, {
          path: res.closedPath,
          camera: res.from,
          stoppedAtMs: res.closedAtMs
        });
        if (conf.segments.length) {
          closedIndex = conf.segments[conf.segments.length - 1].segmentIndex;
        }
        conf = m.openSegment(conf, { camera: res.to, startedAtMs: res.atMs });
        log("CAMERA_SEGMENT_FINAL segmentIndex=" + (closedIndex || "—")
          + " camera=" + (res.from || "—")
          + " path=" + (res.closedPath || "—")
          + " reason=camera_switch");
      }
      set(conf);
      var currentIndex = m.currentIndex(conf);
      log("CAMERA_SWITCH_CONFIRM commandId=" + (cmd.commandId || "—")
        + " confirmed=" + (conf.activeCamera || "—")
        + " segmented=" + (res.segmented ? 1 : 0)
        + " segmentIndex=" + currentIndex
        + " closedSegmentIndex=" + (closedIndex || "—")
        + " closedPath=" + (res.closedPath || "—")
        + " gapMs=" + res.gapMs);
      resumeSampling(requested);
      broadcastState("switch_confirmed");
      return {
        ok: true,
        idempotent: false,
        camera: conf.activeCamera,
        segmented: res.segmented === true,
        segmentIndex: currentIndex,
        closedSegmentIndex: closedIndex,
        closedPath: res.closedPath || "",
        gapMs: res.gapMs,
        view: m.view(conf, { recording: recordingNow() })
      };
    }, function (err) {
      var code = (err && err.code) || "switch_failed";
      var next = m.failSwitch(st(), code, String((err && err.message) || err), nowMs());
      set(next);
      log("CAMERA_SWITCH_FAIL commandId=" + (cmd.commandId || "—")
        + " code=" + code + " requested=" + requested
        + " active=" + (next.activeCamera || "—")
        + " recording=" + (recordingNow() ? 1 : 0)
        + " err=" + String((err && err.message) || err));
      /* L'échantillonnage ne reprend QUE si un recorder tourne encore : sinon il
       * produirait des frames d'un enregistrement arrêté. */
      resumeSampling("after_failure");
      broadcastState("switch_failed");
      return {
        ok: false,
        code: code,
        message: next.lastError,
        /* `camera` est l'état RÉELLEMENT confirmé : le Master se converge vers
         * lui plutôt que de croire l'intention. */
        camera: next.activeCamera,
        view: m.view(next, { recording: recordingNow() })
      };
    });
  }

  /* ---------- J09-08b1 : cycle de vie des segments ----------
   *
   * Trois moments, trois points d'entrée, et un seul propriétaire de l'index :
   *
   *   - le TOP d'un Take  → le segment 1 s'ouvre (`onRecordingStarted`) ;
   *   - une bascule       → le segment courant est clos, le suivant s'ouvre
   *                         (`execute`), sans jamais recalculer `+ 1` ;
   *   - le STOP           → le dernier segment est clos (`onRecordingStopped`).
   *
   * Les deux hooks sont appelés par le start-service, au seul endroit où un
   * recorder démarre ou s'arrête pour un Take. Ils ne lisent AUCUN fait natif
   * pour décider QUAND : seulement pour dire QUELLE caméra filme.
   */

  /* Ouverture. La caméra vient du facing du WRAPPER NATIF, établi dès la
   * préparation — et NON du modèle, dont `activeCamera` peut encore être vide au
   * top (constaté sur le terrain : `activeCamera:""` pendant le REC). Ni la
   * caméra demandée ni un vide : une caméra non relue reste inconnue. */
  function onRecordingStarted() {
    var m = model();
    var s = st();
    if (!m || !s) return 0;
    var cam = camera();
    var cv = (cam && typeof cam.view === "function") ? cam.view() : null;
    var facing = (cv && cv.activeFacing) || "";
    if (s.currentSegment) {
      log("CAMERA_SEGMENT_OPEN_SKIP reason=already_open"
        + " segmentIndex=" + m.currentIndex(s));
      return m.currentIndex(s);
    }
    var next = m.openSegment(s, { camera: facing, startedAtMs: nowMs() });
    set(next);
    log("CAMERA_SEGMENT_OPEN segmentIndex=" + m.currentIndex(next)
      + " camera=" + (m.normalizeCamera(facing) || "—")
      + " take=" + (s.takeNumber == null ? "—" : s.takeNumber));
    return m.currentIndex(next);
  }

  /* Clôture par le STOP. `res` est le retour NATIF de `stopRecordVideo` : son
   * `path` est le seul lien entre un segment et un fichier réel, on ne l'invente
   * jamais. Sans lui le segment est clôturé avec un chemin vide — ce qui est
   * encore exact, et vaut mieux qu'un chemin deviné. */
  function onRecordingStopped(res) {
    var m = model();
    var s = st();
    if (!m || !s) return null;
    if (!s.currentSegment) {
      log("CAMERA_SEGMENT_FINAL_SKIP reason=no_current_segment");
      return null;
    }
    var r = res || {};
    var closed = m.closeCurrentSegment(s, {
      path: (typeof r.path === "string") ? r.path : "",
      stoppedAtMs: (typeof r.atMs === "number") ? r.atMs : nowMs()
    });
    set(closed);
    var last = closed.segments[closed.segments.length - 1];
    log("CAMERA_SEGMENT_FINAL segmentIndex=" + last.segmentIndex
      + " camera=" + (last.camera || "—")
      + " path=" + (last.path || "—")
      + " reason=stop");
    return last;
  }

  /* ---------- commande locale (Capture+Master) ---------- */

  /* Passe par EXACTEMENT la même validation que la commande distante : deux
   * chemins de validation donneraient deux comportements selon l'origine du
   * clic, ce qui rendrait §35.2 faux. */
  function requestSwitch(camera_) {
    var m = model();
    if (!m || !st()) {
      return Promise.resolve({ ok: false, code: "model_unavailable", message: "modèle absent" });
    }
    return resolveCurrent().then(function (c) {
      var cmd = {
        sessionId: (c.session && c.session.sessionId) || "",
        takeNumber: (c.take && c.take.takeNumber != null) ? c.take.takeNumber : null,
        targetDeviceId: selfDid(),
        camera: camera_,
        commandId: newCommandId(),
        from: selfDid()
      };
      return prepareForSwitch()
        .then(function () { return runCommand(cmd, c.session, c.take); })
        .then(function (res) {
          log("CAMERA_SWITCH_LOCAL status=" + (res.ok ? "OK" : "KO")
            + " code=" + (res.ok ? "" : res.code)
            + " camera=" + (res.camera || "—")
            + " commandId=" + cmd.commandId);
          return res;
        });
    });
  }

  /* Uniquement AVANT une bascule : `syncActiveCamera` ecrit `activeCamera`, et
   * pendant une bascule en vol cette valeur est justement en cours de changer.
   * Ecrire le facing natif au-dela reviendrait a afficher une cible comme si
   * elle etait deja acquise. */
  function prepareForSwitch() {
    if (st() && st().switchingCamera) return Promise.resolve(null);
    return Promise.resolve(syncActiveCamera("before_switch"))
      .then(function () { return refreshAvailability(); });
  }

  /* ---------- exécution d'une commande (locale ou distante) ---------- */

  function buildContext(cmd, ses, take) {
    var cam = camera();
    var cv = (cam && typeof cam.view === "function") ? cam.view() : null;
    return {
      state: st(),
      session: ses,
      take: take,
      actorDeviceId: cmd.from || cmd.actorDeviceId || selfDid(),
      /* Un device n'agit sur lui-même que s'il est Master, ET s'il est l'
       * émetteur : c'est la seule exception, elle ne contourne AUCUNE autre
       * validation (§35.2). */
      isMaster: isMasterOf(ses, cmd.from || selfDid()),
      captureRole: isCaptureOf(take, selfDid()),
      connected: connected(selfDid(), cmd.sessionId),
      recording: !!(cv && cv.recording),
      cameraPrepared: !(cv && cv.prepared === false)
    };
  }

  function runCommand(cmd, ses, take) {
    var m = model();
    if (!m || !st()) {
      return Promise.resolve({ ok: false, code: "model_unavailable", message: "modèle absent" });
    }
    var self = selfDid();
    if (!cmd || cmd.targetDeviceId !== self) {
      /* Pas pour nous : rien à exécuter, et surtout PAS d'ACK — un device ne
       * répond jamais pour un autre. */
      return Promise.resolve({ ok: false, code: "not_for_me", message: "cible ≠ ce device", silent: true });
    }

    var v = m.validate(cmd, buildContext(cmd, ses, take));

    if (!v.ok) {
      set(m.failSwitch(st(), v.code, v.message, nowMs()));
      log("CAMERA_SWITCH_REJECT commandId=" + (cmd.commandId || "—")
        + " code=" + v.code + " reason=" + v.message
        + " target=" + (cmd.targetDeviceId || "—") + " requested=" + (cmd.camera || "—"));
      return Promise.resolve({ ok: false, code: v.code, message: v.message, camera: st().activeCamera });
    }

    /* Idempotence : la caméra demandée est DÉJÀ active. Succès SANS opération
     * physique, sans trou, sans nouveau segment — c'est ce qui rend une double
     * commande Master inoffensive. */
    if (v.idempotent) {
      log("CAMERA_SWITCH_NOOP commandId=" + (cmd.commandId || "—")
        + " camera=" + v.camera + " reason=already_active");
      return Promise.resolve({
        ok: true, idempotent: true, camera: v.camera, segmented: false,
        segmentIndex: m.currentIndex(st()), gapMs: 0,
        view: m.view(st(), { recording: recordingNow() })
      });
    }

    return execute(cmd, buildContext(cmd, ses, take), v.camera);
  }

  /* ---------- commande distante (Master → Capture) ---------- */

  function newCommandId() {
    return "cs-" + nowMs().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  /* Envoie une commande CIBLEE et attend l'ACK de la Capture.
   *
   * L'ACK est attendu par `commandId` : sans lui, le Master ne peut pas
   * distinguer « la Capture a changé » de « le message s'est perdu ». Le délai
   * d'attente est une IMPOSSIBILITÉ de conclure, pas un échec : il est rendu
   * comme tel pour que l'UI affiche « pas de réponse » et non « échec ». */
  var ACK_TIMEOUT_MS = 15000;

  function requestSwitchRemote(opts) {
    var m = model();
    var o = opts || {};
    var w = ws();

    return resolveCurrent().then(function (c) {
      var ses = c.session;
      var take = c.take;
      var sid = (o.sessionId || (ses && ses.sessionId) || "");
      var takeNumber = (o.takeNumber != null) ? o.takeNumber : (take ? take.takeNumber : null);
      var commandId = o.commandId || newCommandId();

      var cmd = {
        sessionId: sid,
        takeNumber: (takeNumber == null) ? null : takeNumber,
        targetDeviceId: o.targetDeviceId || "",
        camera: o.camera,
        commandId: commandId
      };

/* Pré-validation de l'AUTORITÉ seulement : ce qu'un Master peut savoir de
     * façon fiable. La disponibilité des caméras et l'état réel de la cible
     * appartiennent à la cible — les deviner ici serait pire que de ne rien
     * vérifier.
     *
     * `captureRole` n'est PAS décoratif : `validateAuthority` refuse un device
     * qui n'est pas Capture du Take (§35.2). L'évaluer ici, avec la table des
     * participants que le Master connaît, évite d'envoyer un ordre à un Storage
     * ou à un Master simple — donc à une cible qui le refuserait à son tour, en
     EX PENSIVE : on ne paie pas un aller-retour réseau pour découvrir
     * que la cible n'était pas une Capture.
     * gratuitement. On ne devine pas : si la liste est absente, on répond faux. */
    var takeCtx = null;
    if (takeNumber != null) {
      takeCtx = { takeNumber: takeNumber, captures: (take && Array.isArray(take.captures)) ? take.captures : [] };
    }
    var a = m.validateAuthority(cmd, {
      session: ses,
      take: (takeNumber == null) ? take : takeCtx,
      isMaster: isMasterOf(ses, selfDid()),
      captureRole: !!(takeCtx && takeCtx.captures.indexOf(cmd.targetDeviceId) >= 0),
      /* La JOIGNABILITÉ est un fait que le Master connaît déjà (§35.2). Le
       * vérifier ici évite d'envoyer un ordre à une cible disparue : non
       * seulement c'est gratuit, mais surtout cela distingue un refus « cible
       * déconnectée » d'un silence réseau, que l'opérateur ne saura pas
       * départager. Le transport reste une seconde barrière, pas la première. */
      connected: connected(cmd.targetDeviceId, sid),
      actorDeviceId: selfDid()
    });
      if (!a.ok) {
        log("CAMERA_SWITCH_SEND_REFUSE target=" + (cmd.targetDeviceId || "—") + " code=" + a.code);
        return { ok: false, code: a.code, message: a.message, sent: false };
      }
      if (!w || typeof w.sendToDevice !== "function") {
        log("CAMERA_SWITCH_SEND_REFUSE target=" + cmd.targetDeviceId + " code=transport_unavailable");
        return { ok: false, code: "transport_unavailable", message: "WS indisponible", sent: false };
      }

      var sent = w.sendToDevice(cmd.targetDeviceId, ses, "camera_switch_request", cmd);
      log("CAMERA_SWITCH_SEND sessionId=" + sid
        + " take=" + (cmd.takeNumber == null ? "—" : cmd.takeNumber)
        + " commandId=" + commandId + " target=" + cmd.targetDeviceId
        + " requested=" + m.normalizeCamera(cmd.camera) + " sent=" + (sent ? 1 : 0));
      if (!sent) {
        return { ok: false, code: "target_disconnected", message: "cible non joignable", sent: false };
      }
      return awaitAck(cmd, commandId);
    });
  }

  function awaitAck(cmd, commandId) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        delete PENDING[commandId];
        log("CAMERA_SWITCH_ACK_TIMEOUT commandId=" + commandId
          + " target=" + cmd.targetDeviceId + " timeoutMs=" + ACK_TIMEOUT_MS);
        resolve({
          ok: false, code: "ack_timeout", message: "pas de réponse de " + cmd.targetDeviceId,
          inconclusive: true, sent: true, commandId: commandId
        });
      }, ACK_TIMEOUT_MS);

      PENDING[commandId] = function (env) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        delete PENDING[commandId];
        log("CAMERA_SWITCH_ACK commandId=" + commandId
          + " ok=" + (env.ok ? 1 : 0) + " code=" + (env.code || "—")
          + " camera=" + (env.activeCamera || env.camera || "—")
          + " segmentIndex=" + (env.segmentIndex == null ? "—" : env.segmentIndex)
          + " gapMs=" + (env.gapMs == null ? "—" : env.gapMs));
        resolve({
          ok: env.ok === true,
          code: env.code || "",
          message: env.message || "",
          idempotent: env.idempotent === true,
          segmented: env.segmented === true,
          camera: env.activeCamera || env.camera || "",
          segmentIndex: env.segmentIndex,
          closedPath: env.closedPath || "",
          gapMs: env.gapMs,
          commandId: commandId,
          sent: true
        });
      };
    });
  }

  /* Résolution d'un ACK reçu par le WS. */
  function onAck(env) {
    if (!env || !env.commandId) return false;
    var waiter = PENDING[env.commandId];
    if (!waiter) return false;
    waiter(env);
    return true;
  }

  /* ---------- pont WS ---------- */

  function hookBridge() {
    if (bridgeHooked || !ws() || typeof ws().setCameraSwitchBridge !== "function") return;
    bridgeHooked = true;
    ws().setCameraSwitchBridge({
      onCameraSwitchRequest: function (env) {
        /* La session est RELUE au moment de l'exécution : une commande portant
         * sur un Take qui n'est plus courant doit être refusée par la
         * validation, pas servie par un cache périmé. */
        prepareForSwitch()
          .then(function () { return loadSession(env.sessionId); })
          .then(function (ses) {
            var take = lastTakeOf(ses);
            if (ses) { lastSession = ses; lastTake = take; }
            return runCommand(env, ses, take);
          })
          .then(function (res) {
            if (res && res.silent) return;   /* pas pour nous : aucun ACK */
            ackTo(env, res);
          })
          .catch(function (err) {
            ackTo(env, { ok: false, code: "internal_error", message: String((err && err.message) || err) });
          });
      },
      onCameraSwitchResult: function (env) {
        onAck(env);
      },
      onCameraState: function (env) {
        /* Mémoire de supervision : un Master affiche l'état d'une Capture. Ce
         * module ne le SUIT pas — il ne fait que le publier. */
        var inbox = global.MultiCamCameraStateInbox;
        if (inbox && typeof inbox.record === "function") inbox.record(env);
      }
    });
  }

  /* L'ACK part sur la MÊME connexion que la demande (règle du transport, déjà
   * appliquée à `arm_result`, `clock_sync_reply` et `start_probe_reply`). */
  function ackTo(env, res) {
    var w = ws();
    if (!w || typeof w.reply !== "function") return;
    var m = model();
    w.reply(env, {
      takeNumber: (env.takeNumber != null) ? env.takeNumber : st().takeNumber,
      targetDeviceId: env.targetDeviceId,
      commandId: env.commandId || "",
      requested: m ? m.normalizeCamera(env.camera) : env.camera,
      activeCamera: (res.view && res.view.activeCamera) || st().activeCamera || "",
      ok: res.ok === true,
      code: res.ok ? "" : (res.code || ""),
      message: res.ok ? "" : (res.message || ""),
      idempotent: res.idempotent === true,
      segmented: res.segmented === true,
      segmentIndex: (res.view && typeof res.view.segmentIndex === "number")
        ? res.view.segmentIndex : m.currentIndex(st()),
      closedPath: res.closedPath || "",
      gapMs: (typeof res.gapMs === "number") ? res.gapMs : 0,
      confirmedAtMs: nowMs()
    });
  }

  /* ---------- publication de l'état confirmé ---------- */

  /* §35.3 : les Masters se CONVERGENT vers l'état RÉELLEMENT confirmé. On
   * diffuse donc après chaque confirmation ET après chaque échec — un Master qui
   * garde un état périmé afficherait une caméra qui ne filme plus. Ce n'est pas
   * une télémétrie périodique : c'est un ÉVÉNEMENT. */
  function broadcastState(reason) {
    var w = ws();
    var m = model();
    var s = st();
    if (!w || typeof w.broadcastCameraState !== "function" || !m || !s) return false;
    var v = m.view(s, { recording: recordingNow() });
    var ss = startService();
    /* La phase RELAYEE est celle du START, lue par l'acces.seur etroit : la
     * lire depuis `m.view()` enverrait l'etat de la CAMERA (cameraPhase). */
    var startPhase = (ss && typeof ss.phase === "function") ? (ss.phase() || "") : "";
    return w.broadcastCameraState(lastSession || { sessionId: s.sessionId }, {
      takeNumber: s.takeNumber,
      deviceId: selfDid(),
      availableCameras: v.availableCameras,
      requestedCamera: v.requestedCamera,
      switchingCamera: v.switchingCamera,
      activeCamera: v.activeCamera,
      segmentIndex: v.segmentIndex,
      switchCount: v.switchCount,
      lastError: v.lastError,
      lastErrorCode: v.lastErrorCode,
      lastSwitchDurationMs: v.lastSwitchDurationMs,
      /* La phase du START est RELAYEE : le Master n'a pas le plan de la
       * Capture et ne doit surtout pas la recomposer. */
      phase: startPhase,
      cameraPhase: v.cameraPhase || "unknown",
      /* Instant de MESURE cote Capture, distinct de l'instant de reception
       * (`updatedAtMs`). Sans lui, la croissance temporelle a un point de
       * comparaison nul et le tri des paquets n'a aucun sens. */
      atMs: nowMs(),
      reason: reason || ""
    });
  }

  /* ---------- cycle de vie ---------- */

  /* Rattachement au plan START courant : c'est ici que le compteur de segments
   * est remis à zéro pour un nouveau Take (segmentIndex est propre au Take). */
  function onStartView(v) {
    var m = model();
    if (!m || !st() || !v || !v.active) return;
    var sid = v.sid || "";
    var tnum = (v.takeNumber == null) ? null : v.takeNumber;
    var s = st();
    if (s.sessionId === sid && String(s.takeNumber) === String(tnum)) return;
    set(m.attachToTake(s, sid, tnum, nowMs()));
    log("CAMERA_SWITCH_ATTACH sessionId=" + (sid || "—")
      + " take=" + (tnum == null ? "—" : tnum) + " segmentIndex=0");
  }

  function view() {
    var m = model();
    var s = st();
    var rec = recordingNow();
    if (!m || !s) {
      return {
        deviceId: selfDid(), availableCameras: [], selectable: [],
        activeCamera: "", requestedCamera: "", switchingCamera: "",
        busy: false, recording: rec, phase: "", unknown: true
      };
    }
    var v = m.view(s, { recording: rec });
    v.recording = rec;
    v.selectable = m.selectable(s);
    var ss = startService();
    /* Accèsseur étroit, PAS `ss.view()` : start-service publie `cameraSwitch`
     * dans sa vue, donc lire sa vue depuis ici reboucle à l'infini. */
    v.phase = (ss && typeof ss.phase === "function") ? (ss.phase() || "") : "";
    v.unknown = false;
    return v;
  }

  function bind() {
    if (S.bound) return Promise.resolve(view());
    S.bound = true;
    st();
    hookBridge();
    log("CAMERA_SWITCH_SERVICE_READY deviceId=" + selfDid());
    return Promise.resolve(view());
  }

  function reset() {
    S.state = freshState();
    lastSession = null;
    lastTake = null;
    Object.keys(PENDING).forEach(function (k) { delete PENDING[k]; });
    return true;
  }

  global.MultiCamCameraSwitchService = {
    bind: bind,
    /* local (Capture+Master) */
    requestSwitch: requestSwitch,
    /* Master -> Capture */
    requestSwitchRemote: requestSwitchRemote,
    /* interne / tests */
    runCommand: runCommand,
    refreshAvailability: refreshAvailability,
    syncActiveCamera: syncActiveCamera,
    broadcastState: broadcastState,
    onStartView: onStartView,
    /* J09-08b1 : segments — appelés par le start-service */
    onRecordingStarted: onRecordingStarted,
    onRecordingStopped: onRecordingStopped,
    onAck: onAck,
    lastTakeOf: lastTakeOf,
    view: view,
    isBusy: function () { return !!(st() && st().switchingCamera); },
    reset: reset,
    ACK_TIMEOUT_MS: ACK_TIMEOUT_MS,
    onView: function (fn) {
      if (typeof fn === "function" && listeners.indexOf(fn) < 0) listeners.push(fn);
    },
    offView: function (fn) {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    }
  };
})(window);