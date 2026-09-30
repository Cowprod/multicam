/* MultiCam — J09-04 : transport des previews JPEG (Capture → Masters).
 *
 * MODELE REEL (inspection de `net/session-ws.js`) :
 *   - une connexion WS physique = UN PEER GLOBAL, pas une session ;
 *   - l'appartenance aux sessions est un ENSEMBLE (`entry.sessions`, J09-01) ;
 *   - l'enveloppe porte `sessionId` par message (multiplexage protocolaire) ;
 *   - `sendServer()` / `sendOn()` renvoient `false` si le socket n'est pas OPEN
 *     ou si `send()` leve : c'est le seul signal de backpressure disponible.
 *
 * OBJECTIF : pendant le REC, chaque JPEG produit par une Capture participante
 * part vers les MASTERS CONNECTES DE CETTE SESSION, et rien d'autre.
 *
 * QUATRE COUCHES, quatre responsabilites :
 *   state/preview-sampler.js   (J09-03, intact) produit la frame ;
 *   state/preview-transport.js construit l'enveloppe, applique la backpressure
 *                              "latest frame wins" et decide DROP ; ne connait
 *                              NI la mosaique NI la camera ;
 *   net/session-ws.js          TRANSPORT PUR : serialise, route, filtre les
 *                              destinataires, ZERO logique de mosaique ;
 *   state/preview-inbox.js     recoit et ne garde qu'UNE frame par Capture.
 *
 * COUVERTURE :
 *   T1. Capture -> 1 Master de S1                 : recu
 *   T2. 2 Masters de S1                           : tous les deux recouvent
 *   T3. peer Capture / Storage-only de S1        : ne recoit RIEN
 *   T4. Master d'une AUTRE session S2            : ne recoit RIEN
 *   T5. source Master+Capture (self)             : pas de boucle reseau
 *   T6. WS ferme                                  : DROP propre, pas d'exception
 *   T7. deux frames rapides                       : backlog borne (1 slot)
 *   T8. message recu                              : metadata + base64 intacts
 *   T9. frame invalide / mauvaise session         : rejet propre et compte
 *   T10. panne transport                          : le REC n'est jamais ralenti
 *   T11. session inconnue / fermee                : DROP, rien n'est emis
 *   T12. session-ws reste pur                     : aucune mosaique, aucun buffer
 */

"use strict";

function register(h) {
  const { describe, it, createEnv, load, loadAll } = h;

  const DID_CAP = "cccccccc-0000-0000-0000-00000000000c";   /* Capture locale */
  const DID_M1 = "mmmmmmmm-0000-0000-0000-000000000001";   /* Master S1 */
  const DID_M2 = "mmmmmmmm-0000-0000-0000-000000000002";   /* 2e Master S1 */
  const DID_CAP2 = "ccccccc2-0000-0000-0000-00000000002";  /* autre Capture S1 */
  const DID_STO = "ssssssss-0000-0000-0000-000000000003";  /* Storage-only S1 */
  const DID_MS2 = "mmmmmmmm-0000-0000-0000-0000000000b2";  /* Master de S2 seul */

  /* ---------- faux JPEG : entete SOF0 suffisant pour la taille ---------- */

  function fakeJpegBase64(width, height, totalBytes) {
    const n = Math.max(totalBytes || 256, 32);
    const b = new Uint8Array(n);
    let i = 0;
    b[i++] = 0xff; b[i++] = 0xd8;                        /* SOI */
    b[i++] = 0xff; b[i++] = 0xe0;                        /* APP0 */
    b[i++] = 0x00; b[i++] = 0x10;
    for (let k = 0; k < 14; k++) b[i++] = k;
    b[i++] = 0xff; b[i++] = 0xc0;                        /* SOF0 */
    b[i++] = 0x00; b[i++] = 0x11;                        /* longueur */
    b[i++] = 0x08;                                        /* precision */
    b[i++] = (height >> 8) & 0xff; b[i++] = height & 0xff;
    b[i++] = (width >> 8) & 0xff; b[i++] = width & 0xff;
    b[i++] = 0x03;                                        /* 3 composantes */
    for (let k = 0; k < 9; k++) b[i++] = k;
    for (; i < n - 2; i++) b[i++] = 0x55;
    b[n - 2] = 0xff; b[n - 1] = 0xd9;                    /* EOI */
    let bin = "";
    for (let k = 0; k < n; k++) bin += String.fromCharCode(b[k]);
    return btoa(bin);
  }

  function b64Bytes(b64) {
    /* Taille DECODEE, indispensable pour la mesure de debit. */
    return Math.floor(b64.length * 3 / 4) - (b64.slice(-2) === "==" ? 2 : b64.slice(-1) === "=" ? 1 : 0);
  }

  /* ---------- faux plugin serveur wsserver + WebSocket client ---------- */

  function makeWsServer() {
    const hooks = {};
    const sent = [];
    const srv = {
      hooks,
      sent,
      start(port, o, ok) {
        hooks.onOpen = o.onOpen;
        hooks.onMessage = o.onMessage;
        hooks.onClose = o.onClose;
        setTimeout(() => ok("0.0.0.0", port), 0);
      },
      send(entry, payload) {
        sent.push({ uuid: entry && entry.uuid, payload: JSON.parse(payload) });
        return true;
      }
    };
    return srv;
  }

  function makeWsClient(env) {
    function WS(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      env.wsSockets.push(this);
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        if (this.onopen) this.onopen();
      }, 5);
    }
    WS.OPEN = 1; WS.CONNECTING = 0; WS.CLOSING = 2; WS.CLOSED = 3;
    WS.prototype.send = function (p) {
      if (this.readyState !== WS.OPEN) throw new Error("socket ferme");
      this.sent.push(JSON.parse(p));
    };
    WS.prototype.close = function () {
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1000, reason: "" });
    };
    return WS;
  }

  /* ---------- sessions de test ---------- */

  function session(sid, masters, members, extra) {
    return Object.assign({
      sessionId: sid, state: "open", name: sid,
      masters: masters.map((d) => ({ deviceId: d })),
      members: members.map((d) => ({ deviceId: d, sessionRoles: [] })),
      takes: []
    }, extra || {});
  }

  function localConfig(deviceId) {
    return {
      _cfg: {
        deviceId, deviceName: "Cap",
        enabledSkills: ["capture", "storage", "controller"],
        supportedSkills: ["capture", "storage", "controller"],
        permissions: {}
      },
      load() { return Promise.resolve(this._cfg); },
      get() { return this._cfg; },
      setSkill() { return Promise.resolve(this._cfg); }
    };
  }

  /* ---------- micro-assertions ---------- */

  let lastEnv = null;
  function eq(actual, want, msg) {
    if (actual !== want) {
      throw new Error((msg ? msg + " — " : "") + "attendu " + JSON.stringify(want)
        + ", obtenu " + JSON.stringify(actual)
        + "\n--- logs ---\n" + (lastEnv ? lastEnv.logText().slice(-2000) : ""));
    }
  }
  function ok(cond, msg) { eq(!!cond, true, msg); }
  function no(cond, msg) { eq(!!cond, false, msg); }

  function tick() { return new Promise((r) => setTimeout(r, 0)); }
  function tickN(n) {
    let p = Promise.resolve();
    for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
    return p;
  }

  /* Charge le transport + l'inbox et branche l'inbox comme pont WS. */
  function loadJ09(env, gate) {
    loadAll(env, ["state/preview-inbox.js", "state/preview-transport.js"]);
    env.inbox = env.MultiCamPreviewInbox;
    env.transport = env.MultiCamPreviewTransport;
    if (env.ws) {
      env.ws.setPreviewBridge({ onPreviewFrame: function (e) { return env.inbox.accept(e); } });
    }
    if (gate) env.inbox.bind(gate.cfg || { deviceId: DID_M1 }, gate.isMasterOf);
    return env;
  }

  /* Une frame prete a partir (exactement ce que le sampler produit). */
  function frameOf(over) {
    const o = over || {};
    const b64 = o.jpegBase64 || fakeJpegBase64(1339, 752, 19836);
    return {
      sessionId: o.sessionId || "S1",
      takeNumber: (o.takeNumber === undefined ? 4 : o.takeNumber),
      startPlanId: o.startPlanId || "PLAN#1#1#1",
      seq: (o.seq === undefined ? 7 : o.seq),
      capturedAt: (o.capturedAt === undefined ? 1700000000123 : o.capturedAt),
      mime: "image/jpeg",
      bytes: b64Bytes(b64), jpegBase64: b64
    };
  }

  function framesSent(srv) {
    return srv.sent.filter((s) => s.payload && s.payload.kind === "preview_frame");
  }

  function conn(uuid) { return { uuid, remoteAddr: "10.0.0.9", resource: "/multicam" }; }

  /* Fait APPARAITRE le peer dans la session par le VRAI chemin d'entree
   * (onOpen puis onMessage), comme le ferait un `sync_please` distant. */
  function peerIn(env, srv, uuid, from, sid) {
    const seen = env.__opened || (env.__opened = {});
    if (!seen[uuid]) { seen[uuid] = true; srv.hooks.onOpen(conn(uuid)); }
    srv.hooks.onMessage(conn(uuid),
      JSON.stringify({ v: 1, kind: "sync_please", from, ts: 1700000000000, sessionId: sid }));
  }

  function deliver(srv, uuid, payload) {
    srv.hooks.onMessage(conn(uuid), JSON.stringify(Object.assign({ v: 1, ts: 1700000000000 }, payload)));
  }

  /* ---------- fabriques d'environnement ---------- */

  /* Emission : le device local est une CAPTURE ; ses peers Masters se
   * connectent A LUI (topologie serveur), comme sur le terrain.
   * `sessions` est optionnel : chaque test installe SON store juste apres. */
  function envCapture(sessions, opts) {
    const env = createEnv({ config: localConfig(DID_CAP) });
    const srv = makeWsServer();
    env.cordova = { plugins: { wsserver: srv } };
    env.srv = srv;
    env.MultiCamSessionModel = {
      sharedView(s) { return { sessionId: s.sessionId, state: s.state }; }
    };
    const store = {};
    Object.keys(sessions || {}).forEach((k) => { store[k] = sessions[k]; });
    env.MultiCamSessionStore = {
      get(sid) { return Promise.resolve(store[sid] || null); },
      list() { return Promise.resolve(Object.keys(store).map((k) => store[k])); },
      save(s) { store[s.sessionId] = s; return Promise.resolve(s); }
    };
    env.MultiCamNative = { ipv4: () => Promise.resolve("10.0.0.1") };
    env.wsSockets = [];
    env.WebSocket = makeWsClient(env);
    load(env, "net/session-ws.js");
    env.ws = env.MultiCamSessionWs;
    void opts;
    return env;
  }

  /* Reception : le device local est un MASTER de S1 et recoit par le serveur. */
  function envMaster(sessions) {
    const env = createEnv({ config: localConfig(DID_M1) });
    const srv = makeWsServer();
    env.cordova = { plugins: { wsserver: srv } };
    env.srv = srv;
    env.MultiCamSessionModel = {
      sharedView(s) { return { sessionId: s.sessionId, state: s.state }; }
    };
    const store = {};
    Object.keys(sessions || {}).forEach((k) => { store[k] = sessions[k]; });
    env.MultiCamSessionStore = {
      get(sid) { return Promise.resolve(store[sid] || null); },
      list() { return Promise.resolve(Object.keys(store).map((k) => store[k])); },
      save(s) { store[s.sessionId] = s; return Promise.resolve(s); }
    };
    env.MultiCamNative = { ipv4: () => Promise.resolve("10.0.0.1") };
    env.wsSockets = [];
    env.WebSocket = makeWsClient(env);
    load(env, "net/session-ws.js");
    env.ws = env.MultiCamSessionWs;
    return env;
  }

  /* Chaque test emission demarre un vrai serveur (heartbeat) : fermeture
   * explicite obligatoire, sinon node ne sort jamais. */
  function itServer(makeEnv, name, fn) {
    it(name, async () => {
      const env = makeEnv();
      lastEnv = env;
      try {
        await env.ws.ensureServer();
        await fn(env);
      } finally {
        try { env.ws.stopServer(); } catch (e) {}
      }
    });
  }

  describe("J09-04 · transport des previews JPEG (Capture → Masters)", () => {

    /* ---------- T1 ---------- */
    itServer(envCapture, "T1. une Capture envoie preview_frame, le Master de S1 le recoit",
      async (env) => {
        env.sessions = { S1: session("S1", [DID_M1], [DID_CAP]) };
        env.MultiCamSessionStore = {
          get(sid) { return Promise.resolve(env.sessions[sid] || null); },
          list() { return Promise.resolve([env.sessions.S1]); },
          save(s) { env.sessions[s.sessionId] = s; return Promise.resolve(s); }
        };
        loadJ09(env);
        peerIn(env, env.srv, "u1", DID_M1, "S1");

        env.transport.submit(frameOf(), "test");
        await tickN(4);

        const sent = framesSent(env.srv);
        eq(sent.length, 1, "exactement 1 preview_frame emis");
        const e = sent[0].payload;
        eq(e.kind, "preview_frame", "kind du protocole");
        eq(e.v, 1, "version de protocole");
        eq(e.sessionId, "S1", "sessionId");
        eq(e.from, DID_CAP, "from = deviceId source");
        eq(e.deviceId, DID_CAP, "deviceId source explicite");
        eq(e.takeNumber, 4, "takeNumber");
        eq(e.startPlanId, "PLAN#1#1#1", "startPlanId");
        eq(e.seq, 7, "seq");
        eq(e.capturedAt, 1700000000123, "capturedAt");
        eq(e.mime, "image/jpeg", "mime");
        eq(e.width, 1339, "width lue LOCALEMENT (pas de decodage reseau)");
        eq(e.height, 752, "height lu localement");
        eq(e.bytes, 19836, "taille JPEG.decodee");
        eq(e.jpegBase64, frameOf().jpegBase64, "base64 intacte");
        ok(e.ts > 0, "ts d'emission");
        eq(env.transport.stats().sent, 1, "compteur sent");
        eq(env.transport.stats().recipients, 1, "1 destinataire");
      });

    /* ---------- T2 ---------- */
    itServer(envCapture, "T2. deux Masters de S1 recoivent tous les deux",
      async (env) => {
        env.sessions = { S1: session("S1", [DID_M1, DID_M2], [DID_CAP]) };
        env.MultiCamSessionStore = {
          get(sid) { return Promise.resolve(env.sessions[sid] || null); },
          list() { return Promise.resolve([env.sessions.S1]); },
          save(s) { env.sessions[s.sessionId] = s; return Promise.resolve(s); }
        };
        loadJ09(env);
        peerIn(env, env.srv, "u1", DID_M1, "S1");
        peerIn(env, env.srv, "u2", DID_M2, "S1");

        env.transport.submit(frameOf(), "test");
        await tickN(4);

        const sent = framesSent(env.srv);
        eq(sent.length, 2, "2 envois, un par Master");
        const uuids = sent.map((s) => s.uuid).sort();
        eq(uuids.join(","), "u1,u2", "les deux connexions Masters sont servies");
        eq(env.transport.stats().sent, 1, "une seule frame source");
        eq(env.transport.stats().recipients, 2, "2 destinataires");
      });

    /* ---------- T3 ---------- */
    itServer(envCapture, "T3. un peer Capture ou Storage-only de S1 ne recoit RIEN",
      async (env) => {
        env.sessions = { S1: session("S1", [DID_M1], [DID_CAP, DID_CAP2, DID_STO]) };
        env.MultiCamSessionStore = {
          get(sid) { return Promise.resolve(env.sessions[sid] || null); },
          list() { return Promise.resolve([env.sessions.S1]); },
          save(s) { env.sessions[s.sessionId] = s; return Promise.resolve(s); }
        };
        loadJ09(env);
        peerIn(env, env.srv, "u1", DID_M1, "S1");
        peerIn(env, env.srv, "u2", DID_CAP2, "S1");
        peerIn(env, env.srv, "u3", DID_STO, "S1");

        env.transport.submit(frameOf(), "test");
        await tickN(4);

        const sent = framesSent(env.srv);
        eq(sent.length, 1, "seul le Master est destinataire");
        eq(sent[0].uuid, "u1", "et c'est bien le Master de S1");
        eq(env.transport.stats().nonMastersSkipped, 2, "les 2 non-Masters sont ecartes et comptes");
      });

    /* ---------- T4 ---------- */
    itServer(envCapture, "T4. un Master de S2 ne recoit rien pour une frame de S1",
      async (env) => {
        env.sessions = {
          S1: session("S1", [DID_M1], [DID_CAP]),
          S2: session("S2", [DID_MS2], [DID_CAP])
        };
        env.MultiCamSessionStore = {
          get(sid) { return Promise.resolve(env.sessions[sid] || null); },
          list() { return Promise.resolve([env.sessions.S1, env.sessions.S2]); },
          save(s) { env.sessions[s.sessionId] = s; return Promise.resolve(s); }
        };
        loadJ09(env);
        peerIn(env, env.srv, "u1", DID_M1, "S1");
        peerIn(env, env.srv, "u2", DID_MS2, "S2");

        env.transport.submit(frameOf(), "test");
        await tickN(4);

        const sent = framesSent(env.srv);
        eq(sent.length, 1, "seul le Master de S1 est destinataire");
        eq(sent[0].uuid, "u1", "le Master de S2 est ecarte");
        eq(env.transport.stats().otherSessionSkipped, 1, "le Master d'une autre session est compte");
      });

    /* ---------- T5 ---------- */
    itServer(envCapture, "T5. source Master+Capture : aucune boucle reseau vers self",
      async (env) => {
        /* Le device local est Master ET Capture de S1 : son propre JPEG ne doit
         * pas lui revenir par le reseau (l'UI lira plus tard sa preview locale). */
        env.sessions = { S1: session("S1", [DID_CAP, DID_M1], [DID_CAP]) };
        env.MultiCamSessionStore = {
          get(sid) { return Promise.resolve(env.sessions[sid] || null); },
          list() { return Promise.resolve([env.sessions.S1]); },
          save(s) { env.sessions[s.sessionId] = s; return Promise.resolve(s); }
        };
        loadJ09(env);
        peerIn(env, env.srv, "u0", DID_CAP, "S1");   /* connexion reflexive simulee */
        peerIn(env, env.srv, "u1", DID_M1, "S1");

        env.transport.submit(frameOf(), "test");
        await tickN(4);

        const sent = framesSent(env.srv);
        eq(sent.length, 1, "une seule connexion servie");
        no(sent.some((s) => s.uuid === "u0"), "self : jamais de boucle reseau");
        ok(sent.some((s) => s.uuid === "u1"), "l'autre Master, lui, recoit");
        eq(env.transport.stats().selfSkipped, 1, "self-loop compte et ecarte");
      });

    /* ---------- T6 ---------- */
    itServer(envCapture, "T6. WS ferme : la frame est DROPpee, aucune exception",
      async (env) => {
        env.sessions = { S1: session("S1", [DID_M1], [DID_CAP]) };
        env.MultiCamSessionStore = {
          get(sid) { return Promise.resolve(env.sessions[sid] || null); },
          list() { return Promise.resolve([env.sessions.S1]); },
          save(s) { env.sessions[s.sessionId] = s; return Promise.resolve(s); }
        };
        loadJ09(env);
        peerIn(env, env.srv, "u1", DID_M1, "S1");
        env.srv.hooks.onClose(conn("u1"));            /* le Master coupe */

        let threw = null;
        try { env.transport.submit(frameOf(), "test"); } catch (e) { threw = e; }
        no(threw, "aucune exception ne doit remonter dans le chemin du REC");
        await tickN(4);

        const st = env.transport.stats();
        eq(st.sent, 0, "rien n'est parti");
        eq(st.dropped, 1, "la frame est comptee comme droppee");
        ok(/no_master_connected|not_open/.test(st.lastDropReason),
          "motif de DROP explicite (" + st.lastDropReason + ")");
      });

    /* ---------- T7 ---------- */
    itServer(envCapture, "T7. deux frames rapides : aucune accumulation (1 slot, latest wins)",
      async (env) => {
        env.sessions = { S1: session("S1", [DID_M1], [DID_CAP]) };
        env.MultiCamSessionStore = {
          get(sid) { return Promise.resolve(env.sessions[sid] || null); },
          list() { return Promise.resolve([env.sessions.S1]); },
          save(s) { env.sessions[s.sessionId] = s; return Promise.resolve(s); }
        };
        loadJ09(env);
        peerIn(env, env.srv, "u1", DID_M1, "S1");

        /* Le transport est deliberement rendu « occupe » : une premiere frame
         * reste en vol, les suivantes doivent etre bornees a UN slot. */
        env.transport.__test_hold(true);
        const seqs = [1, 2, 3, 4, 5];
        for (const s of seqs) env.transport.submit(frameOf({ seq: s }), "test");
        await tickN(2);

        const st = env.transport.stats();
        eq(st.pendingDepth, 1, "la file ne peut PAS depasser 1 slot");
        eq(st.dropped, seqs.length - 1, "les frames perimees sont DROPpees");
        eq(st.droppedBy.superseded, seqs.length - 1, "motif superseded (latest frame wins)");
        ok(st.busy, "le transport est bien occupe");

        /* On relache : la DERNIERE frame est celle qui part. */
        env.transport.__test_hold(false);
        env.transport.flush();
        await tickN(4);

        const sent = framesSent(env.srv);
        eq(env.transport.stats().pendingDepth, 0, "plus rien en attente");
        eq(sent.length, 1, "une seule frame finalement envoyee");
        eq(sent[0].payload.seq, 5, "c'est la frame la plus RECENTE (latest frame wins)");
      });

    /* ---------- T8 ---------- */
    itServer(envMaster, "T8. message recu → l'inbox Master garde metadata + base64 intacts",
      async (env) => {
        env.sessions = { S1: session("S1", [DID_M1], [DID_CAP]) };
        env.MultiCamSessionStore = {
          get(sid) { return Promise.resolve(env.sessions[sid] || null); },
          list() { return Promise.resolve([env.sessions.S1]); },
          save(s) { env.sessions[s.sessionId] = s; return Promise.resolve(s); }
        };
        loadJ09(env, { cfg: { deviceId: DID_M1 }, isMasterOf: (sid) => sid === "S1" });

        const seen = [];
        env.inbox.onFrame(function (f) { seen.push(f); });

        const b64 = fakeJpegBase64(640, 480, 4096);
        peerIn(env, env.srv, "u1", DID_CAP, "S1");
        deliver(env.srv, "u1", {
          kind: "preview_frame", from: DID_CAP, sessionId: "S1", deviceId: DID_CAP,
          takeNumber: 4, startPlanId: "PLAN#1#1#1", seq: 9, capturedAt: 1700000000123,
          mime: "image/jpeg", width: 640, height: 480, bytes: 4096, jpegBase64: b64
        });
        await tickN(3);

        eq(seen.length, 1, "le callback J09 a ete appele une fois");
        const f = seen[0];
        eq(f.sessionId, "S1", "sessionId");
        eq(f.deviceId, DID_CAP, "deviceId source");
        eq(f.takeNumber, 4, "takeNumber");
        eq(f.startPlanId, "PLAN#1#1#1", "startPlanId");
        eq(f.seq, 9, "seq");
        eq(f.capturedAt, 1700000000123, "capturedAt");
        eq(f.receivedAt > 0, true, "receivedAt renseigne");
        eq(f.mime, "image/jpeg", "mime");
        eq(f.width, 640, "width");
        eq(f.height, 480, "height");
        eq(f.bytes, 4096, "taille");
        eq(f.jpegBase64, b64, "base64 STRICTEMENT intacte (aucune troncature)");
        ok(/PREVIEW_FRAME_RECEIVED/.test(env.logText()), "PREVIEW_FRAME_RECEIVED journalise");
        eq(env.inbox.latest("S1", DID_CAP).seq, 9, "latest() renvoie la frame stockee");

        /* Une seule frame conservee par Capture : le seq suivant ecrase. */
        deliver(env.srv, "u1", {
          kind: "preview_frame", from: DID_CAP, sessionId: "S1", deviceId: DID_CAP,
          takeNumber: 4, seq: 10, capturedAt: 1700000001123, mime: "image/jpeg",
          width: 640, height: 480, bytes: 4096, jpegBase64: b64
        });
        await tickN(3);
        eq(env.inbox.latest("S1", DID_CAP).seq, 10, "la DERNIERE frame ecrase (pas d'historique)");
        eq(env.inbox.stats().received, 2, "2 frames recues");
        eq(env.inbox.deviceCount("S1"), 1, "une seule Capture suivie");
      });

    /* ---------- T9 ---------- */
    itServer(envMaster, "T9. frame invalide ou de mauvaise session : rejet propre et compte",
      async (env) => {
        env.sessions = { S1: session("S1", [DID_M1], [DID_CAP]) };
        env.MultiCamSessionStore = {
          get(sid) { return Promise.resolve(env.sessions[sid] || null); },
          list() { return Promise.resolve([env.sessions.S1]); },
          save(s) { env.sessions[s.sessionId] = s; return Promise.resolve(s); }
        };
        loadJ09(env, { cfg: { deviceId: DID_M1 }, isMasterOf: (sid) => sid === "S1" });

        const seen = [];
        env.inbox.onFrame(function (fr) { seen.push(fr); });
        peerIn(env, env.srv, "u1", DID_CAP, "S1");

        const bad = [
          { what: "sessionId absent", p: { kind: "preview_frame", from: DID_CAP, deviceId: DID_CAP, seq: 1, jpegBase64: "AAA" } },
          { what: "jpegBase64 absent", p: { kind: "preview_frame", from: DID_CAP, deviceId: DID_CAP, sessionId: "S1", seq: 1 } },
          { what: "jpegBase64 non string", p: { kind: "preview_frame", from: DID_CAP, deviceId: DID_CAP, sessionId: "S1", seq: 1, jpegBase64: 42 } },
          { what: "seq non numerique", p: { kind: "preview_frame", from: DID_CAP, deviceId: DID_CAP, sessionId: "S1", seq: "x", jpegBase64: "AAA" } },
          { what: "source absente", p: { kind: "preview_frame", sessionId: "S1", deviceId: DID_CAP, seq: 1, jpegBase64: "AAA" } },
          { what: "mauvaise session", p: { kind: "preview_frame", from: DID_CAP, deviceId: DID_CAP, sessionId: "S9", seq: 1, jpegBase64: "AAA" } }
        ];

        for (let i = 0; i < bad.length; i++) {
          const before = env.logText().length;
          deliver(env.srv, "u1", bad[i].p);
          await tickN(2);
          ok(/PREVIEW_TRANSPORT_DROP/.test(env.logText().slice(before)),
            "rejet journalise pour : " + bad[i].what);
        }

        eq(seen.length, 0, "aucune frame invalide n'atteint le callback J09");
        eq(env.inbox.latest("S1", DID_CAP), null, "rien n'est stocke");
        eq(env.inbox.stats().dropped >= 6, true, "chaque rejet est compte");
      });

    /* ---------- T10 : le transport ne peut jamais casser le REC ---------- */
    it("T10. une panne du transport ne remonte JAMAIS dans le callback du sampler",
      async () => {
        const env = createEnv({ skills: ["capture"], pixelCopyMode: "manual", fakeClock: true });
        loadAll(env, [
          "native/pixelcopy.js", "native/camera-record.js",
          "state/preview-service.js", "state/preview-sampler.js",
          "state/preview-inbox.js", "state/preview-transport.js"
        ]);
        /* Transport volontairement casse ET session introuvable. */
        env.MultiCamSessionWs = { sendPreviewFrame() { throw new Error("ws mort"); } };
        env.MultiCamSessionStore = { get() { return Promise.resolve(null); } };

        let threw = null;
        try { env.MultiCamPreviewTransport.bind(); } catch (e) { threw = e; }
        no(threw, "bind() ne doit rien lever");

        /* PAS d'await sur `PreviewService.bind()` : sous horloge virtuelle sa
         * promesse se résout sur un timer, or ce test ne mesure que le chemin
         * PixelCopy → transport. Le sampler n'a pas besoin de ce service. */
        env.MultiCamPreviewService.bind();
        const p1 = env.MultiCamCameraRecord.prepare({ startPlanId: "P1" });
        await env.clock.advance(20); await p1;
        const p2 = env.MultiCamCameraRecord.startRecording({ startPlanId: "P1" });
        await env.clock.advance(20); await p2;
        env.MultiCamPreviewSampler.start({ sessionId: "S1", takeNumber: 1, startPlanId: "P1" });

        for (let i = 0; i < 3; i++) {
          await env.clock.advance(1000);          /* le tick arme la capture */
          try { env.CameraPreview.pixelCopy.settle("ok"); } catch (e) { threw = e; }
          await env.clock.advance(0);
        }
        no(threw, "aucune exception dans le chemin PixelCopy → transport");
        eq(env.MultiCamPreviewSampler.view().stats.ok, 3,
          "le REC continue de produire ses images malgre le transport mort");
        eq(env.MultiCamPreviewTransport.stats().dropped >= 3, true,
          "les frames perdues sont COMPTEES, pas accumulees");
        eq(env.MultiCamPreviewTransport.stats().pendingDepth, 0, "et jamais mises en file");

        env.MultiCamPreviewSampler.stop("test_end");   /* sinon le timer vit pour toujours */
      });

    /* ---------- T11 : session inconnue / fermée ---------- */
    it("T11. le transport n'emet que si la session existe et est ouverte", async () => {
      const env = createEnv({ skills: ["capture"] });
      loadAll(env, ["state/preview-inbox.js", "state/preview-transport.js"]);
      env.MultiCamSessionStore = {
        get(sid) {
          if (sid === "S1") return Promise.resolve(session("S1", [DID_M1], [DID_CAP]));
          if (sid === "CLOSED") {
            return Promise.resolve(Object.assign(session("CLOSED", [DID_M1], [DID_CAP]), { state: "closed" }));
          }
          return Promise.resolve(null);
        }
      };
      let sendCalls = 0;
      env.MultiCamSessionWs = {
        sendPreviewFrame() { sendCalls++; return { sent: 1, recipients: 1, jsonBytes: 10 }; }
      };

      env.MultiCamPreviewTransport.bind();
      env.MultiCamPreviewTransport.submit(frameOf({ sessionId: "S1" }), "test");
      env.MultiCamPreviewTransport.submit(frameOf({ sessionId: "INCONNUE" }), "test");
      env.MultiCamPreviewTransport.submit(frameOf({ sessionId: "CLOSED" }), "test");
      await tickN(6);

      const st = env.MultiCamPreviewTransport.stats();
      eq(sendCalls, 1, "le WS n'est appele que pour la session ouverte");
      eq(st.sent, 1, "seule la session ouverte est servie");
      eq(st.dropped, 2, "session inconnue / fermee : DROP compte");
      eq(st.droppedBy.unknown_session, 1, "motif unknown_session");
      eq(st.droppedBy.session_not_open, 1, "motif session_not_open");
    });

    /* ---------- T13 : un Master joignable par DEUX sockets ----------
     *
     * DÉFECT TROUVÉ PAR LE SMOKE PHYSIQUE, PAS PAR RAISONNEMENT : sur le
     * terrain les deux devices sont serveur ET client l'un de l'autre, donc le
     * Master est joignable par deux connexions pour la même session. Une
     * diffusion par CONNEXION lui envoyait chaque image deux fois : deux fois le
     * débit, deux fois le décodage, et `received` (60) qui ne collait plus avec
     * `sent` (30). Un destinataire est un DEVICE, pas un socket.
     */
    itServer(envCapture, "T13. le meme Master sur 2 sockets : UNE seule frame envoyee",
      async (env) => {
        env.sessions = { S1: session("S1", [DID_M1], [DID_CAP]) };
        env.MultiCamSessionStore = {
          get(sid) { return Promise.resolve(env.sessions[sid] || null); },
          list() { return Promise.resolve([env.sessions.S1]); },
          save(s) { env.sessions[s.sessionId] = s; return Promise.resolve(s); }
        };
        loadJ09(env);
        peerIn(env, env.srv, "u1", DID_M1, "S1");       /* Master entre par le serveur */

        /* Le Meme Master, vu par la connexion cliente que la Capture tient
         * vers le serveur du Master. */
        await env.ws.connectTo("192.168.92.192", 45102);
        await tickN(4);
        const sock = env.wsSockets[env.wsSockets.length - 1];
        sock.readyState = 1;                            /* OPEN */
        sock.sent.length = 0;
        sock.onmessage && sock.onmessage({ data: JSON.stringify({
          v: 1, kind: "sync", from: DID_M1, ts: 1700000000000, sessionId: "S1", state: {}
        }) });

        env.transport.submit(frameOf(), "test");
        await tickN(5);

        eq(framesSent(env.srv).length, 1, "UNE seule emission cote serveur");
        eq(sock.sent.filter((s) => s.kind === "preview_frame").length, 0,
          "rien sur le deuxieme chemin vers le MEME device");
        eq(env.transport.stats().sent, 1, "1 frame source");
        eq(env.transport.stats().recipients, 1, "1 destinataire = 1 device, pas 2 sockets");
        eq(env.transport.stats().duplicateConnsSkipped, 1, "la connexion en doublon est comptee");
      });

    /* ---------- T12 : le transport reste pur ---------- */
    it("T12. session-ws reste un transport pur (aucune mosaique, aucun buffer d'image)", () => {
      const fs = require("fs");
      const path = require("path");
      const src = fs.readFileSync(path.join(h.WWW, "net/session-ws.js"), "utf8");
      /* `\b` est INDISPENSABLE : sans lui, des mots français legitimes
       * (« uTILE », « GRILLE ») feraient echouer le test sur leur propre
       * orthographe. Ce qu'on interdit, c'est un IDENTIFIANT de mosaique. */
      no(/\b(mosaic|mosa[iï]que|grid|gridCell|gridcell|layout|thumbnail|canvas|tile|tileRow|tileCol)\b/i.test(src),
        "session-ws.js ne doit contenir AUCUNE notion de mosaique/grille");
      ok(/preview_frame/.test(src), "session-ws.js connait le kind preview_frame");
      ok(/setPreviewBridge/.test(src), "et expose un PONT, pas une logique metier");
      /* Aucune retention de payload : le WS ne copie jamais le base64. */
      no(/frames\s*\[|frameStore|previewStore|imageCache/.test(src),
        "le WS ne conserve AUCUNE image");
    });
  });
}

module.exports = { register };
