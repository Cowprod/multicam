/* Manual MultiCam Master -> external Storage pairing (lab, no secret persistence).
 * The key is used only for this opt-in handshake. No automatic reconnect:
 * the storage-side WS binding and its HTTP bearer tokens must die together.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.MultiCamStoragePairing = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  var ID = /^[A-Za-z0-9_.-]{1,128}$/;
  var KEY = /^[A-Za-z0-9_-]{43}$/;
  function validId(s) { return typeof s === "string" && ID.test(s) && s[0] !== "."; }
  function endpoint(s) {
    if (typeof s !== "string") return null;
    var m = /^([A-Za-z0-9.-]{1,253}):([1-9][0-9]{0,4})$/.exec(s.trim());
    if (!m || m[1].startsWith(".") || m[1].endsWith(".") || m[1].includes(".."))
      return null;
    var port = Number(m[2]);
    return port > 0 && port <= 65535 ? "ws://" + m[1] + ":" + port + "/" : null;
  }
  function createLink(options) {
    options = options || {};
    var Socket = options.Socket, auth = options.auth, onState = options.onState || function () {};
    var socket = null, generation = 0, timer = null, state = "idle", pending = null;
    function status(next) { state = next; onState(next); }
    function stop() {
      ++generation;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      var previous = socket; socket = null;
      if (pending) { pending(false); pending = null; }
      if (previous) { try { previous.close(); } catch (_) {} }
      status("disconnected");
    }
    function connect(input) {
      stop();
      var url = endpoint(input && input.endpoint);
      var code = input && input.pairingCode;
      if (!Socket || !auth || !url || !validId(input.sessionId)
          || !validId(input.masterDeviceId) || !validId(input.storageDeviceId)
          || input.masterDeviceId === input.storageDeviceId
          || typeof code !== "string" || !KEY.test(code)) {
        status("invalid");
        return Promise.resolve(false);
      }
      var ticket = ++generation, ws;
      try { ws = new Socket(url); }
      catch (_) { status("failed"); return Promise.resolve(false); }
      socket = ws;
      status("connecting");
      return new Promise(function (resolve) {
        var settled = false;
        function done(ok) {
          if (settled) return;
          settled = true;
          pending = null;
          resolve(ok);
        }
        pending = done;
        function fail() {
          if (ticket !== generation) return;
          if (timer !== null) clearTimeout(timer);
          timer = null;
          socket = null;
          try { ws.close(); } catch (_) {}
          status("failed");
          done(false);
        }
        ws.addEventListener("close", function () {
          if (ticket !== generation) return;
          if (timer !== null) clearTimeout(timer);
          timer = null;
          socket = null;
          status(state === "authenticated" ? "disconnected" : "failed");
          done(false);
        });
        ws.addEventListener("error", fail);
        ws.addEventListener("open", function () {
          if (ticket !== generation) return;
          if (timer !== null) clearTimeout(timer);
          timer = null;
          status("authenticating");
          var params = {
            sessionId: input.sessionId, masterDeviceId: input.masterDeviceId,
            storageDeviceId: input.storageDeviceId, pairingCode: code
          };
          code = null;
          Promise.resolve().then(function () { return auth.sendProof(ws, params); })
            .then(function (result) {
              if (ticket !== generation) return;
              if (!result || result.authenticated !== true || ws.readyState !== 1) {
                fail(); return;
              }
              status("authenticated");
              done(true);
            }).catch(fail);
        });
        timer = setTimeout(fail, 5000);
      });
    }
    return { connect: connect, stop: stop, status: function () { return state; } };
  }

  // Screen 03 only: never copy an app PIN into the HMAC field or localStorage.
  var link = null, mounted = false, lastSid = "";
  function el(id) { return document.getElementById(id); }
  var labels = {
    idle: "Non connecté", disconnected: "Déconnecté",
    connecting: "Connexion au Storage…", authenticating: "Vérification HMAC…",
    authenticated: "Master authentifié (liaison WS active)",
    invalid: "Identifiants, adresse ou code d’appariement invalides",
    failed: "Connexion ou authentification refusée"
  };
  function hide() {
    lastSid = "";
    if (link) link.stop();
    if (typeof document !== "undefined") {
      var key = el("storagePairCode"); if (key) key.value = "";
      var panel = el("storagePairCard"); if (panel) panel.classList.add("d-none");
    }
  }
  function mount() {
    if (mounted || typeof document === "undefined") return;
    var button = el("storagePairConnect"), close = el("storagePairDisconnect");
    if (!button || !close) return;
    mounted = true;
    link = createLink({
      Socket: typeof WebSocket === "function" ? WebSocket : null,
      auth: typeof MultiCamStorageAuthClient !== "undefined" ? MultiCamStorageAuthClient : null,
      onState: function (s) {
        var label = el("storagePairStatus");
        if (label) label.textContent = labels[s] || labels.failed;
        button.disabled = s === "connecting" || s === "authenticating" || s === "authenticated";
        close.disabled = s === "idle" || s === "disconnected";
      }
    });
    button.addEventListener("click", function () {
      if (!lastSid) return;
      var field = el("storagePairCode"), code = field.value.trim();
      // Clear the DOM immediately, including on failed input. No persistence.
      field.value = "";
      link.connect({
        sessionId: lastSid, masterDeviceId: el("storagePairCard").dataset.masterId,
        storageDeviceId: el("storagePairDevice").value.trim(),
        endpoint: el("storagePairEndpoint").value.trim(),
        pairingCode: code
      });
    });
    close.addEventListener("click", function () { link.stop(); });
  }
  function show(cfg, sid, store) {
    hide();
    mount();
    if (!cfg || !validId(sid) || !store || typeof store.get !== "function") return;
    var requested = sid;
    store.get(sid).then(function (session) {
      if (requested !== sid || !session || session.state !== "open"
          || !(session.masters || []).some(function (m) { return m.deviceId === cfg.deviceId; }))
        return;
      var panel = el("storagePairCard");
      if (!panel || !panel.closest("#panel-session.active")) return;
      panel.dataset.masterId = cfg.deviceId;
      lastSid = sid;
      panel.classList.remove("d-none");
      if (link) {
        var statusEl = el("storagePairStatus");
        if (statusEl) statusEl.textContent = labels[link.status()];
      }
    }).catch(function () { /* no UI or secret on failure */ });
  }
  return { createLink: createLink, endpoint: endpoint, show: show, hide: hide };
});
