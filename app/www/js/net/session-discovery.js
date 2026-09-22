/* MultiCam — découverte LAN des sessions (J04).
 * Couche haut niveau au-dessus des événements NSD session (*session* events) du
 * plugin cordova-plugin-multicam-nsd, routés via MultiCamDiscovery.onSessionEvent.
 * - type DNS-SD distinct : _multicam-session._tcp. (décision 30.3) ;
 * - dédup par sessionId (plusieurs Masters peuvent annoncer la même session) ;
 * - un enregistrement = UN annonceur (instance DNS-SD), listée sous son sessionId ;
 * - PAS une preuve de joignabilité (décision 30.4) : host/port servent uniquement
 *   à tenter l'établissement WebSocket ;
 * - le PIN n'est JAMAIS dans le TXT : on rejette même un TXT qui en contiendrait un.
 * Journalisation parsable SESSION_DISCOVERY_* / SESSION_LAN_*. */

(function (global) {
  "use strict";

  var SESSION_STORE = "multicam.session.lan";
  var STALE_MS = 150 * 1000;              /* disparition LAN garantie >150s (J04-04) */
  var SWEEP_MS = 30 * 1000;
  var state = {
    instances: {},   /* serviceName -> instance { sessionId, name, did, host, port, ver, sver, firstSeen, lastSeen } */
    byId: {},        /* sessionId -> { sessionId, name, announcers:[...], firstSeen, lastSeen } (vue dédup) */
    listening: false,
    ticker: null,
    listeners: []
  };

  function emit(line) { console.log(line); }

  function notifyChanged() {
    state.listeners.slice().forEach(function (fn) { fn(); });
  }

  function isPinText(s) {
    return typeof s === "string" && /^\d{4}$/.test(s);
  }

  function instanceFrom(ev) {
    if (!ev || !ev.txt || typeof ev.txt !== "object") return null;
    var txt = ev.txt;
    var sid = txt.sid;
    if (!sid) {
      emit("SESSION_DISCOVERY_JUNK reason=missing_sid service=" + (ev.serviceName || "?"));
      return null;
    }
    /* Défense supplémentaire : jamais de PIN dans le TXT (décision 30.3/30.6). */
    if (isPinText(txt.pin) || isPinText(txt.PIN)) {
      emit("SESSION_DISCOVERY_JUNK reason=pin_in_txt sessionId=" + sid + " — ignoré");
      return null;
    }
    var did = txt.did || "";
    if (!did) {
      emit("SESSION_DISCOVERY_JUNK reason=missing_did sessionId=" + sid);
      return null;
    }
    var now = Date.now();
    return {
      sessionId: sid,
      name: txt.name || sid,
      did: did,
      host: ev.host || "",
      port: ev.port || 0,
      ver: txt.ver || "",
      sver: txt.sver || "",
      serviceName: ev.serviceName || (sid + ":" + did),
      firstSeen: now,
      lastSeen: now
    };
  }

  function rebuildById() {
    var byId = {};
    Object.keys(state.instances).forEach(function (name) {
      var inst = state.instances[name];
      if (!byId[inst.sessionId]) {
        byId[inst.sessionId] = {
          sessionId: inst.sessionId, name: inst.name, announcers: []
        };
      }
      byId[inst.sessionId].announcers.push(inst);
    });
    Object.keys(byId).forEach(function (sid) {
      var e = byId[sid];
      var sorted = e.announcers.slice().sort(function (a, b) { return a.lastSeen - b.lastSeen; });
      e.announcers = sorted;
      e.lastSeen = sorted.length ? sorted[sorted.length - 1].lastSeen : 0;
      e.firstSeen = sorted.length ? sorted[0].firstSeen : 0;
    });
    state.byId = byId;
  }

  function persist(reason) {
    try {
      global.sessionStorage.setItem(SESSION_STORE, JSON.stringify({
        savedAt: Date.now(), reason: reason, instances: state.instances
      }));
    } catch (e) {}
  }

  function restore() {
    var raw = null;
    try { raw = global.sessionStorage.getItem(SESSION_STORE); } catch (e) {}
    if (!raw) return 0;
    try {
      var data = JSON.parse(raw);
      if (!data || !data.instances) return 0;
      var n = 0;
      Object.keys(data.instances).forEach(function (name) {
        if (state.instances[name]) return;
        state.instances[name] = data.instances[name];
        n++;
      });
      rebuildById();
      if (n) emit("SESSION_LAN_RESTORED instances=" + n + " source=sessionStorage");
      return n;
    } catch (e) { return 0; }
  }

  function list(skipLocal) {
    return Object.keys(state.byId).map(function (sid) {
      return state.byId[sid];
    }).filter(function (e) {
      if (!skipLocal || !global.MultiCamSessionStore) return true;
      /* skipLocal = false par défaut ; les sessions locales sont filtrées côté UI. */
      return true;
    }).sort(function (a, b) { return (a.name || a.sessionId).localeCompare(b.name || b.sessionId); });
  }

  function instances() {
    return Object.keys(state.instances).map(function (name) { return state.instances[name]; });
  }

  function removeInstance(name, reason) {
    if (!state.instances[name]) return false;
    var inst = state.instances[name];
    delete state.instances[name];
    rebuildById();
    emit("SESSION_LAN_INSTANCE_LOST sessionId=" + inst.sessionId + " did=" + inst.did + " reason=" + reason);
    persist("lost");
    notifyChanged();
    return true;
  }

  function onServiceUpdated(ev) {
    var inst = instanceFrom(ev);
    if (!inst) return;
    var prev = state.instances[inst.serviceName];
    if (prev) {
      var changed = prev.host !== inst.host || prev.port !== inst.port
        || prev.name !== inst.name || prev.did !== inst.did;
      if (changed) {
        emit("SESSION_LAN_INSTANCE_UPDATED sessionId=" + inst.sessionId + " did=" + inst.did
          + " name=" + inst.name + " endpoint=" + (inst.host + ":" + inst.port));
        state.instances[inst.serviceName] = inst;
        persist("updated");
      }
    } else {
      state.instances[inst.serviceName] = inst;
      emit("SESSION_LAN_INSTANCE_FOUND sessionId=" + inst.sessionId + " did=" + inst.did
        + " name=" + inst.name + " endpoint=" + (inst.host + ":" + inst.port)
        + " ver=" + inst.ver + " sver=" + inst.sver);
      persist("found");
    }
    rebuildById();
    notifyChanged();
  }

  function onNsdEvent(ev) {
    if (!ev || !ev.type) return;
    switch (ev.type) {
      case "sessionServiceUpdated":
        onServiceUpdated(ev);
        break;
      case "sessionServiceFound":
        emit("SESSION_LAN_SERVICE_FOUND service=" + ev.serviceName);
        break;
      case "sessionServiceLost":
        removeInstance(ev.serviceName, "serviceLost");
        break;
      case "sessionDiscoveryStarted":
        emit("SESSION_LAN_DISCOVERY_START serviceType=_multicam-session._tcp.");
        break;
      case "sessionDiscoveryStopped":
        emit("SESSION_LAN_DISCOVERY_STOP serviceType=_multicam-session._tcp. reason=" + (ev.reason || "app_stop"));
        break;
      case "sessionDiscoveryRefresh":
        /* La re-enumeration NSD vient de démontrer la présence du service :
         * on rafraîchit la fraîcheur de TOUTES les instances (J04-04 : la
         * disparition >150s repose sur les onServiceLost de la ré-enumeration
         * + le balayage de sécurité ci-dessous). */
        Object.keys(state.instances).forEach(function (name) {
          state.instances[name].lastSeen = Date.now();
        });
        emit("SESSION_LAN_REFRESH_SEEN instances=" + Object.keys(state.instances).length);
        break;
      default:
        break;
    }
  }

  /* Balayage de sécurité : en dernier recours si NSD n'a pas émis de
   * onServiceLost (daemon/timing), une instance muette >150s est retirée. */
  function sweepStale() {
    var now = Date.now();
    var removed = [];
    Object.keys(state.instances).forEach(function (name) {
      if (now - state.instances[name].lastSeen > STALE_MS) removed.push(name);
    });
    removed.forEach(function (name) { removeInstance(name, "stale_150s"); });
  }

  function startTicker() {
    if (state.ticker) return;
    state.ticker = setInterval(sweepStale, SWEEP_MS);
    emit("SESSION_LAN_SWEEP_START every=" + SWEEP_MS + "ms stale=" + STALE_MS + "ms");
  }

  function stopTicker() {
    if (state.ticker) clearInterval(state.ticker);
    state.ticker = null;
  }

  function attach() {
    if (state.listening) return;
    if (!global.MultiCamDiscovery || !global.MultiCamDiscovery.onSessionEvent) return;
    global.MultiCamDiscovery.onSessionEvent(onNsdEvent);
    state.listening = true;
    if (restore()) notifyChanged();
    startTicker();
  }

  function detach() {
    stopTicker();
    state.listening = false;
  }

  global.MultiCamSessionDiscovery = {
    attach: attach,
    detach: detach,
    list: function () { return list(); },
    instances: instances,
    status: function () {
      return {
        listening: state.listening,
        sessions: Object.keys(state.byId).length,
        instances: Object.keys(state.instances).length
      };
    },
    onChanged: function (fn) {
      if (typeof fn === "function" && state.listeners.indexOf(fn) < 0) state.listeners.push(fn);
    },
    dump: function (tag) {
      emit("SESSION_LAN_TABLE " + tag
        + " sessions=" + Object.keys(state.byId).length
        + " instances=" + Object.keys(state.instances).length
        + " rows=" + JSON.stringify(list()));
    }
  };
})(window);