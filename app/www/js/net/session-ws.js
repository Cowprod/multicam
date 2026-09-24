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
 *   - broadcast du sharedView (jamais le PIN) aux Masters connectés ;
 *   - convergence par fusion §30.9 + §31 (closed>open, LMW nom, PIN immuable,
 *     masters par deviceId, members par deviceId avec sessionRoles validés).
 *
 * Journalisation parsable : WS_*, FALLBACK, JOIN_*, SYNC_*, RENAME_*,
 * SESSION_CLOSE_*, MEMBER_*, PEER_* (voir AGENTS.md — exigence journalisation
 * distribuée).
 */

(function (global) {
  "use strict";

  var PROTOCOL_VERSION = 1;
  var WS_BASE_PORT = 45102;
  var WS_PORT_WINDOW = 9;                    /* 45102..45111 (Partie A) */
  var HB_INTERVAL_MS = 2000;
  var HB_TIMEOUT_MS = 8000;

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
    lastResyncMs: 0        /* anti-écho : throttle des sync_please (convergence) */
  };

  var _ipCache = "";       /* IPv4 synchrone (warm-up asynchrone via MultiCamNative) */

  function notifyChanged() {
    state.listeners.slice().forEach(function (fn) { fn(); });
  }

  function cfg() {
    return (global.MultiCamConfig && global.MultiCamConfig.get) ? global.MultiCamConfig.get() : null;
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
      sessionId: null,
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
          resolve({ port: effectivePort });
        }, function (err) {
          advance("execcb:" + JSON.stringify(err));
        });
      };
      attempt();
    });
  }

  function stopServer() {
    var ws = wsserver();
    if (!ws) return;
    if (state.serverRunning) {
      try { ws.stop(function () {}, function () {}); } catch (e) {}
    }
    stopHeartbeat();
    state.serverRunning = false;
    state.effectivePort = -1;
    state.serverConns = {};
    state.clientConns = {};
    emit("WS_SERVER_STOP reason=app");
    notifyChanged();
  }

  /* ---------- client (standard WebView WebSocket) ---------- */

  /* Ouvre (ou ressort) une connexion client vers host:port. Résout le WebSocket
   * ouvert. Les messages entrants sont routés comme ceux du serveur. */
  function connectTo(host, port) {
    var key = host + ":" + port;
    var prev = state.clientConns[key];
    if (prev && prev.ws && prev.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(prev.ws);
    }
    if (prev && (prev.closing || prev.ws.readyState === WebSocket.CONNECTING)) {
      return Promise.resolve(prev.ws);
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
      var entry = { ws: ws, did: null, sessionId: null, lastRxMs: nowMs(), closing: false };
      state.clientConns[key] = entry;
      ws.binaryType = "arraybuffer";
      ws.onopen = function () {
        if (entry.closing) return;
        emit("WS_CLIENT_OPEN endpoint=" + key);
        resolve(ws);
        notifyChanged();
      };
      ws.onmessage = function (ev) {
        entry.lastRxMs = nowMs();
        if (typeof ev.data === "string") {
          var env = parseEnvelope(ev.data);
          if (env) {
            if (env.from) entry.did = env.from;
            if (env.sessionId) entry.sessionId = env.sessionId;
            handleIncoming(env, entry);
          } else {
            emit("WS_CLIENT_PARSE_ERROR endpoint=" + key);
          }
        }
      };
      ws.onclose = function (ev) {
        if (state.clientConns[key] === entry) delete state.clientConns[key];
        var did = entry.did;
        emit("WS_CLIENT_CLOSE endpoint=" + key + " code=" + ev.code + " reason=" + ev.reason
          + " did=" + (did || ""));
        if (did) emit("PEER_DISCONNECTED did=" + did + " reason=ws_client_close");
        notifyChanged();
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
    var e = { v: PROTOCOL_VERSION, kind: kind, from: state.localDid, ts: nowMs() };
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
    if (entry && env.from) entry.peerDid = env.from;
    if (entry && env.sessionId) entry.sessionId = env.sessionId;
    /* Lie le conn au deviceId/peer en amont du traitement (broadcast + PEER_CONNECTED). */
    if (entry && env.from) {
      var wasUnknown = !entry.peerDid;
      entry.peerDid = env.from;
      if (wasUnknown) emit("PEER_CONNECTED did=" + env.from + " via=ws_server uuid=" + conn.uuid.substr(0, 8) + "…");
    }
    handleIncoming(env, entry, conn);
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
      default:
        emit("WS_DROP kind=" + env.kind + " v=" + env.v + " reason=unknown_kind from=" + (env.from || "?"));
        break;
    }
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
        emitEvents(res.events, env.sessionId, env.from);
        emit("TELEMETRY_RECEIVED sessionId=" + env.sessionId + " did=" + env.deviceId + " from=" + env.from);
        notifyChanged();
      });
    }).catch(function (err) {
      emit("TELEMETRY_ERROR kind=telemetry_update sessionId=" + (env.sessionId || "?") + " err=" + (err && err.message));
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
      if (entry && (!entry.sessionId || entry.sessionId === session.sessionId || !entry.peerDid)) {
        if (sendServer(uuid, env)) sent++;
      }
    });
    Object.keys(state.clientConns).forEach(function (key) {
      var entry = state.clientConns[key];
      if (entry && (!entry.sessionId || entry.sessionId === session.sessionId)) {
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
    /* Throttle convergence (meilleure pratique anti-écho) : au plus une requête
     * sync_please toutes les 1 500 ms. Les diff sont déjà portés en temps réel
     * par le canal WS ; sync_please n'est qu'un mécanisme de réparation. */
    var now = nowMs();
    if (now - state.lastResyncMs < 1500) {
      emit("RE_SYNC_THROTTLED sessionId=" + session.sessionId + " dt=" + (now - state.lastResyncMs) + "ms");
      return;
    }
    state.lastResyncMs = now;
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
            sendOn(ws, env);
            emit("SYNC_PLEASE_SENT sessionId=" + session.sessionId + " to=" + m.deviceId
              + " endpoint=" + m.endpoint);
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
      if (entry && (!entry.sessionId || entry.sessionId === session.sessionId || !entry.peerDid)) {
        if (sendServer(uuid, env)) sent++;
      }
    });
    Object.keys(state.clientConns).forEach(function (key) {
      var entry = state.clientConns[key];
      if (entry && (!entry.sessionId || entry.sessionId === session.sessionId)) {
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
      if (entry && (!entry.sessionId || entry.sessionId === session.sessionId || !entry.peerDid)) {
        if (sendServer(uuid, env)) sent++;
      }
    });
    Object.keys(state.clientConns).forEach(function (key) {
      var entry = state.clientConns[key];
      if (entry && (!entry.sessionId || entry.sessionId === session.sessionId)) {
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
        sendServer(uuid, envelope("ping", entry.sessionId || null, {}));
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
          try { entry.ws.close(); } catch (e) {}
          notifyChanged();
          return;
        }
        sendOn(entry.ws, envelope("ping", entry.sessionId || null, {}));
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
      if (e.peerDid && (!sessionId || !e.sessionId || e.sessionId === sessionId)) {
        out[e.peerDid] = { via: "server", lastRxMs: e.lastRxMs };
      }
    });
    Object.keys(state.clientConns).forEach(function (key) {
      var e = state.clientConns[key];
      if (e.did && (!sessionId || !e.sessionId || e.sessionId === sessionId)) {
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

  function bind(cfgv) {
    state.localDid = cfgv.deviceId;
    state.localName = cfgv.deviceName;
    warmIpCache();
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
    takeJoinOutcome: takeJoinOutcome,
    connectedPeers: connectedPeers,
    status: status,
    onChanged: function (fn) {
      if (typeof fn === "function" && state.listeners.indexOf(fn) < 0) state.listeners.push(fn);
    }
  };
})(window);