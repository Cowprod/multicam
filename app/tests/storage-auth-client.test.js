"use strict";
const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const client = require("../www/js/net/storage-auth-client.js");

const key = "paWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaU";
const nonce = "bm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm4";
const vector = "cejdYt7wIg8v9K8bq3KDeOj_Liydzxslrgj9OBOld6s";

class Socket {
  constructor() { this.readyState = 1; this.out = []; this.listeners = {}; }
  addEventListener(name, fn) { (this.listeners[name] ||= new Set()).add(fn); }
  removeEventListener(name, fn) { if (this.listeners[name]) this.listeners[name].delete(fn); }
  send(payload) { this.out.push(JSON.parse(payload)); }
  fire(name, data) { for (const fn of [...(this.listeners[name] || [])]) fn({ data }); }
  listenerCount() { return Object.values(this.listeners).reduce((n, s) => n + s.size, 0); }
}

const opts = () => ({ sessionId: "session-1", masterDeviceId: "master-1",
  storageDeviceId: "storage-1", pairingCode: key, cryptoProvider: webcrypto });
const challenge = () => ({ v: 1, kind: "storage_auth_challenge",
  from: "storage-1", to: "master-1", sessionId: "session-1", nonce });

exports.register = function (h) {
  h.describe("caseRouter Storage v1 HMAC client (interop)", function () {
    h.it("matches a PHP hash_hmac SHA-256 transcript byte-for-byte", async function () {
      assert.equal(await client.proof(key, "session-1", "master-1", "storage-1", nonce, webcrypto), vector);
    });
    h.it("binds the challenge to each peer/session identity", async function () {
      const alternate = await client.proof(key, "session-2", "master-1", "storage-1", nonce, webcrypto);
      assert.notEqual(alternate, vector);
      assert.notEqual(await client.proof(key, "session-1", "master-2", "storage-1", nonce, webcrypto), vector);
    });
    h.it("rejects short PINs, malformed and noncanonical base64url", async function () {
      await assert.rejects(client.proof("1234", "session-1", "master-1", "storage-1", nonce, webcrypto), /invalid_storage_auth_parameters/);
      await assert.rejects(client.proof(key, "session-1", "master-1", "storage-1", nonce.slice(0, -1) + "B", webcrypto), /invalid_storage_auth_parameters/);
      await assert.rejects(client.proof(key, "../outside", "master-1", "storage-1", nonce, webcrypto), /invalid_storage_auth_parameters/);
    });
    h.it("sends hello then proof on a dedicated WS without claiming authenticated", async function () {
      const ws = new Socket();
      const pending = client.sendProof(ws, opts());
      assert.deepEqual(ws.out[0], { v: 1, kind: "storage_auth_hello",
        from: "master-1", to: "storage-1", sessionId: "session-1" });
      ws.fire("message", JSON.stringify(challenge()));
      const completed = await pending;
      assert.deepEqual(completed, { state: "proof_sent", authenticated: false });
      assert.deepEqual(ws.out[1], { v: 1, kind: "storage_auth_proof", from: "master-1",
        to: "storage-1", sessionId: "session-1", proof: vector });
      assert.equal(ws.listenerCount(), 0);
    });
    h.it("rejects forged challenge identity and closes event listeners", async function () {
      const ws = new Socket();
      const pending = client.sendProof(ws, opts());
      const bad = challenge(); bad.from = "storage-evil";
      ws.fire("message", JSON.stringify(bad));
      await assert.rejects(pending, /invalid_storage_auth_challenge/);
      assert.equal(ws.out.length, 1);
      assert.equal(ws.listenerCount(), 0);
    });
    h.it("rejects a connection closing before challenge and an unopened socket", async function () {
      const ws = new Socket();
      const pending = client.sendProof(ws, opts());
      ws.fire("close");
      await assert.rejects(pending, /storage_auth_connection_closed/);
      assert.equal(ws.listenerCount(), 0);
      ws.readyState = 0;
      await assert.rejects(client.sendProof(ws, opts()), /invalid_storage_auth_parameters/);
    });
    h.it("refuses missing Web Crypto rather than downgrading to PIN", async function () {
      await assert.rejects(client.proof(key, "session-1", "master-1", "storage-1", nonce, { subtle: null }), /secure_crypto_unavailable/);
    });
  });
};
