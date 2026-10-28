/* MultiCam J17-A — accès aux vidéos archivées sur les Storages.
 *
 * Trois niveaux, testés séparément :
 *  1. le MODÈLE PUR (`state/media-catalogue-model.js`) : faits persistés +
 *     catalogues reçus → disponibilité par copie, sélection, bascule, URL ;
 *  2. le SERVICE (`state/transfer-service.js`) : listing disque réel côté
 *     Storage, autorisation HTTP du Take, catalogue sans chemin absolu ;
 *  3. l'ASSEMBLAGE (`state/transfer-boot.js`) : requête Master → Storages,
 *     réponse corrélée, autorisation Master, historique conservé hors ligne.
 *
 * Règles non négociables vérifiées ici :
 *  - `summary.transferState === "TERMINATED"` NE PROUVE JAMAIS une copie ;
 *  - un Take non arrêté n'a AUCUN média disponible ;
 *  - un Storage hors ligne N'EFFACE PAS les copies déjà connues ;
 *  - aucune réponse ni URL n'expose un chemin de système de fichiers.
 */

"use strict";

const path = require("path");
const assert = require("assert");
const MC = require(path.resolve(__dirname, "../www/js/state/media-catalogue-model.js"));
const S = require(path.resolve(__dirname, "../www/js/state/transfer-service.js"));
const M = require(path.resolve(__dirname, "../www/js/state/transfer-model.js"));
const TM = require(path.resolve(__dirname, "../www/js/state/take-model.js"));
const Boot = require(path.resolve(__dirname, "../www/js/state/transfer-boot.js"));

const SID = "J17SESS";
const TAKE = 3;
const CAP1 = "cap-1";
const CAP2 = "cap-2";
const STO1 = "sto-1";
const STO2 = "sto-2";
const MASTER = "master-1";

/* ---------- fixtures ---------- */

function makeTake(over) {
  const base = {
    takeNumber: TAKE,
    status: "TERMINATED",
    captures: [CAP1, CAP2],
    storages: [STO1, STO2],
    summary: {
      transferState: "TERMINATED",
      stopStates: {
        [CAP1]: { deviceId: CAP1, state: "STOPPED", deltaMs: 5000 },
        [CAP2]: { deviceId: CAP2, state: "STOPPED", deltaMs: 5200 }
      },
      replications: {
        [CAP1 + "|" + STO1]: { sourceDeviceId: CAP1, storageDeviceId: STO1, state: "done", bytes: 300, total: 300, percent: 100 },
        [CAP1 + "|" + STO2]: { sourceDeviceId: CAP1, storageDeviceId: STO2, state: "done", bytes: 300, total: 300, percent: 100 },
        [CAP2 + "|" + STO1]: { sourceDeviceId: CAP2, storageDeviceId: STO1, state: "done", bytes: 400, total: 400, percent: 100 },
        [CAP2 + "|" + STO2]: { sourceDeviceId: CAP2, storageDeviceId: STO2, state: "done", bytes: 400, total: 400, percent: 100 }
      }
    }
  };
  return Object.assign(base, over || {});
}

function makeSession(over) {
  return Object.assign({
    sessionId: SID,
    name: "Session J17",
    masters: [{ deviceId: MASTER, deviceName: "Regie" }],
    members: [
      { deviceId: CAP1, deviceName: "Cam 1" },
      { deviceId: CAP2, deviceName: "Cam 2" },
      { deviceId: STO1, deviceName: "Storage 1" },
      { deviceId: STO2, deviceName: "Storage 2" },
      { deviceId: MASTER, deviceName: "Regie" }
    ]
  }, over || {});
}

function catReply(sto, over) {
  const base = {
    ok: true,
    endpoint: { host: sto === STO1 ? "10.0.0.11" : "10.0.0.12", port: 8080 },
    token: "tok-" + sto,
    sources: [
      { sourceDeviceId: CAP1, replicationState: "done", files: [
        { rel: "seg-00.mp4", bytes: 100 },
        { rel: "seg-01.mp4", bytes: 200 }
      ] },
      { sourceDeviceId: CAP2, replicationState: "done", files: [
        { rel: "cam2-00.mp4", bytes: 400 }
      ] }
    ]
  };
  return Object.assign(base, over || {});
}

/* ---------- service fake ---------- */

function makeService(over) {
  over = over || {};
  const calls = { serveStart: [], register: [], list: [] };
  const filesByDir = over.filesByDir || {};
  const native = {
    serveStart(o) { calls.serveStart.push(o); return Promise.resolve(over.serveUrl || "http://10.0.0.9:8080"); },
    serveStop() { return Promise.resolve(); },
    serveRegister(o) { calls.register.push(o); return Promise.resolve({}); },
    serveUnregister() { return Promise.resolve({}); },
    download() { return Promise.resolve({ done: true }); },
    remove() { return Promise.resolve({ removed: true }); },
    sha256() { return Promise.resolve({ bytes: 1, sha256: "aa" }); }
  };
  const take = over.take || makeTake();
  const svc = S.createTransferService({
    model: over.model || { PH_DONE: "done", PH_ERROR: "error" },
    native,
    role: over.role || "storage",
    self: () => over.self || STO1,
    take: () => take,
    paths: {
      mediaRoot: () => (over.root === undefined ? "/storage/emulated/0/MultiCam/" + SID + "/" + TAKE : over.root),
      listDir: (dir) => {
        calls.list.push(dir);
        if (over.listError && over.listError(dir)) return Promise.reject(over.listError(dir));
        return Promise.resolve(filesByDir[dir] || []);
      }
    },
    storageMode: () => over.storageMode || "path",
    catalogueModel: () => MC,
    generateToken: () => "tok-generated",
    log: over.log || (() => {})
  });
  return { svc, calls, native };
}

/* ---------- boot fake ---------- */

function makeBoot(over) {
  over = over || {};
  const logs = [];
  const sent = [];
  const replies = [];
  const state = {
    peers: over.peers || {},
    session: makeSession(over.session),
    takes: over.takes || [makeTake()]
  };
  const native = {
    calls: { serveStart: [], register: [], list: [] },
    serveStart(o) { this.calls.serveStart.push(o); return Promise.resolve("http://10.0.0.9:8080"); },
    serveStop() { return Promise.resolve(); },
    serveRegister(o) { this.calls.register.push(o); return Promise.resolve({}); },
    serveUnregister() { return Promise.resolve({}); },
    listDir(dir) {
      this.calls.list.push(dir);
      const entries = (over.filesByDir || {})[dir] || [];
      return Promise.resolve({ path: dir, entries });
    },
    sha256() { return Promise.resolve({ bytes: 1, sha256: "aa" }); },
    stage(src, dest) { return Promise.resolve({ dest, bytes: 1 }); },
    remove() { return Promise.resolve({ removed: true }); },
    download() { return Promise.resolve({ done: true }); }
  };
  const ws = {
    sendToDevice(did, session, kind, extra) { sent.push({ did, session, kind, extra }); return true; },
    broadcastTargeted(kind, session, extra) { sent.push({ did: "*", session, kind, extra }); },
    connectedPeers(sid) { return state.peers[sid] || state.peers || {}; },
    setTransferBridge() {},
    upsertTake() { return Promise.resolve(false); }
  };
  const start = {
    onView() {},
    view() { return { sid: SID, takeNumber: TAKE }; },
    machine() { return { view: () => ({ sid: SID, takeNumber: TAKE }) }; },
    selfDid() { return over.self || STO1; },
    isRecording() { return false; }
  };
  const boot = Boot.createTransferBoot({
    cfg: { enabledSkills: over.skills || ["controller"], deviceId: over.self || STO1 },
    ws: () => ws,
    startService: () => start,
    sessionStore: () => ({
      get: (sid) => Promise.resolve(Object.assign({}, state.session, { sessionId: sid, takes: state.takes }))
    }),
    storageNative: () => ({
      defaultPath: () => "file:///sdcard/",
      systemPath: (u) => String(u || "").replace(/^file:\/\//, "").replace(/\/$/, "")
    }),
    nativeApi: () => native,
    transferModel: () => M,
    transferService: () => S,
    takeModel: () => TM,
    catalogueModel: () => MC,
    now: () => 1700000000000,
    log: (l) => logs.push(l)
  });
  return { boot, ws, state, native, sent, replies, logs };
}

function replyFn(replies) {
  return (kind, extra) => { replies.push({ kind, extra }); };
}

module.exports.register = function (h) {
  const describe = h.describe;
  const it = h.it;

  describe("J17-A — modèle pur du catalogue média", function () {

    it("M1. takeStopped : faits par Capture, repli J12, statut terminal", () => {
      assert.strictEqual(MC.takeStopped(makeTake()), true);
      const missing = makeTake({ summary: { stopStates: { [CAP1]: {} } } });
      assert.strictEqual(MC.takeStopped(missing), false, "une Capture sans fait d'arrêt n'est pas arrêtée");
      const legacy = makeTake({
        summary: {
          transfers: { [CAP1]: { state: "STOPPED" }, [CAP2]: { state: "STOPPED" } }
        }
      });
      assert.strictEqual(MC.takeStopped(legacy), true, "repli J12");
      const old = makeTake({
        captures: [CAP1, CAP2],
        status: "TERMINATED",
        summary: {}
      });
      assert.strictEqual(MC.takeStopped(old), true, "Take ancien : statut terminal");
      const running = makeTake({ status: "IN_PROGRESS", summary: {} });
      assert.strictEqual(MC.takeStopped(running), false);
    });

    it("M2. sanitizeRel : refuse absolu, remontée, schéma, antislash", () => {
      assert.strictEqual(MC.sanitizeRel("seg-00.mp4"), "seg-00.mp4");
      assert.strictEqual(MC.sanitizeRel("sub/seg-00.mp4"), "sub/seg-00.mp4");
      ["", "/etc/passwd", "../x", "a/../../b", "a\\b", "file:/x", "C:/x", "a//b", "a/./b"].forEach((r) => {
        assert.strictEqual(MC.sanitizeRel(r), "", "doit refuser: " + r);
      });
    });

    it("M3. mediaUrl : route confinée, token optionnel, aucun chemin absolu", () => {
      const url = MC.mediaUrl({
        baseUrl: "http://10.0.0.11:8080/", sessionId: SID, takeNumber: TAKE,
        sourceDeviceId: CAP1, rel: "sub/seg 00.mp4", token: "t k"
      });
      assert.strictEqual(url, "http://10.0.0.11:8080/" + SID + "/3/" + CAP1 + "/sub/seg%2000.mp4?token=t%20k");
      assert.ok(url.indexOf("file://") < 0 && url.indexOf("/storage/") < 0);
      assert.strictEqual(MC.mediaUrl({
        baseUrl: "http://10.0.0.11:8080", sessionId: SID, takeNumber: TAKE,
        sourceDeviceId: CAP1, rel: "../x", token: "t"
      }), "");
      assert.strictEqual(MC.mediaUrl({
        baseUrl: "file:///sdcard", sessionId: SID, takeNumber: TAKE,
        sourceDeviceId: CAP1, rel: "a.mp4", token: "t"
      }), "");
    });

    it("M4. buildView : copies disponibles par couple vérifié, sélection déterministe", () => {
      const view = MC.buildView({
        take: makeTake(), session: makeSession(),
        online: { [STO1]: true, [STO2]: true },
        catalogues: { [STO1]: catReply(STO1), [STO2]: catReply(STO2) }
      });
      assert.strictEqual(view.stopped, true);
      assert.strictEqual(view.captures.length, 2);
      const f0 = view.captures[0].files[0];
      assert.strictEqual(f0.rel, "seg-00.mp4");
      assert.strictEqual(f0.copies.length, 2, "les deux Storages sélectionnés sont candidats");
      assert.strictEqual(f0.available, true);
      assert.strictEqual(f0.selectedStorageDeviceId, STO1, "ordre déterministe du Take");
      assert.ok(f0.url.indexOf("http://10.0.0.11:8080/" + SID + "/3/" + CAP1 + "/seg-00.mp4?token=tok-sto-1") === 0);
      assert.strictEqual(view.availableFiles, 3);
      assert.strictEqual(view.totalFiles, 3);
    });

    it("M4b. un état global TERMINATED ne prouve RIEN : réplication inconnue", () => {
      const take = makeTake({ summary: {
        transferState: "TERMINATED",
        stopStates: { [CAP1]: {}, [CAP2]: {} }
      } });
      const view = MC.buildView({
        take, session: makeSession(),
        online: { [STO1]: true, [STO2]: true },
        catalogues: { [STO1]: catReply(STO1), [STO2]: catReply(STO2) }
      });
      assert.strictEqual(view.availableFiles, 0);
      const f0 = view.captures[0].files[0];
      assert.strictEqual(f0.copies[0].reason, MC.REASON.REPLICATION_UNKNOWN);
    });

    it("M4c. fichier absent ou taille incohérente ⇒ copie indisponible, autre copie choisie", () => {
      const c1 = catReply(STO1, {
        sources: [
          { sourceDeviceId: CAP1, files: [{ rel: "seg-00.mp4", bytes: 100 }] },
          { sourceDeviceId: CAP2, files: [{ rel: "cam2-00.mp4", bytes: 400 }] }
        ]
      });
      const view = MC.buildView({
        take: makeTake(), session: makeSession(),
        online: { [STO1]: true, [STO2]: true },
        catalogues: { [STO1]: c1, [STO2]: catReply(STO2) }
      });
      const seg1 = view.captures[0].files.filter((f) => f.rel === "seg-01.mp4")[0];
      assert.strictEqual(seg1.copies[0].reason, MC.REASON.FILE_MISSING);
      assert.strictEqual(seg1.selectedStorageDeviceId, STO2, "bascule vers la copie complète");
      /* Total persisté 300 alors que le catalogue STO1 n'en liste que 100 :
       * le fichier restant est présent mais la paire est incohérente. */
      const seg0 = view.captures[0].files.filter((f) => f.rel === "seg-00.mp4")[0];
      assert.strictEqual(seg0.copies[0].reason, MC.REASON.FILE_SIZE_MISMATCH);
      assert.strictEqual(seg0.selectedStorageDeviceId, STO2);
    });

    it("M4d. échec de listing d'une source : storage_error, pas file_missing", () => {
      const view = MC.buildView({
        take: makeTake(), session: makeSession(),
        online: { [STO1]: true, [STO2]: true },
        catalogues: {
          [STO1]: catReply(STO1, { sources: [{ sourceDeviceId: CAP1, files: [], error: "listing_failed" }] }),
          [STO2]: catReply(STO2)
        }
      });
      const f0 = view.captures[0].files[0];
      assert.strictEqual(f0.copies[0].reason, MC.REASON.STORAGE_ERROR);
      assert.strictEqual(f0.selectedStorageDeviceId, STO2);
    });

    it("M5. Storage hors ligne : historique CONSERVÉ, copie indisponible", () => {
      const view = MC.buildView({
        take: makeTake(), session: makeSession(),
        online: { [STO1]: true, [STO2]: false },
        catalogues: { [STO1]: catReply(STO1), [STO2]: catReply(STO2) }
      });
      const f0 = view.captures[0].files[0];
      assert.strictEqual(f0.copies.length, 2, "la copie hors ligne n'est pas effacée");
      const offline = f0.copies.filter((c) => c.storageDeviceId === STO2)[0];
      assert.strictEqual(offline.reason, MC.REASON.STORAGE_OFFLINE);
      assert.strictEqual(offline.available, false);
      const row = view.storages.filter((s) => s.deviceId === STO2)[0];
      assert.strictEqual(row.state, MC.ST_OFFLINE);
      assert.strictEqual(row.fileCount, 3, "le dernier catalogue connu reste comptabilisé");
      assert.strictEqual(view.captures[0].files[0].selectedStorageDeviceId, STO1);
    });

    it("M6. Take non arrêté : aucun fichier proposé", () => {
      const take = makeTake({ status: "IN_PROGRESS", summary: { stopStates: { [CAP1]: {} } } });
      const view = MC.buildView({
        take, session: makeSession(),
        online: { [STO1]: true, [STO2]: true },
        catalogues: { [STO1]: catReply(STO1) }
      });
      assert.strictEqual(view.stopped, false);
      assert.strictEqual(view.reason, MC.REASON.TAKE_NOT_STOPPED);
      assert.strictEqual(view.totalFiles, 0);
    });

    it("M7. selectCopy : bascule sans logique de lecture complexe", () => {
      const view = MC.buildView({
        take: makeTake(), session: makeSession(),
        online: { [STO1]: true, [STO2]: true },
        catalogues: { [STO1]: catReply(STO1), [STO2]: catReply(STO2) }
      });
      const f0 = view.captures[0].files[0];
      assert.strictEqual(MC.selectCopy(f0).storageDeviceId, STO1);
      assert.strictEqual(MC.selectCopy(f0, [STO1]).storageDeviceId, STO2);
      assert.strictEqual(MC.selectCopy(f0, [STO1, STO2]), null);
    });

    it("M8. normalizeCatalogue : un rel dangereux est ignoré, jamais exposé", () => {
      const cat = MC.normalizeCatalogue({
        ok: true, endpoint: { host: "10.0.0.11", port: 8080 }, token: "t",
        sources: [{ sourceDeviceId: CAP1, files: [
          { rel: "ok.mp4", bytes: 10 }, { rel: "../../etc/passwd", bytes: 10 },
          { rel: "/abs.mp4", bytes: 10 }
        ] }]
      });
      assert.deepStrictEqual(Object.keys(cat.sources[CAP1].files), ["ok.mp4"]);
    });
  });

  describe("J17-A — service Storage : listing réel, autorisation HTTP", function () {

    it("S1. catalogue : fichiers réels, grant par Take, aucun chemin absolu", async () => {
      const root = "/storage/emulated/0/MultiCam/" + SID + "/" + TAKE;
      const filesByDir = {
        [root + "/" + CAP1]: [
          { name: "seg-00.mp4", bytes: 100, dir: false },
          { name: "seg-01.mp4", bytes: 200, dir: false },
          { name: "..", bytes: 0, dir: false }
        ],
        [root + "/" + CAP2]: [{ name: "cam2-00.mp4", bytes: 400, dir: false }]
      };
      const { svc, calls } = makeService({ filesByDir });
      const cat = await svc.storageCatalogue({ sessionId: SID, takeNumber: TAKE, sources: [CAP1, CAP2, STO1, "../evil"] });
      assert.strictEqual(cat.ok, true);
      assert.strictEqual(cat.sources.length, 2, "self et source invalide exclus");
      assert.deepStrictEqual(cat.sources[0].files.map((f) => f.rel), ["seg-00.mp4", "seg-01.mp4"]);
      assert.strictEqual(cat.sources[0].replicationState, "done");
      assert.strictEqual(cat.endpoint.host, "10.0.0.9");
      assert.strictEqual(cat.token, "tok-generated");
      assert.strictEqual(calls.serveStart.length, 1, "un seul serveur partagé");
      assert.strictEqual(calls.register.length, 1);
      assert.strictEqual(calls.register[0].root, root);
      const json = JSON.stringify(cat);
      assert.ok(json.indexOf("/storage/") < 0 && json.indexOf("file://") < 0, "aucun chemin ne fuit");

      const cat2 = await svc.storageCatalogue({ sessionId: SID, takeNumber: TAKE, sources: [CAP1, CAP2] });
      assert.strictEqual(calls.serveStart.length, 1, "serveur réutilisé");
      assert.strictEqual(calls.register.length, 2, "grant ré-enregistré (idempotent)");
      assert.strictEqual(cat2.token, cat.token, "token stable pour un Take");
    });

    it("S2. mode SAF : explicitement non servi, aucun listing", async () => {
      const { svc, calls } = makeService({ storageMode: "saf" });
      const cat = await svc.storageCatalogue({ sessionId: SID, takeNumber: TAKE, sources: [CAP1] });
      assert.strictEqual(cat.ok, false);
      assert.strictEqual(cat.reason, "saf_unsupported");
      assert.strictEqual(calls.list.length, 0);
    });

    it("S3. Take non arrêté ou rôle non Storage : refus explicite", async () => {
      const svcStop = makeService({ take: makeTake({ status: "IN_PROGRESS", summary: { stopStates: {} } }) }).svc;
      const c1 = await svcStop.storageCatalogue({ sessionId: SID, takeNumber: TAKE, sources: [CAP1] });
      assert.strictEqual(c1.ok, false);
      assert.strictEqual(c1.reason, "take_not_stopped");
      const svcMaster = makeService({ role: "master" }).svc;
      const c2 = await svcMaster.storageCatalogue({ sessionId: SID, takeNumber: TAKE, sources: [CAP1] });
      assert.strictEqual(c2.reason, "not_storage");
    });

    it("S4. dossier source absent : source vide (fait), pas une erreur", async () => {
      const { svc } = makeService({ listError: () => new Error("list_failed: list_missing_dir") });
      const cat = await svc.storageCatalogue({ sessionId: SID, takeNumber: TAKE, sources: [CAP1] });
      assert.strictEqual(cat.ok, true);
      assert.deepStrictEqual(cat.sources[0].files, []);
      assert.strictEqual(cat.sources[0].error, undefined);
    });

    it("S5. échec de listing (droits/I-O) : erreur explicite, jamais « fichier absent »", async () => {
      const { svc } = makeService({ listError: () => new Error("list_failed: EACCES") });
      const cat = await svc.storageCatalogue({ sessionId: SID, takeNumber: TAKE, sources: [CAP1] });
      assert.strictEqual(cat.ok, true);
      assert.strictEqual(cat.sources[0].error, "listing_failed");
    });
  });

  describe("J17-A — assemblage Master ↔ Storage", function () {

    it("B1. Master : requête à chaque Storage sélectionné, même requestId", async () => {
      const { boot, sent } = makeBoot({ skills: ["controller"], self: MASTER, peers: { [STO1]: true, [STO2]: true } });
      const ok = await boot.requestCatalogue(SID, TAKE);
      assert.strictEqual(ok, true);
      const reqs = sent.filter((m) => m.kind === "media_catalogue_request");
      assert.deepStrictEqual(reqs.map((r) => r.did).sort(), [STO1, STO2]);
      assert.strictEqual(reqs[0].extra.requestId, reqs[1].extra.requestId);
      assert.strictEqual(reqs[0].extra.takeNumber, TAKE);
      const view = await boot.catalogueFor(SID, TAKE);
      assert.strictEqual(view.stopped, true);
      assert.strictEqual(view.totalFiles, 0, "aucun fichier inventé avant réponse");
      assert.deepStrictEqual(view.storages.map((s) => s.state).sort(), [MC.ST_PENDING, MC.ST_PENDING]);
    });

    it("B2. Master : réponse corrélée → URL LAN + token, requête périmée ignorée", async () => {
      const files = {
        ["/sdcard/MultiCam/" + SID + "/" + TAKE + "/" + CAP1]: [
          { name: "seg-00.mp4", bytes: 100, dir: false }
        ],
        ["/sdcard/MultiCam/" + SID + "/" + TAKE + "/" + CAP2]: []
      };
      const ctx = makeBoot({ skills: ["controller"], self: MASTER, filesByDir: files, peers: { [STO1]: true, [STO2]: true } });
      await ctx.boot.requestCatalogue(SID, TAKE);
      const req = ctx.sent.filter((m) => m.kind === "media_catalogue_request")[0];

      await ctx.boot._onTransferMessage({
        kind: "media_catalogue_reply", sessionId: SID, takeNumber: TAKE, from: STO1,
        requestId: req.extra.requestId, ok: true,
        endpoint: { host: "10.0.0.11", port: 8080 }, token: "tok-1",
        sources: [{ sourceDeviceId: CAP1, files: [
          { rel: "seg-00.mp4", bytes: 100 }, { rel: "seg-01.mp4", bytes: 200 }
        ] }]
      });
      let view = await ctx.boot.catalogueFor(SID, TAKE);
      const f0 = view.captures[0].files[0];
      assert.strictEqual(f0.available, true);
      assert.strictEqual(f0.url, "http://10.0.0.11:8080/" + SID + "/" + TAKE + "/" + CAP1 + "/seg-00.mp4?token=tok-1");
      const row = view.storages.filter((s) => s.deviceId === STO1)[0];
      assert.strictEqual(row.state, MC.ST_READY);

      await ctx.boot._onTransferMessage({
        kind: "media_catalogue_reply", sessionId: SID, takeNumber: TAKE, from: STO1,
        requestId: "mc-old", ok: true,
        endpoint: { host: "10.0.0.99", port: 1 }, token: "old",
        sources: [{ sourceDeviceId: CAP1, files: [{ rel: "seg-00.mp4", bytes: 1 }] }]
      });
      view = await ctx.boot.catalogueFor(SID, TAKE);
      assert.strictEqual(view.captures[0].files[0].url.indexOf("10.0.0.11") > 0, true, "réponse périmée ignorée");
      assert.ok(ctx.logs.some((l) => l.indexOf("stale_request") >= 0));
    });

    it("B3. Storage : refuse un demandeur non Master, aucune réponse", async () => {
      const ctx = makeBoot({ skills: ["storage"], self: STO1 });
      await ctx.boot._onTransferMessage({
        kind: "media_catalogue_request", sessionId: SID, takeNumber: TAKE,
        from: "intruder", requestId: "r1"
      }, replyFn(ctx.replies));
      assert.strictEqual(ctx.replies.length, 0);
      assert.ok(ctx.logs.some((l) => l.indexOf("MEDIA_CATALOGUE_DENY") >= 0 && l.indexOf("not_master") >= 0));
    });

    it("B4. Storage : liste le disque, répond sans chemin absolu, grant enregistré", async () => {
      const root = "/sdcard/MultiCam/" + SID + "/" + TAKE;
      const files = {
        [root + "/" + CAP1]: [{ name: "seg-00.mp4", bytes: 100, dir: false }],
        [root + "/" + CAP2]: [{ name: "cam2-00.mp4", bytes: 400, dir: false }]
      };
      const ctx = makeBoot({ skills: ["storage"], self: STO1, filesByDir: files });
      await ctx.boot._onTransferMessage({
        kind: "media_catalogue_request", sessionId: SID, takeNumber: TAKE,
        from: MASTER, requestId: "r42"
      }, replyFn(ctx.replies));
      assert.strictEqual(ctx.replies.length, 1);
      const r = ctx.replies[0];
      assert.strictEqual(r.kind, "media_catalogue_reply");
      assert.strictEqual(r.extra.ok, true);
      assert.strictEqual(r.extra.requestId, "r42");
      assert.strictEqual(r.extra.endpoint.host, "10.0.0.9");
      assert.strictEqual(r.extra.token.length > 0, true);
      assert.strictEqual(r.extra.sources.length, 2);
      assert.strictEqual(ctx.native.calls.serveStart.length, 1);
      assert.strictEqual(ctx.native.calls.register[0].root, root);
      assert.ok(JSON.stringify(r.extra).indexOf("/sdcard") < 0, "aucun chemin absolu dans la réponse");
    });

    it("B5. Storage hors ligne APRÈS réponse : copie conservée mais indisponible", async () => {
      const ctx = makeBoot({ skills: ["controller"], self: MASTER, peers: { [STO1]: true, [STO2]: true } });
      await ctx.boot.requestCatalogue(SID, TAKE);
      const req = ctx.sent.filter((m) => m.kind === "media_catalogue_request")[0];
      await ctx.boot._onTransferMessage({
        kind: "media_catalogue_reply", sessionId: SID, takeNumber: TAKE, from: STO1,
        requestId: req.extra.requestId, ok: true,
        endpoint: { host: "10.0.0.11", port: 8080 }, token: "tok-1",
        sources: [{ sourceDeviceId: CAP1, files: [
          { rel: "seg-00.mp4", bytes: 100 }, { rel: "seg-01.mp4", bytes: 200 }
        ] }]
      });
      let view = await ctx.boot.catalogueFor(SID, TAKE);
      assert.strictEqual(view.captures[0].files[0].available, true);

      ctx.state.peers = { [STO1]: false, [STO2]: false };
      view = await ctx.boot.catalogueFor(SID, TAKE);
      const f0 = view.captures[0].files[0];
      assert.strictEqual(f0.copies.length, 2, "les copies connues restent listées");
      assert.strictEqual(f0.available, false);
      assert.ok(f0.copies.some((c) => c.reason === MC.REASON.STORAGE_OFFLINE));
      assert.strictEqual(view.storages.filter((s) => s.deviceId === STO1)[0].fileCount, 2);
    });

    it("B6. Master : aucune requête pour un Take non arrêté", async () => {
      const take = makeTake({ status: "IN_PROGRESS", summary: { stopStates: {} } });
      const ctx = makeBoot({ skills: ["controller"], self: MASTER, takes: [take] });
      const ok = await ctx.boot.requestCatalogue(SID, TAKE);
      assert.strictEqual(ok, false);
      assert.strictEqual(ctx.sent.filter((m) => m.kind === "media_catalogue_request").length, 0);
      assert.ok(ctx.logs.some((l) => l.indexOf("reason=take_not_stopped") >= 0));
    });
  });
};
