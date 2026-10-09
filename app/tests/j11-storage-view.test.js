/* MultiCam J11-UI-CONFORMANCE — vue Storage (07) : projection PURE.
 *
 * Référence normative : `ui/07-countdown/README.md` + `storage.html` (VALIDÉS).
 * On éprouve la PROJECTION (aucun DOM) : groupement par session triée par
 * activité, Takes en chrono décroissante conservés, X/Y en DEVICES, états des
 * devices/segments, progression qualitative puis octets/%, countdown/REC
 * indépendants par Take. Un cas de rendu DOM prouve que la vue peint bien. */

"use strict";

const path = require("path");
const assert = require("assert");
const VM = require(path.resolve(__dirname, "../www/js/ui/storage-view-model.js"));

const SELF = "sto-1";
const S1 = "sess-A";
const S2 = "sess-B";

function take(n, caps, stos, over) {
  return Object.assign({
    takeNumber: n,
    status: "PREPARATION",
    captures: caps,
    storages: stos,
    settings: {},
    updatedAtMs: 1000 + n
  }, over || {});
}

function session(sid, name, takes, updatedAtMs, members) {
  return {
    sessionId: sid, name: name, takes: takes,
    updatedAtMs: updatedAtMs,
    members: members || []
  };
}

function transfer(src, sto, over) {
  return Object.assign({
    sourceDeviceId: src, storageDeviceId: sto, state: "pending",
    error: "", bytes: 0, total: 0, percent: 0, files: []
  }, over || {});
}

function tview(transfers) {
  return { transfers: transfers || {} };
}

/* transfersFor indexé par (sid, take). */
function transfersMap(map) {
  return (sid, n) => map[sid + "|" + n] || null;
}

function build(input) {
  return VM.build(Object.assign({ self: SELF, nowMs: 100000 }, input));
}

module.exports.register = function (h) {
  const describe = h.describe;
  const it = h.it;

  describe("J11 vue Storage 07 — projection pure", function () {

    it("A1. sessions triées par activité récente, la plus récente ouverte par défaut", () => {
      const sessions = [
        session(S2, "Concert", [take(1, [], [SELF])], 5000),
        session(S1, "Interview", [take(1, [], [SELF])], 9000)
      ];
      const pv = build({ sessions });
      assert.strictEqual(pv.sessions.length, 2);
      assert.strictEqual(pv.sessions[0].sessionId, S1, "activité récente en tête");
      assert.strictEqual(pv.sessions[0].open, true, "session récente ouverte");
      assert.strictEqual(pv.sessions[1].open, false, "session antérieure repliée");
      assert.strictEqual(pv.sessions[0].activityText, "activité récente");
      assert.strictEqual(pv.sessions[1].activityText, "activité antérieure");
    });

    it("A2. Takes du plus récent au plus ancien, tous conservés (même complet)", () => {
      const sessions = [session(S1, "S", [
        take(1, ["cap-1"], [SELF], { updatedAtMs: 1 }),
        take(3, ["cap-1"], [SELF], { updatedAtMs: 3 }),
        take(2, ["cap-1"], [SELF], { updatedAtMs: 2 })
      ], 3)];
      const pv = build({
        sessions,
        transfersFor: transfersMap({
          [S1 + "|1"]: tview({ ["cap-1|" + SELF]: transfer("cap-1", SELF, { state: "done", bytes: 10, total: 10, percent: 100 }) })
        })
      });
      const nums = pv.sessions[0].takes.map((t) => t.takeNumber);
      assert.deepStrictEqual(nums, [3, 2, 1], "chrono décroissante");
      const t1 = pv.sessions[0].takes.filter((t) => t.takeNumber === 1)[0];
      assert.strictEqual(t1.badge.kind, "done", "Take complet conservé");
    });

    it("A3. X/Y reçus compte les DEVICES, pas les fichiers", () => {
      const sessions = [session(S1, "S", [take(1, ["cap-1", "cap-2"], [SELF])], 1, [
        { deviceId: "cap-1", deviceName: "Cam 01" }, { deviceId: "cap-2", deviceName: "Cam 02" }
      ])];
      const pv = build({
        sessions,
        transfersFor: transfersMap({
          [S1 + "|1"]: tview({
            ["cap-1|" + SELF]: transfer("cap-1", SELF, { state: "done", bytes: 100, total: 100, percent: 100, files: [ { rel: "a", segmentIndex: 0, bytes: 100, received: 100, state: "done" }, { rel: "b", segmentIndex: 1, bytes: 100, received: 100, state: "done" } ] }),
            ["cap-2|" + SELF]: transfer("cap-2", SELF, { state: "transferring", bytes: 30, total: 100, percent: 30 })
          })
        })
      });
      const t = pv.sessions[0].takes[0];
      assert.strictEqual(t.expectedDevices, 2);
      assert.strictEqual(t.receivedDevices, 1);
      assert.strictEqual(t.summaryText, "1/2 reçus");
    });

    it("A4. plusieurs Takes actifs simultanément : badges countdown/REC indépendants", () => {
      const sessions = [session(S1, "S", [take(1, ["cap-1"], [SELF]), take(2, ["cap-2"], [SELF])], 2)];
      const phases = {
        [S1 + "|1"]: { phase: "REC", recElapsedMs: 5000 },
        [S1 + "|2"]: { phase: "COUNTDOWN", digit: 3 }
      };
      const pv = build({ sessions, phaseFor: (sid, n) => phases[sid + "|" + n] || null });
      const t1 = pv.sessions[0].takes.filter((t) => t.takeNumber === 1)[0];
      const t2 = pv.sessions[0].takes.filter((t) => t.takeNumber === 2)[0];
      assert.strictEqual(t1.badge.text, "REC 00:05");
      assert.strictEqual(t2.badge.text, "3");
      assert.strictEqual(t1.phase, "REC");
      assert.strictEqual(t2.phase, "COUNTDOWN");
    });

    it("A5. device multi-segments NON reçu tant que tous les segments ne sont pas reçus/vérifiés", () => {
      const sessions = [session(S1, "S", [take(1, ["cap-1"], [SELF])], 1)];
      const pv = build({
        sessions,
        transfersFor: transfersMap({
          [S1 + "|1"]: tview({
            ["cap-1|" + SELF]: transfer("cap-1", SELF, {
              state: "transferring", bytes: 100, total: 300, percent: 33,
              files: [
                { rel: "seg00.mp4", segmentIndex: 0, bytes: 100, received: 100, state: "done" },
                { rel: "seg01.mp4", segmentIndex: 1, bytes: 200, received: 0, state: "pending" }
              ]
            })
          })
        })
      });
      const dev = pv.sessions[0].takes[0].devices[0];
      assert.strictEqual(dev.received, false, "tous les segments ne sont pas finis");
      assert.strictEqual(dev.segments.length, 2);
      assert.strictEqual(dev.segments[0].stateText, "Reçu · vérifié");
      assert.strictEqual(dev.segments[1].stateText, "En attente");
    });

    it("A6. états device : En attente / Transfert / Vérification / Reçu / Erreur", () => {
      const caps = ["cap-1", "cap-2", "cap-3", "cap-4", "cap-5"];
      const sessions = [session(S1, "S", [take(1, caps, [SELF])], 1)];
      const pv = build({
        sessions,
        transfersFor: transfersMap({
          [S1 + "|1"]: tview({
            ["cap-2|" + SELF]: transfer("cap-2", SELF, { state: "transferring", bytes: 5, total: 10, percent: 50 }),
            ["cap-3|" + SELF]: transfer("cap-3", SELF, { state: "verifying", bytes: 10, total: 10, percent: 100 }),
            ["cap-4|" + SELF]: transfer("cap-4", SELF, { state: "done", bytes: 10, total: 10, percent: 100 }),
            ["cap-5|" + SELF]: transfer("cap-5", SELF, { state: "error", bytes: 5, total: 10, percent: 50 })
          })
        })
      });
      const d = {};
      pv.sessions[0].takes[0].devices.forEach((x) => { d[x.deviceId] = x.stateText; });
      assert.strictEqual(d["cap-1"], "En attente");
      assert.strictEqual(d["cap-2"], "Transfert");
      assert.strictEqual(d["cap-3"], "Vérification");
      assert.strictEqual(d["cap-4"], "Reçu · vérifié");
      assert.strictEqual(d["cap-5"], "Erreur");
    });

    it("A7. progression qualitative (taille inconnue) puis octets + % (taille connue)", () => {
      const sessions = [session(S1, "S", [take(1, ["cap-1", "cap-2"], [SELF])], 1)];
      const pv = build({
        sessions,
        transfersFor: transfersMap({
          [S1 + "|1"]: tview({
            ["cap-1|" + SELF]: transfer("cap-1", SELF, { state: "transferring", bytes: 0, total: 0, percent: 0 }),
            ["cap-2|" + SELF]: transfer("cap-2", SELF, { state: "transferring", bytes: 1932735283, total: 2791728742, percent: 69 })
          })
        })
      });
      const d = {};
      pv.sessions[0].takes[0].devices.forEach((x) => { d[x.deviceId] = x; });
      assert.strictEqual(d["cap-1"].sizeKnown, false);
      assert.strictEqual(d["cap-1"].progressText, "Transfert", "qualitatif avant taille");
      assert.strictEqual(d["cap-2"].sizeKnown, true);
      assert.strictEqual(d["cap-2"].progressText, "1,8 / 2,6 Go · 69%", "octets + %");
    });

    it("A8. Take absent des Storage du device filtré (seuls les Takes rattachés sont suivis)", () => {
      const sessions = [session(S1, "S", [
        take(1, ["cap-1"], [SELF]),
        take(2, ["cap-1"], ["autre-sto"])
      ], 2)];
      const pv = build({ sessions });
      assert.deepStrictEqual(pv.sessions[0].takes.map((t) => t.takeNumber), [1]);
    });

    it("A9. en-tête Storage : nom, espace libre, type réseau (Wi-Fi) seulement si disponible", () => {
      const pv = build({ sessions: [], storageInfo: { name: "Raspberry Storage", freeBytes: 442381631488, networkType: "wifi", wifiQuality: "bon" } });
      assert.strictEqual(pv.storage.name, "Raspberry Storage");
      assert.ok(/libres$/.test(pv.storage.freeText));
      assert.strictEqual(pv.storage.networkText, "Wi-Fi");
      const pv2 = build({ sessions: [], storageInfo: { name: "X" } });
      assert.strictEqual(pv2.storage.freeText, "");
      assert.strictEqual(pv2.storage.networkText, "");
    });

    it("A10. rendu DOM : sessions → Takes → devices peints dans #stSessions", () => {
      const e = h.createEnv({});
      const dom = h.fakeDom(["stDeviceName", "stFree", "stNetwork", "stSessions"]);
      e.document = dom; e.window.document = dom;
      h.load(e, "ui/storage-view-model.js");
      h.load(e, "ui/storage-view.js");
      const sessions = [session(S1, "Interview Studio A", [take(1, ["cap-1"], [SELF])], 1, [{ deviceId: "cap-1", deviceName: "Cam 01" }])];
      e.window.MultiCamStartService = { selfDid: () => SELF, view: () => ({ active: false }) };
      e.window.MultiCamTransferBootInstance = {
        viewFor: () => tview({ ["cap-1|" + SELF]: transfer("cap-1", SELF, { state: "transferring", bytes: 5, total: 10, percent: 50 }) })
      };
      e.window.MultiCamNav = { cfg: () => ({}), current: () => "storage" };
      const V = e.window.MultiCamStorageView;
      V.setSessions(sessions);
      V.render();
      const host = dom.byId["stSessions"];
      assert.strictEqual(host._kids.length, 1, "une session peinte");
      const sess = host._kids[0];
      assert.strictEqual(sess._kids.length, 2, "en-tête + corps de session");
      const body = sess._kids.filter((k) => k._set.has("st-session-body"))[0];
      assert.strictEqual(body._kids.length, 1, "un Take");
      const takeBody = body._kids[0]._kids.filter((k) => k._set.has("st-take-body"))[0];
      assert.strictEqual(takeBody._kids.length, 1, "un device");
    });
  });
};
