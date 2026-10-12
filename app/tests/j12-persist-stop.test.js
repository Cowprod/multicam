"use strict";

module.exports.register = function (h) {
  const describe = h.describe;
  const it = h.it;

  describe("J12 — persistance STOP conservée après redémarrage", function () {
    it("Take terminé reste terminé et conserve summary", function () {
      var tm = require("../www/js/state/take-model.js");
      var t = tm.createFirstTake("A");
      t.status = tm.STATUS_TERMINATED;
      t.summary = { stoppedAtMs: 1000, durationMs: 5000, transferState: "TRANSFERRING", transfers: {} };
      var t2 = tm.sanitizeTake(t);
      if (t2.status !== tm.STATUS_TERMINATED) throw new Error("status perdu");
      if (!t2.summary || t2.summary.durationMs !== 5000) throw new Error("summary perdu");
    });

    it("merge ne réintroduit pas un état plus ancien", function () {
      var tm = require("../www/js/state/take-model.js");
      var newer = {
        takeNumber: 1,
        status: tm.STATUS_TERMINATED,
        captures: ["c"],
        storages: ["s"],
        settings: tm.DEFAULT_SETTINGS(),
        captureOverrides: {},
        updatedAtMs: 2000,
        updatedByDeviceId: "A",
        summary: { stoppedAtMs: 1500, durationMs: 3000, transferState: "TERMINATED" }
      };
      var older = {
        takeNumber: 1,
        status: tm.STATUS_PREPARATION,
        captures: ["c"],
        storages: ["s"],
        settings: tm.DEFAULT_SETTINGS(),
        captureOverrides: {},
        updatedAtMs: 2000,
        updatedByDeviceId: "A",
        summary: null
      };
      var merged = tm.mergeTakes([newer], [older]);
      if (merged.takes[0].status !== tm.STATUS_TERMINATED) throw new Error("régression");
      if (!merged.takes[0].summary) throw new Error("summary perdu");
    });
  });
};
