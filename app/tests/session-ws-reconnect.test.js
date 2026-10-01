/* MultiCam — reprise AUTOMATIQUE d'une connexion WS client après coupure.
 *
 * MODÈLE RÉEL (inspection de `net/session-ws.js`, J04/J05/J09) :
 *   - une connexion WS physique représente UN PAIR GLOBAL : `state.clientConns`
 *     est indexé par endpoint "host:port" et NON par session ; l'appartenance
 *     est un ensemble (`entry.sessions`, sid -> dernier rx) ;
 *   - `connectTo()` crée le socket, `ws.onclose` le supprime de `clientConns`
 *     et journalise `PEER_DISCONNECTED` — puis S'ARRÊTE.
 *
 * DÉFAUT (observé sur device, J09-05) : après `WS_CLIENT_CLOSE code=1006`, AUCUN
 * `WS_CLIENT_OPEN` ne suit tant que rien n'appelle `reSyncSession()` à la main.
 * Les seuls chemins de re-dial existants sont explicites : `reSyncSession()`,
 * `inviteAddedDevice()`, `joinSession()` et la boucle de boot de `main.js`.
 * Il n'existe ni écoute `online`/`offline`, ni écoute `resume`, ni boucle de
 * retry : la présence par session ne se reconstruit donc JAMAIS seule, et les
 * previews ne repartent jamais sans action opérateur — alors que la maquette
 * impose « reconnexion réseau → même slot → reprise des previews ».
 *
 * ATTENDU (ce que ces tests figent) :
 *   R1  coupure du socket       → le peer disparaît de `connectedPeers`
 *   R2  endpoint toujours connu → une tentative de reconnexion SANS appel manuel
 *   R3  reconnexion réussie     → reSync des sessions, présence reconstruite
 *   R4  S1+S2 sur le même socket→ UNE seule reconnexion physique, reSync des deux
 *   R5  socket OPEN             → aucune tentative supplémentaire
 *   R6  socket CONNECTING       → aucune duplication
 *   R7  endpoint injoignable    → backoff croissant et BORNÉ (pas de boucle serrée)
 *   R8  retour réseau tardif    → la reconnexion reprend
 *   R9  session fermée          → ni reconnexion, ni reSync
 *   R10 background / foreground→ pas de retry agressif, reprise propre au resume
 */

"use strict";

function register(h) {
  const { describe, it, createEnv, load, flush } = h;

  const DID_M = "aaaaaaaa-0000-0000-0000-00000000000a";   /* Master */
  const DID_C = "bbbbbbbb-0000-0000-0000-00000000000b";   /* Capture */
  const EP_M = "10.0.0.1:45102";                          /* endpoint du Master */
  const EP_OTHER = "10.0.0.9:45102";                      /* autre pair : sans rapport */

  /* ---------- faux WebSocket piloté par le test ----------
   *
   * Aucun auto-ouverture : le test décide de `openNow()`, `dropNow()` (coupure
   * réseau, code 1006) ou de ne jamais ouvrir (endpoint injoignable). C'est ce
   * qui permet d'affirmer « aucune reconnexion sans action manuelle » : si le code
   * déclenchait un dial, un NOUVEAU socket apparaîtrait dans `env.wsSockets`. */
  function makeWs(env) {
    function WS(url) {
      this.url = url;
      this.readyState = 0;              /* CONNECTING */
      this.sent = [];
      this.closedByUs = false;
      env.wsSockets.push(this);
    }
    WS.OPEN = 1; WS.CONNECTING = 0; WS.CLOSING = 2; WS.CLOSED = 3;
    WS.prototype.send = function (p) { this.sent.push(JSON.parse(p)); };
    WS.prototype.close = function () {
      if (this.readyState === 3) return;
      this.closedByUs = true;
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1000, reason: "" });
    };
    /* Ouverture réussie du dial en cours. */
    WS.prototype.openNow = function () {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      if (this.onopen) this.onopen();
    };
    /* Coupure réseau : 1006 + onerror, SANS onclose « propre ». */
    WS.prototype.dropNow = function () {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.onerror) this.onerror({});
      if (this.onclose) this.onclose({ code: 1006, reason: "" });
    };
    return WS;
  }

  function session(id, ep, st) {
    return {
      sessionId: id,
      state: st || "open",
      masters: [{ deviceId: DID_M, endpoint: ep }],
      members: [{ deviceId: DID_C, endpoint: "10.0.0.7:45102" }]
    };
  }

  function makeEnv(sessions) {
    const env = createEnv({ fakeClock: true });
    const store = {};
    (sessions || [session("S1", EP_M)]).forEach(function (s) { store[s.sessionId] = s; });
    env.MultiCamSessionModel = {
      sharedView(s) { return { sessionId: s.sessionId, state: s.state }; }
    };
    env.MultiCamSessionStore = {
      get(sid) { return Promise.resolve(store[sid] || null); },
      list() { return Promise.resolve(Object.keys(store).map((k) => store[k])); },
      save(s) { store[s.sessionId] = s; return Promise.resolve(s); }
    };
    env.MultiCamConfig = {
      get() { return { deviceId: DID_C, deviceName: "Cam 07" }; },
      load() { return Promise.resolve({ deviceId: DID_C }); }
    };
    env.MultiCamNative = { ipv4: () => Promise.resolve("10.0.0.7") };
    env.cordova = {
      plugins: {
        wsserver: {
          start(p, o, ok) {
            env.serverHooks = o;
            env.setTimeout(() => ok("0.0.0.0", p), 0);
          },
          stop() {},
          send() {}
        }
      }
    };
    env.wsSockets = [];
    env.WebSocket = makeWs(env);
    env.sessionStore = store;
    load(env, "net/session-ws.js");
    env.ws = env.MultiCamSessionWs;
    return env;
  }

  /* ---------- micro-assertions ---------- */
  function eq(actual, want, msg) {
    if (actual !== want) {
      throw new Error((msg ? msg + " — " : "") + "attendu " + JSON.stringify(want)
        + ", obtenu " + JSON.stringify(actual) + "\n--- logs ---\n" + env.logText());
    }
  }
  function yes(v, msg) { eq(!!v, true, msg); }
  function no(v, msg) { eq(!!v, false, msg); }
  let env = null;   /* pour le message d'échec */

  /* Ouvre une session : dial + ouverture + sync_please, comme au boot. */
  async function openSession(e, s) {
    e.ws.reSyncSession(e.sessionStore[s.sessionId]);
    await flush(); await flush();
    e.wsSockets[0].openNow();
    await flush(); await flush();
  }

  function syncPlease(socket, sid) {
    return socket.sent.filter((m) => m.kind === "sync_please" && (!sid || m.sessionId === sid));
  }

  function present(e, did, sid) {
    return Object.prototype.hasOwnProperty.call(e.ws.connectedPeers(sid), did);
  }

  /* Le peer est-il connu côté Master pour cette session ? On simule la réponse du
   * Master au sync_please : c'est elle qui (re)construit la présence de session. */
  function peerSync(e, socket, sid) {
    socket.onmessage({
      data: JSON.stringify({ v: 1, kind: "sync", from: DID_M, ts: 1700000000000, sessionId: sid })
    });
  }

  describe("session-ws · reconnexion automatique après coupure", () => {
    it("R1. socket coupé → le peer disparaît de connectedPeers", async () => {
      const e = makeEnv([session("S1", EP_M)]);
      env = e;
      await openSession(e, e.sessionStore.S1);
      peerSync(e, e.wsSockets[0], "S1");
      yes(present(e, DID_M, "S1"), "le Master est présent tant que le socket vit");
      e.wsSockets[0].dropNow();
      no(present(e, DID_M, "S1"), "socket fermé : le peer doit disparaître");
    });

    it("R2. endpoint connu + coupure → tentative de reconnexion SANS reSyncSession manuel", async () => {
      const e = makeEnv([session("S1", EP_M)]);
      env = e;
      await openSession(e, e.sessionStore.S1);
      peerSync(e, e.wsSockets[0], "S1");
      e.wsSockets[0].dropNow();
      eq(e.wsSockets.length, 1, "aucun second socket tant que le backoff n'a pasExpired");
      /* On laisse passer le premier délai de backoff, SANS appeler reSyncSession. */
      await e.clock.advance(1200);
      await flush(); await flush();
      yes(e.wsSockets.length >= 2,
        "le transport doit re-dialer tout seul (défaut J09 : aucun WS_CLIENT_OPEN après 1006)");
      eq(e.wsSockets[1].url, "ws://" + EP_M, "le re-dial vise le même endpoint");
    });

    it("R3. reconnexion réussie → reSync S1 et présence reconstruite", async () => {
      const e = makeEnv([session("S1", EP_M)]);
      env = e;
      await openSession(e, e.sessionStore.S1);
      e.wsSockets[0].dropNow();
      await e.clock.advance(1200);
      await flush(); await flush();
      const again = e.wsSockets[e.wsSockets.length - 1];
      again.openNow();
      await flush(); await flush();
      eq(syncPlease(again).length, 1, "un sync_please doit être émis sur la NOUVELLE connexion");
      eq(syncPlease(again)[0].sessionId, "S1", "c'est S1 qui est re-synchronisé");
      peerSync(e, again, "S1");
      yes(present(e, DID_M, "S1"), "la présence doit être reconstruite par le reSync");
    });

    it("R4. S1+S2 sur le même socket → UNE reconnexion physique, reSync des deux", async () => {
      const e = makeEnv([session("S1", EP_M), session("S2", EP_M)]);
      env = e;
      await openSession(e, e.sessionStore.S1);
      await openSession(e, e.sessionStore.S2);
      eq(e.wsSockets.length, 1, "S1 et S2 partagent une seule connexion physique");
      peerSync(e, e.wsSockets[0], "S1");
      peerSync(e, e.wsSockets[0], "S2");
      e.wsSockets[0].dropNow();
      await e.clock.advance(1200);
      await flush(); await flush();
      eq(e.wsSockets.length, 2, "UNE SEULE reconnexion physique pour les deux sessions");
      const again = e.wsSockets[1];
      again.openNow();
      await flush(); await flush();
      eq(syncPlease(again, "S1").length, 1, "S1 re-synchronisée");
      eq(syncPlease(again, "S2").length, 1, "S2 re-synchronisée");
      peerSync(e, again, "S1");
      peerSync(e, again, "S2");
      yes(present(e, DID_M, "S1"), "présence S1 reconstruite");
      yes(present(e, DID_M, "S2"), "présence S2 reconstruite");
    });

    it("R5. socket déjà OPEN → aucune tentative supplémentaire", async () => {
      const e = makeEnv([session("S1", EP_M)]);
      env = e;
      await openSession(e, e.sessionStore.S1);
      await e.clock.advance(60000);
      await flush(); await flush();
      eq(e.wsSockets.length, 1, "une connexion ouverte ne doit jamais être re-dialée");
      eq(syncPlease(e.wsSockets[0]).length, 1,
        "et le retry ne doit pas re-émettre de sync_please en boucle");
    });

    it("R6. socket CONNECTING → aucune duplication", async () => {
      const e = makeEnv([session("S1", EP_M)]);
      env = e;
      e.ws.reSyncSession(e.sessionStore.S1);
      await flush(); await flush();
      eq(e.wsSockets.length, 1, "le premier dial a créé le socket");
      /* Deux dialers concurrents vers le même endpoint (deux sessions, un boot). */
      e.ws.reSyncSession(e.sessionStore.S1);
      e.ws.reSyncSession(e.sessionStore.S1);
      await flush(); await flush();
      eq(e.wsSockets.length, 1, "aucun socket concurrent vers le même endpoint");
    });

    it("R7. endpoint injoignable → backoff croissant et borné, pas de boucle serrée", async () => {
      const e = makeEnv([session("S1", EP_M)]);
      env = e;
      e.ws.reSyncSession(e.sessionStore.S1);
      await flush(); await flush();
      /* Le peer ne répond jamais : le chien de garde du dial (4 s, convention de
       * l'invitation) abandonne chaque socket, puis le backoff reprogramme. */
      for (let i = 0; i < 12; i++) {
        await e.clock.advance(500);
        await flush();
      }
      await flush(); await flush();
      yes(e.wsSockets.length >= 2,
        "au moins une relance après l'abandon du premier dial (" + e.wsSockets.length + ")");
      /* Sur 6 s : 1 dial initial + 1 relance (4 s + 500 ms). Trois de plus
       * signifierait une boucle serrée. */
      yes(e.wsSockets.length <= 3,
        "le backoff doit borner le nombre de tentatives (" + e.wsSockets.length + " en 6 s)");
      /* Le délai NE DOIT NI décroître NI dépasser le plafond : c'est la preuve
       * que le retry est croissant et borné, pas seulement « il réessaie ». */
      const delays = env.logs
        .filter(function (l) { return /WS_RETRY_SCHEDULE .*delay=(\d+)ms/.test(l); })
        .map(function (l) { return parseInt(/delay=(\d+)ms/.exec(l)[1], 10); });
      yes(delays.length >= 1, "au moins un retry programmé");
      eq(delays[0], 500, "premier délai = 500 ms");
      yes(delays.every(function (d, i) { return i === 0 || d >= delays[i - 1]; }),
        "délais croissants : " + JSON.stringify(delays));
      yes(delays.every(function (d) { return d <= 5000; }),
        "délai plafonné à 5000 ms : " + JSON.stringify(delays));
      /* Et le partner injoignable ne doit PAS être annoncé présent. */
      eq(Object.keys(e.ws.connectedPeers("S1")).length, 0,
        "un endpoint injoignable ne doit jamais rester « connecté »");
    });

    it("R8. retour réseau après plusieurs échecs → la reconnexion reprend", async () => {
      const e = makeEnv([session("S1", EP_M)]);
      env = e;
      e.ws.reSyncSession(e.sessionStore.S1);
      await flush(); await flush();
      /* Réseau mort : chaque dial reste CONNECTING puis est abandonné (4 s),
       * suivi d'une relance à backoff croissant. 20 s = plusieurs échecs. */
      for (let i = 0; i < 40; i++) {
        await e.clock.advance(500);
        await flush();
      }
      await flush(); await flush();
      const before = e.wsSockets.length;
      yes(before >= 3, "des tentatives ont eu lieu pendant la coupure (" + before + ")");
      /* Le réseau revient : le peer accepte enfin un dial. */
      let opened = false;
      for (let i = 0; i < 12 && !opened; i++) {
        await e.clock.advance(500);
        await flush(); await flush();
        const last = e.wsSockets[e.wsSockets.length - 1];
        if (last.readyState === 0) { last.openNow(); opened = true; }
      }
      yes(opened, "le transport doit finir par rouvrir le socket");
      await flush(); await flush();
      const again = e.wsSockets[e.wsSockets.length - 1];
      eq(syncPlease(again).length, 1, "la session est re-synchronisée après le retour du réseau");
      yes(env.logs.some(function (l) { return /WS_CLIENT_OPEN/.test(l); }),
        "l'ouverture est journalisée");
      yes(env.logs.some(function (l) { return /WS_RESYNC_SESSIONS .*S1/.test(l); }),
        "le reSync de rattrapage est déclenché par la reconnexion, pas par un appel manuel");
    });

    it("R9. session fermée → ni reconnexion, ni reSync", async () => {
      const e = makeEnv([session("S1", EP_M)]);
      env = e;
      await openSession(e, e.sessionStore.S1);
      e.sessionStore.S1.state = "closed";
      e.wsSockets[0].dropNow();
      await e.clock.advance(20000);
      await flush(); await flush();
      eq(e.wsSockets.length, 1,
        "une session fermée ne doit plus être re-dialée : aucun retry pour un endpoint abandonné");
    });

    /* Constaté sur le device pendant le smoke : après une coupure, le socket
     * EN COURS du retry reste CONNECTING quelques secondes. Un dial EXPLICITE
     * (ici l'adhésion d'une session) venait s'y accoler et héritait de son
     * `dial_timeout`, alors que le réseau et le Master étaient Sains : le
     * socket était doomed par SON budget, pas par le réseau. */
    it("R11. dial explicite → ne jamais hériter de l'échec d'un socket de retry", async () => {
      const e = makeEnv([session("S1", EP_M)]);
      env = e;
      await openSession(e, e.sessionStore.S1);
      /* Coupure : le retry prend la main et reste CONNECTING (réseau mort). */
      e.wsSockets[0].dropNow();
      await e.clock.advance(600);
      await flush(); await flush();
      const retrySocket = e.wsSockets[e.wsSockets.length - 1];
      yes(retrySocket && retrySocket.readyState === 0,
        "un socket de retry est en cours d'ouverture");

      /* Action explicite de l'opérateur alors que le retry agonise. */
      let dialErr = null;
      const avantRupture = e.wsSockets.length;
      const dial = e.ws.connectTo(EP_M.split(":")[0], parseInt(EP_M.split(":")[1], 10))
        .then(function () {}, function (err) { dialErr = err; });
      await flush(); await flush();
      const nApresTakeover = e.wsSockets.length;
      yes(nApresTakeover > avantRupture, "le dial explicite prend un socket neuf");
      const last = e.wsSockets[nApresTakeover - 1];
      yes(last !== retrySocket, "ce socket n'est pas celui du retry");

      /* Le réseau va bien : le peer accepte le socket explicite. */
      last.openNow();
      await dial;
      await flush(); await flush();
      yes(dialErr === null, "le dial explicite aboutit");

      /* Le socket de retry est abandonné par son chien de garde : cela ne doit
       * rien casser du dial explicite, déjà résolu sur SON socket. */
      await e.clock.advance(5000);
      await flush(); await flush();
      yes(dialErr === null, "le dial explicite n'hérite pas du dial_timeout du retry");
      yes(env.logs.some(function (l) { return /WS_DIAL_TAKEOVER/.test(l); }),
        "la reprise de socket est journalisée (WS_DIAL_TAKEOVER)");
    });

    it("R10. background → pas de retry agressif, reprise propre au foreground", async () => {
      const e = makeEnv([session("S1", EP_M)]);
      env = e;
      /* `bind()` est le boot réel : c'est lui qui branche pause/resume. */
      e.ws.bind({ deviceId: DID_C, deviceName: "Cam Test" });
      await openSession(e, e.sessionStore.S1);
      e.wsSockets[0].dropNow();
      /* L'app passe en arrière-plan : aucun retry ne doit partir. */
      e.document._fire("pause");
      const apresPause = e.wsSockets.length;
      await e.clock.advance(30000);
      await flush(); await flush();
      eq(e.wsSockets.length, apresPause,
        "en arrière-plan, le transport ne martèle pas l'endpoint");
      /* Retour au premier plan : la reprise est immédiate et unique. */
      e.document._fire("resume");
      await flush(); await flush();
      eq(e.wsSockets.length, apresPause + 1, "le resume re-diale une fois");
      const last = e.wsSockets[e.wsSockets.length - 1];
      last.openNow();
      await flush(); await flush();
      eq(syncPlease(last).length, 1, "et re-synchronise la session");
    });
  });
}

module.exports = { register };