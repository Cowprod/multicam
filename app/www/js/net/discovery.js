/* MultiCam — découverte LAN mDNS/DNS-SD (J03).
 * Couche haut niveau au-dessus du plugin local cordova-plugin-multicam-nsd :
 * - table canonique des peers keyée par deviceId J02 (jamais IP / nom / modèle) ;
 * - cycle de vie en s'appuyant sur les événements NSD réels (found / updated / lost) ;
 * - auto-filtre deself par deviceId local ;
 * - re-annonce propre (unregister/register) sur renommage ou changement de skills ;
 * - journalisation parsable MDNS_* / HEALTH_* / NET_* (voir PLAN).
 * Navigation entre pages : le plugin natif persiste dans la WebView, donc il
 * suffit de ré-attacher le canal d'événements (status → reattached) à chaque
 * (re)chargement de document ; la table est persistée en sessionStorage pour
 * survivre aux navigations accueil <-> paramètres.
 * Règles : aucune identité dérivée du réseau, aucun doublon de peer, perte par
 * serviceLost (source primaire), fallback stale configurable (0 = désactivé). */

(function (global) {
  "use strict";

  var SERVICE_TYPE = "_multicam._tcp.";
  var DEFAULT_PORT = 45101;
  var PEER_STORE = "multicam.mdns.peers";

  var state = {
    running: false,
    starting: false,
    registeredName: null,
    nsdPath: "unknown",
    sdk: null,
    healthPort: -1,
    networkType: null,
    ipv4: null,
    localDid: null,
    localName: "",
    supported: [],
    enabled: [],
    version: "0.0.0",
    sver: 1,
    peers: {},
    nsdNameToDid: {},
    staleTimeoutMs: 0,
    staleTimer: null,
    listeners: []
  };

  function cfg() {
    return (global.MultiCamConfig && global.MultiCamConfig.get) ? global.MultiCamConfig.get() : null;
  }

  function advertiseOptions() {
    var c = cfg();
    if (!c) return null;
    var info = (global.MultiCamDevice && global.MultiCamDevice.getInfo) ? global.MultiCamDevice.getInfo() : null;
    return {
      deviceId: c.deviceId,
      deviceName: c.deviceName,
      supportedSkills: c.supportedSkills.slice(),
      enabledSkills: c.enabledSkills.slice(),
      version: (info && info.appVersion) || "0.0.0",
      sver: 1,
      serviceType: SERVICE_TYPE,
      port: DEFAULT_PORT,
      multicastLock: false
    };
  }

  function plugin() {
    return global.MultiCamNsd || null;
  }

  function notifyChanged() {
    state.listeners.slice().forEach(function (fn) { fn(); });
  }

  function emit(line) { console.log(line); }

  function tableRows() {
    return Object.keys(state.peers).map(function (did) {
      return state.peers[did];
    }).sort(function (a, b) {
      return (a.name || a.deviceId).localeCompare(b.name || b.deviceId);
    });
  }

  function dumpTable(tag) {
    var rows = tableRows().map(function (p) {
      return {
        deviceId: p.deviceId, name: p.name,
        supported: p.supportedSkills, enabled: p.enabledSkills,
        version: p.version, endpoint: p.endpoint,
        state: p.state, firstSeen: p.firstSeen, lastSeen: p.lastSeen
      };
    });
    emit("MDNS_PEER_TABLE " + tag + " peers=" + rows.length + " rows=" + JSON.stringify(rows));
  }

  function persistPeers(reason) {
    try {
      global.sessionStorage.setItem(PEER_STORE, JSON.stringify({ savedAt: Date.now(), reason: reason, peers: tableRows() }));
    } catch (e) {}
  }

  function restorePeers() {
    var raw = null;
    try { raw = global.sessionStorage.getItem(PEER_STORE); } catch (e) {}
    if (!raw) return 0;
    try {
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.peers)) return 0;
      var now = Date.now();
      var restored = 0;
      data.peers.forEach(function (p) {
        if (!p || !p.deviceId) return;
        if (state.localDid && p.deviceId === state.localDid) return;
        var prev = state.peers[p.deviceId];
        if (!prev) {
          state.peers[p.deviceId] = {
            deviceId: p.deviceId, name: p.name || p.deviceId,
            supportedSkills: Array.isArray(p.supportedSkills) ? p.supportedSkills : splitSkills(p.supported),
            enabledSkills: Array.isArray(p.enabledSkills) ? p.enabledSkills : splitSkills(p.enabled),
            version: p.version || "", host: p.host || "", port: p.port || 0,
            endpoint: p.endpoint || "", state: "online", firstSeen: now, lastSeen: now
          };
          restored++;
        }
      });
      if (restored) emit("MDNS_PEER_RESTORED peers=" + restored + " source=sessionStorage");
      return restored;
    } catch (e) { return 0; }
  }

  function splitSkills(v) {
    if (!v) return [];
    return String(v).split(",").map(function (s) { return s.trim(); }).filter(function (s) { return s; });
  }

  function peerDiff(prev, next) {
    var changed = [];
    if (prev.name !== next.name) changed.push("name");
    if (prev.supportedSkills.join(",") !== next.supportedSkills.join(",")) changed.push("supported");
    if (prev.enabledSkills.join(",") !== next.enabledSkills.join(",")) changed.push("enabled");
    if (prev.version !== next.version) changed.push("version");
    if (prev.endpoint !== next.endpoint) changed.push("endpoint");
    return changed;
  }

  function removePeer(did, reason, extra) {
    if (!state.peers[did]) return false;
    delete state.peers[did];
    Object.keys(state.nsdNameToDid).forEach(function (n) {
      if (state.nsdNameToDid[n] === did) delete state.nsdNameToDid[n];
    });
    emit("MDNS_PEER_LOST deviceId=" + did + " reason=" + reason + (extra || ""));
    dumpTable("lost");
    persistPeers(reason);
    notifyChanged();
    return true;
  }

  function clearAllPeers(reason) {
    tableRows().slice().forEach(function (p) { removePeer(p.deviceId, reason); });
  }

  function handleServiceUpdated(ev) {
    var txt = ev.txt || {};
    var did = txt.did;
    if (!did) {
      emit("MDNS_ERROR code=missing_deviceId service=" + (ev.serviceName || "?"));
      return;
    }
    if (state.localDid && did === state.localDid) return; // self-filter (règle : did)
    if (ev.serviceName) state.nsdNameToDid[ev.serviceName] = did;

    var host = ev.host || "";
    var port = ev.port || 0;
    var endpoint = host ? host + ":" + port : "";
    var now = Date.now();
    var next = {
      deviceId: did,
      name: txt.dname || ev.serviceName || did,
      supportedSkills: splitSkills(txt.supported),
      enabledSkills: splitSkills(txt.enabled),
      version: txt.ver || "",
      host: host,
      port: port,
      endpoint: endpoint,
      state: "online",
      firstSeen: now,
      lastSeen: now,
      lastResolveMs: ev.ts || now
    };
    emit("MDNS_RESOLVE deviceId=" + did + " result=OK host=" + host + " port=" + port + " service=" + (ev.serviceName || ""));

    if (!state.peers[did]) {
      state.peers[did] = next;
      emit("MDNS_PEER_FOUND deviceId=" + did + " name=" + next.name
        + " supported=[" + next.supportedSkills.join(",") + "]"
        + " enabled=[" + next.enabledSkills.join(",") + "]"
        + " version=" + next.version + " endpoint=" + endpoint);
      dumpTable("found");
      persistPeers("found");
      notifyChanged();
      return;
    }
    var prev = state.peers[did];
    prev.lastSeen = now;
    prev.lastResolveMs = ev.ts || now;
    var changed = peerDiff(prev, next);
    if (changed.length) {
      prev.name = next.name;
      prev.supportedSkills = next.supportedSkills;
      prev.enabledSkills = next.enabledSkills;
      prev.version = next.version;
      prev.host = next.host;
      prev.port = next.port;
      prev.endpoint = next.endpoint;
      emit("MDNS_PEER_UPDATED deviceId=" + did + " fields=[" + changed.join(",") + "]"
        + " name=" + next.name + " enabled=[" + next.enabledSkills.join(",") + "]"
        + " endpoint=" + endpoint);
      dumpTable("updated");
      persistPeers("updated");
      notifyChanged();
    }
  }

  function handleServiceLost(ev) {
    var name = ev.serviceName;
    var did = state.nsdNameToDid[name];
    if (did) {
      removePeer(did, "serviceLost", " service=" + name);
    } else {
      emit("MDNS_SERVICE_LOST_UNMAPPED service=" + (name || "?"));
    }
  }

  function handleEvent(ev) {
    if (!ev || !ev.type) return;
    var type = ev.type;
    switch (type) {
      case "nsdPath":
        state.nsdPath = ev.nsdPath;
        state.sdk = ev.sdk;
        emit("MDNS_NSD_PATH path=" + state.nsdPath + " sdk=" + state.sdk);
        break;
      case "advertised":
        state.registeredName = ev.registeredName;
        emit("MDNS_ADVERTISE_READY deviceId=" + (state.localDid || "?")
          + " registeredName=" + ev.registeredName + " port=" + state.healthPort
          + " serviceType=" + SERVICE_TYPE);
        notifyChanged();
        break;
      case "advertiseStopped":
        emit("MDNS_ADVERTISE_STOP deviceId=" + (state.localDid || "?") + " reason=" + (ev.reason || "app_stop"));
        notifyChanged();
        break;
      case "discoveryStarted":
        emit("MDNS_DISCOVERY_START serviceType=" + SERVICE_TYPE + " nsdPath=" + state.nsdPath);
        break;
      case "discoveryStopped":
        emit("MDNS_DISCOVERY_STOP serviceType=" + SERVICE_TYPE + " reason=" + (ev.reason || "app_stop"));
        break;
      case "serviceFound":
        emit("MDNS_SERVICE_FOUND service=" + ev.serviceName + " type=" + (ev.serviceType || ""));
        break;
      case "serviceUpdated":
        handleServiceUpdated(ev);
        break;
      case "serviceLost":
        handleServiceLost(ev);
        break;
      case "reannounced":
        if (ev.reason === "network_change") {
          emit("MDNS_ADVERTISE_STOP deviceId=" + (state.localDid || "?") + " reason=network_change");
          emit("MDNS_ADVERTISE_START deviceId=" + (state.localDid || "?") + " reason=network_change");
        } else {
          emit("MDNS_REANNOUNCE deviceId=" + (ev.deviceId || state.localDid || "?")
            + " deviceName=" + (ev.deviceName || "") + " result=OK");
        }
        notifyChanged();
        break;
      case "healthServerStart":
        state.healthPort = ev.port;
        emit("HEALTH_SERVER_START port=" + ev.port);
        break;
      case "healthRequest":
        emit("HEALTH_REQUEST remote=" + ev.remote + " path=" + ev.path + " status=" + ev.status + " bytes=" + ev.bytes);
        break;
      case "netChanged":
        state.networkType = ev.networkType;
        state.ipv4 = ev.ipv4;
        emit("NET_CHANGED networkType=" + ev.networkType + " ipv4=" + (ev.ipv4 || "?"));
        notifyChanged();
        break;
      case "error":
        emit("MDNS_ERROR code=" + (ev.code || "unknown") + " nativeCode=" + (ev.nativeCode || 0)
          + (ev.detail ? " detail=" + ev.detail : ""));
        break;
      default:
        break;
    }
  }

  /* ---------- API ---------- */

  function start() {
    if (state.starting || state.running) return Promise.resolve();
    var p = plugin();
    if (!p) {
      emit("MDNS_ERROR code=unsupported_environment run=web");
      return Promise.resolve();
    }
    state.starting = true;
    return new Promise(function (resolve, reject) {
      p.events(handleEvent, function () {});
      /* Article 1 : le plugin peut déjà tourner (navigation entre documents).
       * On ré-attache le canal + l'état au lieu d'un second démarrage natif. */
      p.status(function (st) {
        if (st && st.running) {
          state.running = true;
          state.starting = false;
          state.localDid = st.localDeviceId;
          state.localName = st.localName || state.localName;
          state.nsdPath = st.nsdPath || "unknown";
          state.sdk = st.sdk;
          state.healthPort = st.port;
          state.registeredName = st.registeredName;
          state.networkType = st.networkType;
          state.ipv4 = st.ipv4;
          if (st.localCfg && st.localCfg.enabledSkills) {
            state.enabled = Array.isArray(st.localCfg.enabledSkills) ? st.localCfg.enabledSkills : splitSkills(st.localCfg.enabledSkills);
          }
          restorePeers();
          emit("MDNS_RUNTIME reattached=1 deviceId=" + state.localDid + " port=" + state.healthPort);
          notifyChanged();
          resolve();
          return;
        }
        var opts = advertiseOptions();
        if (!opts) {
          state.starting = false;
          reject(new Error("config_unavailable"));
          return;
        }
        state.localDid = opts.deviceId;
        state.localName = opts.deviceName;
        state.supported = opts.supportedSkills;
        state.enabled = opts.enabledSkills;
        state.version = opts.version;
        restorePeers();
        p.start(opts, function () {
          state.starting = false;
          state.running = true;
          emit("MDNS_ADVERTISE_START deviceId=" + state.localDid
            + " name=" + state.localName
            + " supported=[" + state.supported.join(",") + "]"
            + " enabled=[" + state.enabled.join(",") + "]"
            + " serviceType=" + SERVICE_TYPE + " port=" + DEFAULT_PORT);
          startStaleSweep();
          notifyChanged();
          resolve();
        }, function (err) {
          state.starting = false;
          emit("MDNS_ERROR code=startPluginFailed detail=" + err);
          reject(err);
        });
      }, function (err) {
        state.starting = false;
        emit("MDNS_ERROR code=statusPluginFailed detail=" + err);
        reject(err);
      });
    });
  }

  function stop() {
    var p = plugin();
    if (!p) { emit("MDNS_ERROR code=unsupported_environment run=web"); return Promise.resolve(); }
    if (!state.running && !state.starting) return Promise.resolve();
    stopStaleSweep();
    return new Promise(function (resolve) {
      p.stop(function () {
        state.running = false;
        emit("MDNS_ADVERTISE_STOP deviceId=" + (state.localDid || "?") + " reason=app_stop");
        emit("MDNS_DISCOVERY_STOP serviceType=" + SERVICE_TYPE + " reason=app_stop");
        clearAllPeers("app_stop");
        notifyChanged();
        resolve();
      }, function (err) {
        emit("MDNS_ERROR code=stopPluginFailed detail=" + err);
        resolve();
      });
    });
  }

  function reannounce() {
    var p = plugin();
    if (!p) return Promise.resolve();
    var opts = advertiseOptions();
    if (!opts) return Promise.resolve();
    state.localName = opts.deviceName;
    state.enabled = opts.enabledSkills;
    return new Promise(function (resolve) {
      p.reannounce(opts, function () { resolve(); }, function (err) {
        emit("MDNS_ERROR code=reannounceFailed detail=" + err);
        resolve();
      });
    });
  }

  function peers() { return tableRows(); }

  function table() {
    return Object.keys(state.peers).map(function (did) {
      var p = state.peers[did];
      return {
        deviceId: did, name: p.name, supported: p.supportedSkills, enabled: p.enabledSkills,
        version: p.version, endpoint: p.endpoint, state: p.state
      };
    });
  }

  function status() {
    return {
      running: state.running,
      advertising: !!(state.running && state.registeredName),
      registeredName: state.registeredName,
      nsdPath: state.nsdPath,
      sdk: state.sdk,
      networkType: state.networkType,
      ipv4: state.ipv4,
      healthPort: state.healthPort,
      serviceType: SERVICE_TYPE,
      peers: Object.keys(state.peers).length
    };
  }

  function onChanged(fn) {
    if (typeof fn === "function" && state.listeners.indexOf(fn) < 0) state.listeners.push(fn);
  }

  /* ---------- stale fallback (défensif, 0 = désactivé) ---------- */

  function startStaleSweep() {
    stopStaleSweep();
    if (!state.staleTimeoutMs) return;
    emit("MDNS_STALE_TIMEOUT enabled=1 timeoutMs=" + state.staleTimeoutMs + " note=defensive_fallback_only");
    state.staleTimer = setInterval(function () {
      var now = Date.now();
      tableRows().forEach(function (p) {
        if (now - p.lastSeen > state.staleTimeoutMs) {
          removePeer(p.deviceId, "stale_fallback", " timeoutMs=" + state.staleTimeoutMs + " lastSeenMs=" + p.lastSeen);
        }
      });
    }, Math.max(15000, Math.floor(state.staleTimeoutMs / 4)));
  }

  function stopStaleSweep() {
    if (state.staleTimer) clearInterval(state.staleTimer);
    state.staleTimer = null;
  }

  global.MultiCamDiscovery = {
    start: start,
    stop: stop,
    reannounce: reannounce,
    peers: peers,
    table: table,
    status: status,
    onChanged: onChanged,
    setStaleTimeout: function (ms) { state.staleTimeoutMs = Math.max(0, ms || 0); }
  };
})(window);