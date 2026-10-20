/* MultiCam J14-C01 — fiabilisation du cycle de vie des transferts.
 *
 * Couvre les trois défauts révélés par la campagne J14 :
 *   D1 — perte d'un état terminal + absence de réconciliation + absence de
 *        watchdog (monotonie terminale, re-diffusion, transfert bloqué, voie
 *        de (ré)identification d'un pair) ;
 *   D2 — cause masquée + retry sans backoff (message précis, backoff injecté) ;
 *   D3 — suppression ciblée par (session, Take), différée tant qu'elle n'est pas
 *        confirmée, ACK PORTEUR du résultat réel.
 *
 * Fakes injectés uniquement : aucune I/O, aucun timer réel. */

"use strict";

const path = require("path");
const assert = require("assert");
const M = require(path.resolve(__dirname, "../www/js/state/transfer-model.js"));
const S = require(path.resolve(__dirname, "../www/js/state/transfer-service.js"));
const TM = require(path.resolve(__dirname, "../www/js/state/take-model.js"));
const Boot = require(path.resolve(__dirname, "../www/js/state/transfer-boot.js"));

const SID = "session-J14C";
const TAKE = 1;
const CAP = "cap-1";
const MST = "mst-1";
const STO1 = "sto-1";
const STO2 = "sto-2";

/* ---------- fakes communs ---------- */

function fakeNative(cfg) {
  cfg = cfg || {};
  const calls = { serveStart: [], serveStop: 0, serveRegister: [], serveUnregister: [], sha256: [], download: [], remove: [], stage: [] };
  return {
    calls,
    serveStart(o) { calls.serveStart.push(o); return Promise.resolve(cfg.serveUrl || "http://10.0.0.5:8080"); },
    serveStop() { calls.serveStop += 1; return Promise.resolve(); },
    serveRegister(o) { calls.serveRegister.push(o); return Promise.resolve({}); },
    serveUnregister(o) { calls.serveUnregister.push(o); return Promise.resolve({}); },
    sha256(p) { calls.sha256.push(p); return Promise.resolve({ bytes: 1000, sha256: "aaaa" }); },
    stage(src, dest) { calls.stage.push({ src, dest }); return Promise.resolve({ dest, bytes: 1000 }); },
    remove(p) {
      calls.remove.push(p);
      const plan = cfg.removePlan ? cfg.removePlan(p, calls.remove.length) : { removed: true, existed: true };
      return Promise.resolve(Object.assign({ path: p }, plan));
    },
    download(o, onProgress) { calls.download.push(o); return Promise.resolve({ done: true, received: o.expectedBytes || 1000, sha256: "aaaa" }); }
  };
}

function mkModel(role, self, nowFn, takeNumber) {
  const sent = [];
  const targeted = [];
  const logs = [];
  const machine = M.createMachine({
    role, sid: SID, self: () => self, takeNumber: takeNumber || TAKE,
    now: nowFn || (() => 1000),
    log: (l) => logs.push(l),
    send: (kind, msg) => sent.push({ kind, msg }),
    sendTo: (to, kind, msg) => targeted.push({ to, kind, msg })
  });
  return { machine, sent, targeted, logs };
}

function offerMsg(cap, files) {
  return {
    kind: "transfer_offer", sessionId: SID, takeNumber: TAKE,
    sourceDeviceId: cap, storageDeviceId: STO1, host: "h", port: 1, token: "t",
    files: files || [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }]
  };
}

module.exports.register = function (h) {
  const describe = h.describe;
  const it = h.it;

  /* ====================================================================== */
  /* D1 — modèle                                                            */
  /* ====================================================================== */

  describe("J14-C01 D1 — monotonie terminale & réconciliation (modèle)", function () {

    it("D1.1 un PROGRESS tardif ne rétrograde JAMAIS un état terminal (done)", async () => {
      const m = mkModel("storage", STO1, () => 1000);
      m.machine.onIncoming(offerMsg(CAP));
      m.machine.onIncoming({ kind: "transfer_result", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, storageDeviceId: STO1, rel: "seg00.mp4", state: "done", bytes: 1000, sha256Destination: "aaaa" });
      assert.strictEqual(m.machine.transferFor(CAP, STO1).state, M.PH_DONE);
      const applied = m.machine.onIncoming({ kind: "transfer_progress", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, storageDeviceId: STO1, rel: "seg00.mp4", received: 500, total: 1000 });
      assert.strictEqual(applied, false, "progression ignorée après terminal");
      assert.strictEqual(m.machine.transferFor(CAP, STO1).state, M.PH_DONE, "état terminal conservé");
      assert.ok(m.logs.some((l) => l.indexOf("TRANSFER_PROGRESS_IGNORE") >= 0), "trace de l'ignoré");
    });

    it("D1.2 un PROGRESS tardif ne rétrograde JAMAIS un état terminal (error)", async () => {
      const m = mkModel("master", MST, () => 1000);
      m.machine.onIncoming({ kind: "media_ready", sessionId: SID, takeNumber: TAKE, deviceId: CAP, host: "h", port: 1, files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }] });
      m.machine.onIncoming({ kind: "transfer_result", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, storageDeviceId: STO1, rel: "seg00.mp4", state: "error", error: "download_failed" });
      assert.strictEqual(m.machine.transferFor(CAP, STO1).state, M.PH_ERROR);
      m.machine.onIncoming({ kind: "transfer_progress", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, storageDeviceId: STO1, rel: "seg00.mp4", received: 1713364144, total: 1946232248 });
      assert.strictEqual(m.machine.transferFor(CAP, STO1).state, M.PH_ERROR, "l'échec acquitté reste terminal (T2-D)");
    });

    it("D1.3 staleTransfers : seuls les transferts NON terminaux et âgés sont signalés", async () => {
      let now = 1000;
      const m = mkModel("master", MST, () => now);
      m.machine.onIncoming({ kind: "media_ready", sessionId: SID, takeNumber: TAKE, deviceId: CAP, host: "h", port: 1, files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }] });
      m.machine.offerTransfers(CAP, [STO1, STO2]);
      m.machine.onIncoming({ kind: "transfer_result", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, storageDeviceId: STO2, rel: "seg00.mp4", state: "error", error: "download_failed" });
      assert.strictEqual(m.machine.staleTransfers(5000, 1000).length, 0, "pas encore âgé");
      assert.strictEqual(m.machine.staleTransfers(5000, 6000).length, 1, "STO1 non terminal et âgé (STO2 terminal exclu)");
      assert.strictEqual(m.machine.staleTransfers(5000, 6000)[0].storageDeviceId, STO1);
    });

    /* J14→J15 — CONTRAT MODIFIÉ.
     *
     * J14 : un blocage (stall watchdog) rendait le transfert TERMINAL `error` et
     *       publiait `transfer_result state=error` (D1.4), ce qui, à tort,
     *       faisait échouer définitivement un transfert sur simple silence réseau
     *       (cause A du diagnostic J15) et déclenchait la voie de suppression.
     *
     * J15 : un stall n'est PAS une preuve d'impossibilité (§16-R5). Le watchdog
     *       passe le transfert en `waiting_network` NON terminal (§4/§5) et le
     *       PUBLIE via `transfer_waiting`, sans jamais émettre de résultat
     *       terminal `error`. La reprise reste possible (aucun `done` détruit).
     *
     * Conservé : convergence Storage→Master (publication immédiate), idempotence,
     *            monotonie terminale, et AUCUNE suppression Capture prématurée. */
    it("D1.4 Storage : un blocage passe en waiting_network PUBLIÉ (J15, plus d'error terminal)", async () => {
      const m = mkModel("storage", STO1, () => 1000);
      m.machine.onIncoming(offerMsg(CAP));
      assert.strictEqual(m.machine.transferFor(CAP, STO1).state, M.PH_PENDING);

      const changed = m.machine.markTransferWaiting(CAP, STO1, "stalled", 9000, 0);
      assert.strictEqual(changed, true);
      assert.strictEqual(m.machine.transferFor(CAP, STO1).state, M.PH_WAITING_NETWORK,
        "J15 : attente réseau, PAS error");
      /* Publication immédiate au Master (convergence), kind dédié, AUCUN
       * résultat terminal. */
      const pub = m.sent.filter((s) => s.kind === "transfer_waiting");
      assert.strictEqual(pub.length, 1, "état d'attente publié au Master");
      assert.strictEqual(pub[0].msg.state, "waiting_network");
      assert.strictEqual(pub[0].msg.storageDeviceId, STO1);
      assert.ok(!m.sent.some((s) => s.kind === "transfer_result"), "J15 : AUCUN `transfer_result` terminal sur simple stall");
      assert.ok(m.logs.some((l) => l.indexOf("TRANSFER_WAITING") >= 0));

      /* Le Master converge vers le MÊME état (pas d'error). */
      const master = mkModel("master", MST, () => 1000);
      master.machine.onIncoming({ kind: "media_ready", sessionId: SID, takeNumber: TAKE, deviceId: CAP, host: "h", port: 1, files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }] });
      master.machine.offerTransfers(CAP, [STO1]);
      const waitEnv = m.sent.find((s) => s.kind === "transfer_waiting").msg;
      master.machine.onIncoming(Object.assign({ kind: "transfer_waiting" }, waitEnv));
      assert.strictEqual(master.machine.transferFor(CAP, STO1).state, M.PH_WAITING_NETWORK);
    });

    it("D1.4b J15 : le stall reste REPRENABLE (offre en mode reprise ne détruit pas l'attente)", async () => {
      const m = mkModel("storage", STO1, () => 1000);
      m.machine.onIncoming(offerMsg(CAP));
      m.machine.markTransferWaiting(CAP, STO1, "stalled", 9000, 0);
      /* Ré-offre de reprise : l'état d'attente est CONSERVÉ (pas de reset dur). */
      m.machine.onIncoming(offerMsg(CAP));
      assert.strictEqual(m.machine.transferFor(CAP, STO1).state, M.PH_WAITING_NETWORK,
        "une ré-offre de reprise n'efface pas l'attente (resumeOffset conservé)");
    });

    it("D1.5 Storage : rebroadcastTerminalResults ré-émet les issues terminales (idempotent côté Master)", async () => {
      const storage = mkModel("storage", STO1, () => 1000);
      storage.machine.onIncoming(offerMsg(CAP));
      storage.machine.onIncoming({ kind: "transfer_result", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, storageDeviceId: STO1, rel: "seg00.mp4", state: "done", bytes: 1000, sha256Destination: "aaaa" });
      const n = storage.machine.rebroadcastTerminalResults();
      assert.strictEqual(n, 1, "une issue terminale ré-émise");
      assert.ok(storage.sent.some((s) => s.kind === "transfer_result" && s.msg.rel === "seg00.mp4"));

      /* Côté Master : la 2e application identique est un no-op (pas de double
       * suppression, cf. J14-B02). */
      const master = mkModel("master", MST, () => 1000);
      master.machine.onIncoming({ kind: "media_ready", sessionId: SID, takeNumber: TAKE, deviceId: CAP, host: "h", port: 1, files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }] });
      const first = master.machine.onIncoming({ kind: "transfer_result", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, storageDeviceId: STO1, rel: "seg00.mp4", state: "done", bytes: 1000, sha256Destination: "aaaa" });
      const second = master.machine.onIncoming({ kind: "transfer_result", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, storageDeviceId: STO1, rel: "seg00.mp4", state: "done", bytes: 1000, sha256Destination: "aaaa" });
      assert.strictEqual(first, true);
      assert.strictEqual(second, false, "re-diffusion idempotente");
    });

    /* J14→J15 — CONTRAT MODIFIÉ.
     *
     * J14 : après un marquage « bloqué », un PROGRESS ne devait pas ressusciter
     *       l'état, mais celui-ci était terminal `error` (l'échec restait figé).
     *
     * J15 : l'attente réseau n'est PAS terminale : un PROGRESS reçu prouve que le
     *       travail a REPRIS, donc il LÈVE l'attente (§4 : `waiting_network` est
     *       un état de repos réversible) et re-synchronise l'avancement. La
     *       garantie conservée est l'absence de rétrogradation d'un `done`/`error`
     *       (voir D1.1/D1.2). */
    it("D1.6 Storage : un PROGRESS lève l'attente mais ne rétrograde pas un terminal (J15)", async () => {
      const m = mkModel("storage", STO1, () => 1000);
      m.machine.onIncoming(offerMsg(CAP));
      /* Terminal franc : un PROGRESS ne doit JAMAIS le rétrograder (garantie J14
       * conservée — c'est le cœur anti-double-suppression). */
      m.machine.onIncoming({ kind: "transfer_result", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, storageDeviceId: STO1, rel: "seg00.mp4", state: "done", bytes: 1000, sha256Destination: "aaaa" });
      assert.strictEqual(m.machine.transferFor(CAP, STO1).state, M.PH_DONE);
      const applied = m.machine.onIncoming({ kind: "transfer_progress", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, storageDeviceId: STO1, rel: "seg00.mp4", received: 400, total: 1000 });
      assert.strictEqual(applied, false, "progression ignorée après terminal");
      assert.strictEqual(m.machine.transferFor(CAP, STO1).state, M.PH_DONE, "terminal préservé");

      /* Attente réseau : une progression côté Storage (reprise) lève l'attente. */
      const s = mkModel("storage", STO1, () => 1000);
      s.machine.onIncoming(offerMsg(CAP));
      s.machine.markTransferWaiting(CAP, STO1, "stalled", 2000, 0);
      assert.strictEqual(s.machine.transferFor(CAP, STO1).state, M.PH_WAITING_NETWORK);
      s.machine.onIncoming({ kind: "transfer_progress", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, storageDeviceId: STO1, rel: "seg00.mp4", received: 400, total: 1000 });
      assert.strictEqual(s.machine.transferFor(CAP, STO1).state, M.PH_TRANSFERRING,
        "J15 : le PROGRESS prouve la reprise → attente levée (non terminale)");
    });
  });

  /* ====================================================================== */
  /* D3 — modèle (ACK porteur du résultat)                                  */
  /* ====================================================================== */

  describe("J14-C01 D3 — ACK de suppression porteur du résultat (modèle)", function () {

    it("D3.1 un ACK `failed` ne marque PAS le média supprimé", async () => {
      const m = mkModel("master", MST, () => 1000);
      m.machine.onIncoming({ kind: "media_ready", sessionId: SID, takeNumber: TAKE, deviceId: CAP, host: "h", port: 1, files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }] });
      m.machine.onIncoming({ kind: "transfer_delete_ack", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, state: "failed", error: "delete_failed" });
      assert.strictEqual(m.machine.state.deleted[CAP], undefined, "pas de faux succès");
      assert.strictEqual(m.machine.state.deleteFailed[CAP], "delete_failed");
      assert.ok(m.logs.some((l) => l.indexOf("TRANSFER_DELETE_FAILED") >= 0));
    });

    it("D3.2 un ACK sans état reste un succès (rétro-compatibilité J11)", async () => {
      const m = mkModel("master", MST, () => 1000);
      m.machine.onIncoming({ kind: "media_ready", sessionId: SID, takeNumber: TAKE, deviceId: CAP, host: "h", port: 1, files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }] });
      m.machine.onIncoming({ kind: "transfer_delete_ack", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP });
      assert.strictEqual(m.machine.state.deleted[CAP], true);
      assert.strictEqual(m.machine.state.deleteFailed[CAP], undefined);
    });

    it("D3.3 Capture : reportDeleteFailed émet un ACK d'échec (jamais un mensonge)", async () => {
      const m = mkModel("capture", CAP, () => 1000);
      m.machine.reportDeleteFailed({ sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP }, "delete_failed");
      const ack = m.sent.filter((s) => s.kind === "transfer_delete_ack").pop();
      assert.ok(ack, "ACK émis");
      assert.strictEqual(ack.msg.state, "error");
      assert.strictEqual(ack.msg.error, "delete_failed");
      assert.strictEqual(m.machine.state.deleted[CAP], undefined);
    });
  });

  /* ====================================================================== */
  /* D3 — service (ciblage, différé, idempotence)                            */
  /* ====================================================================== */

  describe("J14-C01 D3 — suppression ciblée & différée (service)", function () {

    function captureSvc(cfg) {
      cfg = cfg || {};
      const native = fakeNative(cfg.native);
      const m = mkModel("capture", CAP, () => 1000);
      let recording = !!cfg.recording;
      const segs = cfg.segs || [{ rel: "seg00.mp4", segmentIndex: 0, path: "/media/" + SID + "/" + TAKE + "/seg00.mp4" }];
      const paths = Object.assign(
        { mediaRoot: (s, t) => "/media/" + s + "/" + t, listSegments: () => [] },
        cfg.paths ? cfg.paths : {
          listSegmentsFor: () => segs,
          hasTake: () => true
        }
      );
      const svc = S.createTransferService({
        model: m.machine, native, role: "capture", self: () => CAP,
        log: (l) => m.logs.push(l), take: () => ({ sessionId: cfg.currentSid || SID, takeNumber: cfg.currentTake || TAKE, storages: [] }),
        paths,
        deleteLocal: cfg.deleteLocal || ((list) => Promise.all(list.map((p) => native.remove(p))).then((rs) => ({
          ok: rs.every((r) => r && (r.removed || r.existed === false)),
          removed: rs.filter((r) => r && r.removed).length,
          failed: rs.filter((r) => !(r && (r.removed || r.existed === false))).length,
          requested: list.length
        }))),
        isRecording: () => recording
      });
      return { svc, native, model: m, setRecording: (v) => { recording = v; } };
    }

    it("D3.4 la suppression CIBLE le Take de la demande, même si le Take courant a changé", async () => {
      /* Le Take courant est déjà le suivant (3) : la référence stagée du Take 1
       * reste la seule source de vérité. */
      const segs = [{ rel: "seg00.mp4", segmentIndex: 0, path: "/media/" + SID + "/1/seg00.mp4" }];
      const c = captureSvc({ segs, currentTake: 3 });
      await c.svc.handle({ kind: "transfer_delete", sessionId: SID, takeNumber: 1, sourceDeviceId: CAP });
      assert.deepStrictEqual(c.native.calls.remove, ["/media/" + SID + "/1/seg00.mp4"], "cible = segment du Take 1");
      assert.strictEqual(c.model.machine.state.deleted[CAP], true, "ACK émis après suppression confirmée");
      assert.ok(c.model.logs.some((l) => l.indexOf("TRANSFER_LOCAL_DELETED take=1") >= 0 && l.indexOf("files=1") >= 0));
    });

    it("D3.5 suppression pendant REC : DIFFÉRÉE (aucun ACK), rejouée ensuite", async () => {
      const c = captureSvc({ recording: true });
      const applied = await c.svc.handle({ kind: "transfer_delete", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP });
      assert.strictEqual(applied, false, "non acquittée pendant REC");
      assert.strictEqual(c.native.calls.remove.length, 0, "AUCUNE suppression pendant REC");
      assert.strictEqual(c.svc.hasDeferredDeletes(), 1, "demande conservée");
      assert.ok(c.model.logs.some((l) => l.indexOf("TRANSFER_LOCAL_DELETE_DEFER") >= 0 && l.indexOf("reason=recording") >= 0));

      c.setRecording(false);
      const done = await c.svc.retryDeferredDeletes();
      assert.strictEqual(done, 1, "suppression rejouée après le Take");
      assert.strictEqual(c.svc.hasDeferredDeletes(), 0);
      assert.strictEqual(c.model.machine.state.deleted[CAP], true, "ACK seulement après confirmation");
    });

    it("D3.6 Take inconnu : différée puis ACK d'ÉCHEC après épuisement (jamais de faux succès)", async () => {
      const c = captureSvc({ paths: { listSegmentsFor: () => [], hasTake: () => false } });
      await c.svc.handle({ kind: "transfer_delete", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP });
      for (let i = 0; i < 8; i++) { await c.svc.retryDeferredDeletes(); }
      assert.strictEqual(c.svc.hasDeferredDeletes(), 0, "abandon après tentatives bornées");
      const ack = c.model.sent.filter((s) => s.kind === "transfer_delete_ack").pop();
      assert.ok(ack && ack.msg.state === "error", "ACK d'échec explicite");
      assert.strictEqual(c.model.machine.state.deleted[CAP], undefined, "le Master n'enregistre PAS de succès");
      assert.ok(c.model.logs.some((l) => l.indexOf("TRANSFER_LOCAL_DELETE_FAILED") >= 0));
    });

    it("D3.7 suppression déjà effectuée (fichier absent) = succès IDEMPOTENT", async () => {
      const c = captureSvc({ native: { removePlan: () => ({ removed: false, existed: false }) } });
      await c.svc.handle({ kind: "transfer_delete", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP });
      assert.strictEqual(c.model.machine.state.deleted[CAP], true, "« déjà absent » est un succès");
      assert.strictEqual(c.svc.hasDeferredDeletes(), 0);
    });

    it("D3.8 échec natif réel (présent mais non supprimé) : différé, jamais acquitté", async () => {
      const c = captureSvc({ native: { removePlan: () => ({ removed: false, existed: true }) } });
      await c.svc.handle({ kind: "transfer_delete", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP });
      assert.strictEqual(c.model.machine.state.deleted[CAP], undefined, "pas d'ACK sur échec réel");
      assert.strictEqual(c.svc.hasDeferredDeletes(), 1, "demande conservée");
      assert.ok(c.model.logs.some((l) => l.indexOf("TRANSFER_LOCAL_DELETE_RETRY") >= 0));
    });
  });

  /* ====================================================================== */
  /* D2 — service (message précis + backoff injecté)                        */
  /* ====================================================================== */

  describe("J14-C01 D2 — diagnostic & backoff (service)", function () {

    /* J14→J15 — CONTRAT MODIFIÉ.
     * J14 : `download_truncated` (et toute erreur) finissait en `error` terminal
     *       après MAX_ATTEMPTS.
     * J15 : `download_truncated` est POTENTIELLEMENT TRANSITOIRE (§4.3) → attente
     *       réseau NON terminale, cause réelle conservée dans `lastError`. La
     *       garantie de diagnostic (cause précise non masquée) est conservée. */
    it("D2.1 l'échec conserve la cause réelle (transitoire → waiting_network, cause précise)", async () => {
      const native = fakeNative();
      native.download = (o) => { native.calls.download.push(o); return Promise.reject(new Error("download_truncated: received=100 expected=5000")); };
      const m = mkModel("storage", STO1, () => 1000);
      const svc = S.createTransferService({
        model: m.machine, native, role: "storage", self: () => STO1,
        log: (l) => m.logs.push(l),
        take: () => ({ sessionId: SID, takeNumber: TAKE, storages: [] }),
        paths: { mediaRoot: () => "/m", listSegments: () => [], destFor: () => ({ dest: "/dest/f" }) }
      });
      await svc.handle(offerMsg(CAP));
      const f = m.machine.transferFor(CAP, STO1).files[0];
      assert.strictEqual(f.state, M.PH_WAITING_NETWORK, "J15 : troncature = attente réseau récupérable");
      assert.ok(f.error.indexOf("download_truncated") >= 0, "cause précise remontée : " + f.error);
      assert.ok(f.error.indexOf("download_failed") === 0, "préfixe filtrable conservé");
      assert.ok(m.sent.some((s) => s.kind === "transfer_waiting"), "attente publiée au Master");
      assert.ok(!m.sent.some((s) => s.kind === "transfer_result" && s.msg.state === "error"),
        "J15 : aucun résultat terminal sur cause transitoire");
    });

    it("D2.2 backoff injecté entre les tentatives (délai requis avant chaque reprise)", async () => {
      const native = fakeNative();
      native.download = (o) => { native.calls.download.push(o); return Promise.reject(new Error("boom")); };
      const waited = [];
      const m = mkModel("storage", STO1, () => 1000);
      const svc = S.createTransferService({
        model: m.machine, native, role: "storage", self: () => STO1,
        log: (l) => m.logs.push(l),
        take: () => ({ sessionId: SID, takeNumber: TAKE, storages: [] }),
        paths: { mediaRoot: () => "/m", listSegments: () => [], destFor: () => ({ dest: "/dest/f" }) },
        delay: (attempt) => { waited.push(attempt); return Promise.resolve(); }
      });
      await svc.handle(offerMsg(CAP));
      assert.strictEqual(native.calls.download.length, S.MAX_ATTEMPTS);
      assert.deepStrictEqual(waited, [1, 2], "un backoff avant les 2 reprises");
      /* J15 : séquence épuisée (cause par défaut = transitoire) → waiting_network. */
      assert.strictEqual(m.machine.transferFor(CAP, STO1).state, M.PH_WAITING_NETWORK);
    });
  });

  /* ====================================================================== */
  /* D1 — bootstrap (watchdog + réconciliation transport)                   */
  /* ====================================================================== */

  describe("J14-C01 D1 — watchdog & réconciliation (boot)", function () {

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

    function makeStart(self, view) {
      const st = { self, view: view || { sid: SID, takeNumber: TAKE, localStoppedTake: true, stopStates: {} } };
      return {
        st,
        _svc: {
          onView() {}, view: () => st.view, machine: () => ({ view: () => st.view }),
          selfDid: () => st.self, isRecording: () => false
        }
      };
    }

    function makeBoot(over) {
      over = over || {};
      const logs = [];
      const ws = makeWs();
      const native = fakeNative(over.native);
      const start = makeStart(over.self || CAP, over.view);
      let clock = 1000;
      const boot = Boot.createTransferBoot(Object.assign({
        cfg: over.cfg || { enabledSkills: ["capture"] },
        ws: () => ws._ws,
        startService: () => start._svc,
        sessionStore: () => ({ get: (sid) => Promise.resolve({ sessionId: sid, takes: Array.isArray(over.takes) ? over.takes : ((over.takes && over.takes[sid]) || []) }) }),
        storageNative: () => ({ defaultPath: () => "file:///data/app/", systemPath: (u) => String(u || "").replace(/^file:\/\//, "").replace(/\/$/, "") }),
        nativeApi: () => native,
        transferModel: () => M,
        transferService: () => S,
        takeModel: () => TM,
        now: () => clock,
        setInterval: () => null, clearInterval: () => {},
        watchdogMs: 1, stuckMs: over.stuckMs || 1000, stuckMaxReoffers: over.maxReoffers || 2,
        reidentifyThrottleMs: 0,
        log: (l) => logs.push(l)
      }, over.deps || {}));
      return { boot, ws, native, logs, setClock: (v) => { clock = v; }, getClock: () => clock };
    }

    /* J14→J15 — CONTRAT MODIFIÉ.
     *
     * J14 : le watchdog Master, après `stuckMaxReoffers` re-offres, marquait le
     *       transfert terminal `error` (`TRANSFER_STUCK_FINAL`), aggravant le
     *       diagnostic (un Storage simplement lent était déclaré en échec).
     *
     * J15 : après la séquence bornée de re-offres, le Master GÈLE la séquence
     *       (`TRANSFER_RECONCILE_WAIT`) et passe en `waiting_network` NON
     *       terminal. Aucune tempête de re-offres : le compteur gelé n'est purgé
     *       qu'à la réconciliation cyclique (120 s), et une progression reçue
     *       réarme la séquence.
     *
     * Conservés : bornage strict du nombre de re-offres, idempotence, convergence
     *            au retour du Storage, AUCUNE suppression Capture prématurée. */
    it("D1.7 Master : transfert bloqué ⇒ re-offres bornées puis waiting_network gelé (J15)", async () => {
      const takes = {}; takes[SID] = [{ takeNumber: TAKE, storages: [STO1], settings: { transferAuto: true, deleteLocalAfterVerifiedReplication: true } }];
      const b = makeBoot({ cfg: { enabledSkills: ["controller"] }, takes, self: MST });
      b.boot.bind();
      await b.boot._onTransferMessage({ kind: "media_ready", sessionId: SID, takeNumber: TAKE, deviceId: CAP, host: "h", port: 1, files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }] });
      const offersBefore = b.ws.out.sendTo.filter((m) => m.kind === "transfer_offer").length;
      assert.ok(offersBefore >= 1, "offre initiale");

      b.setClock(1000 + 1000);      /* stale >= stuckMs */
      b.boot._watchdogTick();
      assert.ok(b.ws.out.sendTo.filter((m) => m.kind === "transfer_offer").length > offersBefore, "re-offre déclenchée");
      assert.ok(b.logs.some((l) => l.indexOf("TRANSFER_STUCK_REOFFER") >= 0));

      /* Dépassement de la séquence bornée : gel + attente, jamais `error`. */
      b.setClock(1000 + 10000);
      b.boot._watchdogTick();
      b.boot._watchdogTick();
      assert.ok(b.logs.some((l) => l.indexOf("TRANSFER_RECONCILE_WAIT") >= 0),
        "J15 : séquence gelée au lieu d'un échec terminal");
      assert.ok(!b.logs.some((l) => l.indexOf("TRANSFER_STUCK_FINAL") >= 0),
        "J15 : plus de passage terminal error sur simple silence");
      assert.strictEqual(b.boot._machine().transferFor(CAP, STO1).state, M.PH_WAITING_NETWORK,
        "J15 : attente réseau (non terminal), plus de transferring infini");

      /* Aucune tempête : les ticks suivants ne relancent plus d'offres tant que
       * la séquence est gelée. */
      const offersAtFreeze = b.ws.out.sendTo.filter((m) => m.kind === "transfer_offer").length;
      b.setClock(1000 + 20000);
      b.boot._watchdogTick();
      assert.strictEqual(b.ws.out.sendTo.filter((m) => m.kind === "transfer_offer").length, offersAtFreeze,
        "un seul cycle actif par transfert : pas de re-offres en rafale");

      /* Toutes destinations `waiting_network` (aucune `done`/`error`) : la
       * suppression Capture est INTERDITE (aucune preuve de réplication). */
      assert.strictEqual(b.boot._machine().allDestinationsDone(CAP), false);
      assert.ok(!b.ws.out.sendTo.some((m) => m.kind === "transfer_delete"),
        "aucune suppression prématurée pendant une attente réseau");
    });

    it("D1.7b J15 : le retour du Storage lève l'attente et reprend (pas de restart de la séquence)", async () => {
      const takes = {}; takes[SID] = [{ takeNumber: TAKE, storages: [STO1], settings: { transferAuto: true, deleteLocalAfterVerifiedReplication: true } }];
      const b = makeBoot({ cfg: { enabledSkills: ["controller"] }, takes, self: MST });
      b.boot.bind();
      await b.boot._onTransferMessage({ kind: "media_ready", sessionId: SID, takeNumber: TAKE, deviceId: CAP, host: "h", port: 1, files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }] });
      b.setClock(1000 + 1000); b.boot._watchdogTick();
      b.setClock(1000 + 10000); b.boot._watchdogTick(); b.boot._watchdogTick();
      assert.strictEqual(b.boot._machine().transferFor(CAP, STO1).state, M.PH_WAITING_NETWORK);

      /* Le Storage reprend : une progression arrive. */
      b.setClock(1000 + 30000);
      await b.boot._onTransferMessage({ kind: "transfer_progress", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, storageDeviceId: STO1, rel: "seg00.mp4", received: 500, total: 1000 });
      assert.strictEqual(b.boot._machine().transferFor(CAP, STO1).state, M.PH_TRANSFERRING,
        "la reprise lève l'attente");

      /* Puis le transfert converge vers `done`. */
      await b.boot._onTransferMessage({ kind: "transfer_result", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, storageDeviceId: STO1, rel: "seg00.mp4", state: "done", bytes: 1000, sha256Destination: "aaaa" });
      assert.strictEqual(b.boot._machine().transferFor(CAP, STO1).state, M.PH_DONE);
      assert.strictEqual(b.boot._machine().allDestinationsDone(CAP), true);
      const deletions = b.ws.out.sendTo.filter((m) => m.kind === "transfer_delete");
      assert.strictEqual(deletions.length, 1, "la suppression Capture n'est ordonnée QU'APRÈS réplication vérifiée");
    });

    it("D1.8 Master : une progression reçue remet le backoff à zéro", async () => {
      const takes = {}; takes[SID] = [{ takeNumber: TAKE, storages: [STO1], settings: { transferAuto: true } }];
      const b = makeBoot({ cfg: { enabledSkills: ["controller"] }, takes, self: MST });
      b.boot.bind();
      await b.boot._onTransferMessage({ kind: "media_ready", sessionId: SID, takeNumber: TAKE, deviceId: CAP, host: "h", port: 1, files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }] });
      b.setClock(1000 + 1000);
      b.boot._watchdogTick();
      assert.ok(b.logs.some((l) => l.indexOf("TRANSFER_STUCK_REOFFER") >= 0));

      /* Le Storage reprend : une progression arrive après la relance. */
      b.setClock(1000 + 2000);
      await b.boot._onTransferMessage({ kind: "transfer_progress", sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, storageDeviceId: STO1, rel: "seg00.mp4", received: 500, total: 1000 });
      b.setClock(1000 + 2600);
      const before = b.logs.filter((l) => l.indexOf("TRANSFER_STUCK_REOFFER") >= 0).length;
      b.boot._watchdogTick();
      const after = b.logs.filter((l) => l.indexOf("TRANSFER_STUCK_REOFFER") >= 0).length;
      assert.strictEqual(after, before, "pas de relance tant que la progression avance");
    });

    it("D1.9 le watchdog NE touche PAS aux transferts pendant un REC (pause légitime)", async () => {
      const takes = {}; takes[SID] = [{ takeNumber: TAKE, storages: [STO1], settings: { transferAuto: true } }];
      let rec = true;
      let nclock = 100000;
      const r = Boot.createTransferBoot({
        cfg: { enabledSkills: ["controller"] },
        ws: () => ({ broadcastTargeted() {}, sendToDevice() {}, setTransferBridge() {} }),
        startService: () => ({ onView() {}, view: () => ({ sid: SID, takeNumber: TAKE }), selfDid: () => MST, isRecording: () => rec }),
        sessionStore: () => ({ get: (sid) => Promise.resolve({ sessionId: sid, takes: takes[sid] || [] }) }),
        storageNative: () => ({ defaultPath: () => "file:///data/app/", systemPath: (u) => String(u || "").replace(/^file:\/\//, "").replace(/\/$/, "") }),
        nativeApi: () => fakeNative(),
        transferModel: () => M, transferService: () => S, takeModel: () => TM,
        now: () => nclock, setInterval: () => null, clearInterval: () => {},
        watchdogMs: 1, stuckMs: 1000, stuckMaxReoffers: 2, reidentifyThrottleMs: 0,
        log: () => {}
      });
      r.bind();
      await r._onTransferMessage({ kind: "media_ready", sessionId: SID, takeNumber: TAKE, deviceId: CAP, host: "h", port: 1, files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }] });
      const acted = r._watchdogTick();
      assert.strictEqual(acted, 0, "aucune action pendant REC");
      assert.strictEqual(r._machine().transferFor(CAP, STO1).state, M.PH_PENDING, "transfert non terminal conservé (pas un échec)");

      rec = false;
      nclock += 5000;
      const acted2 = r._watchdogTick();
      assert.ok(acted2 >= 1, "le watchdog reprend après le Take");
    });

    it("D1.10 onPeerIdentified : le Master re-offre, le Storage re-diffuse", async () => {
      const takes = {}; takes[SID] = [{ takeNumber: TAKE, storages: [STO1], settings: { transferAuto: true } }];
      const b = makeBoot({ cfg: { enabledSkills: ["controller"] }, takes, self: MST });
      b.boot.bind();
      await b.boot._onTransferMessage({ kind: "media_ready", sessionId: SID, takeNumber: TAKE, deviceId: CAP, host: "h", port: 1, files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }] });
      const before = b.ws.out.sendTo.filter((m) => m.kind === "transfer_offer").length;
      b.boot._onPeerIdentified({ from: CAP });
      assert.ok(b.ws.out.sendTo.filter((m) => m.kind === "transfer_offer").length > before, "Master re-offre à la ré-identification");

      /* Storage : re-diffusion d'une issue terminale. */
      const s = makeBoot({ cfg: { enabledSkills: ["storage"] }, takes, self: STO1 });
      s.boot.bind();
      await s.boot._onTransferMessage(offerMsg(CAP));
      const resBefore = s.ws.out.broadcast.filter((m) => m.kind === "transfer_result").length;
      s.boot._onPeerIdentified({ from: CAP });
      assert.ok(s.ws.out.broadcast.filter((m) => m.kind === "transfer_result").length > resBefore, "Storage re-diffuse son issue");
    });

    it("D1.11 onTransportReconnect : le Storage re-diffuse ses issues terminales", async () => {
      const takes = {}; takes[SID] = [{ takeNumber: TAKE, storages: [STO1], settings: { transferAuto: true } }];
      const s = makeBoot({ cfg: { enabledSkills: ["storage"] }, takes, self: STO1 });
      s.boot.bind();
      await s.boot._onTransferMessage(offerMsg(CAP));
      const before = s.ws.out.broadcast.filter((m) => m.kind === "transfer_result").length;
      s.boot._onTransportReconnect({ endpoint: "10.0.0.9:8080" });
      assert.ok(s.ws.out.broadcast.filter((m) => m.kind === "transfer_result").length > before);
    });
  });

  /* ====================================================================== */
  /* D2 — garde statique du correctif Java (pas de harnais JVM)              */
  /* ====================================================================== */

  describe("J14-C01 D2 — correctif serveur & natif (garde statique)", function () {
    const fs = require("fs");

    it("D2.3 NanoHTTPD : le corps est borné par Content-Length (long), plus par available() (int)", async () => {
      const p = path.resolve(__dirname, "../local-plugins/cordova-plugin-multicam-httpd/src/android/NanoHTTPD.java");
      const src = fs.readFileSync(p, "utf8");
      assert.ok(src.indexOf("int pending = data.available()") < 0, "borne 32 bits supprimée");
      assert.ok(src.indexOf("long pending") >= 0, "compteur 64 bits");
      assert.ok(src.indexOf('header.getProperty( "Content-Length" )') >= 0, "lecture de l'en-tête déclaré");
      assert.ok(src.indexOf("theBufferSize") >= 0, "streaming par blocs préservé");
    });

    it("D2.4 MultiCamTransfer : troncature détectée + `existed` pour l'idempotence de suppression", async () => {
      const p = path.resolve(__dirname, "../local-plugins/cordova-plugin-multicam-transfer/src/android/MultiCamTransfer.java");
      const src = fs.readFileSync(p, "utf8");
      assert.ok(src.indexOf('cb.error("download_truncated') >= 0, "échec explicite sur corps tronqué");
      assert.ok(src.indexOf('res.put("existed", existed)') >= 0, "verdict d'existence pour la suppression idempotente");
    });
  });
};
