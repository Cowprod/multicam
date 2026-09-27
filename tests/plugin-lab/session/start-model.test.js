/* MultiCam J08 — tests déterministes du modèle Countdown + START synchronisé
 * (app/www/js/state/start-model.js). Aucun DOM : horloge, timers, réseau et
 * action d'enregistrement sont INJECTÉS. Le réseau simulé applique une latence
 * aux sondes NTP (start_probe / start_probe_reply) afin d'exercer la formule
 * J07 (offset = horloge pair − horloge locale) sur des horloges réellement
 * décalées.
 *
 * Blocs couverts (39) :
 *   1-5.   helpers purs : planId/isPlanFmt, choosePlanId/comparePlanId,
 *          digitFor, localTopMs, probeOffset (formule NTP J07) ;
 *   6-8.   requestStart : plan auto-suffisant, countdown 0 s (écran 07 sauté +
 *          lead structurel nommé), refus clock_stale sur échantillon J07 périmé ;
 *   9-11.  adoption distante, top synchronisé (3 devices, horloges −250/0/+600
 *          → écart réel nul), séquence 5→1 jamais 0 ;
 *   12-14. idempotence plan / états de pairs, delta mesuré (réveil tardif) ;
 *   15-17. annulation Master, refus non-Master, annulation post-top ignorée ;
 *   18.    perte de TOUS les Masters après programmation (START_MASTER_LOST) ;
 *   19-22. exclusion ERROR, SKIPPED au top, réintégration, START unique ;
 *   23-24. annulation automatique no_startable_capture ;
 *   25-27. participation, Capture sans offset (exclusion honnête), Master
 *          observateur (sonde NTP résolue, aucun enregistrement) ;
 *   28-29. sonde sans réponse (dégradé honnête), rôle Storage ;
 *   30-33. STOP local d'urgence (visible SANS Master), arrêt unique, Take
 *          interdit de redémarrage, autres Captures intactes ;
 *   34-36. plans concurrents : divergence réelle, convergence par
 *          startPlanId, UN seul top par device ;
 *   37-38. plan concurrent APRÈS le top local → refusé (barrière anti-double-REC) ;
 *   38.    START sans cycle ARM actif → armCycleId de repli au format VALIDE ;
 *   39.    re-demande pendant le REC → refusée (plan_active).
 *
 * Usage :  node session/start-model.test.js
 */

"use strict";

const path = require("path");
const assert = require("assert");
const M = require(path.resolve(__dirname, "../../../app/www/js/state/start-model.js"));

const SID = "session-J08";
const A = "dev-A";   /* Master + Capture (starter) */
const B = "dev-B";   /* Capture                                  */
const C = "dev-C";   /* Capture                                  */
const D = "dev-D";   /* Master observateur (non participant)    */
const S = "dev-S";   /* Storage                                  */

/* ---------- horloge simulée (base commune) + ordonnanceur ---------- */

function SimClock(base) {
  let t = typeof base === "number" ? base : 1000000;
  this.now = function () { return t; };
  this.set = function (v) { t = v; };
  this.advance = function (ms) { t += ms; };
}

/* Les timers reçoivent une DURÉE (indépendante du skew) : l'échéance est donc
 * stockée sur la base commune. `late` simule un réveil tardif du WebView. */
function FakeSched(base) {
  const self = this;
  this.base = base;
  this.q = [];
  this.seq = 0;
  this.late = 0;
  this.at = function (fn, dueBase) {
    self.seq += 1;
    self.q.push({ id: self.seq, fn: fn, due: dueBase, dead: false });
    return self.seq;
  };
  this.schedule = function (fn, ms) { return self.at(fn, self.base.now() + Math.max(0, ms || 0)); };
  this.clear = function (id) { self.q.forEach((e) => { if (e.id === id) e.dead = true; }); };
  this.run = function (untilBase) {
    for (let guard = 0; guard < 50000; guard++) {
      const next = self.q.filter((e) => !e.dead).sort((x, y) => (x.due - y.due) || (x.id - y.id))[0];
      if (!next || next.due > untilBase) break;
      next.dead = true;
      self.base.set(Math.max(self.base.now(), next.due + self.late));
      next.fn();
    }
    self.base.set(Math.max(self.base.now(), untilBase));
  };
}

/* ---------- réseau simulé (broadcast + sonde NTP avec latence) ---------- */

function makeNet(sched, base) {
  const nodes = {};
  const net = {
    probeLag: 120,          /* latence aller simple sur les sondes NTP */
    planLag: 0,             /* latence de diffusion des plans (0 = instantané) */
    wire: [],               /* trace des émissions (assertions) */
    register: function (did, machine) { nodes[did] = machine; },
    unregister: function (did) { delete nodes[did]; },
    deliver: function (fromDid, toDid, kind, extra) {
      const n = nodes[toDid];
      if (!n) return;
      let lag = 0;
      if (kind === "start_probe" || kind === "start_probe_reply") lag = net.probeLag;
      else if (kind === "start_plan") lag = net.planLag;
      const run = function () {
        const env = Object.assign({ v: 1, kind: kind, from: fromDid, ts: 0 }, extra);
        n.onIncoming(env, function (rkind, rextra) { net.deliver(toDid, fromDid, rkind, rextra); });
      };
      if (lag > 0) sched.at(run, base.now() + lag);
      else run();
    },
    /* l'émetteur s'adopte lui-même : ici l'adoption locale est déjà faite par
     * requestStart/adoptPlan, donc on ne livre qu'aux autres. */
    send: function (fromDid, kind, extra) {
      net.wire.push({ from: fromDid, kind: kind, extra: extra });
      Object.keys(nodes).forEach((did) => { if (did !== fromDid) net.deliver(fromDid, did, kind, extra); });
    }
  };
  return net;
}

/* ---------- fixtures ---------- */

function member(did, roles) {
  return {
    deviceId: did, deviceName: "nom-" + did,
    enabledSkills: roles, sessionRoles: roles,
    addedAtMs: 0, roleUpdatedMs: 0, telemetry: {}
  };
}

function makeSession(captures, storages, countdownSeconds) {
  const roles = {};
  [A, B, C, D].forEach((d) => { roles[d] = (captures.indexOf(d) >= 0) ? ["capture", "master"] : ["master"]; });
  roles[S] = ["storage"];
  return {
    sessionId: SID, name: "Session J08", state: "open",
    masters: [{ deviceId: A, deviceName: "nom-A", endpoint: "10.0.0.1:45102" }],
    members: [A, B, C, D, S].map((d) => member(d, roles[d])),
    takes: [{
      takeNumber: 1,
      status: "PREPARATION",
      captures: captures,
      storages: storages || [],
      settings: {
        video: { resolution: "FHD", quality: "HIGH", camera: "REAR", orientation: "LANDSCAPE" },
        audio: true, gpsProfile: "NORMAL",
        countdownSeconds: (countdownSeconds === undefined) ? 5 : countdownSeconds,
        transferAuto: true, deleteLocalAfterVerifiedReplication: true
      },
      captureOverrides: {},
      createdAtMs: 0, updatedAtMs: 0, updatedByDeviceId: ""
    }],
    removedMembers: {}
  };
}

function armDevice(did, skills) {
  return { did: did, deviceName: "nom-" + did, skills: skills.map((s) => ({ skill: s, status: "READY" })) };
}

const DEFAULT_ARM_DEVICES = [
  armDevice(A, ["capture"]), armDevice(B, ["capture"]),
  armDevice(C, ["capture"]), armDevice(D, []), armDevice(S, ["storage"])
];

/* ---------- machine de test ---------- */

function makeNode(opts) {
  const did = opts.did;
  const net = opts.net;
  const node = {
    did: did,
    logs: [],
    starts: [],
    stops: [],
    ready: true,                                  /* caméra native prête ? */
    offsets: opts.offsets || {},                  /* peer -> offsetMs */
    offsetAges: opts.offsetAges || {},            /* peer -> ageMs */
    /* armCycleId explicite : null = AUCUN cycle ARM actif (cas testé) — d'où le
     * test !== undefined plutôt qu'un || qui masquerait le null. */
    armCycleId: opts.armCycleId !== undefined ? opts.armCycleId : (SID + "#1#1"),
    armDevices: opts.armDevices || DEFAULT_ARM_DEVICES,
    connected: opts.connected || [A, B, C, D, S],
    machine: null,
    deps: null
  };
  node.deps = {
    nowMs: function () { return opts.clock.now(); },
    schedule: function (fn, ms) { return opts.sched.schedule(fn, ms); },
    clearSchedule: function (t) { opts.sched.clear(t); },
    loadSession: function () { return Promise.resolve(opts.session); },
    selfDid: function () { return did; },
    isConnected: function (d) { return node.connected.indexOf(d) >= 0; },
    isMasterRole: function (d, ses) {
      const m = ses.members.filter((x) => x.deviceId === d)[0];
      return !!m && m.sessionRoles.indexOf("master") >= 0;
    },
    captureRole: function (d, ses) {
      const m = ses.members.filter((x) => x.deviceId === d)[0];
      return !!m && m.sessionRoles.indexOf("capture") >= 0;
    },
    storageRole: function (d, ses) {
      const m = ses.members.filter((x) => x.deviceId === d)[0];
      return !!m && m.sessionRoles.indexOf("storage") >= 0;
    },
    lastTake: function (ses) { return ses.takes[ses.takes.length - 1]; },
    armView: function () { return { armCycleId: node.armCycleId, devices: node.armDevices }; },
    armClockOffsets: function () {
      const out = {};
      Object.keys(node.offsets).forEach((peer) => {
        out[peer] = { offsetMs: node.offsets[peer], ageMs: (node.offsetAges[peer] === undefined) ? 1000 : node.offsetAges[peer] };
      });
      return out;
    },
    refreshArmClock: function () { node.logs.push("REFRESH_CLOCK deviceId=" + did); return Promise.resolve(); },
    countdownSecondsOf: function (take) { return take.settings.countdownSeconds; },
    captureReady: function () { return node.ready ? { ok: true, message: "" } : { ok: false, message: "camera_not_ready" }; },
    startRecording: function (req) { node.starts.push(req); return Promise.resolve({ atMs: opts.clock.now(), detail: "sim" }); },
    stopRecording: function () { node.stops.push(opts.clock.now()); return Promise.resolve({ atMs: opts.clock.now(), detail: "sim" }); },
    connectedMasters: function () { return node.connected; },
    sendStartPlan: function (ses, plan) { net.send(did, "start_plan", { sessionId: ses.sessionId, plan: plan }); },
    sendStartCancel: function (ses, msg) { net.send(did, "start_cancel", Object.assign({ sessionId: ses.sessionId }, msg)); },
    sendStartState: function (ses, msg) { net.send(did, "start_state", Object.assign({ sessionId: ses.sessionId }, msg)); },
    sendStartProbe: function (ses, msg) { net.send(did, "start_probe", Object.assign({ sessionId: ses.sessionId }, msg)); },
    log: function (l) { node.logs.push(l); },
    onChange: function () {}
  };
  node.machine = M.createMachine(node.deps);
  net.register(did, node.machine);
  return node;
}

/* Monde skewé : base commune T, skews constants par device.
 * Convention J07 : clockOffsets[peer] = horloge_peer − horloge_locale. */
const SKEWS = { [A]: 0, [B]: 600, [C]: -250, [D]: 900 };

function buildWorld(opts) {
  opts = opts || {};
  const T = opts.T || 1000000;
  const base = new SimClock(T);
  const sched = new FakeSched(base);
  const net = makeNet(sched, base);
  const ses = makeSession(opts.captures || [A, B, C], opts.storages || [S], opts.countdown);
  const skews = opts.skews || SKEWS;
  const nodes = {};
  function mk(did, extra) {
    const localClock = { now: function () { return base.now() + (skews[did] || 0); } };
    const n = makeNode(Object.assign({
      did: did, clock: localClock, sched: sched, net: net, session: ses,
      armCycleId: opts.noArmCycle ? null : ((opts.armCycleIdFor || {})[did] || (SID + "#1#1")),
      armDevices: DEFAULT_ARM_DEVICES,
      connected: [A, B, C, D, S]
    }, extra || {}));
    n.baseClock = base;
    nodes[did] = n;
    return n;
  }
  const w = { base: base, sched: sched, net: net, ses: ses, nodes: nodes, skews: skews };
  w.A = mk(A, { offsets: { [B]: 600, [C]: -250 } });
  w.B = mk(B, { offsets: { [A]: -600, [C]: -850 } });
  w.C = mk(C, { offsets: { [A]: 250, [B]: 850 } });
  w.D = mk(D, { offsets: { [A]: -900, [B]: -300, [C]: -1150 } });
  w.S = mk(S, { offsets: { [A]: -900, [B]: -300, [C]: -1150 } });
  /* offset du device par rapport à la base (0 = creator/leader) */
  w.skewOf = function (did) { return skews[did] || 0; };
  return w;
}

/* ---------- assertions ---------- */

function flush() { return new Promise((r) => { setImmediate(r); }); }

/* Avance l'horloge simulée PAR TRANCHES : à chaque tranche on laisse les
 * promises se résoudre (onIncoming → loadSession → adoptPlan) avant le timer
 * suivant — exactement l'ordre d'un WebView (macrotask, puis microtasks). */
async function advance(w, ms, slice) {
  slice = slice || 100;
  const end = w.base.now() + ms;
  for (let guard = 0; guard < 5000 && w.base.now() < end; guard++) {
    w.sched.run(Math.min(end, w.base.now() + slice));
    await flush();
  }
}

function has(logs, needle) { return logs.filter((l) => l.indexOf(needle) >= 0); }
function one(logs, needle) {
  const f = has(logs, needle);
  assert.ok(f.length >= 1, "log attendu ABSENT : " + needle);
  return f[0];
}
function only(logs, needle) {
  const f = has(logs, needle);
  assert.strictEqual(f.length, 1, "log attendu EXACTEMENT 1 fois : " + needle + " (trouvé " + f.length + ")");
  return f[0];
}
function none(logs, needle) { assert.strictEqual(has(logs, needle).length, 0, "log inattendu : " + needle); }

/* série des chiffres projetés par les logs COUNTDOWN_STATE */
function digitSeries(logs) {
  const out = [];
  has(logs, "COUNTDOWN_STATE").forEach((l) => {
    const m = /digit=(\d+)/.exec(l);
    if (m) out.push(Number(m[1]));
  });
  return out;
}
function uniqSeq(a) { return a.filter((x, i) => i === 0 || a[i - 1] !== x); }

let blocks = 0;
async function block(name, fn) {
  blocks += 1;
  console.log("\n[" + String(blocks).padStart(2, "0") + "] " + name);
  await fn();
}

/* ===================================================================== */

async function main() {
  let w;

  /* 1 */
  await block("planId / isPlanFmt : identité de plan explicite", function () {
    assert.strictEqual(M.planId("s#1#2", 1), "s#1#2#1");
    assert.strictEqual(M.planId("s#1#2", 12), "s#1#2#12");
    assert.ok(M.isPlanFmt("s#1#2#3"));
    assert.ok(!M.isPlanFmt("s#1#2"), "3 parties = armCycleId seul, pas un plan");
    assert.ok(!M.isPlanFmt("s#x#2#3"), "take/cycle doivent être numériques (arbitrage total)");
    assert.ok(!M.isPlanFmt("#1#2#3"), "sessionId vide refusé");
  });

  /* 2 */
  await block("choosePlanId : verdict pur, total, sans horloge", function () {
    assert.strictEqual(M.choosePlanId("a#1#1#1", "b#1#1#1"), "b#1#1#1");
    assert.strictEqual(M.choosePlanId("b#1#1#1", "a#1#1#1"), "b#1#1#1", "symétrique");
    assert.strictEqual(M.choosePlanId("s#1#1#1", "s#1#2#1"), "s#1#2#1", "take supérieur gagne");
    assert.strictEqual(M.choosePlanId("s#1#1#2", "s#1#1#10"), "s#1#1#10", "rang comparé numériquement");
    assert.strictEqual(M.choosePlanId(null, "z#1#1#1"), "z#1#1#1");
    assert.strictEqual(M.choosePlanId("a#1#1#1", null), "a#1#1#1");
  });

  /* 3 */
  await block("digitFor : ceil, borné à [1..countdown], JAMAIS 0", function () {
    assert.strictEqual(M.digitFor(5000, 5), 5);
    assert.strictEqual(M.digitFor(4001, 5), 5);
    assert.strictEqual(M.digitFor(4000, 5), 4);
    assert.strictEqual(M.digitFor(1, 5), 1);
    assert.strictEqual(M.digitFor(0, 5), 0, "0 = instant du top, jamais affiché");
    assert.strictEqual(M.digitFor(-1, 5), 0);
    assert.strictEqual(M.digitFor(99999, 5), 5, "borné au countdown configuré");
    assert.strictEqual(M.digitFor(4200, 10), 5);
    assert.strictEqual(M.digitFor(0, 0), 0, "countdown 0 s : aucun chiffre");
  });

  /* 4 */
  await block("localTopMs : targetStart + offset J07", function () {
    assert.strictEqual(M.localTopMs({ targetStartMs: 2000 }, 600), 2600, "pair en avance → top plus tard");
    assert.strictEqual(M.localTopMs({ targetStartMs: 2000 }, -600), 1400);
    assert.strictEqual(M.localTopMs({ targetStartMs: 2000 }, null), 2000);
    assert.strictEqual(M.localTopMs(null, 0), null);
  });

  /* 5 */
  await block("probeOffset : formule NTP J07 (pair − local)", function () {
    assert.strictEqual(M.probeOffset(0, 40, 50, 60), 15);
    assert.strictEqual(M.probeOffset(1000, 1040, 1050, 1060), 15);
  });

  /* 6 */
  w = buildWorld({});
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  await block("requestStart : plan auto-suffisant + targetStart = now + countdown", function () {
    const v = w.A.machine.view();
    only(w.A.logs, "START_PLAN_CREATED");
    only(w.A.logs, "START_REQUEST");
    assert.strictEqual(v.phase, M.PHASE_COUNTDOWN);
    assert.strictEqual(v.leader, true);
    assert.strictEqual(v.isCapture, true, "A est Master ET Capture sélectionnée");
    assert.ok(M.isPlanFmt(v.startPlanId), "startPlanId = armCycleId#seq : " + v.startPlanId);
    assert.strictEqual(v.startPlanId, M.planId(SID + "#1#1", 1));
    assert.strictEqual(v.targetStartMs, w.base.now() + 5000, "countdown 5 s → aucun délai caché");
    assert.strictEqual(v.digit, 5, "premier chiffre = 5");
    assert.strictEqual(v.showCountdown, true);
    only(w.A.logs, "START_ACCEPTED");
    only(w.B.logs, "START_PLAN_ACCEPTED");
    assert.strictEqual(v.startableCaptures, 3, "3 Captures démarrables (A, B, C)");
  });

  /* 7 */
  w = buildWorld({ countdown: 0 });
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  await block("countdown 0 s : ÉCRAN 07 ENTIÈREMENT SAUTÉ, lead structurel nommé", function () {
    const v = w.A.machine.view();
    assert.strictEqual(v.targetStartMs, w.base.now() + M.MIN_DISPATCH_LEAD_MS);
    assert.strictEqual(v.showCountdown, false, "aucun écran 07");
    assert.strictEqual(v.digit, 0, "aucun chiffre (jamais 0)");
    only(w.A.logs, "dispatchLeadMs=" + M.MIN_DISPATCH_LEAD_MS);
    only(w.B.logs, "START_PLAN_ACCEPTED");
  });

  /* 8 */
  w = buildWorld({});
  w.A.offsetAges = { [B]: 40000, [C]: 40000 };
  let rej = null;
  try { await w.A.machine.requestStart({ sid: SID }); } catch (e) { rej = e.message; }
  await flush();
  await block("fraîcheur J07 : sample périmé → START_REJECTED clock_stale", function () {
    assert.strictEqual(rej, "clock_stale");
    one(w.A.logs, "START_REJECTED");
    one(w.A.logs, "reason=clock_stale");
    assert.ok(/peers=\[B,C\]/.test(w.A.logs.join("\n")) || /peers=\[[^\]]*B[^\]]*C/.test(w.A.logs.join("\n")),
      "les pairs périmés sont nommés : " + w.A.logs.filter((l) => l.indexOf("START_CLOCK_FRESHNESS") >= 0).join(" | "));
    assert.strictEqual(w.A.machine.view().phase, M.PHASE_IDLE, "aucun plan créé");
    assert.strictEqual(w.B.machine.view().phase, M.PHASE_IDLE, "aucun plan reçu");
  });

  /* 9 + 10 + 11 */
  w = buildWorld({});
  const t0 = w.base.now();
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  const planA = w.A.machine.view();
  await block("plan adopté : top local de chaque device = targetStart + SON offset", function () {
    assert.strictEqual(planA.localTopMs, t0 + 5000, "A = référence (offset 0)");
    assert.strictEqual(w.B.machine.view().localTopMs, t0 + 5600, "B en avance de 600 ms");
    assert.strictEqual(w.C.machine.view().localTopMs, t0 + 4750, "C en retard de 250 ms");
    assert.strictEqual(w.B.machine.view().startPlanId, planA.startPlanId, "même startPlanId sur tous les devices");
    assert.strictEqual(w.C.machine.view().startPlanId, planA.startPlanId);
    assert.strictEqual(w.B.machine.view().digit, 5);
  });
  await advance(w, 5100);
  await block("top synchronisé : même instant RÉEL sur 3 devices (skews −250/0/+600)", function () {
    assert.strictEqual(w.A.starts.length, 1, "A démarre une fois");
    assert.strictEqual(w.B.starts.length, 1, "B démarre une fois");
    assert.strictEqual(w.C.starts.length, 1, "C démarre une fois");
    /* instant réel = localTop − skew */
    const realA = w.A.machine.view().lastStart.actualMs - w.skewOf(A);
    const realB = w.B.machine.view().lastStart.actualMs - w.skewOf(B);
    const realC = w.C.machine.view().lastStart.actualMs - w.skewOf(C);
    assert.strictEqual(Math.max(realA, realB, realC) - Math.min(realA, realB, realC), 0,
      "écart réel = " + (Math.max(realA, realB, realC) - Math.min(realA, realB, realC)) + " ms");
    assert.strictEqual(w.A.machine.view().lastStart.deltaMs, 0, "delta vs top local = 0");
    assert.strictEqual(w.B.machine.view().lastStart.deltaMs, 0);
    assert.strictEqual(w.C.machine.view().lastStart.deltaMs, 0);
    only(w.A.logs, "START_LOCAL");
    only(w.B.logs, "START_LOCAL");
    only(w.C.logs, "START_LOCAL");
    only(w.A.logs, "START_PLAN_COMPLETE");
    assert.strictEqual(w.A.machine.view().phase, M.PHASE_REC);
    only(w.B.logs, "START_NATIVE_ACK");
  });
  await block("countdown 5→4→3→2→1, JAMAIS 0, identique sur A et B", function () {
    assert.deepStrictEqual(uniqSeq(digitSeries(w.A.logs)), [5, 4, 3, 2, 1], "A : " + digitSeries(w.A.logs).join(","));
    assert.deepStrictEqual(uniqSeq(digitSeries(w.B.logs)), [5, 4, 3, 2, 1], "B : " + digitSeries(w.B.logs).join(","));
    assert.deepStrictEqual(uniqSeq(digitSeries(w.C.logs)), [5, 4, 3, 2, 1], "C : " + digitSeries(w.C.logs).join(","));
    none(w.A.logs, "digit=0");
    none(w.B.logs, "digit=0");
    none(w.C.logs, "digit=0");
  });

  /* 12 */
  w = buildWorld({});
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  const dup = w.net.wire.filter((e) => e.kind === "start_plan")[0].extra.plan;
  w.net.send(A, "start_plan", { sessionId: SID, plan: dup });
  await flush();
  await advance(w, 5100);
  await block("idempotence : plan dupliqué → START_PLAN_DUPLICATE, UN seul top", function () {
    only(w.B.logs, "START_PLAN_DUPLICATE");
    only(w.C.logs, "START_PLAN_DUPLICATE");
    assert.strictEqual(w.B.starts.length, 1);
    only(w.B.logs, "START_LOCAL");
    only(w.B.logs, "START_PLAN_COMPLETE");
  });

  /* 13 */
  w = buildWorld({});
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  const pid = w.A.machine.view().startPlanId;
  const stMsg = { sessionId: SID, startPlanId: pid, deviceId: B, takeNumber: 1, state: "EXCLUDED", message: "test" };
  w.net.send(B, "start_state", stMsg);
  w.net.send(B, "start_state", stMsg);
  await block("idempotence des états : deviceId + startPlanId + state", function () {
    /* ACCEPTED de B et C (un chacun, à l'adoption) + l'EXCLUDED injecté deux fois */
    only(w.A.logs, "peer=" + B + " state=EXCLUDED");
    only(w.A.logs, "peer=" + C + " state=ACCEPTED");
    only(w.A.logs, "peer=" + B + " state=ACCEPTED");
    none(w.A.logs, "peer=" + D + " state=");
    assert.strictEqual(w.A.machine.view().startableCaptures, 2, "B exclue → 2 Captures restantes");
    assert.strictEqual(w.A.machine.view().peerStates, 2, "deux pairs avec état");
  });

  /* 14 */
  w = buildWorld({});
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  w.sched.late = 40;                     /* réveil tardif du WebView */
  await advance(w, 5100);
  w.sched.late = 0;
  await block("START_LOCAL : delta mesuré vs top local (retard de 40 ms conservé)", function () {
    const la = w.A.machine.view().lastStart;
    const lb = w.B.machine.view().lastStart;
    assert.strictEqual(la.deltaMs, 40, "A : delta=" + la.deltaMs);
    assert.strictEqual(lb.deltaMs, 40, "B : delta=" + lb.deltaMs);
    const startLine = one(w.A.logs, "START_LOCAL");
    assert.ok(/deltaMs=40/.test(startLine), "START_LOCAL porte son delta : " + startLine);
    assert.ok(la.ackMs !== null, "ack natif mesuré séparément");
    const ackLine = one(w.A.logs, "START_NATIVE_ACK");
    assert.ok(/deltaMs=40/.test(ackLine), "l'ack natif porte SAU propre delta : " + ackLine);
    const line = one(w.A.logs, "START_LOCAL");
    assert.ok(/target=\d\d:\d\d:\d\d\.\d\d\d actual=\d\d:\d\d:\d\d\.\d\d\d/.test(line),
      "deux horodatages lisibles dans START_LOCAL : " + line);
  });

  /* 15 */
  w = buildWorld({});
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  await w.A.machine.cancel("master_cancel");
  await advance(w, 5100);
  await block("annulation par un Master → START_CANCEL, AUCUN top", function () {
    only(w.A.logs, "START_CANCEL");
    only(w.B.logs, "START_CANCEL");
    only(w.C.logs, "START_CANCEL");
    assert.strictEqual(w.B.starts.length, 0, "B n'a pas démarré");
    assert.strictEqual(w.C.starts.length, 0, "C n'a pas démarré");
    assert.strictEqual(w.B.machine.view().phase, M.PHASE_IDLE);
    assert.strictEqual(w.B.machine.view().startPlanId, null, "plan abandonné");
  });

  /* 16 */
  w = buildWorld({});
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  w.B.deps.isMasterRole = function () { return false; };
  let cancelErr = null;
  try { await w.B.machine.cancel("tentative"); } catch (e) { cancelErr = e.message; }
  await block("annulation refusée à un non-Master", function () {
    assert.strictEqual(cancelErr, "not_master");
    one(w.B.logs, "START_CANCEL_REJECT");
    assert.ok(w.A.machine.view().startPlanId !== null, "le plan reste actif");
  });

  /* 17 */
  w = buildWorld({});
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  await advance(w, 5100);
  const beforeStarts = w.B.starts.length;
  let lateCancelErr = null;
  try { await w.A.machine.cancel("trop_tard"); } catch (e) { lateCancelErr = e.message; }
  w.net.send(A, "start_cancel", { sessionId: SID, startPlanId: w.A.machine.view().startPlanId, byDeviceId: A, reason: "trop_tard" });
  await flush();
  await block("annulation APRÈS le top : ignorée, le REC reste engagé", function () {
    assert.strictEqual(lateCancelErr, "already_started");
    one(w.B.logs, "reason=already_started");
    assert.strictEqual(w.B.starts.length, beforeStarts, "aucun démarrage supplémentaire");
    assert.strictEqual(w.B.machine.view().phase, M.PHASE_REC, "B reste en REC");
  });

  /* 18 */
  w = buildWorld({});
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  w.B.connected = [B];
  w.C.connected = [C];
  await advance(w, 5100);
  await block("perte de TOUS les Masters après programmation → le top a lieu", function () {
    one(w.B.logs, "START_MASTER_LOST");
    assert.ok(/countdownContinues=1/.test(w.B.logs.join("\n")));
    assert.strictEqual(w.B.starts.length, 1, "B démarre au top prévu");
    assert.strictEqual(w.C.starts.length, 1, "C démarre au top prévu");
  });

  /* 19 */
  w = buildWorld({});
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  w.B.ready = false;
  await advance(w, 1000);
  await block("Capture ERROR avant le top → CAPTURE_EXCLUDED + sortie du countdown", function () {
    one(w.B.logs, "CAPTURE_EXCLUDED");
    const v = w.B.machine.view();
    assert.strictEqual(v.excluded, true);
    assert.ok(v.excludeMessage.length > 0, "cause affichée");
    assert.strictEqual(v.showCountdown, false, "elle quitte le countdown");
    assert.strictEqual(w.A.machine.view().startableCaptures, 2, "le leader la compte exclue");
  });
  await advance(w, 4200);
  await block("…et elle ne démarre PAS au top (START_LOCAL status=SKIPPED)", function () {
    assert.strictEqual(w.B.starts.length, 0, "aucun enregistrement");
    one(w.B.logs, "status=SKIPPED");
    assert.strictEqual(w.B.machine.view().phase, M.PHASE_EXCLUDED);
    assert.strictEqual(w.C.starts.length, 1, "C démarre toujours");
  });

  /* 20 */
  w = buildWorld({});
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  w.B.ready = false;
  await advance(w, 600);
  w.B.ready = true;
  await advance(w, 1400);
  await block("Capture réintégrée avant le top → CAPTURE_REINTEGRATED", function () {
    only(w.B.logs, "CAPTURE_REINTEGRATED");
    assert.strictEqual(w.B.machine.view().excluded, false);
    assert.strictEqual(w.A.machine.view().startableCaptures, 3, "le leader la recompte");
    assert.ok(w.A.logs.filter((l) => /peer=dev-B state=REINTEGRATED/.test(l)).length === 1);
  });
  await advance(w, 3800);
  await block("…et elle démarre au top (exactement une fois)", function () {
    assert.strictEqual(w.B.starts.length, 1);
    one(w.B.logs, "START_LOCAL");
    only(w.B.logs, "START_PLAN_COMPLETE");
  });

  /* 21 */
  w = buildWorld({ captures: [B, C] });
  w.A.armDevices = [armDevice(B, ["capture"]), armDevice(C, ["capture"]), armDevice(S, ["storage"]), armDevice(A, [])];
  w.A.armCycleId = SID + "#1#1";
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  w.B.ready = false;
  w.C.ready = false;
  await advance(w, 1200);
  await block("zéro Capture démarrable → annulation AUTO (no_startable_capture)", function () {
    one(w.A.logs, "reason=no_startable_capture");
    only(w.A.logs, "START_CANCEL");
    one(w.B.logs, "START_CANCEL");
    assert.strictEqual(w.A.machine.view().phase, M.PHASE_IDLE, "retour ARM (plan abandonné)");
    assert.strictEqual(w.B.machine.view().phase, M.PHASE_IDLE);
    assert.strictEqual(w.B.machine.view().startPlanId, null);
  });
  await advance(w, 5000);
  await block("…personne ne démarre après l'annulation auto", function () {
    assert.strictEqual(w.B.starts.length, 0);
    assert.strictEqual(w.C.starts.length, 0);
    assert.strictEqual(w.A.starts.length, 0, "A est Master seul, pas Capture");
  });

  /* 22 */
  w = buildWorld({});
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  await advance(w, 5100);
  await block("READY/WARNING : chaque Capture démarre UNE SEULE fois", function () {
    assert.strictEqual(w.A.starts.length, 1);
    assert.strictEqual(w.B.starts.length, 1);
    assert.strictEqual(w.C.starts.length, 1);
    assert.strictEqual(w.B.starts[0].takeNumber, 1);
    assert.strictEqual(w.B.starts[0].startPlanId, w.A.machine.view().startPlanId);
    one(w.B.logs, "START_LOCAL");
    only(w.B.logs, "START_NATIVE_ACK");
  });

  /* 23 */
  w = buildWorld({});
  w.A.offsets = { [B]: 600 };           /* C n'est PAS mesuré */
  let stale = null;
  try { await w.A.machine.requestStart({ sid: SID }); } catch (e) { stale = e.message; }
  const ghostPlan = {
    startPlanId: M.planId(SID + "#1#1", 9),
    sessionId: SID, sessionName: "Session J08", takeNumber: 1,
    armCycleId: SID + "#1#1",
    targetStartMs: w.base.now() + 5000, countdownSeconds: 5,
    createdByDeviceId: A, createdAtMs: w.base.now(),
    clockOffsets: { [B]: 600 },
    participants: [
      { deviceId: A, deviceName: "nom-A", role: "capture", takeNumber: 1 },
      { deviceId: B, deviceName: "nom-B", role: "capture", takeNumber: 1 },
      { deviceId: C, deviceName: "nom-C", role: "capture", takeNumber: 1 }
    ]
  };
  w.net.send(A, "start_plan", { sessionId: SID, plan: ghostPlan });
  await flush();
  await advance(w, 1200);
  await block("Capture sans offset dans le plan → sonde sans réponse → exclusion honnête", function () {
    assert.strictEqual(stale, "clock_stale", "le leader refuse un plan non mesuré");
    assert.strictEqual(w.B.machine.view().startPlanId, ghostPlan.startPlanId, "B a bien l'offset : il démarre");
    one(w.C.logs, "START_PROBE_UNKNOWN");
    const v = w.C.machine.view();
    assert.strictEqual(v.offsetKnown, false, "aucune horloge inventée");
    assert.strictEqual(v.excluded, true);
    one(w.C.logs, "reason=offset_inconnu");
  });
  await advance(w, 5000);
  await block("…aucun faux top sur cette Capture", function () {
    assert.strictEqual(w.C.starts.length, 0);
    assert.strictEqual(w.B.starts.length, 1, "B démarre normalement");
  });

  /* 24 */
  w = buildWorld({});
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  await advance(w, 400);
  await block("Master non participant : sonde NTP → offset résolu, countdown correct", function () {
    one(w.D.logs, "START_PROBE");
    const v = w.D.machine.view();
    assert.strictEqual(v.isCapture, false);
    assert.strictEqual(v.offsetKnown, true);
    assert.strictEqual(Math.round(v.offsetMs), 900, "offset = C_D − C_A = +900 ms (convention Local − Créateur)");
    assert.ok(/rtt=\d+ms/.test(w.D.logs.join("\n")), "RTT journalisée (J07)");
    /* Le compte à rebours de l'observateur porte le MÊME temps restant que
     * celui du leader : les deux tops locaux correspondent au même instant
     * réel (les phases de tick peuvent différer, la cible, non). */
    const remA = w.A.machine.view().localTopMs - w.A.deps.nowMs();
    const remD = v.localTopMs - w.D.deps.nowMs();
    assert.strictEqual(remA, remD, "même temps restant projeté (A=" + remA + " D=" + remD + ")");
    assert.strictEqual(v.digit, M.digitFor(v.remainingMs, v.countdownSeconds), "chiffre = ceil(restant)");
    assert.ok(v.digit >= 1 && v.digit <= 5, "compte à rebours dans [1..5] : " + v.digit);
    assert.strictEqual(v.showCountdown, true);
  });
  await advance(w, 5000);
  await block("…et le Master observateur n'exécute AUCUN enregistrement", function () {
    assert.strictEqual(w.D.starts.length, 0);
    one(w.D.logs, "status=OBSERVER");
    assert.strictEqual(w.D.machine.view().phase, M.PHASE_REC);
    only(w.D.logs, "START_PLAN_COMPLETE");
  });

  /* 25 */
  w = buildWorld({});
  const ghost2 = Object.assign({}, ghostPlan, {
    startPlanId: M.planId(SID + "#9#9", 1),
    createdByDeviceId: "dev-absent",
    armCycleId: SID + "#9#9",
    targetStartMs: w.base.now() + 5000
  });
  w.net.send("dev-absent", "start_plan", { sessionId: SID, plan: ghost2 });
  await flush();
  await advance(w, 1200);
  await block("sonde sans réponse → START_PROBE_UNKNOWN, dégradé HONNÊTE (pas de faux top)", function () {
    one(w.D.logs, "START_PROBE_UNKNOWN");
    const v = w.D.machine.view();
    assert.strictEqual(v.countdownResolved, false, "l'offset reste inconnu");
    assert.strictEqual(v.isCapture, false, "D n'est pas Capture : il n'est donc PAS exclu");
    /* Dégradé assumé : le chiffre affiché peut être faux de l'offset inconnu,
     * mais AUCUNE décision de top n'est prise (offsetKnown=false). */
    assert.ok(v.digit >= 1 && v.digit <= 5, "un compte à rebours reste affiché : " + v.digit);
    only(w.D.logs, "START_PROBE_UNKNOWN");
    assert.strictEqual(v.localTopMs, ghost2.targetStartMs, "top dégradé = cible brute (offset supposé 0)");
    assert.strictEqual(v.excluded, false, "l'observateur n'est PAS exclu : il n'a pas de media");
    /* Les Captures sans offset, elles, sont exclues et le disent au groupe. */
    only(w.A.logs, "peer=" + C + " state=EXCLUDED message=offset_inconnu");
    only(w.C.logs, "reason=offset_inconnu");
  });
  await advance(w, 5000);
  await block("…le plan fantôme ne démarre de média chez personne", function () {
    assert.strictEqual(w.D.starts.length, 0);
    assert.strictEqual(w.A.starts.length, 0, "A n'a pas de plan fantôme");
  });

  /* 26 */
  w = buildWorld({});
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  await advance(w, 5100);
  const flagWithMaster = w.B.machine.view().showEmergencyStop;
  w.B.connected = [B];
  await advance(w, 400);
  const flagNoMaster = w.B.machine.view().showEmergencyStop;
  w.B.connected = [A, B, C];
  await advance(w, 300);
  const flagBack = w.B.machine.view().showEmergencyStop;
  await w.B.machine.stopLocal("urgence_sans_master");
  let restartErr = null;
  try { await w.B.machine.requestStart({ sid: SID }); } catch (e) { restartErr = e.message; }
  await block("STOP local d'urgence : visible SANS Master, absent AVEC Master", function () {
    assert.strictEqual(flagWithMaster, false, "pas de STOP d'urgence si un Master est joignable");
    assert.strictEqual(flagNoMaster, true, "STOP d'urgence visible sans Master");
    assert.strictEqual(flagBack, false, "le bouton disparaît si un Master revient");
  });
  await block("STOP local : arrêt unique, phase STOPPED, Take interdit de redémarrage", function () {
    assert.strictEqual(w.B.stops.length, 1, "stopRecording appelé une fois");
    only(w.B.logs, "START_STOP_LOCAL");
    assert.strictEqual(w.B.machine.view().phase, M.PHASE_STOPPED);
    assert.strictEqual(w.B.machine.view().localStoppedTake, true);
    assert.strictEqual(w.B.machine.view().stoppedTakeNumber, 1);
    assert.strictEqual(restartErr, "local_stopped_take", "pas de redémarrage dans le MÊME Take");
    one(w.B.logs, "reason=local_stopped_take");
  });
  await block("STOP local : les autres Captures ne sont pas affectées", function () {
    assert.strictEqual(w.C.starts.length, 1);
    assert.strictEqual(w.C.machine.view().phase, M.PHASE_REC);
    assert.strictEqual(w.C.machine.view().localStoppedTake, false);
  });

  /* 27 */
  w = buildWorld({});
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  await advance(w, 5100);
  await block("rôle Storage : suit l'état du Take, aucun media, aucune vue countdown", function () {
    const v = w.S.machine.view();
    assert.strictEqual(v.isStorage, true);
    assert.strictEqual(v.isCapture, false);
    assert.strictEqual(v.phase, M.PHASE_REC, "le Storage suit l'état du Take");
    assert.strictEqual(v.showCountdown, false, "pas de vue countdown plein écran");
    assert.strictEqual(w.S.starts.length, 0, "un Storage n'enregistre pas");
    one(w.S.logs, "status=OBSERVER");
    assert.strictEqual(w.S.machine.view().startPlanId, w.A.machine.view().startPlanId, "il connaît le plan");
  });

  /* 28 */
  /* Course réelle : la diffusion des plans est différée, donc A et D créent
   * chacun leur plan AVANT de voir celui de l'autre. L'arbitrage par
   * startPlanId doit faire converger tout le monde sur le même plan. */
  w = buildWorld({ armCycleIdFor: { [A]: SID + "#1#1", [D]: SID + "#1#2" } });
  w.net.planLag = 50;
  /* D garde les offsets J07 par défaut (pair − local) : son plan porte donc la
   * MÊME cible réelle que celui de A (créés au même instant, même countdown). */
  await w.A.machine.requestStart({ sid: SID });
  await w.D.machine.requestStart({ sid: SID });
  await flush();
  const planA0 = w.A.machine.view().startPlanId;
  const planD0 = w.D.machine.view().startPlanId;
  assert.notStrictEqual(planA0, planD0, "deux plans concurrents coexistent bien avant arbitrage");
  assert.strictEqual(M.choosePlanId(planA0, planD0), planD0, "le plan du cycle ARM le plus récent gagne");
  await advance(w, 5200);
  await block("plans concurrents : startPlanId gagnant identique partout, UN seul top", function () {
    const winner = M.choosePlanId(planA0, planD0);
    assert.strictEqual(w.A.machine.view().startPlanId, winner, "A a convergé vers le gagnant");
    assert.strictEqual(w.D.machine.view().startPlanId, winner, "D a convergé vers le gagnant");
    assert.strictEqual(w.B.machine.view().startPlanId, winner, "B a convergé vers le gagnant");
    assert.strictEqual(w.C.machine.view().startPlanId, winner, "C a convergé vers le gagnant");
    one(w.A.logs, "START_PLAN_REPLACED");
    one(w.D.logs, "START_PLAN_SUPERSEDED");
    assert.strictEqual(w.A.starts.length, 1, "un seul top local sur A");
    assert.strictEqual(w.B.starts.length, 1, "un seul top local sur B");
    assert.strictEqual(w.C.starts.length, 1, "un seul top local sur C");
    only(w.B.logs, "START_PLAN_COMPLETE");
  });

  /* 29 */
  /* Un second Master ne voit jamais le premier plan (hors réseau) et crée le
   * sien APRÈS le top : personne ne doit enregistrer deux fois le même Take. */
  w = buildWorld({ armCycleIdFor: { [A]: SID + "#1#1", [D]: SID + "#1#2" } });
  w.net.unregister(D);
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  await advance(w, 5100);
  const startedA = w.A.starts.length;
  await w.D.machine.requestStart({ sid: SID });
  await flush();
  await advance(w, 2000);
  await block("plan concurrent APRÈS le top local → refusé (barrière anti-double-REC)", function () {
    assert.strictEqual(startedA, 1, "A a démarré une fois");
    assert.strictEqual(w.A.starts.length, 1, "A n'a PAS redémarré");
    assert.strictEqual(w.B.starts.length, 1, "B n'a PAS redémarré");
    assert.strictEqual(w.C.starts.length, 1, "C n'a PAS redémarré");
    only(w.A.logs, "START_PLAN_DROP");
    only(w.A.logs, "reason=local_already_started");
    only(w.B.logs, "reason=local_already_started");
    only(w.C.logs, "reason=local_already_started");
    assert.strictEqual(w.A.machine.view().localStartedTake, true);
    assert.strictEqual(w.A.machine.view().phase, M.PHASE_REC, "A reste en REC sur SON plan");
  });
  /* 30 */
  /* START sans cycle ARM actif (armView().armCycleId absent) : l'armCycleId de
   * repli doit rester un format de plan VALIDE (tentative numérique 0), sinon
   * le plan est rejeté comme malformed par TOUS les devices, y compris le
   * créateur — une dégradation silencieuse. */
  w = buildWorld({ noArmCycle: true });
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  const noArmV = w.A.machine.view();
  await block("sans cycle ARM : armCycleId de repli VALIDE, plan adopté, journalisé", function () {
    assert.strictEqual(noArmV.phase, M.PHASE_COUNTDOWN, "le plan entre en countdown");
    assert.ok(M.isPlanFmt(noArmV.startPlanId), "format de plan valide : " + noArmV.startPlanId);
    assert.strictEqual(noArmV.armCycleId, SID + "#1#0", "tentative de repli = 0 (numérique)");
    only(w.A.logs, "START_PLAN_NO_ARM_CYCLE");
    only(w.A.logs, "note=start_sans_arme");
    assert.ok(w.A.logs.some((l) => l.indexOf("START_PLAN_DROP") >= 0) === false,
      "aucun START_PLAN_DROP : le plan n'est pas rejeté");
  });

  let rejectErr = null;
  try { await w.A.machine.requestStart({ sid: SID }); } catch (e) { rejectErr = e.message; }
  await block("…et une nouvelle demande de REC pendant le REC est rejetée (plan_active)", function () {
    assert.strictEqual(rejectErr, "plan_active");
    only(w.A.logs, "reason=plan_active");
  });

  console.log("\nOK — " + blocks + " blocs, tous verts.");
}

main().catch(function (err) {
  console.error("\nECHEC : " + (err && err.message));
  console.error(err && err.stack);
  process.exit(1);
});
