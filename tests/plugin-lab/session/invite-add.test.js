/* MultiCam §31.2 — « Ajouter un device depuis un Master » = INTÉGRATION RÉSEAU
 * EFFECTIVE du device distant.
 *
 * Ce test charge le TRANSPORT (app/www/js/net/session-ws.js) dans deux contextes
 * isolés (Master A + device B) reliés par un faux LAN (WebSockets appariés + faux
 * plugin cordova wsserver). Aucun Android requis.
 *
 * Cas couverts (décision 31.2) :
 *   1. ajout d'un device DÉCOUVERT mais non connecté → intégration effective :
 *      B connaît la session, son membership, le rôle Capture attribué par A ;
 *   2. la reply de B identifie la connexion → « Connecté » des deux côtés
 *      (connectedPeers) ;
 *   3. le PIN voyage sur le WS (comme join_req) mais JAMAIS dans le DNS-SD ;
 *   4. sécurité : un rôle non annoncé par B (storage) est rejeté (invite_nack),
 *      l'invitation ne force aucun rôle ;
 *   5. robustness : peer découvert SANS endpoint → aucun crash, invitation
 *      ignorée et tracée (INVITE_SKIP reason=no_endpoint) ;
 *   6. idempotence : ré-ajout d'un device déjà connecté = no-op, pas de doublon,
 *      pas de seconde connexion ;
 *   7. perte de la connexion → plus de peer « connecté » (liveness = WS) ;
 *   8. B réintégré conserve endpoint Master + endpoint propre (reconnexion).
 *
 * Usage :  node session/invite-add.test.js
 */

"use strict";

const path = require("path");
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "../../..");
const MODEL = require(path.join(ROOT, "app/www/js/state/session-model.js"));
const WS_SRC = fs.readFileSync(path.join(ROOT, "app/www/js/net/session-ws.js"), "utf8");

const MASTERS_DID = "aaaa1111-master";
const B_DID = "bbbb2222-capture";

/* ---------- faux LAN : WebSockets appariés + faux plugin wsserver ---------- */

function makeBus() {
  return { servers: {}, classes: {}, wire: [], dnsSd: [] };
}

let uuidSeq = 0;

function liveSockets(bus, ip) {
  if (!bus.live) bus.live = {};
  if (!bus.live[ip]) bus.live[ip] = [];
  return bus.live[ip];
}

/* Classe WebSocket client d'un device : `url` = endpoint DISTANT. À l'ouverture,
 * le serveur distant est pret à accepter (onOpen du handler serveur). */
function makeClientClass(bus, ip) {
  function Cli(url) {
    const m = /^ws:\/\/(.+)$/.exec(url);
    this.url = url;
    this.key = m ? m[1] : url;
    this.owner = ip;
    this.readyState = 0;
    this.binaryType = "";
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      liveSockets(bus, ip).push(this);
      if (this.onopen) this.onopen({});
      const srv = bus.servers[this.key];
      if (srv) srv.accept(this.owner);
    }, 0);
  }
  Cli.CONNECTING = 0;
  Cli.OPEN = 1;
  Cli.CLOSING = 2;
  Cli.CLOSED = 3;
  Cli.prototype.send = function (data) {
    bus.wire.push({ from: this.owner, to: this.key, data: String(data) });
    const srv = bus.servers[this.key];
    if (!srv) return;                       /* endpoint absent = non joignable */
    srv.deliverToClient(this.owner, data);
  };
  Cli.prototype.close = function () {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const l = liveSockets(bus, ip);
    const i = l.indexOf(this);
    if (i >= 0) l.splice(i, 1);
    if (this.onclose) this.onclose({ code: 1000, reason: "" });
  };
  bus.classes[ip] = Cli;
  return Cli;
}

/* Enregistrements serveur (une entrée par device ayant démarré ensureServer). */
function registerServer(bus, ip, port, handlers) {
  const srv = {
    key: ip + ":" + port,
    ip,
    port,
    handlers,
    sockets: [],
    accept(remoteAddr) {
      const s = {
        uuid: "u" + (++uuidSeq),
        remoteAddr,
        resource: "/",
        listenKey: this.key,
        readyState: 1,
        send(data) {
          bus.wire.push({ from: this.listenKey, to: remoteAddr, data: String(data) });
          srv.deliverToClientSide(remoteAddr, data);
        },
        close(code, reason) {
          if (this.readyState === 3) return;
          this.readyState = 3;
          srv.sockets = srv.sockets.filter((x) => x !== this);
          srv.handlers.onClose(this, code || 1000, reason || "", true);
        }
      };
      this.sockets.push(s);
      handlers.onOpen(s);
      return s;
    },
    deliverToClient(remoteAddr, data) {
      this.sockets.filter((s) => s.remoteAddr === remoteAddr)
        .forEach((s) => setTimeout(() => this.handlers.onMessage(s, data), 0));
    },
    /* Message emitted by the SERVER toward the client's socket (onmessage). */
    deliverToClientSide(remoteAddr, data) {
      liveSockets(bus, remoteAddr)
        .filter((c) => c.key === this.key && c.readyState === 1)
        .forEach((c) => setTimeout(() => c.onmessage({ data: String(data) }), 0));
    },
    drop(remoteAddr) {
      this.sockets.filter((s) => s.remoteAddr === remoteAddr).forEach((s) => s.close(1006, "link_lost"));
    }
  };
  bus.servers[srv.key] = srv;
  return srv;
}

function makeWsServerStub(bus, ip) {
  let port = -1;
  return {
    start(p, handlers, success) {
      setTimeout(() => {
        const srv = registerServer(bus, ip, p, handlers);
        port = p;
        success("ws://" + ip, p);
        void srv;
      }, 0);
    },
    /* Le plugin qualified reçoit l'ENTRY serveur (uuid) et route vers le socket. */
    send(entry, data) {
      const srv = bus.servers[ip + ":" + port];
      if (!srv || !entry) return false;
      const sock = srv.sockets.filter((s) => s.uuid === entry.uuid)[0];
      if (!sock) return false;
      sock.send(data);
      return true;
    },
    stop(ok) { if (ok) ok(); }
  };
}

/* ---------- device isolé (un contexte VM par device) ---------- */

function createDevice(bus, opts) {
  const logs = [];
  const files = new Map();
  const dnsSd = [];
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

  const sandbox = {
    console: { log: (line) => logs.push(String(line)) },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    WebSocket: makeClientClass(bus, opts.ip),
    cordova: { plugins: { wsserver: makeWsServerStub(bus, opts.ip) } },
    MultiCamSessionModel: MODEL,
    MultiCamSessionStore: {
      get: (sid) => Promise.resolve(clone(files.get(sid) || null)),
      save: (s) => { files.set(s.sessionId, clone(s)); return Promise.resolve(s); },
      list: () => Promise.resolve(Array.from(files.values()).map(clone)),
      remove: (sid) => { files.delete(sid); return Promise.resolve(); }
    },
    MultiCamConfig: { get: () => ({ deviceId: opts.did, deviceName: opts.name }) },
    MultiCamDiscovery: { status: () => ({ ipv4: opts.ip }) },
    MultiCamNsd: {
      advertiseSession: (o, ok) => { dnsSd.push(o); if (ok) ok(); },
      unadvertiseSession: (sid, ok) => { if (ok) ok(); }
    },
    MultiCamDevice: { appVersion: "1.0.0-test" }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(WS_SRC, sandbox, { filename: "session-ws.js" });

  const ws = sandbox.MultiCamSessionWs;
  ws.bind({ deviceId: opts.did, deviceName: opts.name });

  return {
    did: opts.did,
    name: opts.name,
    ip: opts.ip,
    port: 45102,
    ws,
    logs,
    dnsSd,
    files,
    session: (sid) => clone(files.get(sid) || null),
    logOf: (needle) => logs.filter((l) => l.indexOf(needle) >= 0),
    has: (needle) => logs.some((l) => l.indexOf(needle) >= 0)
  };
}

function flush(times) {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 12); i++) {
    p = p.then(() => new Promise((r) => setTimeout(r, 1)));
  }
  return p;
}

function newBus() {
  return makeBus();
}

async function makePair(opts) {
  const optsA = opts || {};
  const bus = newBus();
  const a = createDevice(bus, { did: MASTERS_DID, name: "Cam D1", ip: "192.168.92.57" });
  const b = createDevice(bus, { did: B_DID, name: "Cam 07", ip: "192.168.92.76" });
  await a.ws.ensureServer();
  await b.ws.ensureServer();
  return { bus, a, b };
}

/* ================= assertions ================= */

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    failures.push(name);
    console.log("  FAIL " + name + "\n       " + (e && e.message ? e.message : e));
  }
}

(async function main() {
  console.log("MultiCam §31.2 — intégration réseau d'un device ajouté depuis un Master\n");

  /* ---------- 1 + 2 : ajout découvert → intégration effective ---------- */
  await check("1. addMember d'un device découvert l'intègre (session + rôle) sans action sur B", async () => {
    const { a, b } = await makePair();

    const s = await a.ws.createSession("Tournage 1", {});
    const sid = s.sessionId;
    assert.ok(sid, "session créée");

    const peer = { deviceId: B_DID, deviceName: "Cam 07", enabledSkills: ["capture"], endpoint: b.ip + ":45102" };
    await a.ws.addMember(s, peer, ["capture"]);
    await flush(20);

    const lb = b.session(sid);
    assert.ok(lb, "B connaît la session créée par A (invitation reçue sans action locale)");
    assert.strictEqual(lb.state, "open");
    assert.strictEqual(lb.name, "Tournage 1");

    const mb = lb.members.find((m) => m.deviceId === B_DID);
    assert.ok(mb, "B est membre de la session");
    assert.deepStrictEqual(mb.sessionRoles, ["capture"], "B connaît le rôle Capture attribué par A");
    assert.deepStrictEqual(mb.enabledSkills, ["capture"]);

    /* §31.2 : B ne doit surtout pas hériter du rôle Master par le canal réseau. */
    assert.ok(!lb.masters.find((m) => m.deviceId === B_DID),
      "B n'est pas inscrit comme Master (rôle Master non escamoté par l'invitation)");
  });

  await check("2. la reply de B identifie la connexion des deux côtés (Connecté)", async () => {
    const { a, b } = await makePair();
    const s = await a.ws.createSession("Tournage 2", {});
    const sid = s.sessionId;
    await a.ws.addMember(s, { deviceId: B_DID, deviceName: "Cam 07", enabledSkills: ["capture"], endpoint: b.ip + ":45102" }, ["capture"]);
    await flush(20);

    const peersA = a.ws.connectedPeers(sid);
    const peersB = b.ws.connectedPeers(sid);
    assert.ok(peersA[B_DID], "A voit B connecté (connectedPeers)");
    assert.ok(peersB[MASTERS_DID], "B voit le Master connecté (connectedPeers)");
    assert.ok(a.has("INVITE_OK") || a.has("INVITE_SENT"), "traces parsables INVITE_* côté A");
    assert.ok(b.has("INVITE_ACCEPTED"), "trace parsable INVITE_ACCEPTED côté B");
  });

  /* ---------- 3 : PIN sur le WS, jamais dans le DNS-SD ---------- */
  await check("3. PIN transmis sur le WS mais jamais publié en DNS-SD", async () => {
    const { a, b } = await makePair();
    const s = await a.ws.createSession("Tournage 3", {});
    const sid = s.sessionId;
    const pin = s.pin;
    assert.ok(/^\d{4}$/.test(pin), "PIN à 4 chiffres côté A");

    await a.ws.addMember(s, { deviceId: B_DID, deviceName: "Cam 07", enabledSkills: ["capture"], endpoint: b.ip + ":45102" }, ["capture"]);
    await flush(20);

    const lb = b.session(sid);
    assert.ok(lb, "session intégrée côté B");
    assert.strictEqual(lb.pin, pin, "B connaît le PIN de la session (il en devient Master de transport)");

    /* aucun payload DNS-SD ne doit contenir le PIN */
    const dnsText = JSON.stringify(a.dnsSd.concat(b.dnsSd));
    assert.ok(dnsText.indexOf(pin) < 0, "PIN absent des publications DNS-SD");
    /* et le sharedView transporté ne doit pas contenir le PIN */
    const lbView = JSON.stringify(MODEL.sharedView(a.session(sid)));
    assert.ok(lbView.indexOf(pin) < 0, "PIN absent du sharedView");
  });

  /* ---------- 4 : sécurité — pas de rôle forcé ---------- */
  await check("4. un rôle non annoncé par B (storage) est rejeté : rien n'est forcé", async () => {
    const { a, b } = await makePair();
    const s = await a.ws.createSession("Tournage 4", {});
    const sid = s.sessionId;

    /* B n'annonce que capture : l'ajout storage est refusé par le modèle, et le
     * device distant ne doit surtout pas se voir attribuer un rôle forcé. */
    let rejected = null;
    try {
      await a.ws.addMember(s, { deviceId: B_DID, deviceName: "Cam 07", enabledSkills: ["capture"], endpoint: b.ip + ":45102" }, ["storage"]);
    } catch (e) {
      rejected = e;
    }
    await flush(20);

    assert.ok(rejected, "addMember refusé (rôle storage non annoncé par B)");
    assert.ok(a.has("MEMBER_ADD_REJECT"), "MEMBER_ADD_REJECT tracé");
    const lb = b.session(sid);
    assert.ok(!lb || !lb.members.find((m) => m.deviceId === B_DID), "B n'intègre aucun rôle non annoncé");
  });

  /* ---------- 5 : robustesse — peer sans endpoint ---------- */
  await check("5. peer découvert SANS endpoint → aucun crash, invitation tracée", async () => {
    const { a, b } = await makePair();
    const s = await a.ws.createSession("Tournage 5", {});
    const sid = s.sessionId;
    await a.ws.addMember(s, { deviceId: B_DID, deviceName: "Cam 07", enabledSkills: ["capture"] }, ["capture"]);
    await flush(10);
    assert.ok(a.has("INVITE_SKIP"), "INVITE_SKIP reason=no_endpoint tracé");
    const lb = b.session(sid);
    assert.ok(!lb, "B n'intègre rien sans endpoint (pas de session locale créée)");
    const la = a.session(sid);
    assert.ok(la.members.some((m) => m.deviceId === B_DID), "l'ajout membre local reste valide (membership conservée)");
  });

  /* ---------- 6 : idempotence ---------- */
  await check("6. ré-ajout d'un device déjà connecté = no-op, pas de doublon", async () => {
    const { a, b } = await makePair();
    const s = await a.ws.createSession("Tournage 6", {});
    const sid = s.sessionId;
    const peer = { deviceId: B_DID, deviceName: "Cam 07", enabledSkills: ["capture"], endpoint: b.ip + ":45102" };
    await a.ws.addMember(s, peer, ["capture"]);
    await flush(20);

    await a.ws.addMember(a.session(sid), peer, ["capture"]);
    await flush(15);

    const la = a.session(sid);
    assert.strictEqual(la.members.filter((m) => m.deviceId === B_DID).length, 1, "un seul membre B");
    assert.ok(a.ws.connectedPeers(sid)[B_DID], "toujours connecté");
    assert.ok(a.has("INVITE_SKIP") || a.has("MEMBER_ADD_NOOP") || a.has("INVITE_SENT"),
      "ré-ajout tracé (no-op ou ré-invitation idempotente)");
  });

  /* ---------- 7 : perte de connexion ---------- */
  await check("7. perte de la connexion WS → plus de peer connecté (liveness)", async () => {
    const { bus, a, b } = await makePair();
    const s = await a.ws.createSession("Tournage 7", {});
    const sid = s.sessionId;
    await a.ws.addMember(s, { deviceId: B_DID, deviceName: "Cam 07", enabledSkills: ["capture"], endpoint: b.ip + ":45102" }, ["capture"]);
    await flush(20);
    assert.ok(a.ws.connectedPeers(sid)[B_DID], "connecté avant coupure");

    /* coupure du lien côté B : le socket serveur de B disparaît, la socket
     * cliente de A se ferme → « Connecté » doit disparaître. */
    bus.servers[b.ip + ":45102"].drop(bus.servers[b.ip + ":45102"].sockets[0].remoteAddr);
    /* et on ferme la socket cliente de A pour simuler la perte physique */
    const liveA = liveSockets(bus, a.ip).filter((c) => c.key === b.ip + ":45102");
    liveA.forEach((c) => c.close());
    await flush(15);

    assert.ok(!a.ws.connectedPeers(sid)[B_DID], "A ne voit plus B connecté");
    assert.ok(!b.ws.connectedPeers(sid)[MASTERS_DID], "B ne voit plus le Master connecté");
  });

  /* ---------- 8 : reconnexion — endpoint du Master conservé ---------- */
  await check("8. B intégré connaît l'endpoint du Master (re-dial au boot possible)", async () => {
    const { a, b } = await makePair();
    const s = await a.ws.createSession("Tournage 8", {});
    const sid = s.sessionId;
    await a.ws.addMember(s, { deviceId: B_DID, deviceName: "Cam 07", enabledSkills: ["capture"], endpoint: b.ip + ":45102" }, ["capture"]);
    await flush(20);

    const lb = b.session(sid);
    const masterA = lb.masters.find((m) => m.deviceId === MASTERS_DID);
    assert.ok(masterA, "B connaît son Master");
    assert.strictEqual(masterA.endpoint, a.ip + ":45102", "B connaît l'endpoint du Master (reconnexion)");
  });

  /* ---------- 9 : device sans session locale ---------- */
  await check("9. un device SANS session locale intègre la session du Master", async () => {
    const { bus, a } = await makePair();
    const s = await a.ws.createSession("Tournage 9", {});
    const sid = s.sessionId;
    /* B neuf : aucune session en store, mais serveur WS actif (donc intégrable). */
    const b = createDevice(bus, { did: B_DID, name: "Cam 07", ip: "192.168.92.76" });
    await b.ws.ensureServer();
    await flush(4);
    assert.ok(b.ws.status().serverRunning, "B écoute même sans session (serverRunning)");
    assert.strictEqual(b.files.size, 0, "aucune session en store");

    await a.ws.addMember(s, { deviceId: B_DID, deviceName: "Cam 07", enabledSkills: ["capture"], endpoint: b.ip + ":45102" }, ["capture"]);
    await flush(20);
    const lb = b.session(sid);
    assert.ok(lb, "B sans session préalable intègre la session du Master");
    assert.deepStrictEqual(lb.members.find((m) => m.deviceId === B_DID).sessionRoles, ["capture"]);
  });

  /* ---------- 10 : device injoignable ---------- */
  await check("10. device injoignable : addMember résout quand même (l'UI ne bloque pas)", async () => {
    const { a } = await makePair();
    const s = await a.ws.createSession("Tournage 10", {});
    const sid = s.sessionId;
    /* port sans serveur : le dial reste suspendu (connectTo ne rejette jamais) */
    const t0 = Date.now();
    const saved = await a.ws.addMember(s, {
      deviceId: B_DID, deviceName: "Cam 07", enabledSkills: ["capture"], endpoint: "192.168.92.76:45999"
    }, ["capture"]);
    const dt = Date.now() - t0;
    assert.ok(dt < 1000, "addMember n'attend pas l'invitation (" + dt + "ms)");
    assert.ok(saved.members.some((m) => m.deviceId === B_DID), "le membre est bien enregistré");
    assert.ok(a.session(sid).members.some((m) => m.deviceId === B_DID), "membership persistée");
    assert.ok(!a.has("INVITE_OK"), "aucun faux « connecté » pour un device injoignable");
    assert.ok(!a.ws.connectedPeers(sid)[B_DID], "pas de peer connecté sans invitation aboutie");
  });

  /* ---------- bilan ---------- */
  console.log("\n" + passed + " passed, " + failures.length + " failed");
  if (failures.length) {
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  process.exit(0);          /* le heartbeat du transport garderait sinon la boucle vivante */
})().catch(function (err) {
  console.error("\n" + ((err && err.stack) || err));
  process.exit(1);
});
