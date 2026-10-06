/* MultiCam — J09-D2 : le cycle de vie de la télémétrie appartient à la SESSION,
 * jamais à l'écran 05.
 *
 * DÉFAUT RELEVÉ EN CAMPAGNE (J09) : la télémétrie n'était active que si
 * l'opérateur ouvrait l'écran 05, parce que `ui/take.js` était le SEUL appelant
 * de `MultiCamTelemetryService.bind()` / `.start()` — le service vivait donc
 * au rythme d'une vue, pas au rythme de la session qu'il supervise.
 *
 * CES TESTS FIGENT :
 *
 *   D2.1a session ouverte + device membre au BOOT  -> le collecteur démarre
 *         SANS qu'aucun écran ne soit chargé (aucun module `ui/*` n'est
 *         présent dans l'environnement : la condition « sans écran 05 » est
 *         vérifiée par construction) ;
 *   D2.1b la session arrive APRÈS le boot (join)  -> il démarre pareillement,
 *         déclenché par le signal global de session ;
 *   D2.2  ouverture puis fermeture de l'écran 05  -> la télémétrie continue,
 *         même timer, même sessionId, aucun arrêt ;
 *   D2.3  ouvertures multiples + signaux multiples -> UN abonnement, UN timer
 *         de cadence, UNE publication par période (aucun double comptage), et
 *         UN abonnement batterie ;
 *   D2.4  fin de session                          -> collecteur arrêté, timer
 *         effacé, plus aucune publication ;
 *   D2.5  garantie structurelle                   -> `ui/take.js` n'appelle plus
 *         bind/start/stop du service (il ne fait que consommer) et
 *         `main.js:bootSession()` le branche au boot.
 *
 * Aucun module d'interface n'est chargé : la preuve « sans écran 05 » est
 * comportementale (D2.1) et le verrou anti-régression est structurel (D2.5).
 */

"use strict";

const fs = require("fs");
const path = require("path");

function register(h) {
  const { describe, it, createEnv, loadAll, flush } = h;

  const SID = "SIDTELEM2";
  const SID2 = "SIDOTHER2";
  const A = "aaaaaaaa-0000-0000-0000-00000000000a";   /* Capture A : ce device */
  const B = "bbbbbbbb-0000-0000-0000-00000000000b";   /* Master B : l'invitant */

  /* ---------- micro-assertions ---------- */

  function eq(actual, want, msg) {
    if (actual !== want) {
      throw new Error((msg ? msg + " — " : "") + "attendu " + want + ", obtenu " + actual);
    }
  }
  function yes(v, msg) { eq(v, true, msg); }
  function no(v, msg) { eq(v, false, msg); }
  function ok(v, msg) { yes(!!v, msg); }

  function forceSessionId(session, sessionId) {
    session.sessionId = sessionId;
    return session;
  }

  function memberOf(store, sid, did) {
    const s = store.__cache[sid];
    return (s && (s.members || []).filter((m) => m.deviceId === did)[0]) || null;
  }

  /* ---------- environnement « Capture A » SANS AUCUN ÉCRAN ----------
   *
   * Modèle + store + transport WS RÉELS (le signal `onChanged` que le service
   * consomme doit être celui du vrai transport, sinon D2.1/D2.4 ne prouveraient
   * rien), natives factices, horloge virtuelle. Deux espions sont posés AVANT
   * le premier `bind()` : ils mesurent exactement les deux ressources dont
   * l'unicité est exigée — l'abonnement aux sessions (D2.3) et le timer de
   * cadence. */
  function envCap(opts) {
    const o = opts || {};
    const e = createEnv({ fakeClock: true });
    e.batterySubs = [];
    e.recording = false;
    e.MultiCamNative = {
      ipv4: () => Promise.resolve("10.0.0.5"),
      freeSpace: () => Promise.resolve({ availableBytes: 8791234567, totalBytes: 128849018880 }),
      networkType: () => Promise.resolve("wifi")
    };
    e.MultiCamDevice = {
      batteryStatus(cb) {
        e.batterySubs.push(cb);
        if (!o.noBattery) cb({ level: 0.62, isPlugged: false });
      }
    };
    e.MultiCamCameraRecord = { isRecording() { return e.recording; } };
    e.MultiCamCaptureCapabilities = {
      capabilitiesFor() { return Promise.resolve({ audioMic: true, gpsFeature: false }); }
    };
    e.MultiCamStorage = {
      defaultPath() { return "file:///storage/emulated/0/Android/data/fr.emmanuel.multicam/files/"; },
      systemPath(u) { return String(u).replace("file://", "").replace(/\/$/, ""); }
    };
    e.MultiCamConfig = {
      get() { return { deviceId: A, deviceName: "Cam A" }; },
      load() { return Promise.resolve({ deviceId: A, deviceName: "Cam A" }); }
    };

    /* Espion d'abonnement : le service doit s'abonner UNE fois. */
    const origOnChanged = function (fn) {
      return e.MultiCamSessionWs.__realOnChanged(fn);
    };
    e.__hookCalls = [];

    loadAll(e, [
      "state/session-model.js",
      "state/session-store.js",
      "net/session-ws.js",
      "state/telemetry-service.js"
    ]);

    e.MultiCamSessionWs.__realOnChanged = e.MultiCamSessionWs.onChanged;
    e.MultiCamSessionWs.onChanged = function (fn) {
      e.__hookCalls.push(fn);
      return origOnChanged(fn);
    };

    /* Espion de timer : la cadence du service est de 5 000 ms — aucun autre
     * module de cet environnement ne crée d'intervalle (le serveur WS n'est
     * pas démarré). */
    e.__intervals = [];
    const realSetInterval = e.setInterval;
    e.setInterval = function (fn, ms) {
      e.__intervals.push(ms);
      return realSetInterval(fn, ms);
    };

    e.store = e.MultiCamSessionStore;
    e.__cache = {};
    const realSave = e.store.save;
    e.store.save = function (s) {
      e.__cache[s.sessionId] = s;
      return realSave.call(e.store, s);
    };
    e.store.__cache = e.__cache;

    e.ws = e.MultiCamSessionWs;
    e.ws.bind({ deviceId: A, deviceName: "Cam A" });   /* main.js : session d'abord */
    e.svc = e.MultiCamTelemetryService;
    return e;
  }

  /* Session ouverte dont ce device (A) est MEMBRE — le chemin réel du modèle,
   * pas un objet fabriqué : c'est le même `addMember` que l'écran 03. */
  async function seedOpenSession(e, opts) {
    const o = opts || {};
    const sm = e.MultiCamSessionModel;
    let s = forceSessionId(
      sm.createSession(o.name || "Studio", { deviceId: B, deviceName: "Regie", endpoint: "10.0.0.1:45100" }),
      o.sid || SID
    );
    if (o.memberA !== false) {
      s = sm.addMember(s, {
        deviceId: A, deviceName: "Cam A", enabledSkills: ["capture"]
      }, ["capture"], B).session;
    }
    await e.store.save(s);
    return s;
  }

  /* Ce que fait l'écran 05 quand il s'ouvre : demander une publication
   * fraîche. C'est le SEUL appel de télémétrie qui lui reste (cf. D2.5). */
  function screenShows(e) {
    e.svc.collectNow();
  }

  /* ==================================================================
   * D2.1 — démarrer / rejoindre une session SANS ouvrir l'écran 05
   * ================================================================== */

  describe("J09-D2 — télémétrie hors écran 05", () => {
    it("D2.1a. session déjà ouverte au boot → le collecteur démarre sans aucun écran", async () => {
      const e = envCap();
      /* Session ouverte et présente au démarrage (cas d'un device redémarré
       * en pleine session) — toujours AUCUN module `ui/*` chargé. */
      await seedOpenSession(e);

      /* L'appel que fait main.js:bootSession(). Aucun écran n'est ouvert. */
      e.svc.bind({ deviceId: A, deviceName: "Cam A" });
      await flush();

      const v = e.svc.view();
      eq(v.running, true, "le service doit tourner dès le boot, sans écran 05");
      eq(v.sessionId, SID, "sur LA session ouverte dont ce device est membre");
      ok(e.logText().includes("TELEMETRY_COLLECTOR_START"), "démarrage journalisé");
      ok(e.logText().includes("TELEMETRY_LIFECYCLE_HOOK source=ws.onChanged"),
        "abonnement au cycle de vie de session posé au boot");

      /* Première publication immédiate (le Master ne doit pas attendre 5 s). */
      await flush();
      const mem = memberOf(e.store, SID, A);
      ok(mem && mem.telemetry, "la télémétrie est publiée sans avoir ouvert l'écran 05");
      eq(mem.telemetry.batteryLevel, 62, "valeur mesurée par le service");

      /* La collecte ÉVOLUE ensuite, seule, à la cadence. */
      const before = e.svc.view().stats.publishes;
      await e.clock.advance(5000);
      eq(e.svc.view().stats.publishes, before + 1, "cadence 5 s entretenue sans écran");
    });

    it("D2.1b. session rejointe APRÈS le boot → le signal de session démarre le service", async () => {
      const e = envCap();
      e.svc.bind({ deviceId: A, deviceName: "Cam A" });
      await flush();
      no(e.svc.view().running, "aucune session → rien à superviser");

      /* La session arrive ensuite : le transport émet son signal global
       * `onChanged` (création, acceptation d'invitation, membres, fermeture —
       * session-ws.js). Ici on passe par une opération WS RÉELLE, qui produit
       * exactement ce signal. */
      await seedOpenSession(e);
      const s = await e.store.get(SID);
      await e.ws.renameSession(s, "Studio rebaptisé");
      await flush();

      const v = e.svc.view();
      eq(v.running, true, "le service suit la session rejoindre, sans écran 05");
      eq(v.sessionId, SID);
      ok(e.logText().includes("TELEMETRY_RECONCILE reason=session_changed action=start"),
        "démarrage déclenché par le signal de session");
      await flush();
      ok(memberOf(e.store, SID, A).telemetry, "première publication effectuée");
    });

    /* ==================================================================
     * D2.2 — ouvrir puis quitter l'écran 05
     * ================================================================== */

    it("D2.2. ouverture puis fermeture de l'écran 05 : la télémétrie continue", async () => {
      const e = envCap();
      await seedOpenSession(e);
      e.svc.bind({ deviceId: A, deviceName: "Cam A" });
      await flush();
      ok(e.svc.view().running);
      const timer = e.svc._state.timer;

      /* Ouverture de l'écran 05 : le seul appel qu'il lui reste. */
      screenShows(e);
      await flush();
      const pubs = e.svc.view().stats.publishes;

      /* L'utilisateur quitte l'écran ; pendant ce temps la session mute
       * (ce qui arrive pendant une navigation) — cela ne doit rien arrêter. */
      const s = await e.store.get(SID);
      await e.ws.renameSession(s, "Studio (navigation)");
      await flush();
      await e.clock.advance(15000);

      const v = e.svc.view();
      eq(v.running, true, "le service ne s'arrête jamais à la navigation");
      eq(v.sessionId, SID, "toujours la même session");
      eq(e.svc._state.timer, timer, "le timer n'a pas été recréé");
      eq(v.stats.publishes > pubs, true, "les publications continuent après l'écran");
      no(e.logText().includes("TELEMETRY_COLLECTOR_STOP"), "aucun arrêt pendant la navigation");
    });

    /* ==================================================================
     * D2.3 — ouvrir/fermer plusieurs fois : ni double timer, ni double
     * listener, ni double émission/comptage
     * ================================================================== */

    it("D2.3. ouvertures multiples : UN abonnement, UN timer, UNE publication par période", async () => {
      const e = envCap();
      await seedOpenSession(e);
      e.svc.bind({ deviceId: A, deviceName: "Cam A" });
      await flush();
      const timer = e.svc._state.timer;

      /* Quatre cycles « ouverture de l'écran 05 » : chaque ouverture demande un
       * rafraîchissement, chaque navigation produit des mutations de session,
       * et on ré-appelle `bind()` (le brancheur boot comme un éventuel second
       * branchement) — rien de tout cela ne doit dupliquer quoi que ce soit. */
      for (let i = 0; i < 4; i++) {
        e.svc.bind({ deviceId: A, deviceName: "Cam A" });
        screenShows(e);
        const s = await e.store.get(SID);
        await e.ws.renameSession(s, "Studio " + i);
        await flush();
      }

      eq(e.__hookCalls.length, 1, "UN SEUL abonnement aux changements de session");
      eq(e.batterySubs.length, 1, "UN SEUL abonnement batterie");
      eq(e.__intervals.filter((ms) => ms === 5000).length, 1,
        "UN SEUL timer de cadence 5 s (aucun timer recréé)");
      eq(e.svc._state.timer, timer, "le timer d'origine est toujours celui en service");
      eq(e.svc.view().running, true);

      /* Le comptage : une — et une seule — collecte par période. */
      await flush();
      eq(e.svc.view().inFlight, 0, "aucune publication en vol avant mesure");
      const c0 = e.svc.view().stats.collects;
      const p0 = e.svc.view().stats.publishes;
      await e.clock.advance(5000);
      eq(e.svc.view().stats.collects, c0 + 1, "UNE collecte par période, pas cinq");
      eq(e.svc.view().stats.publishes, p0 + 1, "UNE publication par période, pas cinq");
    });

    /* ==================================================================
     * D2.4 — fin de session
     * ================================================================== */

    it("D2.4. fin de session → collecteur arrêté, aucun timer ni émission résiduel", async () => {
      const e = envCap();
      await seedOpenSession(e);
      e.svc.bind({ deviceId: A, deviceName: "Cam A" });
      await flush();
      ok(e.svc.view().running, "le service tourne tant que la session est ouverte");

      /* « Terminer la session » (écran 03) : l'API WS réelle, qui émet le
       * signal global de session. */
      const s = await e.store.get(SID);
      await e.ws.closeSession(s);
      await flush();

      const v = e.svc.view();
      eq(v.running, false, "le service s'arrête à la fin de la session");
      eq(v.sessionId, "", "aucune session retenue");
      eq(e.svc._state.timer, null, "timer effacé — aucune fuite");
      ok(e.logText().includes("TELEMETRY_COLLECTOR_STOP"), "arrêt journalisé");

      const pubs = v.stats.publishes;
      await e.clock.advance(30000);
      eq(e.svc.view().stats.publishes, pubs, "aucune publication après la fin de session");
      eq(e.svc.view().running, false, "et le service ne repart pas tout seul");
    });

    /* ==================================================================
     * D2.5 — verrou structurel
     * ================================================================== */

    it("D2.5. l'écran 05 est consommateur ; le boot est le propriétaire", () => {
      const takeSrc = fs.readFileSync(path.join(h.WWW, "ui", "take.js"), "utf8");
      no(/svc\.(bind|start|stop)\s*\(/.test(takeSrc),
        "ui/take.js ne démarre ni n'arrête plus le service de télémétrie");
      no(/MultiCamTelemetryService\.(bind|start|stop)\s*\(/.test(takeSrc),
        "idem, appelé par son nom complet");
      ok(/svc\.collectNow\(/.test(takeSrc),
        "l'écran 05 garde bien son rôle de consommateur (collectNow)");

      const mainSrc = fs.readFileSync(path.join(h.WWW, "main.js"), "utf8");
      ok(/MultiCamTelemetryService\.bind\(/.test(mainSrc),
        "main.js branche le service au boot (bootSession)");
    });
  });
}

module.exports = { register };
