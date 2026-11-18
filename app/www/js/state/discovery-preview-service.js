/* MultiCam — vignette JPEG de decouverte, sans session ni Take.
 * Le serveur WS J04 est reutilise, avec requete/reponse ciblees. Aucune ouverture
 * de camera: le seul PixelCopy passe par preview-sampler.discoverySnapshot().
 * mDNS n'est PAS une authentification cryptographique: l'acces est borne aux
 * annonceurs controller du LAN dont l'IPv4 correspond a la connexion entrante.
 */
(function (global) {
  "use strict";
  var REQUEST_MS = 2000, SERVE_MS = 1800, STALE_MS = 5000;
  var MAX_B64 = 174768; /* JPEG <= 128 KiB */
  var S = { bound: false, did: "", visible: false, foreground: true, timer: null,
    pending: {}, lastAsked: {}, frames: {}, lastServed: 0, seq: 0, listeners: [] };
  function now() { return Date.now(); }
  function log(s) { try { global.console.log(s); } catch (e) {} }
  function config() { return global.MultiCamConfig && global.MultiCamConfig.get ? global.MultiCamConfig.get() : null; }
  function peers() { return global.MultiCamNet && global.MultiCamNet.peers ? global.MultiCamNet.peers() : []; }
  function ws() { return global.MultiCamSessionWs; }
  function capturePeer(did) {
    return peers().filter(function (p) { return p && p.deviceId === did && p.lastResolveMs &&
      p.state === "online" && Array.isArray(p.enabledSkills) && p.enabledSkills.indexOf("capture") >= 0; })[0] || null;
  }
  function controllerPeer(did) {
    return peers().filter(function (p) { return p && p.deviceId === did && p.lastResolveMs &&
      p.state === "online" && Array.isArray(p.enabledSkills) && p.enabledSkills.indexOf("controller") >= 0; })[0] || null;
  }
  function isLocalController() {
    var c = config(); return !!(c && Array.isArray(c.enabledSkills) && c.enabledSkills.indexOf("controller") >= 0);
  }
  function isLocalCapture() {
    var c = config(); return !!(c && Array.isArray(c.enabledSkills) && c.enabledSkills.indexOf("capture") >= 0);
  }
  function ipv4(remote) {
    var m = /(?:^|[^0-9])((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?:$|[^0-9])/.exec(String(remote || ""));
    if (!m) return "";
    return m[1].split(".").every(function (v) { return Number(v) <= 255; }) ? m[1] : "";
  }
  function freshRequester(env, entry) {
    if (!env || typeof env.from !== "string" || !entry || !entry.remoteAddr) return false;
    var peer = controllerPeer(env.from);
    if (!peer) return false;
    var remote = ipv4(entry.remoteAddr);
    var announced = ipv4((peer.wsEndpoint || "").split(":")[0]);
    return !!(remote && announced && remote === announced);
  }
  function nonce() {
    var c = global.crypto;
    if (!c || typeof c.getRandomValues !== "function") return "";
    try {
      var a = new Uint8Array(16); c.getRandomValues(a);
      return Array.prototype.map.call(a, function (v) { return ("0" + v.toString(16)).slice(-2); }).join("");
    } catch (e) { return ""; }
  }
  function notify() {
    S.listeners.slice().forEach(function (fn) { try { fn(); } catch (e) {} });
  }
  function latest(did) {
    var f = S.frames[did];
    return f && now() - f.receivedAt <= STALE_MS && capturePeer(did) ? f : null;
  }
  function prune() {
    var ids = {};
    peers().forEach(function (p) { if (p && capturePeer(p.deviceId)) ids[p.deviceId] = true; });
    Object.keys(S.frames).forEach(function (did) {
      if (!ids[did] || !latest(did)) delete S.frames[did];
    });
    Object.keys(S.pending).forEach(function (did) {
      if (!ids[did] || now() - S.pending[did].at > 4000) delete S.pending[did];
    });
  }
  function tick() {
    S.timer = null;
    if (!S.visible || !S.foreground) return;
    prune();
    if (isLocalController() && ws() && typeof ws().requestDiscoveryPreview === "function") {
      peers().filter(function (p) { return capturePeer(p.deviceId); }).slice(0, 8).forEach(function (p) {
        var did = p.deviceId, last = S.lastAsked[did] || 0;
        if (S.pending[did] || now() - last < REQUEST_MS) return;
        var id = nonce();
        if (!id) { log("DISCOVERY_PREVIEW_SKIP reason=no_crypto"); return; }
        S.lastAsked[did] = now();
        S.pending[did] = { id: id, at: now() };
        Promise.resolve(ws().requestDiscoveryPreview(did, id)).then(function (ok) {
          if (!ok && S.pending[did] && S.pending[did].id === id) delete S.pending[did];
        }).catch(function () {
          if (S.pending[did] && S.pending[did].id === id) delete S.pending[did];
        });
      });
    }
    notify();
    S.timer = setTimeout(tick, REQUEST_MS);
  }
  function setHomeVisible(yes) {
    yes = !!yes;
    if (S.visible === yes) return;
    S.visible = yes;
    if (S.timer !== null) { clearTimeout(S.timer); S.timer = null; }
    S.pending = {};
    if (!yes) S.frames = {}; /* Pas de capture image hors ecran accueil. */
    if (yes && S.foreground) S.timer = setTimeout(tick, 100);
    notify();
  }
  /* Lecture seule et rate limiting : seuls les peers Controller decouverts via
   * mDNS ET presents a la meme IP que le socket entrant peuvent solliciter.
   * Aucun champ de la requete ne controle la camera, un chemin ou une frequence. */
  function onRequest(env, entry, reply) {
    if (!env || !/^[0-9a-f]{32}$/.test(env.requestId || "") ||
        !isLocalCapture() || !S.foreground || !freshRequester(env, entry)) {
      log("DISCOVERY_PREVIEW_DENY reason=not_authorized from=" + ((env && env.from) || "?"));
      return false;
    }
    var pv = global.MultiCamPreviewService && global.MultiCamPreviewService.view
      ? global.MultiCamPreviewService.view() : null;
    if (!pv || !pv.foreground || !pv.captureEnabled) return false;
    if (now() - S.lastServed < SERVE_MS) return false;
    var sampler = global.MultiCamPreviewSampler;
    if (!sampler || typeof sampler.discoverySnapshot !== "function") return false;
    S.lastServed = now();
    var req = env.requestId;
    Promise.resolve(sampler.discoverySnapshot()).then(function (frame) {
      if (!frame || !S.foreground || !isLocalCapture() ||
          !frame.base64 || frame.base64.length > MAX_B64 ||
          frame.base64.slice(0, 4) !== "/9j/") return;
      var payload = { requestId: req, seq: ++S.seq, capturedAt: frame.capturedAt,
        mime: "image/jpeg", bytes: frame.bytes, jpegBase64: frame.base64 };
      var ok = reply(payload);
      log("DISCOVERY_PREVIEW_TX deviceId=" + S.did + " bytes=" + frame.bytes + " sent=" + (ok ? 1 : 0));
    }).catch(function (e) { log("DISCOVERY_PREVIEW_SAMPLE_ERROR err=" + String(e)); });
    return true;
  }
  function onFrame(env) {
    if (!S.visible || !S.foreground || !isLocalController() || !env ||
        !capturePeer(env.from) || !/^[0-9a-f]{32}$/.test(env.requestId || "")) return false;
    var p = S.pending[env.from];
    if (!p || p.id !== env.requestId || now() - p.at > 4000) return false;
    delete S.pending[env.from];
    if (env.mime !== "image/jpeg" || typeof env.jpegBase64 !== "string" ||
        !env.jpegBase64 || env.jpegBase64.length > MAX_B64 ||
        env.jpegBase64.slice(0, 4) !== "/9j/" ||
        !Number.isFinite(env.bytes) || env.bytes <= 0 || env.bytes > 131072 ||
        !Number.isSafeInteger(env.seq) || env.seq <= 0) return false;
    var prev = S.frames[env.from];
    if (prev && env.seq <= prev.seq) return false;
    S.frames[env.from] = { deviceId: env.from, seq: env.seq,
      jpegBase64: env.jpegBase64, receivedAt: now(), bytes: env.bytes };
    log("DISCOVERY_PREVIEW_RX deviceId=" + env.from + " seq=" + env.seq + " bytes=" + env.bytes);
    notify();
    return true;
  }
  function bind(cfg) {
    if (S.bound) return;
    S.bound = true;
    S.did = (cfg && cfg.deviceId) || "";
    if (ws() && ws().setDiscoveryPreviewBridge)
      ws().setDiscoveryPreviewBridge({ onRequest: onRequest, onFrame: onFrame });
    if (global.document && global.document.addEventListener) {
      global.document.addEventListener("pause", function () {
        S.foreground = false;
        if (S.timer !== null) { clearTimeout(S.timer); S.timer = null; }
        S.pending = {}; S.frames = {}; notify();
      });
      global.document.addEventListener("resume", function () {
        S.foreground = true;
        if (S.visible) { S.timer = setTimeout(tick, 100); }
      });
    }
    if (global.MultiCamDiscovery && global.MultiCamDiscovery.onChanged)
      global.MultiCamDiscovery.onChanged(function () {
        prune(); notify();
        if (S.visible && S.foreground && S.timer === null) S.timer = setTimeout(tick, 100);
      });
    log("DISCOVERY_PREVIEW_READY deviceId=" + S.did + " periodMs=" + REQUEST_MS);
  }
  global.MultiCamDiscoveryPreviewService = {
    bind: bind, setHomeVisible: setHomeVisible, latest: latest,
    onChanged: function (fn) { if (typeof fn === "function" && S.listeners.indexOf(fn) < 0) S.listeners.push(fn); },
    /* Projections exposees pour tests unitaires, sans injection ni bypass de garde. */
    active: function () { return S.visible && S.foreground; },
    _onRequest: onRequest, _onFrame: onFrame
  };
})(window);
