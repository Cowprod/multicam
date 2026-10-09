/* MultiCam J11 — écran 09 : barres de transfert (app/www/js/ui/take-stopped.js).
 *
 * La projection est PURE (view/rowsOf) ; le DOM n'est qu'un rendu idempotent.
 * Les coutures (START pour le plan, service de transfert pour la progression)
 * sont stubbées : aucune I/O. On vérifie une barre par Storage, les libellés
 * simples, la conservation de la progression en erreur et le bouton Réessayer. */

"use strict";

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
    sourceDeviceId: CAP, storageDeviceId: STO1, state: "transferring", error: "",
    bytes: 0, total: 0, percent: 0, files: []
  }, over);
}

function env(h, over) {
  over = over || {};
  const e = h.createEnv({});
  const dom = h.fakeDom(["tsSession", "tsTake", "tsDuration", "tsList", "tsDone"]);
  e.document = dom;
  e.window.document = dom;
  h.load(e, "ui/take-stopped.js");
  const retries = [];
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
  e.window.MultiCamNav = { show() {} };
  return { e, screen: e.window.MultiCamTakeStoppedScreen, retries, dom };
}

module.exports.register = function (h) {
  const describe = h.describe;
  const it = h.it;

  describe("J11 écran 09 — barres de transfert par Storage", function () {

    it("U1. view : une barre par Storage, libellés simples, progression conservée en erreur", () => {
      const { screen } = env(h, {
        transferView: {
          transfers: {
            [CAP + "|" + STO1]: transfer({ storageDeviceId: STO1, state: "done", bytes: 1000, total: 1000, percent: 100 }),
            [CAP + "|" + STO2]: transfer({ storageDeviceId: STO2, state: "error", bytes: 570, total: 1000, percent: 57 })
          }
        }
      });
      const pv = screen.view({ active: true, takeNumber: 1, stopStates: { [CAP]: {} } });
      const b = pv.rows[0].bars;
      if (b.length !== 2) throw new Error("attendu 2 barres, got " + b.length);
      const done = b.filter((x) => x.storageDeviceId === STO1)[0];
      const err = b.filter((x) => x.storageDeviceId === STO2)[0];
      if (done.stateText !== "Terminé" || done.percent !== 100) throw new Error("barre done incorrecte");
      if (done.name !== "Storage " + STO1) throw new Error("nom Storage attendu, got " + done.name);
      if (err.stateText !== "Erreur" || err.retry !== true) throw new Error("barre erreur : Réessayer attendu");
      if (err.percent !== 57) throw new Error("progression conservée attendue (57)");
    });

    it("U2. view : barres rattachées à la BONNE Capture, pas de fuite croisée", () => {
      const { screen } = env(h, {
        plan: plan([CAP, CAP2], [STO1]),
        transferView: {
          transfers: {
            [CAP + "|" + STO1]: transfer({ sourceDeviceId: CAP, state: "transferring", bytes: 100, total: 1000, percent: 10 }),
            [CAP2 + "|" + STO1]: transfer({ sourceDeviceId: CAP2, state: "pending", bytes: 0, total: 500, percent: 0 })
          }
        },
        startView: { stopStates: { [CAP]: {}, [CAP2]: {} } }
      });
      const pv = screen.view({ active: true, takeNumber: 1, stopStates: { [CAP]: {}, [CAP2]: {} } });
      const r1 = pv.rows.filter((r) => r.deviceId === CAP)[0];
      const r2 = pv.rows.filter((r) => r.deviceId === CAP2)[0];
      if (r1.bars.length !== 1 || r1.bars[0].percent !== 10) throw new Error("barre de cap-1 incorrecte");
      if (r2.bars.length !== 1 || r2.bars[0].stateText !== "En attente") throw new Error("barre de cap-2 incorrecte");
    });

    it("U3. render : barre en erreur expose Réessayer, qui relance le transfert ciblé", () => {
      const { screen, retries, dom } = env(h, {
        transferView: {
          transfers: {
            [CAP + "|" + STO2]: transfer({ storageDeviceId: STO2, state: "error", bytes: 100, total: 200, percent: 50 })
          }
        }
      });
      screen.show({ deviceId: "mst" }, { sid: "S1" });
      const rows = dom.byId["tsList"]._kids;
      if (rows.length !== 1) throw new Error("une ligne Capture attendue");
      const bars = rows[0]._kids.filter((k) => k._set && k._set.has("ts-bars"))[0];
      if (!bars || bars._kids.length !== 1) throw new Error("une barre attendue");
      const bar = bars._kids[0];
      const retryBtn = bar._kids[0]._kids.filter((k) => k._set && k._set.has("ts-bar-retry"))[0];
      if (!retryBtn) throw new Error("bouton Réessayer absent");
      if (retryBtn._set.has("d-none")) throw new Error("Réessayer doit être visible en erreur");
      retryBtn.dispatchEvent({ type: "click" });
      if (retries.length !== 1 || retries[0] !== CAP) throw new Error("retry doit viser la Capture source");
    });

    it("U4. render : une barre terminée n'expose PAS Réessayer", () => {
      const { screen, dom } = env(h, {
        transferView: {
          transfers: { [CAP + "|" + STO1]: transfer({ storageDeviceId: STO1, state: "done", bytes: 1000, total: 1000, percent: 100 }) }
        }
      });
      screen.show({ deviceId: "mst" }, { sid: "S1" });
      const bar = dom.byId["tsList"]._kids[0]._kids.filter((k) => k._set && k._set.has("ts-bars"))[0]._kids[0];
      const retryBtn = bar._kids[0]._kids.filter((k) => k._set && k._set.has("ts-bar-retry"))[0];
      if (!retryBtn._set.has("d-none")) throw new Error("Réessayer doit être masqué hors erreur");
    });
  });
};
