/* MultiCam J16-A — consultation des Takes PRÉCÉDENTS (archives).
 *
 * Trois niveaux, testés séparément (séparation reconstruction / affichage) :
 *  1. le MODÈLE PUR (`state/take-archive-model.js`) : des faits persistés →
 *     des faits affichables, sans DOM ni service ;
 *  2. la PERSISTANCE : ce que le store relit (rétrocompatible) et ce que les
 *     services écrivent (arrêt par Capture, réplication par couple) ;
 *  3. l'ÉCRAN 09 en mode ARCHIVÉ (`ui/take-stopped.js`) : le DOM rendu à
 *     partir d'un Take passé, sans jamais toucher les sources VIVANTES.
 *
 * Règles non négociables vérifiées ici :
 *  - l'état GLOBAL d'un transfert ne prouve JAMAIS qu'une réplication est finie ;
 *  - un Take ancien se reconstruit quand même, avec des « indisponible » ;
 *  - le mode DIRECT (live) est inchangé.
 */

"use strict";

const path = require("path");
const assert = require("assert");
const Arch = require(path.resolve(__dirname, "../www/js/state/take-archive-model.js"));
const TM = require(path.resolve(__dirname, "../www/js/state/take-model.js"));

const SID = "session-J16";
const CAP1 = "cap-1";
const CAP2 = "cap-2";
const STO1 = "sto-1";
const STO2 = "sto-2";

function session(over) {
  return Object.assign({
    sessionId: SID,
    name: "Session J16",
    members: [
      { deviceId: CAP1, deviceName: "Cam 1", role: "capture" },
      { deviceId: CAP2, deviceName: "Cam 2", role: "capture" },
      { deviceId: STO1, deviceName: "Storage 1", role: "storage" },
      { deviceId: STO2, deviceName: "Storage 2", role: "storage" }
    ]
  }, over || {});
}

/* Take ANCIEN (antérieur à J16-A) : pas de `stopStates`, pas de `replications`.
 * `summary.transfers` porte le format J12 : une entrée par CAPTURE avec
 * l'état « STOPPED » (fait d'arrêt), plus un état GLOBAL de transfert. */
function oldTake(over) {
  return Object.assign({
    takeNumber: 1,
    status: "TERMINATED",
    captures: [CAP1, CAP2],
    storages: [STO1],
    summary: {
      stoppedAtMs: 1700000000000,
      durationMs: 65000,
      stopReason: "manual",
      transferState: "TERMINATED",
      transferBytes: 100,
      transferTotal: 100,
      transferPercent: 100,
      transfers: {
        [CAP1]: { state: "STOPPED", bytes: 0, total: 0, percent: 0, error: "", startedAtMs: 0, updatedAtMs: 1700000065000, completedAtMs: 1700000065000 },
        [CAP2]: { state: "STOPPED", bytes: 0, total: 0, percent: 0, error: "", startedAtMs: 0, updatedAtMs: 1700000065000, completedAtMs: 1700000065000 }
      }
    }
  }, over || {});
}

/* Take NOUVEAU : faits d'arrêt par Capture + état de réplication par couple. */
function newTake(over) {
  return Object.assign({
    takeNumber: 2,
    status: "TERMINATED",
    captures: [CAP1, CAP2],
    storages: [STO1, STO2],
    summary: {
      stoppedAtMs: 1700000100000,
      durationMs: 120000,
      stopReason: "manual",
      stopStates: {
        [CAP1]: { deviceId: CAP1, state: "STOPPED", deltaMs: 12, actualMs: 5000, path: "/m/seg00.mp4" },
        [CAP2]: { deviceId: CAP2, state: "STOPPED", deltaMs: -7, actualMs: 5000, path: "/m/seg00.mp4" }
      },
      replications: {
        [CAP1 + "|" + STO1]: { sourceDeviceId: CAP1, storageDeviceId: STO1, state: "done", error: "", bytes: 1000, total: 1000, percent: 100 },
        [CAP1 + "|" + STO2]: { sourceDeviceId: CAP1, storageDeviceId: STO2, state: "done", error: "", bytes: 1000, total: 1000, percent: 100 },
        [CAP2 + "|" + STO1]: { sourceDeviceId: CAP2, storageDeviceId: STO1, state: "done", error: "", bytes: 1000, total: 1000, percent: 100 },
        [CAP2 + "|" + STO2]: { sourceDeviceId: CAP2, storageDeviceId: STO2, state: "error", error: "sha mismatch", bytes: 400, total: 1000, percent: 40 }
      }
    }
  }, over || {});
}

module.exports.register = function (h) {
  const describe = h.describe;
  const it = h.it;

  /* ================================================================
   * 1. MODÈLE PUR — reconstruction
   * ================================================================ */

  describe("J16-A modèle — reconstruction des faits archivés", function () {

    it("M1. Take ancien : la sélection est connue, la réplication est INDISPONIBLE (jamais « Terminé »)", () => {
      const arch = Arch.reconstruct({ take: oldTake(), session: session() });
      assert.strictEqual(arch.rows.length, 2, "2 Captures sélectionnées");
      assert.strictEqual(arch.captures.length, 2);
      assert.strictEqual(arch.storages.length, 1);
      assert.strictEqual(arch.rows[0].name, "Cam 1", "nom issu de session.members");
      assert.strictEqual(arch.rows[0].stopKnown, true, "fait d'arrêt lu dans summary.transfers (format J12)");
      assert.strictEqual(arch.rows[0].destinations[0].state, Arch.BAR_UNKNOWN, "aucune donnée par couple");
      assert.strictEqual(arch.rows[0].state, Arch.ROW_RECORDED, "Capture arrêtée, réplication non documentée");
      assert.strictEqual(arch.state, Arch.TAKE_PARTIAL, "le Take n'est PAS déclaré terminé");
      assert.ok(arch.state !== Arch.TAKE_DONE, "RÈGLE 2 : l'état global ne prouve aucune fin de réplication");
      assert.strictEqual(arch.globalTransferState, "TERMINATED", "état global exposé mais non utilisé");
      assert.ok(arch.unavailable.length >= 1, "les manques sont énoncés");
      assert.ok(arch.unavailable.join(" ").indexOf("réplication") >= 0, "la réplication est signalée indisponible");
    });

    it("M2. RÈGLE 2 : état global « TERMINATED » sans donnée par couple ⇒ aucune barre « done »", () => {
      const arch = Arch.reconstruct({
        take: oldTake({ summary: { transferState: "TERMINATED", transferPercent: 100, transfers: {} } }),
        session: session()
      });
      arch.rows.forEach((r) => {
        r.destinations.forEach((d) => {
          assert.strictEqual(d.state, Arch.BAR_UNKNOWN, "aucune réplication déduite de l'état global");
          assert.notStrictEqual(d.state, Arch.BAR_DONE);
        });
        assert.notStrictEqual(r.state, Arch.ROW_DONE);
      });
      assert.notStrictEqual(arch.state, Arch.TAKE_DONE);
    });

    it("M3. Take nouveau : faits d'arrêt par Capture et état par couple", () => {
      const arch = Arch.reconstruct({ take: newTake(), session: session() });
      assert.strictEqual(arch.rows.length, 2);
      const r1 = arch.rows.filter((r) => r.deviceId === CAP1)[0];
      const r2 = arch.rows.filter((r) => r.deviceId === CAP2)[0];
      assert.strictEqual(r1.stopKnown, true);
      assert.strictEqual(r1.deltaMs, 12, "écart d'horloge conservé");
      assert.strictEqual(r1.path, "/m/seg00.mp4");
      assert.strictEqual(r1.destinations.length, 2, "une destination par Storage");
      assert.strictEqual(r1.destinations[0].storageDeviceId, STO1);
      assert.strictEqual(r1.destinations[0].name, "Storage 1");
      assert.strictEqual(r1.state, Arch.ROW_DONE, "2/2 réplications documentées et terminées");
      assert.strictEqual(r2.state, Arch.ROW_ERROR, "une réplication en erreur ⇒ Capture en erreur");
      assert.strictEqual(arch.state, Arch.TAKE_ERROR);
      assert.strictEqual(arch.durationKnown, true);
      assert.strictEqual(arch.durationMs, 120000);
      assert.deepStrictEqual(arch.unavailable, [], "rien n'est indisponible : tout est documenté");
    });

    it("M4. réplications multiples : 2 Captures × 2 Storage = 4 couples, aucun mélange", () => {
      const arch = Arch.reconstruct({ take: newTake(), session: session() });
      let total = 0;
      arch.rows.forEach((r) => { total += r.destinations.length; });
      assert.strictEqual(total, 4, "4 destinations au total");
      const r2 = arch.rows.filter((r) => r.deviceId === CAP2)[0];
      const d1 = r2.destinations.filter((d) => d.storageDeviceId === STO1)[0];
      const d2 = r2.destinations.filter((d) => d.storageDeviceId === STO2)[0];
      assert.strictEqual(d1.state, Arch.BAR_DONE);
      assert.strictEqual(d2.state, Arch.BAR_ERROR);
      assert.strictEqual(d2.percent, 40, "progression conservée");
      assert.strictEqual(d2.error, "sha mismatch");
    });

    it("M5. données partielles : une destination non documentée ⇒ partielle, pas « terminée »", () => {
      const t = newTake();
      delete t.summary.replications[CAP1 + "|" + STO2];
      const arch = Arch.reconstruct({ take: t, session: session() });
      const r1 = arch.rows.filter((r) => r.deviceId === CAP1)[0];
      assert.strictEqual(r1.knownDestinations, 1);
      assert.strictEqual(r1.state, Arch.ROW_PARTIAL, "une destination documentée, l'autre non");
      assert.ok(arch.unavailable.join(" ").indexOf("Cam 1") >= 0, "la destination non documentée est nommée");
    });

    it("M6. données partielles : Capture sans confirmation d'arrêt ⇒ information indisponible", () => {
      const t = newTake();
      delete t.summary.stopStates[CAP2];
      const arch = Arch.reconstruct({ take: t, session: session() });
      const r2 = arch.rows.filter((r) => r.deviceId === CAP2)[0];
      assert.strictEqual(r2.stopKnown, false);
      assert.strictEqual(r2.state, Arch.ROW_ERROR, "l'erreur de réplication reste visible");
      assert.ok(arch.unavailable.join(" ").indexOf("Cam 2") >= 0, "la Capture sans confirmation est nommée");
    });

    it("M7. Capture sans AUCUNE donnée ⇒ « unknown », jamais un statut fabriqué", () => {
      const t = newTake();
      delete t.summary.stopStates[CAP2];
      delete t.summary.replications[CAP2 + "|" + STO1];
      delete t.summary.replications[CAP2 + "|" + STO2];
      const arch = Arch.reconstruct({ take: t, session: session() });
      const r2 = arch.rows.filter((r) => r.deviceId === CAP2)[0];
      assert.strictEqual(r2.state, Arch.ROW_UNKNOWN);
      assert.strictEqual(r2.destinations[0].state, Arch.BAR_UNKNOWN);
    });

    it("M8. durée absente ⇒ durée INDISPONIBLE (pas « 00:00:00 »)", () => {
      const t = oldTake();
      delete t.summary.durationMs;
      const arch = Arch.reconstruct({ take: t, session: session() });
      assert.strictEqual(arch.durationKnown, false);
      assert.strictEqual(arch.durationMs, 0);
      assert.ok(arch.unavailable.join(" ").indexOf("Durée") >= 0);
    });

    it("M9. Take sans Capture ⇒ aucune ligne, état « none », message explicite", () => {
      const arch = Arch.reconstruct({ take: oldTake({ captures: [], storages: [] }), session: session() });
      assert.strictEqual(arch.rows.length, 0);
      assert.strictEqual(arch.state, Arch.TAKE_NONE);
      assert.ok(arch.unavailable.length >= 1);
    });

    it("M10. Take sans Storage : l'arrêt de la Capture est le seul fait, état « done »", () => {
      const arch = Arch.reconstruct({ take: oldTake({ storages: [] }), session: session() });
      assert.strictEqual(arch.rows[0].state, Arch.ROW_DONE);
      assert.strictEqual(arch.state, Arch.TAKE_DONE);
    });

    it("M11. entrée illisible (null, chaîne, natif) ⇒ aucune exception, état indisponible", () => {
      const t = oldTake();
      t.summary.stopStates = "pas un objet";
      t.summary.replications = { [CAP1 + "|" + STO1]: null, "bidon": { state: "done" } };
      const arch = Arch.reconstruct({ take: t, session: session() });
      assert.strictEqual(arch.rows.length, 2);
      assert.strictEqual(arch.rows[0].destinations[0].state, Arch.BAR_UNKNOWN, "entrée invalide ignorée");
    });
  });

  /* ================================================================
   * 2. PERSISTANCE — ce que le store relit, ce que les services écrivent
   * ================================================================ */

  describe("J16-A persistance — faits par Capture et par couple", function () {

    it("P1. sanitizeTakeSummary : un résumé ANCIEN reste lisible (stopStates/replications vides)", () => {
      const s = TM.sanitizeTakeSummary({ durationMs: 1000, transferState: "TERMINATED", transfers: { [CAP1]: { state: "STOPPED" } } });
      assert.deepStrictEqual(s.stopStates, {}, "stopStates absent ⇒ objet vide, pas undefined");
      assert.deepStrictEqual(s.replications, {});
      assert.strictEqual(s.durationMs, 1000, "le reste du résumé est intact");
      assert.strictEqual(s.transferState, "TERMINATED");
      assert.ok(s.transfers[CAP1], "l'historique des transferts est conservé");
    });

    it("P2. sanitizeTakeSummary : un résumé NOUVEAU est conservé (aller-retour sans perte)", () => {
      const raw = {
        durationMs: 1000,
        stopStates: { [CAP1]: { deviceId: CAP1, state: "STOPPED", deltaMs: 5, path: "/m/a.mp4" } },
        replications: { [CAP1 + "|" + STO1]: { sourceDeviceId: CAP1, storageDeviceId: STO1, state: "done", bytes: 10, total: 10, percent: 100 } }
      };
      const s = TM.sanitizeTakeSummary(raw);
      assert.strictEqual(s.stopStates[CAP1].deltaMs, 5);
      assert.strictEqual(s.stopStates[CAP1].path, "/m/a.mp4");
      assert.strictEqual(s.replications[CAP1 + "|" + STO1].state, "done");
      assert.strictEqual(s.replications[CAP1 + "|" + STO1].percent, 100);
    });

    it("P3. sanitizeTakeSummary : une entrée parasite est neutralisée", () => {
      const s = TM.sanitizeTakeSummary({
        stopStates: { [CAP1]: "texte", [CAP2]: { state: "STOPPED", deltaMs: "beaucoup" } },
        replications: { [CAP1 + "|" + STO1]: { sourceDeviceId: CAP1, state: "done" } }
      });
      assert.deepStrictEqual(s.stopStates[CAP1], undefined, "entrée non-objet ignorée");
      assert.strictEqual(s.stopStates[CAP2].state, "STOPPED", "l'état par défaut est STOPPED");
      assert.strictEqual(s.stopStates[CAP2].deltaMs, null, "un delta non numérique ne devient pas 0");
      assert.strictEqual(s.replications[CAP1 + "|" + STO1], undefined, "un couple sans storageDeviceId est ignoré");
    });

    it("P4. sanitizeTake (aller-retour store) : un Take ancien traverse le store sans perte", () => {
      const t = TM.sanitizeTake(oldTake());
      assert.strictEqual(t.takeNumber, 1);
      assert.deepStrictEqual(t.captures, [CAP1, CAP2]);
      assert.strictEqual(t.summary.transfers[CAP1].state, "STOPPED", "l'historique J12 survit");
      assert.deepStrictEqual(t.summary.stopStates, {});
    });

    it("P5. sanitizeTake : un Take nouveau traverse le store sans perte", () => {
      const t = TM.sanitizeTake(newTake());
      assert.strictEqual(t.summary.stopStates[CAP2].deltaMs, -7);
      assert.strictEqual(t.summary.replications[CAP2 + "|" + STO2].state, "error");
    });

    it("P6. le modèle ARCHIVE relit un Take SANITISÉ (chemin réel : store → écran)", () => {
      const t = TM.sanitizeTake(newTake());
      const arch = Arch.reconstruct({ take: t, session: session() });
      assert.strictEqual(arch.rows[0].destinations[0].state, Arch.BAR_DONE);
      assert.strictEqual(arch.state, Arch.TAKE_ERROR);
    });

    /* --- chemin d'écriture : ce que les services persistent réellement --- */

    /* Reproduit l'environnement de `j12-persist-stop-nr.test.js` : le service
     * START écrit le résumé du Take à l'arrêt. Le faux store est RÉALISTE :
     * il relit le dernier Take écrit (comme le vrai store), sinon on
     * testerait un cas qui n'existe pas. */
    function startServiceEnv(h, machineView, takeSummary) {
      const e = h.createEnv({ fakeClock: true, skills: ["capture"] });
      const storeTake = {
        takeNumber: 1, status: TM.STATUS_PREPARATION,
        captures: [CAP1, CAP2], storages: [STO1],
        settings: TM.DEFAULT_SETTINGS(), captureOverrides: {},
        updatedAtMs: 1000, updatedByDeviceId: "",
        summary: takeSummary === undefined ? null : takeSummary
      };
      e.MultiCamSessionStore = {
        get() { return Promise.resolve({ sessionId: SID, masters: [], storages: [], takes: [JSON.parse(JSON.stringify(storeTake))] }); }
      };
      e.MultiCamSessionWs = {
        upserts: [],
        status() { return { localDid: CAP1 }; },
        upsertTake(ses, t) { this.upserts.push(t); storeTake.summary = JSON.parse(JSON.stringify(t.summary)); return Promise.resolve(); }
      };
      e.MultiCamStartModel = {
        createMachine() {
          return {
            view() { return Object.assign({ active: false, phase: "STOPPED", rev: 1 }, machineView); },
            isActive() { return false; }
          };
        }
      };
      h.loadAll(e, ["state/take-model.js", "state/start-service.js"]);
      e.MultiCamStartService.bind();
      e.MultiCamStartService.view();
      return e;
    }

    it("P7. le service START écrit les faits d'arrêt PAR CAPTURE et préserve les réplications", async () => {
      const prevRep = { [CAP1 + "|" + STO1]: { sourceDeviceId: CAP1, storageDeviceId: STO1, state: "done", error: "", bytes: 10, total: 10, percent: 100 } };
      const e = startServiceEnv(h, {
        sid: SID, takeNumber: 1, stopExecuted: true, stopDurationMs: 5000,
        stopStates: { [CAP1]: { actualMs: 2000, deltaMs: 3, path: "/m/seg00.mp4" } }
      }, { replications: prevRep });
      await h.flush(6);
      const ups = e.MultiCamSessionWs.upserts;
      assert.strictEqual(ups.length, 1, "le résumé est écrit une fois");
      const s = ups[0].summary;
      assert.ok(s.stopStates[CAP1], "le fait d'arrêt de la Capture est persisté");
      assert.strictEqual(s.stopStates[CAP1].deltaMs, 3, "l'écart d'horloge est persisté");
      assert.strictEqual(s.stopStates[CAP1].path, "/m/seg00.mp4", "le segment est persisté");
      assert.ok(s.replications[CAP1 + "|" + STO1], "les réplications ne sont PAS effacées par l'arrêt");
      assert.strictEqual(s.replications[CAP1 + "|" + STO1].state, "done");
    });

    it("P8. l'écriture à l'arrêt est BORNÉE : pas de réécriture identique, une confirmation tardive est acceptée", async () => {
      const machineView = {
        sid: SID, takeNumber: 1, stopExecuted: true, stopDurationMs: 5000,
        stopStates: { [CAP1]: { actualMs: 2000, deltaMs: 3, path: "/m/seg00.mp4" } }
      };
      const e = startServiceEnv(h, machineView);
      await h.flush(6);
      assert.strictEqual(e.MultiCamSessionWs.upserts.length, 1, "une seule écriture");
      /* Une vue identique ne réécrit pas (garde-fou anti-orage). */
      e.MultiCamStartService.view();
      await h.flush(6);
      assert.strictEqual(e.MultiCamSessionWs.upserts.length, 1, "pas de réécriture à l'identique");
      /* Une confirmation SUPPLÉMENTAIRE (2e Capture) est un fait nouveau : elle
       * est écrite, et le fait précédent est conservé. */
      machineView.stopStates[CAP2] = { actualMs: 2100, deltaMs: -2, path: "/m/seg00.mp4" };
      e.MultiCamStartService.view();
      await h.flush(6);
      const ups = e.MultiCamSessionWs.upserts;
      assert.strictEqual(ups.length, 2, "une confirmation supplémentaire est écrite (fait nouveau)");
      assert.ok(ups[1].summary.stopStates[CAP1], "le fait de la 1re Capture est conservé");
      assert.ok(ups[1].summary.stopStates[CAP2], "le fait de la 2e Capture est ajouté");
      /* Le Take complet écrit est relisible par le modèle ARCHIVE. */
      const arch = Arch.reconstruct({ take: ups[1], session: session() });
      assert.strictEqual(arch.rows[0].stopKnown, true);
      assert.strictEqual(arch.rows[1].stopKnown, true);
    });

    it("P9. le boot du transfert écrit l'état PAR COUPLE et préserve les faits d'arrêt", async () => {
      const M = require(path.resolve(__dirname, "../www/js/state/transfer-model.js"));
      const S = require(path.resolve(__dirname, "../www/js/state/transfer-service.js"));
      const e = h.createEnv({ fakeClock: true });
      const upserts = [];
      const wsApi = {
        broadcastTargeted() {}, sendToDevice() {}, setTransferBridge() {},
        upsertTake(ses, t) { upserts.push(t); return Promise.resolve(); }
      };
      const native = {
        defaultPath: () => "file:///data/app/",
        systemPath: (u) => String(u || "").replace(/^file:\/\//, "").replace(/\/$/, ""),
        sha256: () => Promise.resolve({ bytes: 1000, sha256: "aaaa" }),
        download: (o) => Promise.resolve({ done: true, received: o.expectedBytes || 1000, sha256: "aaaa" }),
        stage: (src, dest) => Promise.resolve({ dest: dest, bytes: 1000 }),
        remove: () => Promise.resolve({ removed: true })
      };
      const take = {
        takeNumber: 1, captures: [CAP1], storages: [STO1], settings: {},
        summary: { stopStates: { [CAP1]: { deviceId: CAP1, state: "STOPPED", deltaMs: 3, path: "/m/seg00.mp4" } }, replications: {} }
      };
      const boot = require(path.resolve(__dirname, "../www/js/state/transfer-boot.js")).createTransferBoot({
        cfg: { enabledSkills: ["storage"] },
        ws: () => wsApi,
        startService: () => ({
          onView() {}, view: () => ({ sid: SID, takeNumber: 1 }), machine: () => ({ view: () => ({ sid: SID, takeNumber: 1 }) }),
          selfDid: () => STO1, isRecording: () => false
        }),
        sessionStore: () => ({ get: () => Promise.resolve({ sessionId: SID, takes: [take] }) }),
        storageNative: () => ({ defaultPath: () => "file:///data/app/", systemPath: (u) => String(u || "").replace(/^file:\/\//, "") }),
        nativeApi: () => native,
        transferModel: () => M,
        transferService: () => S,
        takeModel: () => TM,
        log: () => {}
      });
      boot.bind();
      await boot._onTransferMessage({
        kind: "transfer_offer", sessionId: SID, takeNumber: 1,
        sourceDeviceId: CAP1, storageDeviceId: STO1, host: "10.0.0.5", port: 8080, token: "tok",
        files: [{ rel: "seg00.mp4", segmentIndex: 0, bytes: 1000, sha256: "aaaa" }]
      });
      await h.flush(6);
      await e.clock.advance(1500);   /* laisse passer la coalescence de persistance */
      await h.flush(6);
      assert.ok(upserts.length >= 1, "le résumé est écrit");
      const s = upserts[upserts.length - 1].summary;
      assert.ok(s.replications[CAP1 + "|" + STO1], "l'état du couple Capture → Storage est persisté");
      assert.strictEqual(s.replications[CAP1 + "|" + STO1].storageDeviceId, STO1);
      assert.ok(s.stopStates[CAP1], "les faits d'arrêt ne sont jamais effacés par la persistance du transfert");
      assert.strictEqual(s.stopStates[CAP1].deltaMs, 3);
    });
  });

  /* ================================================================
   * 3. ÉCRAN 09 — mode ARCHIVÉ (DOM)
   * ================================================================ */

  function archivedEnv(h, over) {
    over = over || {};
    const e = h.createEnv({});
    const dom = h.fakeDom(["tsSession", "tsTake", "tsState", "tsDuration", "tsList", "tsDone", "tsBack", "tsArchiveNote"]);
    e.document = dom;
    e.window.document = dom;
    h.load(e, "state/take-archive-model.js");
    h.load(e, "ui/take-stopped.js");
    const takes = over.takes || {};
    e.window.MultiCamSessionStore = {
      get: (sid) => Promise.resolve({ sessionId: sid, name: "Session J16", members: session().members, takes: takes[sid] || [] })
    };
    /* Les sources VIVANTES sont présentes mais VIDES : un Take passé n'a pas de
     * service START ni de service de transfert en cours. Si l'écran archivé
     * les lisait, il afficherait un état vivant au lieu d'une archive. */
    e.window.MultiCamStartService = { view: () => null, machine: () => ({ state: { plan: null } }) };
    e.window.MultiCamTransferBootInstance = { view: () => ({ transfers: {} }) };
    const nav = { calls: [], show: (name, params) => { nav.calls.push([name, params]); } };
    e.window.MultiCamNav = nav;
    return { e, screen: e.window.MultiCamTakeStoppedScreen, dom, logs: e.logs, nav };
  }

  describe("J16-A écran 09 — mode archivé", function () {

    /* Structure d'une ligne : root(ts-row) > [name, meta(ts-row-meta) > [state,
     * delta], path, offline, bars(ts-bars) > bar(ts-bar) > [head > [name,
     * state, retry], progress, meta] */
    function stateElOf(row) {
      const meta = row._kids.filter((k) => k._set && k._set.has("ts-row-meta"))[0];
      return meta._kids.filter((k) => k._set && k._set.has("ts-row-state"))[0];
    }
    function barsOf(row) {
      return row._kids.filter((k) => k._set && k._set.has("ts-bars"))[0];
    }
    function barStateOf(bar) {
      return bar._kids[0]._kids.filter((k) => k._set && k._set.has("ts-bar-state"))[0];
    }

    it("E1. Take ancien : les Captures sont listées, réplication « indisponible », bandeau visible", async () => {
      const takes = { [SID]: [oldTake()] };
      const { screen, dom } = archivedEnv(h, { takes });
      const pv = await screen.show({ deviceId: "mst" }, { sid: SID, takeNumber: 1, archived: "1" });
      assert.ok(pv, "la vue archivée est rendue");
      assert.strictEqual(pv.rows.length, 2, "2 lignes Capture");
      const rows = dom.byId["tsList"]._kids;
      assert.strictEqual(rows.length, 2, "2 lignes dans le DOM");
      assert.strictEqual(stateElOf(rows[0]).textContent, "Enregistré", "Capture arrêtée, réplication non documentée");
      const bar = barsOf(rows[0])._kids[0];
      assert.strictEqual(barStateOf(bar).textContent, "Indisponible", "pas de barre « Terminée » inventée");
      const note = dom.byId["tsArchiveNote"];
      assert.ok(note.textContent.length > 0, "le bandeau énonce ce qui manque");
      assert.ok(!note._set.has("d-none"), "le bandeau est visible");
      assert.strictEqual(dom.byId["tsDuration"].textContent, "00:01:05", "durée connue");
    });

    it("E2. Take nouveau : l'état par couple est affiché, « Terminé » assumé", async () => {
      const takes = { [SID]: [newTake()] };
      const { screen, dom } = archivedEnv(h, { takes });
      const pv = await screen.show({ deviceId: "mst" }, { sid: SID, takeNumber: 2, archived: "1" });
      assert.strictEqual(pv.rows.length, 2);
      const rows = dom.byId["tsList"]._kids;
      const r1 = rows.filter((r) => r.dataset.deviceId === CAP1)[0];
      assert.strictEqual(stateElOf(r1).textContent, "Terminé");
      assert.strictEqual(barsOf(r1)._kids.length, 2, "une barre par Storage");
      const r2 = rows.filter((r) => r.dataset.deviceId === CAP2)[0];
      assert.strictEqual(stateElOf(r2).textContent, "Erreur");
      assert.strictEqual(dom.byId["tsState"].textContent, "Erreur", "état global du Take");
      assert.ok(dom.byId["tsArchiveNote"]._set.has("d-none"), "rien à signaler : le bandeau est masqué");
    });

    it("E3. en archive, le bouton « Réessayer » n'est JAMAIS proposé", async () => {
      const takes = { [SID]: [newTake()] };
      const { screen, dom } = archivedEnv(h, { takes });
      await screen.show({ deviceId: "mst" }, { sid: SID, takeNumber: 2, archived: "1" });
      const rows = dom.byId["tsList"]._kids;
      rows.forEach((r) => {
        barsOf(r)._kids.forEach((bar) => {
          const retry = bar._kids[0]._kids.filter((k) => k._set && k._set.has("ts-bar-retry"))[0];
          assert.ok(retry._set.has("d-none"), "« Réessayer » masqué en archive");
        });
      });
    });

    it("E4. Take absent du store : aucun crash, aucun faux contenu", async () => {
      const { screen, dom, logs } = archivedEnv(h, { takes: {} });
      const pv = await screen.show({ deviceId: "mst" }, { sid: SID, takeNumber: 9, archived: "1" });
      assert.strictEqual(pv, null, "aucune vue rendue");
      assert.strictEqual(dom.byId["tsList"]._kids.length, 0, "aucune ligne");
      assert.ok(logs.join("\n").indexOf("SCREEN09_OPEN_ARCHIVED") >= 0, "l'ouverture est tracée");
    });

    it("E5. store en erreur : l'écran journalise et ne casse pas", async () => {
      const e = h.createEnv({});
      const dom = h.fakeDom(["tsSession", "tsTake", "tsState", "tsDuration", "tsList", "tsDone", "tsArchiveNote"]);
      e.document = dom;
      e.window.document = dom;
      h.load(e, "state/take-archive-model.js");
      h.load(e, "ui/take-stopped.js");
      e.window.MultiCamSessionStore = { get: () => Promise.reject(new Error("store KO")) };
      const pv = await e.window.MultiCamTakeStoppedScreen.show({ deviceId: "mst" }, { sid: SID, takeNumber: 1, archived: "1" });
      assert.strictEqual(pv, null);
      assert.ok(e.logs.join("\n").indexOf("SCREEN09_ARCHIVED_ERR") >= 0, "l'erreur est tracée");
    });

    it("E6. le mode DIRECT reste inchangé (non-régression live)", async () => {
      const e = h.createEnv({});
      const dom = h.fakeDom(["tsSession", "tsTake", "tsState", "tsDuration", "tsList", "tsDone", "tsBack", "tsArchiveNote"]);
      e.document = dom;
      e.window.document = dom;
      h.load(e, "state/take-archive-model.js");
      h.load(e, "ui/take-stopped.js");
      e.window.MultiCamStartService = {
        machine: () => ({ state: { plan: { participants: [{ deviceId: CAP1, deviceName: "Cam 1", role: "capture" }, { deviceId: STO1, deviceName: "Storage 1", role: "storage" }] } } }),
        view: () => ({ active: true, sid: SID, takeNumber: 3, stopStates: { [CAP1]: { deltaMs: 0, path: "/m/seg00.mp4" } } })
      };
      e.window.MultiCamTransferBootInstance = {
        view: () => ({ transfers: { [CAP1 + "|" + STO1]: { sourceDeviceId: CAP1, storageDeviceId: STO1, state: "done", bytes: 10, total: 10, percent: 100, error: "" } } })
      };
      const pv = e.window.MultiCamTakeStoppedScreen.show({ deviceId: "mst" }, { sid: SID });
      assert.strictEqual(pv.rows.length, 1, "1 Capture en direct");
      assert.strictEqual(pv.takeStateText, "Terminé");
      assert.ok(dom.byId["tsArchiveNote"]._set.has("d-none"), "le bandeau d'archive reste masqué en direct");
      assert.ok(!dom.byId["tsDone"]._set.has("d-none"), "« Préparer le Take suivant » visible en direct");
      assert.ok(dom.byId["tsBack"]._set.has("d-none"), "« Retour à la session » masqué en direct");
    });

    it("E7. en archive : « Préparer le Take suivant » est masqué, « Retour à la session » est proposé", async () => {
      const takes = { [SID]: [oldTake()] };
      const { screen, dom, nav } = archivedEnv(h, { takes });
      await screen.show({ deviceId: "mst" }, { sid: SID, takeNumber: 1, archived: "1" });
      assert.ok(dom.byId["tsDone"]._set.has("d-none"), "préparer un Take SUIVANT n'a pas de sens en archive");
      assert.ok(!dom.byId["tsBack"]._set.has("d-none"), "le retour à la session est proposé");
      dom.byId["tsBack"].dispatchEvent({ type: "click" });
      assert.strictEqual(nav.calls.length, 1, "le retour est déclenché");
      assert.strictEqual(nav.calls[0][0], "session", "on revient à la session");
      assert.strictEqual(nav.calls[0][1].sid, SID, "vers la session consultée");
    });

    it("E8. un re-rendu VIF (révision START) n'écrase PAS l'archive affichée", async () => {
      const takes = { [SID]: [oldTake()] };
      const { screen, dom, e } = archivedEnv(h, { takes });
      await screen.show({ deviceId: "mst" }, { sid: SID, takeNumber: 1, archived: "1" });
      const before = dom.byId["tsTake"].textContent;
      const rowsBefore = dom.byId["tsList"]._kids.length;
      /* Le routeur (main.js) re-rend l'écran à chaque révision START : en
       * archive, ce re-rendu doit être SANS EFFET. */
      e.window.MultiCamStartService.view = () => ({ active: true, sid: SID, takeNumber: 7, stopStates: { [CAP1]: { deltaMs: 0, path: "/m/autre.mp4" } } });
      screen.render(e.window.MultiCamStartService.view());
      assert.strictEqual(dom.byId["tsTake"].textContent, before, "le Take affiché ne change pas");
      assert.strictEqual(dom.byId["tsList"]._kids.length, rowsBefore, "les lignes archivées restent");
      assert.strictEqual(screen.isArchived(), true, "l'écran sait qu'il consulte une archive");
    });

    it("E9. revenir en mode DIRECT désactive le mode archivé", async () => {
      const takes = { [SID]: [oldTake()] };
      const { screen, e } = archivedEnv(h, { takes });
      await screen.show({ deviceId: "mst" }, { sid: SID, takeNumber: 1, archived: "1" });
      assert.strictEqual(screen.isArchived(), true);
      e.window.MultiCamStartService.view = () => ({ active: true, sid: SID, takeNumber: 8, stopStates: { [CAP1]: { deltaMs: 0, path: "/m/seg00.mp4" } } });
      screen.show({ deviceId: "mst" }, { sid: SID });
      assert.strictEqual(screen.isArchived(), false, "le mode direct reprend la main");
    });
  });
};
