/* MultiCam — throttle du `sync_please` de `reSyncSession()`.
 *
 * BUG ANTÉRIEUR (J04/J07), pas une régression J09-02.
 *
 * Au boot, `main.js:bootSession()` parcourt TOUTES les sessions ouvertes dans un
 * `forEach` SYNCHRONE et appelle `reSyncSession(session)` pour chacune.
 * Or le garde anti-écho vit dans UN compteur global partagé
 * (`state.lastResyncMs`, session-ws.js:111) :
 *
 *     if (now - state.lastResyncMs < 1500) { return; }   /* throttlé *\/
 *
 * La première session passe ; les suivantes arrivent quelques millisecondes plus
 * tard et sont donc rejetées. Elles ne sont jamais rejouées (aucun timer de
 * retry), alors qu'aucune connexion n'a même été tentée pour elles.
 *
 * Conséquence observée sur device : sur 9 sessions ouvertes, une seule re-rejoint
 * automatiquement son Master au boot ; les 8 autres restent déconnectées alors que
 * leur endpoint Master est parfaitement valide.
 *
 * ATTENDU : le throttle est PAR SESSION. Une session A ne doit jamais empêcher B,
 * C, D de re-synchroniser ; les appels rapprochés de la MÊME session restent
 * throttlés (l'intention anti-écho est conservée).
 *
 * Couverture :
 *   T1.  même session 2× très vite   → 1 seul reSync
 *   T2.  2 sessions très vite        → les 2 partent
 *   T3.  3 sessions en boucle sync. → les 3 partent
 *   T4.  > 1500 ms, même session     → reSync de nouveau autorisé
 *   T4b. 1499 ms                     → toujours throttlé (délai inchangé)
 *   T5.  sessionId absent/invalide   → sûr, ne pollue pas les sessions réelles
 *   T5b. masters vide                → aucun dial, aucun envoi
 */

"use strict";

function register(h) {
  const { describe, it, createEnv, load, flush } = h;

  const T0 = 1700000000000;   /* horloge figée : aucun appel parasite ne passe */
  const MASTER = "10.0.0.1:45000";

  /* ---------- horloge contrôlée ---------- */
  /* `nowMs()` résout `Date` dans le contexte `vm` à CHAQUE appel : on peut donc
   * substituer `env.Date` avant le chargement du module. */
  function makeClock(start) {
    const Real = globalThis.Date;
    let t = start;
    function FakeDate() {
      const args = Array.prototype.slice.call(arguments);
      if (!(this instanceof FakeDate)) return new Real(t).toString();
      return new Real.apply(Real, args.length ? args : [t]);
    }
    FakeDate.now = function () { return t; };
    FakeDate.advance = function (ms) { t += ms; };
    return FakeDate;
  }

  /* ---------- faux WebSocket : compte les dial et les envois réels ---------- */
  function makeWebSocket() {
    function WS(url) {
      const self = this;
      this.url = url;
      this.readyState = 0;
      this.binaryType = "";
      this.sent = [];
      WS.instances.push(this);
      /* `self` capturé : un callback `function` classique aurait `this` non lié. */
      setTimeout(function () {
        self.readyState = WS.OPEN;
        if (self.onopen) self.onopen();
      }, 0);
    }
    WS.OPEN = 1;
    WS.CONNECTING = 0;
    WS.CLOSING = 2;
    WS.CLOSED = 3;
    WS.instances = [];
    WS.prototype.send = function (d) { this.sent.push(JSON.parse(d)); };
    WS.prototype.close = function () {
      this.readyState = WS.CLOSED;
      if (this.onclose) this.onclose();
    };
    return WS;
  }

  /* ---------- micro-assertions locales ---------- */
  function eq(actual, want, msg) {
    if (actual !== want) {
      throw new Error((msg ? msg + " — " : "") + "attendu " + want + ", obtenu " + actual
        + "\n--- logs du module ---\n" + (lastEnv ? lastEnv.logText() : "(aucun env)"));
    }
  }
  function notMatch(text, re, msg) {
    if (re.test(text)) throw new Error(msg || ("motif interdit trouvé : " + re));
  }

  let lastEnv = null;
  function boot() {
    const env = createEnv();
    env.Date = makeClock(T0);
    env.WebSocket = makeWebSocket();
    load(env, "net/session-ws.js");
    env.ws = env.MultiCamSessionWs;
    lastEnv = env;
    return env;
  }

  /* Une session ayant un Master joignable : c'est la seule chose qui compte
   * pour que `reSyncSession()` émette RE_SYNC_START puis dial. */
  function session(sid, endpoint) {
    return {
      sessionId: sid,
      state: "open",
      masters: [{ deviceId: "M-1", deviceName: "Master", endpoint: endpoint || MASTER }]
    };
  }

  /* Un reSync « parti » = un `sync_please` RÉELLEMENT envoyé. Compter les logs
   * de dial serait trop optimiste : on compte l'envoi. */
  function sent(env, sid) {
    const re = new RegExp("SYNC_PLEASE_SENT sessionId=" + sid + " ");
    return env.logs.filter(function (l) { return re.test(l); }).length;
  }
  function throttled(env, sid) {
    const re = new RegExp("RE_SYNC_THROTTLED sessionId=" + sid + " ");
    return env.logs.filter(function (l) { return re.test(l); }).length;
  }

  async function resync(env, sess) {
    env.ws.reSyncSession(sess);
    await flush(6);
  }

  /* ---------- micro-assertions locales ---------- */

  /* ------------------------------------------------------------------ *
   * T1 — non-régression : l'anti-écho sur la MÊME session doit survivre.
   * ------------------------------------------------------------------ */
  describe("session-ws · throttle reSync — MÊME session", () => {
    it("T1. reSyncSession deux fois très vite sur la même session → 1 seul envoi", async () => {
      const env = boot();
      await resync(env, session("A"));
      eq(sent(env, "A"), 1);

      env.Date.advance(4);   /* 4 ms : très largement dans la fenêtre */
      await resync(env, session("A"));
      eq(sent(env, "A"), 1, "le 2e envoi ne doit pas repartir");
      eq(throttled(env, "A"), 1, "le 2e appel doit être journalisé throttlé");
    });
  });

  /* ------------------------------------------------------------------ *
   * T2/T3 — LE BUG. Étaient rouges sur le code livré (throttle global) :
   * B et C étaient rejetés à quelques ms près derrière A.
   * ------------------------------------------------------------------ */
  describe("session-ws · throttle reSync — sessions DIFFÉRENTES", () => {
    it("T2. deux sessions différentes appelées très vite → les deux reSync partent", async () => {
      const env = boot();
      await resync(env, session("A"));
      env.Date.advance(2);   /* 2 ms, comme au boot dans le forEach */
      await resync(env, session("B"));

      eq(sent(env, "A"), 1);
      eq(sent(env, "B"), 1, "la session B ne doit pas être étouffée par A");
    });

    it("T3. trois sessions dans une boucle synchrone (cas du boot) → les trois partent", async () => {
      const env = boot();
      /* Reproduit exactement `main.js:bootSession()` : un forEach synchrone. */
      env.Date.advance(1);
      ["A", "B", "C"].forEach(function (sid) { env.ws.reSyncSession(session(sid)); });
      await flush(10);

      eq(sent(env, "A"), 1);
      eq(sent(env, "B"), 1, "seule la 1re session survivait au boot");
      eq(sent(env, "C"), 1, "seule la 1re session survivait au boot");
    });
  });

  /* ------------------------------------------------------------------ *
   * T4 — la fenêtre de 1500 ms doit rester une fenêtre RÉELLE par session.
   * ------------------------------------------------------------------ */
  describe("session-ws · fenêtre de 1500 ms", () => {
    it("T4. même session après >1500 ms → reSync de nouveau autorisé", async () => {
      const env = boot();
      await resync(env, session("A"));
      env.Date.advance(1501);
      await resync(env, session("A"));
      eq(sent(env, "A"), 2, "la fenêtre doit expirer pour la même session");
    });

    it("T4b. le délai n'est pas raccourci : à 1499 ms toujours throttlé", async () => {
      const env = boot();
      await resync(env, session("A"));
      env.Date.advance(1499);
      await resync(env, session("A"));
      eq(sent(env, "A"), 1);
      eq(throttled(env, "A"), 1);
    });
  });

  /* ------------------------------------------------------------------ *
   * T5 — robustesse : une session sans sessionId ne doit ni consommer le
   * budget de throttle d'une session RÉELLE, ni envoyer un enveloppe sans sid.
   * ------------------------------------------------------------------ */
  describe("session-ws · sessionId invalide", () => {
    it("T5. session sans sessionId → pas de pollution du throttle des sessions réelles", async () => {
      const env = boot();
      env.ws.reSyncSession({ masters: session("A").masters });   /* pas de sessionId */
      await flush(6);
      notMatch(env.logText(), /sessionId=undefined/,
        "aucune enveloppe ne doit partir sans sessionId");

      /* La session réelle qui suit immédiatement ne doit pas être pénalisée. */
      env.Date.advance(1);
      await resync(env, session("A"));
      eq(sent(env, "A"), 1, "un sessionId absent a consommé le throttle de A");
    });

    it("T5b. masters vide → aucun dial, aucun envoi, aucun crash", async () => {
      const env = boot();
      env.ws.reSyncSession({ sessionId: "Z", masters: [] });
      await flush(6);
      eq(sent(env, "Z"), 0);
      eq(env.WebSocket.instances.length, 0, "aucun dial ne doit partir");
    });
  });
}

module.exports = { register };
