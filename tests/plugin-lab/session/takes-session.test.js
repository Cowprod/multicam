/* MultiCam J06 — tests de l'intégration des Takes + télémétrie dans le modèle
 * de session (session-model.js). Vérifie que J04/J05 restent intacts (takes
 * additive, télémétrie additive) et que la synchronisation multi-Master des
 * Takes est déterministe et sans régression du sharedView (PIN jamais exposé).
 *
 * Cases couvertes (mission J06) :
 *  1. une session J04/J05 existante (ré-ouverte) reste valide → takes: [] ;
 *  2. upsertTake : ajout, remplacement, no-op (contournement de rebond) ;
 *  3. newTake : héritage du précédent + numérotation déterministe ;
 *  4. mergeSessions B←C : un Take modifié côté remote est adopté (LMW) ;
 *  5. mergeSessions C←B : l'ordre de fusion n'a pas d'importance (déterminisme) ;
 *  6. old → nouveau : la télémétrie d'un membre est adoptée indépendamment de
 *     ses rôles (rôles conservés, télémétrie mise à jour) ;
 *  7. les Takes/Télémétrie passent par le sharedView mais JAMAIS le PIN ;
 *  8. updateMemberTelemetry : refusé pour un device non membre.
 *
 * Usage :  node session/takes-session.test.js
 */

"use strict";

const path = require("path");
const assert = require("assert");
const M = require(path.resolve(__dirname, "../../../app/www/js/state/session-model.js"));

const T0 = 1700000000000;
const B = "device-B";
const C = "device-C";
const M1 = "device-1"; /* capture, device B */
const M2 = "device-2"; /* storage, device C */

function mkSession(actor, sid, atMs) {
  return M.createSession("Session test", {
    deviceId: actor, deviceName: actor, endpoint: "ws://127.0.0.1:1", joinedAtMs: atMs
  });
}

function addCapture(session, did, by) {
  return M.addMember(session, { deviceId: did, deviceName: did, enabledSkills: ["capture"] }, ["capture"], by || session.self || "");
}

/* ---------- 1. session J04/J05 ré-ouverte → takes [] ---------- */
{
  const s = mkSession(B, "s1", T0);
  const s2 = addCapture(s, M1, B);
  assert.deepStrictEqual(s2.session.takes, [], "takes initialisés à [] (additif, pas de migration destructive)");
  assert.deepStrictEqual(s2.session.members.map((m) => m.deviceId), [M1], "membres J04/J05 inchangés");
}

/* ---------- 2. upsertTake : ajout / remplacement / no-op ---------- */
{
  let r = mkSession(B, "s2", T0);
  r = addCapture(r, M1, B);
  let s = r.session;
  const t1 = s.takes.length ? s.takes[0] : null;
  const first = t1 || M.takeModel.createFirstTake(B, T0);
  const add = M.upsertTake(s, first, B);
  assert.strictEqual(add.changed, true);
  assert.strictEqual(add.session.takes.length, 1);
  assert.strictEqual(add.events[0].type, "takeAdded");
  assert.strictEqual(add.session.takes[0].createdAtMs, T0);
  /* même take resoumis identique → no-op */
  const noop = M.upsertTake(add.session, first, B);
  assert.strictEqual(noop.changed, false, "resoumission identique = no-op");
  /* modification → remplacement */
  const mod = M.takeModel.setSetting(first, "resolution", "4K", B, T0 + 1);
  const repl = M.upsertTake(add.session, mod, B);
  assert.strictEqual(repl.changed, true);
  assert.strictEqual(repl.events[0].type, "takeChanged");
  assert.strictEqual(repl.session.takes[0].settings.video.resolution, "4K");
  /* take invalide refusé */
  const bad = M.upsertTake(add.session, { takeNumber: "x" }, B);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.error, "invalid_take");
}

/* ---------- 3. newTake : héritage + numérotation ---------- */
{
  let s = mkSession(B, "s3", T0);
  s = addCapture(s, M1, B).session;
  const nt0 = M.newTake(s, B);
  assert.strictEqual(nt0.ok, true);
  assert.strictEqual(nt0.takeNumber, 1);
  assert.strictEqual(nt0.session.takes.length, 1);
  assert.deepStrictEqual(nt0.session.takes[0].captures, []);
  /* une capture puis nouveau take */
  let s2 = addCapture(nt0.session, M1, B).session;
  const up = M.upsertTake(s2, M.takeModel.setCapture(M.takeModel.takeAt(s2.takes || [], 1), M1, true, B, T0 + 1), B);
  s2 = up.session;
  const nt1 = M.newTake(s2, B);
  assert.strictEqual(nt1.takeNumber, 2);
  assert.deepStrictEqual(nt1.session.takes[1].captures, [M1], "Take 002 hérite des captures de 001");
  assert.notStrictEqual(nt1.session.takes[0], nt1.session.takes[1]);
}

/* ---------- 4/5. mergeSessions : propagation des Takes B↔C, déterministe ---------- */
{
  let sb = mkSession(B, "s4", T0);
  sb = addCapture(sb, M1, B).session;
  /* C rejoint en tant que second Master via le sharedView de B (mêmes
   * métadonnées membres, comme dans le flux réel broadcast). */
  let sc = M.mergeSessions(mkSession(C, "s4", T0), M.sharedView(sb)).session;
  sb = M.upsertTake(sb, M.takeModel.createFirstTake(B, T0), B).session;
  sc = M.upsertTake(sc, M.takeModel.createFirstTake(C, T0), C).session;
  /* C modifie le Take 001 (résolution 4K) — plus récent que B's */
  const edited = M.takeModel.setSetting(M.takeModel.takeAt(sc.takes, 1), "resolution", "4K", C, T0 + 100);
  sc = M.upsertTake(sc, edited, C).session;
  /* B fusionne C → adopte la résolution 4K */
  const resB = M.mergeSessions(sb, M.sharedView(sc));
  assert.strictEqual(resB.changed, true, "B voit le changement");
  assert.strictEqual(resB.session.takes[0].settings.video.resolution, "4K", "B adopte l'édition de C");
  /* C fusionne B (qui n'a rien de plus récent) → reste sémantiquement stable.
   * Côté protocole, le garde-fou anti-rebond est semanticEqual (session-ws) :
   * une fusion qui ne change Rien de sémantique n'est jamais re-sauvée ni
   * re-broadcastée. On reproduit ici ce comparateur (champs sémantiques partagés)
   * sur les Takes + membres. */
  const resC = M.mergeSessions(sc, M.sharedView(resB.session));
  const semanticEqual = (a, b) => {
    if (JSON.stringify(a.takes || []) !== JSON.stringify(b.takes || [])) return false;
    const am = (a.members || []).map((m) => [m.deviceId, m.deviceName, (m.sessionRoles || []).join(","), m.addedAtMs, m.roleUpdatedMs, JSON.stringify(m.telemetry || null)].join("|"));
    const bm = (b.members || []).map((m) => [m.deviceId, m.deviceName, (m.sessionRoles || []).join(","), m.addedAtMs, m.roleUpdatedMs, JSON.stringify(m.telemetry || null)].join("|"));
    return JSON.stringify(am) === JSON.stringify(bm);
  };
  assert.ok(semanticEqual(resC.session, sc), "re-fusion de C = state sémantique identique (pas de rebond protocole)");
  /* déterminisme : l'ordre B←C puis C←B converge sur le même résultat JSON */
  assert.deepStrictEqual(resB.session.takes, resC.session.takes, "déterminisme des deux Masters");
}

/* ---------- 6. télémétrie adoptée indépendamment des rôles ---------- */
{
  let sb = mkSession(B, "s5", T0);
  sb = addCapture(sb, M1, B).session;
  const capsB = { source: "telemetry", capabilities: { resolutions: ["FHD"], gpsFeature: true, audioMic: true } };
  let tele = sb;
  tele = M.updateMemberTelemetry(tele, M1, { capabilities: capsB.capabilities, batteryLevel: 61, freeBytes: 1000000, updatedAtMs: T0 + 5 }, B).session;
  assert.strictEqual(M.membersOf(tele).find((m) => m.deviceId === M1).telemetry.batteryLevel, 61);
  assert.strictEqual(M.membersOf(tele).find((m) => m.deviceId === M1).sessionRoles.join(","), "capture", "rôles intacts");
  /* le rôle du device C est mis à jour localement → télémétrie transmise dans le sharedView */
  const view = M.sharedView(tele);
  const vm = view.members.find((m) => m.deviceId === M1);
  assert.strictEqual(vm.telemetry.batteryLevel, 61, "télémétrie dans le sharedView");
  /* C fusionne : adopte la télémétrie même si ses propres rôles gagnent */
  let sc = mkSession(C, "s5", T0);
  sc = addCapture(sc, M1, B).session;
  sc = M.updateMemberRoles(sc, M1, ["capture"], C).session; /* C met à jour les rôles (LMW plus récent) */
  const res = M.mergeSessions(sc, view);
  const mc = res.session.members.find((m) => m.deviceId === M1);
  assert.strictEqual(mc.roleByDeviceId, C, "rôles : vainqueur local C");
  assert.strictEqual(mc.telemetry.batteryLevel, 61, "télémétrie : adoptée de B (indépendante des rôles)");
  assert.ok(res.events.some((e) => e.type === "memberTelemetryChanged"), "event télémétrie émis");
  /* télémétrie re-fusionnée identique → pas de changement (pas de rebond) */
  const res2 = M.mergeSessions(res.session, view);
  assert.strictEqual(res2.changed, false);
}

/* ---------- 7. sharedView : Takes + télémétrie, JAMAIS le PIN ---------- */
{
  let s = mkSession(B, "s6", T0);
  s = addCapture(s, M1, B).session;
  s = M.updateMemberTelemetry(s, M1, { capabilities: { resolutions: ["HD"] }, batteryLevel: 50, freeBytes: 5 }, B).session;
  s = M.upsertTake(s, M.takeModel.createFirstTake(B, T0), B).session;
  const view = JSON.stringify(M.sharedView(s));
  assert.ok(view.indexOf(M1) >= 0, "membres visibles");
  assert.ok(view.indexOf('"takes"') >= 0, "Takes dans le sharedView");
  assert.ok(view.indexOf('"telemetry"') >= 0, "télémétrie dans le sharedView");
  assert.ok(view.indexOf(s.pin) < 0, "PIN jamais dans le sharedView");
  assert.ok(view.indexOf('"telemetry"') >= 0);
}

/* ---------- 8. updateMemberTelemetry refusé pour un non-membre ---------- */
{
  const s = mkSession(B, "s7", T0);
  const res = M.updateMemberTelemetry(s, "device-inconnu", { batteryLevel: 10 }, B);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "not_a_member");
}

console.log("takes-session.test.js OK — 8 cases");