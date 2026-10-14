/* MultiCam J14 — D-SERVE : serveur média UNIQUE par Capture.
 *
 * Corrige le défaut qualifié lors du test à blanc : chaque Take démarrait un
 * NOUVEAU serveur sur le port 8080 sans jamais arrêter le précédent → bind
 * EADDRINUSE. Ici on éprouve la nouvelle articulation :
 *   - un SEUL serveur (idempotent), partagé au niveau boot ;
 *   - une autorisation (racine + token) PAR Take, enregistrée sur ce serveur ;
 *   - l'URL de pull porte le chemin routé /<sessionId>/<takeNumber>/<rel> ;
 *   - supprimer un Take ne retire QUE son autorisation, sans arrêter le serveur ;
 *   - l'arrêt du serveur est réservé à la fermeture de session (stopServerIfIdle).
 * Tout est fake injecté : aucune I/O, aucun réseau. */

"use strict";

const path = require("path");
const assert = require("assert");
const M = require(path.resolve(__dirname, "../www/js/state/transfer-model.js"));
const S = require(path.resolve(__dirname, "../www/js/state/transfer-service.js"));
const TM = require(path.resolve(__dirname, "../www/js/state/take-model.js"));
const Boot = require(path.resolve(__dirname, "../www/js/state/transfer-boot.js"));

const SID = "session-J14";
const CAP = "cap-1";
const STO1 = "sto-1";

function fakeNative(cfg) {
  cfg = cfg || {};
  const calls = { serveStart: [], serveStop: 0, serveRegister: [], serveUnregister: [], sha256: [], stage: [], remove: [], download: [] };
  return {
    calls,
    serveStart(o) {
      calls.serveStart.push(o);
      if (cfg.startBehavior) return cfg.startBehavior(o, calls.serveStart.length);
      return Promise.resolve(cfg.serveUrl || "http://10.0.0.5:8080");
    },
    serveStop() { calls.serveStop += 1; return Promise.resolve(); },
    serveRegister(o) { calls.serveRegister.push(o); return Promise.resolve({}); },
    serveUnregister(o) { calls.serveUnregister.push(o); return Promise.resolve({}); },
    sha256(p) { calls.sha256.push(p); return Promise.resolve({ bytes: 1000, sha256: "aaaa" }); },
    stage(src, dest) { calls.stage.push({ src, dest }); return Promise.resolve({ dest: dest, bytes: 1000 }); },
    remove(p) { calls.remove.push(p); return Promise.resolve({ removed: true, path: p }); },
    download(o) { calls.download.push(o); return Promise.resolve({ done: true, received: o.expectedBytes || 1000, sha256: "aaaa" }); }
  };
}

function sharedServer() { return { running: false, url: "", host: "", port: 0, tokens: {} }; }

function seg(rel) { return { rel, segmentIndex: 0, path: "/cache/" + rel }; }

function fakeCaptureModel(sid, takeNumber) {
  const sent = [];
  return {
    sent,
    PH_DONE: "done", PH_ERROR: "error",
    K_TRANSFER_DELETE: "transfer_delete",
    announceMedia(m) {
      const msg = { sessionId: sid, takeNumber, host: m.host, port: m.port, token: m.token, files: m.files };
      sent.push(msg);
      return msg;
    },
    onIncoming() { return true; },
    canDeleteLocal() { return false; }
  };
}

/* Service Capture adossé à un serveur partagé (par défaut un natif dédié). */
function captureSvc(server, takeNumber, opts) {
  opts = opts || {};
  const native = opts.native || fakeNative();
  const model = fakeCaptureModel(SID, takeNumber);
  const svc = S.createTransferService({
    model, native, role: "capture", self: () => CAP, log: () => {},
    server,
    take: () => ({ sessionId: SID, takeNumber, storages: [] }),
    generateToken: () => "tok-" + takeNumber,
    paths: { mediaRoot: (sid, t) => "/media/" + sid + "/" + t, listSegments: () => [seg("seg00.mp4")] },
    deleteLocal: opts.deleteLocal || (() => Promise.resolve())
  });
  return { svc, native, model };
}

function makeBootCapture(native) {
  const logs = [];
  const viewers = [];
  const view = { sid: SID, takeNumber: 1, localStoppedTake: true, stopStates: { [CAP]: { path: "file:///data/app/seg00.mp4" } } };
  const start = {
    _svc: {
      onView(fn) { viewers.push(fn); },
      view() { return view; },
      machine() { return { view: () => view }; },
      selfDid() { return CAP; },
      isRecording() { return false; }
    }
  };
  const boot = Boot.createTransferBoot({
    cfg: { enabledSkills: ["capture"] },
    ws: () => null,
    startService: () => start._svc,
    sessionStore: () => ({ get: (sid) => Promise.resolve({ sessionId: sid, takes: [{ takeNumber: 1, storages: [], settings: {} }] }) }),
    storageNative: () => ({ defaultPath: () => "file:///data/app/", systemPath: (u) => String(u || "").replace(/^file:\/\//, "").replace(/\/$/, "") }),
    nativeApi: () => native,
    transferModel: () => M,
    transferService: () => S,
    takeModel: () => TM,
    log: (l) => logs.push(l)
  });
  return { boot, start, viewers, logs, view };
}

module.exports.register = function (h) {
  const describe = h.describe;
  const it = h.it;

  describe("J14 D-SERVE — serveur média unique et routage multi-Take", function () {

    it("DS1. deux Takes simultanés partagent UN serveur (un seul bind)", async () => {
      const server = sharedServer();
      const a = captureSvc(server, 1);
      const b = captureSvc(server, 2);

      await a.svc.captureAnnounce();
      await b.svc.captureAnnounce();

      assert.strictEqual(server.running, true, "serveur partagé actif");
      assert.strictEqual(a.native.calls.serveStart.length, 1, "Take 1 démarre le serveur");
      assert.strictEqual(b.native.calls.serveStart.length, 0, "Take 2 RÉUTILISE le serveur (aucun bind)");
      assert.strictEqual(a.native.calls.serveRegister.length, 1);
      assert.strictEqual(b.native.calls.serveRegister.length, 1);
      assert.strictEqual(a.native.calls.serveRegister[0].takeNumber, 1);
      assert.strictEqual(b.native.calls.serveRegister[0].takeNumber, 2);
      assert.ok(server.tokens[SID + "/1"], "Take 1 autorisé");
      assert.ok(server.tokens[SID + "/2"], "Take 2 autorisé");
    });

    it("DS2. ré-annonce du même Take : token réutilisé, aucun nouveau bind", async () => {
      const server = sharedServer();
      const a = captureSvc(server, 1);
      const m1 = await a.svc.captureAnnounce();
      const m2 = await a.svc.captureAnnounce();

      assert.strictEqual(a.native.calls.serveStart.length, 1, "un seul bind");
      assert.strictEqual(a.native.calls.serveRegister.length, 2, "ré-autorisation idempotente");
      assert.strictEqual(m1.token, m2.token, "token du Take inchangé");
      assert.deepStrictEqual(
        a.native.calls.serveRegister.map((r) => r.token),
        [m1.token, m1.token], "même token ré-enregistré");
    });

    it("DS3. token ISOLÉ par Take : chaque media_ready porte le token de son Take", async () => {
      const server = sharedServer();
      const a = captureSvc(server, 1);
      const b = captureSvc(server, 2);
      const ma = await a.svc.captureAnnounce();
      const mb = await b.svc.captureAnnounce();

      assert.notStrictEqual(ma.token, mb.token, "tokens distincts");
      assert.strictEqual(ma.token, server.tokens[SID + "/1"]);
      assert.strictEqual(mb.token, server.tokens[SID + "/2"]);
      assert.strictEqual(a.model.sent[0].token, ma.token);
      assert.strictEqual(b.model.sent[0].token, mb.token);
    });

    it("DS4. supprimer un Take ne retire QUE son autorisation (serveur inchangé)", async () => {
      const server = sharedServer();
      const a = captureSvc(server, 1);
      const b = captureSvc(server, 2);
      await a.svc.captureAnnounce();
      await b.svc.captureAnnounce();

      await a.svc.handle({ kind: "transfer_delete", sessionId: SID, takeNumber: 1, sourceDeviceId: CAP });

      assert.strictEqual(a.native.calls.serveUnregister.length, 1, "autorisation retirée");
      assert.strictEqual(a.native.calls.serveUnregister[0].takeNumber, 1);
      assert.strictEqual(a.native.calls.serveStop, 0, "serveur NON arrêté");
      assert.strictEqual(server.running, true, "serveur toujours actif");
      assert.strictEqual(server.tokens[SID + "/1"], undefined, "Take 1 dé-autorisé");
      assert.ok(server.tokens[SID + "/2"], "Take 2 intact");
    });

    it("DS5. arrêt de session : serveur stoppé et autorisations purgées", async () => {
      const server = sharedServer();
      const a = captureSvc(server, 1);
      await a.svc.captureAnnounce();

      await a.svc.serveStop();

      assert.strictEqual(a.native.calls.serveStop, 1, "serveur arrêté");
      assert.strictEqual(server.running, false);
      assert.deepStrictEqual(server.tokens, {}, "toutes autorisations purgées");
    });

    it("DS6. URL de pull ROUTÉE /<sessionId>/<takeNumber>/<rel>", async () => {
      const server = sharedServer();
      const native = fakeNative();
      const model = M.createMachine({
        role: "storage", sid: SID, self: () => STO1, takeNumber: 3,
        log: () => {}, send: () => {}, sendTo: () => {}
      });
      const svc = S.createTransferService({
        model, native, role: "storage", self: () => STO1, log: () => {}, server,
        take: () => ({ sessionId: SID, takeNumber: 3, storages: [] }),
        paths: { destFor: () => ({ dest: "/d/x" }) }
      });
      await svc.handle({
        kind: "transfer_offer", sessionId: SID, takeNumber: 3,
        sourceDeviceId: CAP, storageDeviceId: STO1, host: "10.0.0.5", port: 8080, token: "t",
        files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }]
      });
      assert.strictEqual(native.calls.download[0].url, "http://10.0.0.5:8080/" + SID + "/3/seg00.mp4");
    });

    it("DS7. port effectif : une URL sur port libre est reprise telle quelle", async () => {
      const server = sharedServer();
      const native = fakeNative({ serveUrl: "http://10.0.0.5:41234" });
      const a = captureSvc(server, 1, { native });
      const msg = await a.svc.captureAnnounce();
      assert.strictEqual(msg.port, 41234, "le port réellement écouté est annoncé");
      assert.strictEqual(server.port, 41234);
    });

    it("DS8. boot : stopServerIfIdle n'arrête le serveur qu'une fois plus aucun Take autorisé", async () => {
      const native = fakeNative();
      const { boot, view } = makeBootCapture(native);
      boot.bind();
      await boot._onStartView(view);

      assert.strictEqual(native.calls.serveStart.length, 1);
      assert.strictEqual(native.calls.serveRegister.length, 1);

      await boot.stopServerIfIdle();
      assert.strictEqual(native.calls.serveStop, 0, "serveur conservé tant qu'un Take est autorisé");

      await boot._onTransferMessage({ kind: "transfer_delete", sessionId: SID, takeNumber: 1, sourceDeviceId: CAP });
      assert.strictEqual(native.calls.serveUnregister.length, 1, "Take dé-autorisé à la suppression locale");

      await boot.stopServerIfIdle();
      assert.strictEqual(native.calls.serveStop, 1, "serveur arrêté une fois la session close");
    });

  });
};
