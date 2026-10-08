/* MultiCam — transport WebSocket de session (J04 + J05).
 *
 * Séparation stricte (décision 30.5) :
 *   - modèle de session pur          → MultiCamSessionModel (js/state/session-model.js)
 *   - persistance locale             → MultiCamSessionStore (js/state/session-store.js)
 *   - brique serveur générique       → cordova.plugins.wsserver (plugin qualifié C2, AUCUNE
 *     logique MultiCam dans le plugin — décision 30.10)
 *   - TRANSPORT + protocole J04/J05  → ce module (JS, logique applicative)
 *
 * Responsabilités :
 *   - serveur WebSocket par device avec repli de port 45102..45111 (Partie A :
 *     onFailure + failure exec → port suivant, succès → port effectif publié) ;
 *   - client WebSocket standard vers les autres Masters ;
 *   - enveloppes versionnées {v=1, kind, from, sessionId, ts, seq} ;
 *   - messages : sync (state complet), sync_please, join_req, join_ok, join_nack,
 *     ping/pong (heartbeat/liveness §30.4/30.8), et depuis J05 :
 *     member_add, member_update, member_remove (gestion des members/sessionRoles) ;
 *   - routage (et rien d'autre) des messages J08 start_plan, start_cancel,
 *     start_state, start_probe, start_probe_reply vers le pont start-service ;
 *   - broadcast du sharedView (jamais le PIN) aux Masters connectés ;
 *   - convergence par fusion §30.9 + §31 (closed>open, LMW nom, PIN immuable,
 *     masters par deviceId, members par deviceId avec sessionRoles validés).
 *
 * Journalisation parsable : WS_*, FALLBACK, JOIN_*, SYNC_*, RENAME_*,
 * SESSION_CLOSE_*, MEMBER_*, PEER_*, START_TRANSPORT_* (voir AGENTS.md —
 * exigence journalisation distribuée).
 *
 * Rappel de responsabilité (décision 30.10) : ce module ne connaît NI le plan
 * de START, NI les offsets, NI l'arbitrage. Il transmet fidèlement et signale
 * les enveloppes malformées ; la logique J08 vit dans start-model (pur) et
 * start-service (application).
 */

(function (global) {
  "use strict";

  var PROTOCOL_VERSION = 1;
  var WS_BASE_PORT = 45102;
  var WS_PORT_WINDOW = 9;                    /* 45102..45111 (Partie A) */
  var HB_INTERVAL_MS = 2000;
  var HB_TIMEOUT_MS = 8000;

  /* ---------- reprise automatique d'une connexion client (J09) ----------
   *
   * AVANT : `ws.onclose` supprimait l'entrée de `clientConns` et s'arrêtait là.
   * Les seuls chemins de re-dial étaient explicites (`reSyncSession()`,
   * `inviteAddedDevice()`, `joinSession()`, boucle de boot de `main.js`) : après
   * une coupure réseau, la présence par session ne se reconstruisait JAMAIS
   * seule et les previews ne repartaient pas — la maquette exige l'inverse
   * (« reconnexion réseau → même slot → reprise des previews »).
   *
   * CHOIX : la boucle de retry est indexée par ENDPOINT (un endpoint = un pair
   * global, éventuellement plusieurs sessions), jamais par session — sinon un
   * Master multi-sessions déclencherait N dialers concurrents vers le même hôte.
   * Le « pair est-il encore voulu ? » n'est PAS une comptabilité à part : il se
   * déduit des sessions OUVERTES qui référencent cet endpoint. Une session fermée
   * fait donc tomber la boucle toute seule, sans état à resynchroniser.
   *
   * Bornes : le délai croît (500 → 1000 → 2000 → 5000 ms) et reste plafonné à
   * 5 s ; le retry est annulé dès qu'un dial explicite arrive, dès l'ouverture
   * du socket, et à l'arrêt du serveur. Un dial qui ne s'ouvre pas est abandonné
   * après `DIAL_TIMEOUT_MS` (même valeur que le timeout d'invitation) : sans
   * lui, un pair injoignable laisserait le dialer suspendu indéfiniment et
   * aucun retry ne partirait jamais.
   */
  var RETRY_STEPS_MS = [500, 1000, 2000, 5000];
  var RETRY_CAP_MS = 5000;
  var DIAL_TIMEOUT_MS = 4000;

  function emit(line) { console.log(line); }

  function nowMs() { return Date.now(); }

  function model() { return global.MultiCamSessionModel; }
  function store() { return global.MultiCamSessionStore; }

  /* Égalité SÉMANTIQUE de deux copies de session (champs qui forment la
   * convergence partagée). updatedAtMs est du métadonnée (chaque save le
   * re-horodate) : une simple re-save provoquerait un écho permanent
   * sync → changed → sync. Une égalité sémantique → NOOP (pas de save, pas de
   * ré-annonce, pas de notifyChanged). */
  function semanticEqual(a, b) {
    if (!a || !b) return false;
    if (a.state !== b.state || a.stateUpdatedMs !== b.stateUpdatedMs || a.stateByDeviceId !== b.stateByDeviceId) return false;
    if (a.name !== b.name || a.nameUpdatedMs !== b.nameUpdatedMs || a.nameByDeviceId !== b.nameByDeviceId) return false;
    var am = a.masters || [], bm = b.masters || [];
    if (am.length !== bm.length) return false;
    for (var i = 0; i < am.length; i++) {
      if (am[i].deviceId !== bm[i].deviceId) return false;
      if ((am[i].endpoint || "") !== (bm[i].endpoint || "")) return false;
    }
    /* J05 — membres + tombstones : toute différence sémantique = propagation. */
    var aMem = a.members || [], bMem = b.members || [];
    if (aMem.length !== bMem.length) return false;
    for (var j = 0; j < aMem.length; j++) {
      var ma = aMem[j], mb = bMem[j];
      if (ma.deviceId !== mb.deviceId) return false;
      if (ma.deviceName !== mb.deviceName) return false;
      if ((ma.enabledSkills || []).join(",") !== (mb.enabledSkills || []).join(",")) return false;
      if ((ma.sessionRoles || []).join(",") !== (mb.sessionRoles || []).join(",")) return false;
      if (ma.addedAtMs !== mb.addedAtMs) return false;
      if (ma.roleUpdatedMs !== mb.roleUpdatedMs) return false;
      /* J06 — télémétrie auto-déclarée : une MAJ de télémétrie doit se propager
       * (sinon l'écran 05 du peer garde cap/batterie périmés). */
      if (JSON.stringify(ma.telemetry || null) !== JSON.stringify(mb.telemetry || null)) return false;
    }
    var ar = a.removedMembers || {}, br = b.removedMembers || {};
    var ak = Object.keys(ar).sort(), bk = Object.keys(br).sort();
    if (ak.length !== bk.length) return false;
    for (var k = 0; k < ak.length; k++) {
      if (ak[k] !== bk[k]) return false;
      if ((ar[ak[k]].removedAtMs || 0) !== (br[ak[k]].removedAtMs || 0)) return false;
    }
    /* J06 — Takes de la session : toute différence sémantique (sélections,
     * réglages, overrides, métadonnées LMW) doit se propager. */
    var aT = (a.takes || []).map(function (t) { return JSON.stringify(t); });
    var bT = (b.takes || []).map(function (t) { return JSON.stringify(t); });
    return JSON.stringify(aT) === JSON.stringify(bT);
  }

  function wsserver() {
    return (global.cordova && global.cordova.plugins && global.cordova.plugins.wsserver) || null;
  }

  var state = {
    serverRunning: false,
    effectivePort: -1,
    serverConns: {},       /* uuid -> { uuid, remoteAddr, peerDid, sessionId } (acceptés) */
    serverSidToAm: {},     /* am_i_master? unused — kept for future per-conn roles */
    clientConns: {},       /* endpoint "host:port" -> { ws, did, sessionId, lastRxMs, closed } */
    hbTimer: null,
    listeners: [],
    pendingJoin: null,   /* { sid, host, port, ok, reason, atMs } — consommé par l'écran 02 */
    localDid: null,
    localName: "",
    selfEndpoint: "",      /* "ip:effectivePort" (best-effort, rempli au start) */
    advertisedKey: {},     /* sessionId -> dernier TXT publié (dédup des ré-annonces) */
    lastResyncAt: {},      /* anti-écho PAR SESSION : sid -> dernier sync_please (convergence) */
    txtRepublished: false, /* le TXT device a déjà été republié avec wsep */
    clientRetry: {},       /* key "host:port" -> { backoffMs, timer } — retry de reconnexion */
    foreground: true,      /* false en arrière-plan : plus de retry, reprise au resume */
    lifecycleBound: false, /* pause/resume déjà branchés sur le document */
    armBridge: null,       /* J07 : pont ARM (arm-service), voit pas de logique ARM ici */
    startBridge: null,     /* J08 : pont START (start-service) — idem, zéro logique ici */
    previewBridge: null,  /* J09 : pont PREVIEW (preview-inbox) — idem, zéro logique ici */
    cameraBridge: null   /* J09-07 : pont CAMERA (camera-switch-service) — idem */
  };

  var _ipCache = "";       /* IPv4 synchrone (warm-up asynchrone via MultiCamNative) */

  function notifyChanged() {
    state.listeners.slice().forEach(function (fn) { fn(); });
  }

  /* ---------- présence par session sur une connexion multiplexée ----------
   *
   * MODÈLE : une connexion WS physique représente UN PAIR GLOBAL, pas une
   * session. `connectTo()` indexe les connexions client par endpoint
   * "host:port", et `reSyncSession()` rappelle `connectTo(host, port)` pour
   * CHAQUE session d'un même Master : une seule connexion sert donc plusieurs
   * sessions, chacune discriminée par le `sessionId` de son enveloppe.
   *
   * L'appartenance est donc un ENSEMBLE (`sessions`, sid -> dernier rx), et non
   * un scalaire `sessionId` réécrit à chaque message reçu. Le scalaire faisait
   * deux choses fausses : la présence disparaissait de `connectedPeers` pour les
   * sessions.transportées mais non parlées en dernier, ET `broadcast()` skippait
   * le pair pour ces mêmes sessions — perte de messages réelle.
   *
   * `sessions === null` = connexion jamais marquée (avant tout message
   * identifiant une session) : fail-open historique conservé.
   */
  function markSession(entry, sid, now) {
    if (!entry || !sid) return;
    if (!entry.sessions) entry.sessions = {};
    entry.sessions[sid] = now;
  }

  function inSession(entry, sid) {
    if (!entry) return false;
    if (!entry.sessions) return true;   /* jamais marquée : fail-open historique */
    return !!entry.sessions[sid];
  }

  function cfg() {
    return (global.MultiCamConfig && global.MultiCamConfig.get) ? global.MultiCamConfig.get() : null;
  }

  /* `state.localDid` n'est renseigné qu'à l'`init()`. Une frame émise avant
   * l'init (boot, écran non initialisé, test) n'aurait sinon ni `from` ni
   * détection du self-loop : on retombe sur la config, comme le fait le reste
   * du fichier. */
  function localDid() {
    return state.localDid || (cfg() ? cfg().deviceId : "") || "";
  }

  /* ---------- endpoint / interfaces ---------- */

  function localIpv4() {
    var st = (global.MultiCamDiscovery && global.MultiCamDiscovery.status) ? global.MultiCamDiscovery.status() : {};
    if (st && st.ipv4) return st.ipv4;
    return _ipCache || "";
  }

  /* Cache synchrone de l'IPv4 (MultiCamNative.ipv4() est asynchrone). Défendu :
   * on n'accepte qu'une chaîne "1.2.3.4" réelle — jamais un objet/Promise. */
  function warmIpCache() {
    if (!global.MultiCamNative || !global.MultiCamNative.ipv4) return;
    try {
      global.MultiCamNative.ipv4().then(function (ip) {
        if (typeof ip === "string" && ip && ip.indexOf(":") < 0 && ip.indexOf(" ") < 0) {
          _ipCache = ip;
          refreshSelfEndpoint();
        }
      }).catch(function () {});
    } catch (e) {}
  }

  function refreshSelfEndpoint() {
    if (state.effectivePort > 0) {
      var ip = localIpv4();
      /* défense : l'IPv4 peut arriver de source asynchrone ; on n'accepte qu'une
       * chaîne réelle (jamais un objet/Promise qu'une mauvaise API pourrait donner). */
      if (typeof ip === "string" && ip && ip.indexOf(":") < 0 && ip.indexOf(" ") < 0) {
        state.selfEndpoint = ip + ":" + state.effectivePort;
      }
    }
    return state.selfEndpoint;
  }

  /* ---------- handlers serveur ---------- */

  function srvOnOpen(conn) {
    state.serverConns[conn.uuid] = {
      uuid: conn.uuid,
      remoteAddr: conn.remoteAddr || "",
      resource: conn.resource || "",
      peerDid: null,
      sessions: null,      /* sid -> dernier rx ; null = jamais marquée (fail-open) */
      anonymous: true,
      lastRxMs: nowMs()
    };
    emit("WS_CONN_OPEN uuid=" + conn.uuid.substr(0, 8) + "… remote=" + conn.remoteAddr + " res=" + conn.resource);
    notifyChanged();
  }

  function srvOnMsg(conn, msg) {
    var entry = state.serverConns[conn.uuid];
    if (entry) entry.lastRxMs = nowMs();
    if (typeof msg === "string") handleServerText(conn, msg);
    else emit("WS_DROP kind=binary reason=unsupported_j04 uuid=" + (conn.uuid || "?").substr(0, 8) + "…");
  }

  function srvOnClose(conn, code, reason, wasClean) {
    var entry = state.serverConns[conn.uuid];
    delete state.serverConns[conn.uuid];
    var did = entry ? entry.peerDid : "";
    emit("WS_CONN_CLOSE uuid=" + (conn.uuid || "?").substr(0, 8) + "… code=" + code
      + " reason=" + reason + " clean=" + (wasClean ? 1 : 0)
      + (did ? " did=" + did : ""));
    if (did) {
      emit("PEER_DISCONNECTED did=" + did + " reason=ws_close");
    }
    notifyChanged();
  }

  /* ---------- serveur : repli de port (mécano Partie A qualifiée) ---------- */

  /* Démarre le serveur WebSocket avec repli séquentiel base..base+fenêtre.
   * Résout avec { port } — ne rejette que si TOUTE la fenêtre est occupée.
   * On réutilise comme signal d'échec : onFailure ET la failure exec (les deux
   * avancent au port suivant, `settled` évite le double-déclenchement). */
  function startServer() {
    var ws = wsserver();
    if (!ws) {
      emit("WS_ERROR code=wsserver_unavailable");
      return Promise.reject(new Error("wsserver_unavailable"));
    }
    if (state.serverRunning) return Promise.resolve({ port: state.effectivePort });

    var base = WS_BASE_PORT;
    var win = WS_PORT_WINDOW;
    var idx = 0;
    var tried = [];
    var t0 = nowMs();

    return new Promise(function (resolve, reject) {
      var attempt = function () {
        var port = base + idx;
        if (idx > win) {
          emit("WS_FALLBACK_EXHAUSTED base=" + base + " tried=" + JSON.stringify(tried) + " total=" + (nowMs() - t0) + "ms");
          reject(new Error("no_free_ws_port"));
          return;
        }
        var ta = nowMs();
        var settled = false;
        var onAccept = srvOnOpen;
        var onMsg = srvOnMsg;
        var onClose = srvOnClose;
        var onFailure = function (addr, p, reason) {
          if (p !== port) return;
          advance("onFailure:" + reason);
        };
        var advance = function (tag) {
          if (settled) return;
          settled = true;
          tried.push(":" + port + "(" + tag + "," + (nowMs() - ta) + "ms)");
          emit("WS_FALLBACK_BUSY port=" + port + " via=" + tag + " dt=" + (nowMs() - ta) + "ms");
          idx++;
          attempt();
        };

        ws.start(port, {
          origins: null,
          protocols: null,
          tcpNoDelay: true,
          onOpen: onAccept,
          onMessage: onMsg,
          onClose: onClose,
          onFailure: onFailure
        }, function (addr, effectivePort) {
          settled = true;
          state.serverRunning = true;
          state.effectivePort = effectivePort;
          emit("WS_EFFECTIVE_PORT port=" + effectivePort + " addr=" + addr
            + " attempts=" + JSON.stringify(tried) + " total=" + (nowMs() - t0) + "ms");
          startHeartbeat();
          refreshSelfEndpoint();
          /* L'endpoint de transport n'est connu qu'ici : on republie le TXT device
           * pour qu'un pair puisse nous dialer (§31.2). */
          republishDeviceTxt();
          resolve({ port: effectivePort });
        }, function (err) {
          advance("execcb:" + JSON.stringify(err));
        });
      };
      attempt();
    });
  }

  /* Republie l'annonce device (_multicam._tcp.) pour y faire figurer l'endpoint
   * de transport de session. Best-effort : l'invitation §31.2 reste possible si
   * le republi échoue (l'endpoint est alors relu à l'ajout du membre). */
  function republishDeviceTxt() {
    var d = global.MultiCamDiscovery;
    if (!d || typeof d.reannounce !== "function") return;
    if (state.txtRepublished) return;
    state.txtRepublished = true;
    try {
      d.reannounce();
    } catch (e) {
      emit("WS_TXT_REPUBLISH_ERROR err=" + String((e && e.message) || e));
    }
  }

  function stopServer() {
    var ws = wsserver();
    if (!ws) return;
    if (state.serverRunning) {
      try { ws.stop(function () {}, function () {}); } catch (e) {}
    }
    stopHeartbeat();
    /* Les retries programmés appartiennent au serveur arrêté : les laisser
     * tourner rouvrirait des sockets alors que l'app a tout fermé. */
    cancelAllRetries();
    state.serverRunning = false;
    state.effectivePort = -1;
    state.serverConns = {};
    state.clientConns = {};
    emit("WS_SERVER_STOP reason=app");
    notifyChanged();
  }

  /* ---------- reconnexion automatique (client) ----------
   *
   * Toutes les fonctions ci-dessous vivent dans la couche transport : aucun
   * écran, aucun panneau, aucun état de navigation n'intervient, et ce fichier
   * reste un transport pur (garde T12). Les couches au-dessus n'ont rien à
   * savoir de la reprise : elles observent `connectedPeers()` et le heartbeat,
   * qui convergent dès que la session a été re-synchronisée. */

  function retryOf(key) {
    if (!state.clientRetry[key]) state.clientRetry[key] = { backoffMs: 0, timer: null };
    return state.clientRetry[key];
  }

  function cancelRetry(key) {
    var r = state.clientRetry[key];
    if (!r || !r.timer) return;
    clearTimeout(r.timer);
    r.timer = null;
    emit("WS_RETRY_CANCEL endpoint=" + key);
  }

  function cancelAllRetries() {
    Object.keys(state.clientRetry).forEach(cancelRetry);
    state.clientRetry = {};
  }

  /* Sessions OUVERTES qui référencent cet endpoint, soit comme Master connu
   * (notre dial vers un esclave), soit comme pair connu. C'est l'unique
   * définition de « endpoint encore voulu » : pas de comptabilité parallèle à
   * resynchroniser, et une session fermée fait tomber la boucle toute seule. */
  function openSessionsFor(key) {
    var st = store();
    if (!st || typeof st.list !== "function") return Promise.resolve([]);
    return Promise.resolve(st.list()).catch(function () { return []; }).then(function (list) {
      return (list || []).filter(function (s) {
        if (!s || s.state !== "open" || !s.sessionId) return false;
        var pools = [s.masters || [], s.members || []];
        for (var i = 0; i < pools.length; i++) {
          for (var j = 0; j < pools[i].length; j++) {
            if (pools[i][j] && pools[i][j].endpoint === key) return true;
          }
        }
        return false;
      });
    });
  }

  function hostPortOf(key) {
    var i = key.lastIndexOf(":");
    if (i <= 0) return null;
    return { host: key.slice(0, i), port: parseInt(key.slice(i + 1), 10) };
  }

  /* Après (re)connexion physique : re-synchroniser TOUTES les sessions portées
   * par cet endpoint. Leur quota d'anti-écho est purgé : il n'existe que pour
   * amortir les échos d'une connexion VIVANTE, et une connexion neuve n'a aucun
   * écho à amortir. Le garder bloquerait la reconstruction de présence. */
  function reSyncSessionsFor(key) {
    return openSessionsFor(key).then(function (list) {
      if (!list.length) return 0;
      var n = 0;
      list.forEach(function (s) {
        delete state.lastResyncAt[s.sessionId];
        reSyncSession(s);
        n++;
      });
      /* Direction Master→Capture (D4) : le resync ci-dessus ne s'adresse qu'aux
       * MASTERS (auto-dial + primage). Si cet endpoint porte un MEMBRE — par ex.
       * une Capture rejointe par invitation — le socket restauré resterait
       * anonyme côté serveur (peerDid jamais renseigné, aucun camera_state ne
       * repartirait). On lui envoie donc un sync_please DIRIGÉ : le pair répond
       * par son état, ce qui identifie la connexion et republie les états
       * captifs. Primitive existante, SNAPSHOT idempotent — aucun compteur ni
       * commande rejoué, anti-replay conservé. */
      list.forEach(function (s) {
        var peerDid = peerDidOfEndpoint(s, key);
        if (peerDid && peerDid !== state.localDid && !isMasterDevice(s, peerDid)) {
          var sent = sendClient(key, envelope("sync_please", s.sessionId, {}));
          emit(sent
            ? "SYNC_PLEASE_SENT sessionId=" + s.sessionId + " to=" + peerDid + " endpoint=" + key + " note=redialed_member"
            : "SYNC_PLEASE_DROP sessionId=" + s.sessionId + " endpoint=" + key + " reason=socket_not_open");
        }
      });
      emit("WS_RESYNC_SESSIONS endpoint=" + key + " sessions=" + n
        + " ids=" + JSON.stringify(list.map(function (s) { return s.sessionId; })));
      return n;
    }).catch(function (e) {
      emit("WS_RESYNC_ERROR endpoint=" + key + " err=" + String((e && e.message) || e));
      return 0;
    });
  }

  function scheduleRetry(key, reason) {
    if (!state.foreground) {
      emit("WS_RETRY_SKIP endpoint=" + key + " reason=background");
      return;
    }
    var hp = hostPortOf(key);
    if (!hp) {
      emit("WS_RETRY_SKIP endpoint=" + key + " reason=bad_endpoint");
      return;
    }
    /* Un dial explicite peut être en vol ou une connexion déjà ouverte : dans les
     * deux cas il n'y a rien à rattraper. */
    var live = state.clientConns[key];
    if (live && live.ws && (live.ws.readyState === WebSocket.OPEN || live.ws.readyState === WebSocket.CONNECTING)) {
      emit("WS_RETRY_SKIP endpoint=" + key + " reason=already_" + (live.ws.readyState === WebSocket.OPEN ? "open" : "connecting"));
      return;
    }
    openSessionsFor(key).then(function (list) {
      if (!list.length) {
        emit("WS_RETRY_SKIP endpoint=" + key + " reason=no_open_session");
        return;
      }
      /* `openSessionsFor()` est asynchrone : l'app a pu passer en arrière-plan
       * entre l'appel et ici. Re-contrôler au moment d'ARMER le timer, sinon un
       * retry programmé juste avant `pause` partirait quand même en fond
       * d'écran — exactement ce que la pause doit interdire. */
      if (!state.foreground) {
        /* L'endpoint reste RÉPERTORIÉ sans timer : c'est la seule mémoire qui
         * permet au `resume` de savoir quoi rouvrir. L'oublier ici rendrait la
         * reprise au premier plan impossible après un simple passage en fond. */
        retryOf(key);
        emit("WS_RETRY_SKIP endpoint=" + key + " reason=background");
        return;
      }
      var r = retryOf(key);
      var delay = r.backoffMs || RETRY_STEPS_MS[0];
      r.backoffMs = Math.min(RETRY_CAP_MS, delay);
      r.timer = setTimeout(function () {
        r.timer = null;
        emit("WS_RETRY_ATTEMPT endpoint=" + key + " attempt_delay=" + r.backoffMs + "ms reason=" + reason);
        /* La progression du backoff appartient à l'ÉCHEC, pas à l'attente : un
         * dial réussi remet le compteur à zéro (cf. `ws.onopen`). */
        r.backoffMs = Math.min(RETRY_CAP_MS,
          r.backoffMs >= RETRY_STEPS_MS[RETRY_STEPS_MS.length - 1]
            ? RETRY_CAP_MS
            : (RETRY_STEPS_MS.filter(function (d) { return d > r.backoffMs; })[0] || RETRY_CAP_MS));
        connectTo(hp.host, hp.port, true).then(function () {
          /* La reconnexion physique est faite : la présence se reconstruit par
           * le reSync des sessions transportées par ce socket. */
        }, function () {
          /* Échec : le watchdog du dial ou son onclose réarmera le backoff. */
        });
      }, delay);
      emit("WS_RETRY_SCHEDULE endpoint=" + key + " delay=" + delay + "ms reason=" + reason
        + " sessions=" + list.length);
    });
  }

  /* Cycle de vie Android : en arrière-plan on ne martèle pas le réseau ; au
   * retour au premier plan on rouvre immédiatement (le réseau a souvent changé
   * d'IP ou de Wi-Fi entre-temps). */
  function onLifecycle(foreground) {
    if (state.foreground === foreground) return;
    state.foreground = foreground;
    emit("WS_LIFECYCLE foreground=" + (foreground ? 1 : 0));
    if (!foreground) {
      Object.keys(state.clientRetry).forEach(cancelRetry);
      return;
    }
    /* Au resume : une seule tentative par endpoint, et le backoff repart de zéro
     * (le réseau est revenu, inutile d'attendre le délai de la coupure). Même
     * filtre que le retry : une session fermée pendant le passage en fond ne
     * doit pas ressusciter un dial. */
    Object.keys(state.clientRetry).forEach(function (key) {
      var hp = hostPortOf(key);
      if (!hp) return;
      openSessionsFor(key).then(function (list) {
        if (!list.length || !state.foreground) return;
        state.clientRetry[key].backoffMs = 0;
        emit("WS_RESUME_DIAL endpoint=" + key + " sessions=" + list.length);
        connectTo(hp.host, hp.port);
      });
    });
  }

  /* Endpoints dont le socket a été OUVERT puis perdu : la prochaine ouverture
   * est une RECONNEXION et doit donc déclencher le reSync de rattrapage. La
   * première ouverture d'une connexion ne le doit pas : elle est déjà couverte
   * par son appelant (reSyncSession, invitation, adhésion). */
  var reconnects = {};

  /* Libère les deux promesses d'un dialer : l'interne (`openPromise`, qui
   * bloquait les dialers concurrents) et celle de l'appelant. Idempotent :
   * une ouverture passée ne doit jamais être rejetée après coup. */
  function settleDial(entry, err) {
    if (entry.dialSettled) return;
    entry.dialSettled = true;
    entry.rejectOpen(err);
    /* Avant, un dial qui n'ouvrait jamais laissait l'appelant suspendu a vie
     * (seul `inviteAddedDevice()` se protegeait avec son propre minuteur) :
     * l'échec doit être remonté : c'est ce qui permet à l'appelant de logger
     * SYNC_PLEASE_CONNECT_FAIL et au retry de repartir. */
    if (entry.rejectDial) entry.rejectDial(err);
  }

  /* ---------- client (standard WebView WebSocket) ---------- */

  /* Ouvre (ou ressort) une connexion client vers host:port. Résout le WebSocket
   * ouvert. Les messages entrants sont routés comme ceux du serveur.
   *
   * Un dial EXPLICITE (reSyncSession, invitation, adhésion) prend toujours le
   * pas sur une reconnexion en attente : il annule le timer plutôt que de créer
   * un second socket vers le même endpoint.
   *
   * `fromRetry` distingue les deux origines. C'est nécessaire parce qu'un socket
   * de RETRY porte le budget de 4 s qui lui a été accordé : sur un réseau mort,
   * il reste CONNECTING quelques secondes après que le réseau soit revenu. Un
   * dial explicite qui s'y accole hériterait de ce `dial_timeout` alors que tout
   * va bien côté réseau — constaté sur le device (une adhésion échouait alors
   * que le Master écoutait). Le dial explicite prend donc un socket neuf, et
   * ferme l'ancien. */
  function connectTo(host, port, fromRetry) {
    var key = host + ":" + port;
    cancelRetry(key);   /* un dial demandé ne double jamais le retry programmé */
    var prev = state.clientConns[key];
    if (prev && prev.ws && prev.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(prev.ws);
    }
    if (prev && !prev.closing && prev.openPromise) {
      if (!fromRetry && prev.fromRetry) {
        emit("WS_DIAL_TAKEOVER endpoint=" + key + " from=retry");
        prev.closing = true;
        settleDial(prev, new Error("superseded_by_explicit_dial"));
        try { prev.ws.close(); } catch (e) {}
        /* On laisse la place : l'entrée sera écrasée ci-dessous, et le
         * `onclose` de l'ancien socket ne supprimera PAS la nouvelle (test
         * d'identité sur `state.clientConns[key]`). */
      } else {
        /* Connexion EN COURS : on attend son ouverture au lieu de résoudre
         * immédiatement. Résoudre sur un socket CONNECTING faisait perdre le
         * message — `sendOn()` refuse un socket non ouvert. */
        return prev.openPromise;
      }
    }
    return new Promise(function (resolve, reject) {
      var url = "ws://" + key;
      var ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        emit("WS_CLIENT_CTOR_ERROR url=" + url + " err=" + e);
        reject(e);
        return;
      }
      var entry = { ws: ws, did: null, sessions: null, lastRxMs: nowMs(), closing: false, openPromise: null };
      /* Résolue à l'ouverture : les appels concurrents à `connectTo` pour le même
       * endpoint (une par session au boot) patientent au lieu d'écrire dans le vide. */
      entry.openPromise = new Promise(function (res, rej) {
        entry.resolveOpen = res;
        entry.rejectOpen = rej;
      });
      /* Ce rejet interne n'a pas toujours de consommateur (un seul dialer, ou
       * personne en attente) : sans ce rattrapage, un dial avorté devient un
       * rejet non traité et casse la WebView comme le runner de tests. */
      entry.openPromise.catch(function () {});
      state.clientConns[key] = entry;
      ws.binaryType = "arraybuffer";
      /* Chien de garde du dial : un pair injoignable peut laisser le socket
       * CONNECTING indéfiniment (aucun onclose). Sans abandon, `connectTo()`
       * ne rejette jamais et la boucle de retry n'aurait jamais de départ. On
       * abandonne au même délai que l'invitation (4 s) et on laisse le retry
       * reprendre la main. */
      entry.rejectDial = reject;   /* libère l'appelant si le dial échoue */
      entry.fromRetry = !!fromRetry;   /* origine : retry (spéculatif) ou explicite */
      entry.dialTimer = setTimeout(function () {
        if (state.clientConns[key] !== entry) return;
        if (ws.readyState !== WebSocket.CONNECTING) return;
        emit("WS_DIAL_TIMEOUT endpoint=" + key + " after=" + DIAL_TIMEOUT_MS + "ms");
        entry.closing = true;
        settleDial(entry, new Error("dial_timeout"));
        reconnects[key] = true;
        try { ws.close(); } catch (e) {}
        if (state.clientConns[key] === entry) delete state.clientConns[key];
        notifyChanged();
        scheduleRetry(key, "dial_timeout");
      }, DIAL_TIMEOUT_MS);
      ws.onopen = function () {
        if (entry.dialTimer) { clearTimeout(entry.dialTimer); entry.dialTimer = null; }
        if (entry.closing) return;
        entry.dialSettled = true;   /* résolu : une fermeture ultérieure ne rejette plus */
        emit("WS_CLIENT_OPEN endpoint=" + key);
        /* Connexion rétablie : le backoff repart de zéro — l'incident est clos. */
        var r = state.clientRetry[key];
        if (r) r.backoffMs = 0;
        entry.resolveOpen(ws);
        resolve(ws);
        notifyChanged();
        /* Reconstruction de la présence : les sessions transportées par ce
         * socket sont re-synchronisées. Une reconnexion SANS reSync laisserait
         * les pairs « déconnectés » alors que le lien est revenu. */
        if (reconnects[key]) {
          delete reconnects[key];
          reSyncSessionsFor(key);
        }
      };
      ws.onmessage = function (ev) {
        entry.lastRxMs = nowMs();
        if (typeof ev.data === "string") {
          var env = parseEnvelope(ev.data);
          if (env) {
            if (env.from) entry.did = env.from;
            markSession(entry, env.sessionId, nowMs());
            handleIncoming(env, entry);
          } else {
            emit("WS_CLIENT_PARSE_ERROR endpoint=" + key);
          }
        }
      };
      ws.onclose = function (ev) {
        if (entry.dialTimer) { clearTimeout(entry.dialTimer); entry.dialTimer = null; }
        if (state.clientConns[key] === entry) delete state.clientConns[key];
        var did = entry.did;
        emit("WS_CLIENT_CLOSE endpoint=" + key + " code=" + ev.code + " reason=" + ev.reason
          + " did=" + (did || ""));
        /* Le dialer doit être libéré même si le socket n'a jamais ouvert : sans
         * rejet, un appelant concurrent resterait suspendu sur une promesse
         * morte, et `connectTo()` refuserait tout nouveau dial. */
        settleDial(entry, new Error("closed_before_open"));
        if (did) emit("PEER_DISCONNECTED did=" + did + " reason=ws_client_close");
        notifyChanged();
        reconnects[key] = true;          /* la prochaine ouverture est une reconnexion */
        if (entry.closing) return;       /* arrêt explicite : pas de retry */
        /* Une session ouverte référençant encore cet endpoint suffit à re-dialer :
         * `scheduleRetry` ignore le cas « plus aucune session ouverte ». */
        scheduleRetry(key, "close_" + (ev && ev.code !== undefined ? ev.code : "?"));
      };
      ws.onerror = function () {
        emit("WS_CLIENT_ERROR endpoint=" + key);
      };
    });
  }

  function sendOn(ws, obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      emit("WS_SEND_ERROR " + e);
      return false;
    }
  }

  function sendClient(key, obj) {
    var entry = state.clientConns[key];
    if (!entry || !entry.ws) return false;
    return sendOn(entry.ws, obj);
  }

  function sendServer(uuid, obj) {
    var ws = wsserver();
    var entry = state.serverConns[uuid];
    if (!ws || !entry) return false;
    try {
      ws.send(entry, JSON.stringify(obj));
      return true;
    } catch (e) {
      emit("WS_SEND_ERROR " + e);
      return false;
    }
  }

  /* ---------- enveloppes ---------- */

  function envelope(kind, sessionId, extra) {
    var e = { v: PROTOCOL_VERSION, kind: kind, from: localDid(), ts: nowMs() };
    if (sessionId) e.sessionId = sessionId;
    if (extra) for (var k in extra) e[k] = extra[k];
    return e;
  }

  function parseEnvelope(text) {
    var raw;
    try { raw = JSON.parse(text); } catch (e) { return null; }
    if (!raw || typeof raw !== "object") return null;
    if (raw.v !== PROTOCOL_VERSION) {
      emit("WS_DROP kind=" + (raw.kind || "?") + " reason=protocol_version from=" + (raw.from || "?"));
      return null;
    }
    if (typeof raw.kind !== "string" || !raw.kind) return null;
    return raw;
  }

  /* ---------- routage entrant (serveur ET client) ---------- */

  function handleServerText(conn, text) {
    var env = parseEnvelope(text);
    if (!env) {
      emit("WS_SERVER_PARSE_ERROR remote=" + conn.remoteAddr);
      return;
    }
    var entry = state.serverConns[conn.uuid];
    if (entry) entry.lastRxMs = nowMs();
    if (entry) markSession(entry, env.sessionId, nowMs());
    /* Lie le conn au deviceId/peer en amont du traitement (broadcast + PEER_CONNECTED).
     * Le test d'inconnu est effectué AVANT mutation : l'ancien code affectait
     * entry.peerDid puis testait !entry.peerDid, qui valait donc TOUJOURS faux —
     * PEER_CONNECTED n'était jamais émis sur la voie serveur, précisément la voie
     * empruntée par la reconnexion (D3 restauré le transport, D4 remonte les états). */
    if (entry && env.from && entry.peerDid !== env.from) {
      var wasUnknown = !entry.peerDid;
      entry.peerDid = env.from;
      if (wasUnknown) {
        emit("PEER_CONNECTED did=" + env.from + " via=ws_server uuid=" + conn.uuid.substr(0, 8) + "…");
        /* D4 : le pair s'est (re)annoncé sur une connexion restaurée — prévenir
         * le pont caméra pour qu'il republie un SNAPSHOT d'état idempotent. */
        resyncCameraState(env, entry);
      }
    }
    handleIncoming(env, entry, conn);
  }

  function resyncCameraState(env, entry) {
    if (!env || !env.sessionId || !env.from) return;
    var bridge = state.cameraBridge;
    if (!bridge || typeof bridge.onPeerIdentified !== "function") return;
    try {
      bridge.onPeerIdentified(env, entry);
    } catch (e) {
      emit("CAMERA_RESYNC_ERROR from=" + (env.from || "?") + " err=" + String((e && e.message) || e));
    }
  }

  function handleIncoming(env, entry, serverConn) {
    switch (env.kind) {
      case "ping":
        sendReply(entry, serverConn, "pong", env.sessionId, { echo_ts: env.ts });
        break;
      case "pong":
        break;
      case "sync_please":
        handleSyncPlease(env, entry, serverConn);
        break;
      case "sync":
        handleSync(env);
        break;
      case "join_req":
        handleJoinRequest(env, entry, serverConn);
        break;
      case "join_ok":
        handleJoinOk(env);
        break;
      case "join_nack":
        handleJoinNack(env);
        break;
      case "invite_req":
        handleInviteRequest(env, entry, serverConn);
        break;
      case "invite_ok":
        handleInviteOk(env);
        break;
      case "invite_nack":
        handleInviteNack(env);
        break;
      case "member_add":
      case "member_update":
        handleMemberUpsert(env, entry);
        break;
      case "member_remove":
        handleMemberRemove(env, entry);
        break;
      case "take_update":
        handleTakeUpdate(env, entry);
        break;
      case "telemetry_update":
        handleTelemetryUpdate(env, entry);
        break;
      case "arm_request":
        handleArmRequest(env, entry, serverConn);
        break;
      case "arm_result":
        handleArmResult(env);
        break;
      case "clock_sync":
        handleClockSync(env, entry, serverConn);
        break;
      case "clock_sync_reply":
        handleClockSyncReply(env);
        break;
      case "start_plan":
      case "start_cancel":
      case "start_state":
      case "start_probe":
      case "start_probe_reply":
        handleStartMessage(env, entry, serverConn);
        break;
      case "preview_frame":
        handlePreviewFrame(env, entry);
        break;
      case "camera_switch_request":
        handleCameraSwitchRequest(env, entry, serverConn);
        break;
      case "camera_switch_result":
        handleCameraSwitchResult(env);
        break;
      case "camera_state":
        handleCameraState(env);
        break;
      default:
        emit("WS_DROP kind=" + env.kind + " v=" + env.v + " reason=unknown_kind from=" + (env.from || "?"));
        break;
    }
  }

  /* ---------- J09 : transport des previews JPEG ----------
   *
   * DEUX FONCTIONS, ET C'EST TOUT.
   *
   * `handlePreviewFrame()` — ROUTAGE. Une seule ligne utile : remettre
   * l'enveloppe au pont J09, qui décide si elle est recevable. Le WS ne
   * hiérarchise pas les images, ne les garde pas, ne les recompose pas : il ne
   * fait que transporter, comme pour `take_update`.
   *
   * `sendPreviewFrame()` — SÉLECTION DES DESTINATAIRES + SÉRIALISATION UNE FOIS.
   * Deux filtres, dans cet ordre, et ils sont distincts :
   *   1. la connexion parle-t-elle CETTE session ? (`inSession`, modèle J09-01) ;
   *   2. cette session a-t-elle le CE device comme Master ? (`session.masters`).
   * Un Master d'une autre session et une Capture ou un Storage-only de la même
   * session sont donc écartés — et COMPTÉS, parce qu'un écart silencieux est
   * indiscernable d'un bug. `selfSkipped` casse la boucle réseau quand un
   * device est Master ET Capture : son propre JPEG lui reviendrait par le WS,
   * alors que l'UI lira plus tard sa preview locale.
   *
   * RÈGLE ABSOLUE : ce fichier ne conserve AUCUNE image. Il sérialise, envoie,
   * puis oublie — le `base64` n'est jamais recopié dans un état du module.
   * Unavu de transport est signale par le retour `false` de `sendServer()` /
   * `sendOn()` (socket fermé, ou `send()` qui lève) : c'est le SEUL signal de
   * backpressure dont on dispose, et c'est à l'appelant de décider du DROP.
   */
  function handlePreviewFrame(env, entry) {
    var bridge = state.previewBridge;
    if (!bridge || typeof bridge.onPreviewFrame !== "function") {
      emit("WS_DROP kind=preview_frame reason=no_preview_bridge from=" + (env.from || "?"));
      return false;
    }
    try {
      bridge.onPreviewFrame(env, entry);
    } catch (e) {
      emit("WS_PREVIEW_FRAME_ERROR from=" + (env.from || "?") + " err=" + e);
      return false;
    }
    return true;
  }

  function isMasterDevice(session, deviceId) {
    if (!session || !deviceId) return false;
    var masters = session.masters || [];
    for (var i = 0; i < masters.length; i++) {
      if (masters[i] && masters[i].deviceId === deviceId) return true;
    }
    return false;
  }

  /* D4 : pour un endpoint donné (par ex. l'endpoint transport d'un membre
   * re-dialé), retrouve le deviceId qui le porte dans la session — Masters et
   * Membres confondus. Si cet endpoint est inconnu de la session, retourne null. */
  function peerDidOfEndpoint(session, endpoint) {
    if (!session || !endpoint) return null;
    var i;
    if (session.masters) {
      for (i = 0; i < session.masters.length; i++) {
        if (session.masters[i] && session.masters[i].endpoint === endpoint) {
          return session.masters[i].deviceId;
        }
      }
    }
    if (session.members) {
      for (i = 0; i < session.members.length; i++) {
        if (session.members[i] && session.members[i].endpoint === endpoint) {
          return session.members[i].deviceId;
        }
      }
    }
    return null;
  }

  function sendPreviewFrame(session, frame) {
    var st = {
      sent: 0, recipients: 0, candidates: 0, duplicatesSkipped: 0,
      nonMastersSkipped: 0, otherSessionSkipped: 0,
      selfSkipped: 0, unknownPeerSkipped: 0, notOpenSkipped: 0,
      jsonBytes: 0, reason: ""
    };
    var sid = (session && session.sessionId) || (frame && frame.sessionId) || "";
    if (!session || !sid || !frame) {
      st.reason = "invalid_target";
      return st;
    }
    var env = envelope("preview_frame", sid, {
      takeNumber: (typeof frame.takeNumber === "number") ? frame.takeNumber : null,
      startPlanId: frame.startPlanId || "",
      deviceId: frame.deviceId || localDid(),
      seq: frame.seq,
      capturedAt: frame.capturedAt || 0,
      mime: frame.mime || "image/jpeg",
      width: (typeof frame.width === "number") ? frame.width : null,
      height: (typeof frame.height === "number") ? frame.height : null,
      bytes: frame.bytes || 0,
      jpegBase64: frame.jpegBase64
    });
    var json = JSON.stringify(env);
    st.jsonBytes = json.length;
    var self = localDid();

    /* Un destinataire est un DEVICE, pas une connexion. Sur le terrain les deux
     * devices tournent en serveur ET en client l'un vers l'autre : le Master est
     * donc joignable par DEUX sockets pour la même session, et une diffusion par
     * connexion lui aurait envoyé chaque image deux fois — deux fois le débit,
     * deux fois le décodage, et un compteur de réception qui ne colle plus avec
     * l'émission. On dé-duplique par deviceId, le premier chemin gagné restant
     * prioritaire (connexion entrante, puis sortante). */
    var targets = [];
    var seen = {};

    function consider(did, send) {
      if (!did) { st.unknownPeerSkipped++; return; }
      if (seen[did]) { st.duplicatesSkipped++; return; }
      seen[did] = true;
      st.candidates++;
      targets.push({ did: did, send: send });
    }

    Object.keys(state.serverConns).forEach(function (uuid) {
      var entry = state.serverConns[uuid];
      if (!entry) return;
      var did = entry.peerDid;
      if (!did) { st.unknownPeerSkipped++; return; }
      if (!inSession(entry, sid)) { st.otherSessionSkipped++; return; }
      if (!isMasterDevice(session, did)) { st.nonMastersSkipped++; return; }
      if (did === self) { st.selfSkipped++; return; }
      consider(did, function () { return sendServer(uuid, env); });
    });

    Object.keys(state.clientConns).forEach(function (key) {
      var entry = state.clientConns[key];
      if (!entry) return;
      var did = entry.did;
      if (!did) { st.unknownPeerSkipped++; return; }
      if (!inSession(entry, sid)) { st.otherSessionSkipped++; return; }
      if (!isMasterDevice(session, did)) { st.nonMastersSkipped++; return; }
      if (did === self) { st.selfSkipped++; return; }
      consider(did, function () { return sendOn(entry.ws, env); });
    });

    targets.forEach(function (t) {
      if (t.send()) st.sent++; else st.notOpenSkipped++;
    });
    st.recipients = st.sent;
    if (!st.candidates) st.reason = st.unknownPeerSkipped ? "no_identified_peer" : "no_master_connected";
    else if (!st.sent) st.reason = "not_open";
    emit("PREVIEW_FRAME_TX sessionId=" + sid
      + " seq=" + frame.seq
      + " candidates=" + st.candidates
      + " peers=" + st.sent
      + " nonMastersSkipped=" + st.nonMastersSkipped
      + " otherSessionSkipped=" + st.otherSessionSkipped
      + " selfSkipped=" + st.selfSkipped
      + " duplicateConnsSkipped=" + st.duplicatesSkipped
      + " jsonBytes=" + st.jsonBytes);
    return st;
  }

  /* envoie vers l'émetteur : si serverConn présent → via ws.send(conn), sinon client */
  function sendReply(entry, serverConn, kind, sessionId, extra) {
    var env = envelope(kind, sessionId, extra);
    if (serverConn) {
      sendServer(serverConn.uuid, env);
    } else if (entry && entry.ws) {
      sendOn(entry.ws, env);
    }
  }

  /* ---------- J09-07 : transport du changement de caméra ----------
   *
   * QUATRE fonctions, et c'est tout — aucun état de caméra ici.
   *
   * `sendToDevice()`   — le SEUL envoi à device unique du fichier. Il existe
   *                       parce que `broadcastTargeted()` ne l'est PAS : malgré
   *                       son nom, il diffuse à tous les peers de la session. Or
   *                       §35.2 veut qu'une commande de caméra atteigne UNE
   *                       Capture précise. On réutilise donc le tri déjà éprouvé
   *                       par `sendPreviewFrame()` : dé-duplication par deviceId
   *                       (un Master est joignable par deux sockets), filtre
   *                       `inSession`, premier chemin gagné prioritaire.
   *
   * `reply()`          — la RÉPONSE part sur la MÊME connexion que la demande,
   *                       exactement comme `arm_result` et `start_probe_reply`.
   *                       C'est la seule garantie que l'ACK atteint son
   *                       destinataire sans être confondu avec une diffusion.
   *
   * `broadcastCameraState()` — l'état CONFIRMÉ part vers tous les Masters de la
   *                       session. §35.3 : ils se convergent vers le fait réel,
   *                       pas vers l'intention, et un Master doit pouvoir le
   *                       savoir même si sa télémétrie est en retard.
   *
   * `handleCameraSwitchRequest()` / `handleCameraSwitchResult()` /
   * `handleCameraState()` — le routage, et rien d'autre : le WS ne valide pas
   *                       une commande de caméra, il ne connaît ni REAR ni
   *                       FRONT. Il vérifie seulement la STRUCTURE et
   *                       l'auto-déclaration, puis passe la main.
   */

  function sendToDevice(deviceId, session, kind, extra) {
    if (!deviceId || typeof deviceId !== "string") return false;
    var sid = (session && session.sessionId) || (extra && extra.sessionId) || "";
    if (!sid) return false;
    var env = envelope(kind, sid, extra);
    var sent = false;
    var self = localDid();

    /* Le device ne s'envoie rien à lui-même : il exécute sa propre bascule par
     * le chemin LOCAL (`requestSwitch`), jamais en se écoutant sur le réseau. */
    if (deviceId === self) return false;

    Object.keys(state.serverConns).forEach(function (uuid) {
      if (sent) return;
      var entry = state.serverConns[uuid];
      if (!entry || entry.peerDid !== deviceId) return;
      if (!inSession(entry, sid)) return;
      if (sendServer(uuid, env)) sent = true;
    });
    Object.keys(state.clientConns).forEach(function (key) {
      if (sent) return;
      var entry = state.clientConns[key];
      if (!entry || entry.did !== deviceId) return;
      if (!inSession(entry, sid)) return;
      if (sendOn(entry.ws, env)) sent = true;
    });
    emit(kind.toUpperCase() + "_TX sessionId=" + sid
      + " target=" + deviceId + " sent=" + (sent ? 1 : 0));
    return sent;
  }

  /* Réponse sur la connexion d'origine de `env` (stockée par le pont WS).
   *
   * Un seul `kind` de réponse pour la commande caméra : `camera_switch_result`
   * porte À LA FOIS le succès et l'erreur, distingués par `ok` + `code`. Deux
   * kinds obligeraient le pont à choisir avant de connaître le résultat, et donc
   * à annoncer une intention d'erreur. */
  function reply(env, extra) {
    var rec = env && env.__conn;
    if (!rec) return false;
    var sent = rec.serverConn
      ? sendServer(rec.serverConn.uuid, envelope("camera_switch_result", env.sessionId, extra))
      : (rec.entry && rec.entry.ws ? sendOn(rec.entry.ws, envelope("camera_switch_result", env.sessionId, extra)) : false);
    emit("CAMERA_SWITCH_REPLY sessionId=" + (env.sessionId || "—")
      + " commandId=" + (extra.commandId || "—")
      + " ok=" + (extra.ok ? 1 : 0) + " code=" + (extra.code || "—")
      + " sent=" + (sent ? 1 : 0));
    return sent === true;
  }

  /* Un seul chemin de réponse pour la commande caméra : le pont reçoit toujours
   * `camera_switch_result`, quel que soit le verdict. */
  function handleCameraSwitchRequest(env, entry, serverConn) {
    if (cameraIsMalformed(env)) {
      emit("CAMERA_TRANSPORT_DROP kind=camera_switch_request reason=malformed from=" + (env.from || "?"));
      return;
    }
    var bridge = state.cameraBridge;
    if (!bridge || typeof bridge.onCameraSwitchRequest !== "function") {
      emit("CAMERA_TRANSPORT_DROP kind=camera_switch_request reason=no_bridge sessionId=" + (env.sessionId || "—"));
      return;
    }
    /* On transporte la connexion d'origine pour que l'ACK reparte dessus. */
    var tagged = env;
    tagged.__conn = { entry: entry, serverConn: serverConn, replyKind: "camera_switch_result" };
    try {
      bridge.onCameraSwitchRequest(tagged, entry, serverConn);
    } catch (e) {
      emit("CAMERA_SWITCH_ERROR from=" + (env.from || "?") + " err=" + e);
    }
  }

  function handleCameraSwitchResult(env) {
    if (!env || !env.commandId || !env.from) {
      emit("CAMERA_TRANSPORT_DROP kind=camera_switch_result reason=malformed from=" + (env.from || "?"));
      return;
    }
    var bridge = state.cameraBridge;
    if (!bridge || typeof bridge.onCameraSwitchResult !== "function") {
      emit("CAMERA_TRANSPORT_DROP kind=camera_switch_result reason=no_bridge");
      return;
    }
    bridge.onCameraSwitchResult(env);
  }

  function handleCameraState(env) {
    if (!env || !env.deviceId || !env.from) {
      emit("CAMERA_TRANSPORT_DROP kind=camera_state reason=malformed from=" + (env.from || "?"));
      return;
    }
    if (env.from !== env.deviceId) {
      emit("CAMERA_TRANSPORT_DROP kind=camera_state reason=not_self claimed=" + env.deviceId + " from=" + env.from);
      return;
    }
    var bridge = state.cameraBridge;
    if (!bridge || typeof bridge.onCameraState !== "function") {
      emit("CAMERA_TRANSPORT_DROP kind=camera_state reason=no_bridge");
      return;
    }
    bridge.onCameraState(env);
  }

  /* Validation STRUCTURELLE uniquement. Le WS ignore ce qu'est une caméra : il
   * exige juste que la commande soit adressable et correlable. */
  function cameraIsMalformed(env) {
    if (!env.sessionId || !env.from) return true;
    if (typeof env.targetDeviceId !== "string" || !env.targetDeviceId) return true;
    if (typeof env.camera !== "string" || !env.camera) return true;
    if (typeof env.commandId !== "string" || !env.commandId) return true;
    return false;
  }

  function broadcastCameraState(session, extra) {
    var sid = (session && session.sessionId) || (extra && extra.sessionId) || "";
    if (!sid) return false;
    var env = envelope("camera_state", sid, extra);
    var sent = 0;
    var self = localDid();
    /* Même dé-duplication que `sendPreviewFrame` : un Master est joignable par
     * deux sockets, et une image d'état en double ferait clignoter la vignette. */
    var seen = {};
    Object.keys(state.serverConns).forEach(function (uuid) {
      var entry = state.serverConns[uuid];
      if (!entry) return;
      var did = entry.peerDid;
      if (!did || did === self || seen[did]) return;
      if (!inSession(entry, sid)) return;
      if (!isMasterDevice(session, did)) return;
      if (sendServer(uuid, env)) { sent++; seen[did] = true; }
    });
    Object.keys(state.clientConns).forEach(function (key) {
      var entry = state.clientConns[key];
      if (!entry) return;
      var did = entry.did;
      if (!did || did === self || seen[did]) return;
      if (!inSession(entry, sid)) return;
      if (!isMasterDevice(session, did)) return;
      if (sendOn(entry.ws, env)) { sent++; seen[did] = true; }
    });
    emit("CAMERA_STATE_TX sessionId=" + sid
      + " deviceId=" + (extra && extra.deviceId ? extra.deviceId : "—")
      + " activeCamera=" + (extra && extra.activeCamera ? extra.activeCamera : "—")
      + " switchingCamera=" + (extra && extra.switchingCamera ? extra.switchingCamera : "—")
      + " masters=" + sent);
    return sent > 0;
  }

  /* ---------- protocole : sync ---------- */

  function handleSyncPlease(env, entry, serverConn) {
    if (!env.sessionId) {
      emit("WS_DROP kind=sync_please reason=missing_sessionId from=" + (env.from || "?"));
      return;
    }
    store().get(env.sessionId).then(function (s) {
      if (!s) {
        emit("SYNC_PLEASE_UNKNOWN sessionId=" + env.sessionId + " from=" + (env.from || "?"));
        sendReply(entry, serverConn, "sync", env.sessionId, { state: null, reason: "unknown_session" });
        return;
      }
      /* Un Master déjà connu peut resynchroniser ; un inconnu se fait servir le
       * state (sans PIN) et sera validé s'il envoie un join_req ensuite. */
      var view = model().sharedView(s);
      emit("SYNC_SENT sessionId=" + env.sessionId + " to=" + (env.from || "?") + " state=" + s.state);
      sendReply(entry, serverConn, "sync", env.sessionId, { state: view });
    });
  }

  function handleSync(env) {
    if (!env.sessionId || !env.state) return;
    var remote = env.state;
    if (remote.sessionId !== env.sessionId) {
      emit("WS_DROP kind=sync reason=session_mismatch from=" + (env.from || "?"));
      return;
    }
store().get(env.sessionId).then(function (local) {
        var modelM = model();
      if (!local) {
        /* Copie locale créée à partir du state distant : surtout PAS de PIN —
         * seul un join_req reconnu en apportera un. Les membres/sessionRoles et
         * tombstones distants sont conservés (J05). */
        var fresh = modelM.sanitizeSession({
          sessionId: env.sessionId,
          name: remote.name, nameUpdatedMs: remote.nameUpdatedMs, nameByDeviceId: remote.nameByDeviceId,
          state: remote.state, stateUpdatedMs: remote.stateUpdatedMs, stateByDeviceId: remote.stateByDeviceId,
          createdAtMs: remote.createdAtMs, updatedAtMs: remote.updatedAtMs,
          masters: [],
          members: remote.members || [],
          removedMembers: remote.removedMembers || {}
        });
        /* Sanitize génère un PIN local aléatoire (jamais transmis). */
        return store().save(fresh).then(function () {
          emit("SYNC_RECEIVED sessionId=" + env.sessionId + " kind=new_copy state=" + fresh.state + " note=no_pin_wire");
          notifyChanged();
        });
      }
      var res = modelM.mergeSessions(local, remote);
      if (res.changed && semanticEqual(local, res.session)) {
        /* Écho de convergence (ex : re-save distante avec updatedAtMs neuf sur des
         * champs partagés inchangés) → rien à persister, rien à ré-annoncer. */
        emit("MERGE_NOOP sessionId=" + res.session.sessionId + " from=" + (env.from || "?"));
        return;
      }
      if (res.changed) {
        return store().save(res.session).then(function () {
          emitEvents(res.events, env.sessionId, env.from);
          if (res.session.state === "closed") {
            /* Décision 30.9/30.10 : une session fermée n'est plus annoncée sur le
             * LAN, quel que soit l'écran courant (J04-11). Le serveur WS reste up
             * pour la sync de retour (30.9.3). */
            emit("SESSION_UNADVERTISE_LEARNED sessionId=" + res.session.sessionId + " via=sync");
            unadvertise();
          } else {
            /* Convergence complète : le TXT DNS-SD (nom) de CET annonceur suit
             * l'état fusionné, même si la mutation est arrivée par sync (30.1). */
            advertiseOne(res.session);
          }
          notifyChanged();
        });
      }
    }).catch(function (err) {
      emit("SYNC_ERROR sessionId=" + env.sessionId + " err=" + (err && err.message));
    });
  }

  function emitEvents(events, sid, from) {
    events.forEach(function (e) {
      if (e.type === "close") {
        emit("SESSION_CLOSE_APPLIED sessionId=" + sid + " by=" + (e.byDeviceId || "?"));
      } else if (e.type === "rename") {
        emit("RENAME_APPLIED sessionId=" + sid + " from=" + e.from + " to=" + e.to + " by=" + e.byDeviceId);
      } else if (e.type === "masterAdded") {
        emit("MASTER_ADDED sessionId=" + sid + " deviceId=" + e.deviceId + " learned_from=" + (from || "?"));
      } else if (e.type === "memberAdded") {
        emit("MEMBER_ADDED sessionId=" + sid + " did=" + e.deviceId + " learned_from=" + (from || "?"));
      } else if (e.type === "memberRolesChanged") {
        emit("MEMBER_ROLES_CHANGED sessionId=" + sid + " did=" + e.deviceId + " roles=[" + (e.to || []).join(",") + "] learned_from=" + (from || "?"));
      } else if (e.type === "memberRemoved") {
        emit("MEMBER_REMOVED sessionId=" + sid + " did=" + e.deviceId + " learned_from=" + (from || "?"));
      } else if (e.type === "memberRestored") {
        emit("MEMBER_RESTORED sessionId=" + sid + " did=" + e.deviceId + " learned_from=" + (from || "?"));
      } else if (e.type === "memberPruned") {
        emit("MEMBER_PRUNED sessionId=" + sid + " did=" + e.deviceId + " reason=" + (e.reason || "") + " learned_from=" + (from || "?"));
      } else if (e.type === "memberTelemetryChanged") {
        emit("MEMBER_TELEMETRY sessionId=" + sid + " did=" + e.deviceId + " learned_from=" + (from || "?"));
      } else if (e.type === "takeAdded") {
        emit("TAKE_ADDED sessionId=" + sid + " take=" + e.takeNumber + " learned_from=" + (from || "?"));
      } else if (e.type === "takeChanged") {
        emit("TAKE_CHANGED sessionId=" + sid + " take=" + e.takeNumber + " learned_from=" + (from || "?"));
      } else if (e.type === "conflict") {
        emit("SYNC_CONFLICT sessionId=" + sid + " field=" + e.field + " detail=" + (e.detail || ""));
      }
    });
  }

  /* ---------- protocole : join ---------- */

  function handleJoinRequest(env, entry, serverConn) {
    if (!env.sessionId || !env.pin || !env.from) {
      emit("JOIN_NACK sessionId=" + (env.sessionId || "?") + " reason=malformed from=" + (env.from || "?"));
      sendReply(entry, serverConn, "join_nack", env.sessionId, { reason: "malformed" });
      return;
    }
    store().get(env.sessionId).then(function (s) {
      if (!s) {
        emit("JOIN_NACK sessionId=" + env.sessionId + " reason=unknown_session from=" + env.from);
        sendReply(entry, serverConn, "join_nack", env.sessionId, { reason: "unknown_session" });
        return;
      }
      if (s.state === "closed") {
        emit("JOIN_NACK sessionId=" + env.sessionId + " reason=session_closed from=" + env.from);
        sendReply(entry, serverConn, "join_nack", env.sessionId, { reason: "session_closed" });
        return;
      }
      if (String(env.pin) !== String(s.pin)) {
        /* Décision 30.8 : PIN erroné → rejet SANS modifier la session. */
        emit("JOIN_NACK sessionId=" + env.sessionId + " reason=pin_mismatch from=" + env.from);
        sendReply(entry, serverConn, "join_nack", env.sessionId, { reason: "pin_mismatch" });
        return;
      }
      /* OK : ajoute le joiner aux Masters (fusion par deviceId), persiste, répond
       * avec le sharedView (sans PIN), et prévient les autres Masters. */
      var selfInfo = {
        deviceId: env.from,
        deviceName: env.deviceName || env.from,
        endpoint: env.endpoint || "",
        joinedAtMs: nowMs()
      };
      var res = model().upsertMaster(s, selfInfo);
      return store().save(res.session).then(function () {
        emit("JOIN_OK sessionId=" + env.sessionId + " did=" + env.from + " name=" + selfInfo.deviceName);
        emit("PEER_JOINED sessionId=" + env.sessionId + " did=" + env.from);
        var view = model().sharedView(res.session);
        sendReply(entry, serverConn, "join_ok", env.sessionId, { state: view });
        broadcast(res.session, "master_added", " did=" + env.from);
        notifyChanged();
      });
    }).catch(function (err) {
      emit("JOIN_ERROR sessionId=" + env.sessionId + " err=" + (err && err.message));
    });
  }

  function handleJoinOk(env) {
    /* Réponse du Master acceptant notre join_req. On reçoit le sharedView. */
    if (!env.sessionId || !env.state) return;
    state.pendingJoin = { sid: env.sessionId, host: "", port: 0, ok: true, reason: "accepted", atMs: nowMs() };
    /* Le PIN reste LOCAL : celui saisi par l'utilisateur (on jamais sur le wire).
     * On le retrouve via le store de la session en cours de création. */
    return store().get(env.sessionId).then(function (local) {
      var modelM = model();
      var res = modelM.mergeSessions(local, env.state);
      res.session.pin = local.pin; /* immuable, conservé en local uniquement */
      return store().save(res.session).then(function () {
        emit("JOIN_ACCEPTED sessionId=" + env.sessionId + " state=" + res.session.state
          + " name=" + res.session.name);
        emitEvents(res.events, env.sessionId, env.from);
        notifyChanged();
      });
    }).catch(function () {
      emit("JOIN_OK_NO_LOCAL sessionId=" + env.sessionId + " — sync pure attendue");
    });
  }

  function handleJoinNack(env) {
    state.pendingJoin = { sid: env.sessionId, host: "", port: 0, ok: false, reason: env.reason || "unknown", atMs: nowMs() };
    emit("JOIN_REJECTED sessionId=" + (env.sessionId || "?") + " reason=" + (env.reason || "unknown"));
    notifyChanged();
  }

  /* ---------- protocole : invitation (31.2) ---------- */

  /* Décision 31.2 : ajouter un device DÉCOUVERT depuis un Master doit intégrer
   * RÉELLEMENT ce device. Un broadcast ne suffit pas — tant que le device n'est
   * pas connecté, peers=0 et rien ne lui parvient. On dialle donc l'endpoint
   * découvert (mDNS = découverte seule, jamais le PIN) et on lui pousse l'état
   * de la session ; sa reply invite_ok identifie la connexion des deux côtés
   * (« Connecté »). Le PIN voyage sur le WS exactement comme join_req, et le
   * device validé ne reçoit QUE les rôles accordés (modèle, jamais de rôle
   * forcé). */

  function parseEndpoint(ep) {
    if (typeof ep !== "string" || !ep) return null;
    var m = /^(.+):(\d{2,5})$/.exec(ep.trim());
    if (!m) return null;
    var port = parseInt(m[2], 10);
    if (!m[1] || !(port > 0)) return null;
    return { host: m[1], port: port };
  }

  function inviteAddedDevice(session, peer, roles) {
    var sid = session ? session.sessionId : "";
    var did = peer && peer.deviceId ? peer.deviceId : "";
    if (!sid || !did) return Promise.resolve(false);
    var ep = parseEndpoint(peer.endpoint);
    if (!ep) {
      emit("INVITE_SKIP sessionId=" + sid + " did=" + did + " reason=no_endpoint");
      return Promise.resolve(false);
    }
    if (connectedPeers(sid)[did]) {
      emit("INVITE_SKIP sessionId=" + sid + " did=" + did + " reason=already_connected");
      return Promise.resolve(false);
    }
    var member = (session.members || []).filter(function (m) { return m.deviceId === did; })[0] || null;
    var cfgv = cfg();
    var payload = {
      deviceName: state.localName || (cfgv ? cfgv.deviceName : ""),
      endpoint: refreshSelfEndpoint(),
      pin: session.pin,
      roles: roles,
      member: member ? {
        deviceId: member.deviceId,
        deviceName: member.deviceName,
        enabledSkills: member.enabledSkills.slice()
      } : null,
      state: model().sharedView(session)
    };
    /* Dial borné : connectTo() ne rejette jamais (un dial impossible reste
     * suspendu jusqu'au timeout WS), donc on plafonne l'attente pour ne pas
     * laisser une connexion molle ouverte sur un device hors réseau. */
    var dialTimeoutMs = 4000;
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error("connect_timeout"));
      }, dialTimeoutMs);
      connectTo(ep.host, ep.port).then(function (ws) {
        if (settled) { try { ws.close(); } catch (e) {} return; }
        settled = true;
        clearTimeout(timer);
        resolve(ws);
      }, function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    }).then(function (ws) {
      if (!sendOn(ws, envelope("invite_req", sid, payload))) throw new Error("send_failed");
      emit("INVITE_SENT sessionId=" + sid + " did=" + did + " to=" + ep.host + ":" + ep.port
        + " roles=[" + payload.roles.join(",") + "]");
      return true;
    }).catch(function (err) {
      emit("INVITE_ERROR sessionId=" + sid + " did=" + did + " endpoint=" + ep.host + ":" + ep.port
        + " err=" + String((err && err.message) || err));
      return false;
    });
  }

  /* Le device invité reste un membre de rôle (Capture) : il n'est PAS inscrit
   * dans session.masters, sinon start-service.isMasterRole() lui accorderait le
   * rôle Master (§34.1). Il enregistre en revanche le Master invitant (avec son
   * endpoint) : c'est ce qui lui permet de re-dialer A au boot, donc de
   * réintégrer le réseau sans action locale. Même disposition que le join
   * manuel, où le joigneur devient Master de transport. */
  function handleInviteRequest(env, entry, serverConn) {
    var sid = env.sessionId || "";
    var selfDid = state.localDid;
    var refuse = function (reason) {
      emit("INVITE_REJECT sessionId=" + (sid || "?") + " did=" + selfDid
        + " reason=" + reason + " from=" + (env.from || "?"));
      sendReply(entry, serverConn, "invite_nack", sid, { reason: reason });
    };
    if (!sid || !env.from || !env.state || !/^\d{4}$/.test(String(env.pin || ""))) { refuse("malformed"); return; }
    if (env.state.sessionId !== sid) { refuse("session_mismatch"); return; }
    if (!Array.isArray(env.roles) || !env.roles.length) { refuse("no_role"); return; }
    var me = (env.member && env.member.deviceId === selfDid) ? env.member : null;
    store().get(sid).then(function (local) {
      var modelM = model();
      var events = [];
      var s = local;
      if (!s) {
        var view = env.state;
        s = modelM.sanitizeSession({
          sessionId: sid,
          name: view.name, nameUpdatedMs: view.nameUpdatedMs, nameByDeviceId: view.nameByDeviceId,
          state: view.state, stateUpdatedMs: view.stateUpdatedMs, stateByDeviceId: view.stateByDeviceId,
          createdAtMs: view.createdAtMs, updatedAtMs: view.updatedAtMs,
          masters: [], members: view.members || [], removedMembers: view.removedMembers || {},
          takes: view.takes || []
        });
      } else {
        var merged = modelM.mergeSessions(local, env.state);
        s = merged.session;
        events = events.concat(merged.events || []);
      }
      /* PIN : le Master invitant est l'autorité de la session qu'il héberge
       * (même source que join_req côté Master). Un PIN déjà identique est un
       * no-op ; il n'est jamais dérivé d'une annonce mDNS. */
      if (s.pin !== env.pin) {
        emit("INVITE_PIN_ADOPTED sessionId=" + sid + " from=" + env.from);
        s.pin = env.pin;
      }
      var add = modelM.addMember(s, {
        deviceId: selfDid,
        deviceName: (me && me.deviceName) || state.localName,
        enabledSkills: (me && me.enabledSkills) || []
      }, env.roles, env.from);
      if (!add.ok) { refuse(add.error || "role_rejected"); return; }
      events = events.concat(add.events || []);
      var withMaster = modelM.upsertMaster(add.session, {
        deviceId: env.from, deviceName: env.deviceName, endpoint: env.endpoint, joinedAtMs: nowMs()
      });
      events.push({ type: "masterAdded", deviceId: env.from });
      return store().save(withMaster.session).then(function () {
        emit("INVITE_ACCEPTED sessionId=" + sid + " did=" + selfDid + " by=" + env.from
          + " roles=[" + env.roles.join(",") + "]");
        emitEvents(events, sid, env.from);
        sendReply(entry, serverConn, "invite_ok", sid, { accepted: true, roles: env.roles });
        advertiseOne(withMaster.session);
        notifyChanged();
      });
    }).catch(function (err) {
      emit("INVITE_ERROR sessionId=" + sid + " did=" + selfDid + " err=" + String((err && err.message) || err));
      sendReply(entry, serverConn, "invite_nack", sid, { reason: "local_error" });
    });
  }

  function handleInviteOk(env) {
    emit("INVITE_OK sessionId=" + (env.sessionId || "?") + " from=" + (env.from || "?")
      + " roles=[" + ((env.roles || []).join(",") || "?") + "]");
    notifyChanged();
  }

  function handleInviteNack(env) {
    emit("INVITE_NACK sessionId=" + (env.sessionId || "?") + " from=" + (env.from || "?")
      + " reason=" + (env.reason || "unknown"));
    notifyChanged();
  }

  /* ---------- protocole J05 : members/sessionRoles ---------- */

  /* Un autre Master a ajouté ou modifié les rôles d'un membre. L'opération
   * arrive déjà validée par le modèle de l'émetteur ; on l'applique localement
   * via les primitives du modèle (fusion deviceId, LMW rôle) puis on propage.
   * Un rôle non annoncé est impossible à soumettre côté modèle ; on re-vérifie
   * quand même (défense en profondeur, décision 31 : jamais de rôle forcé). */
  function handleMemberUpsert(env, entry) {
    if (!env.sessionId || !env.member || !env.member.deviceId) {
      emit("MEMBER_DROP kind=" + env.kind + " reason=malformed from=" + (env.from || "?"));
      return;
    }
    store().get(env.sessionId).then(function (local) {
      if (!local) {
        emit("MEMBER_DROP kind=" + env.kind + " reason=unknown_session sessionId=" + env.sessionId + " from=" + (env.from || "?"));
        return;
      }
      var modelM = model();
      var member = modelM.cleanMember(env.member);
      if (!member || member.sessionRoles.length === 0) {
        emit("MEMBER_REJECT kind=" + env.kind + " sessionId=" + env.sessionId
          + " did=" + env.member.deviceId + " reason=no_valid_role from=" + (env.from || "?"));
        return;
      }
      /* LMW : les primitives addMember/updateMemberRoles du modèle sont des
       * upserts idempotents par deviceId ; la dernière synchro (sync) portant le
       * sharedView complet aura le dernier mot si horodatage concurrent. */
      var actor = env.from || (member.addedByDeviceId || "");
      var res;
      if (env.kind === "member_add") {
        res = modelM.addMember(local, member, member.sessionRoles, actor);
      } else {
        res = modelM.updateMemberRoles(local, member.deviceId, member.sessionRoles, actor);
      }
      if (!res.ok) {
        emit("MEMBER_REJECT kind=" + env.kind + " sessionId=" + env.sessionId
          + " did=" + member.deviceId + " reason=" + (res.error || "rejected"));
        return;
      }
      if (res.changed) {
        return store().save(res.session).then(function () {
          emitEvents(res.events, env.sessionId, env.from);
          emit("MEMBER_RECEIVED kind=" + env.kind + " sessionId=" + env.sessionId
            + " did=" + member.deviceId + " roles=[" + member.sessionRoles.join(",") + "] from=" + (env.from || "?"));
          /* La fusion complète sera également portée par le sync de l'émetteur ;
           * on ne re-broadcast pas ici pour éviter un écho (le sync arrive). */
          notifyChanged();
        });
      }
      emit("MEMBER_NOOP kind=" + env.kind + " sessionId=" + env.sessionId + " did=" + member.deviceId);
    }).catch(function (err) {
      emit("MEMBER_ERROR kind=" + env.kind + " sessionId=" + (env.sessionId || "?") + " err=" + (err && err.message));
    });
  }

  /* Un autre Master a retiré un membre : tombstone validé par le modèle de
   * l'émetteur. On applique le retrait localement (jamais les skills globales). */
  function handleMemberRemove(env, entry) {
    if (!env.sessionId || !env.deviceId) {
      emit("MEMBER_DROP kind=member_remove reason=malformed from=" + (env.from || "?"));
      return;
    }
    store().get(env.sessionId).then(function (local) {
      if (!local) {
        emit("MEMBER_DROP kind=member_remove reason=unknown_session sessionId=" + env.sessionId + " from=" + (env.from || "?"));
        return;
      }
      var res = model().removeMember(local, env.deviceId, env.from || "");
      if (!res.ok) {
        emit("MEMBER_REJECT kind=member_remove sessionId=" + env.sessionId
          + " did=" + env.deviceId + " reason=not_a_member from=" + (env.from || "?"));
        return;
      }
      if (res.changed) {
        return store().save(res.session).then(function () {
          emitEvents(res.events, env.sessionId, env.from);
          emit("MEMBER_REMOVE_RECEIVED sessionId=" + env.sessionId + " did=" + env.deviceId
            + " from=" + (env.from || "?"));
          notifyChanged();
        });
      }
      emit("MEMBER_REMOVE_NOOP sessionId=" + env.sessionId + " did=" + env.deviceId);
    }).catch(function (err) {
      emit("MEMBER_ERROR kind=member_remove sessionId=" + (env.sessionId || "?") + " err=" + (err && err.message));
    });
  }

  /* L'écran 02 consomme le dernier verdict de join (déduit du protocole, pas de
   * l'UI) — remis à null après lecture. */
  function takeJoinOutcome(sid) {
    if (!state.pendingJoin || (sid && state.pendingJoin.sid !== sid)) return null;
    var o = state.pendingJoin;
    state.pendingJoin = null;
    return o;
  }

  /* ---------- protocole J06 : Takes + télémétrie ---------- */

  /* Un autre Master a créé/modifié un Take. Le Take est déjà validé par le
   * modèle de l'émetteur ; on l'insère/remplace localement via upsertTake
   * (upsert idempotent, LMW) puis on propage. La convergence intégrale est
   * également portée par le sync (sharedView) de l'émetteur. */
  function handleTakeUpdate(env, entry) {
    if (!env.sessionId || !env.take || !env.take.takeNumber) {
      emit("TAKE_DROP kind=take_update reason=malformed from=" + (env.from || "?"));
      return;
    }
    store().get(env.sessionId).then(function (local) {
      if (!local) {
        emit("TAKE_DROP kind=take_update reason=unknown_session sessionId=" + env.sessionId + " from=" + (env.from || "?"));
        return;
      }
      /* Anti-rebond : un écho stale (même clé LMW, contenu plus vieux) ne doit
       * jamais régresser un Take local plus récent (J06-06 campagne). */
      var tmG = model() && model().takeModel;
      var current = (local.takes || []).filter(function (t) { return t.takeNumber === env.take.takeNumber; })[0];
      if (current && tmG) {
        var win = tmG.takeWinner(current, env.take);
        if (win === current && !tmG.takesEqual(current, env.take)) {
          emit("TAKE_IGNORED_STALE sessionId=" + env.sessionId + " take=" + env.take.takeNumber
            + " local_upd=" + (current.updatedAtMs || 0) + " peer_upd=" + (env.take.updatedAtMs || 0) + " from=" + (env.from || "?"));
          return;
        }
      }
      var actor = env.from || "";
      var res = model().upsertTake(local, env.take, actor);
      if (!res.ok) {
        emit("TAKE_REJECT kind=take_update sessionId=" + env.sessionId
          + " take=" + env.take.takeNumber + " reason=" + (res.error || "rejected") + " from=" + (env.from || "?"));
        return;
      }
      if (!res.changed) {
        emit("TAKE_NOOP kind=take_update sessionId=" + env.sessionId + " take=" + env.take.takeNumber + " from=" + (env.from || "?"));
        return;
      }
      return store().save(res.session).then(function () {
        emitEvents(res.events, env.sessionId, env.from);
        emit("TAKE_RECEIVED sessionId=" + env.sessionId + " take=" + res.session.takes.length
          + " event=" + res.events[0].type + " from=" + (env.from || "?"));
        notifyChanged();
      });
    }).catch(function (err) {
      emit("TAKE_ERROR kind=take_update sessionId=" + (env.sessionId || "?") + " err=" + (err && err.message));
    });
  }

  /* Un Master annonce SA PROPRE télémétrie (capacités/batterie/espace libre).
   * Régle J06 : SEUL env.from === deviceId est accepté (jamais d'invention
   * externe). Le sync complète. */
  function handleTelemetryUpdate(env, entry) {
    if (!env.sessionId || !env.deviceId || !env.from) {
      emit("TELEMETRY_DROP kind=telemetry_update reason=malformed from=" + (env.from || "?"));
      return;
    }
    if (env.from !== env.deviceId) {
      emit("TELEMETRY_DROP kind=telemetry_update sessionId=" + env.sessionId
        + " reason=not_self claimed=" + env.deviceId + " from=" + env.from);
      return;
    }
    store().get(env.sessionId).then(function (local) {
      if (!local) {
        emit("TELEMETRY_DROP kind=telemetry_update reason=unknown_session sessionId=" + env.sessionId + " from=" + (env.from || "?"));
        return;
      }
      var res = model().updateMemberTelemetry(local, env.deviceId, env.telemetry || {}, env.from);
      if (!res.ok) {
        emit("TELEMETRY_REJECT kind=telemetry_update sessionId=" + env.sessionId
          + " did=" + env.deviceId + " reason=" + (res.error || "rejected") + " from=" + env.from);
        return;
      }
      if (!res.changed) {
        emit("TELEMETRY_NOOP kind=telemetry_update sessionId=" + env.sessionId + " did=" + env.deviceId + " from=" + env.from);
        return;
      }
      return store().save(res.session).then(function () {
        /* Mémoire de supervision (J09-06) : le store ne fait qu'enregistrer ce
         * que le transport vient d'accepter, comme la boîte de réception le
         * fait pour une frame. Il ne filtre rien, ne décide rien, et n'est
         * JAMAIS relu ici : ce module reste un transport, et la lecture se fait
         * dans l'écran (main.js). */
        recordTelemetry(env.sessionId, env.deviceId, res.session, false);
        emitEvents(res.events, env.sessionId, env.from);
        emit("TELEMETRY_RECEIVED sessionId=" + env.sessionId + " did=" + env.deviceId + " from=" + env.from);
        notifyChanged();
      });
    }).catch(function (err) {
      emit("TELEMETRY_ERROR kind=telemetry_update sessionId=" + (env.sessionId || "?") + " err=" + (err && err.message));
    });
  }

  /* ---------- protocole J07 : ARM distribué + synchronisation d'horloge ---------- */

  /* TRANSPORT uniquement : aucune logique ARM ici (décision 30.10). Les messages
   * sont routés vers le pont applicatif (arm-service → arm-model) ; la réponse
   * arm_result / clock_sync_reply part sur la MÊME connexion que la demande. */

  function handleArmRequest(env, entry, serverConn) {
    if (!env.sessionId || !env.armCycleId || !Array.isArray(env.targets) || !env.takeNumber) {
      emit("ARM_TRANSPORT_DROP reason=malformed from=" + (env.from || "?"));
      return;
    }
    if (!state.armBridge || typeof state.armBridge.onArmRequest !== "function") {
      emit("ARM_TRANSPORT_DROP reason=no_bridge kind=arm_request sessionId=" + env.sessionId);
      return;
    }
    state.armBridge.onArmRequest(env, function (kind, extra) {
      if (kind === "arm_result" || kind === "clock_sync_reply") {
        sendReply(entry, serverConn, kind, env.sessionId, extra);
      }
    });
  }

  function handleArmResult(env) {
    if (!env.sessionId || !env.armCycleId || !env.deviceId) {
      emit("ARM_TRANSPORT_DROP reason=malformed from=" + (env.from || "?"));
      return;
    }
    if (!state.armBridge || typeof state.armBridge.onArmResult !== "function") return;
    state.armBridge.onArmResult(env);
  }

  function handleClockSync(env, entry, serverConn) {
    if (!env.sessionId || !env.armCycleId || typeof env.requestId === "undefined" || !env.target) {
      emit("CLOCK_TRANSPORT_DROP reason=malformed from=" + (env.from || "?"));
      return;
    }
    if (!state.armBridge || typeof state.armBridge.onClockSync !== "function") return;
    state.armBridge.onClockSync(env, function (kind, extra) {
      if (kind === "clock_sync_reply") {
        sendReply(entry, serverConn, kind, env.sessionId, extra);
      }
    });
  }

  function handleClockSyncReply(env) {
    if (!env.sessionId || !env.armCycleId || !env.from) return;
    if (!state.armBridge || typeof state.armBridge.onClockReply !== "function") return;
    state.armBridge.onClockReply(env);
  }

  /* ---------- protocole J08 : plan de START synchronisé ----------
   *
   * TRANSPORT uniquement (décision 30.10) : AUCUNE règle de J08 ici. Validation
   * STRUCTURALE minimale de l'enveloppe (les invariants métier — offsets frais,
   * arbitrage startPlanId, rôles, top — sont vérifiés par start-model via
   * start-service). Seule `start_probe` a une réponse dirigée, sur la MÊME
   * connexion que la demande (comme clock_sync en J07) : c'est la mesure NTP
   * courte qui permet à une Capture de connaître son décalage même si le
   * créateur du plan n'est pas dans clockOffsets.
   */

  var START_REPLY_KINDS = { start_probe_reply: true };

  function startIsMalformed(env) {
    if (!env.sessionId || !env.from) return true;
    switch (env.kind) {
      case "start_plan":
        return !env.plan || !env.plan.startPlanId || !env.plan.targetStartMs;
      case "start_cancel":
      case "start_state":
        return !env.startPlanId;
      case "start_probe":
        return typeof env.requestId === "undefined" || !env.target;
      case "start_probe_reply":
        return !env.startPlanId || typeof env.requestId === "undefined"
          || typeof env.t1 !== "number" || typeof env.t2 !== "number";
      default:
        return true;
    }
  }

  function handleStartMessage(env, entry, serverConn) {
    if (startIsMalformed(env)) {
      emit("START_TRANSPORT_DROP kind=" + env.kind + " reason=malformed from=" + (env.from || "?"));
      return;
    }
    if (!state.startBridge || typeof state.startBridge.onStartMessage !== "function") {
      emit("START_TRANSPORT_DROP kind=" + env.kind + " reason=no_bridge sessionId=" + env.sessionId);
      return;
    }
    state.startBridge.onStartMessage(env, function (kind, extra) {
      if (!START_REPLY_KINDS[kind]) {
        emit("START_TRANSPORT_DROP reply=" + kind + " reason=reply_kind_not_allowed");
        return;
      }
      sendReply(entry, serverConn, kind, env.sessionId, extra);
    });
  }

  /* ---------- broadcast ---------- */

  /* Envoie le sharedView (sans PIN) à tous les Masters connectés (serveur + client)
   * concernés par la session. Appelé après tout changement local (create/rename/close/
   * join) et sur demandes. */
  function broadcast(session, tag, extra) {
    var view = model().sharedView(session);
    var env = envelope("sync", session.sessionId, { state: view });
    var sent = 0;
    Object.keys(state.serverConns).forEach(function (uuid) {
      var entry = state.serverConns[uuid];
      if (entry && (inSession(entry, session.sessionId) || !entry.peerDid)) {
        if (sendServer(uuid, env)) sent++;
      }
    });
    Object.keys(state.clientConns).forEach(function (key) {
      var entry = state.clientConns[key];
      if (entry && inSession(entry, session.sessionId)) {
        if (sendOn(entry.ws, env)) sent++;
      }
    });
    emit("SYNC_BROADCAST sessionId=" + session.sessionId + " tag=" + (tag || "") + " peers=" + sent + (extra || ""));
  }

  /* ---------- API session (appelée par les écrans) ---------- */

  function ensureServer() {
    /* Application monodocument (index.html) : le cycle de vie réseau ne dépend pas
     * de l'écran affiché (décision 30.7). Le serveur générique démarre via
     * startServer() seulement ; pas de ré-attache natif : le plugin qualifié C2 ne
     * comporte AUCUNE action `status` (pas de logique MultiCam dans le plugin,
     * décision 30.10). L'état JS de ce document persiste, donc pas de double
     * démarrage possible. */
    bindLifecycle();
    return startServer().then(function (res) { return res.port; });
  }

  function advertiseOne(session) {
    /* Dé-dup : on ne ré-enregistre pas auprès du plugin NSD si le TXT DNS-SD
     * n'a pas changé (même sid, nom, port, deviceId). Cela empêche :
     * 1) l'accumulation d'instances "- THBVPJ77", "(2)", "(3)"… (défaut NSD).
     * 2) le déclenchement d'échos ping-pong de convergence. */
    if (!global.MultiCamNsd || !global.MultiCamNsd.advertiseSession) return Promise.resolve();
    if (!session || session.state !== "open") return Promise.resolve();
    refreshSelfEndpoint();
    var key = {
      name: session.name,
      did: cfg() ? cfg().deviceId : "",
      port: state.effectivePort,
      ver: (global.MultiCamDevice && global.MultiCamDevice.appVersion) || "0.0.0",
      sver: model().SCHEMA_VERSION
    };
    var prev = state.advertisedKey[session.sessionId];
    if (prev && prev.name === key.name && prev.port === key.port && prev.did === key.did
        && prev.ver === key.ver && prev.sver === key.sver) {
      emit("SESSION_ADVERTISE_SKIP sessionId=" + session.sessionId + " name=" + session.name + " reason=no_change");
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      var opts = { sessionId: session.sessionId, name: key.name, did: key.did, port: key.port, ver: key.ver, sver: key.sver };
      global.MultiCamNsd.advertiseSession(opts, function () {
        state.advertisedKey[session.sessionId] = key;
        emit("SESSION_ADVERTISE sessionId=" + session.sessionId + " name=" + session.name
          + " port=" + state.effectivePort + " type=_multicam-session._tcp.");
        resolve();
      }, function (err) {
        emit("SESSION_ADVERTISE_ERROR sessionId=" + session.sessionId + " err=" + err);
        resolve();
      });
    });
  }

  function advertiseOpenSessions() {
    if (!global.MultiCamNsd || !global.MultiCamNsd.advertiseSession) return Promise.resolve();
    return store().list().then(function (sessions) {
      var jobs = sessions
        .filter(function (s) { return s.state === "open"; })
        .map(function (s) { return advertiseOne(s); });
      return Promise.all(jobs);
    });
  }

  function unadvertise() {
    state.advertisedKey = {};
    if (global.MultiCamNsd && global.MultiCamNsd.unadvertiseSession) {
      return new Promise(function (resolve) {
        global.MultiCamNsd.unadvertiseSession(function () { resolve(); }, function () { resolve(); });
      });
    }
    return Promise.resolve();
  }

  function reSyncSession(session) {
    var sid = session && session.sessionId;
    /* Garde-fou : sans sessionId on ne sait ni journaliser ni dédupliquer.
     * On sort AVANT de toucher au throttle — sinon une session malformée
     * consommerait le budget d'une session réelle et l'empêcherait de
     * re-synchroniser au boot. */
    if (!sid) {
      emit("RE_SYNC_SKIP sessionId=? reason=no_session_id");
      return;
    }
    /* Throttle convergence (meilleure pratique anti-écho) : au plus une requête
     * sync_please toutes les 1 500 ms POUR UNE MÊME SESSION. Les diff sont déjà
     * portés en temps réel par le canal WS ; sync_please n'est qu'un mécanisme de
     * réparation.
     *
     * Le throttle est VOLONTAIREMENT indexé par sessionId : au boot,
     * `main.js:bootSession()` appelle cette fonction pour TOUTES les sessions
     * ouvertes dans un `forEach` synchrone. Avec un compteur global, la première
     * session consommait le quota et toutes les suivantes étaient rejetées à
     * quelques ms près — sans jamais être rejouées, faute de retry : sur un
     * device multi-sessions, une seule session re-rejoignait son Master au boot. */
    var now = nowMs();
    var last = state.lastResyncAt[sid] || 0;
    if (now - last < 1500) {
      emit("RE_SYNC_THROTTLED sessionId=" + sid + " dt=" + (now - last) + "ms");
      return;
    }
    state.lastResyncAt[sid] = now;
    /* Reproche l'état aux Masters connus (endpoints persistés). Best-effort. */
    var knownMasterDid = [];
    (session.masters || []).forEach(function (m) {
      if (m.deviceId === state.localDid) return;
      if (m.endpoint) {
        var parts = m.endpoint.split(":");
        var host = parts[0] || "";
        var port = parseInt(parts[1], 10) || 0;
        if (host && port) {
          knownMasterDid.push(m.deviceId);
          connectTo(host, port).then(function (ws) {
            var env = envelope("sync_please", session.sessionId, {});
            /* `SYNC_PLEASE_SENT` doit refléter un envoi RÉEL : sinon le log
             * certifie des messages que `sendOn()` a refusés. */
            if (sendOn(ws, env)) {
              emit("SYNC_PLEASE_SENT sessionId=" + session.sessionId + " to=" + m.deviceId
                + " endpoint=" + m.endpoint);
            } else {
              emit("SYNC_PLEASE_DROP sessionId=" + session.sessionId + " to=" + m.deviceId
                + " endpoint=" + m.endpoint);
            }
          }).catch(function () {
            emit("SYNC_PLEASE_CONNECT_FAIL sessionId=" + session.sessionId + " to=" + m.deviceId);
          });
        }
      } else {
        knownMasterDid.push(m.deviceId);
      }
    });
    if (knownMasterDid.length) {
      emit("RE_SYNC_START sessionId=" + session.sessionId + " peers=" + knownMasterDid.length
        + " list=" + JSON.stringify(knownMasterDid));
    }
  }

  /* ---------- API opérations (appelées par UI) ---------- */

  function createSession(name, selfMeta) {
    var cfgv = cfg();
    var self = {
      deviceId: cfgv ? cfgv.deviceId : "self",
      deviceName: (selfMeta && selfMeta.deviceName) || (cfgv && cfgv.deviceName) || "Cam",
      endpoint: state.selfEndpoint || selfEndpointFallback(),
      joinedAtMs: nowMs()
    };
    var s = model().createSession(name, self);
    return store().save(s).then(function () {
      emit("SESSION_CREATED sessionId=" + s.sessionId + " name=" + s.name
        + " state=" + s.state + " endpoint=" + self.endpoint
        + " pinGenerated=1");
      notifyChanged();
      return s;
    });
  }

  /* Le device rejoint via discovery : ouvre un client WS vers l'annonceur et
   * envoie join_req. Le PIN est envoyé une fois, jamais publié ailleurs. */
  function joinSession(discovered, pin) {
    var cfgv = cfg();
    var announcerHost = discovered.host;
    var announcerPort = discovered.port;
    if (!announcerHost || !announcerPort) return Promise.reject(new Error("no_endpoint"));
    var selfInfo = {
      deviceId: cfgv ? cfgv.deviceId : "self",
      deviceName: (cfgv && cfgv.deviceName) || "Cam",
      endpoint: refreshSelfEndpoint()
    };
    /* Copie locale provisoire (PIN local saisi — jamais transmis via sharedView). */
    var provisional = model().sanitizeSession({
      sessionId: discovered.sessionId,
      name: discovered.name,
      pin: pin,
      state: "open",
      createdAtMs: nowMs(),
      updatedAtMs: nowMs(),
      masters: []
    });
    return store().save(provisional).then(function () {
      return connectTo(announcerHost, announcerPort).then(function (ws) {
        state.pendingJoin = { sid: discovered.sessionId, host: announcerHost, port: announcerPort, ok: null, reason: "requested", atMs: nowMs() };
        var env = envelope("join_req", discovered.sessionId, {
          pin: pin,
          deviceName: selfInfo.deviceName,
          endpoint: selfInfo.endpoint
        });
        sendOn(ws, env);
        emit("JOIN_REQUEST sessionId=" + discovered.sessionId + " to=" + announcerHost + ":" + announcerPort
          + " did=" + selfInfo.deviceId + " name=" + selfInfo.deviceName);
        return ws;
      });
    }).catch(function (err) {
      state.pendingJoin = { sid: discovered.sessionId, host: announcerHost, port: announcerPort, ok: false, reason: "connect_failed:" + (err && err.message), atMs: nowMs() };
      throw err;
    });
  }

  function renameSession(session, newName) {
    var n = typeof newName === "string" ? newName.trim() : "";
    if (!n) return Promise.reject(new Error("name_empty"));
    // model().cloneSession + modification locale (LMW locale)
    var updated = model().cloneSession(session);
    updated.name = n;
    updated.nameUpdatedMs = nowMs();
    updated.nameByDeviceId = state.localDid || cfg().deviceId;
    updated.updatedAtMs = nowMs();
    return store().save(updated).then(function () {
      emit("RENAME_LOCAL sessionId=" + updated.sessionId + " to=" + n + " by=" + updated.nameByDeviceId);
      broadcast(updated, "rename");
      advertiseOne(updated);
      notifyChanged();
      return updated;
    });
  }

  function closeSession(session) {
    var closed = model().cloneSession(session);
    closed.state = "closed";
    closed.stateUpdatedMs = nowMs();
    closed.stateByDeviceId = state.localDid || (cfg() ? cfg().deviceId : "");
    closed.updatedAtMs = nowMs();
    return store().save(closed).then(function () {
      emit("SESSION_CLOSE_LOCAL sessionId=" + closed.sessionId + " by=" + closed.stateByDeviceId);
      broadcast(closed, "close");
      return unadvertise().then(function () {
        notifyChanged();
        return closed;
      });
    });
  }

  function selfEndpointFallback() {
    return state.selfEndpoint || "";
  }

  /* ---------- API J05 : gestion des membres (appelée par UI écran 03) ---------- */

  /* Ajoute (ou met à jour) un device comme membre de la session avec ses
   * sessionRoles. L'identité est le deviceId. Le modèle valide les rôles
   * (≥1 rôle annoncé) ; un échec est renvoyé sans toucher au store. Propage
   * member_add + broadcast du sharedView complet (convergence immédiate). */
  function addMember(session, peer, roles) {
    var actor = state.localDid || (cfg() ? cfg().deviceId : "");
    var res = model().addMember(session, peer, roles, actor);
    if (!res.ok) {
      emit("MEMBER_ADD_REJECT sessionId=" + session.sessionId + " did=" + (peer && peer.deviceId)
        + " roles=[" + (Array.isArray(roles) ? roles.join(",") : "") + "] reason=" + (res.error || "rejected")
        + " rejected=[" + (res.rejected || []).join(",") + "]");
      return Promise.reject(new Error(res.error || "member_add_rejected"));
    }
    if (!res.changed) {
      emit("MEMBER_ADD_NOOP sessionId=" + session.sessionId + " did=" + peer.deviceId);
      return Promise.resolve(session);
    }
    return store().save(res.session).then(function () {
      emit("MEMBER_ADD_LOCAL sessionId=" + res.session.sessionId + " did=" + peer.deviceId
        + " roles=[" + res.session.members.filter(function (m) { return m.deviceId === peer.deviceId; }).map(function (m) { return m.sessionRoles.join("+"); }).join(",")
        + "] by=" + actor);
      emitEvents(res.events, res.session.sessionId, actor);
      broadcastMember("member_add", res.session, { member: res.session.members.filter(function (m) { return m.deviceId === peer.deviceId; })[0] });
      broadcast(res.session, "member_add", " did=" + peer.deviceId);
      notifyChanged();
      /* 31.2 : l'ajout doit intégrer le device, pas seulement l'annoncer —
       * invitation directe sur l'endpoint découvert. Délibérément NON attendu :
       * l'écran 03 ne doit jamais rester bloqué sur un device injoignable, et le
       * device reste membre (il rejoint par le flux normal ensuite). */
      inviteAddedDevice(res.session, peer, roles);
      return res.session;
    });
  }

  /* Modifie les rôles d'un membre existant (crayon). */
  function updateMemberRoles(session, deviceId, roles) {
    var actor = state.localDid || (cfg() ? cfg().deviceId : "");
    var res = model().updateMemberRoles(session, deviceId, roles, actor);
    if (!res.ok) {
      emit("MEMBER_UPDATE_REJECT sessionId=" + session.sessionId + " did=" + deviceId
        + " roles=[" + (Array.isArray(roles) ? roles.join(",") : "") + "] reason=" + (res.error || "rejected")
        + " rejected=[" + (res.rejected || []).join(",") + "]");
      return Promise.reject(new Error(res.error || "member_update_rejected"));
    }
    if (!res.changed) {
      emit("MEMBER_UPDATE_NOOP sessionId=" + session.sessionId + " did=" + deviceId);
      return Promise.resolve(session);
    }
    return store().save(res.session).then(function () {
      emit("MEMBER_UPDATE_LOCAL sessionId=" + res.session.sessionId + " did=" + deviceId
        + " roles=[" + roles.join(",") + "] by=" + actor);
      emitEvents(res.events, res.session.sessionId, actor);
      broadcastMember("member_update", res.session, { member: res.session.members.filter(function (m) { return m.deviceId === deviceId; })[0] });
      broadcast(res.session, "member_update", " did=" + deviceId);
      notifyChanged();
      return res.session;
    });
  }

  /* Retire un membre (membership + rôles). Ne touche jamais aux skills globales
   * du device. Propage member_remove + broadcast du sharedView (tombstone). */
  function removeMember(session, deviceId) {
    var actor = state.localDid || (cfg() ? cfg().deviceId : "");
    var res = model().removeMember(session, deviceId, actor);
    if (!res.ok) {
      emit("MEMBER_REMOVE_REJECT sessionId=" + session.sessionId + " did=" + deviceId + " reason=" + (res.error || "not_a_member"));
      return Promise.reject(new Error(res.error || "not_a_member"));
    }
    if (!res.changed) {
      emit("MEMBER_REMOVE_NOOP sessionId=" + session.sessionId + " did=" + deviceId);
      return Promise.resolve(session);
    }
    return store().save(res.session).then(function () {
      emit("MEMBER_REMOVE_LOCAL sessionId=" + res.session.sessionId + " did=" + deviceId + " by=" + actor);
      emitEvents(res.events, res.session.sessionId, actor);
      broadcastMember("member_remove", res.session, { deviceId: deviceId, removedAtMs: res.session.removedMembers[deviceId] ? res.session.removedMembers[deviceId].removedAtMs : 0, removedByDeviceId: actor });
      broadcast(res.session, "member_remove", " did=" + deviceId);
      notifyChanged();
      return res.session;
    });
  }

  /* On envoie maintenant l'API J06. D'abord un broadcast ciblé générique
   * (diagnostic précis + convergence intégrale par le sync qui suit). */
  function broadcastTargeted(kind, session, extra) {
    var env = envelope(kind, session.sessionId, extra);
    var sent = 0;
    Object.keys(state.serverConns).forEach(function (uuid) {
      var entry = state.serverConns[uuid];
      if (entry && (inSession(entry, session.sessionId) || !entry.peerDid)) {
        if (sendServer(uuid, env)) sent++;
      }
    });
    Object.keys(state.clientConns).forEach(function (key) {
      var entry = state.clientConns[key];
      if (entry && inSession(entry, session.sessionId)) {
        if (sendOn(entry.ws, env)) sent++;
      }
    });
    emit("TARGETED_BROADCAST kind=" + kind + " sessionId=" + session.sessionId + " peers=" + sent);
  }

  /* ---------- API J06 : Takes (écran 05) ---------- */

  /* Remplace/insère un Take (mutations de l'écran 05). Propage take_update +
   * broadcast du sharedView (convergence immédiate, LMW). */
  function upsertTake(session, take) {
    var actor = state.localDid || (cfg() ? cfg().deviceId : "");
    var res = model().upsertTake(session, take, actor);
    if (!res.ok) {
      emit("TAKE_UPDATE_REJECT sessionId=" + session.sessionId + " reason=" + (res.error || "rejected"));
      return Promise.reject(new Error(res.error || "take_upsert_rejected"));
    }
    if (!res.changed) {
      emit("TAKE_UPDATE_NOOP sessionId=" + session.sessionId + " take=" + (take && take.takeNumber));
      return Promise.resolve(session);
    }
    return store().save(res.session).then(function () {
      emit("TAKE_UPDATE_LOCAL sessionId=" + res.session.sessionId + " take=" + (take && take.takeNumber)
        + " event=" + res.events[0].type + " by=" + actor);
      emitEvents(res.events, res.session.sessionId, actor);
      broadcastTargeted("take_update", res.session, { take: res.session.takes.filter(function (t) { return t.takeNumber === take.takeNumber; })[0] });
      broadcast(res.session, "take_update", " take=" + (take && take.takeNumber));
      notifyChanged();
      return res.session;
    });
  }

  /* Nouveau Take (hérite du précédent). Retour Promise<{ session, takeNumber }>. */
  function newTake(session) {
    var actor = state.localDid || (cfg() ? cfg().deviceId : "");
    var res = model().newTake(session, actor);
    if (!res.ok) {
      emit("TAKE_NEW_REJECT sessionId=" + session.sessionId + " reason=" + (res.error || "rejected"));
      return Promise.reject(new Error(res.error || "take_new_rejected"));
    }
    if (!res.changed) {
      emit("TAKE_NEW_NOOP sessionId=" + session.sessionId);
      return Promise.resolve({ session: res.session, takeNumber: res.takeNumber });
    }
    return store().save(res.session).then(function () {
      emit("TAKE_NEW_LOCAL sessionId=" + res.session.sessionId + " take=" + res.takeNumber + " by=" + actor);
      emitEvents(res.events, res.session.sessionId, actor);
      broadcastTargeted("take_update", res.session, { take: res.session.takes.filter(function (t) { return t.takeNumber === res.takeNumber; })[0] });
      broadcast(res.session, "take_update", " take=" + res.takeNumber);
      notifyChanged();
      return { session: res.session, takeNumber: res.takeNumber };
    });
  }

  /* ---------- API J06 : télémétrie auto-déclarée ---------- */

  /* Mémoire de supervision : on lit la télémétrie tel qu'elle vient d'être
   * validée par le MODÈLE (donc déjà assainie : impossible d'y injecter un
   * champ concret), et on l'indexe par (sessionId, deviceId). `local` marque le
   * chemin auto-déclaré, qui n'a fait aucun aller-retour réseau. Si le store
   * n'est pas chargé, on ne casse surtout pas le protocole : l'évènement
   * TelemetryStore n'est simplement pas journalisé. */
  function recordTelemetry(sessionId, deviceId, session, local) {
    var ts = global.MultiCamTelemetryStore;
    if (!ts || typeof ts.set !== "function") return false;
    var member = (session.members || []).filter(function (m) { return m.deviceId === deviceId; })[0];
    if (!member || !member.telemetry) return false;
    var applied = ts.set(sessionId, deviceId, member.telemetry, member.telemetry.atMs, { local: !!local });
    if (applied) ts.emit(deviceId);
    emit("TELEMETRY_STORE_SET sessionId=" + sessionId + " did=" + deviceId
      + " local=" + (!!local ? 1 : 0) + " atMs=" + (member.telemetry.atMs || "—"));
    return applied;
  }

  /* Le device local déclare CAPACITÉS + batterie + espace libre (natif). Seul
   * soi-même : le protocole refuse telemetry_update dont le from != deviceId. */
  function updateMemberTelemetry(session, deviceId, telemetry) {
    var actor = state.localDid || (cfg() ? cfg().deviceId : "");
    if (deviceId !== actor) {
      emit("TELEMETRY_REJECT sessionId=" + session.sessionId + " did=" + deviceId
        + " reason=not_self by=" + actor);
      return Promise.reject(new Error("telemetry_not_self"));
    }
    var res = model().updateMemberTelemetry(session, deviceId, telemetry, actor);
    if (!res.ok) {
      emit("TELEMETRY_UPDATE_REJECT sessionId=" + session.sessionId + " did=" + deviceId
        + " reason=" + (res.error || "rejected"));
      return Promise.reject(new Error(res.error || "telemetry_rejected"));
    }
    if (!res.changed) {
      emit("TELEMETRY_UPDATE_NOOP sessionId=" + session.sessionId + " did=" + deviceId);
      return Promise.resolve(session);
    }
    return store().save(res.session).then(function () {
      /* Cas du Master QUI EST AUSSI Capture : la télémétrie locale est
       * enregistrée ici, en mémoire, SANS aller-retour réseau. Lui envoyer sa
       * propre télémétrie pour la lire serait un loopback inutile (le transport
       * écarte déjà le self-loop des previews, J09-04 : même règle ici). */
      recordTelemetry(res.session.sessionId, deviceId, res.session, true);
      emit("TELEMETRY_UPDATE_LOCAL sessionId=" + res.session.sessionId + " did=" + deviceId + " by=" + actor);
      emitEvents(res.events, res.session.sessionId, actor);
      broadcastTargeted("telemetry_update", res.session, {
        deviceId: deviceId,
        telemetry: res.session.members.filter(function (m) { return m.deviceId === deviceId; })[0] ? res.session.members.filter(function (m) { return m.deviceId === deviceId; })[0].telemetry : null
      });
      broadcast(res.session, "telemetry_update", " did=" + deviceId);
      notifyChanged();
      return res.session;
    });
  }

  /* Enveloppe ciblée membre (émit en parallèle avec le broadcast du sharedView
   * complet : la cible donne un évènement diagnostic précis, le sync assure la
   * convergence intégrale). Même destinataire que broadcast(). */
  function broadcastMember(kind, session, extra) {
    var env = envelope(kind, session.sessionId, extra);
    var sent = 0;
    Object.keys(state.serverConns).forEach(function (uuid) {
      var entry = state.serverConns[uuid];
      if (entry && (inSession(entry, session.sessionId) || !entry.peerDid)) {
        if (sendServer(uuid, env)) sent++;
      }
    });
    Object.keys(state.clientConns).forEach(function (key) {
      var entry = state.clientConns[key];
      if (entry && inSession(entry, session.sessionId)) {
        if (sendOn(entry.ws, env)) sent++;
      }
    });
    emit("MEMBER_BROADCAST kind=" + kind + " sessionId=" + session.sessionId + " peers=" + sent);
  }

  /* ---------- heartbeat / liveness (§30.4/30.8) ---------- */

  function startHeartbeat() {
    stopHeartbeat();
    var probe = function () {
      var now = nowMs();
      /* Serveur : ping aux conns anonymes/actives, purge des expirés. */
      Object.keys(state.serverConns).forEach(function (uuid) {
        var entry = state.serverConns[uuid];
        if (!entry) return;
        if (now - entry.lastRxMs > HB_TIMEOUT_MS) {
          var did = entry.peerDid || "";
          delete state.serverConns[uuid];
          emit("WS_CONN_TIMEOUT uuid=" + uuid.substr(0, 8) + "… did=" + (did || "anon"));
          if (did) emit("PEER_DISCONNECTED did=" + did + " reason=heartbeat_timeout");
          notifyChanged();
          return;
        }
        sendServer(uuid, envelope("ping", null, {}));
      });
      /* Client. */
      Object.keys(state.clientConns).forEach(function (key) {
        var entry = state.clientConns[key];
        if (!entry || !entry.ws) return;
        if (entry.ws.readyState !== WebSocket.OPEN) return;
        if (now - entry.lastRxMs > HB_TIMEOUT_MS) {
          var did = entry.did || "";
          delete state.clientConns[key];
          emit("WS_CLIENT_TIMEOUT endpoint=" + key + " did=" + (did || "?"));
          if (did) emit("PEER_DISCONNECTED did=" + did + " reason=heartbeat_timeout");
          /* Le `close()` déclenche `ws.onclose`, qui arme le retry : rien de plus
           * à faire ici — un lien muet est un lien à reprendre, pas à oublier. */
          try { entry.ws.close(); } catch (e) {}
          notifyChanged();
          return;
        }
        sendOn(entry.ws, envelope("ping", null, {}));
      });
    };
    state.hbTimer = setInterval(probe, HB_INTERVAL_MS);
    emit("WS_HEARTBEAT_START interval=" + HB_INTERVAL_MS + "ms timeout=" + HB_TIMEOUT_MS + "ms");
  }

  function stopHeartbeat() {
    if (state.hbTimer) clearInterval(state.hbTimer);
    state.hbTimer = null;
  }

  /* ---------- état exposé ---------- */

  function connectedPeers(sessionId) {
    var out = {};
    Object.keys(state.serverConns).forEach(function (uuid) {
      var e = state.serverConns[uuid];
      if (e.peerDid && (!sessionId || inSession(e, sessionId))) {
        out[e.peerDid] = { via: "server", lastRxMs: e.lastRxMs };
      }
    });
    Object.keys(state.clientConns).forEach(function (key) {
      var e = state.clientConns[key];
      if (e.did && (!sessionId || inSession(e, sessionId))) {
        var prev = out[e.did] || {};
        out[e.did] = { via: "client", lastRxMs: e.lastRxMs, server: prev.via || "" };
      }
    });
    return out;
  }

  function status() {
    return {
      serverRunning: state.serverRunning,
      effectivePort: state.effectivePort,
      localDid: state.localDid,
      localName: state.localName,
      selfEndpoint: state.selfEndpoint,
      serverConns: Object.keys(state.serverConns).length,
      clientConns: Object.keys(state.clientConns).length,
      heartbeat: !!state.hbTimer
    };
  }

  /* Cycle de vie Android : en arrière-plan le transport ne martèle pas le
   * réseau, et le retour au premier plan rouvre ce qui doit l'être (30.7 : la
   * connexion ne dépend pas de l'écran affiché). Branché sur `bind()` ET sur
   * `ensureServer()` : la reprise réseau est critique, elle ne doit pas
   * dépendre du seul chemin de boot UI. */
  function bindLifecycle() {
    var d = global.document;
    if (state.lifecycleBound || !d || typeof d.addEventListener !== "function") return;
    d.addEventListener("pause", function () { onLifecycle(false); });
    d.addEventListener("resume", function () { onLifecycle(true); });
    state.lifecycleBound = true;
  }

  function bind(cfgv) {
    state.localDid = cfgv.deviceId;
    state.localName = cfgv.deviceName;
    warmIpCache();
    bindLifecycle();
  }

  global.MultiCamSessionWs = {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    WS_BASE_PORT: WS_BASE_PORT,
    bind: bind,
    ensureServer: ensureServer,
    stopServer: stopServer,
    connectTo: connectTo,
    createSession: createSession,
    joinSession: joinSession,
    renameSession: renameSession,
    closeSession: closeSession,
    addMember: addMember,
    updateMemberRoles: updateMemberRoles,
    removeMember: removeMember,
    upsertTake: upsertTake,
    newTake: newTake,
    updateMemberTelemetry: updateMemberTelemetry,
    semanticEqual: semanticEqual,
    advertiseOpenSessions: advertiseOpenSessions,
    unadvertise: unadvertise,
    reSyncSession: reSyncSession,
    broadcast: broadcast,
    broadcastTargeted: broadcastTargeted,
    takeJoinOutcome: takeJoinOutcome,
    connectedPeers: connectedPeers,
    status: status,
    setArmBridge: function (bridge) {
      state.armBridge = bridge || null;
    },
    setStartBridge: function (bridge) {
      state.startBridge = bridge || null;
    },
    sendPreviewFrame: sendPreviewFrame,
    setPreviewBridge: function (bridge) {
      state.previewBridge = bridge || null;
    },
    /* J09-07 */
    sendToDevice: sendToDevice,
    reply: reply,
    broadcastCameraState: broadcastCameraState,
    setCameraSwitchBridge: function (bridge) {
      state.cameraBridge = bridge || null;
    },
    onChanged: function (fn) {
      if (typeof fn === "function" && state.listeners.indexOf(fn) < 0) state.listeners.push(fn);
    }
  };
})(window);