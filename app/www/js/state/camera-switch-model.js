/* MultiCam — J09-07 : MODÈLE PUR du changement de caméra (aucun effet de bord).
 *
 * Décision appliquée : MULTICAM_DECISIONS_REFERENCE.md §35.2 et §35.3.
 *
 *   §35.2  une Capture peut changer de caméra à tout moment, y compris PENDANT
 *          un enregistrement ; tous les Masters ont la MÊME autorité ; une
 *          Capture qui n'est pas Master ne change rien elle-même.
 *   §35.3  la stratégie figée est la SEGMENTATION : arrêter proprement le
 *          recorder courant, basculer, puis démarrer immédiatement un nouveau
 *          recorder/fichier. Le Take reste REC. Aucune Capture ne s'arrête.
 *
 * ---------- LE PRINCIPE DIRECTEUR : PAS D'UI OPTIMISTE ----------
 *
 * `requestedCamera` est une INTENTION. `activeCamera` est un FAIT : il n'est
 * écrit qu'après un retour natif qui confirme la caméra réellement ouverte. Un
 * Master ne voit donc jamais « REAR → FRONT » avant que le device n'ait
 * réellement changé, et un échec laisse l'état exactement où il était.
 *
 * ---------- J09-08b1 : L'IDENTITÉ D'UN SEGMENT ----------
 *
 * Un segment porte son index dès son OUVERTURE, pas à sa clôture. Le premier
 * segment d'un Take est le segment 1 ; après un switch, le nouveau fichier est
 * le segment 2 ; puis 3. `currentSegment` porte l'index du fichier en cours et
 * `segments[]` l'historique ordonné de ceux qui sont clos — le dernier inclus,
 * clos par le STOP. Aucun index n'est réutilisé dans un même Take.
 *
 * Ce qui précède était un compteur de segments DÉJÀ FERMÉS : il ne disait pas
 * à quel fichier un numéro appartenait, la valeur publiée changeait sous les
 * pieds du même fichier, et le dernier segment d'un Take n'était jamais numéroté.
 *
 * ---------- J09-08b2 : L'ÉTAT EXPLICITE D'UN SEGMENT ----------
 *
 * Un segment n'est plus « présent » ou « absent » : il est `recording`,
 * `closed` ou `failed`. L'état n'est pas décoratif, c'est lui qui décide si un
 * segment entre dans l'historique :
 *
 *   - `closed`  sa clôture est CONFIRMÉE par le natif (chemin + instant) ;
 *   - `failed`  il a bien existé — donc il porte un index — mais sa clôture
 *               n'est pas confirmée. Il reste DEVANT l'historique, jamais dans
 *               l'historique : un fichier dont on ignore s'il existe ne peut
 *               pas être présenté comme finalisé.
 *
 * Un segment `failed` reste le segment EN COURS : il garde son index, et le
 * suivant PORTERA l'index suivant. C'est ce qui rend la règle « aucun index
 * réutilisé » tenable même après un échec — un `restart_failed` ne fabrique
 * jamais un N+1 fantôme, et un échec ne fait jamais disparaître un N+1 réel.
 *
 * ---------- POURQUOI UN MODÈLE SÉPARÉ ----------
 *
 * Les invariants §35.2 (session, Take, cible, disponibilité, concurrence,
 * idempotence) sont testables sans Cordova, sans réseau et sans minuterie. Les
 * mettre dans le service les rendrait dépendants du faux plugin de test. Ce
 * module ne connaît QUE des objets : il ne fait aucun Date.now(), aucun log,
 * aucune Promesse. Le temps est injecté par l'appelant.
 */

(function (global) {
  "use strict";

  /* Les DEUX caméras du modèle J06 (`take.settings.video.camera`). On ne parle
   * jamais d'un cameraId matériel ici : le modèle produit est REAR/FRONT, et
   * la résolution du facing vers un cameraId est un fait NATIF (§35.3). */
  var CAMERAS = ["REAR", "FRONT"];

  /* Codes d'échec STABLES : ce sont des mots de log parsables et des motifs
   * affichables. Toute erreur doit être l'un d'eux — une exception libre
   * rendrait l'ACK au Master non exploitable. */
  var ERR = {
    MALFORMED: "malformed_request",
    NO_SESSION: "no_session",
    SESSION_MISMATCH: "session_mismatch",
    UNKNOWN_TAKE: "unknown_take",
    TAKE_MISMATCH: "take_mismatch",
    TARGET_REQUIRED: "target_device_required",
    TARGET_UNKNOWN: "unknown_target_device",
    TARGET_NOT_CAPTURE: "target_not_capture",
    TARGET_DISCONNECTED: "target_disconnected",
    NOT_MASTER: "not_master",
    SWITCH_IN_PROGRESS: "switch_in_progress",
    UNKNOWN_CAMERA: "unknown_camera",
    CAMERA_NOT_AVAILABLE: "camera_not_available",
    NOT_CAPTURE_ROLE: "not_capture_role",
    SWITCH_FAILED: "switch_failed",
    RESTART_FAILED: "restart_failed",
    PLUGIN_UNAVAILABLE: "plugin_unavailable",
    CAMERA_OFF: "camera_off"
  };

  var LABELS = { REAR: "Arrière", FRONT: "Selfie" };

  /* ---------- J09-08b2 : cycle de vie d'un segment ----------
   *
   * Ces trois valeurs sont un vocabulaire STABLE : elles sont journalisées et
   * publiées. « absent » n'en fait pas partie — un segment existe dès que son
   * recorder a démarré, et son état dit ce qu'on sait de sa fin. */
  var SEG = {
    RECORDING: "recording",
    CLOSED: "closed",
    FAILED: "failed"
  };

  /* ---------- normalisation ---------- */

  /* Accepte les écritures réellement vues dans l'application : le modèle J06
   * ("REAR"/"FRONT"), les capacités natives ("rear"/"front"), les directions du
   * plugin ("back"/"front") et les noms de facing camera2. Renvoie "" pour tout
   * ce qui n'est pas une caméra du modèle — jamais de valeur devinée. */
  function normalizeCamera(v) {
    if (typeof v !== "string") return "";
    var s = v.trim().toUpperCase();
    if (s === "REAR" || s === "BACK" || s === "BACKWARD" || s === "LENS_FACING_BACK") return "REAR";
    if (s === "FRONT" || s === "FRONTCAMERA" || s === "SELFIE" || s === "LENS_FACING_FRONT") return "FRONT";
    return "";
  }

  function label(camera) {
    return LABELS[camera] || "";
  }

  /* ---------- état ---------- */

  function createState(deviceId) {
    return {
      deviceId: (typeof deviceId === "string") ? deviceId : "",
      sessionId: "",
      takeNumber: null,
      /* Liste des caméras PHYSIQUIQUEMENT présentes. Vide = inconnu, ce qui est
       * un refus (fail closed), jamais « toutes disponibles ». */
      availableCameras: [],
      /* Intention en cours de réalisation. */
      requestedCamera: "",
      /* Caméra en cours de bascule (opération interne, jamais un état stable). */
      switchingCamera: "",
      /* FAIT natif : la caméra réellement ouverte. */
      activeCamera: "",
      /* ---------- J09-08b1 : L'IDENTITÉ DU SEGMENT ----------
       *
       * `currentSegment` est le segment MÉMOIRE en cours d'enregistrement. Il
       * reçoit son `segmentIndex` À L'OUVERTURE — c'est-à-dire quand le
       * recorder démarre — et plus jamais ensuite. Le premier segment d'un Take
       * porte donc 1, celui qui suit 2, puis 3.
       *
       * `segments` est l'historique ORDONNÉ des segments clôturés du Take
       * courant. Il ne manque jamais d'entrée : tout fichier produit par un Take
       * finit ici, y compris le dernier, clos par le STOP.
       *
       * Ces deux notions sont distinctes par construction : `segmentIndex` n'est
       * plus un compteur de « segments déjà fermés », et `currentSegment` n'est
       * plus le dernier segment fermé. Un compteur ne disait pas à quel fichier
       * un numéro appartenait — c'était la ambiguïté constatée sur J09-07.
       *
       * ---------- J09-08b2 : l'état du segment ----------
       *
       * `currentSegment.state` est `recording` ou `failed` ; une entrée de
       * `segments` est `closed` ou `failed` (un segmentclos par le STOP après
       * un échec conserve son `failureCode` : le fait observé ne s'efface pas). */
      currentSegment: null,
      segments: [],
      /* Compteurs de diagnostic (parsersables dans les logs de campagne). */
      switchCount: 0,
      failCount: 0,
      lastError: "",
      lastErrorCode: "",
      lastErrorAtMs: 0,
      lastCommandId: "",
      lastRequestedAtMs: 0,
      lastConfirmedAtMs: 0,
      /* Durée cumulée des trous d'image mesurés par la segmentation, en ms. */
      lastSwitchDurationMs: 0,
      gapMaxMs: 0
    };
  }

  /* ---------- capacités -> caméras disponibles ----------
   *
   * Source : la FORME BRUTE de `getCaptureCapabilities` (`cameras[]` avec
   * `facing`). On ne passe volontairement PAS par la normalisation J06, qui
   * réduit chaque facing à la liste des RÉSOLUTIONS recordings : une caméra
   * arrière qui ne supporte aucun profil 720P/1080P/2160P y verrait une liste
   * vide et serait à tort déclarée « indisponible ».
   *
   * Renvoie { known:false } dès que la forme n'est pas exploitable : le
   * service refusera alors toute bascule plutôt que de la deviner. */
  function availableFromRaw(raw) {
    if (!raw || typeof raw !== "object") return { known: false, cameras: [] };
    /* Enveloppe de télémétrie éventuelle. */
    var r = (raw.capabilities && typeof raw.capabilities === "object") ? raw.capabilities : raw;
    var list = null;

    if (Array.isArray(r.cameras)) {
      list = r.cameras;
    } else if (r.cameras && typeof r.cameras === "object" && !Array.isArray(r.cameras)) {
      /* Forme DÉJÀ normalisée J06 : {rear:[résolutions], front:[…]}. Elle ne
       * dit RIEN de la présence physique d'une caméra. Répondre « inconnu »
       * est le comportement fail closed ; déduire la présence d'une liste de
       * résolutions serait une invention. */
      return { known: false, cameras: [] };
    } else {
      return { known: false, cameras: [] };
    }

    var seen = [];
    var errors = 0;
    list.forEach(function (c) {
      if (!c || typeof c !== "object") return;
      if (c.error) { errors += 1; return; }
      var facing = normalizeCamera(c.facing);
      if (!facing) return;
      if (seen.indexOf(facing) < 0) seen.push(facing);
    });
    /* On trie dans l'ordre du modèle : une liste stable rend les logs et les
     * tests reproductibles quelle que soit l'ordre d'énumération natif. */
    seen.sort(function (a, b) { return CAMERAS.indexOf(a) - CAMERAS.indexOf(b); });
    if (!seen.length && errors) return { known: false, cameras: [] };
    return { known: true, cameras: seen };
  }

  function hasCamera(list, camera) {
    return Array.isArray(list) && list.indexOf(camera) >= 0;
  }

/* ---------- validation (PARE, fail closed) ----------
   *
   * `validateAuthority()` — ce qu'un Master peut vérifier AVANT d'envoyer, et que
   *   la cible revérifiera à l'identique. Un device non-Master, une cible
   *   inconnue, une cible qui n'est pas Capture du Take courant, une session qui
   *   ne correspond pas : ces refus sont déterministes et FRANCHISSABLES par les
   *   deux camps, donc inutile de les faire voyager sur le réseau.
   *
   * `validate()` — l'autorité PLUS ce que seule la cible peut savoir : caméra
   *   demandée existante, bascule concurrente, disponibilité physique réelle,
   *   preview ouverte.
   *
   * L'ordre est FIXE et lisible : structure → session → Take → cible → rôle →
   * concurrence → caméra. Le premier motif compte : c'est lui qui est renvoyé
   * au Master, donc deux devices doivent toujours citer la même raison.
   */
  function validateAuthority(cmd, ctx) {
    var c = ctx || {};
    var cmd0 = cmd || {};

    /* --- 1. structure de la commande --- */
    if (!cmd0 || typeof cmd0 !== "object") {
      return fail(ERR.MALFORMED, "commande absente");
    }
    if (typeof cmd0.sessionId !== "string" || !cmd0.sessionId) {
      return fail(ERR.NO_SESSION, "sessionId absent");
    }
    if (typeof cmd0.targetDeviceId !== "string" || !cmd0.targetDeviceId) {
      return fail(ERR.TARGET_REQUIRED, "targetDeviceId absent");
    }
    var takeNumber = (cmd0.takeNumber == null || cmd0.takeNumber === "") ? null : cmd0.takeNumber;

    /* --- 2. session connue et identique --- */
    if (!c.session || !c.session.sessionId) {
      return fail(ERR.NO_SESSION, "session inconnue");
    }
    if (c.session.sessionId !== cmd0.sessionId) {
      return fail(ERR.SESSION_MISMATCH, "session " + (cmd0.sessionId || "—") + " != " + c.session.sessionId);
    }

    /* --- 3. Take courant --- */
    if (!c.take) return fail(ERR.UNKNOWN_TAKE, "aucun Take");
    if (takeNumber !== null && c.take.takeNumber !== takeNumber) {
      return fail(ERR.TAKE_MISMATCH, "Take " + takeNumber + " != " + c.take.takeNumber);
    }

    /* --- 4. cible : un device connu de CETTE session --- */
    if (!isMemberOf(c.session, cmd0.targetDeviceId)) {
      return fail(ERR.TARGET_UNKNOWN, "device " + cmd0.targetDeviceId + " absent de la session");
    }

    /* --- 5. autorité : §35.2 « tous les Masters ont la MÊME autorité » --- */
    if (c.isMaster !== true) {
      return fail(ERR.NOT_MASTER, "émetteur " + (c.actorDeviceId || "—") + " n'est pas Master");
    }

    /* --- 6. rôle Capture de la cible (§35.2) --- */
    if (!c.captureRole) {
      return fail(ERR.TARGET_NOT_CAPTURE, cmd0.targetDeviceId + " n'est pas Capture du Take");
    }

    /* --- 7. joignabilité : un device déconnecté ne peut rien confirmer --- */
    if (c.connected === false) {
      return fail(ERR.TARGET_DISCONNECTED, cmd0.targetDeviceId + " déconnecté");
    }

    return { ok: true, takeNumber: takeNumber };
  }

  function validate(cmd, ctx) {
    var c = ctx || {};
    var stt = c.state || createState("");
    var cmd0 = cmd || {};

    var a = validateAuthority(cmd, c);
    if (!a.ok) return a;

    /* --- 8. caméra demandée --- */
    var camera = normalizeCamera(cmd0.camera);
    if (!camera) {
      return fail(ERR.UNKNOWN_CAMERA, "caméra " + String(cmd0.camera) + " hors modèle");
    }

    /* --- 9. opération concurrente : une seule bascule physique par device --- */
    if (stt.switchingCamera) {
      return fail(ERR.SWITCH_IN_PROGRESS, "bascule vers " + stt.switchingCamera + " en cours");
    }

    /* --- 10. IDEMPOTENCE : déjà active → succès SANS toucher au matériel.
     * Vérifié APRÈS la concurrence pour qu'une bascule réellement en cours ne
     * soit jamais déclarée « déjà active » sur la seule foi de l'intention. */
    if (stt.activeCamera === camera) {
      return { ok: true, camera: camera, idempotent: true, reason: "already_active" };
    }

    /* --- 11. disponibilité physique : fail closed sur un inventaire inconnu --- */
    if (!Array.isArray(stt.availableCameras) || !stt.availableCameras.length) {
      return fail(ERR.CAMERA_NOT_AVAILABLE, "caméras disponibles inconnues");
    }
    if (!hasCamera(stt.availableCameras, camera)) {
      return fail(ERR.CAMERA_NOT_AVAILABLE,
        camera + " absent (disponible : " + (stt.availableCameras.join(",") || "—") + ")");
    }

    /* --- 12. la caméra doit être ouverte : on reconfigure une preview, on ne
     * l'ouvre pas. Si la preview permanente est éteinte, il n'y a rien à
     * reconfigurer et le service le refuse. --- */
    if (c.cameraPrepared === false) {
      return fail(ERR.CAMERA_OFF, "preview locale fermée");
    }

    return { ok: true, camera: camera, idempotent: false, reason: "" };
  }


  function isMemberOf(session, deviceId) {
    if (!session || !deviceId) return false;
    var members = session.members || [];
    for (var i = 0; i < members.length; i++) {
      if (members[i] && members[i].deviceId === deviceId) return true;
    }
    return false;
  }

  function fail(code, message) {
    return { ok: false, code: code, message: message || code };
  }

  /* ---------- transitions (pures : entrée → sortie) ---------- */

  /* Début d'opération. Ne change PAS `activeCamera` : l'UI doit continuer
   * d'afficher le fait courant jusqu'à la confirmation native. */
  function beginSwitch(state, cmd, camera, atMs) {
    var out = clone(state);
    out.requestedCamera = camera;
    out.switchingCamera = camera;
    out.lastCommandId = (cmd && typeof cmd.commandId === "string") ? cmd.commandId : out.lastCommandId;
    out.lastRequestedAtMs = atMs;
    out.lastError = "";
    out.lastErrorCode = "";
    /* `switchCount` reste en revanche CUMULATIF : c'est un compteur de
     * diagnostic du device (combien de bascules depuis l'allumage), pas un
     * état du Take. Le remettre à zéro ferait perdre l'historique utile en cas
     * de problème de segmentation, sans rien apporter à l'écran. */
    return out;
  }

  /* Confirmation native. `confirmed` est le facing lu par le natif APRÈS la
   * bascule. On n'accepte la confirmation que si elle correspond à la demande :
   * c'est ce qui rend impossible un faux ACK sur un callback qui aurait renvoyé
   * l'ETAT AVANT bascule. */
  function confirmSwitch(state, requested, confirmed, atMs) {
    var out = clone(state);
    if (normalizeCamera(confirmed) !== normalizeCamera(requested)) {
      out.lastError = "caméra confirmée (" + String(confirmed) + ") != demandée (" + String(requested) + ")";
      out.lastErrorCode = ERR.SWITCH_FAILED;
      out.lastErrorAtMs = atMs;
      out.switchingCamera = "";
      out.failCount += 1;
      /* `activeCamera` est INCHANGÉ : on ne publie rien de faux. */
      return out;
    }
    out.activeCamera = normalizeCamera(confirmed);
    out.switchingCamera = "";
    out.requestedCamera = out.activeCamera;
    out.lastConfirmedAtMs = atMs;
    out.switchCount += 1;
    return out;
  }

  /* Échec. `activeCamera` reste le fait confirmed, `switchingCamera` est
   * relâché pour qu'une nouvelle commande puisse être tentée. */
  function failSwitch(state, code, message, atMs) {
    var out = clone(state);
    out.switchingCamera = "";
    out.lastError = message || code;
    out.lastErrorCode = code;
    out.lastErrorAtMs = atMs;
    out.failCount += 1;
    return out;
  }

  /* ---------- J09-08b1 : identité et historique des segments ---------- */

/* Le prochain index est calculé sur le MAXIMUM DÉJÀ VU, jamais sur la
   * longueur de l'historique : `longueur + 1` ne vaut « suivant » que tant que
   * l'historique est une suite contiguë, et le réutiliserait dès qu'elle cessera
   * de l'être. Sur le maximum, l'invariant tient par construction : deux
   * segments d'un même Take ne peuvent pas partager un index.
   *
   * J09-08b2 : un segment `failed` COMPTE. Il a occupé un index et un fichier,
   * donc le suivant ne peut pas le reprendre — que l'échec ait eu lieu avant ou
   * après la bascule. */
  function nextSegmentIndex(state) {
    var st = state || {};
    var max = 0;
    (st.segments || []).forEach(function (s) {
      if (s && typeof s.segmentIndex === "number" && s.segmentIndex > max) max = s.segmentIndex;
    });
    if (st.currentSegment && typeof st.currentSegment.segmentIndex === "number"
      && st.currentSegment.segmentIndex > max) {
      max = st.currentSegment.segmentIndex;
    }
    return max + 1;
  }

  /* Index du segment EN COURS, 0 quand rien n'est en cours. 0 n'est pas un
   * index : aucun segment d'un Take ne le porte. */
  function currentIndex(state) {
    return (state && state.currentSegment) ? state.currentSegment.segmentIndex : 0;
  }

  /* Ouverture d'un segment, au moment où son recorder démarre.
   *
   * `info.camera` est la caméra RÉELLEMENT ouverte, lue du natif — jamais la
   * caméra demandée. `info.path` reste vide à l'ouverture : le chemin n'existe
   * qu'à la clôture, quand `stopRecordVideo` le renvoie.
   *
   * J09-08b2 : l'ouverture ne concernera QUE le segment N+1 d'une bascule dont
   * le natif a CONFIRMÉ la création du recorder (`recorderStarted === true`).
   * Un `restart_failed` sans cette preuve n'appelle donc pas cette fonction, et
   * aucun segment fantôme n'apparaît. */
  function openSegment(state, info) {
    var o = info || {};
    var out = clone(state);
    /* Un Take ne filme qu'avec UN recorder : un second segment ouvert ici
     * donnerait deux fichiers pour un seul index. On ne devine pas lequel des
     * deux est le bon — l'appelant journalise le refus et n'inscrit rien. */
    if (out.currentSegment) return out;
    out.currentSegment = {
      segmentIndex: nextSegmentIndex(out),
      camera: normalizeCamera(o.camera),
      path: (typeof o.path === "string") ? o.path : "",
      startedAtMs: (typeof o.startedAtMs === "number") ? o.startedAtMs : 0,
      stoppedAtMs: 0,
      /* J09-08b2 : le recorder vient de démarrer, la fin du segment est
       * entièrement inconnue. */
      state: SEG.RECORDING,
      failureCode: "",
      failedAtMs: 0
    };
    return out;
  }

  /* Clôture du segment courant : il quitte le devant et rejoint l'historique
   * avec SON index et SA caméra. Aucun accès au natif ici : `info` ne porte que
   * des faits déjà lus (`closedPath`, `closedAtMs`), et une donnée absente reste
   * absente — jamais un chemin ni un instant devinés. */
  function closeCurrentSegment(state, info) {
    var o = info || {};
    var out = clone(state);
    var cur = out.currentSegment;
    /* Clôturer sans segment ouvert n'invente pas d'entrée : un historique
     * contenant un segment qui n'a jamais existé serait un fait fabriqué. */
    if (!cur) return out;
    out.segments = out.segments.concat([{
      segmentIndex: cur.segmentIndex,
      /* PAS de repli sur `activeCamera` : à la clôture, cette valeur vaut la
       * CIBLE, pas la caméra du segment que l'on clôt. Reprendre cette valeur
       * rattacherait le fichier à la mauvaise caméra. Un départ inconnu reste
       * inconnu. */
      camera: normalizeCamera(o.camera || cur.camera),
      path: (typeof o.path === "string" && o.path) ? o.path : cur.path,
      startedAtMs: cur.startedAtMs,
      stoppedAtMs: (typeof o.stoppedAtMs === "number") ? o.stoppedAtMs : 0,
      /* J09-08b2 : la clôture est CONFIRMÉE, le segment est donc `closed`. Un
       * échec antérieur reste porté par `failureCode`/`failedAtMs` : le fait
       * observé ne disparaît pas parce qu'un arrêt plus tard a réussi. */
      state: SEG.CLOSED,
      failureCode: cur.failureCode || "",
      failedAtMs: cur.failedAtMs || 0
    }]);
    out.currentSegment = null;
    return out;
  }

  /* ---------- J09-08b2 : ÉCHEC DE CLÔTURE ----------
   *
   * Le segment a EXISTÉ — son recorder a démarré, donc son index est brûlé —
   * mais sa clôture n'est pas confirmée : on ignore si le fichier a été
   * finalisé, et même s'il existe. Deux invariants tiennent ici, et ils sont
   * opposés à ceux d'une clôture :
   *
   *   1. le segment reste EN COURS (`currentSegment`) : il n'entre pas dans
   *      `segments[]`, donc l'historique ne présente jamais un fichier dont la
   *      fin est inconnue comme finalisé ;
   *   2. AUCUN index n'est consommé : `nextSegmentIndex()` repart du maximum
   *      observé, ce segment compris. Le prochain segment portera donc N+1, pas
   *      N+2 — un échec ne saute pas de numéro.
   *
   * Sans segment ouvert, il n'y a rien à échouer : on n'invente pas d'entrée. */
  function markSegmentFailed(state, info) {
    var o = info || {};
    var out = clone(state);
    var cur = out.currentSegment;
    if (!cur) return out;
    cur.state = SEG.FAILED;
    cur.failureCode = (typeof o.failureCode === "string") ? o.failureCode : "";
    cur.failedAtMs = (typeof o.failedAtMs === "number") ? o.failedAtMs : 0;
    /* Un chemin DÉJÀ connu est conservé : le fichier a été produit, il existe
     * donc — même si sa fin reste inconnue. Mais un chemin absent le reste :
     * on n'en fabrique aucun. */
    if (typeof o.path === "string" && o.path) cur.path = o.path;
    return out;
  }

  /* Mesure du trou d'image : `stopRecording()` à `restartAck`. C'est la seule
   * mesure qui compte pour la campagne physique (§35.3). */
  function recordSwitchDuration(state, durationMs, atMs) {
    var out = clone(state);
    var d = (typeof durationMs === "number" && durationMs >= 0) ? Math.round(durationMs) : 0;
    out.lastSwitchDurationMs = d;
    if (d > out.gapMaxMs) out.gapMaxMs = d;
    out.lastConfirmedAtMs = atMs;
    return out;
  }

  /* Rattachement au Take courant : le compteur de segments est propre à un
   * Take. Un nouveau Take repart à 0, sinon le segment N+1 porterait le numéro
   * d'un autre Take. */
  function attachToTake(state, sessionId, takeNumber, atMs) {
    var sid = sessionId || "";
    var tnum = (takeNumber == null || takeNumber === "") ? null : takeNumber;
    var out = clone(state);
    if (out.sessionId === sid && out.takeNumber === tnum) return out;
    out.sessionId = sid;
    out.takeNumber = tnum;
    /* Les SEGMENTS sont comptés par Take : un nouveau plan repart à 1, sinon
     * le segment N+1 porterait le numéro d'un autre Take, et l'historique
     * mélangerait deux plans sur un même écran. */
    out.currentSegment = null;
    out.segments = [];
    out.requestedCamera = "";
    out.switchingCamera = "";
    out.lastError = "";
    out.lastErrorCode = "";
    return out;
  }

  /* Inventaire reçu : `known:false` ne REMPLACE PAS un inventaire connu (le
   * natif peut répondre par une erreur transitoire ; effacer l'inventaire
   * rendrait tout device inutilisable jusqu'à la prochaine sonde). */
  function applyAvailability(state, probe) {
    var out = clone(state);
    if (!probe || probe.known !== true) return out;
    out.availableCameras = (probe.cameras || []).slice();
    return out;
  }

  /* Rattachement d'un état CONFIRMÉ observé (ex. au boot, ou relu depuis la
   * télémétrie d'un autre device). `trusted:true` n'est réservé qu'à une
   * lecture NATIVE : une valeur non fiable ne doit jamais écraser un fait. */
  function applyConfirmed(state, camera, atMs, trusted) {
    if (trusted !== true) return state;
    var c = normalizeCamera(camera);
    if (!c) return state;
    var out = clone(state);
    out.activeCamera = c;
    out.lastConfirmedAtMs = atMs || 0;
    return out;
  }

  function clone(state) {
    var out = {};
    for (var k in state) {
      if (Object.prototype.hasOwnProperty.call(state, k)) {
        var v = state[k];
        out[k] = (Array.isArray(v)) ? v.slice()
          : (v && typeof v === "object") ? clone(v)
            : v;
      }
    }
    return out;
  }

  /* ---------- vue ---------- */

  /* Rendue pour l'UI. `busy` = une opération physique est en cours : les
   * boutons sont alors neutralisés, mais l'état reste AFFICHÉ tel qu'il est. */
  function view(state, opts) {
    var st = state || createState("");
    var o = opts || {};
    return {
      deviceId: st.deviceId,
      sessionId: st.sessionId,
      takeNumber: st.takeNumber,
      availableCameras: (st.availableCameras || []).slice(),
      requestedCamera: st.requestedCamera,
      switchingCamera: st.switchingCamera,
      activeCamera: st.activeCamera,
      busy: !!st.switchingCamera,
      /* `segmentIndex` est l'IDENTITÉ du segment en cours (0 = rien en cours).
       * Les écrans et le réseau le lisent sous ce nom : ce n'est plus un
       * compteur de segments fermés. */
      segmentIndex: currentIndex(st),
      currentSegment: st.currentSegment ? clone(st.currentSegment) : null,
      segments: (st.segments || []).map(function (s) { return clone(s); }),
      /* J09-08b2 : l'état du segment EN COURS, lisible sans traverser
       * `currentSegment` ("" = rien en cours). Un écran doit pouvoir écrire
       * « enregistrement non confirmé » sans recalculer quoi que ce soit. */
      segmentState: st.currentSegment ? (st.currentSegment.state || "") : "",
      segmentCount: (st.segments || []).length + (st.currentSegment ? 1 : 0),
      switchCount: st.switchCount,
      failCount: st.failCount,
      lastError: st.lastError,
      lastErrorCode: st.lastErrorCode,
      lastErrorAtMs: st.lastErrorAtMs,
      lastCommandId: st.lastCommandId,
      lastRequestedAtMs: st.lastRequestedAtMs,
      lastConfirmedAtMs: st.lastConfirmedAtMs,
      lastSwitchDurationMs: st.lastSwitchDurationMs,
      gapMaxMs: st.gapMaxMs,
      /* `switching` n'est pas un booléen : l'UI doit pouvoir écrire
       * « bascule vers Selfie… » sans prétendre que c'est actif. */
      /* `cameraPhase`, PAS `phase` : la phase du START (IDLE/COUNTDOWN/REC) est
       * une AUTRE notion, fournie par le start-service. Sous le meme nom, la
       * diffusion `camera_state` partait avec « FRONT » comme phase — ce que la
       * supervision Master affichait tel quel. */
      cameraPhase: st.switchingCamera
        ? ("switching:" + st.switchingCamera)
        : (st.activeCamera ? ("active:" + st.activeCamera) : "unknown"),
      recording: o.recording === true
    };
  }

  /* Caméras que l'UI doit proposer : disponibles etKnownes, la caméra active
   * restant sélectionnée. Une liste vide = « aucune bascule possible », ce qui
   * est un refus honnête et non un écran vide sans explication. */
  function selectable(state) {
    var st = state || createState("");
    if (!Array.isArray(st.availableCameras)) return [];
    return st.availableCameras.filter(function (c) {
      return CAMERAS.indexOf(c) >= 0;
    }).map(function (c) {
      return { camera: c, label: label(c), active: st.activeCamera === c };
    });
  }

  global.MultiCamCameraSwitchModel = {
    CAMERAS: CAMERAS,
    ERR: ERR,
    /* J09-08b2 */
    SEG: SEG,
    normalizeCamera: normalizeCamera,
    label: label,
    createState: createState,
    availableFromRaw: availableFromRaw,
    hasCamera: hasCamera,
    isMemberOf: isMemberOf,
    validateAuthority: validateAuthority,
    validate: validate,
    beginSwitch: beginSwitch,
    confirmSwitch: confirmSwitch,
    failSwitch: failSwitch,
    openSegment: openSegment,
    closeCurrentSegment: closeCurrentSegment,
    markSegmentFailed: markSegmentFailed,
    currentIndex: currentIndex,
    nextSegmentIndex: nextSegmentIndex,
    recordSwitchDuration: recordSwitchDuration,
    attachToTake: attachToTake,
    applyAvailability: applyAvailability,
    applyConfirmed: applyConfirmed,
    selectable: selectable,
    view: view
  };
})(window);