module.exports = function () {
  describe("J12 diag5: new take inherits params not summary", function () {
    it("createNextTake clears summary", function () {
      var tm = require("../www/js/state/take-model.js");
      var prev = tm.createFirstTake("A");
      prev.status = tm.STATUS_TERMINATED;
      prev.summary = { stoppedAtMs: 1234, durationMs: 100, transferState: "TERMINATED" };
      var nxt = tm.createNextTake([prev], "A");
      if (nxt.takeNumber !== 2) throw new Error("tn");
      if (nxt.status !== tm.STATUS_PREPARATION) throw new Error("status");
      if (nxt.summary) throw new Error("summary should be empty for preparation");
    });
  });
};
