/* MultiCam J11 — transfert / Storage / réplication (app/www/js/state/transfer-model.js).
 *
 * Déterministe, sans DOM ni réseau : horloge, log et transport sont INJECTÉS.
 * Un bus minimal route les messages entre une Capture, un Master et deux
 * Storage, ce qui permet de vérifier de bout en bout le protocole J11 :
 *
 *   J11.1  media_ready : une Capture annonce ses segments (source de vérité)
 *   J11.2  transfer_offer : le Master offre à CHAQUE Storage, indépendamment
 *   J11.3  le Storage crée un transfert `pending` avec un total par fichier
 *   J11.4  progression + OFFSET DE REPRISE (Range) après coupure
 *   J11.5  transfert multi-segments : chaque segment TEL QUEL, ordre préservé
 *   J11.6  transfer_result : SHA-256 égal → done ; divergent → error
 *   J11.7  destinations INDÉPENDANTES (l'échec de l'une n'atteint pas l'autre)
 *   J11.8  suppression locale seulement si tout est `done` ET option active
 *   J11.9  transfer_delete / transfer_delete_ack (source ↔ Master)
 *   J11.10 isolation par Take : un message d'un autre Take est ignoré
 *
 * Journalisation exigée par le plan : TRANSFER_PROGRESS take=… source=… storage=…
 * bytes=… total=… et TRANSFER_HASH take=… sourceSha256=… storageSha256=… (asserés).
 */

"use strict";

const path = require("path");
const assert = require("assert");
const M = require(path.resolve(__dirname, "../www/js/state/transfer-model.js"));

const SID = "session-J11";
const TAKE = 1;
const CAP = "cap-1";
const MST = "mst-1";
const STO1 = "sto-1";
const STO2 = "sto-2";

/* ---------- horloge simulée ---------- */

function SimClock(base) {
  let t = typeof base === "number" ? base : 1000000;
  this.now = function () { return t; };
  this.advance = function (ms) { t += ms; };
}

/* ---------- bus : route send (broadcast) et sendTo (ciblé) ---------- */

function makeBus() {
  const clock = new SimClock();
  const devs = {};
  const kinds = []; /* journal des kinds émis, pour prouver l'absence de bruit */

  const deliver = function (toDid, kind, msg) {
    const d = devs[toDid];
    if (!d) return;
    d.machine.onIncoming(Object.assign({ kind: kind }, msg));
  };

  const broadcast = function (kind, msg, from) {
    kinds.push({ kind: kind, from: from, to: "*" });
    Object.keys(devs).forEach(function (d) { if (d !== from) deliver(d, kind, msg); });
  };

  const make = function (role, self, takeNumber) {
    const logs = [];
    const machine = M.createMachine({
      role: role,
      sid: SID,
      self: function () { return self; },
      takeNumber: takeNumber,
      now: function () { return clock.now(); },
      log: function (l) { logs.push(l); },
      send: function (kind, msg) { broadcast(kind, msg, self); },
      sendTo: function (toDid, kind, msg) {
        kinds.push({ kind: kind, from: self, to: toDid });
        deliver(toDid, kind, msg);
      }
    });
    const dev = { role: role, self: self, machine: machine, logs: logs };
    devs[self] = dev;
    return dev;
  };

  return { clock: clock, make: make, devs: devs, kinds: kinds };
}

/* ---------- manifeste de test (2 segments) ---------- */

function manifest() {
  return {
    host: "10.0.0.5", port: 8080,
    files: [
      { rel: "cam-1-seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" },
      { rel: "cam-1-seg01.mp4", segmentIndex: 1, bytes: 2000, sha256: "bbbb" }
    ]
  };
}

/* Monde prêt : Capture annonce, Master offre aux 2 Storage. */
function buildWorld() {
  const bus = makeBus();
  const cap = bus.make("capture", CAP, TAKE);
  const mst = bus.make("master", MST, TAKE);
  const s1 = bus.make("storage", STO1, TAKE);
  const s2 = bus.make("storage", STO2, TAKE);
  cap.machine.announceMedia(manifest());
  mst.machine.offerTransfers(CAP, [STO1, STO2]);
  return { bus: bus, cap: cap, mst: mst, s1: s1, s2: s2 };
}

function hasLog(logs, needle) {
  return logs.some(function (l) { return l.indexOf(needle) >= 0; });
}

module.exports.register = function (h) {
  const describe = h.describe;
  const it = h.it;

  describe("J11 — transfert / Storage / réplication", function () {

    it("J11.1 media_ready : le Master apprend les segments de la source", function () {
      const bus = makeBus();
      const cap = bus.make("capture", CAP, TAKE);
      const mst = bus.make("master", MST, TAKE);
      cap.machine.announceMedia(manifest());

      const src = mst.machine.state.sources[CAP];
      assert.ok(src, "source enregistrée");
      assert.strictEqual(Object.keys(src.files).length, 2);
      assert.strictEqual(src.totalBytes, 3000);
      assert.strictEqual(src.host, "10.0.0.5");
      assert.ok(hasLog(cap.logs, "MEDIA_READY take=1 source=" + CAP));
      assert.ok(hasLog(mst.logs, "MEDIA_READY take=1 source=" + CAP + " files=2 total=3000"));
    });

    it("J11.2 transfer_offer : le Master offre à chacun, indépendamment", function () {
      const bus = makeBus();
      const cap = bus.make("capture", CAP, TAKE);
      const mst = bus.make("master", MST, TAKE);
      const s1 = bus.make("storage", STO1, TAKE);
      const s2 = bus.make("storage", STO2, TAKE);
      cap.machine.announceMedia(manifest());

      const sent = mst.machine.offerTransfers(CAP, [STO1, STO2]);
      assert.strictEqual(sent.length, 2, "une offre par Storage");
      assert.strictEqual(sent[0].storageDeviceId, STO1);
      assert.strictEqual(sent[1].storageDeviceId, STO2);

      const offersTo1 = bus.kinds.filter(function (k) { return k.kind === "transfer_offer" && k.to === STO1; });
      const offersTo2 = bus.kinds.filter(function (k) { return k.kind === "transfer_offer" && k.to === STO2; });
      assert.strictEqual(offersTo1.length, 1);
      assert.strictEqual(offersTo2.length, 1);
    });

    it("J11.3 le Storage crée un transfert pending avec un total par fichier", function () {
      const w = buildWorld();
      const t = w.s1.machine.transferFor(CAP, STO1);
      assert.strictEqual(t.state, M.PH_PENDING);
      assert.strictEqual(t.total, 3000);
      assert.strictEqual(t.bytes, 0);
      assert.strictEqual(t.files.length, 2);
      assert.strictEqual(t.files[0].rel, "cam-1-seg00.mp4");
      assert.strictEqual(t.files[0].state, M.PH_PENDING);
      assert.ok(hasLog(w.s1.logs, "TRANSFER_OFFER take=1 source=" + CAP + " storage=" + STO1 + " files=2 total=3000"));
    });

    it("J11.4 progression + offset de reprise (Range) après coupure", function () {
      const w = buildWorld();
      w.s1.machine.reportFileProgress(CAP, "cam-1-seg00.mp4", 400);
      /* Le Master agrège la progression. */
      assert.strictEqual(w.mst.machine.percent(CAP, STO1), Math.floor((400 * 100) / 3000));
      /* Le Storage connaît l'offset DÉJÀ reçu → reprise `Range: bytes=400-`. */
      assert.strictEqual(w.s1.machine.resumeOffset(CAP, STO1, "cam-1-seg00.mp4"), 400);
      assert.ok(hasLog(w.s1.logs,
        "TRANSFER_PROGRESS take=1 source=" + CAP + " storage=" + STO1 + " bytes=400 total=1000"));
    });

    it("J11.5 multi-segments : chaque segment tel quel, ordre préservé", function () {
      const w = buildWorld();
      const t = w.s1.machine.transferFor(CAP, STO1);
      assert.deepStrictEqual(t.files.map(function (f) { return f.rel; }),
        ["cam-1-seg00.mp4", "cam-1-seg01.mp4"]);
      assert.deepStrictEqual(t.files.map(function (f) { return f.segmentIndex; }), [0, 1]);
      assert.strictEqual(t.files[0].sha256, "aaaa");
      assert.strictEqual(t.files[1].sha256, "bbbb");
    });

    it("J11.6 result : SHA-256 égal → done ; divergent → error", function () {
      const w = buildWorld();
      /* Segment 0 : hash identique (casse différente) → done. */
      w.s1.machine.reportResult(CAP, "cam-1-seg00.mp4", M.PH_DONE, { bytes: 1000, sha256Destination: "AAAA" });
      let f = w.mst.machine.transferFor(CAP, STO1).files[0];
      assert.strictEqual(f.state, M.PH_DONE);
      /* Preuve de vérification : le log HASH juxtapose les deux empreintes. */
      assert.ok(hasLog(w.s1.logs, "TRANSFER_HASH take=1 sourceSha256=aaaa storageSha256=aaaa"));

      /* Segment 1 : hash divergent annoncé malgré `done` → ÉCHEC. */
      w.s1.machine.reportResult(CAP, "cam-1-seg01.mp4", M.PH_DONE, { bytes: 2000, sha256Destination: "zzzz" });
      f = w.mst.machine.transferFor(CAP, STO1).files[1];
      assert.strictEqual(f.state, M.PH_ERROR);
      assert.strictEqual(f.error, "sha256_mismatch");
    });

    it("J11.7 destinations indépendantes : l'échec de l'une n'atteint pas l'autre", function () {
      const w = buildWorld();
      const doneAll = function (m) {
        m.reportResult(CAP, "cam-1-seg00.mp4", M.PH_DONE, { bytes: 1000, sha256Destination: "aaaa" });
        m.reportResult(CAP, "cam-1-seg01.mp4", M.PH_DONE, { bytes: 2000, sha256Destination: "bbbb" });
      };
      doneAll(w.s1.machine);
      w.s2.machine.reportResult(CAP, "cam-1-seg00.mp4", M.PH_ERROR, { error: "network_reset" });

      assert.strictEqual(w.mst.machine.transferFor(CAP, STO1).state, M.PH_DONE);
      assert.strictEqual(w.mst.machine.transferFor(CAP, STO2).state, M.PH_ERROR);
      assert.strictEqual(w.mst.machine.allDestinationsDone(CAP), false);
    });

    it("J11.8 suppression locale : seulement si tout est done ET option active", function () {
      const w = buildWorld();
      const finish = function (m) {
        m.reportResult(CAP, "cam-1-seg00.mp4", M.PH_DONE, { bytes: 1000, sha256Destination: "aaaa" });
        m.reportResult(CAP, "cam-1-seg01.mp4", M.PH_DONE, { bytes: 2000, sha256Destination: "bbbb" });
      };
      finish(w.s1.machine);
      assert.strictEqual(w.mst.machine.canDeleteLocal(CAP, { deleteLocalAfterVerifiedReplication: true }), false,
        "S2 pas encore vérifié");

      finish(w.s2.machine);
      assert.strictEqual(w.mst.machine.allDestinationsDone(CAP), true);
      assert.strictEqual(w.mst.machine.canDeleteLocal(CAP, { deleteLocalAfterVerifiedReplication: true }), true);
      assert.strictEqual(w.mst.machine.canDeleteLocal(CAP, { deleteLocalAfterVerifiedReplication: false }), false,
        "option du Take désactivée");
      assert.strictEqual(w.mst.machine.canDeleteLocal(CAP, {}), false, "sans option = pas de suppression");
    });

    it("J11.9 transfer_delete : la Capture accuse réception (ack au Master)", function () {
      const w = buildWorld();
      const req = w.mst.machine.requestDelete(CAP);
      assert.strictEqual(req.sourceDeviceId, CAP);
      assert.strictEqual(w.cap.machine.state.deleted[CAP], true, "la Capture a supprimé et accusé");
      assert.strictEqual(w.mst.machine.state.deleted[CAP], true, "le Master a reçu l'ack");
      assert.ok(hasLog(w.mst.logs, "TRANSFER_DELETE take=1 source=" + CAP));
      assert.ok(hasLog(w.mst.logs, "TRANSFER_DELETE_ACK take=1 source=" + CAP));
    });

    it("J11.10 isolation par Take : un message d'un autre Take est ignoré", function () {
      const bus = makeBus();
      const mst = bus.make("master", MST, TAKE);
      const applyMst = mst.machine.onIncoming(Object.assign({ kind: M.K_MEDIA_READY },
        { sessionId: SID, takeNumber: 99, deviceId: CAP, files: [] }));
      assert.strictEqual(applyMst, false, "Take différent → rejeté");
      assert.strictEqual(Object.keys(mst.machine.state.sources).length, 0);
      assert.ok(hasLog(mst.logs, "MEDIA_READY_IGNORE take=99 active=1"));
    });

  });
};
