/* MultiCam J10 — STOP global coordonné (app/www/js/state/start-model.js).
 *
 * Déterministe, sans DOM : horloge, timers et réseau sont INJECTÉS via les
 * dépendances de `createMachine`. Trois devices ou plus partagent un bus qui
 * applique la convention J07 (offsets Local − Créateur) ; on vérifie le STOP
 * GLOBAL de bout en bout :
 *
 *   J10.1  nominal (Master + 1 Capture) → même instant réel, stop_state mesuré
 *   J10.2  multi-captures (2 Captures) → chacune son stop_state, deltas nuls
 *   J10.3  idempotence : double requestStop + stop_request rejoué = 1 seul arrêt
 *   J10.4  déjà STOPPED → late ack (republish), JAMAIS de redémarrage
 *   J10.5  cohérence Take/media : durée > 0, path, phase STOPPED
 *   J10.6  reconnexion APRÈS STOP → aucun replay de START
 *   J10.7  Capture absente au STOP → INCIDENT, levé à sa reconnexion
 *   J10.8  session ouverte après STOP (aucun close, plan conservé)
 *   J10.9  deux Masters : convergence sur le MÊME stopId (un seul arrêt)
 *   J10.10 garde J09 : un seul start/stop physique, aucun timer résiduel
 *
 * Journalisation exigée par le plan : STOP_REQUEST session=… take=… target=…
 * et STOP_LOCAL session=… take=… actual=… (asserés ici).
 */

"use strict";

const path = require("path");
const assert = require("assert");
const M = require(path.resolve(__dirname, "../www/js/state/start-model.js"));

const SID = "session-J10";
const A = "dev-A";   /* Master + créateur du STOP */
const B = "dev-B";   /* Capture */
const C = "dev-C";   /* Capture */
const D = "dev-D";   /* Master observateur (non participant) */
const S = "dev-S";   /* Storage */

/* ---------- horloge simulée (base commune) + ordonnanceur ---------- */

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
  this.pending = function () { return self.q.filter((e) => !e.dead).length; };
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
    probeLag: 120,
    planLag: 0,
    wire: [],
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

function makeSession(captures, storages) {
  const roles = {};
  [A, B, C, D].forEach((d) => { roles[d] = (captures.indexOf(d) >= 0) ? ["capture", "master"] : ["master"]; });
  roles[S] = ["storage"];
  return {
    sessionId: SID, name: "Session J10", state: "open",
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
        countdownSeconds: 0,
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

/* ---------- machine de test ---------- */

function makeNode(opts) {
  const did = opts.did;
  const net = opts.net;
  const node = {
    did: did,
    logs: [],
    starts: [],
    stops: [],
    changes: [],
    ready: true,
    offsets: opts.offsets || {},
    offsetAges: opts.offsetAges || {},
    armCycleId: opts.armCycleId !== undefined ? opts.armCycleId : (SID + "#1#1"),
    armDevices: opts.armDevices || [],
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
    startRecording: function (req) { node.starts.push({ atMs: opts.clock.now(), req: req }); return Promise.resolve({ atMs: opts.clock.now(), detail: "sim" }); },
    stopRecording: function () { node.stops.push(opts.clock.now()); return Promise.resolve({ atMs: opts.clock.now(), detail: "sim", path: "file:///take.mp4" }); },
    connectedMasters: function () { return node.connected; },
    peerConnected: function (d) { return node.connected.indexOf(d) >= 0 && !!opts.appPeers[opts.appPeers.indexOf(d)]; },
    sendStartPlan: function (ses, plan) { net.send(did, "start_plan", { sessionId: ses.sessionId, plan: plan }); },
    sendStartCancel: function (ses, msg) { net.send(did, "start_cancel", Object.assign({ sessionId: ses.sessionId }, msg)); },
    sendStartState: function (ses, msg) { net.send(did, "start_state", Object.assign({ sessionId: ses.sessionId }, msg)); },
    sendStartProbe: function (ses, msg) { net.send(did, "start_probe", Object.assign({ sessionId: ses.sessionId }, msg)); },
    sendStopRequest: function (sid, msg) { net.send(did, "stop_request", Object.assign({ sessionId: sid }, msg)); },
    sendStopState: function (sid, msg) { net.send(did, "stop_state", Object.assign({ sessionId: sid }, msg)); },
    log: function (l) { node.logs.push(l); },
    onChange: function () { node.changes.push(Date.now()); }
  };
  node.machine = M.createMachine(node.deps);
  net.register(did, node.machine);
  return node;
}

const SKEWS = { [A]: 0, [B]: 600, [C]: -250, [D]: 900 };

/* Un monde J10 complet, avec des Captures explicites. `appPeers` = la
 * connectivité RÉELLE vue par les pairs (peerConnected), distincte des rôles. */
function buildWorld(opts) {
  opts = opts || {};
  const T = opts.T || 1000000;
  const base = new SimClock(T);
  const sched = new FakeSched(base);
  const net = makeNet(sched, base);
  const captures = opts.captures || [B];
  const ses = makeSession(captures, opts.storages || []);
  const skews = opts.skews || SKEWS;
  const nodes = {};
  const appPeers = opts.appPeers || [A, B, C, D, S];
  function mk(did, extra) {
    const localClock = { now: function () { return base.now() + (skews[did] || 0); } };
    const n = makeNode(Object.assign({
      did: did, clock: localClock, sched: sched, net: net, session: ses,
      armCycleId: SID + "#1#1",
      armDevices: [],
      connected: [A, B, C, D, S],
      appPeers: appPeers
    }, extra || {}));
    n.baseClock = base;
    nodes[did] = n;
    return n;
  }
  const w = { base: base, sched: sched, net: net, ses: ses, nodes: nodes, skews: skews };
  w.A = mk(A);
  w.B = mk(B, { offsets: { [A]: -600, [C]: -850 } });
  w.C = mk(C, { offsets: { [A]: 250, [B]: 850 } });
  w.D = mk(D, { offsets: { [A]: -900, [B]: -300, [C]: -1150 } });
  w.S = mk(S, { offsets: { [A]: -900, [B]: -300, [C]: -1150 } });
  /* Le créateur A voit les périphériques ARM de son plan (rôles STRICTS). */
  const devs = captures.map((d) => armDevice(d, ["capture"]));
  (opts.storages || []).forEach((s) => devs.push(armDevice(s, ["storage"])));
  devs.push(armDevice(A, []));
  w.A.armDevices = devs;
  /* Le créateur A mesure ses pairs (convention peer − A). */
  w.A.deps.armClockOffsets = function () {
    const out = {};
    captures.forEach((d) => { out[d] = { offsetMs: skews[d] || 0, ageMs: 1000 }; });
    return out;
  };
  return w;
}

/* Fait démarrer un Take par A et attend le REC effectif de toutes les Captures. */
async function runToRec(w, captures) {
  captures = captures || [];
  await w.A.machine.requestStart({ sid: SID });
  await flush();
  await advance(w, M.MIN_DISPATCH_LEAD_MS + 400);
  captures.forEach((d) => {
    assert.strictEqual(w.nodes[d].machine.view().phase, M.PHASE_REC, d + " doit être en REC");
    assert.strictEqual(w.nodes[d].starts.length, 1, d + " a démarré une fois");
  });
  assert.strictEqual(w.A.machine.view().phase, M.PHASE_REC, "A (Master) suit le Take");
}

/* ---------- assertions ---------- */

function flush() { return new Promise((r) => { setImmediate(r); }); }

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

function numField(line, key) {
  const m = new RegExp(key + "=(-?\\d+)").exec(line || "");
  return m ? Number(m[1]) : null;
}

/* ===================================================================== */

module.exports = {
  register(h) {
    const { describe, it } = h;

    describe("J10 · STOP global coordonné (modèle pur, bus local)", () => {

      it("J10.1 nominal : Master + 1 Capture → même instant réel, stop_state mesuré", async () => {
        const w = buildWorld({ captures: [B] });
        await runToRec(w, [B]);

        const plan = w.A.machine.state.plan;
        const targetStart = plan.targetStartMs;
        await w.A.machine.requestStop("master_stop");
        await flush();

        /* Le log exigé par le plan porte session/take/target. */
        const req = one(w.A.logs, "STOP_REQUEST sessionId=" + SID);
        assert.ok(req.indexOf("take=1") >= 0, "take dans STOP_REQUEST");
        assert.ok(/target=\d+/.test(req), "target absolue dans STOP_REQUEST");

        /* Accord reçu par la Capture, top d'arrêt planifié. */
        one(w.B.logs, "STOP_REQUEST_ACCEPTED");
        const stop = w.A.machine.view().stop;
        assert.ok(stop && stop.stopId === plan.startPlanId + "#stop", "stopId = startPlanId#stop");

        await advance(w, M.STOP_LEAD_MS + M.STOP_ACK_TIMEOUT_MS + 300);

        /* Un seul arrêt physique par Capture, phases STOPPED partout. */
        assert.strictEqual(w.B.stops.length, 1, "un seul stopRecordVideo");
        one(w.B.logs, "STOP_LOCAL sessionId=" + SID);
        assert.strictEqual(w.B.machine.view().phase, M.PHASE_STOPPED);
        assert.strictEqual(w.A.machine.view().phase, M.PHASE_STOPPED);
        assert.strictEqual(w.A.starts.length, 0, "A Master observateur n'enregistre pas");
        assert.strictEqual(w.A.stops.length, 0, "A n'a pas de média à arrêter");

        /* Mesure honnête : le top d'arrêt local de B correspond au même instant
         * réel que celui de A (offset +600 ms, skew B = +600 ms). */
        const localTargetB = stop.targetStopMs + stop.clockOffsets[B];
        assert.strictEqual(w.B.stops[0], localTargetB, "B s'arrête à SON instant cible local");
        const fB = has(w.A.logs, "STOP_STATE deviceId=" + A + " stopId=")
          .filter((l) => l.indexOf("peer=dev-B") >= 0)[0];
        assert.ok(fB, "stop_state de B reçu par A");
        assert.ok(/state=STOPPED/.test(fB), "stop_state de B : " + fB);
        assert.strictEqual(numField(fB, "deltaMs"), 0, "delta mesuré (0 sur horloge déterministe)");
        assert.ok(w.A.machine.view().stopStates[B], "stopStates[B] renseigné");
        assert.deepStrictEqual(w.A.machine.view().stopIncidentDids, [], "aucun incident");
        /* Le Take a réellement duré. */
        assert.ok(w.A.machine.view().stopDurationMs > 0, "durée A > 0");
        assert.ok(w.B.machine.view().stopDurationMs > 0, "durée B > 0");
      });

      it("J10.2 multi-captures : chaque Capture son stop_state, deltas nuls", async () => {
        const w = buildWorld({ captures: [B, C] });
        await runToRec(w, [B, C]);
        await w.A.machine.requestStop("master_stop");
        await flush();
        await advance(w, M.STOP_LEAD_MS + M.STOP_ACK_TIMEOUT_MS + 300);

        assert.strictEqual(w.B.stops.length, 1);
        assert.strictEqual(w.C.stops.length, 1);
        assert.strictEqual(w.B.machine.view().phase, M.PHASE_STOPPED);
        assert.strictEqual(w.C.machine.view().phase, M.PHASE_STOPPED);
        const st = w.A.machine.view().stopStates;
        assert.ok(st[B] && st[C], "deux stop_state distincts sur le Master");
        assert.strictEqual(st[B].deltaMs, 0);
        assert.strictEqual(st[C].deltaMs, 0);
        only(w.A.logs, "STOP_REQUEST sessionId=" + SID);
        assert.deepStrictEqual(w.A.machine.view().stopIncidentDids, []);
      });

      it("J10.3 idempotence : double requestStop + stop_request rejoué = 1 arrêt", async () => {
        const w = buildWorld({ captures: [B] });
        await runToRec(w, [B]);

        await w.A.machine.requestStop("master_stop");
        await w.A.machine.requestStop("master_stop");      /* déjà actif */
        await flush();
        /* Rejeu du MÊME stop_request (autre Master paresseux / doublon réseau). */
        const txn = Object.assign({ sessionId: SID }, w.A.machine.view().stop);
        w.net.send(A, "stop_request", txn);
        w.net.send(A, "stop_request", txn);
        await flush();
        await advance(w, M.STOP_LEAD_MS + M.STOP_ACK_TIMEOUT_MS + 300);

        only(w.A.logs, "STOP_REQUEST sessionId=" + SID);   /* un seul déclenchement */
        one(w.A.logs, "reason=stop_active");               /* le 2e est ignoré */
        assert.strictEqual(w.B.stops.length, 1, "le doublon ne ré-arrête pas");
        assert.strictEqual(w.B.machine.view().phase, M.PHASE_STOPPED);
      });

      it("J10.4 déjà STOPPED : late ack (republish), JAMAIS de redémarrage", async () => {
        const w = buildWorld({ captures: [B] });
        await runToRec(w, [B]);
        await w.A.machine.requestStop("master_stop");
        await flush();
        await advance(w, M.STOP_LEAD_MS + M.STOP_ACK_TIMEOUT_MS + 300);

        /* Un stop_request tardif (autre Master, même plan/Take) re-tombe sur B
         * déjà STOPPED : B republie son stop_state, sans rien relancer. */
        const txn = Object.assign({ sessionId: SID }, w.A.machine.view().stop);
        w.net.send(D, "stop_request", txn);
        await flush();
        await advance(w, 400);

        one(w.B.logs, "STOP_STATE_REPUBLISH");
        assert.strictEqual(w.B.starts.length, 1, "aucun redémarrage");
        assert.strictEqual(w.B.stops.length, 1, "aucun second arrêt");
        assert.strictEqual(w.B.machine.view().phase, M.PHASE_STOPPED);
      });

      it("J10.5 cohérence Take/media : durée, path, phase STOPPED", async () => {
        const w = buildWorld({ captures: [B] });
        await runToRec(w, [B]);
        const recStart = w.B.machine.view().recStartedAtMs;
        await w.A.machine.requestStop("master_stop");
        await flush();
        await advance(w, M.STOP_LEAD_MS + 600);

        const v = w.B.machine.view();
        assert.strictEqual(v.phase, M.PHASE_STOPPED);
        assert.ok(v.recStartedAtMs === recStart, "le top de départ est conservé");
        assert.ok(v.stopDurationMs > 0, "durée finale > 0");
        assert.strictEqual(v.localStopInfo.path, "file:///take.mp4", "chemin du média conservé");
        assert.strictEqual(v.localStoppedTake, true, "Take verrouillé en local");
      });

      it("J10.6 reconnexion APRÈS STOP : aucun replay de START", async () => {
        const w = buildWorld({ captures: [B] });
        await runToRec(w, [B]);
        await w.A.machine.requestStop("master_stop");
        await flush();
        await advance(w, M.STOP_LEAD_MS + M.STOP_ACK_TIMEOUT_MS + 300);
        const plan = w.A.machine.state.plan;

        /* B reçoit à nouveau le plan de START (reSync/reconnexion) : il portait
         * DÉJÀ ce plan et est arrêté → duplicat idempotent, aucun nouveau top
         * (la double barrière reste localStartedTakes/DROP pour un autre plan). */
        w.net.send(A, "start_plan", { sessionId: SID, plan: plan });
        await flush();
        await advance(w, 800);

        assert.strictEqual(w.B.starts.length, 1, "aucun second démarrage");
        assert.strictEqual(w.B.stops.length, 1, "aucun second arrêt");
        assert.strictEqual(w.B.machine.view().phase, M.PHASE_STOPPED);
        one(w.B.logs, "START_PLAN_DUPLICATE");
        only(w.B.logs, "START_LOCAL deviceId=dev-B startPlanId=" + plan.startPlanId + " ");
      });

      it("J10.7 Capture absente au STOP → INCIDENT, levé à sa reconnexion", async () => {
        const w = buildWorld({ captures: [B], appPeers: [A, C, D, S] }); /* B absent du lien */
        await runToRec(w, [B]);
        /* B ne reçoit pas le stop_request (lien coupé). */
        w.net.unregister(B);
        w.A.connected = [A, C, D, S];

        await w.A.machine.requestStop("master_stop");
        await flush();
        await advance(w, M.STOP_LEAD_MS + M.STOP_ACK_TIMEOUT_MS + 300);

        assert.ok(w.A.machine.view().stopIncidents[B], "B marquée INCIDENT");
        one(w.A.logs, "STOP_INCIDENT deviceId=" + A + " stopId=");
        assert.ok(has(w.A.logs, "peer=dev-B reason=no_stop_state").length >= 1);

        /* B revient : la reconnexion constatée lève l'incident, sans replay. */
        w.net.register(B, w.B.machine);
        w.A.connected = [A, B, C, D, S];
        w.nodes.A = w.A;
        w.A.deps.peerConnected = function (d) { return w.A.connected.indexOf(d) >= 0; };
        await advance(w, M.TICK_MS * 3 + 50);

        assert.deepStrictEqual(w.A.machine.view().stopIncidentDids, [], "incident levé après reconnexion");
        one(w.A.logs, "STOP_RECONNECTED deviceId=" + A + " stopId=");
        assert.strictEqual(w.B.starts.length, 1, "toujours aucun redémarrage");
      });

      it("J10.8 session ouverte après STOP (plan conservé, aucun close)", async () => {
        const w = buildWorld({ captures: [B] });
        await runToRec(w, [B]);
        await w.A.machine.requestStop("master_stop");
        await flush();
        await advance(w, M.STOP_LEAD_MS + M.STOP_ACK_TIMEOUT_MS + 300);

        const v = w.A.machine.view();
        assert.strictEqual(v.active, true, "le plan reste actif (écran d'arrêt affichable)");
        assert.strictEqual(v.phase, M.PHASE_STOPPED);
        /* Aucun log de fermeture de session n'est produit par le modèle STOP. */
        none(w.A.logs, "SESSION_CLOSE");
        none(w.A.logs, "SESSION_CLOSED");
      });

      it("J10.9 deux Masters : convergence sur le MÊME stopId (un seul arrêt)", async () => {
        const w = buildWorld({ captures: [B] });
        await runToRec(w, [B]);
        const planId = w.A.machine.view().startPlanId;

        /* A et D déclenchent chacun leur STOP pour le même plan : par
         * construction stopId = startPlanId#stop → MÊME identité, donc B
         * n'exécute qu'un seul arrêt (dédup seenStops). */
        await w.A.machine.requestStop("master_stop");
        await flush();
        const txnD = Object.assign({ sessionId: SID }, w.A.machine.view().stop);
        txnD.createdByDeviceId = D;
        w.net.send(D, "stop_request", txnD);
        await flush();
        await advance(w, M.STOP_LEAD_MS + M.STOP_ACK_TIMEOUT_MS + 300);

        const stop = w.A.machine.view().stop;
        assert.strictEqual(stop.stopId, planId + "#stop");
        assert.strictEqual(w.B.stops.length, 1, "un seul arrêt malgré deux Masters");
        assert.strictEqual(w.B.machine.view().phase, M.PHASE_STOPPED);
      });

      it("J10.10 garde J09 : un seul start/stop physique, aucun timer résiduel", async () => {
        const w = buildWorld({ captures: [B] });
        await runToRec(w, [B]);
        assert.strictEqual(w.B.starts.length, 1);
        await w.A.machine.requestStop("master_stop");
        await flush();
        await advance(w, M.STOP_LEAD_MS + M.STOP_ACK_TIMEOUT_MS + 500);

        assert.strictEqual(w.B.starts.length, 1, "un seul démarrage");
        assert.strictEqual(w.B.stops.length, 1, "un seul arrêt");
        /* Après résolution (aucun incident), la fenêtre de surveillance se
         * referme : plus aucun timer programmé sur le bus partagé. */
        assert.strictEqual(w.sched.pending(), 0, "aucun timer résiduel après STOP résolu");
      });
    });
  }
};
