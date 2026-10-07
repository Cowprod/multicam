/* MultiCam — J09-D3 : reconnexion automatique après coupure réseau (Master → Capture).
 *
 * CAMPAIGNE (logs J09-FINAL) : la coupure Wi-Fi de la capture C coupe le socket
 * que le Master A avait ouvert vers C à l'invitation. A journalise
 * `WS_RETRY_SKIP … reason=no_open_session` et ne re-diale JAMAIS C ; C jette ses
 * trames (`PREVIEW_FRAME_DROP reason=no_master_connected`) pendant 120 s. Ce
 * test fige la cause racine et le correctif.
 *
 * MODÈLE RÉEL (rien de fabriqué) :
 *   - session créée par l'API transport réelle `createSession()` ;
 *   - membre ajouté par l'API réelle `addMember()`, avec les MÊMES arguments que
 *     l'écran 03 (`ui/session.js`) : `endpoint: device.wsEndpoint` (découverte) ;
 *   - le store ET le transport WS sont les vrais modules (`state/session-model.js`,
 *     `state/session-store.js`, `net/session-ws.js`) ;
 *   - seul le WebSocket physique est un faux pilote (ouverture/coupure pilotée),
 *     comme dans `session-ws-reconnect.test.js`.
 *
 * AUCUN endpoint n'est injecté à la main dans le modèle final : l'endpoint du
 * membre passe par le trajet production (découverte → `addMember`). C'est
 * précisément ce que les anciens tests masquaient (ils plantaient un
 * `members[].endpoint` factice dans un store fabriqué).
 *
 * D3.1 perte temporaire avec endpoint connu → l'info de reconnexion reste et la
 *      tentative automatique part (plus de `no_open_session`) ;
 * D3.2 reconnexion réussie → même did, même membre, aucun doublon, resync par la
 *      reconnexion elle-même ;
 * D3.3 endpoint mis à jour → le nouveau devient la cible, l'ancien est invalidé ;
 * D3.4 session fermée → `closed wins`, aucun retry ne ressuscite ;
 * D3.5 pas d'endpoint exploitable → aucune cible inventée, aucune boucle ;
 * D3.6 upsert endpoint : ré-ajout sans endpoint conserve la cible connue, jamais
 *      de doublon.
 */

"use strict";

function register(h) {
  const { describe, it, createEnv, loadAll, flush } = h;

  const A_DID = "aaaaaaaa-0000-0000-0000-00000000000a";   /* Master local */
  const C_DID = "bbbbbbbb-0000-0000-0000-00000000000b";   /* Capture */
  const EP_C1 = "10.0.0.7:45102";                         /* endpoint découvert, puis coupé */
  const EP_C2 = "10.0.0.8:45102";                         /* réapparition sur un autre endpoint */

  /* ---------- faux WebSocket pilote (mêmes conventions que le test reconnexion) ---------- */
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
    WS.prototype.openNow = function () {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      if (this.onopen) this.onopen();
    };
    WS.prototype.dropNow = function () {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.onerror) this.onerror({});
      if (this.onclose) this.onclose({ code: 1006, reason: "" });
    };
    return WS;
  }

  /* ---------- environnement réel : modèle + store + transport WS ---------- */
  function makeEnv() {
    const e = createEnv({ fakeClock: true });
    e.wsSockets = [];
    e.WebSocket = makeWs(e);
    e.MultiCamConfig = {
      get() { return { deviceId: A_DID, deviceName: "Regie" }; },
      load() { return Promise.resolve({ deviceId: A_DID }); }
    };
    e.MultiCamNative = { ipv4: () => Promise.resolve("10.0.0.1") };
    loadAll(e, ["state/session-model.js", "state/session-store.js", "net/session-ws.js"]);
    e.ws = e.MultiCamSessionWs;
    e.ws.bind({ deviceId: A_DID, deviceName: "Regie" });
    e.store = e.MultiCamSessionStore;
    return e;
  }

  /* Trajet EXACT de l'écran 03 (ui/session.js:addMember) : la découverte fournit
   * `wsEndpoint`, que le Master diale pour intégrer le device (§31.2). */
  async function addDiscoveredMember(e, session, endpoint, roles) {
    return e.ws.addMember(session, {
      deviceId: C_DID,
      deviceName: "Cam 07",
      enabledSkills: ["capture"],
      endpoint: endpoint || ""
    }, roles || ["capture"]);
  }

  function memberOf(s, did) {
    return (s && (s.members || []).filter((m) => m.deviceId === did)[0]) || null;
  }

  function hasLog(e, re) { return e.logs.some((l) => re.test(l)); }

  function eq(actual, want, msg) {
    if (actual !== want) {
      throw new Error((msg ? msg + " — " : "") + "attendu " + JSON.stringify(want)
        + ", obtenu " + JSON.stringify(actual) + "\n--- logs ---\n" + env.logText());
    }
  }
  function yes(v, msg) { eq(!!v, true, msg); }
  function no(v, msg) { eq(!!v, false, msg); }
  let env = null;   /* pour le message d'échec */

  describe("J09-D3 — reconnexion Master→Capture après coupure réseau", () => {
    it("D3.1. coupure avec endpoint connu : l'info survit ET la tentative automatique part", async () => {
      const e = makeEnv(); env = e;
      const s0 = await e.ws.createSession("Tournage", {});
      const sid = s0.sessionId;
      const s = await addDiscoveredMember(e, s0, EP_C1);
      await flush(); await flush();

      /* Le trajet UI (découverte → addMember) persiste l'endpoint de transport. */
      const stored = await e.store.get(sid);
      eq(memberOf(stored, C_DID).endpoint, EP_C1,
        "l'endpoint découvert est conservé dans members[].endpoint (sinon openSessionsFor ne matche jamais)");

      /* L'invitation a bien dialé le device découvert (§31.2). */
      eq(e.wsSockets.length, 1, "un socket d'invitation a été ouvert vers le device");
      eq(e.wsSockets[0].url, "ws://" + EP_C1, "le dial vise l'endpoint découvert");
      e.wsSockets[0].openNow();
      await flush();

      /* Rupture du transport. */
      e.wsSockets[0].dropNow();
      await flush();

      /* L'information nécessaire à la reconnexion reste disponible après la coupure. */
      const afterDrop = await e.store.get(sid);
      eq(memberOf(afterDrop, C_DID).endpoint, EP_C1,
        "la rupture du transport ne détruit pas l'identité réseau du membre");

      /* Aucune action manuelle : le transport doit armer un retry, pas le sauter. */
      await e.clock.advance(1200);
      await flush(); await flush();
      yes(hasLog(e, /WS_RETRY_SCHEDULE endpoint=10\.0\.0\.7:45102 .*sessions=1/),
        "une tentative automatique est déclenchée (WS_RETRY_SCHEDULE sessions=1)");
      no(hasLog(e, /WS_RETRY_SKIP endpoint=10\.0\.0\.7:45102 reason=no_open_session/),
        "défaut campagne : l'endpoint n'est PAS orphelin, plus de no_open_session");
      yes(e.wsSockets.length >= 2, "un second socket de reconnexion a été créé");
    });

    it("D3.2. réseau revenu : reconnexion réussie, même membre, aucun doublon", async () => {
      const e = makeEnv(); env = e;
      const s0 = await e.ws.createSession("Tournage", {});
      const sid = s0.sessionId;
      const pin = s0.pin;
      await addDiscoveredMember(e, s0, EP_C1);
      await flush(); await flush();
      e.wsSockets[0].openNow();
      await flush();
      e.wsSockets[0].dropNow();
      await e.clock.advance(1200);
      await flush(); await flush();
      yes(e.wsSockets.length >= 2, "une nouvelle tentative physique a été lancée sans action UI");

      const again = e.wsSockets[e.wsSockets.length - 1];
      eq(again.url, "ws://" + EP_C1, "elle vise le même endpoint connu");
      again.openNow();
      await flush(); await flush();
      yes(hasLog(e, /WS_RESYNC_SESSIONS endpoint=10\.0\.0\.7:45102 sessions=1/),
        "la reconnexion déclenche elle-même la re-synchronisation de la session");

      /* Le pair reprend la parole (C répond au rétablissement du lien). */
      again.onmessage({ data: JSON.stringify({ v: 1, kind: "sync", from: C_DID, ts: 1700000000001, sessionId: sid }) });
      await flush();
      yes(e.ws.connectedPeers(sid)[C_DID], "C redevient présent côté Master après reconnexion");

      /* Identité réutilisée, aucune duplication. */
      const after = await e.store.get(sid);
      const list = (after.members || []).filter((m) => m.deviceId === C_DID);
      eq(list.length, 1, "aucun membre fantôme ni doublon du même device");
      eq(list[0].deviceId, C_DID, "même deviceId");
      eq(after.sessionId, sid, "même sid (pas de nouvelle session)");
      eq(after.pin, pin, "même PIN");
      eq(after.state, "open", "la session reste ouverte");
      eq(after.masters.length, 1, "pas de Master dupliqué");
      eq(after.masters[0].deviceId, A_DID, "même Master qu'avant la coupure");

      /* Une connexion vivante et résolue ne tourne plus : aucun retry résiduel. */
      await e.clock.advance(60000);
      await flush(); await flush();
      eq(e.wsSockets.length, 2, "la reconnexion réussie ne multiplie pas les sockets");
    });

    it("D3.3. réapparition avec un AUTRE endpoint : le nouveau devient la cible, l'ancien est invalidé", async () => {
      const e = makeEnv(); env = e;
      const s0 = await e.ws.createSession("Tournage", {});
      const sid = s0.sessionId;
      await addDiscoveredMember(e, s0, EP_C1);
      await flush(); await flush();
      e.wsSockets[0].openNow();
      await flush();
      e.wsSockets[0].dropNow();   /* coupure sur l'ancienne adresse */
      await flush();

      /* Redécouverte : l'opérateur ré-actualise le membre avec le NOUVEL endpoint
       * découvert (même API, même forme d'argument que l'écran 03). */
      await addDiscoveredMember(e, await e.store.get(sid), EP_C2);
      await flush(); await flush();

      const updated = await e.store.get(sid);
      eq(memberOf(updated, C_DID).endpoint, EP_C2, "le nouveau endpoint devient la source valide");
      yes(e.wsSockets.some((s) => s.url === "ws://" + EP_C2), "un dial part immédiatement vers le NOUVEL endpoint");

      /* La boucle de retry suit le modèle : retries vers le nouveau, abandon de l'ancien
       * (plus aucune session ouverte ne le référence → règle d'invalidation du modèle). */
      await e.clock.advance(15000);
      await flush(); await flush();
      yes(hasLog(e, /WS_RETRY_SCHEDULE endpoint=10\.0\.0\.8:45102/),
        "les tentatives de reconnexion visent désormais le nouvel endpoint");
      yes(hasLog(e, /WS_RETRY_SKIP endpoint=10\.0\.0\.7:45102 reason=no_open_session/),
        "l'ancien endpoint n'étant plus référencé par une session ouverte, la boucle ne tourne pas indéfiniment dessus");
    });

    it("D3.4. session fermée : closed wins, aucune reconnexion ne la ressuscite", async () => {
      const e = makeEnv(); env = e;
      const s0 = await e.ws.createSession("Tournage", {});
      const sid = s0.sessionId;
      await addDiscoveredMember(e, s0, EP_C1);
      await flush(); await flush();
      e.wsSockets[0].openNow();
      await flush();

      await e.ws.closeSession(await e.store.get(sid));
      await flush(); await flush();
      const stash = e.wsSockets.length;

      /* Rupture APRÈS la fermeture : la session fermée ne doit rien re-dialer. */
      e.wsSockets[0].dropNow();
      await flush();
      await e.clock.advance(15000);
      await flush(); await flush();
      eq(e.wsSockets.length, stash, "aucune reconnexion n'est lancée pour une session fermée");
      no(hasLog(e, /WS_RETRY_SCHEDULE endpoint=10\.0\.0\.7:45102/), "aucun retry armé");
      yes(hasLog(e, /WS_RETRY_SKIP endpoint=10\.0\.0\.7:45102 reason=no_open_session/),
        "le skip par session fermée est le comportement invalidation attendu");
    });

    it("D3.5. aucun endpoint exploitable : aucune cible inventée, aucune boucle", async () => {
      const e = makeEnv(); env = e;
      const s0 = await e.ws.createSession("Tournage", {});
      const sid = s0.sessionId;
      await addDiscoveredMember(e, s0, "");
      await flush(); await flush();

      yes(hasLog(e, /INVITE_SKIP .*reason=no_endpoint/), "l'invitation ignore un device sans endpoint");
      eq(e.wsSockets.length, 0, "aucun dial inventé vers une cible inexistante");
      const stored = await e.store.get(sid);
      const m = memberOf(stored, C_DID);
      yes(m, "le membership reste valide (le device demeure membre de la session)");
      eq((m.endpoint || ""), "", "aucune cible exploitable n'est persistée");

      await e.clock.advance(20000);
      await flush(); await flush();
      eq(e.wsSockets.length, 0, "rien ne martèle un endpoint absent (pas de boucle agressive)");
    });

    it("D3.6. upsert membre : ré-ajout sans endpoint conserve la cible connue, jamais de doublon", async () => {
      const e = makeEnv(); env = e;
      const s0 = await e.ws.createSession("Tournage", {});
      const sid = s0.sessionId;
      await addDiscoveredMember(e, s0, EP_C1);
      await flush(); await flush();

      /* Second addMember (même deviceId), cette fois sans endpoint : c'est un
       * upsert idempotent par deviceId — il ne doit ni dupliquer le membre ni
       * effacer la cible de reconnexion déjà connue. */
      await addDiscoveredMember(e, await e.store.get(sid), "");
      await flush(); await flush();

      const after = await e.store.get(sid);
      const list = (after.members || []).filter((m) => m.deviceId === C_DID);
      eq(list.length, 1, "un seul membre pour le même device (pas de doublon)");
      eq(list[0].endpoint, EP_C1, "la cible connue survit au ré-ajout sans endpoint");
    });
  });
}

module.exports = { register };