/* MultiCam J11-UI-CONFORMANCE — écran 09 (Take arrêté) : conformité à
 * `ui/09-take-stopped/README.md` (VALIDÉ). On éprouve la PROJECTION pure :
 * état GLOBAL dynamique, état de Capture DÉRIVÉ des réplications, Capture hors
 * ligne, Réessayer ciblé, bouton « Préparer le Take suivant » toujours actif. */

"use strict";

const assert = require("assert");

const CAP = "cap-1";
const CAP2 = "cap-2";
const STO1 = "sto-1";
const STO2 = "sto-2";

function plan(captures, storages) {
  return {
    participants: captures.map((d) => ({ deviceId: d, deviceName: "Cam " + d, role: "capture" }))
      .concat(storages.map((d) => ({ deviceId: d, deviceName: "Storage " + d, role: "storage" })))
  };
}

function transfer(over) {
  return Object.assign({
    sourceDeviceId: CAP, storageDeviceId: STO1, state: "pending", error: "",
    bytes: 0, total: 0, percent: 0, files: []
  }, over);
}

function env(h, over) {
  over = over || {};
  const e = h.createEnv({});
  const dom = h.fakeDom(["tsSession", "tsTake", "tsState", "tsDuration", "tsList", "tsDone"]);
  e.document = dom;
  e.window.document = dom;
  h.load(e, "ui/take-stopped.js");
  const retries = [];
  const nav = [];
  const startView = Object.assign({
    active: true, sid: "S1", takeNumber: 1,
    stopStates: { [CAP]: { deltaMs: 0, path: "/m/seg00.mp4" } }
  }, over.startView || {});
  e.window.MultiCamStartService = {
    machine: () => ({ state: { plan: over.plan || plan([CAP], [STO1, STO2]) } }),
    view: () => startView
  };
  e.window.MultiCamTransferBootInstance = {
    view: () => over.transferView || { transfers: {} },
    retry: (src) => { retries.push(src); }
  };
  e.window.MultiCamNav = { show: (n, p) => nav.push({ n, p }) };
  return { e, screen: e.window.MultiCamTakeStoppedScreen, retries, nav, dom };
}

module.exports.register = function (h) {
  const describe = h.describe;
  const it = h.it;

  describe("J11 écran 09 — états dynamiques et passage au Take suivant", function () {

    it("B1. état global du Take : Transferts en cours / Terminé / Erreur", () => {
      const running = env(h, {
        transferView: { transfers: { [CAP + "|" + STO1]: transfer({ state: "transferring", bytes: 5, total: 10, percent: 50 }) } }
      }).screen;
      assert.strictEqual(running.view({ active: true, takeNumber: 1, stopStates: { [CAP]: {} } }).takeStateText, "Transferts en cours");

      const done = env(h, {
        transferView: { transfers: {
          [CAP + "|" + STO1]: transfer({ storageDeviceId: STO1, state: "done", bytes: 10, total: 10, percent: 100 }),
          [CAP + "|" + STO2]: transfer({ storageDeviceId: STO2, state: "done", bytes: 10, total: 10, percent: 100 })
        } }
      }).screen;
      assert.strictEqual(done.view({ active: true, takeNumber: 1, stopStates: { [CAP]: {} } }).takeStateText, "Terminé");

      const err = env(h, {
        transferView: { transfers: {
          [CAP + "|" + STO1]: transfer({ storageDeviceId: STO1, state: "done", bytes: 10, total: 10, percent: 100 }),
          [CAP + "|" + STO2]: transfer({ storageDeviceId: STO2, state: "error", bytes: 5, total: 10, percent: 50 })
        } }
      }).screen;
      assert.strictEqual(err.view({ active: true, takeNumber: 1, stopStates: { [CAP]: {} } }).takeStateText, "Erreur");
    });

    it("B2. état de Capture DÉRIVÉ des réplications (jamais l'état STOP brut)", () => {
      const { screen } = env(h, {
        plan: plan([CAP], [STO1]),
        transferView: { transfers: { [CAP + "|" + STO1]: transfer({ state: "transferring", bytes: 5, total: 10, percent: 50 }) } }
      });
      const r = screen.view({ active: true, takeNumber: 1, stopStates: { [CAP]: {} } }).rows[0];
      assert.strictEqual(r.stateText, "Transfert");
      assert.ok(["ERROR", "DONE", "TRANSFER", "WAITING", "PREPARING"].indexOf(r.state) >= 0);
    });

    it("B3. Capture hors ligne → « En attente de Cam X » + Storage attendus en attente", () => {
      const { screen } = env(h, {
        plan: plan([CAP, CAP2], [STO1, STO2]),
        startView: { stopStates: { [CAP]: {} } }   /* cap-2 n'a rien finalisé */
      });
      const rows = screen.view({ active: true, takeNumber: 1, stopStates: { [CAP]: {} } }).rows;
      const r2 = rows.filter((r) => r.deviceId === CAP2)[0];
      assert.strictEqual(r2.offlineText, "En attente de Cam " + CAP2);
      assert.strictEqual(r2.stateText, "En attente");
      assert.strictEqual(r2.bars.length, 2, "les Storage attendus restent visibles");
      assert.ok(r2.bars.every((b) => b.state === "pending"));
    });

    it("B4. Réessayer n'apparaît QUE sur la ligne en erreur, et cible sa Capture", () => {
      const { screen, retries, dom } = env(h, {
        transferView: { transfers: {
          [CAP + "|" + STO1]: transfer({ storageDeviceId: STO1, state: "done", bytes: 10, total: 10, percent: 100 }),
          [CAP + "|" + STO2]: transfer({ storageDeviceId: STO2, state: "error", bytes: 5, total: 10, percent: 50 })
        } }
      });
      screen.show({ deviceId: "mst" }, { sid: "S1" });
      const bars = dom.byId["tsList"]._kids[0]._kids.filter((k) => k._set.has("ts-bars"))[0];
      const errBar = bars._kids.filter((b) => b.dataset.storageId === STO2)[0];
      const okBar = bars._kids.filter((b) => b.dataset.storageId === STO1)[0];
      const retryOf = (bar) => bar._kids[0]._kids.filter((k) => k._set.has("ts-bar-retry"))[0];
      assert.strictEqual(retryOf(errBar)._set.has("d-none"), false, "Réessayer visible en erreur");
      assert.strictEqual(retryOf(okBar)._set.has("d-none"), true, "pas de Réessayer sur une barre terminée");
      retryOf(errBar).dispatchEvent({ type: "click" });
      assert.deepStrictEqual(retries, [CAP]);
    });

    it("B5. « Préparer le Take suivant » est disponible et renvoie à l'écran 05, même en erreur", () => {
      const { screen, nav, dom } = env(h, {
        transferView: { transfers: { [CAP + "|" + STO2]: transfer({ storageDeviceId: STO2, state: "error", bytes: 5, total: 10, percent: 50 }) } }
      });
      screen.show({ deviceId: "mst" }, { sid: "S1" });
      dom.byId["tsDone"].dispatchEvent({ type: "click" });
      assert.strictEqual(nav.length, 1, "un seul changement d'écran");
      assert.strictEqual(nav[0].n, "take");
      assert.strictEqual(nav[0].p.sid, "S1");
    });

    it("B6. aucune progression globale du Take exposée", () => {
      const { screen } = env(h, {});
      const pv = screen.view({ active: true, takeNumber: 1, stopStates: { [CAP]: {} } });
      assert.strictEqual(pv.percent, undefined);
      assert.strictEqual(pv.progress, undefined);
    });
  });
};
