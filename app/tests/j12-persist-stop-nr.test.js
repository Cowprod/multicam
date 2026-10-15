"use strict";

/* Non-régression J14 — `isNum` doit être défini dans start-service.js.
 *
 * Défaut d'origine : `persistStopIfNeeded()` (state/start-service.js) appelait
 * `isNum(...)` alors que l'helper n'était DÉFINI que dans transfer-boot.js,
 * arm-model.js et storage-view-model.js — pas dans ce fichier. Résultat au
 * runtime : `ReferenceError: isNum is not defined`, avalée par le `.catch` de
 * chargement → journal `TAKE_PERSIST_STOP_LOAD_ERR` et STOP JAMAIS persisté
 * (le Take restait « PREPARATION » après redémarrage).
 *
 * Ce test pilote le VRAI `persistStopIfNeeded` (atteint via `view()` en phase
 * STOPPED) et EXIGE que le Take terminé soit réellement écrit dans le store.
 * Rouge avant la correction (zéro upsert, journal LOAD_ERR), vert après. */

module.exports.register = function (h) {
  const describe = h.describe;
  const it = h.it;
  const createEnv = h.createEnv;
  const loadAll = h.loadAll;
  const flush = h.flush;

  const SID = "S-NR";
  const CAP = "CAP-1";

  function sessionStub() {
    const tm = require("../www/js/state/take-model.js");
    return {
      sessionId: SID,
      masters: [],
      storages: [],
      takes: [{
        takeNumber: 1,
        status: tm.STATUS_PREPARATION,
        captures: [CAP],
        storages: [],
        settings: tm.DEFAULT_SETTINGS(),
        captureOverrides: {},
        updatedAtMs: 1000,
        updatedByDeviceId: "",
        summary: null
      }]
    };
  }

  function boot(env, machineView) {
    env.MultiCamSessionStore = {
      get() { return Promise.resolve(sessionStub()); }
    };
    env.MultiCamSessionWs = {
      upserts: [],
      status() { return { localDid: CAP }; },
      upsertTake(ses, t) { env.MultiCamSessionWs.upserts.push(t); return Promise.resolve(); }
    };
    env.MultiCamStartModel = {
      createMachine() {
        return {
          view() { return Object.assign({ active: false, phase: "STOPPED", rev: 1 }, machineView); },
          isActive() { return false; }
        };
      }
    };
    loadAll(env, ["state/take-model.js", "state/start-service.js"]);
    env.MultiCamStartService.bind();
    env.MultiCamStartService.view();
    return env.MultiCamSessionWs.upserts;
  }

  describe("J14 — non-régression : isNum défini dans start-service (persistance STOP)", function () {
    it("NR1. STOP en phase STOPPED → Take TERMINATED réellement écrit (pas de LOAD_ERR)", async () => {
      const tm = require("../www/js/state/take-model.js");
      const env = createEnv({ fakeClock: true, skills: ["capture"] });
      const upserts = boot(env, {
        sid: SID, takeNumber: 1, stopExecuted: true,
        stopDurationMs: 5000,
        stopStates: { [CAP]: { actualMs: 2000 } }
      });
      await flush(6);
      if (upserts.length !== 1) {
        throw new Error("STOP non persisté (upserts=" + upserts.length + ") — log: " + env.logText());
      }
      if (upserts[0].status !== tm.STATUS_TERMINATED) {
        throw new Error("Take non TERMINATED : " + upserts[0].status);
      }
      if (!upserts[0].summary || upserts[0].summary.durationMs !== 5000) {
        throw new Error("summary.durationMs perdu : " + JSON.stringify(upserts[0].summary));
      }
      if (env.logText().indexOf("TAKE_PERSIST_STOP_LOAD_ERR") >= 0) {
        throw new Error("LOAD_ERR présent — isNum manquant ? log: " + env.logText());
      }
      if (env.logText().indexOf("TAKE_PERSIST_STOP sid=" + SID) < 0) {
        throw new Error("pas de journal TAKE_PERSIST_STOP — log: " + env.logText());
      }
    });

    it("NR2. valeurs non numériques ignorées par la garde isNum (pas de NaN persisté)", async () => {
      const env = createEnv({ fakeClock: true, skills: ["capture"] });
      const upserts = boot(env, {
        sid: SID, takeNumber: 1, stopExecuted: true,
        stopDurationMs: "pas_un_nombre",
        recElapsedMs: NaN,
        localStopInfo: { actualMs: 1234 }
      });
      await flush(6);
      if (upserts.length !== 1) {
        throw new Error("STOP non persisté (upserts=" + upserts.length + ") — log: " + env.logText());
      }
      const s = upserts[0].summary || {};
      if (s.stoppedAtMs !== 1234) throw new Error("stoppedAtMs attendu 1234, reçu " + s.stoppedAtMs);
      if (s.durationMs !== 0) throw new Error("durationMs doit retomber à 0 (garde isNum), reçu " + s.durationMs);
    });
  });
};
