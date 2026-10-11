/* J12 — test anti-régression : un état de réplication déjà validé ne régresse pas. */
"use strict";

module.exports.register = function (h) {
  const describe = h.describe;
  const it = h.it;

  describe("J12 — anti-régression merge Take (état validé ne régresse pas)", function () {
    it("le vainqueur canonique conserve status + summary (LMW égal → contenu prime)", function () {
      var tm = require("../www/js/state/take-model.js");
      var baseA = {
        takeNumber: 1,
        status: tm.STATUS_TERMINATED,
        captures: ["cap1"],
        storages: ["sto1"],
        settings: tm.DEFAULT_SETTINGS(),
        captureOverrides: {},
        updatedAtMs: 1000,
        updatedByDeviceId: "A",
        summary: { stoppedAtMs: 5000, durationMs: 12000, transferState: "TERMINATED", transfers: { "cap1": { state: "done" } } }
      };
      var baseB_old = {
        takeNumber: 1,
        status: tm.STATUS_PREPARATION,
        captures: ["cap1"],
        storages: ["sto1"],
        settings: tm.DEFAULT_SETTINGS(),
        captureOverrides: {},
        updatedAtMs: 1000,
        updatedByDeviceId: "A",
        summary: null
      };
      var merged = tm.mergeTakes([baseA], [baseB_old]);
      if (merged.takes[0].status !== tm.STATUS_TERMINATED) throw new Error("status régressé");
      if (!merged.takes[0].summary || merged.takes[0].summary.transferState !== "TERMINATED") throw new Error("summary régressé");
    });

    it("takeWinner ne choisit pas la version ancienne si le contenu est plus faible", function () {
      var tm = require("../www/js/state/take-model.js");
      var newerSummary = {
        takeNumber: 2,
        status: tm.STATUS_TERMINATED,
        captures: ["c1"],
        storages: ["s1"],
        settings: tm.DEFAULT_SETTINGS(),
        captureOverrides: {},
        updatedAtMs: 500,
        updatedByDeviceId: "M1",
        summary: { stoppedAtMs: 100, durationMs: 50, transferState: "ERROR" }
      };
      var olderButSameTs = {
        takeNumber: 2,
        status: tm.STATUS_PREPARATION,
        captures: ["c1"],
        storages: ["s1"],
        settings: tm.DEFAULT_SETTINGS(),
        captureOverrides: {},
        updatedAtMs: 500,
        updatedByDeviceId: "M1",
        summary: null
      };
      var win = tm.takeWinner(newerSummary, olderButSameTs);
      if (win !== newerSummary) throw new Error("doit conserver l'état validé");
    });
  });
};
