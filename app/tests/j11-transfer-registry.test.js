/* MultiCam J11-UI-CONFORMANCE — registre multi-(session, take) du boot de
 * transfert (app/www/js/state/transfer-boot.js).
 *
 * Principe : une vue Storage suit PLUSIEURS Takes simultanément (vue 07). Le
 * registre doit donc tenir une machine/service PAR (session, take), sans
 * écrasement, sans double assemblage, et sans que la navigation n'arrête le
 * transfert. On éprouve ces invariants sur des fakes injectés. */

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

function makeWs() {
  const out = { broadcast: [], sendTo: [], bridge: 0 };
  return {
    out,
    _ws: {
      broadcastTargeted(kind, session, extra) { out.broadcast.push({ kind, session, extra }); },
      sendToDevice(did, session, kind, extra) { out.sendTo.push({ did, kind, extra }); },
      setTransferBridge() { out.bridge += 1; }
    }
  };
}

function makeNative() {
  const calls = { serveStart: [], download: [] };
  return {
    calls,
    serveStart(o) { calls.serveStart.push(o); return Promise.resolve("http://10.0.0.5:8080"); },
    serveStop() { return Promise.resolve(); },
    sha256() { return Promise.resolve({ bytes: 1000, sha256: "aaaa" }); },
    download(o) { calls.download.push(o); return Promise.resolve({ done: true, received: o.expectedBytes || 1000, sha256: "aaaa" }); }
  };
}

function makeStart(self, view) {
  const viewers = [];
  return {
    viewers,
    _svc: {
      onView(fn) { viewers.push(fn); },
      machine() { return { view: () => view || { sid: SID, takeNumber: 1 } }; },
      selfDid() { return self; },
      isRecording() { return false; }
    }
  };
}

function makeStore(takes) {
  return { get: (sid) => Promise.resolve({ sessionId: sid, takes: takes || [] }) };
}

function makeBoot(over) {
  over = over || {};
  const logs = [];
  const ws = makeWs();
  const start = makeStart(over.self || STO1, over.startView);
  const native = makeNative();
  const boot = Boot.createTransferBoot({
    cfg: over.cfg || { enabledSkills: ["storage"] },
    ws: () => ws._ws,
    startService: () => start._svc,
    sessionStore: () => makeStore(over.takes || []),
    storageNative: () => ({ defaultPath: () => "file:///data/", systemPath: (u) => String(u || "").replace(/^file:\/\//, "").replace(/\/$/, "") }),
    nativeApi: () => native,
    transferModel: () => M,
    transferService: () => S,
    takeModel: () => TM,
    log: (l) => logs.push(l)
  });
  return { boot, ws, start, native, logs };
}

function offer(take) {
  return {
    kind: "transfer_offer", sessionId: SID, takeNumber: take,
    sourceDeviceId: CAP, storageDeviceId: STO1, host: "h", port: 1, token: "t",
    files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }]
  };
}

module.exports.register = function (h) {
  const describe = h.describe;
  const it = h.it;
  const flush = h.flush;

  describe("J11 registre de transfert — multi-Take et cycle de vie", function () {

    it("C1. deux Takes simultanés : chacun garde SA machine, aucune écrasement", async () => {
      const takes = [
        { takeNumber: 1, storages: [STO1], settings: {} },
        { takeNumber: 2, storages: [STO1], settings: {} }
      ];
      const { boot } = makeBoot({ takes });
      boot.bind();

      await boot._onTransferMessage(offer(1));
      await boot._onTransferMessage(offer(2));
      await flush();

      assert.deepStrictEqual(Object.keys(boot._entries()).sort(), [SID + "|1", SID + "|2"]);
      assert.ok(boot.viewFor(SID, 1), "Take 1 connu");
      assert.ok(boot.viewFor(SID, 2), "Take 2 connu");
      assert.ok(Object.keys(boot.viewFor(SID, 1).transfers).length >= 1, "progression Take 1 conservée");
      assert.ok(Object.keys(boot.viewFor(SID, 2).transfers).length >= 1, "progression Take 2 conservée");
      assert.notStrictEqual(boot.viewFor(SID, 1), boot.viewFor(SID, 2), "deux vues distinctes");
      assert.strictEqual(boot.views().length, 2);
    });

    it("C2. une entrée n'est jamais assemblée deux fois (pas de double service)", async () => {
      const takes = [{ takeNumber: 1, storages: [STO1], settings: {} }];
      const { boot } = makeBoot({ takes });
      boot.bind();
      const a = boot._ensureFor(SID, 1);
      const b = boot._ensureFor(SID, 1);
      assert.strictEqual(a, b, "même service rendu");
      assert.strictEqual(Object.keys(boot._entries()).length, 1);
    });

    it("C3. bind() idempotent : un seul pont transport, un seul abonnement START", () => {
      const takes = [{ takeNumber: 1, storages: [STO1], settings: {} }];
      const { boot, ws, start } = makeBoot({ takes });
      boot.bind();
      boot.bind();
      assert.strictEqual(ws.out.bridge, 1, "un seul pont posé");
      assert.strictEqual(start.viewers.length, 1, "un seul abonnement à la vue START");
    });

    it("C4. la progression continue indépendamment de l'écran (le registre ne se vide jamais)", async () => {
      const takes = [{ takeNumber: 1, storages: [STO1], settings: {} }];
      const { boot } = makeBoot({ takes });
      boot.bind();
      await boot._onTransferMessage(offer(1));
      await flush();
      const before = Object.keys(boot._entries()).length;
      /* « Navigation » : on re-rend / re-consulte la vue, sans rien démonter. */
      assert.ok(boot.viewFor(SID, 1), "vue toujours disponible");
      assert.strictEqual(Object.keys(boot._entries()).length, before, "registre inchangé");
    });
  });
};
