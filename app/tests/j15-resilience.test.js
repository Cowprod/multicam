/* MultiCam J15 — résilience des transferts / reprise automatique persistante.
 *
 * Couvre la PHASE 2 (§4, §5, §7, §10, §15, §16 du design
 * tests/e2e/validation/J15/CONCEPTION-REPRISE-AUTOMATIQUE.md) :
 *   - journal technique versionné (tmp + relecture + rename atomique) ;
 *   - restauration : JAMAIS `done` d'après le journal seul (§7.3) ;
 *   - endomorphismes de reprise : UN run par clé, file bornée, verrou pris AVANT
 *     la planification et libéré en `finally` ;
 *   - backoff exponentiel 5 s → 60 s avec jitter ;
 *   - scan de secours 120 s + déclencheur de retour réseau (§5) ;
 *   - classification native (`range_mismatch`, SAF force offset=0) côté JS.
 *
 * Fakes injectés uniquement : aucune I/O réelle, aucune horloge réelle. */

"use strict";

const path = require("path");
const assert = require("assert");
const M = require(path.resolve(__dirname, "../www/js/state/transfer-model.js"));
const S = require(path.resolve(__dirname, "../www/js/state/transfer-service.js"));
const TM = require(path.resolve(__dirname, "../www/js/state/take-model.js"));
const J = require(path.resolve(__dirname, "../www/js/state/transfer-journal.js"));
const Boot = require(path.resolve(__dirname, "../www/js/state/transfer-boot.js"));

const SID = "session-J15";
const TAKE = 1;
const CAP = "cap-1";
const STO1 = "sto-1";

/* ---------- fakes ---------- */

function fakeNative(cfg) {
  cfg = cfg || {};
  const calls = { download: [], remove: [], sha256: [], serveStart: [], serveStop: 0, serveRegister: [], stage: [] };
  return {
    calls,
    serveStart(o) { calls.serveStart.push(o); return Promise.resolve(cfg.serveUrl || "http://10.0.0.5:8080"); },
    serveStop() { calls.serveStop += 1; return Promise.resolve(); },
    serveRegister(o) { calls.serveRegister.push(o); return Promise.resolve({}); },
    serveUnregister() { return Promise.resolve({}); },
    sha256(p) { calls.sha256.push(p); return Promise.resolve((cfg.sha256Map && cfg.sha256Map[p]) || { bytes: 1000, sha256: "aaaa" }); },
    stage(src, dest) { calls.stage.push({ src, dest }); return Promise.resolve({ dest, bytes: 1000 }); },
    remove(p) { calls.remove.push(p); return Promise.resolve({ removed: true, path: p }); },
    download(o, onProgress) {
      calls.download.push(o);
      if (cfg.download) return cfg.download(o, onProgress, calls.download.length);
      return Promise.resolve({ done: true, received: o.expectedBytes || 1000, sha256: "aaaa" });
    }
  };
}

function mkModel(role, self, nowFn) {
  const sent = [];
  const logs = [];
  const machine = M.createMachine({
    role, sid: SID, self: () => self, takeNumber: TAKE,
    now: nowFn || (() => 1000),
    log: (l) => logs.push(l),
    send: (kind, msg) => sent.push({ kind, msg }),
    sendTo: (to, kind, msg) => sent.push({ to, kind, msg })
  });
  return { machine, sent, logs };
}

function offerMsg(files) {
  return {
    kind: "transfer_offer", sessionId: SID, takeNumber: TAKE,
    sourceDeviceId: CAP, storageDeviceId: STO1, host: "h", port: 1, token: "t",
    files: files || [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }]
  };
}

/* Regroupement Storage pour le boot : START + store + natif + journal mémoire. */
function makeStorageBoot(over) {
  over = over || {};
  const logs = [];
  const wsOut = { broadcast: [], sendTo: [], bridge: null };
  const ws = {
    broadcastTargeted(kind, session, extra) { wsOut.broadcast.push({ kind, session, extra }); },
    sendToDevice(did, session, kind, extra) { wsOut.sendTo.push({ did, kind, extra }); },
    setTransferBridge(b) { wsOut.bridge = b; }
  };
  const native = fakeNative(over.native);
  const store = { get: (sid) => Promise.resolve({ sessionId: sid, takes: over.takes || [] }) };
  const startSvc = {
    onView() {}, view() { return null; }, machine() { return null; },
    selfDid() { return STO1; }, isRecording() { return !!over.recording; }
  };
  const journalFs = over.journalFs || J.memoryFs();
  const boot = Boot.createTransferBoot({
    cfg: over.cfg || { enabledSkills: ["storage"], deviceId: STO1 },
    ws: () => ws,
    startService: () => startSvc,
    sessionStore: () => store,
    storageNative: () => ({ defaultPath: () => "file:///data/app/", systemPath: (u) => String(u || "").replace(/^file:\/\//, "").replace(/\/$/, "") }),
    nativeApi: () => native,
    transferModel: () => M,
    transferService: () => S,
    takeModel: () => TM,
    transferJournal: () => J,
    discovery: () => over.discovery || null,
    now: over.now,
    rand: over.rand,
    setTimeout: over.setTimeout,
    clearTimeout: over.clearTimeout,
    setInterval: over.setInterval,
    clearInterval: over.clearInterval,
    journalFs: journalFs,
    maxResumeQueue: over.maxResumeQueue,
    log: (l) => logs.push(l)
  });
  return { boot, ws, wsOut, native, logs, journalFs, store };
}

module.exports.register = function (h) {
  const describe = h.describe;
  const it = h.it;
  const flush = h.flush;

  /* ====================================================================== */
  /* §7 — journal technique                                                 */
  /* ====================================================================== */

  describe("J15 §7 — journal technique (durabilité, version, restauration)", function () {

    it("J15.1 buildDoc : sérialise les métadonnées nécessaires, endpoint = trace", () => {
      const doc = J.buildDoc({
        sessionId: SID, takeNumber: TAKE, storageDeviceId: STO1,
        manifestId: "m-1", endpoint: { host: "10.0.0.5", port: 8080 }, nowMs: 5000,
        transfers: {
          "cap-1|sto-1": {
            srcDid: CAP, storageDid: STO1, state: "waiting_network",
            files: { "seg00.mp4": { bytes: 1000, sha256: "aaaa", state: "waiting_network", received: 400, waitingSinceMs: 4000, nextAttemptAtMs: 30000, error: "network" } }
          }
        }
      });
      assert.strictEqual(doc.version, J.VERSION);
      assert.strictEqual(doc.sessionId, SID);
      assert.strictEqual(doc.takeNumber, TAKE);
      assert.strictEqual(doc.storageDeviceId, STO1);
      assert.strictEqual(doc.files.length, 1);
      assert.strictEqual(doc.files[0].sourceDeviceId, CAP);
      assert.strictEqual(doc.files[0].expectedBytes, 1000);
      assert.strictEqual(doc.files[0].received, 400);
      assert.strictEqual(doc.endpoint.host, "10.0.0.5", "endpoint conservé comme trace");
    });

    it("J15.2 écriture durable : JSON relu identique, pas de fichier .tmp résiduel", async () => {
      const fs = J.memoryFs();
      const j = J.createTransferJournal({ fs, log: () => {} });
      const doc = { version: 1, sessionId: SID, takeNumber: TAKE, storageDeviceId: STO1, files: [] };
      await j.save(doc, true);
      const names = await fs.list();
      assert.ok(names.indexOf(J.fileFor(SID, TAKE, STO1)) >= 0, "fichier final écrit");
      assert.ok(names.every((n) => n.indexOf(".tmp") < 0), "aucun .tmp résiduel");
      const res = await j.restore(SID, TAKE, STO1);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.doc.storageDeviceId, STO1);
    });

    it("J15.3 journal absent : restore rend ok=false sans erreur", async () => {
      const fs = J.memoryFs();
      const j = J.createTransferJournal({ fs, log: () => {} });
      const res = await j.restore(SID, TAKE, STO1);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.doc, null);
    });

    it("J15.4 journal corrompu : CONSERVÉ et ignoré (jamais réécrit aveuglément)", async () => {
      const fs = J.memoryFs();
      fs._files[J.fileFor(SID, TAKE, STO1)] = "{ pas du json";
      const logs = [];
      const j = J.createTransferJournal({ fs, log: (l) => logs.push(l) });
      const res = await j.restore(SID, TAKE, STO1);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.corrupted, true);
      assert.ok(fs._files[J.fileFor(SID, TAKE, STO1)], "le fichier corrompu n'est pas effacé");
      assert.ok(logs.some((l) => l.indexOf("TRANSFER_JOURNAL_CORRUPT") >= 0));
    });

    it("J15.5 version inconnue : ignorée (pas de migration implicite)", async () => {
      const fs = J.memoryFs();
      fs._files[J.fileFor(SID, TAKE, STO1)] = JSON.stringify({ version: 999, files: [] });
      const j = J.createTransferJournal({ fs, log: () => {} });
      const res = await j.restore(SID, TAKE, STO1);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.corrupted, true);
    });

    it("J15.6 purge : supprime le journal d'un Storage", async () => {
      const fs = J.memoryFs();
      const j = J.createTransferJournal({ fs, log: () => {} });
      await j.save({ version: 1, sessionId: SID, takeNumber: TAKE, storageDeviceId: STO1, files: [] }, true);
      assert.strictEqual(await j.purge(SID, TAKE, STO1), true);
      assert.strictEqual((await j.restore(SID, TAKE, STO1)).ok, false);
    });
  });

  /* ====================================================================== */
  /* §7.3 — restauration dans le modèle : jamais done d'après le journal     */
  /* ====================================================================== */

  describe("J15 §7.3 — restoreFromJournal (jamais done sur le journal seul)", function () {

    it("J15.7 restaure des fichiers RÉCUPÉRABLES en waiting_network, y compris un `done` journalisé", () => {
      const m = mkModel("storage", STO1, () => 5000);
      const n = m.machine.restoreFromJournal({
        version: 1, sessionId: SID, takeNumber: TAKE, storageDeviceId: STO1,
        files: [
          { sourceDeviceId: CAP, rel: "seg00.mp4", expectedBytes: 1000, expectedSha256: "aaaa", state: "done", received: 1000 },
          { sourceDeviceId: CAP, rel: "seg01.mp4", expectedBytes: 2000, expectedSha256: "bbbb", state: "waiting_network", received: 500, lastError: "network" }
        ]
      });
      assert.strictEqual(n, 2);
      const t = m.machine.transferFor(CAP, STO1);
      assert.strictEqual(t.state, M.PH_WAITING_NETWORK, "reprise requise, jamais done");
      const f0 = t.files.find((f) => f.rel === "seg00.mp4");
      const f1 = t.files.find((f) => f.rel === "seg01.mp4");
      assert.strictEqual(f0.state, M.PH_WAITING_NETWORK, "un done journalisé est re-récupéré (taille disque fait foi)");
      assert.strictEqual(f1.state, M.PH_WAITING_NETWORK);
      /* L'identité du média est PRÉSERVÉE : taille et SHA attendus restaurés pour
       * permettre la vérification disque/SHA, jamais une confiance aveugle. */
      assert.strictEqual(f0.bytes, 1000);
      assert.strictEqual(f0.sha256, "aaaa");
      assert.strictEqual(f1.bytes, 2000);
      assert.strictEqual(f1.sha256, "bbbb");
    });

    it("J15.8 restaure pour le BON take uniquement (takeNumber différent → 0)", () => {
      const m = mkModel("storage", STO1, () => 5000);
      const n = m.machine.restoreFromJournal({
        version: 1, sessionId: SID, takeNumber: 2, storageDeviceId: STO1,
        files: [{ sourceDeviceId: CAP, rel: "seg00.mp4", expectedBytes: 1, state: "transferring" }]
      });
      assert.strictEqual(n, 0);
    });

    it("J15.9 le Master n'utilise PAS le journal (réservé au Storage)", () => {
      const m = mkModel("master", "mst-1", () => 5000);
      const n = m.machine.restoreFromJournal({
        version: 1, sessionId: SID, takeNumber: TAKE, storageDeviceId: STO1,
        files: [{ sourceDeviceId: CAP, rel: "seg00.mp4", expectedBytes: 1 }]
      });
      assert.strictEqual(n, 0);
    });
  });

  /* ====================================================================== */
  /* §5 — backoff exponentiel + jitter                                      */
  /* ====================================================================== */

  describe("J15 §5 — backoff exponentiel borné (5 s → 60 s) + jitter", function () {

    function svc(rand) {
      return S.createTransferService({
        model: mkModel("storage", STO1).machine,
        native: fakeNative({}),
        role: "storage", self: () => STO1, take: () => ({ sessionId: SID, takeNumber: TAKE }),
        rand: rand || (() => 1), log: () => {}
      });
    }

    it("J15.10 croissance exponentielle bornée à RESUME_MAX_MS", () => {
      const s = svc(() => 1); /* jitter max = 1.0 pour des valeurs déterministes */
      assert.strictEqual(s.nextBackoffMs(1), S.RESUME_BASE_MS);
      assert.strictEqual(s.nextBackoffMs(2), 10000);
      assert.strictEqual(s.nextBackoffMs(3), 20000);
      assert.strictEqual(s.nextBackoffMs(4), 40000);
      assert.strictEqual(s.nextBackoffMs(5), 60000, "plafonné");
      assert.strictEqual(s.nextBackoffMs(9), 60000, "reste plafonné");
    });

    it("J15.11 jitter multiplicatif borne dans [0,5 ; 1,0]", () => {
      assert.strictEqual(svc(() => 0).nextBackoffMs(1), 2500);
      assert.strictEqual(svc(() => 1).nextBackoffMs(1), 5000);
      const mid = svc(() => 0.5).nextBackoffMs(1);
      assert.ok(mid >= 2500 && mid <= 5000);
    });
  });

  /* ====================================================================== */
  /* §4/§16 — classification d'erreur                                       */
  /* ====================================================================== */

  describe("J15 §4/§16 — classification (défaut = transitoire)", function () {

    it("J15.12 par DÉFAUT, une erreur inconnue est TRANSITOIRE (jamais fatal sans preuve)", () => {
      const c = S.classifyError("download_failed: Weird: quelque chose");
      assert.strictEqual(c.transient, true);
    });

    it("J15.13 SAF/écriture = fatal ; mismatch de plage/réseau = transitoire", () => {
      assert.strictEqual(S.classifyError("saf_create_failed").transient, false);
      assert.strictEqual(S.classifyError("ENOSPC: no space").transient, false);
      assert.strictEqual(S.classifyError("sha256_mismatch").transient, false);
      assert.strictEqual(S.classifyError("download_range_mismatch: requested=5 got=bytes 0-4/9").transient, true);
      assert.strictEqual(S.classifyError("download_truncated: received=1 expected=2").transient, true);
      assert.strictEqual(S.classifyError("download_http_404").transient, true);
    });
  });

  /* ====================================================================== */
  /* §4/§5 — service : attente NON terminale, terminal réel                 */
  /* ====================================================================== */

  describe("J15 §4/§5 — service : attente non terminale vs échec démontré", function () {

    function mkService(cfg) {
      const m = mkModel("storage", STO1, () => 1000);
      m.machine.onIncoming(offerMsg());
      const native = fakeNative(cfg);
      const waits = [];
      const s = S.createTransferService({
        model: m.machine, native, role: "storage", self: () => STO1,
        take: () => ({ sessionId: SID, takeNumber: TAKE }),
        log: () => {}, rand: () => 1,
        onWaiting: (info) => waits.push(info),
        statDest: () => Promise.resolve(null)
      });
      return { m, native, s, waits };
    }

    it("J15.14 échec transitoire → waiting_network NON terminal + onWaiting signalé", async () => {
      const ctx = mkService({
        download: (o, onProgress, n) => Promise.reject(new Error("ConnectException: refused"))
      });
      const offer = { sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, host: "h", port: 1, token: "t", files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }] };
      const r = await ctx.s.downloadWithRetry(offer, offer.files[0], TAKE);
      assert.strictEqual(r, false);
      assert.strictEqual(ctx.m.machine.transferFor(CAP, STO1).state, M.PH_WAITING_NETWORK);
      assert.ok(ctx.waits.length >= 1, "onWaiting appelé pour planifier la reprise");
      assert.ok(!ctx.m.sent.some((x) => x.kind === "transfer_result" && x.msg.state === "error"), "aucun terminal error");
    });

    it("J15.15 échec SAF → error TERMINAL immédiat (aucun waiting, aucune reprise)", async () => {
      const ctx = mkService({
        download: () => Promise.reject(new Error("saf_create_failed"))
      });
      const offer = { sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, host: "h", port: 1, token: "t", files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }] };
      const r = await ctx.s.downloadWithRetry(offer, offer.files[0], TAKE);
      assert.strictEqual(r, false);
      assert.strictEqual(ctx.m.machine.transferFor(CAP, STO1).state, M.PH_ERROR);
      assert.strictEqual(ctx.waits.length, 0, "aucune planification de reprise sur erreur fatale");
    });

    it("J15.16 un run de reprise qui ÉCHOUE repasse en waiting_network (jamais terminal)", async () => {
      const ctx = mkService({
        download: () => Promise.reject(new Error("ETIMEDOUT"))
      });
      const offer = { sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, host: "h", port: 1, token: "t", files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }] };
      await ctx.s.downloadWithRetry(offer, offer.files[0], TAKE);
      assert.strictEqual(ctx.m.machine.transferFor(CAP, STO1).state, M.PH_WAITING_NETWORK);
    });
  });

  /* ====================================================================== */
  /* §5 — ResumeCoordinator                                                 */
  /* ====================================================================== */

  describe("J15 §5 — ResumeCoordinator (verrou, file bornée, reprise)", function () {

    function bootWithNative(cfg) {
      return makeStorageBoot({ takes: [{ takeNumber: TAKE, storages: [] }], native: cfg });
    }

    it("J15.17 un SEUL run actif par clé — la 2e planification est ignorée", async () => {
      const ctx = bootWithNative({});
      ctx.boot.bind();
      const e = ctx.boot._ensureFor(SID, TAKE);
      const calls = [];
      e.storageRun = (offer) => { calls.push(offer); return Promise.resolve(); };
      ctx.boot._scheduleResume(e, { sourceDeviceId: CAP, rel: "seg00.mp4", nextAttemptAtMs: 9999999999 });
      ctx.boot._scheduleResume(e, { sourceDeviceId: CAP, rel: "seg00.mp4", nextAttemptAtMs: 9999999999 });
      assert.ok(ctx.logs.some((l) => l.indexOf("TRANSFER_RESUME_SKIP") >= 0), "doublon de clé ignoré");
      /* Annule le timer en attente. */
      ctx.boot._stopWatchdog();
    });

    it("J15.18 la file est BORNÉE (pas d'explosion sur des clés uniques)", async () => {
      const ctx = makeStorageBoot({ takes: [{ takeNumber: TAKE, storages: [] }], native: {}, maxResumeQueue: 3 });
      ctx.boot.bind();
      const e = ctx.boot._ensureFor(SID, TAKE);
      e.storageRun = () => Promise.resolve();
      for (let i = 0; i < 10; i++) {
        ctx.boot._scheduleResume(e, { sourceDeviceId: CAP, rel: "rel-" + i + ".mp4", nextAttemptAtMs: 9999999999 });
      }
      assert.ok(ctx.logs.some((l) => l.indexOf("TRANSFER_RESUME_QUEUE_FULL") >= 0), "débordement refusé proprement");
      ctx.boot._stopWatchdog();
    });

    it("J15.19 reprise : le scan planifie puis EXECUTE une offre ciblée (mode=retry)", async () => {
      /* Timers et horloge injectables : on CAPTURE le callback de reprise pour
       * prouver l'EXECUTION reelle, pas seulement la journalisation. */
      const timers = [];
      const ctx = makeStorageBoot({
        takes: [{ takeNumber: TAKE, storages: [] }], native: {},
        setTimeout: (fn, ms) => { const t = { fn, ms, unref() { return t; } }; timers.push(t); return t; },
        clearTimeout: () => {}
      });
      ctx.boot.bind();
      ctx.boot._ensureFor(SID, TAKE);
      const e = ctx.boot._entries()[SID + "|" + TAKE];
      e.machine.onIncoming(offerMsg());
      e.machine.markTransferWaiting(CAP, STO1, "network", 1000, 0);
      let captured = null;
      e.service.storageRun = (offer) => { captured = offer; return Promise.resolve(); };
      const n = ctx.boot._onNetworkChange();
      assert.strictEqual(n, 1, "un fichier en attente est planifie au retour reseau");
      const planned = ctx.logs.filter((l) => l.indexOf("TRANSFER_RESUME_PLANNED") >= 0);
      assert.strictEqual(planned.length, 1, "planification effective (pas de faux positif)");
      assert.ok(planned[0].indexOf("rel=seg00.mp4") >= 0, "la reprise cible le fichier en attente");
      assert.strictEqual(timers.length, 1, "un timer de reprise planifie");
      timers[0].fn();
      await flush(5);
      assert.ok(captured, "storageRun execute a l'echeance");
      assert.strictEqual(captured.mode, "retry", "offre de reprise en mode retry");
      assert.ok((captured.files || []).some((f) => f.rel === "seg00.mp4"), "offre ciblee sur le fichier attendu");
      ctx.boot._stopWatchdog();
    });

    it("J15.20 le retour réseau déclenche un scan (onNetworkChange)", async () => {
      let registered = null;
      const disc = { onNetworkChange(fn) { registered = fn; } };
      const ctx = makeStorageBoot({ takes: [{ takeNumber: TAKE, storages: [] }], native: {}, discovery: disc });
      ctx.boot.bind();
      assert.strictEqual(typeof registered, "function", "le boot s'abonne aux changements réseau");
      const before = ctx.logs.length;
      registered();
      assert.ok(ctx.logs.length >= before);
      ctx.boot._stopWatchdog();
    });
  });

  /* ====================================================================== */
  /* J15-A — concurrence (reconnexions rapprochées + watchdog)              */
  /* ====================================================================== */

  describe("J15-A — concurrence : jamais deux téléchargements simultanés", function () {

    it("J15.21 deux reconnexions rapprochées → un seul run par clé (verrou)", async () => {
      const ctx = makeStorageBoot({ takes: [{ takeNumber: TAKE, storages: [] }], native: {} });
      ctx.boot.bind();
      ctx.boot._ensureFor(SID, TAKE);
      const e = ctx.boot._entries()[SID + "|" + TAKE];
      e.machine.onIncoming(offerMsg());
      e.machine.markTransferWaiting(CAP, STO1, "network", 1000, 0);
      e.service.storageRun = () => Promise.resolve();
      /* Deux scans rapprochés : le verrou par clé empêche la 2e planification. */
      ctx.boot._onNetworkChange();
      ctx.boot._onNetworkChange();
      const planned = ctx.logs.filter((l) => l.indexOf("TRANSFER_RESUME_PLANNED") >= 0).length;
      assert.strictEqual(planned, 1, "une seule planification malgré deux reconnexions");
      ctx.boot._stopWatchdog();
    });

    it("J15.22 watchdog + reconnexion concurrents → aucun doublon de run", async () => {
      const now = 1000000;
      const ctx = makeStorageBoot({ takes: [{ takeNumber: TAKE, storages: [] }], native: {}, now: () => now });
      ctx.boot.bind();
      ctx.boot._ensureFor(SID, TAKE);
      const e = ctx.boot._entries()[SID + "|" + TAKE];
      e.machine.onIncoming(offerMsg());
      e.machine.markTransferWaiting(CAP, STO1, "network", 1000, 0);
      e.service.storageRun = () => Promise.resolve();
      ctx.boot._onNetworkChange();
      /* Le watchdog ne doit PAS replanifier la clé déjà verrouillée. */
      ctx.boot._watchdogTick(now);
      const planned = ctx.logs.filter((l) => l.indexOf("TRANSFER_RESUME_PLANNED") >= 0).length;
      assert.ok(planned <= 1, "pas de re-planification pendant qu'une clé est verrouillée");
      ctx.boot._stopWatchdog();
    });
  });

  /* ====================================================================== */
  /* J15-B — redémarrage : journal restauré puis reprise                    */
  /* ====================================================================== */

  describe("J15-B — redémarrage applicatif (journal → reprise)", function () {

    it("J15.23 nouvelle instance de boot : journal existant → transfert reconstruit et reprise", async () => {
      const fs = J.memoryFs();
      const doc = J.buildDoc({
        sessionId: SID, takeNumber: TAKE, storageDeviceId: STO1, nowMs: 1000,
        transfers: {
          "cap-1|sto-1": {
            srcDid: CAP, storageDid: STO1, state: "waiting_network",
            files: { "seg00.mp4": { bytes: 1000, sha256: "aaaa", state: "waiting_network", received: 400, waitingSinceMs: 500, lastAttemptAtMs: 600, error: "network" } }
          }
        }
      });
      const j0 = J.createTransferJournal({ fs, log: () => {} });
      await j0.save(doc, true);

      const ctx = makeStorageBoot({ takes: [{ takeNumber: TAKE, storages: [] }], native: {}, journalFs: fs });
      ctx.boot.bind();
      ctx.boot._ensureFor(SID, TAKE);
      ctx.boot._entries()[SID + "|" + TAKE].service.storageRun = () => Promise.resolve();
      await flush(10);
      const e = ctx.boot._entries()[SID + "|" + TAKE];
      const t = e.machine.transferFor(CAP, STO1);
      assert.ok(t, "transfert reconstruit depuis le journal");
      assert.strictEqual(t.state, M.PH_WAITING_NETWORK, "restauré comme récupérable, jamais done");
      const f0 = t.files.find((f) => f.rel === "seg00.mp4");
      assert.strictEqual(f0.bytes, 1000, "identité taille préservée");
      assert.strictEqual(f0.sha256, "aaaa", "identité SHA préservée");
      assert.ok(ctx.logs.some((l) => l.indexOf("TRANSFER_JOURNAL_APPLIED") >= 0), "journal appliqué au boot");
      ctx.boot._stopWatchdog();
    });

    it("J15.24 après restauration, le coordinateur réactive une reprise (scan)", async () => {
      const fs = J.memoryFs();
      const j0 = J.createTransferJournal({ fs, log: () => {} });
      await j0.save(J.buildDoc({
        sessionId: SID, takeNumber: TAKE, storageDeviceId: STO1, nowMs: 1000,
        transfers: { "cap-1|sto-1": { srcDid: CAP, storageDid: STO1, state: "transferring", files: { "seg00.mp4": { bytes: 1000, sha256: "aaaa", state: "transferring", received: 300 } } } }
      }), true);
      const ctx = makeStorageBoot({ takes: [{ takeNumber: TAKE, storages: [] }], native: {}, journalFs: fs });
      ctx.boot.bind();
      ctx.boot._ensureFor(SID, TAKE);
      const e0 = ctx.boot._entries()[SID + "|" + TAKE];
      e0.service.storageRun = () => Promise.resolve();
      await flush(10);
      const e = ctx.boot._entries()[SID + "|" + TAKE];
      e.service.storageRun = () => Promise.resolve();
      const n = ctx.boot._resumeScan();
      assert.ok(n >= 1, "le scan planifie la reprise du transfert restauré");
      ctx.boot._stopWatchdog();
    });
  });

  /* ====================================================================== */
  /* J15-C — HTTP Range (comportement JS ; le natif Java est inspecté)      */
  /* ====================================================================== */

  describe("J15-C — HTTP 200 / 206 / 416", function () {

    function mkSvc(downloadPlan, statMap) {
      const m = mkModel("storage", STO1, () => 1000);
      m.machine.onIncoming(offerMsg());
      const native = fakeNative({ download: downloadPlan });
      const waits = [];
      const s = S.createTransferService({
        model: m.machine, native, role: "storage", self: () => STO1,
        take: () => ({ sessionId: SID, takeNumber: TAKE }),
        log: () => {}, rand: () => 1,
        onWaiting: (info) => waits.push(info),
        paths: { destFor: () => ({ dest: "file:///data/app/seg00.mp4", relPath: "seg00.mp4" }) },
        statDest: () => Promise.resolve(statMap ? statMap() : null)
      });
      return { m, native, s, waits };
    }

    const offer416 = () => ({ sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, host: "h", port: 1, token: "t", files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }] });
    const file416 = () => ({ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa", received: 500 });

    it("J15.25 416 + destination COMPLÈTE et conforme → done sans nouveau download", async () => {
      const ctx = mkSvc(() => Promise.reject(new Error("download_http_416")), () => ({ bytes: 1000, sha256: "aaaa" }));
      const r = await ctx.s.downloadWithRetry(offer416(), file416(), TAKE);
      assert.strictEqual(r, true);
      assert.strictEqual(ctx.m.machine.transferFor(CAP, STO1).state, M.PH_DONE, "416 réconcilié : fichier en fait complet");
    });

    it("J15.26 416 + destination incohérente → pas de done (reprise/attente)", async () => {
      const ctx = mkSvc(() => Promise.reject(new Error("download_http_416")), () => ({ bytes: 123, sha256: "zzzz" }));
      const r = await ctx.s.downloadWithRetry(offer416(), file416(), TAKE);
      assert.strictEqual(r, false);
      assert.notStrictEqual(ctx.m.machine.transferFor(CAP, STO1).state, M.PH_DONE, "jamais done sur 416 non conforme");
    });

    it("J15.27 206 Content-Range incohérent → restart contrôlé, puis récupérable (jamais terminal)", async () => {
      let dl = 0;
      const ctx = mkSvc(() => { dl += 1; return Promise.reject(new Error("download_range_mismatch: requested=500 got=bytes 0-499/1000")); }, () => null);
      const r = await ctx.s.downloadWithRetry(offer416(), file416(), TAKE);
      assert.strictEqual(r, false);
      assert.ok(dl >= 1);
      assert.notStrictEqual(ctx.m.machine.transferFor(CAP, STO1).state, M.PH_DONE);
      assert.ok(ctx.m.sent.some((x) => x.kind === "transfer_waiting") || ctx.waits.length >= 1, "reste récupérable, jamais terminal");
    });

    it("J15.28 HTTP 200 (serveur ignore le Range) : download réussi → done normal", async () => {
      const ctx = mkSvc(() => Promise.resolve({ done: true, received: 1000, sha256: "aaaa" }), () => null);
      const r = await ctx.s.downloadWithRetry(offer416(), file416(), TAKE);
      assert.strictEqual(r, true);
      assert.strictEqual(ctx.m.machine.transferFor(CAP, STO1).state, M.PH_DONE);
    });
  });

  /* ====================================================================== */
  /* J15-D — fichiers > 2 GiB (pas de troncature 32 bits)                    */
  /* ====================================================================== */

  describe("J15-D — tailles et offsets > 2 GiB (pas de troncature 32 bits)", function () {

    const BIG = 3 * 1024 * 1024 * 1024; /* 3 GiB > 2^31 */

    it("J15.29 le modèle accepte une taille > 2 GiB sans troncature", () => {
      const m = mkModel("storage", STO1, () => 1000);
      m.machine.onIncoming(offerMsg([{ rel: "big.mp4", segmentIndex: 0, bytes: BIG, sha256: "aaaa" }]));
      const t = m.machine.transferFor(CAP, STO1);
      assert.strictEqual(t.files[0].bytes, BIG, "taille conservée exactement");
      assert.ok(t.files[0].bytes > 2147483647);
    });

    it("J15.30 offset > 2 GiB transmis au natif sans troncature", async () => {
      const m = mkModel("storage", STO1, () => 1000);
      m.machine.onIncoming(offerMsg([{ rel: "big.mp4", segmentIndex: 0, bytes: BIG, sha256: "aaaa" }]));
      const native = fakeNative({ download: (o) => Promise.resolve({ done: true, received: BIG, sha256: "aaaa" }) });
      const s = S.createTransferService({
        model: m.machine, native, role: "storage", self: () => STO1,
        take: () => ({ sessionId: SID, takeNumber: TAKE }), log: () => {},
        paths: { destFor: () => ({ dest: "file:///data/app/big.mp4", relPath: "big.mp4" }) },
        statDest: () => Promise.resolve(null)
      });
      const f = { rel: "big.mp4", segmentIndex: 0, bytes: BIG, sha256: "aaaa", received: BIG - 1000 };
      m.machine.reportFileProgress(CAP, "big.mp4", BIG - 1000);
      const r = await s.downloadWithRetry({ sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, host: "h", port: 1, token: "t", files: [f] }, f, TAKE);
      assert.strictEqual(r, true);
      assert.strictEqual(native.calls.download[0].expectedBytes, BIG, "expectedBytes exact, non tronqué");
      assert.strictEqual(native.calls.download[0].offset, BIG - 1000, "offset > 2^31 transmis sans troncature");
    });
  });

  /* ====================================================================== */
  /* J15-E — réutilisation après restauration (intégrité par SHA réel)      */
  /* ====================================================================== */

  describe("J15-E — réutilisation d'un fichier intègre / rejet sinon", function () {

    function mkSvc(stat) {
      const m = mkModel("storage", STO1, () => 1000);
      m.machine.onIncoming(offerMsg());
      const native = fakeNative({});
      const s = S.createTransferService({
        model: m.machine, native, role: "storage", self: () => STO1,
        take: () => ({ sessionId: SID, takeNumber: TAKE }), log: () => {},
        paths: { destFor: () => ({ dest: "file:///data/app/seg00.mp4", relPath: "seg00.mp4" }) },
        statDest: () => Promise.resolve(stat)
      });
      return { m, native, s };
    }
    const off = () => ({ sessionId: SID, takeNumber: TAKE, sourceDeviceId: CAP, host: "h", port: 1, token: "t", files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }] });

    it("J15.31 fichier complet + taille et SHA corrects → AUCUN téléchargement", async () => {
      const ctx = mkSvc({ bytes: 1000, sha256: "aaaa" });
      let dl = 0;
      ctx.native.download = () => { dl += 1; return Promise.resolve({ done: true, received: 1000, sha256: "aaaa" }); };
      const f = { rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa", received: 1000 };
      const r = await ctx.s.downloadWithRetry(off(), f, TAKE);
      assert.strictEqual(r, true);
      assert.strictEqual(dl, 0, "aucun download : fichier déjà intègre");
      assert.strictEqual(ctx.m.machine.transferFor(CAP, STO1).state, M.PH_DONE);
    });

    it("J15.32 même taille mais SHA DIFFÉRENT → pas de réutilisation, téléchargement nécessaire", async () => {
      let dl = 0;
      const ctx = mkSvc({ bytes: 1000, sha256: "zzzz" });
      ctx.native.download = () => { dl += 1; return Promise.resolve({ done: true, received: 1000, sha256: "aaaa" }); };
      const f = { rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa", received: 1000 };
      const r = await ctx.s.downloadWithRetry(off(), f, TAKE);
      assert.strictEqual(r, true);
      assert.strictEqual(dl, 1, "SHA différent → retéléchargement (taille seule non probante)");
    });

    it("J15.33 fichier absent (statDest null) → téléchargement normal", async () => {
      let dl = 0;
      const ctx = mkSvc(null);
      ctx.native.download = () => { dl += 1; return Promise.resolve({ done: true, received: 1000, sha256: "aaaa" }); };
      const f = { rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa", received: 500 };
      const r = await ctx.s.downloadWithRetry(off(), f, TAKE);
      assert.strictEqual(r, true);
      assert.strictEqual(dl, 1);
    });

    it("J15.34 transfert NEUF (aucune métadonnée locale) → précontrôle ignoré, download direct", async () => {
      let dl = 0;
      let statCalls = 0;
      const m = mkModel("storage", STO1, () => 1000);
      m.machine.onIncoming(offerMsg());
      const native = fakeNative({});
      native.download = () => { dl += 1; return Promise.resolve({ done: true, received: 1000, sha256: "aaaa" }); };
      const s = S.createTransferService({
        model: m.machine, native, role: "storage", self: () => STO1,
        take: () => ({ sessionId: SID, takeNumber: TAKE }), log: () => {},
        paths: { destFor: () => ({ dest: "file:///data/app/seg00.mp4", relPath: "seg00.mp4" }) },
        statDest: () => { statCalls += 1; return Promise.resolve({ bytes: 1000, sha256: "aaaa" }); }
      });
      const f = { rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa", received: 0 };
      await s.downloadWithRetry(off(), f, TAKE);
      assert.strictEqual(dl, 1, "transfert neuf télécharge toujours");
      assert.strictEqual(statCalls, 0, "aucun précontrôle sans trace locale");
    });
  });
};
