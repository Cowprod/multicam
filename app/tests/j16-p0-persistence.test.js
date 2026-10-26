/* MultiCam J16-P0 — securisation de la persistance des sessions.
 *
 * Le module teste est le VRAI `state/session-store.js`, execute dans le harnais
 * `vm` contre un faux systeme de fichiers Cordova (`fake-cordova-fs.js`). On ne
 * verifie pas « pas d'exception » : on relit le CONTENU reellement present sur
 * le disque apres chaque scenario, y compris apres une mort brutale du
 * processus (aucun callback ne s'execute plus, comme un force-stop).
 *
 * Regle centrale : a aucun instant il ne doit exister ZERO version valide.
 */

"use strict";

const assert = require("assert");
const h = require("./harness.js");
const ffs = require("./fake-cordova-fs.js");

const SID = "AAAA1111";
const SID2 = "BBBB2222";

function boot(disk) {
  const e = h.createEnv({});
  ffs.install(e, disk);
  h.loadAll(e, ["state/take-model.js", "state/session-model.js", "state/session-store.js"]);
  return e;
}

async function started(disk) {
  const e = boot(disk);
  await e.MultiCamSessionStore.loadAll();
  return e;
}

function makeSession(e, opts) {
  opts = opts || {};
  const s = e.MultiCamSessionModel.createSession(opts.name || "Session P0", {
    deviceId: opts.self || "A1",
    deviceName: "Master A"
  });
  if (opts.sid) s.sessionId = opts.sid;
  return s;
}

function addTake(e, s, n) {
  const t = e.MultiCamTakeModel.createFirstTake("B1", 1000);
  t.takeNumber = n;
  t.status = "STOPPED";
  t.captures = ["B1"];
  t.storages = ["C1"];
  t.summary = e.MultiCamTakeModel.sanitizeTakeSummary({
    stoppedAtMs: 5000,
    durationMs: 4000,
    stopReason: "manual",
    transferState: "done",
    transferBytes: 12345,
    transferTotal: 12345,
    transferPercent: 100,
    transfers: {
      "B1|C1": { sourceDeviceId: "B1", storageDeviceId: "C1", state: "done", bytes: 12345, total: 12345, percent: 100 }
    },
    stopStates: {
      B1: { deviceId: "B1", state: "STOPPED", stopId: "S1", actualMs: 5000, localTargetMs: 5000, deltaMs: 12.5, path: "/tmp/t1.mp4" }
    },
    replications: {
      "B1|C1": { sourceDeviceId: "B1", storageDeviceId: "C1", state: "done", bytes: 12345, total: 12345, percent: 100, error: "", updatedAtMs: 6000 }
    }
  });
  s.takes = (s.takes || []).filter((x) => x.takeNumber !== n).concat([t]);
  return s;
}

function texts(disk, sid) {
  return {
    primary: disk.get(sid + ".json"),
    tmp: disk.get(sid + ".json.tmp"),
    bak: disk.get(sid + ".json.bak")
  };
}

async function crashDuring(disk, stageName, act) {
  const e = await started(disk);
  e.MultiCamSessionStoreDebug = { enabled: true, stage: stageName, kill: true };
  await act(e);
  await h.flush(30);
  return e;
}

/* Enregistrement a l'appel (comme les autres suites) : evite le warning
 * "n'exporte pas register()" du runner et tout double enregistrement. */
function register() {
  h.describe("J16-P0 — ecriture atomique et recuperation", () => {
    h.it("T01 — ecriture nominale : primaire seul, contenu exact, aucun temporaire", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const s = makeSession(e, { sid: SID });
      await e.MultiCamSessionStore.save(s);
      const t = texts(disk, SID);
      assert.deepStrictEqual(JSON.parse(t.primary).sessionId, SID);
      assert.strictEqual(t.tmp, null, "aucun tmp apres succes");
      assert.strictEqual(t.bak, null, "pas de backup au premier enregistrement");
      assert.deepStrictEqual(disk.names(), [SID + ".json"]);
    });

    h.it("T02 — ecritures successives : primaire = n, backup = n-1", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const s = makeSession(e, { sid: SID, name: "v1" });
      await e.MultiCamSessionStore.save(s);
      s.name = "v2"; s.nameUpdatedMs += 1; s.updatedAtMs += 1;
      await e.MultiCamSessionStore.save(s);
      s.name = "v3"; s.nameUpdatedMs += 1; s.updatedAtMs += 1;
      await e.MultiCamSessionStore.save(s);
      const t = texts(disk, SID);
      assert.strictEqual(JSON.parse(t.primary).name, "v3");
      assert.strictEqual(JSON.parse(t.bak).name, "v2");
      assert.strictEqual(t.tmp, null);
      assert.deepStrictEqual(disk.names(), [SID + ".json", SID + ".json.bak"]);
    });

    h.it("T03 — interruption AVANT creation du temporaire : primaire intact", async () => {
      const disk = ffs.createDisk();
      const e0 = await started(disk);
      const s = makeSession(e0, { sid: SID, name: "v1" });
      await e0.MultiCamSessionStore.save(s);

      const e = boot(disk);
      await e.MultiCamSessionStore.loadAll();
      e.MultiCamSessionStoreDebug = { enabled: true, stage: "before_tmp", kill: true };
      s.name = "v2";
      e.MultiCamSessionStore.save(s); /* jamais resolu : mort */
      await h.flush(20);

      const r = await started(disk);
      const got = await r.MultiCamSessionStore.get(SID);
      assert.strictEqual(got.name, "v1");
      assert.strictEqual(texts(disk, SID).tmp, null, "aucun temporaire cree");
    });

    h.it("T04 — interruption PENDANT l'ecriture temporaire (tmp vide) : primaire intact", async () => {
      const disk = ffs.createDisk();
      const e0 = await started(disk);
      const s = makeSession(e0, { sid: SID, name: "v1" });
      await e0.MultiCamSessionStore.save(s);

      const e = boot(disk);
      await e.MultiCamSessionStore.loadAll();
      e.MultiCamSessionStoreDebug = { enabled: true, stage: "tmp_truncated", kill: true };
      s.name = "v2";
      e.MultiCamSessionStore.save(s);
      await h.flush(20);
      assert.strictEqual(disk.get(SID + ".json.tmp"), "", "tmp tronque, jamais complete");

      const r = await started(disk);
      const got = await r.MultiCamSessionStore.get(SID);
      assert.strictEqual(got.name, "v1");
      assert.strictEqual(disk.get(SID + ".json.tmp"), null, "tmp invalide nettoye");
    });

    h.it("T05 — interruption APRES ecriture temporaire : le tmp complet est promu", async () => {
      const disk = ffs.createDisk();
      const e0 = await started(disk);
      const s = makeSession(e0, { sid: SID, name: "v1" });
      await e0.MultiCamSessionStore.save(s);

      const e = boot(disk);
      await e.MultiCamSessionStore.loadAll();
      e.MultiCamSessionStoreDebug = { enabled: true, stage: "tmp_written", kill: true };
      s.name = "v2";
      e.MultiCamSessionStore.save(s);
      await h.flush(20);
      assert.strictEqual(JSON.parse(disk.get(SID + ".json.tmp")).name, "v2");

      const r = await started(disk);
      const got = await r.MultiCamSessionStore.get(SID);
      assert.strictEqual(got.name, "v2", "la derniere version complete survit");
      assert.strictEqual(JSON.parse(disk.get(SID + ".json")).name, "v2");
      assert.strictEqual(JSON.parse(disk.get(SID + ".json.bak")).name, "v1", "v1 conservee en backup");
      assert.strictEqual(disk.get(SID + ".json.tmp"), null);
    });

    h.it("T05b — interruption APRES verification du temporaire : idem", async () => {
      const disk = ffs.createDisk();
      const e0 = await started(disk);
      const s = makeSession(e0, { sid: SID, name: "v1" });
      await e0.MultiCamSessionStore.save(s);

      const e = boot(disk);
      await e.MultiCamSessionStore.loadAll();
      e.MultiCamSessionStoreDebug = { enabled: true, stage: "tmp_verified", kill: true };
      s.name = "v2";
      e.MultiCamSessionStore.save(s);
      await h.flush(20);

      const r = await started(disk);
      assert.strictEqual((await r.MultiCamSessionStore.get(SID)).name, "v2");
      assert.strictEqual(JSON.parse(disk.get(SID + ".json.bak")).name, "v1");
    });

    h.it("T06a — interruption apres suppression du backup, avant rotation : rien perdu", async () => {
      const disk = ffs.createDisk();
      const e0 = await started(disk);
      const s = makeSession(e0, { sid: SID, name: "v1" });
      await e0.MultiCamSessionStore.save(s);
      s.name = "v2"; s.updatedAtMs += 1;
      await e0.MultiCamSessionStore.save(s);

      const e = boot(disk);
      await e.MultiCamSessionStore.loadAll();
      e.MultiCamSessionStoreDebug = { enabled: true, stage: "bak_removed", kill: true };
      s.name = "v3";
      e.MultiCamSessionStore.save(s);
      await h.flush(20);
      assert.strictEqual(JSON.parse(disk.get(SID + ".json.bak") || "{}").name, undefined, "ancien backup retire");

      const r = await started(disk);
      assert.strictEqual((await r.MultiCamSessionStore.get(SID)).name, "v3");
      assert.strictEqual(JSON.parse(disk.get(SID + ".json.bak")).name, "v2");
    });

    h.it("T06b — interruption pendant le remplacement (primaire deplace, tmp pas encore) : tmp recupere", async () => {
      const disk = ffs.createDisk();
      const e0 = await started(disk);
      const s = makeSession(e0, { sid: SID, name: "v1" });
      await e0.MultiCamSessionStore.save(s);

      const e = boot(disk);
      await e.MultiCamSessionStore.loadAll();
      e.MultiCamSessionStoreDebug = { enabled: true, stage: "primary_moved", kill: true };
      s.name = "v2";
      e.MultiCamSessionStore.save(s);
      await h.flush(20);
      assert.strictEqual(disk.get(SID + ".json"), null, "primaire absent a ce point");
      assert.strictEqual(JSON.parse(disk.get(SID + ".json.bak")).name, "v1");
      assert.strictEqual(JSON.parse(disk.get(SID + ".json.tmp")).name, "v2");

      const r = await started(disk);
      assert.strictEqual((await r.MultiCamSessionStore.get(SID)).name, "v2");
      assert.strictEqual(JSON.parse(disk.get(SID + ".json.bak")).name, "v1");
    });

    h.it("T06c — interruption AU MILIEU du moveTo tmp→primaire (fallback copie) : tmp intact, primaire partiel ignore", async () => {
      const disk = ffs.createDisk();
      const e0 = await started(disk);
      const s = makeSession(e0, { sid: SID, name: "v1" });
      await e0.MultiCamSessionStore.save(s);

      disk.moveMode = "copy";
      disk.killAfterCopyBytes = 25;
      disk.killOnMove = 2; /* 1 = primaire→backup, 2 = tmp→primaire */
      const e = boot(disk);
      await e.MultiCamSessionStore.loadAll();
      s.name = "v2";
      e.MultiCamSessionStore.save(s);
      await h.flush(60);
      assert.ok(disk.get(SID + ".json") !== null && disk.get(SID + ".json").length === 25, "primaire partiel sur disque");
      assert.ok(disk.get(SID + ".json.tmp") && JSON.parse(disk.get(SID + ".json.tmp")).name === "v2", "tmp source intact");

      const r = await started(disk);
      const got = await r.MultiCamSessionStore.get(SID);
      assert.strictEqual(got.name, "v2", "un primaire partiel ne remplace jamais un tmp complet");
      assert.strictEqual(JSON.parse(disk.get(SID + ".json.bak")).name, "v1");
    });

    h.it("T06d — interruption AU MILIEU du moveTo primaire→backup (fallback copie) : primaire intact", async () => {
      const disk = ffs.createDisk();
      const e0 = await started(disk);
      const s = makeSession(e0, { sid: SID, name: "v1" });
      await e0.MultiCamSessionStore.save(s);

      disk.moveMode = "copy";
      disk.killAfterCopyBytes = 25;
      disk.killOnMove = 1;
      const e = boot(disk);
      await e.MultiCamSessionStore.loadAll();
      s.name = "v2";
      e.MultiCamSessionStore.save(s);
      await h.flush(60);
      assert.strictEqual(disk.moveCount, 1, "mort pendant le premier moveTo");
      assert.strictEqual(JSON.parse(disk.get(SID + ".json")).name, "v1", "la source (primaire) survit a la copie partielle");
      assert.strictEqual(disk.get(SID + ".json.tmp") !== null, true);

      const r = await started(disk);
      assert.strictEqual((await r.MultiCamSessionStore.get(SID)).name, "v2");
      assert.strictEqual(JSON.parse(disk.get(SID + ".json.bak")).name, "v1");
    });

    h.it("T07 — primaire valide + temporaire incomplet : primaire retenu, tmp nettoye", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const s = makeSession(e, { sid: SID, name: "v1" });
      await e.MultiCamSessionStore.save(s);
      disk.set(SID + ".json.tmp", '{"sessionId":"' + SID + '","name":"tronq');

      const r = await started(disk);
      assert.strictEqual((await r.MultiCamSessionStore.get(SID)).name, "v1");
      assert.strictEqual(disk.get(SID + ".json.tmp"), null);
    });

    h.it("T08 — primaire corrompu + backup valide : backup promu, aucune donnee inventee", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const s = makeSession(e, { sid: SID, name: "v1" });
      await e.MultiCamSessionStore.save(s);
      s.name = "v2"; s.updatedAtMs += 1;
      await e.MultiCamSessionStore.save(s);
      const good = disk.get(SID + ".json.bak");
      disk.set(SID + ".json", "\u0000\u0000\u0000");

      const r = await started(disk);
      const got = await r.MultiCamSessionStore.get(SID);
      assert.strictEqual(got.name, "v1");
      assert.strictEqual(disk.get(SID + ".json"), good, "primaire reecrit depuis le backup");
      assert.strictEqual(disk.get(SID + ".json.bak"), good, "le backup est conserve");
      assert.ok(r.logText().indexOf("SESSION_RECOVER") >= 0);
    });

    h.it("T08b — primaire corrompu + backup valide + tmp valide : le tmp (plus recent) gagne, backup conserve", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const s = makeSession(e, { sid: SID, name: "v1" });
      await e.MultiCamSessionStore.save(s);
      s.name = "v2"; s.updatedAtMs += 1;
      const v2 = JSON.stringify(s, null, 2);
      const v1 = disk.get(SID + ".json");
      disk.set(SID + ".json", "{cassé");
      disk.set(SID + ".json.bak", v1);
      disk.set(SID + ".json.tmp", v2);

      const r = await started(disk);
      assert.strictEqual((await r.MultiCamSessionStore.get(SID)).name, "v2");
      assert.strictEqual(JSON.parse(disk.get(SID + ".json.bak")).name, "v1");
      assert.strictEqual(disk.get(SID + ".json.tmp"), null);
    });

    h.it("T09 — erreur d'ecriture : la sauvegarde echoue, l'ancienne version reste, la suivante passe", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const s = makeSession(e, { sid: SID, name: "v1" });
      await e.MultiCamSessionStore.save(s);

      disk.failNext = { op: "write", code: 10 };
      s.name = "v2";
      await assert.rejects(() => e.MultiCamSessionStore.save(s));
      assert.strictEqual(JSON.parse(disk.get(SID + ".json")).name, "v1", "primaire intact");
      assert.strictEqual(disk.get(SID + ".json.tmp"), null, "tmp partiel nettoye par la reparation");

      s.name = "v3";
      await e.MultiCamSessionStore.save(s);
      assert.strictEqual(JSON.parse(disk.get(SID + ".json")).name, "v3");
      assert.strictEqual(JSON.parse(disk.get(SID + ".json.bak")).name, "v1");
    });

    h.it("T10 — ecritures concurrentes d'une meme session : serialisees, dernier appel gagne", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const a = makeSession(e, { sid: SID, name: "A" });
      const b = makeSession(e, { sid: SID, name: "B" });
      const p1 = e.MultiCamSessionStore.save(a);
      const p2 = e.MultiCamSessionStore.save(b);
      await Promise.all([p1, p2]);
      assert.strictEqual(JSON.parse(disk.get(SID + ".json")).name, "B");
      /* Aucun moveTo n'a ecrase une destination existante : on ne depend pas
       * de la semantique "remplace" de moveTo. */
      disk.ops.filter((o) => o.op === "moveTo").forEach((o) => {
        assert.strictEqual(o.destExisted, false, "moveTo vers une destination neuve");
      });
    });

    h.it("T11a — suppression pendant une sauvegarde en vol : aucune resurrection", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const s = makeSession(e, { sid: SID, name: "v1" });
      await e.MultiCamSessionStore.save(s);

      e.MultiCamSessionStoreDebug = { enabled: true, stage: "tmp_verified", delayMs: 40 };
      s.name = "v2";
      const pSave = e.MultiCamSessionStore.save(s);
      const pRemove = e.MultiCamSessionStore.remove(SID);
      await Promise.all([pSave, pRemove]);
      await h.flush(5);
      assert.deepStrictEqual(disk.names(), [], "plus aucun fichier");
      assert.strictEqual(await e.MultiCamSessionStore.get(SID), null, "cache purge");
    });

    h.it("T11b — sauvegarde apres suppression : ignoree (tombstone), aucun fichier recree", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const s = makeSession(e, { sid: SID, name: "v1" });
      await e.MultiCamSessionStore.save(s);
      await e.MultiCamSessionStore.remove(SID);
      await e.MultiCamSessionStore.save(s);
      await h.flush(5);
      assert.deepStrictEqual(disk.names(), []);
      assert.strictEqual(await e.MultiCamSessionStore.get(SID), null);
      assert.ok(e.logText().indexOf("SESSION_STORE_SAVE_SKIPPED") >= 0);
    });

    h.it("T12 — lecture apres redemarrage : contenu, membres et Takes intacts", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const s = makeSession(e, { sid: SID, name: "Session P0" });
      s.members = [{
        deviceId: "B1", deviceName: "Cam B", endpoint: "ws://b",
        enabledSkills: ["capture"], sessionRoles: ["capture"],
        addedAtMs: 1000, addedByDeviceId: "A1", roleUpdatedMs: 1000, roleByDeviceId: "A1"
      }];
      addTake(e, s, 1);
      addTake(e, s, 2);
      await e.MultiCamSessionStore.save(s);

      const r = await started(disk);
      const got = await r.MultiCamSessionStore.get(SID);
      assert.strictEqual(got.sessionId, SID);
      assert.strictEqual(got.name, "Session P0");
      assert.strictEqual(got.pin, s.pin);
      assert.deepStrictEqual(got.members.map((m) => m.deviceId), ["B1"]);
      assert.deepStrictEqual(got.takes.map((t) => t.takeNumber), [1, 2]);
    });

    h.it("T13 — retrocompatibilite d'une session J12 (sans stopStates/replications)", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const s = makeSession(e, { sid: SID, name: "Legacy J12" });
      s.state = "closed";
      s.members = [{
        deviceId: "B1", deviceName: "Cam B", endpoint: "",
        enabledSkills: ["capture"], sessionRoles: ["capture"],
        addedAtMs: 1000, addedByDeviceId: "A1", roleUpdatedMs: 1000, roleByDeviceId: "A1"
      }];
      addTake(e, s, 1);
      const raw = JSON.parse(JSON.stringify(s));
      delete raw.takes[0].summary.stopStates;
      delete raw.takes[0].summary.replications;
      disk.set(SID + ".json", JSON.stringify(raw, null, 2));

      const r = await started(disk);
      const got = await r.MultiCamSessionStore.get(SID);
      assert.strictEqual(got.name, "Legacy J12");
      assert.strictEqual(got.state, "closed");
      assert.strictEqual(got.pin, s.pin);
      assert.strictEqual(got.takes.length, 1);
      assert.strictEqual(got.takes[0].summary.transferState, "done");
      assert.deepStrictEqual(Object.keys(got.takes[0].summary.transfers), ["B1|C1"]);
      assert.strictEqual(JSON.stringify(got.takes[0].summary.stopStates), "{}");
      assert.strictEqual(JSON.stringify(got.takes[0].summary.replications), "{}");

      got.name = "Legacy J12 (renommee)";
      got.updatedAtMs += 1;
      await r.MultiCamSessionStore.save(got);
      const r2 = await started(disk);
      assert.strictEqual((await r2.MultiCamSessionStore.get(SID)).name, "Legacy J12 (renommee)");
    });

    h.it("T14 — les champs J16-A (stopStates, replications) survivent a sauvegarde et redemarrage", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const s = makeSession(e, { sid: SID });
      addTake(e, s, 1);
      await e.MultiCamSessionStore.save(s);

      const r = await started(disk);
      const got = await r.MultiCamSessionStore.get(SID);
      const sum = got.takes[0].summary;
      assert.strictEqual(sum.stopStates.B1.state, "STOPPED");
      assert.strictEqual(sum.stopStates.B1.deltaMs, 12.5);
      assert.strictEqual(sum.replications["B1|C1"].state, "done");
      assert.strictEqual(sum.replications["B1|C1"].percent, 100);
    });

    h.it("T15 — plusieurs sessions independantes : une corruption n'affecte pas les autres", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const s1 = makeSession(e, { sid: SID, name: "S1" });
      const s2 = makeSession(e, { sid: SID2, name: "S2" });
      await Promise.all([e.MultiCamSessionStore.save(s1), e.MultiCamSessionStore.save(s2)]);
      disk.set(SID + ".json", "corrompu");

      const r = await started(disk);
      assert.strictEqual(await r.MultiCamSessionStore.get(SID), null);
      assert.strictEqual((await r.MultiCamSessionStore.get(SID2)).name, "S2");
      assert.strictEqual((await r.MultiCamSessionStore.list()).length, 1);
    });

    h.it("T16 — aucun fichier recuperable (cas G) : rien n'est fabrique, fichiers conserves", async () => {
      const disk = ffs.createDisk();
      disk.set(SID + ".json", "pas du json");
      disk.set(SID + ".json.tmp", "non plus");
      const r = await started(disk);
      assert.strictEqual(await r.MultiCamSessionStore.get(SID), null);
      assert.deepStrictEqual((await r.MultiCamSessionStore.list()), []);
      assert.ok(disk.has(SID + ".json"), "fichier non supprime (aucune destruction)");
      assert.ok(disk.has(SID + ".json.tmp"), "temporaire non supprime");
      assert.ok(r.logText().indexOf("SESSION_RECOVER_NONE sid=" + SID) >= 0);
    });

    h.it("T17 — sessionId incoherent avec le nom de fichier : version refusee, jamais servie sous un autre id", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const s = makeSession(e, { sid: SID, name: "v1" });
      await e.MultiCamSessionStore.save(s);
      const good = disk.get(SID + ".json");
      const bad = JSON.parse(good);
      bad.sessionId = "ZZZZ9999";
      disk.set(SID + ".json", JSON.stringify(bad));
      disk.set(SID + ".json.bak", good);

      const r = await started(disk);
      const got = await r.MultiCamSessionStore.get(SID);
      assert.strictEqual(got.name, "v1");
      assert.strictEqual(got.sessionId, SID);
      assert.strictEqual(await r.MultiCamSessionStore.get("ZZZZ9999"), null);
    });

    h.it("T18 — succes : aucun mouvement vers une destination existante, aucun temporaire residuel", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const s = makeSession(e, { sid: SID, name: "v1" });
      await e.MultiCamSessionStore.save(s);
      s.name = "v2"; s.updatedAtMs += 1;
      await e.MultiCamSessionStore.save(s);
      assert.deepStrictEqual(disk.names(), [SID + ".json", SID + ".json.bak"]);
      disk.ops.filter((o) => o.op === "moveTo").forEach((o) => {
        assert.strictEqual(o.destExisted, false);
      });
    });

    h.it("T19 — suppression : primaire, temporaire et backup sont tous retires", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const s = makeSession(e, { sid: SID, name: "v1" });
      await e.MultiCamSessionStore.save(s);
      s.name = "v2"; s.updatedAtMs += 1;
      await e.MultiCamSessionStore.save(s);
      disk.set(SID + ".json.tmp", "residu");
      await e.MultiCamSessionStore.remove(SID);
      assert.deepStrictEqual(disk.names(), []);
    });

    h.it("T20 — premiere sauvegarde d'une session heritee : le fichier existant devient le backup", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const s = makeSession(e, { sid: SID, name: "legacy" });
      await e.MultiCamSessionStore.save(s);
      const legacy = disk.get(SID + ".json");
      const r = await started(disk);
      const got = await r.MultiCamSessionStore.get(SID);
      got.name = "modifiee";
      got.updatedAtMs += 1;
      await r.MultiCamSessionStore.save(got);
      assert.strictEqual(disk.get(SID + ".json.bak"), legacy);
      assert.strictEqual(JSON.parse(disk.get(SID + ".json")).name, "modifiee");
    });

    h.it("T21 — recuperation idempotente : deux demarrages consecutifs donnent le meme resultat", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const s = makeSession(e, { sid: SID, name: "v1" });
      await e.MultiCamSessionStore.save(s);
      disk.set(SID + ".json.tmp", JSON.stringify(Object.assign({}, s, { name: "v2" }), null, 2));
      disk.set(SID + ".json", "corrompu");

      const r1 = await started(disk);
      const a = await r1.MultiCamSessionStore.get(SID);
      const snap1 = JSON.stringify(disk.files);
      const r2 = await started(disk);
      const b = await r2.MultiCamSessionStore.get(SID);
      assert.strictEqual(a.name, "v2");
      assert.strictEqual(b.name, "v2");
      assert.strictEqual(disk.get(SID + ".json.tmp"), null);
      assert.strictEqual(JSON.stringify(disk.files), snap1);
    });

    h.it("T22 — mode web (localStorage) : suppression puis sauvegarde ne ressuscite pas", async () => {
      const e = h.createEnv({});
      h.loadAll(e, ["state/take-model.js", "state/session-model.js", "state/session-store.js"]);
      const s = makeSession(e, { sid: SID, name: "web" });
      await e.MultiCamSessionStore.save(s);
      await e.MultiCamSessionStore.remove(SID);
      await e.MultiCamSessionStore.save(s);
      e.MultiCamSessionStore.resetCache();
      assert.strictEqual(await e.MultiCamSessionStore.get(SID), null);
    });

    h.it("T23 — instrumentation INERTE sans injection : aucun stage journalise", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const s = makeSession(e, { sid: SID });
      await e.MultiCamSessionStore.save(s);
      assert.strictEqual(e.MultiCamSessionStoreDebug, undefined);
      assert.ok(e.logText().indexOf("SESSION_STORE_STAGE") < 0);
    });

    h.it("T24 — backup non ecrase par un primaire corrompu : le bon backup survit", async () => {
      const disk = ffs.createDisk();
      const e = await started(disk);
      const s = makeSession(e, { sid: SID, name: "v1" });
      await e.MultiCamSessionStore.save(s);
      s.name = "v2"; s.updatedAtMs += 1;
      await e.MultiCamSessionStore.save(s);
      const goodBak = disk.get(SID + ".json.bak");
      disk.set(SID + ".json", "{cassé");

      /* Premiere lecture : le backup est promu ; une nouvelle sauvegarde ne doit
       * jamais transformer le fichier corrompu en "backup". */
      const r = await started(disk);
      const got = await r.MultiCamSessionStore.get(SID);
      got.name = "v3";
      got.updatedAtMs += 1;
      await r.MultiCamSessionStore.save(got);
      assert.strictEqual(JSON.parse(disk.get(SID + ".json")).name, "v3");
      assert.strictEqual(disk.get(SID + ".json.bak"), goodBak);
    });
  });
}

module.exports = { register: register };
