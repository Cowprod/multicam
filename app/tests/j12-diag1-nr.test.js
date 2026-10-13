module.exports = function () {
  describe("J12 diag1 non-regression: API defensive", function () {
    it("newTake/upsertTake reject session_not_found when incomplete and missing", function () {
      var ws = global.MultiCamSessionWs;
      if (!ws) return; // skip if not loaded in env
      return ws.newTake({sessionId: "NOPE"}).then(function () {
        throw new Error("should have rejected");
      }, function (err) {
        if (!err || String(err.message) !== "session_not_found") throw err;
      }).then(function () {
        return ws.upsertTake({sessionId: "NOPE"}, {takeNumber:1});
      }).then(function () {
        throw new Error("should have rejected");
      }, function (err) {
        if (!err || String(err.message) !== "session_not_found") throw err;
      });
    });
  });
};
