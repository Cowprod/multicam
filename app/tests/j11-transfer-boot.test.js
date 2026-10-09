/* MultiCam J11 — bootstrap du transfert (app/www/js/state/transfer-boot.js).
 *
 * Le modèle (j11-transfer.test.js) et le service (j11-transfer-service.test.js)
 * sont éprouvés séparément ; ici on éprouve l'ASSEMBLAGE : choix du rôle, chargement
 * du Take courant depuis la session, construction paresseuse (re)liée à l'en-tête
 * de session/take, pont transport, déclenchement après STOP, et garde RECORDING.
 * Toutes les coutures (WS, START, store, natif) sont des fakes injectés. */

"use strict";

const path = require("path");
const assert = require("assert");
const M = require(path.resolve(__dirname, "../www/js/state/transfer-model.js"));
const S = require(path.resolve(__dirname, "../www/js/state/transfer-service.js"));
const TM = require(path.resolve(__dirname, "../www/js/state/take-model.js"));
const Boot = require(path.resolve(__dirname, "../www/js/state/transfer-boot.js"));

const SID = "session-J11";
const CAP = "cap-1";
const STO1 = "sto-1";
const STO2 = "sto-2";

/* ---------- fakes ---------- */

function makeWs() {
  const out = { broadcast: [], sendTo: [], bridge: null };
  return {
    out,
    _ws: {
      broadcastTargeted(kind, session, extra) { out.broadcast.push({ kind, session, extra }); },
      sendToDevice(did, session, kind, extra) { out.sendTo.push({ did, kind, extra }); },
      setTransferBridge(b) { out.bridge = b; }
    }
  };
}

function makeNative(cfg) {
  cfg = cfg || {};
  const calls = { serveStart: [], serveStop: 0, sha256: [], download: [] };
  return {
    calls,
    serveStart(o) { calls.serveStart.push(o); return Promise.resolve(cfg.serveUrl || "http://10.0.0.5:8080"); },
    serveStop() { calls.serveStop += 1; return Promise.resolve(); },
    sha256(p) { calls.sha256.push(p); return Promise.resolve((cfg.sha256Map && cfg.sha256Map[p]) || { bytes: 1000, sha256: "aaaa" }); },
    download(o) { calls.download.push(o); return Promise.resolve({ done: true, received: o.expectedBytes || 1000, sha256: "aaaa" }); }
  };
}

function makeStart(initial) {
  initial = initial || {};
  const st = { view: initial.view || { sid: SID, takeNumber: 1 }, self: initial.self || CAP, recording: !!initial.recording };
  const viewers = [];
  return {
    st,
    viewers,
    _svc: {
      onView(fn) { viewers.push(fn); },
      machine() { return { view: () => st.view }; },
      selfDid() { return st.self; },
      isRecording() { return st.recording; }
    }
  };
}

function makeStore(takesBySid) {
  return { get: (sid) => Promise.resolve({ sessionId: sid, takes: takesBySid[sid] || [] }) };
}

const storageNative = () => ({
  defaultPath: () => "file:///data/app/",
  systemPath: (u) => String(u || "").replace(/^file:\/\//, "").replace(/\/$/, "")
});

function makeBoot(over) {
  over = over || {};
  const logs = [];
  const ws = makeWs();
  const start = makeStart(over.start);
  const native = makeNative(over.native);
  const boot = Boot.createTransferBoot({
    cfg: over.cfg || { enabledSkills: ["capture"] },
    ws: () => ws._ws,
    startService: () => start._svc,
    sessionStore: () => makeStore(over.takes || {}),
    storageNative: storageNative,
    nativeApi: () => native,
    transferModel: () => M,
    transferService: () => S,
    takeModel: () => TM,
    log: (l) => logs.push(l)
  });
  return { boot, ws, start, native, logs };
}

function mediaReady(sid, take, cap) {
  return {
    kind: "media_ready", sessionId: sid, takeNumber: take, deviceId: cap,
    host: "10.0.0.5", port: 8080, token: "tok",
    files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }]
  };
}

module.exports.register = function (h) {
  const describe = h.describe;
  const it = h.it;
  const flush = h.flush;

  describe("J11 boot — rôles, assemblage, déclencheurs", function () {

    it("B1. roleFor : priorité controller > capture > storage", () => {
      assert.strictEqual(Boot.roleFor({ enabledSkills: ["controller", "capture"] }), "master");
      assert.strictEqual(Boot.roleFor({ enabledSkills: ["capture"] }), "capture");
      assert.strictEqual(Boot.roleFor({ enabledSkills: ["storage"] }), "storage");
      assert.strictEqual(Boot.roleFor({ enabledSkills: [] }), "");
    });

    it("B2. capture : STOP ⇒ SHA-256, serveur et media_ready (une seule fois)", async () => {
      const takes = { [SID]: [{ takeNumber: 1, storages: [], settings: { transferAuto: true } }] };
      const { boot, ws, native, logs } = makeBoot({
        cfg: { enabledSkills: ["capture"] }, takes,
        start: { view: { sid: SID, takeNumber: 1, localStoppedTake: true, stopStates: { [CAP]: { path: "file:///data/app/seg00.mp4" } } } }
      });
      boot.bind();

      await boot._onStartView({ sid: SID, takeNumber: 1, localStoppedTake: true, stopStates: { [CAP]: { path: "file:///data/app/seg00.mp4" } } });
      const ready = ws.out.broadcast.filter((m) => m.kind === "media_ready");
      assert.strictEqual(native.calls.serveStart.length, 1, "serveur média démarré");
      assert.strictEqual(native.calls.serveStart[0].root, "/data/app/MultiCam/" + SID + "/1");
      assert.strictEqual(native.calls.serveStart[0].token.length > 0, true, "token d'accès généré");
      assert.strictEqual(ready.length, 1, "media_ready émis une fois");
      assert.strictEqual(ready[0].extra.files.length, 1);
      assert.strictEqual(ready[0].extra.files[0].sha256, "aaaa");
      assert.ok(logs.some((l) => l.indexOf("TRANSFER_ANNOUNCE_TRIGGER") >= 0));

      await boot._onStartView({ sid: SID, takeNumber: 1, localStoppedTake: true, stopStates: { [CAP]: { path: "file:///data/app/seg00.mp4" } } });
      assert.strictEqual(native.calls.serveStart.length, 1, "pas de seconde annonce pour le même Take");
    });

    it("B3. master : media_ready reçu ⇒ offre aux Storage sélectionnés", async () => {
      const takes = { [SID]: [{ takeNumber: 1, storages: [STO1, STO2], settings: { transferAuto: true } }] };
      const { boot, ws } = makeBoot({ cfg: { enabledSkills: ["controller"] }, takes });
      boot.bind();
      assert.ok(ws.out.bridge, "pont transport installé au bind");

      await boot._onTransferMessage(mediaReady(SID, 1, CAP));
      const offers = ws.out.sendTo.filter((m) => m.kind === "transfer_offer");
      assert.strictEqual(offers.length, 2, "une offre par Storage");
      assert.deepStrictEqual(offers.map((o) => o.did).sort(), [STO1, STO2]);
      assert.ok(offers.every((o) => o.extra.token === "tok"), "token propagé");
    });

    it("B4. storage : offre reçue ⇒ téléchargement reprenable", async () => {
      const takes = { [SID]: [{ takeNumber: 1, storages: [], settings: {} }] };
      const { boot, native } = makeBoot({
        cfg: { enabledSkills: ["storage"] }, takes,
        start: { view: { sid: SID, takeNumber: 1 }, self: STO1 }
      });
      boot.bind();

      await boot._onTransferMessage({
        kind: "transfer_offer", sessionId: SID, takeNumber: 1,
        sourceDeviceId: CAP, storageDeviceId: STO1, host: "10.0.0.5", port: 8080, token: "tok",
        files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }]
      });
      assert.strictEqual(native.calls.download.length, 1);
      assert.strictEqual(native.calls.download[0].url, "http://10.0.0.5:8080/seg00.mp4");
      assert.strictEqual(native.calls.download[0].dest, "/data/app/MultiCam/" + SID + "/1/seg00.mp4");
    });

    it("B5. garde RECORDING : offre mise en attente puis rejouée après le Take", async () => {
      const takes = { [SID]: [{ takeNumber: 1, storages: [], settings: {} }] };
      const { boot, start, native, logs } = makeBoot({
        cfg: { enabledSkills: ["storage"] }, takes,
        start: { view: { sid: SID, takeNumber: 1 }, self: STO1, recording: true }
      });
      boot.bind();

      const offer = {
        kind: "transfer_offer", sessionId: SID, takeNumber: 1,
        sourceDeviceId: CAP, storageDeviceId: STO1, host: "h", port: 1, token: "t",
        files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }]
      };
      await boot._onTransferMessage(offer);
      assert.strictEqual(native.calls.download.length, 0, "aucun pull pendant REC");
      assert.ok(logs.some((l) => l.indexOf("TRANSFER_PAUSE") >= 0));

      start.st.recording = false;
      boot._resumePaused();
      await flush();
      assert.strictEqual(native.calls.download.length, 1, "pull rejoué hors REC");
    });

    it("B6. machine reconstruite quand la session/take change", async () => {
      const takes = {
        "s1": [{ takeNumber: 1, storages: [], settings: {} }],
        "s2": [{ takeNumber: 2, storages: [], settings: {} }]
      };
      const { boot } = makeBoot({ cfg: { enabledSkills: ["capture"] }, takes });
      boot.bind();

      await boot._onStartView({ sid: "s1", takeNumber: 1 });
      assert.strictEqual(boot._machine().state.sid, "s1");
      assert.strictEqual(boot._machine().state.takeNumber, 1);

      await boot._onStartView({ sid: "s2", takeNumber: 2 });
      assert.strictEqual(boot._machine().state.sid, "s2", "en-tête de session mis à jour");
      assert.strictEqual(boot._machine().state.takeNumber, 2);
    });

  });
};
