/* MultiCam J07 — tests déterministes du modèle ARM distribué + synchronisation
 * d'horloge (arm-model.js). Aucun DOM : les timers et l'horloge sont injectés
 * (FakeSched / SimClock). Vérifie :
 *   1.  identité de cycle (cycleId) et validation de format ;
 *   2.  ordre déterministe des devices sélectionnés (ordres, doublons, skills) ;
 *   3.  permissions requises par l'effectif (micro / GPS / caméra) ;
 *   4.  lignes de vérification Capture (caméra, audio, permissions, stockage local,
 *       réglages — le best effort 4K→FHD n'est PAS une erreur, les capacités
 *       inconnues sont honnêtes (warn), un GPS effectif Off n'exige jamais la
 *       localisation) ;
 *   5.  lignes Storage (connexion, espace libre, volume, transferts) ;
 *   6.  réduction de statut : arr > attr > pending > ok ;
 *   7.  éligibilité REC : ≥1 Capture READY ou WARNING, jamais bloquée par le
 *       Storage ou la sync dégradée ;
 *   8.  incidents (modal) : lignes en err/warn/pending, ordre des devices ;
 *   9.  math NTP : rtt / offset (positif = horloge du pair en avance) ;
 *  10.  syncOfSamples : pending / stable / dégradé (offset > 50 ms) / dégradé
 *       (dispersion > 50 ms), échantillon retenu = RTT minimal ;
 *  11.  machine : start auto (ARM_START, évaluation locale, READY sans pair),
 *  12.  requêtes aux pairs (ARM_REQUEST + clock_sync), attente initiale 5 s →
 *       ARM_TIMEOUT → ERROR ;
 *  13.  arm_result correct → Capture distante READY (après sync), cycle/take
 *       obsolètes et device non sélectionné ignorés (ARM_IGNORE_STALE) ;
 *  14.  réponse tardive après timeout → ARM_RECOVER ;
 *  15.  cancel → ARM_CANCEL, résultats ultérieurs ignorés (not_active) ;
 *  16.  restart → tentative incrémentée (armCycleId change, l'ancien cycle est
 *       ignoré) ;
 *  17.  multi-Master B↔C : deux machines indépendantes, aucune fusion, convergence
 *       READY des deux côtés, stable après refresh (pas d'oscillation) ;
 *  18.  changement de Take pendant l'ARM → cancel + nouveau cycle ;
 *  19.  déconnexion → ERROR, reconnexion → ARMING + re-requête + READY ;
 *  20.  Storage en erreur n'affecte JAMAIS l'éligibilité REC ;
 *  21.  sync dégradée (offset 60 ms) → Capture WARNING, REC toujours éligible ;
 *  22.  ordre du sampling d'horloge : tous les captures distants sont échantillonnés
 *       (ordre des devices), 3 échantillons chacun, aucune requête en vol ;
 *  23.  incidents présents pendant l'ARMING / auto-fermeture quand tout est READY.
 *
 * Usage :  node session/arm-model.test.js   (sorties assertion simple)
 */

"use strict";

const path = require("path");
const assert = require("assert");
const M = require(path.resolve(__dirname, "../../../app/www/js/state/arm-model.js"));

const SID = "session-1";
const B = "device-B";
const C = "device-C";
const D = "device-D";

/* ---------- fausse horloge (temps de simulation) ---------- */

function SimClock(base) {
  let t = typeof base === "number" ? base : 0;
  this.now = function () { return t; };
  this.advance = function (ms) { t += ms; };
  this.jumpTo = function (to) { t = to; };
}

/* ---------- fake ordonnanceur (timers une fois) ---------- */

function FakeSched() {
  const self = this;
  this.q = [];
  this.seq = 0;
  this.schedule = function (fn, ms) {
    self.seq++;
    self.q.push({ id: self.seq, fn: fn, ms: ms, dead: false });
    return self.seq;
  };
  this.clear = function (id) {
    self.q.forEach((e) => { if (e.id === id) e.dead = true; });
  };
  this.log = function () { return self.q.filter((e) => !e.dead).map((e) => ({ id: e.id, ms: e.ms, dead: e.dead })); };
  this.fire = function (id) {
    const e = self.q.find((x) => x.id === id && !x.dead);
    if (!e) return false;
    e.dead = true;
    e.fn();
    return true;
  };
  /* exécute UNE SEULE FOIS la toute première entrée vivante (ordre d'insertion) */
  this.fireOne = function () {
    const e = self.q.find((x) => !x.dead);
    if (!e) return false;
    e.dead = true;
    e.fn();
    return true;
  };
  this.fireNextMs = function (ms) {
    const e = self.q.find((x) => !x.dead && x.ms === ms);
    if (!e) return false;
    e.dead = true;
    e.fn();
    return true;
  };
}

function flush() { return new Promise((r) => { setImmediate(r); }); }

/* ---------- fixtures de session ---------- */

function member(did, roles) {
  return {
    deviceId: did, deviceName: "dev-" + did, enabledSkills: roles, sessionRoles: roles,
    addedAtMs: 0, roleUpdatedMs: 0, telemetry: {}
  };
}

function take(n, captures, storages) {
  return {
    takeNumber: n, captures: captures || [], storages: storages || [],
    settings: {
      audioTracking: true, geoloc: false, quality: "HIGH", resolution: "HD",
      giveUpResolution: false, fiducialMode: "COUNT", stillMode: "NONE", minStorageFreeGB: 2
    },
    captureOverrides: {}, createdAtMs: 0, updatedAtMs: 0, updatedByDeviceId: ""
  };
}

function session(members, takes) {
  return { sessionId: SID, state: "open", name: "S", pin: "1234", owners: [], masters: [], members: members, takes: takes, createdAtMs: 0, updatedAtMs: 0 };
}

/* ---------- faits natifs (par défaut : tout prêt) ---------- */

function okCaptureFacts(overrides) {
  const f = {
    capsUnknown: false,
    supportedRes: ["HD", "FHD", "4K"],
    effective: { audio: true, gpsProfile: "OFF", resolution: "FHD", quality: "HIGH", camera: "REAR", fallback: false, warnings: [] },
    nativeProfile: { key: "FHD@30", width: 1920, height: 1080, fps: 30, label: "FHD@30" },
    perms: { CAMERA: "GRANTED", RECORD_AUDIO: "GRANTED" },
    freeBytes: 10000000000,
    probeOk: true
  };
  return overrides ? Object.assign(f, overrides) : f;
}

function okStorageFacts(overrides) {
  const f = { connected: true, freeBytes: 10000000000, writable: true, storageMode: "internal" };
  return overrides ? Object.assign(f, overrides) : f;
}

/* ---------- construction d'une machine injectée ---------- */

function mkMachine(opts) {
  const o = opts || {};
  const sched = new FakeSched();
  const clock = new SimClock(o.base != null ? o.base : 1000000);
  const holder = { current: o.session };
  const selfDid = o.selfDid || B;
  let conn = o.connected || function () { return true; };
  const requests = [];
  const clockReqs = [];
  const replies = [];
  const logs = [];
  const assessSelf = o.assessSelf || (function () {
    return function (ses, tk) {
      const out = [];
      (tk.captures || []).forEach((d) => { if (d === selfDid) out.push({ deviceId: d, skill: M.SKILL_CAPTURE, checks: M.assessCapture(okCaptureFacts()) }); });
      (tk.storages || []).forEach((d) => { if (d === selfDid) out.push({ deviceId: d, skill: M.SKILL_STORAGE, checks: M.assessStorage(okStorageFacts()) }); });
      return Promise.resolve(out);
    };
  })();

  const mach = M.createMachine({
    nowMs: clock.now,
    schedule: sched.schedule,
    clearSchedule: sched.clear,
    loadSession: function () { return Promise.resolve(holder.current); },
    selfDid: function () { return selfDid; },
    isConnected: function (did) { return did === selfDid || conn(did); },
    assessSelf: assessSelf,
    sendArmRequest: function (s, req) { requests.push(req); },
    sendClockRequest: function (s, req) { clockReqs.push(req); },
    log: function (l) { logs.push(l); }
  });

  return {
    mach, sched, clock, requests, clockReqs, replies, logs,
    setSession(s) { holder.current = s; },
    setConnected(fn) { conn = fn; }
  };
}

/* Une réponse d'arm_result côté répondeur (extra) → env côté REQUEUR. */
function resultEnv(extra, fromDid, overrides) {
  const e = {
    kind: "arm_result", sessionId: extra.sessionId || SID,
    armCycleId: extra.armCycleId, takeNumber: extra.takeNumber,
    deviceId: extra.deviceId, skill: extra.skill, checks: extra.checks,
    from: fromDid, generatedAtMs: extra.generatedAtMs
  };
  return Object.assign(e, overrides || {});
}

/* Réponse d'horloge fabriquée pour demander un offset cible (0 = parfait). */
function clockReplyH(m, did, offsetMs) {
  const p = m.mach.state.pendingClock;
  assert.ok(p && p.did === did, "clock request in vol pour " + did);
  const t0 = p.t0;
  let t1, t2, t3;
  if (offsetMs === 0) { t1 = t0 + 1; t2 = t0 + 2; t3 = t0 + 3; }
  else {
    /* offset = ((t1−t0)+(t2−t3))/2 ; on prend t2−t1 = 1 (processus quasi nul) */
    const d = offsetMs * 2;
    t1 = t0 + d; t2 = t0 + d + 1; t3 = t0 + 1;
  }
  m.clock.jumpTo(t0 + 3);
  return {
    kind: "clock_sync_reply", sessionId: p.armCycleId.split("#")[0],
    armCycleId: p.armCycleId, requestId: p.requestId, target: m.mach.state? undefined : undefined,
    from: did, t1, t2
  };
}

function skillStatus(m, did, skill) {
  const v = m.mach.view();
  const dev = v.devices.find((d) => d.did === did);
  if (!dev) return null;
  const sk = dev.skills.find((s) => s.skill === skill);
  return sk ? sk.status : null;
}

function syncStatus(m, did) {
  const v = m.mach.view();
  const dev = v.devices.find((d) => d.did === did);
  if (!dev) return null;
  const cap = dev.skills.find((s) => s.skill === M.SKILL_CAPTURE);
  if (!cap) return null;
  const line = cap.checks.find((c) => c.key === "sync");
  return line ? { status: line.status, message: line.message } : null;
}

/* ================================================================== */
/* 1. cycleId / format                                                */
/* ================================================================== */
{
  assert.strictEqual(M.cycleId("s1", 3, 2), "s1#3#2");
  assert.strictEqual(M.isCycleFmt("s1#3#2"), true);
  assert.strictEqual(M.isCycleFmt("s1#x#2"), false);
  assert.strictEqual(M.isCycleFmt("s1#3#a"), false);
  assert.strictEqual(M.isCycleFmt(""), false);
  assert.strictEqual(M.isCycleFmt(null), false);
  assert.strictEqual(M.cycleMatches("s1#3#2", "s1", 3), true);
  assert.strictEqual(M.cycleMatches("s1#3#2", "s1", 4), false);
  assert.strictEqual(M.cycleMatches("s1-other#3#2", "s1", 3), false);
}

/* ================================================================== */
/* 2. orderedDevices : ordre EXACT de l'écran 05, un seul device,      */
/*    rôles Capture puis Storage                                       */
/* ================================================================== */
{
  const ms = [member(B, ["capture"]), member(C, ["capture", "storage"]), member(D, ["storage"])];
  const tk = take(1, [C, B], [B, D, C]);
  /* ordre de l'écran 05 = ordre des membres ; skills Capture puis Storage */
  const devices = M.orderedDevices(tk, ms);
  assert.deepStrictEqual(devices.map((d) => d.did), [B, C, D], "ordre des membres conservé, chaque device une seule fois");
  assert.deepStrictEqual(devices[1].skills, [M.SKILL_CAPTURE, M.SKILL_STORAGE], "rôles Capture puis Storage");
  assert.deepStrictEqual(devices[2].skills, [M.SKILL_STORAGE], "Storage seul");
  /* device non membre ou take vide → rien */
  assert.deepStrictEqual(M.orderedDevices(take(1, ["ghost"], []), ms), [], "device non membre ignoré");
}

/* ================================================================== */
/* 3. permissions requises par l'effectif                              */
/* ================================================================== */
{
  assert.deepStrictEqual(M.requirePermissions({ audio: false, gpsProfile: "OFF" }), ["CAMERA"]);
  assert.deepStrictEqual(M.requirePermissions({ audio: true, gpsProfile: "OFF" }), ["CAMERA", "RECORD_AUDIO"]);
  assert.deepStrictEqual(M.requirePermissions({ audio: true, gpsProfile: "HIGH" }), ["CAMERA", "RECORD_AUDIO", "ACCESS_FINE_LOCATION"]);
  assert.deepStrictEqual(M.requirePermissions({ audio: false, gpsProfile: "HIGH" }), ["CAMERA", "ACCESS_FINE_LOCATION"]);
  assert.deepStrictEqual(M.requirePermissions(null), ["CAMERA"], "effectif absent → caméra seule");
}

/* ================================================================== */
/* 4. lignes Capture                                                   */
/* ================================================================== */
{
  const cap = (m) => M.assessCapture(m).find((c) => c.key === "camera").status;
  assert.strictEqual(cap(okCaptureFacts()), "ok");
  assert.strictEqual(cap(okCaptureFacts({ capsUnknown: true })), "warn", "capacités inconnues = honnête warn");
  assert.strictEqual(cap(okCaptureFacts({ capsUnknown: false, supportedRes: [] })), "err");

  const audio = (m) => M.assessCapture(m).find((c) => c.key === "audio").status;
  assert.strictEqual(audio(okCaptureFacts({ effective: Object.assign(okCaptureFacts().effective, { audio: false }) })), "ok", "audio désactivé = non requise");
  assert.strictEqual(audio(okCaptureFacts()), "ok");
  assert.strictEqual(audio(okCaptureFacts({ perms: { CAMERA: "GRANTED" } })), "warn", "clé absente = statut inconnu, jamais un refus déclaré");
  assert.strictEqual(audio(okCaptureFacts({ perms: { CAMERA: "GRANTED", RECORD_AUDIO: "DENIED" } })), "err", "permission micro refusée");

  const perm = (m) => M.assessCapture(m).find((c) => c.key === "permissions");
  assert.strictEqual(perm(okCaptureFacts({ perms: null })).status, "warn", "autorisations non vérifiables");
  assert.strictEqual(perm(okCaptureFacts()).status, "ok");
  assert.strictEqual(perm(okCaptureFacts({ perms: { CAMERA: "DENIED", RECORD_AUDIO: "GRANTED" } })).status, "err", "CAMERA refusée");

  const store = (m) => M.assessCapture(m).find((c) => c.key === "storageLocal").status;
  assert.strictEqual(store(okCaptureFacts({ probeOk: false })), "err", "écriture impossible");
  assert.strictEqual(store(okCaptureFacts({ freeBytes: undefined })), "warn", "espace inconnu");
  assert.strictEqual(store(okCaptureFacts({ freeBytes: 500000000 })), "warn", "< 1 Go");
  assert.strictEqual(store(okCaptureFacts({ freeBytes: 1000000001 })), "ok");

  const set = (m) => M.assessCapture(m).find((c) => c.key === "settings").status;
  assert.strictEqual(set(okCaptureFacts()), "ok");
  const fbEff = Object.assign({}, okCaptureFacts().effective, { fallback: true });
  assert.strictEqual(set(okCaptureFacts({ effective: fbEff })), "ok", "best effort 4K→FHD jamais une erreur d'ARM");
  assert.strictEqual(M.assessCapture(okCaptureFacts({ effective: fbEff })).find((c) => c.key === "settings").message, "Best effort appliqué");
}

/* ================================================================== */
/* 5. lignes Storage                                                   */
/* ================================================================== */
{
  const lines = M.assessStorage(okStorageFacts());
  assert.deepStrictEqual(lines.map((c) => c.status), ["ok", "ok", "ok", "ok"]);
  const nofree = M.assessStorage(okStorageFacts({ freeBytes: 500000000 }));
  assert.strictEqual(nofree.find((c) => c.key === "freeSpace").status, "warn", "< 1 Go sur le volume de stockage");
  const ro = M.assessStorage({ connected: true, freeBytes: undefined, writable: false });
  assert.strictEqual(ro.find((c) => c.key === "volume").status, "err");
  assert.strictEqual(ro.find((c) => c.key === "freeSpace").status, "err", "inaccessible → err, pas warn");
  const offline = M.assessStorage({ connected: false, freeBytes: 10000000000, writable: true });
  assert.strictEqual(offline.find((c) => c.key === "connection").status, "err");
}

/* ================================================================== */
/* 6. réduction de statut                                              */
/* ================================================================== */
{
  assert.strictEqual(M.reduceStatus([]), M.STATUS_ARMING);
  assert.strictEqual(M.reduceStatus([{ status: "ok" }]), M.STATUS_READY);
  assert.strictEqual(M.reduceStatus([{ status: "ok" }, { status: "pending" }]), M.STATUS_ARMING);
  assert.strictEqual(M.reduceStatus([{ status: "ok" }, { status: "pending" }, { status: "warn" }]), M.STATUS_WARNING);
  assert.strictEqual(M.reduceStatus([{ status: "ok" }, { status: "warn" }, { status: "err" }]), M.STATUS_ERROR);
  assert.ok(M.statusRank(M.STATUS_ERROR) > M.statusRank(M.STATUS_WARNING));
  assert.ok(M.statusRank(M.STATUS_WARNING) > M.statusRank(M.STATUS_ARMING));
  assert.ok(M.statusRank(M.STATUS_ARMING) > M.statusRank(M.STATUS_READY));
}

/* ================================================================== */
/* 7. éligibilité REC                                                  */
/* ================================================================== */
{
  const sk = (sk, st) => ({ skill: sk, status: st });
  assert.strictEqual(M.recEligible([sk("capture", M.STATUS_READY)]), true);
  assert.strictEqual(M.recEligible([sk("capture", M.STATUS_WARNING)]), true, "WARNING compté, REC jamais bloqué par la sync");
  assert.strictEqual(M.recEligible([sk("capture", M.STATUS_ARMING)]), false);
  assert.strictEqual(M.recEligible([sk("capture", M.STATUS_ERROR)]), false);
  assert.strictEqual(M.recEligible([sk("storage", M.STATUS_READY)]), false, "le Storage ne participe jamais");
  assert.strictEqual(M.recEligible([sk("storage", M.STATUS_ERROR)]), false);
  assert.strictEqual(M.recEligible([sk("capture", M.STATUS_ERROR), sk("capture", M.STATUS_READY)]), true);
  assert.strictEqual(M.recEligibleCount([sk("capture", M.STATUS_READY), sk("capture", M.STATUS_WARNING)]), 2);
  assert.strictEqual(M.recEligible([]), false);
}

/* ================================================================== */
/* 8. incidents                                                        */
/* ================================================================== */
{
  const view = {
    devices: [
      { did: C, deviceName: "x-C", skills: [{ skill: M.SKILL_CAPTURE, status: M.STATUS_WARNING, checks: [{ key: "sync", status: "warn", message: "Dégradée" }, { key: "camera", status: "ok", message: "" }] }] },
      { did: D, deviceName: "x-D", skills: [{ skill: M.SKILL_STORAGE, status: M.STATUS_ERROR, checks: [{ key: "volume", status: "err", message: "Inaccessible" }] }] }
    ]
  };
  const inc = M.incidentsOf(view);
  assert.strictEqual(inc.length, 2, "une ligne par incident (pas par device)");
  assert.strictEqual(inc[0].deviceName, "x-C");
  assert.strictEqual(inc[0].key, "sync");
  assert.strictEqual(inc[1].key, "volume");
  assert.strictEqual(M.incidentsEmpty(inc), false);
  assert.strictEqual(M.incidentsEmpty([]), true);
  const none = M.incidentsOf({ devices: [{ did: C, deviceName: "x", skills: [{ skill: M.SKILL_CAPTURE, status: M.STATUS_READY, checks: [{ key: "a", status: "ok", message: "" }] }] }] });
  assert.strictEqual(M.incidentsEmpty(none), true);
}

/* ================================================================== */
/* 9. math NTP                                                         */
/* ================================================================== */
{
  /* asymétrique : pair 1ms après réception, 7ms avant émission → rtt = 8−0 = 8 */
  assert.strictEqual(M.rttOf(1000, 1001, 1001, 1008), 8);
  assert.strictEqual(M.offsetOf(1000, 1001, 1001, 1008), -3);
  /* convention : offset positif = horloge du pair EN AVANCE */
  assert.ok(M.offsetOf(1000, 1060, 1061, 1001) > 0, "pair en avance → offset positif");
  assert.strictEqual(M.offsetOf(1000, 1060, 1061, 1001), 60);
  assert.strictEqual(M.rttOf(1000, 1060, 1061, 1001), 0);
}

/* ================================================================== */
/* 10. syncOfSamples                                                   */
/* ================================================================== */
{
  assert.strictEqual(M.syncOfSamples([]).status, "pending");
  const perfect = [{ t0: 1000, t1: 1001, t2: 1002, t3: 1003 }, { t0: 2000, t1: 2001, t2: 2002, t3: 2003 }];
  const st = M.syncOfSamples(perfect);
  assert.strictEqual(st.status, "ok");
  assert.strictEqual(st.offsetMs, 0);
  assert.strictEqual(st.dispersionMs, 0);
  assert.strictEqual(st.samples, 2);
  const ahead = [{ t0: 1000, t1: 1060, t2: 1061, t3: 1001 }];
  const stA = M.syncOfSamples(ahead);
  assert.strictEqual(stA.status, "warn", "|offset| > 50 ms → dégradé");
  assert.strictEqual(stA.offsetMs, 60);
  const wide = [{ t0: 1000, t1: 1001, t2: 1002, t3: 1003 }, { t0: 2000, t1: 2100, t2: 2101, t3: 2001 }];
  const stW = M.syncOfSamples(wide);
  assert.strictEqual(stW.status, "warn", "dispersion > 50 ms → dégradé");
  assert.ok(stW.dispersionMs > 50, "dispersion = étendue des offsets");
  /* échantillon retenu = RTT minimal */
  const pick = M.syncOfSamples([
    { t0: 1000, t1: 1010, t2: 1010, t3: 1040 },   /* rtt 30, offset 0 */
    { t0: 2000, t1: 2070, t2: 2071, t3: 2001 }    /* rtt 0, offset 70 (le plus fiable) */
  ]);
  assert.strictEqual(pick.offsetMs, 70, "l'échantillon au RTT minimal fait foi");
  assert.strictEqual(pick.rttMs, 0);
}

/* ================================================================== */
/* 11. machine : start auto, évaluation locale, READY sans pair        */
/* ================================================================== */
(async () => {
  const m = mkMachine({ session: session([member(B, ["capture"])], [take(1, [B])]) });
  const v = await m.mach.start(SID);
  await flush();
  assert.strictEqual(m.mach.view().active, true);
  assert.strictEqual(m.requests.length, 0, "aucune requête ARM sans pair sélectionné");
  assert.strictEqual(m.mach.view().devices.length, 1);
  assert.strictEqual(skillStatus(m, B, M.SKILL_CAPTURE), M.STATUS_READY, "soi-même évalué localement");
  assert.strictEqual(m.mach.view().recEligible, true);
  assert.strictEqual(m.mach.view().incidentsEmpty, true, "plus d'incident une fois READY");
  assert.ok(m.logs.some((l) => l.indexOf("ARM_START sessionId=" + SID) === 0), "ARM_START journalisé");
  assert.ok(m.logs.some((l) => l.indexOf("ARM_STATE_CHANGED") === 0 && l.indexOf("status=READY") > 0), "transition READY journalisée");
})();

/* ================================================================== */
/* 12. pair : ARM_REQUEST + clock_sync, timeout 5 s → ERROR            */
/* ================================================================== */
(async () => {
  const m = mkMachine({ session: session([member(B, ["capture"]), member(C, ["capture"])], [take(1, [B, C])]) });
  await m.mach.start(SID);
  await flush();
  assert.strictEqual(m.requests.length, 1, "ARM_REQUEST émis une fois");
  assert.deepStrictEqual(m.requests[0].targets, [C], "cible = les pairs sélectionnés");
  assert.strictEqual(m.requests[0].armCycleId, M.cycleId(SID, 1, 1));
  assert.strictEqual(skillStatus(m, B, M.SKILL_CAPTURE), M.STATUS_READY);
  assert.strictEqual(skillStatus(m, C, M.SKILL_CAPTURE), M.STATUS_ARMING, "C en attente (sync pending)");
  assert.ok(m.clockReqs.length >= 1 && m.clockReqs[0].target === C, "requête clock_sync vers la Capture distante");
  assert.strictEqual(m.mach.view().recEligible, true, "soi-même READY suffit à l'éligibilité");
  /* timeout 5 s : on tire le timer de (C, capture) */
  const dl = m.sched.log().find((e) => e.ms === M.FIRST_RESULT_TIMEOUT_MS);
  assert.ok(dl, "deadline planifiée");
  assert.strictEqual(m.sched.fire(dl.id), true);
  assert.strictEqual(skillStatus(m, C, M.SKILL_CAPTURE), M.STATUS_ERROR, "timeout → ERROR");
  assert.ok(m.logs.some((l) => l.indexOf("ARM_TIMEOUT") === 0), "ARM_TIMEOUT journalisé");
})();

/* ================================================================== */
/* 13. arm_result correct → READY (avec sync), stale/take ignorés       */
/* ================================================================== */
(async () => {
  const m = mkMachine({ session: session([member(B, ["capture"]), member(C, ["capture"])], [take(1, [B, C])]) });
  const cur = M.cycleId(SID, 1, 1);
  await m.mach.start(SID);
  await flush();

  const resp = { sessionId: SID, armCycleId: cur, takeNumber: 1, deviceId: C, skill: M.SKILL_CAPTURE, checks: M.assessCapture(okCaptureFacts()), generatedAtMs: 1000000005 };
  /* cycle obsolète d'abord : doit être ignoré sans changer l'état */
  m.mach.onIncoming(resultEnv(resp, C, { armCycleId: M.cycleId(SID, 1, 999) }));
  assert.strictEqual(skillStatus(m, C, M.SKILL_CAPTURE), M.STATUS_ARMING, "cycle obsolète ignoré");
  assert.ok(m.logs.some((l) => l.indexOf("ARM_IGNORE_STALE") === 0 && l.indexOf("reason=stale_cycle") > 0), "stale_cycle journalisé");

  /* take différent, cycle correct : remplacé par l'ignoré */
  m.mach.onIncoming(resultEnv(resp, C, { takeNumber: 7 }));
  assert.strictEqual(skillStatus(m, C, M.SKILL_CAPTURE), M.STATUS_ARMING, "take mismatch ignoré");
  assert.ok(m.logs.some((l) => l.indexOf("reason=take_mismatch") > 0), "take_mismatch journalisé");

  /* device non sélectionné */
  m.mach.onIncoming(resultEnv(resp, D, { deviceId: D, skill: M.SKILL_STORAGE }));
  assert.ok(m.logs.some((l) => l.indexOf("reason=not_selected") > 0), "not_selected journalisé");

  /* bonne réponse : première lecture sans sync → ARMING (sync pending) */
  m.mach.onIncoming(resultEnv(resp, C));
  await flush();
  assert.strictEqual(skillStatus(m, C, M.SKILL_CAPTURE), M.STATUS_ARMING, "Capture distante en attente de sync");

  /* sync parfaite : offset 0 */
  const p = m.mach.state.pendingClock;
  assert.ok(p && p.did === C, "requête d'horloge en vol");
  m.clock.jumpTo(p.t0 + 3);
  m.mach.onIncoming({ kind: "clock_sync_reply", sessionId: SID, armCycleId: cur, requestId: p.requestId, from: C, t1: p.t0 + 1, t2: p.t0 + 2 });
  await flush();
  assert.strictEqual(skillStatus(m, C, M.SKILL_CAPTURE), M.STATUS_READY, "READY dès que la sync est stable");
  assert.strictEqual(m.mach.view().recEligible, true);
  assert.ok(m.logs.some((l) => l.indexOf("CLOCK_SYNC peer=" + C) === 0), "CLOCK_SYNC journalisé");
  assert.deepStrictEqual(syncStatus(m, C), { status: "ok", message: "Stable · delta 0 ms" });

  /* stale cycle APRÈS READY : n'invalide rien */
  m.mach.onIncoming(resultEnv(resp, C, { armCycleId: M.cycleId(SID, 1, 888) }));
  await flush();
  assert.strictEqual(skillStatus(m, C, M.SKILL_CAPTURE), M.STATUS_READY, "un result stale ne casse pas un skill prêt");
})();

/* ================================================================== */
/* 14. réponse tardive après timeout → ARM_RECOVER while cycling?     */
/* ================================================================== */
(async () => {
  const m = mkMachine({ session: session([member(B, ["capture"]), member(C, ["capture"])], [take(1, [B, C])]) });
  await m.mach.start(SID);
  await flush();
  const dl = m.sched.log().find((e) => e.ms === M.FIRST_RESULT_TIMEOUT_MS);
  m.sched.fire(dl.id);
  assert.strictEqual(skillStatus(m, C, M.SKILL_CAPTURE), M.STATUS_ERROR);
  /* arrivée tardive : le skill repasse à READY après la sync */
  const cur = M.cycleId(SID, 1, 1);
  m.mach.onIncoming(resultEnv({ sessionId: SID, armCycleId: cur, takeNumber: 1, deviceId: C, skill: M.SKILL_CAPTURE, checks: M.assessCapture(okCaptureFacts()), generatedAtMs: 1000000099 }, C));
  const p = m.mach.state.pendingClock;
  m.clock.jumpTo(p.t0 + 3);
  m.mach.onIncoming({ kind: "clock_sync_reply", sessionId: SID, armCycleId: cur, requestId: p.requestId, from: C, t1: p.t0 + 1, t2: p.t0 + 2 });
  await flush();
  assert.strictEqual(skillStatus(m, C, M.SKILL_CAPTURE), M.STATUS_READY, "réponse tardive acceptée");
  assert.ok(m.logs.some((l) => l.indexOf("ARM_RECOVER") === 0), "ARM_RECOVER journalisé");
})();

/* ================================================================== */
/* 15. cancel → ARM_CANCEL, résultats ultérieurs ignorés               */
/* ================================================================== */
(async () => {
  const m = mkMachine({ session: session([member(B, ["capture"]), member(C, ["capture"])], [take(1, [B, C])]) });
  const cur = M.cycleId(SID, 1, 1);
  await m.mach.start(SID);
  await flush();
  m.mach.cancel("test");
  assert.strictEqual(m.mach.isActive(), false);
  assert.ok(m.logs.some((l) => l === "ARM_CANCEL sessionId=" + SID + " armCycleId=" + cur + " reason=test"), "ARM_CANCEL journalisé");
  m.mach.onIncoming(resultEnv({ sessionId: SID, armCycleId: cur, takeNumber: 1, deviceId: C, skill: M.SKILL_CAPTURE, checks: M.assessCapture(okCaptureFacts()) }, C));
  await flush();
  assert.strictEqual(skillStatus(m, C, M.SKILL_CAPTURE), null, "résultat après cancel ignoré (aucun device réapparu)");
  assert.ok(m.logs.some((l) => l.indexOf("reason=not_active") > 0), "not_active journalisé");
  /* cancel neutralise l'état (aucun résultat antérieur réutilisé) */
  assert.strictEqual(m.mach.view().devices.length, 0, "état vidé après cancel");
  assert.strictEqual(m.mach.view().recEligible, false);
})();

/* ================================================================== */
/* 16. restart → tentative +1, ancien cycle ignoré                     */
/* ================================================================== */
(async () => {
  const m = mkMachine({ session: session([member(B, ["capture"]), member(C, ["capture"])], [take(1, [B, C])]) });
  await m.mach.start(SID);
  assert.strictEqual(m.mach.attemptsFor(SID, 1), 1);
  m.mach.cancel("x");
  await m.mach.start(SID);
  assert.strictEqual(m.mach.attemptsFor(SID, 1), 2, "tentative incrémentée");
  assert.strictEqual(m.mach.state.armCycleId, M.cycleId(SID, 1, 2));
  /* ancien cycle (tentative 1) ignoré maintenant */
  m.mach.onIncoming(resultEnv({ sessionId: SID, armCycleId: M.cycleId(SID, 1, 1), takeNumber: 1, deviceId: C, skill: M.SKILL_CAPTURE, checks: M.assessCapture(okCaptureFacts()) }, C));
  await flush();
  assert.strictEqual(skillStatus(m, C, M.SKILL_CAPTURE), M.STATUS_ARMING, "le cycle précédent ne peut plus alimenter l'état");
  const req = m.requests[m.requests.length - 1];
  assert.strictEqual(req.armCycleId, M.cycleId(SID, 1, 2), "nouvelles requêtes avec le nouveau cycle");
})();

/* ================================================================== */
/* 17. multi-Master B↔C : machines indépendantes, convergence READY     */
/* ================================================================== */
(async () => {
  const ms = [member(B, ["capture"]), member(C, ["capture"])];
  const tk = take(1, [B, C]);
  const ses = session(ms, [tk]);
  const mB = mkMachine({ session: ses, selfDid: B });
  const mC = mkMachine({ session: ses, selfDid: C });

  /* B (requeur) se met en ARM */
  await mB.mach.start(SID);
  await flush();
  assert.strictEqual(mB.requests.length, 1, "B a demandé ARM à C");

  /* C (répondeur) : traite la requête sans être actif */
  const req = mB.requests[0];
  const replies = [];
  const cycB = M.cycleId(SID, 1, 1);
  mC.mach.onIncoming({
    kind: "arm_request", sessionId: SID, armCycleId: cycB, takeNumber: 1,
    targets: req.targets, skills: req.skills, from: B, endpoint: "ws://x"
  }, function (kind, extra) { replies.push({ kind, extra }); });
  await flush();
  assert.strictEqual(replies.length, 1, "C a répondu exactement ses skills");
  assert.strictEqual(replies[0].extra.deviceId, C);
  assert.strictEqual(replies[0].extra.armCycleId, cycB);

  /* B ingère la réponse + sync */
  mB.mach.onIncoming(resultEnv(replies[0].extra, C));
  const pB = mB.mach.state.pendingClock;
  mB.clock.jumpTo(pB.t0 + 3);
  mB.mach.onIncoming({ kind: "clock_sync_reply", sessionId: SID, armCycleId: cycB, requestId: pB.requestId, from: C, t1: pB.t0 + 1, t2: pB.t0 + 2 });
  await flush();
  assert.strictEqual(skillStatus(mB, B, M.SKILL_CAPTURE), M.STATUS_READY);
  assert.strictEqual(skillStatus(mB, C, M.SKILL_CAPTURE), M.STATUS_READY, "convergence côté B");

  /* sens inverse : C (Master) démarre SON ARM */
  await mC.mach.start(SID);
  await flush();
  const reqC = mC.requests.find((r) => r.targets.indexOf(B) >= 0);
  assert.ok(reqC, "C a demandé ARM à B");
  const cycC = M.cycleId(SID, 1, 1);
  const repliesB = [];
  mB.mach.onIncoming({
    kind: "arm_request", sessionId: SID, armCycleId: cycC, takeNumber: 1,
    targets: reqC.targets, skills: reqC.skills, from: C, endpoint: "ws://y"
  }, function (kind, extra) { repliesB.push({ kind, extra }); });
  await flush();
  assert.strictEqual(repliesB.length, 1, "B a répondu à C");
  mC.mach.onIncoming(resultEnv(repliesB[0].extra, B));
  const pC = mC.mach.state.pendingClock;
  mC.clock.jumpTo(pC.t0 + 3);
  mC.mach.onIncoming({ kind: "clock_sync_reply", sessionId: SID, armCycleId: cycC, requestId: pC.requestId, from: B, t1: pC.t0 + 1, t2: pC.t0 + 2 });
  await flush();
  assert.strictEqual(skillStatus(mC, C, M.SKILL_CAPTURE), M.STATUS_READY);
  assert.strictEqual(skillStatus(mC, B, M.SKILL_CAPTURE), M.STATUS_READY, "convergence côté C");

  /* AUCUNE fusion de vues : chaque Master garde SA lecture, et un refresh
     ne fait pas osciller l'état */
  assert.notStrictEqual(mB.mach.state.armCycleId + "|" + mC.mach.state.armCycleId, "fused!");
  await mB.mach.refresh();
  await flush();
  await mC.mach.refresh();
  await flush();
  assert.strictEqual(skillStatus(mB, B, M.SKILL_CAPTURE), M.STATUS_READY);
  assert.strictEqual(skillStatus(mB, C, M.SKILL_CAPTURE), M.STATUS_READY);
  assert.strictEqual(skillStatus(mC, C, M.SKILL_CAPTURE), M.STATUS_READY);
  assert.strictEqual(skillStatus(mC, B, M.SKILL_CAPTURE), M.STATUS_READY);
  const cycAfter = mB.mach.state.armCycleId;
  assert.strictEqual(cycAfter, cycB, "le refresh succède au même cycle (pas de re-tentative)");
})();

/* ================================================================== */
/* 18. changement de Take → ARM_CANCEL + nouveau cycle                  */
/* ================================================================== */
(async () => {
  const s0 = session([member(B, ["capture"]), member(C, ["capture"])], [take(1, [B])]);
  const m = mkMachine({ session: s0 });
  await m.mach.start(SID);
  assert.strictEqual(m.mach.state.takeNumber, 1);
  /* nouveau Take après que la CAMPAIGN décide */
  const s1 = session([member(B, ["capture"]), member(C, ["capture"])], [take(1, [B]), take(2, [B, C])]);
  m.setSession(s1);
  await m.mach.refresh();
  await flush();
  assert.strictEqual(m.mach.state.takeNumber, 2, "nouveau Take adopté");
  assert.strictEqual(m.mach.state.armCycleId, M.cycleId(SID, 2, 1), "identique (sid, takeNouveau) → tentative repart à 1");
  assert.strictEqual(m.mach.state.devices.length, 2, "devices sélectionnés du Take 2");
  assert.ok(m.logs.some((l) => l.indexOf("ARM_CANCEL") === 0 && l.indexOf("reason=take_changed") > 0), "take_changed journalisé");
})();

/* ================================================================== */
/* 19. déconnexion → ERROR, reconnexion → ARMING + re-requête + READY   */
/* ================================================================== */
(async () => {
  let remoteOk = true;
  const m = mkMachine({
    session: session([member(B, ["capture"]), member(C, ["capture"])], [take(1, [B, C])]),
    connected: function () { return remoteOk; }
  });
  const cur = M.cycleId(SID, 1, 1);
  await m.mach.start(SID);
  await flush();
  /* C READY d'abord */
  m.mach.onIncoming(resultEnv({ sessionId: SID, armCycleId: cur, takeNumber: 1, deviceId: C, skill: M.SKILL_CAPTURE, checks: M.assessCapture(okCaptureFacts()) }, C));
  const p = m.mach.state.pendingClock;
  m.clock.jumpTo(p.t0 + 3);
  m.mach.onIncoming({ kind: "clock_sync_reply", sessionId: SID, armCycleId: cur, requestId: p.requestId, from: C, t1: p.t0 + 1, t2: p.t0 + 2 });
  await flush();
  assert.strictEqual(skillStatus(m, C, M.SKILL_CAPTURE), M.STATUS_READY);

  /* déconnexion physique : syncConnectivity → ERROR */
  remoteOk = false;
  m.mach.syncConnectivity();
  assert.strictEqual(skillStatus(m, C, M.SKILL_CAPTURE), M.STATUS_ERROR);
  assert.ok(m.logs.some((l) => l.indexOf("status=ERROR check=connection") > 0), "échec connexion journalisé");
  assert.strictEqual(m.mach.view().recEligible, true, "le Master READY maintient l'éligibilité, C seul est en erreur");

  /* reconnexion → ARMING + l'ARM_REQUEST re-sollicite C */
  remoteOk = true;
  const nReq = m.requests.length;
  m.mach.syncConnectivity();
  assert.strictEqual(skillStatus(m, C, M.SKILL_CAPTURE), M.STATUS_ARMING, "reconnexion → nouvel ARM");
  assert.ok(m.logs.some((l) => l.indexOf("status=ARMING check=reconnect") > 0), "reconnect journalisé");
  assert.ok(m.requests.length > nReq, "re-requête émise");
  m.mach.onIncoming(resultEnv({ sessionId: SID, armCycleId: cur, takeNumber: 1, deviceId: C, skill: M.SKILL_CAPTURE, checks: M.assessCapture(okCaptureFacts()) }, C));
  await flush();
  assert.strictEqual(skillStatus(m, C, M.SKILL_CAPTURE), M.STATUS_READY, "re-évaluation = READY (clock conservé)");
})();

/* ================================================================== */
/* 20. Storage en erreur n'affecte JAMAIS l'éligibilité REC             */
/* ================================================================== */
(async () => {
  const m = mkMachine({
    session: session([member(B, ["capture"]), member(C, ["storage"])], [take(1, [B], [C])]),
    assessSelf: function (ses, tk) {
      const out = [];
      out.push({ deviceId: B, skill: M.SKILL_CAPTURE, checks: M.assessCapture(okCaptureFacts()) });
      out.push({ deviceId: C, skill: M.SKILL_STORAGE, checks: M.assessStorage(okStorageFacts()) });
      return Promise.resolve(out);
    }
  });
  await m.mach.start(SID);
  await flush();
  assert.strictEqual(skillStatus(m, B, M.SKILL_CAPTURE), M.STATUS_READY);
  assert.strictEqual(skillStatus(m, C, M.SKILL_STORAGE), M.STATUS_READY);
  assert.strictEqual(m.mach.view().recEligible, true);
  /* C passe en erreur (volume inaccessible) : REC reste vrai (B capture READY) */
  m.mach.onIncoming(resultEnv({ sessionId: SID, armCycleId: m.mach.state.armCycleId, takeNumber: 1, deviceId: C, skill: M.SKILL_STORAGE, checks: M.assessStorage({ connected: true, freeBytes: undefined, writable: false }) }, C));
  await flush();
  assert.strictEqual(skillStatus(m, C, M.SKILL_STORAGE), M.STATUS_ERROR, "le pair Storage est visiblement en erreur");
  assert.strictEqual(m.mach.view().recEligible, true, "le Storage n'influe JAMAIS sur REC");
  assert.strictEqual(m.mach.view().incidentsEmpty, false, "mais l'incident Storage existe (modal)");
})();

/* ================================================================== */
/* 21. sync dégradée (offset 60 ms) → Capture WARNING, REC éligible     */
/* ================================================================== */
(async () => {
  const m = mkMachine({ session: session([member(B, ["capture"]), member(C, ["capture"])], [take(1, [B, C])]) });
  const cur = M.cycleId(SID, 1, 1);
  await m.mach.start(SID);
  await flush();
  m.mach.onIncoming(resultEnv({ sessionId: SID, armCycleId: cur, takeNumber: 1, deviceId: C, skill: M.SKILL_CAPTURE, checks: M.assessCapture(okCaptureFacts()) }, C));
  const p = m.mach.state.pendingClock;
  m.clock.jumpTo(p.t0 + 3);
  m.mach.onIncoming({ kind: "clock_sync_reply", sessionId: SID, armCycleId: cur, requestId: p.requestId, from: C, t1: p.t0 + 60, t2: p.t0 + 61 });
  await flush();
  assert.strictEqual(skillStatus(m, C, M.SKILL_CAPTURE), M.STATUS_WARNING, "offset 60 ms → Capture WARNING, jamais ERROR");
  assert.ok(m.mach.view().incidents.some((i) => i.key === "sync"), "la ligne sync dégradée est un incident visible");
  assert.strictEqual(m.mach.view().recEligible, true, "WARNING compte pour l'éligibilité REC");
})();

/* ================================================================== */
/* 22. sampling d'horloge : tous les captures distants, ordre des      */
/*     devices, 3 échantillons chacun, aucune requête en vol            */
/* ================================================================== */
(async () => {
  const m = mkMachine({ session: session([member(B, ["capture"]), member(C, ["capture"]), member(D, ["capture"])], [take(1, [B, C, D])]) });
  await m.mach.start(SID);
  await flush();
  const cur = M.cycleId(SID, 1, 1);
  /* 1er échantillon : C (premier capteur distant dans l'ordre des devices) */
  assert.strictEqual(m.clockReqs[0].target, C, "premier capteur distant = C");

  const feed = function () {
    const p = m.mach.state.pendingClock;
    assert.ok(p, "requête en vol attendue");
    m.clock.jumpTo(p.t0 + 3);
    m.mach.onIncoming({ kind: "clock_sync_reply", sessionId: SID, armCycleId: cur, requestId: p.requestId, from: p.did, t1: p.t0 + 1, t2: p.t0 + 2 });
  };

  /* C : remarque les échantillons se suivent via le timer 500 ms (fireNextMs) */
  const consumeSample = function () {
    let acted = false;
    if (m.mach.state.pendingClock) { feed(); acted = true; }
    else {
      const fired = m.sched.fireNextMs(M.CLOCK_SAMPLE_SPACING_MS);
      if (fired && m.mach.state.pendingClock) feed();
      acted = fired;
    }
    return acted;
  };
  while (consumeSample()) { await flush(); }

  const reqs = m.clockReqs;
  assert.strictEqual(reqs.length, 6, "C×3 puis D×3 = 6 échantillons");
  assert.deepStrictEqual(reqs.map((r) => r.target), [C, C, C, D, D, D], "ordre deterministe, en séquence, aucune requête en vol");
  assert.strictEqual(m.mach.samplesFor(C).length, 3);
  assert.strictEqual(m.mach.samplesFor(D).length, 3);
  assert.strictEqual(m.mach.state.pendingClock, null, "plus aucune requête en vol à la fin");
  const v = m.mach.view();
  const syncC = v.clock[C], syncD = v.clock[D];
  assert.strictEqual(syncC.status, "ok");
  assert.strictEqual(syncD.status, "ok");
  assert.strictEqual(syncC.offsetMs, 0);
  assert.strictEqual(syncD.offsetMs, 0);
  assert.strictEqual(syncStatus(m, C).status, "ok");
  assert.strictEqual(syncStatus(m, D).status, "ok");
})();

/* ================================================================== */
/* 23. incidents pendant l'ARMING puis auto-fermeture quand READY       */
/* ================================================================== */
(async () => {
  const m = mkMachine({ session: session([member(B, ["capture"]), member(C, ["capture"])], [take(1, [B, C])]) });
  await m.mach.start(SID);
  await flush();
  assert.strictEqual(m.mach.view().incidentsEmpty, false, "C en ARMING → incident (sync pending)");
  assert.ok(m.mach.view().incidents.some((i) => i.did === C && i.key === "sync"), "incident C/sync listé");
  assert.ok(m.mach.view().incidents.every((i) => i.deviceName === "dev-" + i.did), "deviceName présent");
  const cur = M.cycleId(SID, 1, 1);
  m.mach.onIncoming(resultEnv({ sessionId: SID, armCycleId: cur, takeNumber: 1, deviceId: C, skill: M.SKILL_CAPTURE, checks: M.assessCapture(okCaptureFacts()) }, C));
  const p = m.mach.state.pendingClock;
  m.clock.jumpTo(p.t0 + 3);
  m.mach.onIncoming({ kind: "clock_sync_reply", sessionId: SID, armCycleId: cur, requestId: p.requestId, from: C, t1: p.t0 + 1, t2: p.t0 + 2 });
  await flush();
  assert.strictEqual(m.mach.view().incidentsEmpty, true, "auto-fermeture du modal une fois tout READY");
})();

/* ================================================================== */
/* 24. convergence terminale ARM après revue humaine : un `pending`    */
/*     connu (permission NOT_REQUESTED) est un fait terminal →         */
/*     WARNING, jamais ARMING durable ; seul un pending réellement     */
/*     en cours (sync en attente / réponse attendue) reste ARMING.     */
/* ================================================================== */
{
  /* Cas A — Capture locale : tout OK sauf permission NOT_REQUESTED,
     sync = référence locale → WARNING (jamais ARMING). */
  const f = okCaptureFacts({ perms: { CAMERA: "NOT_REQUESTED", RECORD_AUDIO: "GRANTED" } });
  const checks = M.assessCapture(f);
  const permLine = checks.find((c) => c.key === "permissions");
  assert.strictEqual(permLine.status, "pending", "la ligne reste honnêtement pending (« à demander »)");
  assert.strictEqual(permLine.settled, true, "mais marquée settled = fait connu terminal");
  assert.strictEqual(permLine.message, "Autorisation à demander : CAMERA");
  const local = [{ status: "ok" }].concat(checks).concat([{ key: "sync", status: "ok", message: "Référence locale" }]);
  assert.strictEqual(M.reduceStatus(local), M.STATUS_WARNING, "Cas A : NOT_REQUESTED connue → WARNING, pas ARMING");
  const skA = [{ skill: M.SKILL_CAPTURE, status: M.STATUS_WARNING }];
  assert.strictEqual(M.recEligible(skA), true, "Cas A : Capture WARNING reste recEligible");

  /* Cas B — même Capture vue depuis un Master distant, sync distante OK
     → même état fonctionnel terminal (WARNING). */
  const distantOk = [{ status: "ok" }].concat(checks).concat([{ key: "sync", status: "ok", message: "Stable · delta 0 ms", offsetMs: 0 }]);
  assert.strictEqual(M.reduceStatus(distantOk), M.STATUS_WARNING, "Cas B : mêmes faits + sync distante OK → même WARNING");

  /* Cas C — sync distante dégradée → WARNING (jamais bloquant). */
  const distantDeg = [{ status: "ok" }].concat(checks).concat([{ key: "sync", status: "warn", message: "Dégradée · delta 155 ms", offsetMs: 155 }]);
  assert.strictEqual(M.reduceStatus(distantDeg), M.STATUS_WARNING, "Cas C : sync dégradée → WARNING, jamais ERROR/ARMING");

  /* Cas D — réponse réellement encore attendue (sync pending, pas settled)
     → ARMING. */
  assert.strictEqual(M.reduceStatus([{ status: "ok" }, { status: "pending" }]), M.STATUS_ARMING, "Cas D : pending en cours (sync) → ARMING");
  assert.strictEqual(M.reduceStatus([{ status: "ok" }, { key: "sync", status: "pending" }]), M.STATUS_ARMING, "Cas D : sync en attente → ARMING");

  /* Cas E — permission indispensable explicitement refusée → ERROR. */
  const refused = okCaptureFacts({ perms: { CAMERA: "DENIED", RECORD_AUDIO: "GRANTED" } });
  const errChecks = M.assessCapture(refused);
  const errLine = errChecks.find((c) => c.key === "permissions");
  assert.strictEqual(errLine.status, "err", "Cas E : CAMERA DENIED → err");
  assert.strictEqual(errLine.settled, undefined, "un refus n'est pas un pending settled");
  const eLocal = [{ status: "ok" }].concat(errChecks).concat([{ key: "sync", status: "ok", message: "Référence locale" }]);
  assert.strictEqual(M.reduceStatus(eLocal), M.STATUS_ERROR, "Cas E : refus indispensable → ERROR");
}

/* ================================================================== */
/* 25. convergence renforcée côté MACHINE (D4 self ARMING / requester  */
/*     WARNING — reproduit le défaut physique avant correction)        */
/* ================================================================== */
(async () => {
  /* NOT_REQUESTED physique (style Cam D4) : camera/audio/storage OK,
     GPS en attente d'action. Défaut reproduit : soi-même → ARMING,
     requester → WARNING. Corrigé : les deux terminent WARNING. */
  const notReqFacts = okCaptureFacts({
    perms: { CAMERA: "GRANTED", RECORD_AUDIO: "GRANTED", ACCESS_FINE_LOCATION: "NOT_REQUESTED" },
    effective: Object.assign(okCaptureFacts().effective, { gpsProfile: "HIGH" })
  });
  const assessSelfWithNomTr = function (ses, tk) {
    const out = [];
    (tk.captures || []).forEach((d) => { if (d === C) out.push({ deviceId: d, skill: M.SKILL_CAPTURE, checks: M.assessCapture(notReqFacts) }); });
    return Promise.resolve(out);
  };

  /* Vue du device POUI lui-même (C master local : sync = référence locale). */
  const mSelf = mkMachine({
    session: session([member(B, ["capture"]), member(C, ["capture"])], [take(1, [B, C])]),
    selfDid: C, assessSelf: assessSelfWithNomTr
  });
  await mSelf.mach.start(SID);
  await flush();
  assert.strictEqual(skillStatus(mSelf, C, M.SKILL_CAPTURE), M.STATUS_WARNING, "self : NOT_REQUESTED connue → WARNING, plus jamais ARMING durable");
  assert.strictEqual(mSelf.mach.view().recEligible, true, "self : Capture WARNING éligible");
  const syncSelf = mSelf.mach.view().devices.find((d) => d.did === C).skills[0].checks.find((c) => c.key === "sync");
  assert.strictEqual(syncSelf.status, "ok");
  assert.strictEqual(syncSelf.message, "Référence locale", "aucun offset factice sur soi-même");

  /* Vue du REQUESTER (B master) sur le même device C avec vraie sync
     distante dégradée : converge vers le même état terminal. */
  const mReq = mkMachine({ session: session([member(B, ["capture"]), member(C, ["capture"])], [take(1, [B, C])]) });
  const cur = M.cycleId(SID, 1, 1);
  await mReq.mach.start(SID);
  await flush();
  mReq.mach.onIncoming(resultEnv({ sessionId: SID, armCycleId: cur, takeNumber: 1, deviceId: C, skill: M.SKILL_CAPTURE, checks: M.assessCapture(notReqFacts) }, C));
  const p = mReq.mach.state.pendingClock;
  mReq.clock.jumpTo(p.t0 + 3);
  mReq.mach.onIncoming({ kind: "clock_sync_reply", sessionId: SID, armCycleId: cur, requestId: p.requestId, from: C, t1: p.t0 + 156, t2: p.t0 + 157 });
  await flush();
  assert.strictEqual(skillStatus(mReq, C, M.SKILL_CAPTURE), M.STATUS_WARNING, "requester : même device → même WARNING (sync dégradée mesurée)");
  const syncReq = mReq.mach.view().devices.find((d) => d.did === C).skills[0].checks.find((c) => c.key === "sync");
  assert.strictEqual(syncReq.status, "warn", "requester : vraie sync distante dégradée mesurée");
  assert.ok(String(syncReq.offsetMs).indexOf("15") === 0, "requester : offset réellement mesuré");
  assert.strictEqual(mReq.mach.view().recEligible, true, "requester : Capture WARNING éligible");
})();