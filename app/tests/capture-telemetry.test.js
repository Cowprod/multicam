/* MultiCam — J09-06 : télémétrie opérationnelle des Captures (contrat,
 * transport, modèle mémoire, mosaïque, vue détaillée).
 *
 * CE QUE CES TESTS FIGENT, et pourquoi chaque ligne existe :
 *
 *   1. LA BONNE CAPTURE / LA BONNE SESSION. La mosaïque de régie ne peut pas
 *      se permettre d'afficher la batterie du mauvais device : la télémétrie est
 *      donc indexée (sessionId, deviceId), et un device hors Take est ignoré ET
 *      compté — exactement comme pour les frames (J09-05).
 *   2. LATEST STATE WINS, SANS HISTORIQUE. Une supervision d'opérateur montre
 *      l'état courant ; garder un historique de snapshots n'aurait aucun usage
 *      ici et coûterait de la mémoire pour rien (décision §23 : pas d'historique).
 *   3. AUCUNE DONNÉE INVENTÉE. Batterie inconnue ≠ 0 %, stockage inconnu ≠ 0
 *      octets. L'absence de donnée est un état AFFICHABLE, pas une valeur
 *      falsifiable : c'est le piège classique de ce type d'écran.
 *   4. DÉCONNECTED N'EST PAS UNE DONNÉE DE TÉLÉMÉTRIE. La vignette déconnectée
 *      garde sa dernière télémétrie et sa dernière image, mais son état vient du
 *      LIVENESS WS côté Master, jamais d'un auto-déclaration : une Capture ne
 *      peut pas se déclarer connectée après une coupure réseau.
 *   5. LES CONCEPTS NE SE MELANGENT PAS. WS vivant + preview vieille + télémétrie
 *      périmée = trois informations distinctes ; « périmé » signale une donnée
 *      ancienne, ça ne fabrique jamais un DECONNECTED.
 *   6. MASTER + CAPTURE LOCAL : la télémétrie locale s'affiche sans aller-retour
 *      réseau inutile (le transport écarte déjà le self-loop J09-04).
 *
 * COUVERTURE :
 *   T1.  Capture S1 publie sa télémétrie      -> le Master S1 la reçoit
 *   T2.  la même télémétrie sous S2           -> aucun effet sur S1
 *   T3.  device hors Take                     -> mosaïque intacte + compté
 *   T4.  deux snapshots du même device        -> le 2e remplace, pas d'historique
 *   T5.  batterie inconnue                   -> état neutre, PAS 0 %
 *   T6.  stockage inconnu                    -> état neutre
 *   T7.  Capture déconnectée                 -> télémétrie conservée, DECONNECTED
 *   T8.  reconnexion                          -> même slot, télémétrie fraîche
 *   T9.  télémétrie périmée                  -> stale signalé, PAS de DECONNECTED
 *   T10. Master + Capture local               -> télémétrie locale sans loopback
 *   T11. deux Captures                        -> aucune contamination A/B
 *   T12. REC -> STOPPED                       -> état de vignette cohérent
 *   T13. cadence 5 s, latest-wins, sans file  -> pas d'accumulation
 *   T14. changement important                 -> publication immédiate
 *   T15. vue détaillée                        -> données cohérentes avec la vignette
 *   T16. vue détaillée déconnectée            -> dernière image + dernière télémétrie
 *   T17. vue détaillée                        -> AUCUNE action de commande
 *   T18. contrat : champs inconnus / faux     -> assainis, jamais propagés tels quels
 *   T19. échelle de batterie                  -> fraction OU pourcentage lus pareil
 */

"use strict";

function register(h) {
  const { describe, it, createEnv, load, loadAll, flush } = h;

  const SID = "SIDTELEM";
  const SID2 = "SIDOTHER";
  const LOCAL = "dddddddd-0000-0000-0000-000000000001";   /* Master + Capture */
  const A = "aaaaaaaa-0000-0000-0000-00000000000a";      /* Capture A */
  const B = "bbbbbbbb-0000-0000-0000-00000000000b";      /* Capture B */
  const C = "cccccccc-0000-0000-0000-00000000000c";      /* Capture C, hors Take */

  /* ---------- faux plugin serveur wsserver + WebSocket client ---------- */

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
    WS.prototype.send = function (p) { this.sent.push(JSON.parse(p)); };
    WS.prototype.close = function () {
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1000, reason: "" });
    };
    return WS;
  }

  /* Environnement « Master qui REÇOIT » : il possède déjà S1 et S2, et le
   * modèle de session est le vrai MultiCamSessionModel (la validation du
   * contrat doit être testée, pas contournée). */
  function envMaster(opts) {
    const o = opts || {};
    const e = createEnv();
    e.cordova = { plugins: { wsserver: makeWsServer() } };
    e.MultiCamNative = { ipv4: () => Promise.resolve("10.0.0.1") };
    e.wsSockets = [];
    e.WebSocket = makeWsClient(e);
    e.MultiCamConfig = {
      get() { return { deviceId: o.localDid || LOCAL, deviceName: "Regie" }; },
      load() { return Promise.resolve({ deviceId: o.localDid || LOCAL }); }
    };
    e.__sessions = {};
    loadAll(e, ["state/session-model.js", "state/session-store.js", "state/telemetry-store.js", "net/session-ws.js"]);
    /* Sessions initiales S1/S2 : le Master local + la Capture A comme membre.
     * On passe par l'API RÉELLE du modèle (createSession/addMember), pas par un
     * objet fabriqué à la main : le test doit valider le même chemin que
     * l'application. */
    const sm = e.MultiCamSessionModel;
    const self = { deviceId: o.localDid || LOCAL, deviceName: "Regie", endpoint: "10.0.0.1:45100" };
    e.__sessions[SID] = forceSessionId(sm.createSession("Studio A", self), SID);
    e.__sessions[SID2] = forceSessionId(sm.createSession("Studio B", self), SID2);
    if (o.withMemberA !== false) {
      e.__sessions[SID] = sm.addMember(e.__sessions[SID], {
        deviceId: A, deviceName: "Cam A", enabledSkills: ["capture", "controller"]
      }, ["capture"], LOCAL).session;
    }
    e.MultiCamSessionStore = {
      get(sid) { return Promise.resolve(e.__sessions[sid] || null); },
      list() { return Promise.resolve(Object.keys(e.__sessions).map((k) => e.__sessions[k])); },
      save(s) { e.__sessions[s.sessionId] = s; return Promise.resolve(s); }
    };
    e.ws = e.MultiCamSessionWs;
    return e;
  }

  /* Le sessionId est tiré par le modèle : on le FIXE pour que les tests portent
   * sur les identifiants qu'ils citent. */
  function forceSessionId(session, sessionId) {
    session.sessionId = sessionId;
    return session;
  }

  function conn(uuid) {
    return { uuid: uuid || "conn-1", remoteAddr: "10.0.0.9", resource: "/multicam" };
  }

  /* Un snapshot de télémétrie « mesuré » (forme du contrat). */
  function snap(over) {
    return Object.assign({
      capabilities: { unknown: false, audioMic: true, gpsFeature: false, cameras: { rear: ["HD", "FHD"], front: ["HD"] } },
      batteryLevel: 62,
      batteryCharging: true,
      freeBytes: 8791234567,
      totalBytes: 128849018880,
      netType: "wifi",
      recording: true,
      atMs: 1700000000000
    }, over || {});
  }

  /* ---------- environnement mosaïque (sans DOM) ---------- */

  /* Le Master en mosaïque REC : toutes les Captures du plan sont VIVANTES au
   * départ. `connected` est un fait de LIVENESS (J09-05), jamais une déduction
   * de la télémétrie — les tests qui veulent une coupure le disent en appelant
   * `setLiveness(did, false)`.
   * Horloge virtuelle obligatoire : la fraîcheur (âge de la télémétrie, âge de la
   * preview) se mesure en millisecondes, on ne veut pas de Date.now() réel. */
  function envLive(participants, opts) {
    const o = opts || {};
    const e = createEnv({ fakeClock: true });
    loadAll(e, [
      "state/session-model.js",
      "state/telemetry-store.js",
      "state/take-model.js",
      "state/live-model.js",
      "ui/live.js",
      "ui/live-detail.js"
    ]);
    const model = e.MultiCamLiveModel;
    const screen = e.MultiCamLiveScreen;
    model.bind({
      localDid: o.localDid === null ? "" : (o.localDid || LOCAL),
      getParticipants: function (sid) { return sid === SID ? participants : []; }
    });
    model.setTake(SID, o.take === undefined ? 7 : o.take);
    model.syncParticipants();
    participants.forEach(function (p) { model.setLiveness(p.deviceId, true); });
    return { e, model, screen, store: e.MultiCamTelemetryStore, detail: e.MultiCamLiveDetail };
  }

  function parts() {
    return Array.prototype.slice.call(arguments).map(function (d) {
      return typeof d === "string" ? { deviceId: d, deviceName: d, role: "capture" } : d;
    });
  }

  function slotOf(m, did) {
    return m.view().slots.filter(function (s) { return s.deviceId === did; })[0] || null;
  }

  /* ---------- micro-assertions ---------- */

  function eq(actual, want, msg) {
    if (actual !== want) {
      throw new Error((msg ? msg + " — " : "") + "attendu " + want + ", obtenu " + actual);
    }
  }
  function yes(v, msg) { eq(v, true, msg); }
  function no(v, msg) { eq(v, false, msg); }
  function ok(v, msg) { yes(!!v, msg); }
  function findIcon(list, key) {
    return (list || []).filter(function (x) { return x.key === key; })[0] || null;
  }

  /* ==================================================================
   * T1 / T2 — TRANSPORT : la bonne session, la bonne Capture
   * ================================================================== */

  describe("J09-06 télémétrie — transport (telemetry_update)", () => {
    it("T1. Capture S1 publie -> le Master S1 reçoit la télémétrie", async () => {
      /* Chemin RÉEL : le service publie via updateMemberTelemetry, qui
       * broadcast un `telemetry_update` ; on rejoue ensuite ce payload exact
       * dans le Master (srvOnMsg), comme le ferait le socket. */
      const cap = createEnv();
      cap.cordova = { plugins: { wsserver: makeWsServer() } };
      cap.MultiCamNative = { ipv4: () => Promise.resolve("10.0.0.5") };
      cap.wsSockets = [];
      cap.WebSocket = makeWsClient(cap);
      cap.MultiCamConfig = {
        get() { return { deviceId: A, deviceName: "Cam A" }; },
        load() { return Promise.resolve({ deviceId: A }); }
      };
      let session = null;
      cap.MultiCamSessionStore = {
        get(sid) { return Promise.resolve(sid === SID ? session : null); },
        list() { return Promise.resolve(session ? [session] : []); },
        save(s) { session = s; return Promise.resolve(s); }
      };
      loadAll(cap, ["state/session-model.js", "state/session-store.js", "net/session-ws.js"]);
      const sm = cap.MultiCamSessionModel;
      const s0 = forceSessionId(sm.createSession("Studio A", { deviceId: B, deviceName: "Regie", endpoint: "10.0.0.1:45100" }), SID);
      session = sm.addMember(s0, {
        deviceId: A, deviceName: "Cam A", enabledSkills: ["capture", "controller"]
      }, ["capture"], B).session;
      await cap.MultiCamSessionWs.ensureServer();
      /* Le Master B se connecte AU SERVEUR de la Capture et s'annonce : sans
       * cela le broadcast n'a aucune connexion et rien n'est observable — ce n'est
       * pas un raccourci de test, c'est la condition réelle d'un envoi. */
      const cB = conn("master-b");
      cap.cordova.plugins.wsserver.hooks.onOpen(cB);
      cap.cordova.plugins.wsserver.hooks.onMessage(cB, JSON.stringify({
        v: 1, kind: "sync_please", from: B, ts: 1700000000000, sessionId: SID
      }));
      await cap.MultiCamSessionWs.updateMemberTelemetry(session, A, snap());

      /* Le broadcast contient bien la télémétrie de A, pour S1, par A. */
      const envs = cap.cordova.plugins.wsserver.sent.map(function (s) { return s.payload; });
      const pub = envs.filter(function (p) { return p.kind === "telemetry_update"; })[0];
      /* Côté Master : on applique ce payload exact. */
      const m = envMaster();
      try {
        ok(pub, "aucun telemetry_update émis par la Capture");
        eq(pub.sessionId, SID);
        eq(pub.from, A);
        eq(pub.deviceId, A, "la Capture publie pour elle-même");
        eq(pub.telemetry.batteryLevel, 62);

        await m.ws.ensureServer();
        const c = conn();
        m.cordova.plugins.wsserver.hooks.onOpen(c);
        m.cordova.plugins.wsserver.hooks.onMessage(c, JSON.stringify(pub));
        /* La réception est une chaîne de promesses (lecture session → modèle →
         * écriture store) : on laisse le tour d'événement se dérouler avant
         * d'asserter, exactement comme sur le terrain. */
        await new Promise(function (r) { setTimeout(r, 20); });

        const got = m.MultiCamTelemetryStore.get(SID, A);
        ok(got, "télémétrie absente du store du Master");
        eq(got.telemetry.batteryLevel, 62);
        eq(got.telemetry.freeBytes, 8791234567);
        eq(got.telemetry.batteryCharging, true);
        eq(got.telemetry.netType, "wifi");
        eq(got.telemetry.recording, true);
        /* Le modèle de session du Master porte la même donnée (source de vérité
         * persistée) — pas de divergence entre store vivant et session. */
        const sess = m.__sessions[SID];
        const mem = (sess.members || []).filter(function (x) { return x.deviceId === A; })[0];
        ok(mem, "A n'est pas membre de S1 côté Master");
        eq(mem.telemetry.batteryLevel, 62);
        eq(mem.telemetry.totalBytes, 128849018880);
      } finally {
        /* Les deux serveurs sont arrêtés dans le MÊME finally : un heartbeat
         * laissé actif ferait tourner node jusqu'au timeout du runner. */
        m.ws.stopServer();
        cap.MultiCamSessionWs.stopServer();
      }
    });

    it("T2. la même télémétrie annoncée sous S2 ne touche PAS S1", async () => {
      const m = envMaster();
      try {
        await m.ws.ensureServer();
        const c = conn();
        m.cordova.plugins.wsserver.hooks.onOpen(c);
        /* A est membre de S1 chez le Master, mais le message prétend venir de S2. */
        m.cordova.plugins.wsserver.hooks.onMessage(c, JSON.stringify({
          v: 1, kind: "telemetry_update", from: A, ts: 1700000000000,
          sessionId: SID2, deviceId: A, telemetry: snap({ batteryLevel: 3 })
        }));
        /* S2 n'a pas de membre A : rien ne doit être créé. */
        const s2 = m.__sessions[SID2];
        const memS2 = (s2.members || []).filter(function (x) { return x.deviceId === A; })[0];
        ok(!memS2, "un telemetry_update ne doit pas créer de membre");
        eq(m.MultiCamTelemetryStore.get(SID, A), null, "S1 ne doit rien recevoir");
        eq(m.MultiCamTelemetryStore.get(SID2, A), null, "S2 sans membre A ne rien stocker");
        no(m.logText().indexOf("TELEMETRY_RECEIVED") >= 0, "aucune réception acceptée attendue");
      } finally {
        m.ws.stopServer();
      }
    });

    it("T2b. une Capture ne peut pas publier la télémétrie d'un autre device", async () => {
      const m = envMaster({ localDid: A });
      const s = m.__sessions[SID];
      let out = null, error = null;
      try {
        out = await m.ws.updateMemberTelemetry(s, B, snap());
      } catch (err) {
        error = String(err && err.message);
      }
      ok(error || (out && out.ok === false), "publier pour un autre device doit être refusé");
      if (error) ok(error.indexOf("not_self") >= 0, "rejet attendu not_self, obtenu " + error);
      if (out) eq(out.ok, false, "la promesse doit résoudre avec ok=false");
      eq(m.MultiCamTelemetryStore.get(SID, B), null, "rien ne doit être stocké pour B");
    });
  });

  /* ==================================================================
   * T3 / T4 / T11 — MODÈLE : filtrage strict, dernier état, pas d'historique
   * ================================================================== */

  describe("J09-06 télémétrie — modèle mémoire de la mosaïque", () => {
    it("T3. télémétrie d'un device HORS TAKE -> mosaïque intacte + comptée", () => {
      const env = envLive(parts(A));
      const before = env.model.view();
      const accepted = env.model.syncTelemetry({
        C: { batteryLevel: 88, freeBytes: 5e11, updatedAtMs: 1700000000000 }
      });
      const after = env.model.view();
      eq(after.slots.length, 1, "aucune vignette ajoutée");
      eq(after.slots[0].telemetry, null, "le slot du Take ne doit pas être alimenté");
      eq(after.stats.telemetryIgnored >= 1, true, "la télémétrie hors Take doit être COMPTÉE");
      eq(accepted, false);
    });

    it("T4. deux snapshots successifs -> le 2e remplace, AUCUN historique", () => {
      const env = envLive(parts(A));
      env.store.set(SID, A, snap({ batteryLevel: 62, updatedAtMs: 1000 }), 1000);
      env.store.set(SID, A, snap({ batteryLevel: 58, updatedAtMs: 2000 }), 2000);
      env.model.syncTelemetry(env.store.all(SID));
      const s = slotOf(env.model, A);
      eq(s.telemetry.batteryLevel, 58, "le dernier snapshot doit gagner");
      eq(s.telemetryAt, 2000);
      const all = env.store.all(SID);
      eq(Object.keys(all).length, 1, "une seule entrée par device");
      ok(env.store.history === undefined, "aucun historique ne doit exister");
    });

    it("T4b. snapshot plus ancien que le précédent -> ignoré (pas de recul)", () => {
      const env = envLive(parts(A));
      env.store.set(SID, A, snap({ batteryLevel: 50, updatedAtMs: 5000 }), 5000);
      env.store.set(SID, A, snap({ batteryLevel: 10, updatedAtMs: 4000 }), 4000);
      env.model.syncTelemetry(env.store.all(SID));
      eq(slotOf(env.model, A).telemetry.batteryLevel, 50, "un snapshot plus ancien ne doit pas remplacer");
    });

    it("T11. deux Captures -> valeurs indépendantes, aucun mélange", () => {
      const env = envLive(parts(A, B));
      env.store.set(SID, A, snap({ batteryLevel: 12, freeBytes: 100 }), 1000);
      env.store.set(SID, B, snap({ batteryLevel: 91, freeBytes: 9e10 }), 1000);
      env.model.syncTelemetry(env.store.all(SID));
      const sa = slotOf(env.model, A), sb = slotOf(env.model, B);
      eq(sa.telemetry.batteryLevel, 12);
      eq(sb.telemetry.batteryLevel, 91);
      eq(sa.telemetry.freeBytes, 100);
      eq(sb.telemetry.freeBytes, 9e10);
    });
  });

  /* ==================================================================
   * T5 / T6 / T9 — AFFICHAGE : aucune valeur inventée
   * ================================================================== */

  describe("J09-06 télémétrie — affichage honnête des unknowns", () => {
    it("T5. batterie inconnue -> état NEUTRE, jamais 0 %", () => {
      const env = envLive(parts(A));
      env.store.set(SID, A, snap({ batteryLevel: null }), 1000);
      env.model.syncTelemetry(env.store.all(SID));
      const t = env.screen.tiles(env.model.view())[0];
      const b = findIcon(t.icons, "battery");
      ok(b, "pas d'icône batterie");
      eq(b.known, false);
      eq(b.value, null, "aucune valeur inventée");
      eq(String(b.text).indexOf("0"), -1, "0 % serait une valeur inventée : " + b.text);
      eq(String(b.text).indexOf("%"), -1, "pas de pourcentage si la donnée est absente");
    });

    it("T6. stockage inconnu -> état NEUTRE, jamais 0 octet", () => {
      const env = envLive(parts(A));
      env.store.set(SID, A, snap({ freeBytes: null }), 1000);
      env.model.syncTelemetry(env.store.all(SID));
      const t = env.screen.tiles(env.model.view())[0];
      const s = findIcon(t.icons, "storage");
      ok(s, "pas d'icône stockage");
      eq(s.known, false);
      eq(s.value, null);
      no(/Mo|Go|o\b/.test(String(s.text)), "aucune unité affichée sans donnée : " + s.text);
    });

    it("T6b. batterie et stockage connus -> valeur ET état de vigilance", () => {
      const env = envLive(parts(A));
      env.store.set(SID, A, snap({ batteryLevel: 23, freeBytes: 820000000 }), 1000);
      env.model.syncTelemetry(env.store.all(SID));
      const t = env.screen.tiles(env.model.view())[0];
      const b = findIcon(t.icons, "battery");
      const s = findIcon(t.icons, "storage");
      eq(b.known, true);
      eq(String(b.text).indexOf("23") >= 0, true, "le % doit être affiché : " + b.text);
      eq(b.level, "warn", "23 % est un seuil d'avertissement");
      eq(s.level, "warn", "< 1 Go est un seuil d'avertissement (maquette)");
      ok(t.incidents.length >= 2, "les incidents doivent être listés pour la vue détaillée");
    });

    it("T9. télémétrie périmée -> stale SIGNALÉ mais PAS de DECONNECTED", () => {
      const env = envLive(parts(A));
      /* Snapshot vieux de 60 s, WS pourtant vivant (liveness separately). */
      env.store.set(SID, A, snap(), Date.now() - 60000);
      env.model.syncTelemetry(env.store.all(SID));
      env.model.setLiveness(A, true);
      const t = env.screen.tiles(env.model.view(), { nowMs: Date.now() })[0];
      eq(t.state, "REC", "le WS est vivant : l'état ne peut pas être DECONNECTED");
      eq(t.telemetryStale, true, "la donnée périmée doit être signalée");
      ok(t.incidents.some(function (i) { return i.key === "telemetryStale"; }), "incident de fraîcheur attendu");
    });
  });

  /* ==================================================================
   * T7 / T8 / T12 — DÉCONNEXION, RECONNEXION, REC -> STOPPED
   * ================================================================== */

  describe("J09-06 télémétrie — déconnexion / reconnexion / arrêt", () => {
    it("T7. Capture déconnectée -> télémétrie conservée, vignette DÉCONNECTÉE", () => {
      const env = envLive(parts(A));
      env.store.set(SID, A, snap({ batteryLevel: 40 }), 1000);
      env.model.syncTelemetry(env.store.all(SID));
      const idx = env.model.view().order.indexOf(A);
      env.model.setLiveness(A, false);
      const v = env.model.view();
      eq(v.order.indexOf(A), idx, "la vignette ne doit pas bouger");
      const s = slotOf(env.model, A);
      eq(s.telemetry.batteryLevel, 40, "la dernière télémétrie doit être conservée");
      eq(s.connected, false);
      eq(s.displayState, "DECONNECTED");
      const t = env.screen.tiles(v, { nowMs: Date.now() })[0];
      eq(t.state, "DECONNECTED");
      eq(t.icons.length > 0, true, "la vignette garde ses valeurs connues");
    });

    it("T8. reconnexion -> MÊME slot, télémétrie fraîche qui remplace", () => {
      const env = envLive(parts(A));
      env.store.set(SID, A, snap({ batteryLevel: 40 }), 1000);
      env.model.syncTelemetry(env.store.all(SID));
      env.model.setLiveness(A, false);
      const idx = env.model.view().order.indexOf(A);
      env.model.setLiveness(A, true);
      env.store.set(SID, A, snap({ batteryLevel: 39 }), 90000);
      env.model.syncTelemetry(env.store.all(SID));
      const v = env.model.view();
      eq(v.order.indexOf(A), idx, "même slot, même position");
      eq(v.slots.length, 1);
      eq(v.slots[0].telemetry.batteryLevel, 39, "la valeur fraîche remplace l'ancienne");
      eq(env.screen.tiles(v, { nowMs: Date.now() })[0].state, "REC");
    });

    it("T12. REC -> STOPPED -> état de vignette cohérent avec le modèle START", () => {
      const env = envLive(parts(A));
      eq(env.screen.tiles(env.model.view())[0].state, "REC");
      env.model.setStatus(A, "STOPPED");
      const t = env.screen.tiles(env.model.view())[0];
      eq(t.state, "STOPPED");
      eq(t.stateLabel, "STOPPED");
      no(t.icons.some(function (i) { return i.key === "recorder"; }), "STOPPED ne doit plus afficher REC");
    });

    it("T12b. STOPPED + lien perdu -> DÉCONNECTÉ prime, l'enregistreur est mémorisé", () => {
      const env = envLive(parts(A));
      env.model.setStatus(A, "STOPPED");
      env.model.setLiveness(A, false);
      const v = env.model.view();
      eq(v.slots[0].displayState, "DECONNECTED");
      eq(v.slots[0].status, "STOPPED", "l'état recorder reste disponible pour le détail");
    });
  });

  /* ==================================================================
   * T10 — MASTER + CAPTURE LOCAL, SANS BOUCLE RÉSEAU
   * ================================================================== */

  describe("J09-06 télémétrie — device local", () => {
    it("T10. Master+Capture local -> télémétrie locale visible sans loopback", () => {
      const env = envLive(parts(LOCAL, A), { localDid: LOCAL });
      /* Le service local publie SA propre télémétrie (chemin auto-déclaré). */
      env.store.set(SID, LOCAL, snap({ batteryLevel: 100, recording: true }), 5000, { local: true });
      env.model.syncTelemetry(env.store.all(SID));
      const v = env.model.view();
      const local = slotOf(env.model, LOCAL);
      eq(local.isLocal, true);
      eq(local.telemetry.batteryLevel, 100, "la télémétrie locale doit être lue localement");
      const tiles = env.screen.tiles(v, { nowMs: Date.now() });
      const tl = tiles.filter(function (t) { return t.isLocal; })[0];
      eq(findIcon(tl.icons, "battery").value, 100);
      /* Et AUCUN message réseau n'a été nécessaire : le store a été rempli par
       * le chemin local, pas par un `telemetry_update` d'un pair. */
      eq(env.store.all(SID)[LOCAL].local, true, "la source locale est marquée");
    });
  });

  /* ==================================================================
   * T13 / T14 — CADENCE : périodique + au changement, sans file
   * ================================================================== */

  describe("J09-06 télémétrie — service de collecte (côté Capture)", () => {
    /* Environnement du service : natives factices, horloge virtuelle. */
    function envService(opts) {
      const o = opts || {};
      const e = createEnv({ fakeClock: true });
      const published = [];
      e.battery = { level: 0.62, isPlugged: true };
      e.space = { availableBytes: 8791234567, totalBytes: 128849018880 };
      e.net = "wifi";
      e.recording = true;
      e.batterySubs = [];
      e.spaceCalls = 0;
      e.netCalls = 0;
      e.MultiCamDevice = {
        batteryStatus(cb) {
          e.batterySubs.push(cb);
          if (o.noBattery) return;
          cb({ level: e.battery.level, isPlugged: e.battery.isPlugged });
        }
      };
      e.MultiCamNative = {
        freeSpace() {
          e.spaceCalls++;
          if (o.failSpace) return Promise.reject(new Error("statfs_failed"));
          return Promise.resolve(Object.assign({}, e.space));
        },
        networkType() { e.netCalls++; return Promise.resolve(o.failNet ? null : e.net); }
      };
      e.MultiCamCameraRecord = { isRecording() { return e.recording; }, view() { return { recording: e.recording }; } };
      e.MultiCamCaptureCapabilities = {
        capabilitiesFor() { return Promise.resolve({ unknown: false, audioMic: true, gpsFeature: false, cameras: { rear: ["HD", "FHD"], front: ["HD"] } }); }
      };
      e.session = {
        sessionId: SID, state: "open",
        members: [{ deviceId: A, deviceName: "Cam A", enabledSkills: ["capture"], sessionRoles: ["capture"], telemetry: null }]
      };
      e.MultiCamConfig = { get() { return { deviceId: A, deviceName: "Cam A" }; } };
      e.MultiCamStorage = {
        defaultPath() { return "file:///storage/emulated/0/Android/data/fr.emmanuel.multicam/files/"; },
        systemPath(u) { return String(u).replace("file://", "").replace(/\/$/, ""); }
      };
      e.wsUpdate = function (session, did, telemetry) {
        published.push({ sessionId: session.sessionId, deviceId: did, telemetry: JSON.parse(JSON.stringify(telemetry)) });
        if (o.failPublish && published.length <= (o.failPublishCount || 1)) {
          return Promise.reject(new Error("ws_closed"));
        }
        return Promise.resolve(session);
      };
      e.MultiCamSessionWs = {
        updateMemberTelemetry(session, did, telemetry) { return e.wsUpdate(session, did, telemetry); }
      };
      loadAll(e, ["state/telemetry-service.js"]);
      e.svc = e.MultiCamTelemetryService;
      e.published = published;
      return e;
    }

    it("T13. cadence 5 s -> un snapshot par période, latest-wins, SANS file", async () => {
      const e = envService();
      e.svc.bind({ deviceId: A, deviceName: "Cam A" });
      e.svc.start(e.session);
      await e.clock.advance(10);
      /* Free space + net type ne sont mesurés qu'une fois puis mis en cache :
       * aucun martèlement natif à chaque snapshot. */
      eq(e.spaceCalls, 1, "espace libre : une seule mesure pour 2 snapshots");
      eq(e.netCalls, 1, "type réseau : une seule mesure pour 2 snapshots");
      await e.clock.advance(15000);
      eq(e.published.length >= 3, true, "plusieurs snapshots : " + e.published.length);
      const gaps = e.published.slice(1).map(function (p, i) {
        return (p.telemetry.atMs || 0) - (e.published[i].telemetry.atMs || 0);
      });
      gaps.forEach(function (g) { ok(g >= 4000, "cadence attendue ~5 s, écart mesuré " + g + " ms"); });
      const v = e.svc.view();
      eq(v.inFlight, 0, "RIEN ne doit rester en file");
      eq(v.pending, false, "aucun envoi en attente après la cadence");
    });

    it("T13b. un publish en échec ne bloque pas la cadence suivante", async () => {
      const e = envService({ failPublish: true, failPublishCount: 1 });
      e.svc.bind({ deviceId: A, deviceName: "Cam A" });
      e.svc.start(e.session);
      await e.clock.advance(10);
      eq(e.published.length, 1);
      eq(e.svc.view().errors >= 1, true, "l'échec doit être compté et journalisé");
      await e.clock.advance(6000);
      eq(e.published.length, 2, "la cadence doit repartir malgré l'échec");
      eq(e.svc.view().inFlight, 0, "pas de promise abandonnée");
    });

    it("T14. seuil de batterie franchi -> publication IMMÉDIATE", async () => {
      const e = envService();
      e.svc.bind({ deviceId: A, deviceName: "Cam A" });
      e.svc.start(e.session);
      await e.clock.advance(10);
      const first = e.published.length;
      /* ≤ 25 % est le seuil d'avertissement (`session-model.js`,aligné sur la
       * maquette ui/08 qui montre 23 % en ambre) : le franchissement doit être
       * visible tout de suite, pas dans 5 s. */
      e.battery.level = 0.20;
      e.batterySubs.forEach(function (cb) { cb({ level: 0.20, isPlugged: true }); });
      await flush();
      eq(e.published.length, first + 1, "un franchissement de seuil doit être publié tout de suite");
      eq(e.published[e.published.length - 1].telemetry.batteryLevel, 20);
    });

    it("T14c. un simple pas de 1 % n'AJOUTE PAS de message (anti-bruit)", async () => {
      const e = envService();
      e.svc.bind({ deviceId: A, deviceName: "Cam A" });
      e.svc.start(e.session);
      await e.clock.advance(10);
      const first = e.published.length;
      /* 62 % -> 63 % : la cadence 5 s suffit. Publier à chaque point de
       * pourcentage remplirait le réseau sans rien apprendre à l'opérateur. */
      e.battery.level = 0.63;
      e.batterySubs.forEach(function (cb) { cb({ level: 0.63, isPlugged: true }); });
      await flush();
      eq(e.published.length, first, "aucun envoi immédiat sur un simple pas de 1 %");
      await e.clock.advance(5000);
      eq(e.published.length, first + 1, "la cadence prend le relais");
      eq(e.published[e.published.length - 1].telemetry.batteryLevel, 63, "avec la valeur fraîche");
    });

    it("T14b. mise en charge / arrêt du REC -> publication immédiate", async () => {
      const e = envService();
      e.svc.bind({ deviceId: A, deviceName: "Cam A" });
      e.svc.start(e.session);
      await e.clock.advance(10);
      let n = e.published.length;
      e.battery.isPlugged = false;
      e.batterySubs.forEach(function (cb) { cb({ level: 0.62, isPlugged: false }); });
      await flush();
      eq(e.published.length, n + 1, "le basculement charge doit être publié");
      eq(e.published[e.published.length - 1].telemetry.batteryCharging, false);

      n = e.published.length;
      e.recording = false;
      e.svc.collectNow();
      await flush();
      eq(e.published.length, n + 1, "l'arrêt du REC doit être publié immédiatement");
      eq(e.published[e.published.length - 1].telemetry.recording, false);
    });

    it("T18. contrat : les champs inconnus/bidons sont ASSAINIS, jamais transmis", async () => {
      const e = envService();
      e.svc.bind({ deviceId: A, deviceName: "Cam A" });
      e.svc.start(e.session);
      await e.clock.advance(10);
      /* Une donnée qui n'est pas mesurable doit disparaître, pas devenir 0. */
      const e2 = envService({ failSpace: true, failNet: true });
      e2.svc.bind({ deviceId: A, deviceName: "Cam A" });
      e2.svc.start(e2.session);
      await e2.clock.advance(10);
      const t = e2.published[0].telemetry;
      eq(t.freeBytes === undefined || t.freeBytes === null, true, "espace libre indisponible => absent");
      eq(t.netType === undefined || t.netType === null, true, "réseau indisponible => absent");
      eq(t.batteryLevel, 62, "la batterie, elle, est mesurée");
    });

    /* RÉGRESSION PHYSIQUE : sur le device de test, `batterystatus` a renvoyé 100
     * (pourcentage) au lieu de 1 (fraction). La conversion a produit 10000, le
     * contrat l'a rejetée, et la batterie a DISPARU de la mosaïque — sans
     * erreur et sans faux 0 %. Un test écrit uniquement en fraction (0.62) ne
     * l'aurait jamais vu : c'est le smoke physique qui l'a trouvé. */
    it("T19. batterie en FRACTION ou en POURCENTAGE -> la même valeur, jamais rejetée", async () => {
      const e = envService();
      e.svc.bind({ deviceId: A, deviceName: "Cam A" });
      e.svc.start(e.session);
      await e.clock.advance(10);
      eq(e.published[0].telemetry.batteryLevel, 62, "0.62 (fraction) -> 62 %");

      /* Même batterie pleine, mais exprimée en pourcentage. */
      const e2 = envService();
      e2.battery.level = 100;
      e2.svc.bind({ deviceId: A, deviceName: "Cam A" });
      e2.svc.start(e2.session);
      await e2.clock.advance(10);
      eq(e2.published[0].telemetry.batteryLevel, 100, "100 (pourcentage) -> 100 %, PAS rejeté");

      const e3 = envService();
      e3.battery.level = 1;
      e3.svc.bind({ deviceId: A, deviceName: "Cam A" });
      e3.svc.start(e3.session);
      await e3.clock.advance(10);
      eq(e3.published[0].telemetry.batteryLevel, 100, "1 (fraction pleine) -> 100 %");

      /* Hors bornes : la mesure n'est pas interprétable, elle ne doit donc PAS
       * devenir « 100 % » — ce serait inventer une batterie pleine. */
      const e4 = envService();
      e4.battery.level = 4200;
      e4.svc.bind({ deviceId: A, deviceName: "Cam A" });
      e4.svc.start(e4.session);
      await e4.clock.advance(10);
      eq(e4.published[0].telemetry.batteryLevel === undefined
        || e4.published[0].telemetry.batteryLevel === null, true,
        "une valeur hors bornes est NON MESURABLE, pas 100 %");
    });

    it("T18b. le modèle refuse une télémétrie d'un device qui n'est pas membre", async () => {
      const e = createEnv();
      loadAll(e, ["state/session-model.js"]);
      const sm = e.MultiCamSessionModel;
      const s = forceSessionId(sm.createSession("S", { deviceId: LOCAL, deviceName: "Regie", endpoint: "10.0.0.1:45100" }), SID);
      const withM = sm.addMember(s, { deviceId: A, deviceName: "Cam A", enabledSkills: ["capture"] }, ["capture"], LOCAL).session;
      const r = sm.updateMemberTelemetry(withM, A, snap({ batteryLevel: "plein", freeBytes: NaN, netType: 42 }), A);
      eq(r.ok, true, "la télémétrie d'un membre doit rester acceptable");
      const mem = r.session.members.filter(function (x) { return x.deviceId === A; })[0];
      eq(mem.telemetry.batteryLevel, null, "un niveau non numérique ne peut pas passer");
      eq(mem.telemetry.freeBytes, null, "NaN ne peut pas passer");
      eq(mem.telemetry.netType, null, "un type réseau non textuel ne peut pas passer");
      eq(mem.telemetry.recording, true, "les champs valides passent");
      eq(mem.telemetry.batteryLevel === 0, false, "jamais 0 par défaut");
    });
  });

  /* ==================================================================
   * T15 / T16 / T17 — VUE DÉTAILLÉE
   * ================================================================== */

  describe("J09-06 télémétrie — vue détaillée d'une Capture", () => {
    it("T15. le détail est cohérent avec la vignette", () => {
      const env = envLive(parts(A));
      env.store.set(SID, A, snap({ batteryLevel: 23, batteryCharging: false, freeBytes: 820000000, netType: "ethernet", recording: true }), 1000);
      env.model.syncTelemetry(env.store.all(SID));
      env.model.setStatus(A, "REC");
      const v = env.model.view();
      const now = 1500;
      const tile = env.screen.tiles(v, { nowMs: now })[0];
      /* J09-09b : le plan du Take pour A (audio demandé, GPS off) — la même
       * source que l'écran 05 et l'ARM. */
      const takeOfA = {
        takeNumber: 7, captures: [A], storages: [],
        settings: {
          video: { resolution: "HD", quality: "HIGH", camera: "REAR", orientation: "AUTO" },
          audio: true, gpsProfile: "OFF",
          countdownSeconds: 0, transferAuto: false, deleteLocalAfterVerifiedReplication: false
        },
        captureOverrides: {}
      };
      const d = env.detail.detailOf(v.slots[0], { nowMs: now, take: takeOfA });
      eq(d.deviceId, A);
      eq(d.deviceName, tile.deviceName, "le détail et la vignette nomment la même Capture");
      eq(d.state, tile.state, "même état de connexion");
      eq(d.recorder, "REC");
      eq(d.connected, true);
      eq(d.battery.known, true);
      eq(d.battery.value, 23);
      eq(d.battery.charging, false);
      eq(d.storage.known, true);
      eq(d.storage.value, 820000000);
      eq(d.network.label, "Ethernet");
      eq(d.telemetryAgeMs, 500, "l'âge du snapshot est calculé, pas supposé");
      ok(d.functions.video.active, "la vidéo doit être active quand le plan du Take le dit");
      eq(d.functions.video.status, "active");
      ok(d.functions.audio.active, "audio demandé ET micro présent → actif");
      eq(d.functions.audio.status, "active");
      eq(d.functions.gps.active, false, "GPS absent = non actif");
      eq(d.functions.gps.status, "off", "la forme OFF du plan rend le GPS 'off', pas actif");
      ok(d.capMeta.known, "l'identité des capacités reste mesurée");
      eq(d.actions.length, 0, "AUCUNE action de commande en J09-06");
    });

    it("T16. détail d'une Capture DÉCONNECTÉE -> dernière image + dernière télémétrie", async () => {
      const env = envLive(parts(A));
      env.store.set(SID, A, snap({ batteryLevel: 40, freeBytes: 5e10 }), 1000);
      env.model.syncTelemetry(env.store.all(SID));
      env.model.onPreviewFrame({
        sessionId: SID, takeNumber: 7, deviceId: A, seq: 12,
        capturedAt: 900, receivedAt: 950, jpegBase64: "SEVMTA", mime: "image/jpeg"
      });
      env.model.setLiveness(A, false);
      /* 59 050 ms après l'ingestion. L'âge vient de l'horloge du MASTER (le
       * modèle estampille `lastFrameAt` à la réception) : les horloges des
       * Captures ne sont pas synchronisées avant J09-10, donc un âge calculé sur
       * `capturedAt` serait FAUX — et le test le prouve en donnant des
       * `capturedAt`/`receivedAt` (900/950) sans rapport avec l'horloge. */
      await env.e.clock.advance(59050);
      const v = env.model.view();
      const now = env.e.clock.now();
      const d = env.detail.detailOf(v.slots[0], { nowMs: now });
      eq(d.connected, false);
      eq(d.state, "DECONNECTED");
      eq(d.recorder, "REC", "l'enregistreur est MÉMORISÉ, pas réinventé");
      eq(d.preview.seq, 12, "la dernière image est conservée");
      eq(d.preview.frozen, true, "elle doit être signalée comme figée");
      eq(d.preview.ageMs, 59050, "âge mesuré sur l'horloge du Master, pas sur celle du device");
      eq(d.battery.value, 40, "la dernière télémétrie connue reste affichée");
      eq(d.telemetryStale, true, "et elle est signalée comme ancienne");
      ok(d.incidents.some(function (i) { return i.key === "disconnected"; }), "incident de déconnexion attendu");
    });

    it("T17. le détail n'expose AUCUNE commande (pas de J10)", () => {
      const env = envLive(parts(A));
      env.store.set(SID, A, snap(), 1000);
      env.model.syncTelemetry(env.store.all(SID));
      const d = env.detail.detailOf(env.model.view().slots[0], { nowMs: 1200 });
      eq(d.actions.length, 0);
      /* Le contrat du detailView ne doit même pas contenir de clé d'action. */
      const keys = Object.keys(d);
      keys.forEach(function (k) {
        no(/^(stop|remote|command|control)$/i.test(k), "clé de commande interdite : " + k);
      });
      ok(keys.indexOf("preview") >= 0, "la preview courante doit être présente");
      ok(keys.indexOf("battery") >= 0);
      ok(keys.indexOf("storage") >= 0);
      ok(keys.indexOf("network") >= 0);
    });
  });

}
module.exports = { register };
