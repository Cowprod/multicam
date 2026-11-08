/* MultiCam -> caseRouter Storage: opt-in mutual HMAC v1 authentication.
 * No PIN fallback and no persistence of the 256-bit pairing secret.
 * A successful result requires a cryptographically verified server ACK.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.MultiCamStorageAuthClient = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  var SEGMENT = /^[A-Za-z0-9_.-]+$/;
  var CODE = /^[A-Za-z0-9_-]{43}$/;
  function safeId(s) {
    return typeof s === "string" && s.charAt(0) !== "."
      && s.length > 0 && s.length <= 128 && SEGMENT.test(s);
  }
  function decode32(encoded) {
    if (typeof encoded !== "string" || !CODE.test(encoded)
        || typeof atob !== "function" || typeof btoa !== "function") return null;
    var raw;
    try { raw = atob(encoded.replace(/-/g, "+").replace(/_/g, "/") + "="); }
    catch (e) { return null; }
    if (raw.length !== 32) return null;
    var bytes = new Uint8Array(32);
    for (var i = 0; i < 32; i++) bytes[i] = raw.charCodeAt(i);
    if (btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== encoded)
      return null;
    return bytes;
  }
  function encode32(buffer) {
    var bytes = new Uint8Array(buffer);
    if (bytes.length !== 32 || typeof btoa !== "function") throw new Error("crypto_unavailable");
    var raw = "";
    for (var i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
    return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function hmacProof(pairingCode, sid, masterDid, storageDid, nonce, cryptoProvider, domain) {
    var key = decode32(pairingCode);
    if (!key || !decode32(nonce) || !safeId(sid) || !safeId(masterDid)
        || !safeId(storageDid) || masterDid === storageDid)
      throw new Error("invalid_storage_auth_parameters");
    var provider = cryptoProvider || (typeof crypto !== "undefined" ? crypto : null);
    if (!provider || !provider.subtle || typeof TextEncoder === "undefined")
      throw new Error("secure_crypto_unavailable");
    var message = domain + "\n" + sid + "\n" + masterDid
      + "\n" + storageDid + "\n" + nonce;
    var imported = await provider.subtle.importKey(
      "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    return encode32(await provider.subtle.sign(
      { name: "HMAC" }, imported, new TextEncoder().encode(message)
    ));
  }
  function proof(code, sid, master, storage, nonce, cryptoProvider) {
    return hmacProof(code, sid, master, storage, nonce, cryptoProvider,
      "multicam-storage/ws-auth/v1");
  }
  function acceptProof(code, sid, master, storage, nonce, cryptoProvider) {
    return hmacProof(code, sid, master, storage, nonce, cryptoProvider,
      "multicam-storage/ws-auth/accept/v1");
  }
  function equalProof(a, b) {
    if (typeof a !== "string" || typeof b !== "string" ||
        a.length !== 43 || b.length !== 43) return false;
    var difference = 0;
    for (var i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return difference === 0;
  }
  // Called on a dedicated, already OPEN storage WebSocket, never on the
  // multiplexed J04/J05 session WebSocket. No UI or key store is implied.
  function sendProof(ws, options) {
    options = options || {};
    var sid = options.sessionId, master = options.masterDeviceId,
      storage = options.storageDeviceId, code = options.pairingCode;
    var timeout = options.timeoutMs == null ? 5000 : options.timeoutMs;
    if (!ws || ws.readyState !== 1 || !safeId(sid)
        || !safeId(master) || !safeId(storage) || master === storage
        || !decode32(code) || !Number.isSafeInteger(timeout)
        || timeout < 1000 || timeout > 30000)
      return Promise.reject(new Error("invalid_storage_auth_parameters"));
    return new Promise(function (resolve, reject) {
      var done = false;
      var phase = "challenge";
      var serverNonce = null;
      var timer;
      function cleanup() {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        ws.removeEventListener("close", onClose);
        ws.removeEventListener("error", onClose);
      }
      function finish(error) {
        if (done) return;
        done = true;
        cleanup();
        if (error) reject(new Error(error));
        else resolve({ state: "authenticated", authenticated: true });
      }
      function onClose() { finish("storage_auth_connection_closed"); }
      async function onMessage(event) {
        if (done) return;
        var message;
        try { message = JSON.parse(event.data); }
        catch (e) { finish("invalid_storage_auth_response"); return; }
        if (phase === "challenge") {
          if (!message || message.v !== 1
              || message.kind !== "storage_auth_challenge"
              || message.from !== storage || message.to !== master
              || message.sessionId !== sid || !decode32(message.nonce)) {
            finish("invalid_storage_auth_challenge");
            return;
          }
          phase = "computing";
          serverNonce = message.nonce;
          try {
            var answer = await proof(code, sid, master, storage,
              serverNonce, options.cryptoProvider);
            if (done) return;
            phase = "ack";
            ws.send(JSON.stringify({ v: 1, kind: "storage_auth_proof",
              from: master, to: storage, sessionId: sid, proof: answer }));
          } catch (e) { finish("storage_auth_proof_failed"); }
          return;
        }
        if (phase !== "ack" || !message || message.v !== 1
            || message.kind !== "storage_auth_ok"
            || message.from !== storage || message.to !== master
            || message.sessionId !== sid || !decode32(message.proof)) {
          finish("invalid_storage_auth_ack");
          return;
        }
        phase = "verifying";
        try {
          var expected = await acceptProof(code, sid, master, storage,
            serverNonce, options.cryptoProvider);
          if (done) return;
          if (!equalProof(message.proof, expected)) {
            finish("invalid_storage_auth_ack");
            return;
          }
          finish(null);
        } catch (e) { finish("storage_auth_ack_verification_failed"); }
      }
      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onClose);
      ws.addEventListener("error", onClose);
      timer = setTimeout(function () { finish("storage_auth_timeout"); }, timeout);
      try {
        ws.send(JSON.stringify({ v: 1, kind: "storage_auth_hello",
          from: master, to: storage, sessionId: sid }));
      } catch (e) { finish("storage_auth_send_failed"); }
    });
  }
  return { proof: proof, acceptProof: acceptProof, sendProof: sendProof };
});
