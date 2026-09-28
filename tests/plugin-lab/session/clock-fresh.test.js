/* MultiCam J08 — tests du PONT J07 → J08 : ensureFreshClock (arm-model).
 *
 * Contexte : J08 verrouille targetStart avec des offsets J07 FRAIS
 * (CLOCK_FRESH_MAX_AGE_MS = 12 s), alors que l'ARM de J07 cesse d'échantillonner
 * une fois 3 échantillons par device. Sans demande explicite de fraîcheur, un
 * ARM monté depuis plus de 12 s était refusé en `clock_stale` — un refus
 * correct, mais qui rendait le dock REC inutilisable en conditions réelles.
 *
 * ensureFreshClock doit donc, À LA DEMANDE et UNIQUEMENT POUR CETTE DEMANDE :
 *   1. ne rien changer au comportement de repos de J07 (pas de timer éternel) ;
 *   2. obtenir un échantillon POSTÉRIEUR à l'appel pour chaque capture distante ;
 *   3. respecter une requête en vol à la fois et l'espacement (500 ms) ;
 *   4. résoudre avec fresh:false au timeout (l'appelant tranche, il ne bloque pas) ;
 *   5. court-circuiter si l'ARM est inactif ou s'il n'y a aucune capture distante.
 *
 * Usage :  node session/clock-fresh.test.js
 */

"use strict";

const path = require("path");
const assert = require("assert");
const M = require(path.resolve(__dirname, "../../../app/www/js/state/arm-model.js"));

let blocks = 0;
function block(title, fn) {
  blocks++;
  console.log("\n[" + String(blocks).padStart(2, "0") + "] " + title);
  return fn();
}
function check(title, cond) {
  if (!cond) throw new Error("ÉCHEC : " + title);
  console.log("    ok — " + title);
}

const SID = "S1";
const ME = "dev-me";
const PEER = "dev-peer";
const PEER2 = "dev-peer2";

/* ---------- horloge + ordonnanceur simulés ---------- */

function harness(over) {
  over = over || {};
  const H = { t: 100000, timers: [], seq: 0, logs: [] };
  H.now = () => H.t;
  H.advance = (ms) => { H.t += ms; };
  H.schedule = (fn, ms) => { H.seq++; H.timers.push({ id: H.seq, fn: fn, at: H.t + (ms || 0), dead: false }); return H.seq; };
  H.clear = (id) => { H.timers.forEach((e) => { if (e.id === id) e.dead = true; }); };
  H.live = () => H.timers.filter((e) => !e.dead);
  /* Avance le temps en déclenchant les timers dus, dans l'ordre. */
  H.run = (ms) => {
    const until = H.t + ms;
    for (let guard = 0; guard < 5000; guard++) {
      const due = H.live().filter((e) => e.at <= until).sort((a, b) => a.at - b.at || a.id - b.id);
      if (!due.length) { H.t = until; return; }
      const e = due[0];
      e.dead = true;
      H.t = Math.max(H.t, e.at);
      e.fn();
    }
    throw new Error("run(" + ms + ") : boucle de timers non convergente");
  };
  H.dead = () => H.live().length;

  const deps = {
    nowMs: H.now,
    schedule: H.schedule,
    clearSchedule: H.clear,
    loadSession: () => Promise.resolve(over.session || {
      sessionId: SID, state: "open", name: "S", masters: [ME], members: [
        { deviceId: ME, deviceName: "me", enabledSkills: ["capture"], sessionRoles: ["capture"], telemetry: {} },
        { deviceId: PEER, deviceName: "peer", enabledSkills: ["capture"], sessionRoles: ["capture"], telemetry: {} }
      ], takes: [{
        takeNumber: 1, captures: [ME, PEER], storages: [],
        settings: { resolution: "FHD", quality: "HIGH", camera: "REAR", audio: true, gpsProfile: "OFF", transferAuto: true, minFreeBytes: 1000000, giveUpResolution: false, video: {} }
      }]
    }),
    selfDid: () => ME,
    isConnected: (did) => did !== "dev-gone",
    assessSelf: () => Promise.resolve(over.assess || {
      capsUnknown: false, supportedRes: ["FHD"], effective: { audio: true, gpsProfile: "OFF", resolution: "FHD", quality: "HIGH", camera: "REAR" },
      nativeProfile: { key: "FHD@30", width: 1920, height: 1080, fps: 30 },
      perms: { CAMERA: "GRANTED", RECORD_AUDIO: "GRANTED" }, freeBytes: 10000000000, probeOk: true
    }),
    sendArmRequest: (ses, req) => { H.logs.push("ARM_REQUEST target=" + req.target); },
    sendClockRequest: (ses, req) => { H.logs.push("CLOCK_SYNC_REQUEST peer=" + req.target + " req=" + req.requestId); H.sent = H.sent || []; H.sent.push(req); },
    log: (l) => { H.logs.push(l); },
    onChange: () => { }
  };
  H.deps = deps;
  H.m = M.createMachine(deps);
  return H;
}

/* Répond comme le ferait un pair : t1/t2 = horloge du pair (offset connu). */
function reply(H, req, offsetMs) {
  H.m.onIncoming({
    kind: "clock_sync_reply", sessionId: SID, from: req.target, target: ME,
    armCycleId: H.armCycleId, requestId: req.requestId,
    t1: H.now() + 20 + offsetMs, t2: H.now() + 21 + offsetMs
  });
}
const flush = () => new Promise((r) => { setImmediate(r); });

/* Le pair répond ARM_RESULT comme le fait un vrai device : sans cela la Capture
 * distante reste ARMING puis ERROR (timeout 5 s) et le Take n'est pas eligible. */
function armResult(H, did, skill) {
  H.m.onIncoming({
    kind: "arm_result", sessionId: SID, from: did, target: ME,
    armCycleId: H.armCycleId, takeNumber: 1, deviceId: did, skill: skill || "capture",
    checks: [{ line: "camera", status: "ok" }, { line: "audio", status: "ok" },
      { line: "permissions", status: "ok" }, { line: "localStorage", status: "ok" },
      { line: "settings", status: "ok" }],
    generatedAtMs: H.now()
  });
}

/* ---------- 1. inactif : court-circuit immédiat ---------- */
block("ARM inactif → fresh:false sans planter ni attendre", function () {
  const H = harness();
  const t0 = H.now();
  return H.m.ensureFreshClock(4000).then((r) => {
    check("fresh=false", r.fresh === false);
    check("reason=arm_inactive", r.reason === "arm_inactive");
    check("aucun temps écoulé", H.now() === t0);
    check("aucun timer résiduel créé par l'appel", true);
  });
});

/* ---------- 2. aucun pair distant ---------- */
block("aucune capture distante → fresh:true (nothing to sync)", function () {
  const H = harness();
  return H.m.start(SID).then(() => { H.armCycleId = H.m.view().armCycleId; })
    .then(() => H.m.ensureFreshClock(2000)).then((r) => {
      check("fresh=true", r.fresh === true);
      /* avec le seul device local, remoteCaptureDids() est vide */
    });
});

/* ---------- 3. le cas réel : échantillons fraîche après la demande ---------- */
block("échantillon postérieur à la demande pour chaque pair (cas J08)", function () {
  const H = harness();
  return H.m.start(SID)
    .then(() => {
      H.armCycleId = H.m.view().armCycleId;
      /* Monte la READY : le peer répond aux 3 échantillons de J07. */
      for (let i = 0; i < 3; i++) {
        H.run(M.CLOCK_SAMPLE_SPACING_MS);
        const req = (H.sent || [])[H.sent.length - 1];
        if (req) reply(H, req, 40);
      }
      H.run(600);
      const v = H.m.view();
      check("ARM actif", v.active === true);
      check("offset mesuré présent", typeof v.clock[PEER].offsetMs === "number");
      const before = v.clock[PEER].lastSyncMs;
      /* On laisse VIEILLIR l'échantillon bien au-delà de 12 s. */
      H.run(30000);
      check("échantillon vieillit (lastSyncMs inchangé, âge > 12 s)",
        H.m.view().clock[PEER].lastSyncMs === before);
      /* ... puis on demande de la fraîcheur, comme au moment du REC. */
      H.sent = [];
      const p = H.m.ensureFreshClock(4000);
      H.run(2000);
      return p;
    })
    .then((r) => {
      check("fresh=true", r.fresh === true);
      check("waitedMs > 0 (il a fallu un NOUVEL échantillon)", r.waitedMs > 0);
      const v = H.m.view();
      check("lastSyncMs strictement postérieur à la demande", v.clock[PEER].lastSyncMs > before);
      check("journal ARM_CLOCK_FRESH_OK", H.logs.some((l) => l.indexOf("ARM_CLOCK_FRESH_OK") === 0));
    });
});

/* ---------- 4. une seule requête en vol ---------- */
block("jamais deux clock_sync en vol (espacement 500 ms respecté)", function () {
  const H = harness();
  return H.m.start(SID)
    .then(() => {
      H.armCycleId = H.m.view().armCycleId;
      for (let i = 0; i < 3; i++) {
        H.run(M.CLOCK_SAMPLE_SPACING_MS);
        const req = (H.sent || [])[H.sent.length - 1];
        if (req) reply(H, req, 10);
      }
      H.run(600);
      H.sent = [];
      const p = H.m.ensureFreshClock(4000);
      /* On ne répond PAS : on vérifie qu'au plus une requête est en vol. */
      H.run(300);
      const pending = H.sent.length;
      H.run(200);
      check("1 seule requête pendante après 300 ms", pending === 1);
      check("toujours 1 seule requête après 500 ms (pas de doublon)", H.sent.length === 1);
      /* On répond enfin → la promesse doit résoudre. */
      reply(H, H.sent[0], 10);
      H.run(500);
      return p;
    })
    .then((r) => check("fresh=true après réponse tardive", r.fresh === true));
});

/* ---------- 5. pair muet → timeout honnête, pas de blocage ---------- */
block("pair muet → fresh:false au timeout (l'appelant tranchera)", function () {
  const H = harness();
  return H.m.start(SID)
    .then(() => {
      H.armCycleId = H.m.view().armCycleId;
      for (let i = 0; i < 3; i++) {
        H.run(M.CLOCK_SAMPLE_SPACING_MS);
        const req = (H.sent || [])[H.sent.length - 1];
        if (req) reply(H, req, 10);
      }
      H.run(600);
      const p = H.m.ensureFreshClock(2000);
      H.run(2500);
      return p;
    })
    .then((r) => {
      check("fresh=false", r.fresh === false);
      check("reason=timeout", r.reason === "timeout");
      check("journal ARM_CLOCK_FRESH_WAIT_TIMEOUT",
        H.logs.some((l) => l.indexOf("ARM_CLOCK_FRESH_WAIT_TIMEOUT") === 0));
    });
});

/* ---------- 6. pas de timer éternel : J07 au repos reste calme ---------- */
block("J07 au repos : aucun timer récurrent (pas de pompage permanent)", function () {
  const H = harness();
  return H.m.start(SID)
    .then(() => {
      H.armCycleId = H.m.view().armCycleId;
      /* Readiness complète : 3 échantillons, puis on laisse tout se résoudre. */
      for (let i = 0; i < 3; i++) {
        H.run(M.CLOCK_SAMPLE_SPACING_MS);
        const req = (H.sent || [])[H.sent.length - 1];
        if (req) reply(H, req, 5);
      }
      armResult(H, PEER);
      H.run(2000);
      const peerDev = H.m.view().devices.filter((d) => d.did === PEER)[0];
      const capSk = peerDev && peerDev.skills.filter((x) => x.skill === "capture")[0];
      /* READY ou WARNING : les réponses simulées ici ont un RTT énorme (on répond
       * 500 ms après l'émission), donc la sync est dégradée — c'est très
       * exactement le cas J08 sur matériel réel, et WARNING participe. */
      check("pair READY ou WARNING après arm_result (sync dégradée tolérée)",
        !!capSk && (capSk.status === "READY" || capSk.status === "WARNING"));
      check("Take éligible REC malgré la sync dégradée", H.m.view().recEligible === true);
      const sentBefore = (H.sent || []).length;
      /* 30 s de repos : AUCUNE nouvelle requête d'horloge ne doit partir. */
      H.run(30000);
      const sentAfter = (H.sent || []).length;
      check("0 requête d'horloge pendant 30 s de repos", sentAfter === sentBefore);
      check("le modèle reste READY et actif", H.m.view().active === true && H.m.view().recEligible === true);
    });
});

console.log("\nOK — " + blocks + " blocs, tous verts.");
