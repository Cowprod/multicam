/* MultiCam — sanity Node du modèle de session (décisions 30.9).
 * Charge app/www/js/state/session-model.js (UMD→globalThis) et vérifie les règles
 * de fusion sans dépendre d'Android. Pré-requis J04 : les échecs bloquent le jalon.
 *
 * Usage :  node session/merge-model.test.js
 */

"use strict";

const path = require("path");
const assert = require("assert");
const MODEL_PATH = path.resolve(__dirname, "../../../app/www/js/state/session-model.js");

const M = require(MODEL_PATH);

if (!M) {
  console.error("FAIL MultiCamSessionModel introuvable après require");
  process.exit(1);
}

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("PASS " + name);
  } catch (err) {
    console.error("FAIL " + name + " — " + err.message);
    process.exitCode = 1;
  }
}

function base(sessionId, overrides) {
  const now = M.nowMs();
  return M.sanitizeSession(Object.assign({
    sessionId: sessionId,
    name: "S1",
    pin: "4281",
    state: "open",
    createdAtMs: now,
    updatedAtMs: now,
    masters: []
  }, overrides || {}));
}

check("createSession génère un PIN à 4 chiffres", () => {
  const s = M.createSession("Interview Studio A", { deviceId: "dev-a", deviceName: "Cam A" });
  assert.ok(/^\d{4}$/.test(s.pin));
  assert.strictEqual(s.name, "Interview Studio A");
  assert.strictEqual(s.state, "open");
  assert.strictEqual(s.masters.length, 1);
  assert.strictEqual(s.masters[0].deviceId, "dev-a");
});

check("sharedView ne contient jamais le PIN", () => {
  const s = base("SID1", { pin: "9999" });
  const view = M.sharedView(s);
  assert.strictEqual(view.pin, undefined);
  assert.strictEqual(JSON.stringify(view).indexOf("9999"), -1);
});

check("closed gagne ABSOLUMENT sur open (30.9.1)", () => {
  const local = base("SID1", { state: "open" });
  const remote = base("SID1", { state: "closed" });
  const res = M.mergeSessions(local, remote);
  assert.strictEqual(res.changed, true);
  assert.strictEqual(res.session.state, "closed");
  assert.ok(res.events.some((e) => e.type === "close"));

  const back = M.mergeSessions(res.session, base("SID1", { state: "open", nameUpdatedMs: M.nowMs() + 1000 }));
  assert.strictEqual(back.session.state, "closed", "une copie open hors-ligne ne ressuscite pas");
});

check("rename : latest modification wins (LMW)", () => {
  const local = base("SID1", { name: "A", nameUpdatedMs: 100, nameByDeviceId: "dev-a" });
  const remote = base("SID1", { name: "B", nameUpdatedMs: 200, nameByDeviceId: "dev-b" });
  const res = M.mergeSessions(local, remote);
  assert.strictEqual(res.session.name, "B");
  assert.ok(res.events.some((e) => e.type === "rename" && e.to === "B"));
});

check("PIN : immuable, désaccord = conflit + PIN local gardé", () => {
  const local = base("SID1", { pin: "1111" });
  const remote = base("SID1", { pin: "9999" });
  const res = M.mergeSessions(local, remote);
  assert.strictEqual(res.session.pin, "1111");
  assert.ok(res.events.some((e) => e.type === "conflict" && e.field === "pin"));
});

check("masters : fusion par deviceId (identité = deviceId)", () => {
  const local = base("SID1", {
    masters: [{ deviceId: "dev-a", deviceName: "A", joinedAtMs: 1 }]
  });
  const remote = base("SID1", {
    masters: [
      { deviceId: "dev-a", deviceName: "A-renamed", joinedAtMs: 1 },
      { deviceId: "dev-b", deviceName: "B", joinedAtMs: 2 }
    ]
  });
  const res = M.mergeSessions(local, remote);
  const ids = res.session.masters.map((m) => m.deviceId).sort();
  assert.deepStrictEqual(ids, ["dev-a", "dev-b"]);
  assert.ok(res.events.some((e) => e.type === "masterAdded" && e.deviceId === "dev-b"));
});

check("upsertMaster add + upsert rafraîchit endpoint sans dupliquer", () => {
  let s = base("SID1");
  let r = M.upsertMaster(s, { deviceId: "dev-x", deviceName: "X", endpoint: "10.0.0.5:45102", joinedAtMs: 3 });
  assert.strictEqual(r.session.masters.length, 1);
  const r2 = M.upsertMaster(r.session, { deviceId: "dev-x", deviceName: "X", endpoint: "10.0.0.9:45102" });
  assert.strictEqual(r2.session.masters.length, 1);
  assert.strictEqual(r2.session.masters[0].endpoint, "10.0.0.9:45102");
});

check("merge idempotent : états strictement identiques → changed:false, updatedAtMs intact (flake corrigé)", () => {
  const realNow = Date.now;
  try {
    let fakeNow = 987654321000;
    Date.now = () => fakeNow;
    const a = base("SID1");
    const b = M.sanitizeSession(JSON.parse(JSON.stringify(a))); /* strictement identique */
    const tLocal = a.updatedAtMs;
    const r1 = M.mergeSessions(a, b);
    assert.strictEqual(r1.changed, false, "1er merge d'états identiques = no-op");
    assert.strictEqual(r1.session.updatedAtMs, tLocal, "updatedAtMs non avancé (1er merge)");
    assert.strictEqual(r1.events.length, 0, "aucun event sur merge identique");
    fakeNow += 10000; /* Date.now() avance de 10 ms entre les deux merges */
    const r2 = M.mergeSessions(a, b);
    assert.strictEqual(r2.changed, false, "re-merge après ≥1 ms reste no-op (idempotence)");
    assert.strictEqual(r2.session.updatedAtMs, tLocal, "updatedAtMs jamais avancé artificiellement par l'heure du merge");
    assert.strictEqual(JSON.stringify(r1.session), JSON.stringify(r2.session), "résultats des deux merges identiques");
  } finally {
    Date.now = realNow;
  }
});

check("merge : un état réellement plus récent fait avancer updatedAtMs (LMW conservé)", () => {
  const realNow = Date.now;
  try {
    let fakeNow = 111111111000;
    Date.now = () => fakeNow;
    const older = base("SID1", { updatedAtMs: 1000, name: "A", nameUpdatedMs: 100, nameByDeviceId: "dev-a" });
    const newer = base("SID1", { updatedAtMs: 9000, name: "B", nameUpdatedMs: 8000, nameByDeviceId: "dev-b" });
    const res = M.mergeSessions(older, newer);
    assert.strictEqual(res.changed, true, "état plus récent → changé");
    assert.strictEqual(res.session.name, "B", "LMW du nom préservé");
    assert.ok(res.session.updatedAtMs >= newer.updatedAtMs, "updatedAtMs a avancé avec l'état réellement intégré");
    assert.strictEqual(res.session.updatedAtMs, Math.max(older.updatedAtMs, newer.updatedAtMs, fakeNow), "max sémantique conservé");
  } finally {
    Date.now = realNow;
  }
});

console.log("\nRésumé : " + passed + " groupe(s) de tests exécuté(s)"
  + (process.exitCode ? " — ÉCHECS" : " — TOUS OK"));
process.exit(process.exitCode || 0);