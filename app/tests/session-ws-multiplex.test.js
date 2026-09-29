/* MultiCam — présence par session sur une connexion WS multiplexée.
 *
 * MODÈLE RÉEL (établi par inspection de `net/session-ws.js`, J04/J05) :
 * une connexion WS physique représente UN PEER GLOBAL, pas une session.
 *   - `connectTo()` indexe `state.clientConns` par endpoint "host:port" ;
 *   - `reSyncSession()` boucle sur TOUTES les sessions d'un Master et rappelle
 *     `connectTo(host, port)` pour chacune → une seule connexion réutilisée ;
 *   - les enveloppes portent `sessionId` par message : le multiplexage est
 *     protocolaire ;
 *   - `connectedPeers()` indexe sa sortie par `peerDid`, pas par session.
 *
 * BUG : l'appartenance aux sessions était modélisée par un SCALAIRE
 * (`entry.sessionId`), réécrit à CHAQUE message reçu
 * (`if (entry && env.sessionId) entry.sessionId = env.sessionId`, ligne 422).
 * Une connexion transportant S1 puis S2 se retrouvait estampillée S2, donc :
 *   1. `connectedPeers(S1)` ne la renvoyait plus ;
 *   2. `broadcast(S1)` / `broadcastTargeted(S1)` / `broadcastMember(S1)` la
 *      SKIPPAIENT — perte de messages RÉELE, pas seulement d'observabilité.
 *
 * ATTENDU : l'appartenance est un ENSEMBLE de sessions par connexion, et la
 * liveness est suivie par session.
 *
 * Couverture :
 *   M1. 1 connexion / 1 session          → comportement inchangé
 *   M2. 1 connexion / 2 sessions         → B présent dans connectedPeers(S1) ET S2
 *   M3. activité sur S1 seulement        → n'invente PAS de présence sur S2
 *   M4. rejoin de S2                     → B devient présent sur S2
 *   M5. fermeture physique              → B disparaît de S1 ET S2
 *   M6. reconnexion                     → associations reconstruites
 *   M7. deux peers distincts            → aucune contamination croisée
 *   M8. broadcast(S1) atteint la connexion multiplexée (non-régression métier)
 */

"use strict";

function register(h) {
  const { describe, it, createEnv, load, flush } = h;

  const DID_A = "aaaaaaaa-0000-0000-0000-00000000000a";   /* Master */
  const DID_B = "bbbbbbbb-0000-0000-0000-00000000000b";   /* Capture */
  const DID_C = "cccccccc-0000-0000-0000-00000000000c";   /* autre Capture */

  /* ---------- faux plugin serveur wsserver ---------- */
  /* On capture les callbacks que le module enregistre afin de rejouer le VRAI
   * chemin d'entrée : srvOnOpen / srvOnMsg / srvOnClose. */
  function makeWsServer() {
    const hooks = {};
    const sent = [];
    return {
      hooks,
      sent,
      start(port, opts, ok) {
        hooks.onOpen = opts.onOpen;
        hooks.onMessage = opts.onMessage;
        hooks.onClose = opts.onClose;
        setTimeout(() => ok("0.0.0.0", port), 0);
      },
      send(entry, payload) { sent.push({ uuid: entry && entry.uuid, payload: JSON.parse(payload) }); }
    };
  }

  /* WebSocket client simulé : s'ouvre seule après quelques ms, comme le vrai.
   * `readyState` suit la norme (0=CONNECTING, 1=OPEN, 3=CLOSED). */
  function makeWsClient(env) {
    function WS(url) {
      this.url = url;
      this.readyState = 0;                 /* CONNECTING */
      this.sent = [];
      env.wsSockets.push(this);
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;               /* OPEN */
        if (this.onopen) this.onopen();
      }, 5);
    }
    WS.OPEN = 1; WS.CONNECTING = 0; WS.CLOSING = 2; WS.CLOSED = 3;
    WS.prototype.send = function (p) { this.sent.push(JSON.parse(p)); };
    WS.prototype.close = function () {
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1000, reason: "" });
    };
    return WS;
  }

  function makeEnvInto(env) {
    env.cordova = { plugins: { wsserver: makeWsServer() } };
    env.MultiCamSessionModel = {
      sharedView(s) { return { sessionId: s.sessionId, state: s.state }; }
    };
    const sessions = {
      S1: { sessionId: "S1", state: "open", masters: [{ deviceId: DID_A }], members: [{ deviceId: DID_B }] },
      S2: { sessionId: "S2", state: "open", masters: [{ deviceId: DID_A }], members: [{ deviceId: DID_B }] }
    };
    env.MultiCamSessionStore = {
      get(sid) { return Promise.resolve(sessions[sid] || null); },
      list() { return Promise.resolve(Object.keys(sessions).map((k) => sessions[k])); },
      save(s) { sessions[s.sessionId] = s; return Promise.resolve(s); }
    };
    env.MultiCamConfig = {
      get() { return { deviceId: DID_A, deviceName: "Cam D4" }; },
      load() { return Promise.resolve({ deviceId: DID_A }); }
    };
    env.MultiCamNative = { ipv4: () => Promise.resolve("10.0.0.1") };
    env.wsSockets = [];
    env.WebSocket = makeWsClient(env);
    load(env, "net/session-ws.js");
    env.ws = env.MultiCamSessionWs;
    env.sessions = sessions;
    return env;
  }

  function conn(uuid) {
    return { uuid, remoteAddr: "10.0.0.9", resource: "/multicam" };
  }

  function env_(from, sid, kind) {
    const e = { v: 1, kind: kind || "sync_please", from, ts: 1700000000000 };
    if (sid) e.sessionId = sid;
    return JSON.stringify(e);
  }

  /* Fait SYNCHRONISER le pair sur `sid` via la connexion `c` (chemin réel).
   * L'ouverture n'est faite qu'UNE fois par uuid : un 2e `onOpen` créerait une
   * entrée neuve et effacerait l'historique de sessions — ce qu'on veut justement
   * observer. */
  function openOnce(env, c) {
    const seen = env.__opened || (env.__opened = {});
    if (seen[c.uuid]) return;
    seen[c.uuid] = true;
    env.cordova.plugins.wsserver.hooks.onOpen(c);
  }

  function peerSync(env, c, from, sid) {
    openOnce(env, c);
    env.cordova.plugins.wsserver.hooks.onMessage(c, env_(from, sid));
  }

  function has(env, did, sid) {
    return Object.prototype.hasOwnProperty.call(env.ws.connectedPeers(sid), did);
  }

  /* ---------- micro-assertions ---------- */
  function eq(actual, want, msg) {
    if (actual !== want) {
      throw new Error((msg ? msg + " — " : "") + "attendu " + want + ", obtenu " + actual
        + "\n--- logs ---\n" + lastEnv.logText());
    }
  }
  function yes(v, msg) { eq(v, true, msg); }
  function no(v, msg) { eq(v, false, msg); }

  let lastEnv = null;

  /* Chaque test démarre un vrai serveur, donc un `setInterval` de heartbeat :
   * sans fermeture explicite, node ne sort jamais. */
  function itServer(name, fn) {
    it(name, async () => {
      const env = createEnv();
      const e = makeEnvInto(env);
      lastEnv = e;
      try {
        await e.ws.ensureServer();
        await fn(e);
      } finally {
        e.ws.stopServer();
      }
    });
  }

  function itClient(name, fn) {
    it(name, async () => {
      const env = createEnv();
      const e = makeEnvInto(env);
      lastEnv = e;
      await fn(e);
    });
  }

  describe("session-ws · présence par session sur connexion multiplexée", () => {
    itServer("M1. une connexion, une session → comportement inchangé", async (env) => {
      const c = conn("u1");
      peerSync(env, c, DID_B, "S1");
      yes(has(env, DID_B, "S1"), "B doit être présent sur S1");
      no(has(env, DID_B, "S2"), "B n'a jamais parlé de S2 : il ne doit pas y être");
    });

    itServer("M2. une connexion, deux sessions → B présent dans connectedPeers(S1) ET S2", async (env) => {
      const c = conn("u1");
      peerSync(env, c, DID_B, "S1");
      peerSync(env, c, DID_B, "S2");
      yes(has(env, DID_B, "S1"), "B a synchronisé S1 : il doit y rester présent");
      yes(has(env, DID_B, "S2"), "B a synchronisé S2 sur la MÊME connexion : il doit y être présent");
    });

    itServer("M3. activité sur S1 seulement → n'invente pas de présence sur S2", async (env) => {
      const c = conn("u1");
      peerSync(env, c, DID_B, "S1");
      /* Messages sans sessionId (heartbeat, ping) : ne doivent rien créer. */
      env.cordova.plugins.wsserver.hooks.onMessage(c, env_(DID_B, null, "ping"));
      no(has(env, DID_B, "S2"), "aucun message sur S2 : présence S2 interdite");
      yes(has(env, DID_B, "S1"), "S1 reste présent");
    });

    itServer("M4. rejoin de S2 → B devient présent sur S2 sans perdre S1", async (env) => {
      const c = conn("u1");
      peerSync(env, c, DID_B, "S1");
      no(has(env, DID_B, "S2"), "pas encore de S2");
      peerSync(env, c, DID_B, "S2");
      yes(has(env, DID_B, "S2"), "S2 doit apparaître après le rejoin");
      yes(has(env, DID_B, "S1"), "S1 doit être conservé");
    });

    itServer("M5. fermeture physique → B disparaît de S1 ET S2", async (env) => {
      const c = conn("u1");
      peerSync(env, c, DID_B, "S1");
      peerSync(env, c, DID_B, "S2");
      env.cordova.plugins.wsserver.hooks.onClose(c, 1000, "bye", true);
      no(has(env, DID_B, "S1"), "S1 doit être vidé");
      no(has(env, DID_B, "S2"), "S2 doit être vidé");
    });

    itServer("M6. reconnexion → les associations sont reconstruites par le reSync", async (env) => {
      const c1 = conn("u1");
      peerSync(env, c1, DID_B, "S1");
      peerSync(env, c1, DID_B, "S2");
      env.cordova.plugins.wsserver.hooks.onClose(c1, 1006, "drop", false);
      no(has(env, DID_B, "S1"), "connexion fermée : S1 vidé");

      const c2 = conn("u2");   /* nouvelle connexion physique */
      peerSync(env, c2, DID_B, "S1");
      peerSync(env, c2, DID_B, "S2");
      yes(has(env, DID_B, "S1"), "S1 reconstruit");
      yes(has(env, DID_B, "S2"), "S2 reconstruit");
    });

    itServer("M7. deux peers distincts → aucune contamination croisée", async (env) => {
      const cb = conn("u1"), cc = conn("u2");
      peerSync(env, cb, DID_B, "S1");
      peerSync(env, cc, DID_C, "S2");
      yes(has(env, DID_B, "S1"), "B sur S1");
      no(has(env, DID_B, "S2"), "B n'est pas sur S2");
      yes(has(env, DID_C, "S2"), "C sur S2");
      no(has(env, DID_C, "S1"), "C n'est pas sur S1");

      env.cordova.plugins.wsserver.hooks.onClose(cb, 1000, "bye", true);
      yes(has(env, DID_C, "S2"), "fermer B ne doit pas vider S2 (connexion de C)");
    });

    itServer("M8. broadcast(S1) doit atteindre la connexion qui a aussi transporté S2", async (env) => {
      const c = conn("u1");
      peerSync(env, c, DID_B, "S1");
      peerSync(env, c, DID_B, "S2");   /* l'estampille passe à S2 avec le code livré */
      env.cordova.plugins.wsserver.sent.length = 0;
      env.ws.broadcast(env.sessions.S1, "test");
      const hit = env.cordova.plugins.wsserver.sent.some((m) => m.payload.kind === "sync"
        && m.payload.sessionId === "S1");
      yes(hit, "le sharedView de S1 n'atteint plus le peer — PERTE DE MESSAGE");
    });

    /* ---------- 2e cause racine : course entre le dial et l'envoi ----------
     *
     * Au boot, `reSyncSession()` boucle sur TOUTES les sessions d'un même Master
     * et appelle `connectTo(host, port)` pour chacune. La 1re crée le socket
     * (CONNECTING) ; la 2e… la 2e retrouve l'entrée et, si `connectTo` résout
     * sur un socket ENCORE CONNECTING, `sendOn()` refuse (readyState != OPEN) :
     * le message est PERDU. Et comme `SYNC_PLEASE_SENT` était émis sans vérifier
     * le retour de `sendOn`, le log annonçait un envoi réussi.
     *
     * C'est ce qui est físicamente observé : `SYNC_PLEASE_SENT S1` journalisé
     * 74 ms AVANT le `WS_CLIENT_OPEN`, et S1 jamais reçue par le Master alors
     * que S2 (envoyée après l'ouverture) l'a été.
     */
    itClient("N1. 2 sessions en rafale vers le meme endpoint : les 2 sync_please partent", async (env) => {
      env.sessions.S1.masters = [{ deviceId: DID_B, endpoint: "10.0.0.1:45000" }];
      env.sessions.S2.masters = [{ deviceId: DID_B, endpoint: "10.0.0.1:45000" }];
      env.ws.reSyncSession(env.sessions.S1);   /* dial 1 : socket CONNECTING */
      env.ws.reSyncSession(env.sessions.S2);   /* dial 2 : socket encore CONNECTING */
      await flush(); await flush();
      const socket = env.wsSockets[0];
      const sent = socket.sent.filter((m) => m.kind === "sync_please").map((m) => m.sessionId).sort();
      eq(socket.sent.length > 0 ? "1" : "0", "1", "le socket existe");
      eq(env.wsSockets.length, 1, "UNE seule connexion physique pour les 2 sessions");
      eq(JSON.stringify(sent), JSON.stringify(["S1", "S2"]),
        "les 2 sync_please doivent être réellement sur le fil");
    });

    itClient("N2. jamais plus de SYNC_PLEASE_SENT que d'envois réels (course)", async (env) => {
      env.sessions.S1.masters = [{ deviceId: DID_B, endpoint: "10.0.0.1:45000" }];
      env.sessions.S2.masters = [{ deviceId: DID_B, endpoint: "10.0.0.1:45000" }];
      env.ws.reSyncSession(env.sessions.S1);
      env.ws.reSyncSession(env.sessions.S2);
      await flush(); await flush();
      const onWire = env.wsSockets[0].sent.filter((m) => m.kind === "sync_please").length;
      const logged = env.logs.filter((e) => /^SYNC_PLEASE_SENT /.test(e)).length;
      eq(logged, onWire,
        "SYNC_PLEASE_SENT annonce un envoi qui n'a pas eu lieu (log mensonger)");
    });
  });
}

module.exports = { register };
