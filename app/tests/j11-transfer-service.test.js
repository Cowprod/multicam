/* MultiCam J11 — service de transfert (app/www/js/state/transfer-service.js).
 *
 * Le modèle pur est éprouvé par j11-transfer.test.js ; ici on éprouve la GLUE :
 * annonce des segments par la Capture, offre du Master, téléchargement
 * reprenable du Storage, garde RECORDING et suppression locale vérifiée.
 * Le natif est un FAKE injecté : aucune I/O réelle, tout est déterministe.
 */

"use strict";

const path = require("path");
const assert = require("assert");
const M = require(path.resolve(__dirname, "../www/js/state/transfer-model.js"));
const S = require(path.resolve(__dirname, "../www/js/state/transfer-service.js"));

const SID = "session-J11";
const TAKE = 1;
const CAP = "cap-1";
const MST = "mst-1";
const STO1 = "sto-1";
const STO2 = "sto-2";

/* ---------- fake natif ---------- */

function fakeNative(cfg) {
  cfg = cfg || {};
  const calls = { serveStart: [], serveStop: 0, sha256: [], download: [] };
  return {
    calls: calls,
    serveStart(opts) {
      calls.serveStart.push(opts);
      if (cfg.serveStartError) return Promise.reject(new Error(cfg.serveStartError));
      return Promise.resolve(cfg.serveUrl || "http://10.0.0.5:8080");
    },
    serveStop() { calls.serveStop += 1; return Promise.resolve(); },
    sha256(p) {
      calls.sha256.push(p);
      const r = (cfg.sha256Map && cfg.sha256Map[p]) || { bytes: 1000, sha256: "aaaa" };
      return Promise.resolve(r);
    },
    download(opts, onProgress) {
      calls.download.push(opts);
      const plan = cfg.downloadPlan ? cfg.downloadPlan(opts, calls.download.length) : { ok: true };
      if (plan.progress && onProgress) {
        plan.progress.forEach((p) => onProgress(p));
      }
      if (plan.ok === false) return Promise.reject(new Error(plan.error || "net"));
      return Promise.resolve(plan.result || { done: true, received: 1000, total: 1000, sha256: "aaaa" });
    }
  };
}

/* ---------- fake chemins ---------- */

function fakePaths(segs, dest) {
  return {
    mediaRoot: (sid, take) => `/media/${sid}/${take}`,
    listSegments: () => segs || [],
    destFor: (sid, take, rel) => dest ? dest(rel) : { dest: `/dest/${sid}/${take}/${rel}` }
  };
}

/* ---------- modèle ---------- */

function makeModel(role, self, takeNumber) {
  const sent = [];
  const targeted = [];
  const logs = [];
  const machine = M.createMachine({
    role, sid: SID, self: () => self, takeNumber,
    now: () => 1000000,
    log: (l) => logs.push(l),
    send: (kind, msg) => sent.push({ kind, msg }),
    sendTo: (to, kind, msg) => targeted.push({ to, kind, msg })
  });
  return { machine, sent, targeted, logs };
}

function seg(rel, index, bytes, sha) {
  return { rel, segmentIndex: index, path: `/media/${rel}`, bytes, sha256: sha };
}

module.exports.register = function (h) {
  const describe = h.describe;
  const it = h.it;

  describe("J11 service — annonce, offre, pull, garde, suppression", function () {

    it("S1. captureAnnounce : SHA-256 par segment, serveur démarré, media_ready émis", async () => {
      const segs = [seg("seg00.mp4", 0, 1000, "aaaa"), seg("seg01.mp4", 1, 2000, "bbbb")];
      const native = fakeNative({
        serveUrl: "http://10.0.0.5:8080",
        sha256Map: { "/media/seg00.mp4": { bytes: 1000, sha256: "aaaa" }, "/media/seg01.mp4": { bytes: 2000, sha256: "bbbb" } }
      });
      const model = makeModel("capture", CAP, TAKE);
      const svc = S.createTransferService({
        model: model.machine, native, role: "capture", self: () => CAP,
        log: (l) => model.logs.push(l), take: () => ({ sessionId: SID, takeNumber: TAKE, storages: [] }),
        paths: fakePaths(segs)
      });
      const msg = await svc.captureAnnounce();

      assert.strictEqual(native.calls.sha256.length, 2);
      assert.strictEqual(native.calls.serveStart.length, 1);
      assert.strictEqual(native.calls.serveStart[0].root, `/media/${SID}/${TAKE}`);
      assert.ok(native.calls.serveStart[0].token.length > 0, "token généré");
      assert.strictEqual(msg.host, "10.0.0.5");
      assert.strictEqual(msg.port, 8080);
      assert.strictEqual(msg.files.length, 2);
      assert.deepStrictEqual(msg.files.map((f) => f.sha256), ["aaaa", "bbbb"]);
      assert.ok(model.sent.some((m) => m.kind === "media_ready"));
      assert.ok(model.logs.some((l) => l.indexOf("TRANSFER_SERVE") >= 0));
    });

    it("S2. master : offre automatique aux Storage si transferAuto", async () => {
      const native = fakeNative();
      const model = makeModel("master", MST, TAKE);
      const tk = { sessionId: SID, takeNumber: TAKE, storages: [STO1, STO2] };
      const svc = S.createTransferService({
        model: model.machine, native, role: "master", self: () => MST,
        log: (l) => model.logs.push(l), take: () => tk,
        settings: () => ({ transferAuto: true }),
        paths: fakePaths([])
      });
      await svc.handle({
        kind: "media_ready", sessionId: SID, takeNumber: TAKE, deviceId: CAP,
        host: "10.0.0.5", port: 8080, token: "tok",
        files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }]
      });
      const offers = model.targeted.filter((m) => m.kind === "transfer_offer");
      assert.strictEqual(offers.length, 2, "une offre par Storage");
      assert.ok(offers.every((o) => o.msg.token === "tok"), "token transmis");
    });

    it("S2b. master : PAS d'offre si transferAuto désactivé (manuel)", async () => {
      const native = fakeNative();
      const model = makeModel("master", MST, TAKE);
      const svc = S.createTransferService({
        model: model.machine, native, role: "master", self: () => MST,
        log: (l) => model.logs.push(l),
        take: () => ({ sessionId: SID, takeNumber: TAKE, storages: [STO1] }),
        settings: () => ({ transferAuto: false }),
        paths: fakePaths([])
      });
      await svc.handle({
        kind: "media_ready", sessionId: SID, takeNumber: TAKE, deviceId: CAP,
        host: "10.0.0.5", port: 8080, files: [{ rel: "seg00.mp4", bytes: 1000, sha256: "aaaa" }]
      });
      assert.strictEqual(model.targeted.filter((m) => m.kind === "transfer_offer").length, 0);
      assert.ok(model.logs.some((l) => l.indexOf("TRANSFER_OFFER_SKIP reason=manual") >= 0));
    });

    it("S3. storage : téléchargement, progression publiée, résultat done", async () => {
      const native = fakeNative({
        downloadPlan: () => ({ ok: true, result: { done: true, received: 1000, total: 1000, sha256: "aaaa" },
          progress: [{ received: 400, total: 1000 }] })
      });
      const model = makeModel("storage", STO1, TAKE);
      const svc = S.createTransferService({
        model: model.machine, native, role: "storage", self: () => STO1,
        log: (l) => model.logs.push(l),
        take: () => ({ sessionId: SID, takeNumber: TAKE, storages: [] }),
        paths: fakePaths([], (rel) => ({ dest: `/dest/${rel}` }))
      });
      await svc.handle({
        kind: "transfer_offer", sessionId: SID, takeNumber: TAKE,
        sourceDeviceId: CAP, storageDeviceId: STO1, host: "10.0.0.5", port: 8080, token: "tok",
        files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }]
      });
      assert.strictEqual(native.calls.download.length, 1);
      assert.strictEqual(native.calls.download[0].url, "http://10.0.0.5:8080/seg00.mp4");
      assert.strictEqual(native.calls.download[0].token, "tok");
      assert.strictEqual(native.calls.download[0].offset, 0);
      const t = model.machine.transferFor(CAP, STO1);
      assert.strictEqual(t.state, M.PH_DONE);
      assert.ok(model.logs.some((l) => l.indexOf("TRANSFER_PROGRESS") >= 0));
      assert.ok(model.logs.some((l) => l.indexOf("TRANSFER_FILE_DONE") >= 0));
    });

    it("S4. storage : échec transitoire puis reprise (offset conservé) → done", async () => {
      let n = 0;
      const native = fakeNative({
        downloadPlan: (opts) => {
          n += 1;
          if (n === 1) return { ok: false, error: "reset", progress: [{ received: 400, total: 1000 }] };
          return { ok: true, result: { done: true, received: 1000, total: 1000, sha256: "aaaa" } };
        }
      });
      const model = makeModel("storage", STO1, TAKE);
      const svc = S.createTransferService({
        model: model.machine, native, role: "storage", self: () => STO1,
        log: (l) => model.logs.push(l),
        take: () => ({ sessionId: SID, takeNumber: TAKE, storages: [] }),
        paths: fakePaths([], () => ({ dest: "/dest/f" }))
      });
      await svc.handle({
        kind: "transfer_offer", sessionId: SID, takeNumber: TAKE,
        sourceDeviceId: CAP, storageDeviceId: STO1, host: "h", port: 1, token: "t",
        files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }]
      });
      assert.strictEqual(native.calls.download.length, 2, "une reprise");
      assert.strictEqual(native.calls.download[1].offset, 400, "reprend à l'offset reçu");
      assert.strictEqual(model.machine.transferFor(CAP, STO1).state, M.PH_DONE);
    });

    it("S5. storage : échec persistant → error après MAX_ATTEMPTS", async () => {
      const native = fakeNative({ downloadPlan: () => ({ ok: false, error: "boom" }) });
      const model = makeModel("storage", STO1, TAKE);
      const svc = S.createTransferService({
        model: model.machine, native, role: "storage", self: () => STO1,
        log: (l) => model.logs.push(l),
        take: () => ({ sessionId: SID, takeNumber: TAKE, storages: [] }),
        paths: fakePaths([], () => ({ dest: "/dest/f" }))
      });
      await svc.handle({
        kind: "transfer_offer", sessionId: SID, takeNumber: TAKE,
        sourceDeviceId: CAP, storageDeviceId: STO1, host: "h", port: 1, token: "t",
        files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }]
      });
      assert.strictEqual(native.calls.download.length, S.MAX_ATTEMPTS);
      assert.strictEqual(model.machine.transferFor(CAP, STO1).state, M.PH_ERROR);
    });

    it("S6. garde RECORDING : aucun téléchargement pendant un Take", async () => {
      const native = fakeNative();
      const model = makeModel("storage", STO1, TAKE);
      const svc = S.createTransferService({
        model: model.machine, native, role: "storage", self: () => STO1,
        log: (l) => model.logs.push(l), isRecording: () => true,
        take: () => ({ sessionId: SID, takeNumber: TAKE, storages: [] }),
        paths: fakePaths([], () => ({ dest: "/dest/f" }))
      });
      await svc.handle({
        kind: "transfer_offer", sessionId: SID, takeNumber: TAKE,
        sourceDeviceId: CAP, storageDeviceId: STO1, host: "h", port: 1, token: "t",
        files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }]
      });
      assert.strictEqual(native.calls.download.length, 0, "aucun pull pendant REC");
      assert.ok(model.logs.some((l) => l.indexOf("TRANSFER_PAUSE") >= 0 && l.indexOf("reason=recording") >= 0));
    });

    it("S7. master : suppression locale ordonnée quand tout est vérifié", async () => {
      const native = fakeNative();
      const model = makeModel("master", MST, TAKE);
      const svc = S.createTransferService({
        model: model.machine, native, role: "master", self: () => MST,
        log: (l) => model.logs.push(l),
        take: () => ({ sessionId: SID, takeNumber: TAKE, storages: [STO1] }),
        settings: () => ({ transferAuto: true, deleteLocalAfterVerifiedReplication: true }),
        paths: fakePaths([])
      });
      /* Le Master offre (crée la destination attendue) puis reçoit le résultat. */
      await svc.handle({
        kind: "media_ready", sessionId: SID, takeNumber: TAKE, deviceId: CAP,
        host: "h", port: 1, files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }]
      });
      await svc.handle({
        kind: "transfer_result", sessionId: SID, takeNumber: TAKE,
        sourceDeviceId: CAP, storageDeviceId: STO1, rel: "seg00.mp4",
        state: "done", bytes: 1000, sha256Destination: "aaaa"
      });
      const del = model.targeted.filter((m) => m.kind === "transfer_delete");
      assert.strictEqual(del.length, 1, "un ordre de suppression");
      assert.strictEqual(del[0].to, CAP);
    });

    it("S8. capture : suppression locale effectuée AVANT l'ack", async () => {
      const native = fakeNative();
      const segs = [seg("seg00.mp4", 0, 1000, "aaaa")];
      const order = [];
      const model = makeModel("capture", CAP, TAKE);
      const svc = S.createTransferService({
        model: model.machine, native, role: "capture", self: () => CAP,
        log: (l) => model.logs.push(l),
        take: () => ({ sessionId: SID, takeNumber: TAKE, storages: [] }),
        paths: fakePaths(segs),
        deleteLocal: (list) => { order.push("delete:" + list.length); return Promise.resolve(); }
      });
      await svc.handle({
        kind: "transfer_delete", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP
      });
      assert.deepStrictEqual(order, ["delete:1"]);
      assert.strictEqual(model.machine.state.deleted[CAP], true, "ack émis après suppression");
      assert.ok(model.sent.some((m) => m.kind === "transfer_delete_ack"));
    });

  });
};
