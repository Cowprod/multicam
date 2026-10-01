/* MultiCam — J09-05 : modèle mémoire de la mosaïque Master.
 *
 * UNE SEULE QUESTION, une seule réponse : « quelles vignettes afficher, dans
 * quel ordre, avec quelle image ? ». Ce module y répond à partir de TROIS
 * sources, et ne touche à rien d'autre :
 *
 *   participants du plan de START   → QUELS slots existent, et dans quel ORDRE
 *   boîte de réception (J09-04)      → QUELLE image montre chaque vignette
 *   vivacité de la session (WS)     → la vignette est-elle en ligne
 *
 * Il ne connaît NI le DOM, NI le WebSocket, NI la caméra. C'est ce qui permet
 * de le tester seul, et c'est ce qui empêche la mosaïque de devenir un puits de
 * logique réseau (cf. `net/session-ws.js`, qui n'apprend rien de ce fichier).
 *
 * ---------- LE POINT DÉLICATEUX : L'ORDRE ----------
 *
 * Une mosaïque de régie sert à repérer « qui filme quoi ». Si l'ordre des
 * vignettes bougeait quand une Capture se déconnecte, quand elle revient, quand
 * elle s'arrête ou quand elle Renvoie une frame, l'opérateur perdrait le
 * repère au pire moment — et loxide de la grille deviendrait le premier
 * Federation d'occupation du moniteur.
 *
 * L'ordre vient donc d'UNE SEULE source : `participants[]` du plan de START,
 * c'est-à-dire la photo figée du Take. Il est écrit UNE FOIS dans `order[]` et
 * n'est plus jamais réordonné :
 *
 *   - un device PAS dans le plan        -> AUCUN slot (pas de vignette fantôme) ;
 *   - un device retiré du plan en cours -> son slot RESTE (le Take n'a pas changé) ;
 *   - un device apparu plus tard          -> AJOUTÉ EN FIN, jamais inséré au milieu.
 *
 * Aucun tri, à aucun moment, sur aucun critère dynamique (dernière frame,
 * connectivité, nom, état technique). `M16` verrouille cette règle.
 *
 * ---------- DÉCONNECTÉ ≠ ARRÊTÉ ----------
 *
 * `connected` décrit le lien WS. `status` décrit l'enregistreur. Les deux sont
 * stockés SÉPARÉMENT et ne se contaminent jamais : une Capture déconnectée
 * reste peut-être en train d'enregistrer, et l'inverse est vrai aussi. La
 * vignette d'une Capture hors ligne conserve son image, figée, en niveaux de
 * gris — c'est une information, pas une sanction.
 *
 * ---------- PLACEHOLDER ----------
 *
 * Un slot existe parce que le device PARTICIPE au Take, jamais parce qu'une
 * image est arrivée. Une Capture qui n'a pas encore envoyé de preview a donc
 * sa vignette, vide, avec un placeholder : l'absence d'image est un état
 * affichable, pas une vignette manquante.
 *
 * ---------- LE DEVICE LOCAL ----------
 *
 * Si ce Master est aussi une Capture du Take, il a sa vignette comme les
 * autres — mais il ne se reçoit pas sa propre image par le WS (le transport
 * J09-04 écarte déjà le self-loop : `selfSkipped`). Sa vignette ne porte donc
 * AUCUNE image réseau ; elle est identifiée par le seul `isLocal`, que l'UI
 * traduit par le contour coloré de la maquette. La source visuelle est la
 * preview native, déjà rendue en fond par le service de preview (§35.1).
 */

"use strict";
(function (global) {

  var S = {
    bound: false,
    localDid: "",
    getParticipants: null,     /* (sessionId) -> [{deviceId, deviceName, role}] */
    sessionId: "",
    takeNumber: 0,
    order: [],                /* deviceId, dans l'ordre FIGE du Take */
    byId: {},
    stats: null,
    listeners: []
  };

  function freshStats() {
    return {
      participantSyncs: 0,
      framesApplied: 0,
      framesIgnored: 0,        /* mauvais device / session / Take / seq périmée */
      livenessUpdates: 0,
      statusUpdates: 0
    };
  }

  function log() {
    try {
      var args = [];
      for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
      global.console.log(args.join(" "));
    } catch (e) {}
  }

  function nowMs() { return Date.now(); }

  function emitChange() {
    S.listeners.slice().forEach(function (fn) {
      try { fn(); } catch (e) { log("LIVE_MODEL_LISTENER_ERROR err=" + e); }
    });
  }

  /* Un participant qui NE FILME PAS n'a pas de vignette. Le rôle vient du plan
   * de START ; en son absence (plan ancien, test), on le assimile à une
   * Capture — mais un `storage` explicite, lui, est toujours écarté : un
   * disque n'a pas d'image à montrer. */
  function isCapture(p) {
    if (!p || !p.deviceId) return false;
    var role = p.role || p.sessionRole;
    if (!role) return true;
    return role === "capture";
  }

  function slotOf(did) { return S.byId[did] || null; }

  function newSlot(did, name) {
    return {
      sessionId: S.sessionId,
      take: S.takeNumber,
      deviceId: did,
      deviceName: name || did,
      isLocal: !!S.localDid && did === S.localDid,
      status: "REC",         /* il participe à un Take en cours d'enregistrement */
      lastFrame: null,        /* PAS d'image tant qu'aucune preview n'est arrivée */
      lastFrameSeq: 0,
      lastFrameAt: 0,
      /* `connected` : le device local est Joignable par construction, un device
       * distant ne l'est pas tant que le WS ne l'a pas prouvé. On ne suppose
       * JAMAIS une Capture distante connectée. */
      connected: !!S.localDid && did === S.localDid
    };
  }

  /* ---------- API ---------- */

  function bind(options) {
    var o = options || {};
    if (o.localDid !== undefined) S.localDid = o.localDid || "";
    if (typeof o.getParticipants === "function") S.getParticipants = o.getParticipants;
    S.bound = true;
    if (!S.stats) S.stats = freshStats();
    log("LIVE_MODEL_READY localDid=" + (S.localDid || "—") + " policy=take_order_frozen");
    return view();
  }

  /* Changement de Take : on repart d'une grille NEUVE. Aucun reliquat — une
   * image du Take précédent affichée dans le suivant serait un bug grave. */
  function setTake(sessionId, takeNumber) {
    var sid = sessionId || "";
    var take = (typeof takeNumber === "number") ? takeNumber : 0;
    if (S.sessionId === sid && S.takeNumber === take) return view();
    S.sessionId = sid;
    S.takeNumber = take;
    S.order = [];
    S.byId = {};
    S.stats = freshStats();
    log("LIVE_TAKE_SET sessionId=" + (sid || "—") + " take=" + take + " slots_reset=1");
    emitChange();
    return view();
  }

  /* (Re)lit les participants du plan. AJOUTE ceux qui manquent, en fin de
   * grille, et ne touche à rien d'autre : ni retrait, ni réordonnancement. */
  function syncParticipants(list) {
    if (!S.sessionId) return view();
    var src = Array.isArray(list) ? list
      : (typeof S.getParticipants === "function" ? S.getParticipants(S.sessionId) : []);
    var incoming = Array.isArray(src) ? src : [];
    var added = 0;
    incoming.forEach(function (p) {
      if (!isCapture(p)) return;
      var did = p.deviceId;
      if (S.byId[did]) {
        /* Le nom peut arriver plus tard : on l'adopte, ça ne bouge RIEN à
         * l'ordre (le nom est un libellé, pas une clé de tri). */
        if (p.deviceName && S.byId[did].deviceName !== p.deviceName) {
          S.byId[did].deviceName = p.deviceName;
        }
        return;
      }
      S.byId[did] = newSlot(did, p.deviceName);
      S.order.push(did);
      added++;
    });
    S.stats.participantSyncs += 1;
    if (added) {
      log("LIVE_SLOTS_ADDED sessionId=" + S.sessionId + " take=" + S.takeNumber
        + " added=" + added + " order=[" + S.order.join(",") + "]");
      emitChange();
    }
    return view();
  }

  /* Une preview acceptée par la boîte de réception. Le filtrage est ici, et il
   * est STRICT : la bonne image dans la mauvaise vignette est le pire défaut
   * possible d'une mosaïque, donc tout ce qui n'est pas exactement « ce Take,
   * cette Capture » est ignoré ET compté (un rejet muet serait indiscernable
   * d'une panne). */
  function onPreviewFrame(frame) {
    if (!frame || typeof frame !== "object") { S.stats.framesIgnored += 1; return false; }
    if (!S.sessionId || !S.takeNumber) { S.stats.framesIgnored += 1; return false; }
    if (frame.sessionId !== S.sessionId || (frame.takeNumber || 0) !== S.takeNumber) {
      S.stats.framesIgnored += 1;
      log("LIVE_FRAME_IGNORED reason=other_session_or_take"
        + " slotSession=" + S.sessionId + " take=" + S.takeNumber
        + " frameSession=" + (frame.sessionId || "—") + " frameTake=" + (frame.takeNumber || 0)
        + " from=" + (frame.deviceId || "—"));
      return false;
    }
    var slot = slotOf(frame.deviceId);
    if (!slot) {
      /* Capture hors Take : on n'invente surtout pas de vignette. */
      S.stats.framesIgnored += 1;
      log("LIVE_FRAME_IGNORED reason=not_in_take from=" + (frame.deviceId || "—")
        + " sessionId=" + (frame.sessionId || "—") + " take=" + (frame.takeNumber || 0)
        + " participants=[" + S.order.join(",") + "]");
      return false;
    }
    if (typeof frame.seq === "number" && frame.seq <= slot.lastFrameSeq) {
      /* Rejeu ou ordre inversé : garder l'image la plus récente, sans
       * redescendre en arrière (une reconnexion peut rejouer un tampon). */
      S.stats.framesIgnored += 1;
      return false;
    }
    slot.lastFrame = frame;
    slot.lastFrameSeq = frame.seq || slot.lastFrameSeq + 1;
    slot.lastFrameAt = nowMs();
    /* Une image reçue PRUVE la connectivité, même si le WS n'a pas encore
     * signalé la présence : c'est une preuve plus forte qu'un socket ouvert. */
    slot.connected = true;
    S.stats.framesApplied += 1;
    emitChange();
    return true;
  }

  /* Perte/reprise du lien WS. Ne retire JAMAIS un slot, ne le déplace JAMAIS,
   * et ne touche pas à l'image : « déconnecté » décrit le lien, pas l'état de
   * l'enregistreur. */
  function setLiveness(deviceId, connected) {
    var slot = slotOf(deviceId);
    if (!slot) return false;
    var v = !!connected;
    if (slot.connected === v) return true;
    slot.connected = v;
    S.stats.livenessUpdates += 1;
    log("LIVE_LIVENESS sessionId=" + S.sessionId + " take=" + S.takeNumber
      + " deviceId=" + deviceId + " connected=" + v
      + " frameFigee=" + (slot.lastFrameSeq || "—"));
    emitChange();
    return true;
  }

  /* Applique un état de vivacité à TOUS les slots connus (un seul aller-retour
   * vers le WS suffit : la liste fait foi). */
  function syncLiveness(map) {
    if (!map || typeof map !== "object") return view();
    Object.keys(S.byId).forEach(function (did) {
      setLiveness(did, !!map[did]);
    });
    return view();
  }

  /* État RECORDER d'un device (STOPPED local, WARNING, ERROR). distinct de la
   * connectivité : les deux sont conservés séparément. */
  function setStatus(deviceId, status) {
    var slot = slotOf(deviceId);
    if (!slot || !status || slot.status === status) return false;
    slot.status = status;
    S.stats.statusUpdates += 1;
    log("LIVE_STATUS sessionId=" + S.sessionId + " take=" + S.takeNumber
      + " deviceId=" + deviceId + " status=" + status
      + " connected=" + slot.connected);
    emitChange();
    return true;
  }

  /* ---------- état AFFICHABLE ----------
   *
   * Pur, sans DOM : la mosaïque s'en sert, et les tests assertent dessus. La
   * RÈGLE : la perte de connexion PRIME sur l'état recorder, parce que c'est
   * l'information la plus récente et la moins contestable. L'inverse serait
   * le pire : afficher « REC » à une Capture dont on ne sait plus rien. */
  function displayStateOf(slot) {
    if (!slot) return "UNKNOWN";
    if (!slot.connected) return "DECONNECTED";
    if (slot.status === "STOPPED") return "STOPPED";
    if (slot.status === "WARNING") return "WARNING";
    if (slot.status === "ERROR") return "ERROR";
    return "REC";
  }

  function slotView(slot) {
    var out = {
      sessionId: slot.sessionId,
      take: slot.take,
      deviceId: slot.deviceId,
      deviceName: slot.deviceName,
      isLocal: slot.isLocal,
      status: slot.status,
      lastFrame: slot.lastFrame,
      lastFrameSeq: slot.lastFrameSeq,
      lastFrameAt: slot.lastFrameAt,
      connected: slot.connected,
      displayState: displayStateOf(slot),
      /* Une vignette SANS image est un état affichable (placeholder), pas une
       * vignette manquante : l'UI s'en sert pour ne jamais dessiner de vide. */
      hasFrame: !!slot.lastFrame
    };
    return out;
  }

  function view() {
    var slots = S.order.map(function (did) {
      return slotOf(did) ? slotView(slotOf(did)) : null;
    }).filter(function (s) { return !!s; });
    return {
      bound: S.bound,
      sessionId: S.sessionId,
      takeNumber: S.takeNumber,
      localDid: S.localDid,
      /* L'ordre est exposé tel quel : l'UI doit pouvoir constater qu'il ne
       * bouge pas, et un test doit pouvoir l'asserter. */
      order: S.order.slice(),
      slots: slots,
      stats: {
        participantSyncs: S.stats.participantSyncs,
        framesApplied: S.stats.framesApplied,
        framesIgnored: S.stats.framesIgnored,
        livenessUpdates: S.stats.livenessUpdates,
        statusUpdates: S.stats.statusUpdates,
        placeholders: slots.filter(function (s) { return !s.hasFrame; }).length
      }
    };
  }

  function onChange(fn) {
    if (typeof fn === "function" && S.listeners.indexOf(fn) < 0) S.listeners.push(fn);
    return fn;
  }

  function reset() {
    S.order = [];
    S.byId = {};
    S.stats = freshStats();
    emitChange();
  }

  global.MultiCamLiveModel = {
    bind: bind,
    setTake: setTake,
    syncParticipants: syncParticipants,
    onPreviewFrame: onPreviewFrame,
    setLiveness: setLiveness,
    syncLiveness: syncLiveness,
    setStatus: setStatus,
    displayStateOf: displayStateOf,
    view: view,
    onChange: onChange,
    reset: reset,
    /* Utilisé par les tests : accès à l'état brut sans passer par une copie. */
    _state: S
  };

})(window);
