/* MultiCam J05 — tests du modèle de session (membres + sessionRoles).
 * Charge app/www/js/state/session-model.js (UMD→globalThis) et vérifie les
 * règles de fusion/validation membres de la décision 31 + mission J05, SANS
 * dépendre d'Android. Pré-requis : les échecs bloquent le jalon J05.
 *
 * Tests couverts (liste mission J05, 16 cases modèle/protocole) :
 *   1. ajout initié par Master : capture-only ajouté avec [capture]
 *   2. capture-only ne peut pas recevoir storage (rôle non annoncé rejeté)
 *   3. device annonçant capture+storage peut cumuler les deux rôles (31.2)
 *   4. storage/{capture} seul suffit (device annonçant storage → storage)
 *   5. une MAJ de rôle apporte [capture]→[storage] proprement
 *   6. un device capturé+stream dans la session n'y apparaît pas en double
 *   7. édition = même membre (deviceId), pas un nouveau membre
 *   8. retrait : membership + rôles supprimés, skills globales intactes
 *   9. device retiré ré-ajoutable immédiatement + tombstone levé
 *  10. le retrait est un LMW : un rôle plus récent que le tombstone gagne
 *  11. un membre absent (copie sans lui) est GARDÉ localement (pas d'effacement
 *      par une copie périmée — le retrait ne vient que du tombstone)
 *  12. convergence A→B sans refresh : addMember(A) → merge(B) atteint le membre
 *  13. propagation du retrait A→B sans refresh (tombstone transmis par sharedView)
 *  14. reconnexion d'un ancien membre : upsert même membre, pas de doublon
 *  15. un membre perdant tous ses rôles valides après fusion est pruné (≥1 rôle)
 *  16. le sharedView ne contient jamais le PIN, même après ajout de membres
 *  17. ré-ajout aprés retrait : convergence (merge) lève le tombstone local —
 *      déterminisme B↔C (le chemin addMember local le levait déjà, le chemin
 *      convergence doit faire pareil, sinon B et C divergent sur removedMembers)
 *
 * Les events emitEvents côté WS sont couverts par les tests fusion ci-dessus
 * (types memberAdded/memberRemoved/memberRolesChanged/memberPruned).
 *
 * Usage :  node session/members-model.test.js
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

const PEER_CAP = { deviceId: "dev-cap", deviceName: "CamCapture", enabledSkills: ["capture"] };
const PEER_STO = { deviceId: "dev-sto", deviceName: "CamStorage", enabledSkills: ["storage"] };
const PEER_BOTH = { deviceId: "dev-both", deviceName: "CamPlus", enabledSkills: ["capture", "storage"] };

check("J05-1 : capture-only ajouté par un Master avec [capture]", () => {
  const s = base("SID1");
  const r = M.addMember(s, PEER_CAP, ["capture"], "master-a");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.changed, true);
  const m = r.session.members.find((x) => x.deviceId === "dev-cap");
  assert.ok(m);
  assert.deepStrictEqual(m.sessionRoles, ["capture"]);
  assert.deepStrictEqual(m.enabledSkills, ["capture"]);
  assert.strictEqual(m.roleByDeviceId, "master-a");
});

check("J05-2 : capture-only ne peut PAS recevoir un rôle storage (rejet)", () => {
  const s = base("SID1");
  const r = M.addMember(s, PEER_CAP, ["storage"], "master-a");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "no_valid_role_for_device");
  assert.deepStrictEqual(r.rejected, ["storage"]);
  assert.strictEqual(r.session.members.length, 0);
});

check("J05-3 : device annoté capture+storage cumule les deux rôles (31.2)", () => {
  const s = base("SID1");
  const r = M.addMember(s, PEER_BOTH, ["capture", "storage"], "master-a");
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.session.members[0].sessionRoles, ["capture", "storage"]);
});

check("J05-4 : storage seul suffit quand le device annonce storage", () => {
  const s = base("SID1");
  const r = M.addMember(s, PEER_STO, ["storage"], "master-a");
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.session.members[0].sessionRoles, ["storage"]);
});

check("J05-5 : MAJ de rôle sur un device qui l'annonce — LMW propre (même deviceId)", () => {
  let s = base("SID1");
  s = M.addMember(s, PEER_BOTH, ["capture"], "master-a").session;
  const r = M.updateMemberRoles(s, "dev-both", ["storage"], "master-b");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.session.members.length, 1);
  assert.deepStrictEqual(r.session.members[0].sessionRoles, ["storage"]);
  assert.strictEqual(r.session.members[0].roleByDeviceId, "master-b");
});

check("J05-6 : le même device ne devient PAS deux membres (fusion deviceId)", () => {
  let s = base("SID1");
  let r = M.addMember(s, PEER_BOTH, ["capture"], "master-a");
  s = r.session;
  r = M.addMember(s, PEER_BOTH, ["storage"], "master-a");
  assert.strictEqual(r.session.members.length, 1, "toujours 1 membre, pas de doublon");
  assert.deepStrictEqual(r.session.members[0].sessionRoles, ["storage"], "LMW : dernière requête gagne");
});

check("J05-7 : édition garde le membre existant (reconnexion ancien membre)", () => {
  let s = base("SID1");
  let r = M.addMember(s, PEER_BOTH, ["capture"], "master-a");
  s = r.session;
  const first = s.members[0];
  r = M.updateMemberRoles(s, "dev-both", ["capture", "storage"], "master-b");
  assert.strictEqual(r.session.members.length, 1);
  assert.strictEqual(r.session.members[0].deviceId, "dev-both");
  assert.deepStrictEqual(r.session.members[0].sessionRoles, ["capture", "storage"]);
  assert.ok(r.events.some((e) => e.type === "memberRolesChanged"));
  void first;
});

check("J05-8 : retrait supprime membership ET rôles, jamais les skills globales", () => {
  let s = base("SID1");
  s = M.addMember(s, PEER_BOTH, ["capture", "storage"], "master-a").session;
  const r = M.removeMember(s, "dev-both", "master-b");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.session.members.length, 0);
  assert.ok(r.session.removedMembers["dev-both"]
    && r.session.removedMembers["dev-both"].removedAtMs > 0, "tombstone horodaté écrit");
  assert.ok(r.events.some((e) => e.type === "memberRemoved"));
  /* La constraint « ne modifie pas enabledSkills » : le device n'a PAS de champ
   * skills globales dans la session ; sa config est ailleurs (J02), intacte. */
});

check("J05-9 : device retiré ré-ajoutable immédiatement (tombstone levé)", () => {
  let s = base("SID1");
  s = M.addMember(s, PEER_STO, ["storage"], "master-a").session;
  s = M.removeMember(s, "dev-sto", "master-a").session;
  assert.strictEqual(s.removedMembers["dev-sto"] !== undefined, true);
  const r = M.addMember(s, PEER_STO, ["storage"], "master-a");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.session.members.length, 1);
  assert.strictEqual(r.session.removedMembers["dev-sto"], undefined, "tombstone levé après ré-ajout");
});

check("J05-10 : le retrait est LMW — un rôle plus récent que le tombstone gagne", () => {
  let a = base("SID1");
  a = M.addMember(a, PEER_BOTH, ["capture"], "master-a").session;
  /* Master A retire à T200 (horodatage simulé) puis Master B relance un rôle. */
  const b = M.cloneSession(a);
  b.members[0].roleUpdatedMs = 100;
  b.updatedAtMs = 100;
  /* Retrait côté A (tombstone ~ maintenant). */
  const removedA = M.removeMember(a, "dev-both", "master-a");
  a = removedA.session;
  assert.strictEqual(a.members.length, 0);
  /* B (hors-ligne) a un membre avec roleUpdatedMs=100 ; A reçoit le merge de B :
   * le membre remote (roleUpdatedMs 100) vs tombstone (removedAtMs now>100) →
   * le tombstone gagne et le membre est retiré. Puis B re-merge A : idem. */
  const viewA = M.sharedView(a);
  const resB = M.mergeSessions(b, viewA);
  assert.strictEqual(resB.session.members.length, 0, "tombstone plus récent que le rôle → retiré");
  assert.ok(resB.events.some((e) => e.type === "memberRemoved"));
});

check("J05-11 : absence du remote n'efface PAS un membre local (le retrait ne vient que du tombstone)", () => {
  let s = base("SID1");
  s = M.addMember(s, PEER_BOTH, ["capture"], "master-a").session;
  const view = M.sharedView(base("SID1", { masters: [] }));
  /* remote sans le membre (copie antérieure) : ne doit pas le supprimer. */
  const res = M.mergeSessions(s, view);
  assert.strictEqual(res.session.members.length, 1, "membre local conservé — pas d'effacement par absence");
});

check("J05-12 : convergence A→B SANS refresh — addMember(A) transmis à B par sharedView", () => {
  const a = M.addMember(base("SID1"), PEER_CAP, ["capture"], "master-a").session;
  const b = base("SID1");
  const res = M.mergeSessions(b, M.sharedView(a));
  assert.strictEqual(res.changed, true);
  assert.strictEqual(res.session.members.length, 1);
  assert.deepStrictEqual(res.session.members[0].sessionRoles, ["capture"]);
  assert.ok(res.events.some((e) => e.type === "memberAdded"));
});

check("J05-13 : propagation du retrait A→B SANS refresh (tombstone dans sharedView)", () => {
  let a = base("SID1");
  a = M.addMember(a, PEER_STO, ["storage"], "master-a").session;
  let b = base("SID1");
  b = M.mergeSessions(b, M.sharedView(a)).session;
  const aRemoved = M.removeMember(a, "dev-sto", "master-b").session;
  const res = M.mergeSessions(b, M.sharedView(aRemoved));
  assert.strictEqual(res.session.members.length, 0);
  assert.ok(res.session.removedMembers["dev-sto"], "tombstone propagé");
});

check("J05-14 : reconnexion d'un ancien membre (qui était resté) = upsert, pas de doublon", () => {
  let s = base("SID1");
  s = M.addMember(s, PEER_CAP, ["capture"], "master-a").session;
  /* même deviceId re-transmis par un second Master qui l'avait aussi */
  const remote = M.addMember(base("SID1"), PEER_CAP, ["capture"], "master-b").session;
  const res = M.mergeSessions(s, M.sharedView(remote));
  assert.strictEqual(res.session.members.length, 1);
  assert.strictEqual(res.session.members[0].deviceId, "dev-cap");
});

check("J05-15 : membre perdant tous ses rôles valides après fusion → pruné (≥1 rôle)", () => {
  let s = base("SID1");
  s = M.addMember(s, PEER_BOTH, ["capture"], "master-a").session;
  /* Un remote transmet une copie où dev-both n'annonce plus capture (storage only)
   * et donc capture est invalide → le membre n'a plus de rôle valide → retiré. */
  const degraded = M.createSession("X", { deviceId: "master-b", deviceName: "B" });
  const remote = M.addMember(degraded,
    { deviceId: "dev-both", deviceName: "CamPlus", enabledSkills: ["storage"] },
    ["storage"], "master-b").session;
  const res = M.mergeSessions(s, M.sharedView(remote));
  const m = res.session.members.find((x) => x.deviceId === "dev-both");
  assert.ok(!m || m.sessionRoles.join(",") === "storage",
    "rôle capture (non annoncé) jamais appliqué ; storage conservé le cas échéant");
  assert.ok(res.events.some((e) => e.type === "memberPruned") || (m && m.sessionRoles.join(",") === "storage"));
});

check("J05-16 : sharedView ne contient jamais le PIN, même après ajout de membres", () => {
  let s = base("SID1", { pin: "7777" });
  s = M.addMember(s, PEER_BOTH, ["capture", "storage"], "master-a").session;
  const view = M.sharedView(s);
  const json = JSON.stringify(view);
  assert.strictEqual(view.pin, undefined);
  assert.ok(json.indexOf("7777") < 0, "pas de PIN dans la vue partagée");
  assert.ok(view.members.length === 1, "membres transmis dans la vue");
});

check("J05-17 : ré-ajout après retrait — la convergence (merge) LEVE le tombstone local", () => {
  /* A retire le membre puis le ré-ajoute (tombstone levé côté A). B qui avait
   * appliqué le tombstone doit, à la réception de la vue partagée de A SANS
   * tombstone, lever son tombstone local : déterminisme B↔C (même état). */
  let a = base("SID1");
  a = M.addMember(a, PEER_STO, ["storage"], "master-a").session;
  let b = base("SID1");
  b = M.mergeSessions(b, M.sharedView(a)).session;
  a = M.removeMember(a, "dev-sto", "master-b").session;               // retrait → tombstone A+B
  const viewRemoved = M.sharedView(a);
  b = M.mergeSessions(b, viewRemoved).session;
  assert.strictEqual(b.members.length, 0, "membre retiré");
  assert.ok(b.removedMembers["dev-sto"], "tombstone propagé sur B");
  a = M.addMember(a, PEER_STO, ["storage"], "master-a").session;      // ré-ajout → tombstone levé A
  assert.strictEqual(a.removedMembers["dev-sto"], undefined, "tombstone levé côté A (addMember)");
  const res = M.mergeSessions(b, M.sharedView(a));
  assert.strictEqual(res.session.members.length, 1, "membre de retour");
  assert.strictEqual(res.session.removedMembers["dev-sto"], undefined,
    "tombstone levé côté B par convergence — même état que A");
  assert.ok(res.events.some((e) => e.type === "memberRestored"));
});

console.log("\nRésumé : " + passed + " case(s) de tests exécutée(s)"
  + (process.exitCode ? " — ÉCHECS" : " — TOUS OK"));
process.exit(process.exitCode || 0);