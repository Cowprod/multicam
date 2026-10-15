/* MultiCam J14-B01 — non-régression : cycle de vie & arbitrage des START PLANS
 * entre SESSIONS (app/www/js/state/start-model.js).
 *
 * Défaut d'origine (reproduit sur A/B/C le 2026-10-15, session GES3F6KY) :
 * `adoptPlan()` arbitrait deux plans concurrents via `choosePlanId()`, qui
 * compare les segments du planId DANS L'ORDRE — dont le sessionId EN PREMIER.
 * Comme `state.planId` est CONSERVÉ après un STOP (par design, pour l'acquittement
 * STOP tardif de J10), un plan périmé d'une ANCIENNE session « gagnait » encore
 * contre tout plan d'une nouvelle session dès que son sessionId était
 * lexicographiquement supérieur. Le REC ne démarrait jamais (START_PLAN_SUPERSEDED
 * kept=<ancienne session>).
 *
 * En prime, `localStartedTakes` / `localStoppedTakes` étaient indexés par
 * takeNumber SEUL : le Take 1 d'une nouvelle session entrait en collision avec le
 * Take 1 (déjà démarré/arrêté) d'une session précédente.
 *
 * Les 8 blocs ci-dessous verrouillent la correction :
 *   NR1  nouveau Take, MÊME session → remplace le plan terminé
 *   NR2  nouvelle session après STOP → enregistrée (le plan terminé ne bloque plus)
 *   NR3  ancienne session d'identifiant lexicalement SUPÉRIEUR → ne bloque plus
 *   NR4  ancienne session d'identifiant lexicalement INFÉRIEUR → ne bloque plus
 *   NR5  start_plan tardif d'une ancienne session pendant un REC → superseded
 *   NR6  plans concurrents MÊME session → arbitrage déterministe inchangé
 *   NR7  STOP puis nouveau Take sans redémarrage (même session)
 *   NR8  redémarrage/restauration : machine neuve, aucun plan résiduel
 *
 * Déterministe, sans DOM : horloge, timers et réseau INJECTÉS (même harnais que
 * j10-stop.test.js). Deux sessions partagent un leader (A) et une Capture (B).
 */

"use strict";

const path = require("path");
const assert = require("assert");
const M = require(path.resolve(__dirname, "../www/js/state/start-model.js"));

const A = "dev-A";   /* Master (créateur des plans) */
const B = "dev-B";   /* Capture */
const S = "dev-S";   /* Storage (participant sans machine ici) */

/* Sessions : identifiants choisis pour couvrir les deux ordres lexicaux. */
const OLD_HI = "S_ZZZ";   /* lexicalement SUPÉRIEUR à NEW_LO */
const NEW_LO = "S_AAA";
const OLD_LO = "S_AAA";
const NEW_HI = "S_ZZZ";

/* ---------- horloge simulée + ordonnanceur ---------- */

function SimClock(base) {
  let t = typeof base === "number" ? base : 1000000;
  this.now = function () { return t; };
  this.set = function (v) { t = v; };
  this.advance = function (ms) { t += ms; };
}

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

/* ---------- réseau simulé ---------- */

function makeNet(sched, base) {
  const nodes = {};
  const net = {
    probeLag: 0,
    planLag: 0,
    wire: [],
    register: function (did, machine) { nodes[did] = machine; },
    unregister: function (did) { delete nodes[did]; },
    deliver: function (fromDid, toDid, kind, extra) {
      const n = nodes[toDid];
      if (!n) return;
      const run = function () {
        const env = Object.assign({ v: 1, kind: kind, from: fromDid, ts: 0 }, extra);
        n.onIncoming(env, function (rkind, rextra) { net.deliver(toDid, fromDid, rkind, rextra); });
      };
      if (kind === "start_probe" || kind === "start_probe_reply") sched.at(run, base.now() + net.probeLag);
      else run();
    },
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

function take(n, captures, storages) {
  return {
    takeNumber: n,
    status: "PREPARATION",
    captures: captures,
    storages: storages || [],
    settings: {
      video: { resolution: "FHD", quality: "HIGH", camera: "REAR", orientation: "LANDSCAPE" },
      audio: true, gpsProfile: "NORMAL", countdownSeconds: 0,
      transferAuto: true, deleteLocalAfterVerifiedReplication: true
    },
    captureOverrides: {},
    createdAtMs: 0, updatedAtMs: 0, updatedByDeviceId: ""
  };
}

/* Session avec un ou plusieurs Takes. `createdAtMs` = ordre inter-sessions. */
function makeSession(sid, createdAtMs, takes) {
  return {
    sessionId: sid, name: "Session " + sid, state: "open",
    createdAtMs: createdAtMs,
    masters: [{ deviceId: A, deviceName: "nom-A", endpoint: "10.0.0.1:45102" }],
    members: [member(A, ["master"]), member(B, ["capture", "master"]), member(S, ["storage"])],
    takes: takes,
    removedMembers: {}
  };
}

/* ---------- machine de test ---------- */

function makeNode(opts) {
  const did = opts.did;
  const net = opts.net;
  const sessions = opts.sessions;
  const node = {
    did: did,
    logs: [], starts: [], stops: [],
    machine: null, deps: null
  };
  node.deps = {
    nowMs: function () { return opts.clock.now(); },
    schedule: function (fn, ms) { return opts.sched.schedule(fn, ms); },
    clearSchedule: function (t) { opts.sched.clear(t); },
    loadSession: function (sid) { return Promise.resolve(sessions[sid]); },
    selfDid: function () { return did; },
    isConnected: function () { return true; },
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
    /* Le leader A voit B comme Capture distante : le plan a un participant réel. */
    armView: function () {
      if (did !== A) return { armCycleId: opts.armCycleId || null, devices: [] };
      return {
        armCycleId: opts.armCycleId || null,
        devices: [
          { did: A, deviceName: "nom-A", skills: [] },
          { did: B, deviceName: "nom-B", skills: [{ skill: "capture", status: "READY" }] },
          { did: S, deviceName: "nom-S", skills: [{ skill: "storage", status: "READY" }] }
        ]
      };
    },
    armClockOffsets: function () { return { [B]: { offsetMs: 0, ageMs: 1000 } }; },
    refreshArmClock: function () { return Promise.resolve(); },
    countdownSecondsOf: function (t) { return t.settings.countdownSeconds; },
    captureReady: function () { return { ok: true, message: "" }; },
    startRecording: function (req) { node.starts.push(req); return Promise.resolve({ atMs: opts.clock.now(), detail: "sim" }); },
    stopRecording: function () { node.stops.push(opts.clock.now()); return Promise.resolve({ atMs: opts.clock.now(), detail: "sim", path: "file:///take.mp4" }); },
    connectedMasters: function () { return [A]; },
    peerConnected: function () { return false; },
    sendStartPlan: function (ses, plan) { net.send(did, "start_plan", { sessionId: ses.sessionId, plan: plan }); },
    sendStartCancel: function (ses, msg) { net.send(did, "start_cancel", Object.assign({ sessionId: ses.sessionId }, msg)); },
    sendStartState: function (ses, msg) { net.send(did, "start_state", Object.assign({ sessionId: ses.sessionId }, msg)); },
    sendStartProbe: function (ses, msg) { net.send(did, "start_probe", Object.assign({ sessionId: ses.sessionId }, msg)); },
    sendStopRequest: function (sid, msg) { net.send(did, "stop_request", Object.assign({ sessionId: sid }, msg)); },
    sendStopState: function (sid, msg) { net.send(did, "stop_state", Object.assign({ sessionId: sid }, msg)); },
    log: function (l) { node.logs.push(l); },
    onChange: function () {}
  };
  node.machine = M.createMachine(node.deps);
  net.register(did, node.machine);
  return node;
}

/* ---------- monde ---------- */

function simSched(base) { return new FakeSched(base); }

/* Construit un monde avec un ensemble de sessions.
 * `sessions` = { sid: sessionObject }. A et B sont instanciés.
 * Aucun cycle ARM n'est fourni : requestStart retombe sur l'armCycleId de repli
 * `ses.sessionId#take#0`, garantissant un planId cohérent avec la session. */
function buildWorld(sessions) {
  const base = new SimClock(1000000);
  const sched = simSched(base);
  const net = makeNet(sched, base);
  const nodes = {};
  function mk(did) {
    const localClock = { now: function () { return base.now(); } };
    const n = makeNode({ did: did, clock: localClock, sched: sched, net: net, sessions: sessions });
    n.baseClock = base;
    nodes[did] = n;
    return n;
  }
  const w = { base: base, sched: sched, net: net, sessions: sessions, nodes: nodes };
  w.A = mk(A);
  w.B = mk(B);
  return w;
}

/* ---------- helpers d'exécution ---------- */

function flush() { return new Promise((r) => { setImmediate(r); }); }

async function advance(w, ms, slice) {
  slice = slice || 50;
  const end = w.base.now() + ms;
  for (let guard = 0; guard < 5000 && w.base.now() < end; guard++) {
    w.sched.run(Math.min(end, w.base.now() + slice));
    await flush();
  }
}

function has(logs, needle) { return logs.filter((l) => l.indexOf(needle) >= 0); }
function one(logs, needle) {
  const f = has(logs, needle);
  assert.ok(f.length >= 1, "log attendu ABSENT : " + needle + "\n  logs: " + logs.join("\n  "));
  return f[0];
}
function none(logs, needle) { assert.strictEqual(has(logs, needle).length, 0, "log inattendu : " + needle); }

/* Fait démarrer et ARRÊTER un Take : A crée le plan, B (Capture) l'exécute. */
async function runToRecAndStop(w, sid) {
  await w.A.machine.requestStart({ sid: sid });
  await flush();
  await advance(w, M.MIN_DISPATCH_LEAD_MS + 400);
  await w.A.machine.requestStop("master_stop");
  await flush();
  await advance(w, M.STOP_LEAD_MS + M.STOP_ACK_TIMEOUT_MS + 300);
}

/* Un plan auto-suffisant injectable directement (session `sid`, take `n`). */
function rawPlan(sid, targetDid, n, seq, targetStartMs) {
  return {
    startPlanId: sid + "#" + n + "#0#" + seq,
    sessionId: sid,
    sessionName: "Session " + sid,
    takeNumber: n,
    armCycleId: sid + "#" + n + "#0",
    targetStartMs: targetStartMs,
    countdownSeconds: 0,
    dispatchLeadMs: M.MIN_DISPATCH_LEAD_MS,
    createdByDeviceId: A,
    createdAtMs: targetStartMs,
    clockOffsets: { [targetDid]: 0 },
    participants: [{ deviceId: B, deviceName: "nom-B", role: "capture", takeNumber: n }]
  };
}

/* ===================================================================== */

module.exports.register = function (h) {
  const { describe, it } = h;

  describe("J14-B01 · START PLAN — cycle de vie & arbitrage inter-sessions (NR)", () => {

    /* NR1 — nouveau Take, MÊME session : le plan terminé est remplacé. */
    it("NR1. nouveau Take même session : remplace un plan STOPPED", async () => {
      const sid = "S_ONE";
      const ses = makeSession(sid, 1000, [take(1, [B], [])]);
      const w = buildWorld({ [sid]: ses });
      await runToRecAndStop(w, sid);
      assert.strictEqual(w.B.machine.view().phase, M.PHASE_STOPPED, "take 1 arrêté");

      /* Un second Take du même Take est préparé (dernier Take de la session). */
      ses.takes.push(take(2, [B], []));
      await w.A.machine.requestStart({ sid: sid });
      await flush();
      await advance(w, M.MIN_DISPATCH_LEAD_MS + 400);

      assert.strictEqual(w.A.machine.state.plan.takeNumber, 2, "A adopte le Take 2");
      assert.strictEqual(w.B.machine.view().phase, M.PHASE_REC, "B enregistre le Take 2");
      one(w.A.logs, "START_PLAN_REPLACED");
      assert.strictEqual(w.B.starts.length, 2, "B a démarré deux fois (un par Take)");
    });

    /* NR2 — nouvelle session après STOP : le plan terminé ne bloque plus. */
    it("NR2. nouvelle session après STOP : REC de la nouvelle session (Take 1 identique)", async () => {
      const oldSid = "S_OLD1";
      const newSid = "S_NEW1";
      const w = buildWorld({
        [oldSid]: makeSession(oldSid, 1000, [take(1, [B], [])]),
        [newSid]: makeSession(newSid, 2000, [take(1, [B], [])])
      });
      await runToRecAndStop(w, oldSid);
      assert.strictEqual(w.B.machine.view().phase, M.PHASE_STOPPED);
      const startsAfterOld = w.B.starts.length;

      /* Nouvelle session, MÊME takeNumber=1 : sans scoping par session, la clé
       * « 1 » déjà démarrée/arrêtée bloquerait ce Take. */
      await w.A.machine.requestStart({ sid: newSid });
      await flush();
      await advance(w, M.MIN_DISPATCH_LEAD_MS + 400);

      assert.strictEqual(w.A.machine.view().startPlanId, w.B.machine.view().startPlanId,
        "A et B partagent le plan de la nouvelle session");
      assert.ok(w.B.machine.view().startPlanId.indexOf(newSid + "#") === 0,
        "le plan appartient à la nouvelle session : " + w.B.machine.view().startPlanId);
      assert.strictEqual(w.B.machine.view().phase, M.PHASE_REC, "B enregistre la nouvelle session");
      assert.strictEqual(w.B.starts.length, startsAfterOld + 1, "B a un nouveau REC (pas bloqué par l'ancien Take 1)");
      one(w.B.logs, "START_PLAN_CROSS_SESSION");
      none(w.B.logs, "reason=local_already_started");
    });

    /* NR3 — ancienne session lexicalement SUPÉRIEURE (le cas du défaut). */
    it("NR3. ancienne session d'id lexicalement SUPÉRIEUR : ne supersede plus", async () => {
      assert.ok(OLD_HI > NEW_LO, "prémisse : OLD_HI > NEW_LO lexicalement");
      const w = buildWorld({
        [OLD_HI]: makeSession(OLD_HI, 1000, [take(1, [B], [])]),
        [NEW_LO]: makeSession(NEW_LO, 2000, [take(1, [B], [])])
      });
      await runToRecAndStop(w, OLD_HI);

      await w.A.machine.requestStart({ sid: NEW_LO });
      await flush();
      await advance(w, M.MIN_DISPATCH_LEAD_MS + 400);

      assert.ok(w.B.machine.view().startPlanId.indexOf(NEW_LO + "#") === 0,
        "le plan de la nouvelle session (id inférieur) est bien adopté : " + w.B.machine.view().startPlanId);
      assert.strictEqual(w.B.machine.view().phase, M.PHASE_REC);
      none(w.B.logs, "kept=" + OLD_HI + "#1#0#1");
    });

    /* NR4 — ancienne session lexicalement INFÉRIEURE (doit continuer à marcher). */
    it("NR4. ancienne session d'id lexicalement INFÉRIEUR : ne supersede plus", async () => {
      assert.ok(OLD_LO < NEW_HI, "prémisse : OLD_LO < NEW_HI lexicalement");
      const w = buildWorld({
        [OLD_LO]: makeSession(OLD_LO, 1000, [take(1, [B], [])]),
        [NEW_HI]: makeSession(NEW_HI, 2000, [take(1, [B], [])])
      });
      await runToRecAndStop(w, OLD_LO);

      await w.A.machine.requestStart({ sid: NEW_HI });
      await flush();
      await advance(w, M.MIN_DISPATCH_LEAD_MS + 400);

      assert.ok(w.B.machine.view().startPlanId.indexOf(NEW_HI + "#") === 0,
        "nouvelle session adoptée : " + w.B.machine.view().startPlanId);
      assert.strictEqual(w.B.machine.view().phase, M.PHASE_REC);
    });

    /* NR5 — start_plan tardif d'une ANCIENNE session pendant un REC. */
    it("NR5. start_plan tardif d'une ancienne session pendant REC → superseded", async () => {
      const oldSid = "S_OLD5";
      const newSid = "S_NEW5";
      const w = buildWorld({
        [oldSid]: makeSession(oldSid, 1000, [take(1, [B], [])]),
        [newSid]: makeSession(newSid, 2000, [take(1, [B], [])])
      });
      /* On enregistre directement la NOUVELLE session (REC). */
      await w.A.machine.requestStart({ sid: newSid });
      await flush();
      await advance(w, M.MIN_DISPATCH_LEAD_MS + 400);
      assert.strictEqual(w.B.machine.view().phase, M.PHASE_REC, "B en REC sur la nouvelle session");
      const startsBefore = w.B.starts.length;

      /* Un plan de l'ANCIENNE session (périmé) arrive TARDIVEMENT. */
      const late = rawPlan(oldSid, B, 1, 9, w.base.now() + M.MIN_DISPATCH_LEAD_MS);
      await w.B.machine.onIncoming({ kind: "start_plan", from: A, plan: late });
      await flush();
      await advance(w, M.MIN_DISPATCH_LEAD_MS + 200);

      assert.strictEqual(w.B.machine.view().startPlanId, newSid + "#1#0#1", "B reste sur la nouvelle session");
      assert.strictEqual(w.B.machine.view().phase, M.PHASE_REC, "toujours en REC, pas de bascule");
      assert.strictEqual(w.B.starts.length, startsBefore, "AUCUN redémarrage parasite");
      const sup = one(w.B.logs, "START_PLAN_SUPERSEDED");
      assert.ok(sup.indexOf("reason=cross_session_active") >= 0, "superseded inter-session actif : " + sup);
    });

    /* NR6 — plans concurrents MÊME session : arbitrage déterministe inchangé. */
    it("NR6. plans concurrents même session : le plus grand identifiant gagne", async () => {
      const sid = "S_CONC";
      const w = buildWorld({ [sid]: makeSession(sid, 1000, [take(1, [B], [])]) });
      const p1 = rawPlan(sid, B, 1, 1, w.base.now() + M.MIN_DISPATCH_LEAD_MS);
      const p2 = rawPlan(sid, B, 1, 2, w.base.now() + M.MIN_DISPATCH_LEAD_MS);

      await w.B.machine.onIncoming({ kind: "start_plan", from: A, plan: p1 });
      await flush();
      assert.strictEqual(w.B.machine.view().startPlanId, p1.startPlanId, "premier plan adopté");

      await w.B.machine.onIncoming({ kind: "start_plan", from: A, plan: p2 });
      await flush();
      assert.strictEqual(w.B.machine.view().startPlanId, p2.startPlanId, "le plus grand identifiant remplace");

      await w.B.machine.onIncoming({ kind: "start_plan", from: A, plan: p1 });
      await flush();
      assert.strictEqual(w.B.machine.view().startPlanId, p2.startPlanId, "le plan périmé est superseded");
      one(w.B.logs, "START_PLAN_REPLACED");
      one(w.B.logs, "START_PLAN_SUPERSEDED");
    });

    /* NR7 — STOP puis nouveau Take, sans redémarrage du Take stoppé. */
    it("NR7. STOP puis nouveau Take : le Take stoppé ne redémarre jamais", async () => {
      const sid = "S_SEQ";
      const ses = makeSession(sid, 1000, [take(1, [B], [])]);
      const w = buildWorld({ [sid]: ses });
      await runToRecAndStop(w, sid);
      assert.strictEqual(w.B.machine.view().phase, M.PHASE_STOPPED);

      /* Re-demander le MÊME Take (dernier Take = 1) est refusé localement. */
      let err = null;
      try { await w.A.machine.requestStart({ sid: sid }); } catch (e) { err = e.message; }
      await flush();
      assert.strictEqual(err, "local_stopped_take", "Take stoppé verrouillé pour CE Take");

      /* Un nouveau Take (2) repart, lui. */
      ses.takes.push(take(2, [B], []));
      await w.A.machine.requestStart({ sid: sid });
      await flush();
      await advance(w, M.MIN_DISPATCH_LEAD_MS + 400);
      assert.strictEqual(w.A.machine.state.plan.takeNumber, 2, "Take 2 adopté");
      assert.strictEqual(w.B.machine.view().phase, M.PHASE_REC, "B enregistre le Take 2");
    });

    /* NR8 — redémarrage/restauration : machine neuve, aucun plan résiduel. */
    it("NR8. machine neuve (redémarrage) : aucun plan résiduel, adoption immédiate", async () => {
      const sid = "S_FRESH";
      const w = buildWorld({ [sid]: makeSession(sid, 1000, [take(1, [B], [])]) });
      /* machine neuve : state.planId null */
      assert.strictEqual(w.B.machine.view().active, false, "aucun plan au démarrage");
      const plan = rawPlan(sid, B, 1, 1, w.base.now() + M.MIN_DISPATCH_LEAD_MS);
      await w.B.machine.onIncoming({ kind: "start_plan", from: A, plan: plan });
      await flush();
      await advance(w, M.MIN_DISPATCH_LEAD_MS + 400);
      assert.strictEqual(w.B.machine.view().startPlanId, plan.startPlanId, "plan adopté sans résidu");
      one(w.B.logs, "START_PLAN_ACCEPTED");
      none(w.B.logs, "START_PLAN_SUPERSEDED");
    });
  });
};
