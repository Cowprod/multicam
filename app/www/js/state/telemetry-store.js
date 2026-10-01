/* MultiCam — J09-06 : mémoire de supervision, côté Master.
 *
 * ROLE : la DERNIERE télémétrie connue de chaque Capture, par session. Volatile,
 * sans historique — exactement comme `state/preview-inbox.js` pour les images,
 * et pour la même raison : la mosaïque montre l'état courant, pas un journal.
 * Un historique de snapshots n'aurait aucun usage ici et coûterait de la
 * mémoire pour rien (décision §23 : « pas d'historique »).
 *
 * CE QUE CE MODULE NE FAIT PAS (et c'est volontaire) :
 *   - il ne décide PAS de ce qui est affichable : la mosaïque lit, elle ne
 *     filtre pas ;
 *   - il ne NOTIFIE PAS l'UI : le rendu du Master est déjà piloté par le flux
 *     START (200 ms, main.js), qui lit ce store comme il lit le liveness. Un
 *     abonnement supplémentaire créerait un second rythme de rendu ;
 *   - il ne CONNAIT PAS le réseau. Il ne fait qu'enregistrer ce que le
 *     transport a accepté de traiter, comme la boîte de réception le fait pour
 *     une frame.
 *
 * L'indexation est (sessionId, deviceId) et non deviceId : la même Capture peut
 * participer à plusieurs sessions, et une supervision ne doit JAMAIS mélanger
 * deux sessions (c'est le défaut le plus grave possible sur un écran de régie).
 *
 * « connected » N'EST PAS STOCKÉ ICI. Il vient du liveness WS, qui seul sait
 * si le lien est réellement vivant : une Capture ne peut pas s'auto-déclarer
 * connectée après une coupure réseau. Ce store ne mémorise que des MESURES.
 */

"use strict";
(function (global) {

  var S = {
    /* sid -> { deviceId -> { telemetry, atMs, local } } */
    bySession: {},
    listeners: [],
    stats: { sets: 0, ignoredOlder: 0, cleared: 0 }
  };

  function nowMs() { return Date.now(); }

  function log() {
    try {
      var args = [];
      for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
      global.console.log(args.join(" "));
    } catch (e) {}
  }

  function bucket(sessionId) {
    var sid = typeof sessionId === "string" && sessionId ? sessionId : "";
    if (!S.bySession[sid]) S.bySession[sid] = {};
    return S.bySession[sid];
  }

  /* Un snapshot MESURÉ. `atMs` est l'instant de la mesure côté Capture (champ
   * `atMs` du contrat) ; à défaut, l'instant d'enregistrement. Les deux sont
   * exposés séparément de `updatedAtMs`, qui est l'instant de réception. */
  function set(sessionId, deviceId, telemetry, atMs, opts) {
    if (!sessionId || !deviceId || !telemetry || typeof telemetry !== "object") return false;
    var b = bucket(sessionId);
    var stamp = (typeof atMs === "number" && atMs > 0) ? atMs
      : (typeof telemetry.atMs === "number" && telemetry.atMs > 0 ? telemetry.atMs : nowMs());
    var prev = b[deviceId];
    /* Un snapshot plus ancien que celui qu'on a ne remplace JAMAIS le dernier
     * état : une reconnexion peut rejouer un tampon, et « dernier état connu »
     * doit rester le plus récent. */
    if (prev && stamp < prev.atMs) {
      S.stats.ignoredOlder += 1;
      log("TELEMETRY_STORE_IGNORE sessionId=" + sessionId + " did=" + deviceId
        + " reason=older atMs=" + stamp + " keptAtMs=" + prev.atMs);
      return false;
    }
    b[deviceId] = {
      telemetry: telemetry,
      atMs: stamp,
      /* Marqueur de provenance : la télémétrie du device LOCAL est enregistrée
       * par le chemin auto-déclaré, sans aller-retour réseau (un Master qui est
       * aussi Capture ne doit pas s'envoyer sa télémétrie pour la lire). */
      local: !!(opts && opts.local)
    };
    S.stats.sets += 1;
    return true;
  }

  /* La dernière télémétrie connue, ou null si cette Capture n'a jamais
   * signalé. `null` n'est jamais remplacé par une valeur par défaut. */
  function get(sessionId, deviceId) {
    var b = S.bySession[sessionId];
    var e = b && b[deviceId];
    return e || null;
  }

  /* Table { deviceId -> { telemetry, atMs, local } } pour la mosaïque. */
  function all(sessionId) {
    var b = S.bySession[sessionId] || {};
    var out = {};
    Object.keys(b).forEach(function (did) { out[did] = b[did]; });
    return out;
  }

  /* Vue «Supervision » prête à afficher pour un device (la mosaïque et la vue
   * détaillée lisent la MÊME structure : pas de second format). */
  function viewOf(sessionId, deviceId) {
    var e = get(sessionId, deviceId);
    if (!e) return null;
    return {
      deviceId: deviceId,
      telemetry: e.telemetry,
      atMs: e.atMs,
      local: !!e.local,
      ageMs: Math.max(0, nowMs() - e.atMs)
    };
  }

  function onChange(fn) {
    if (typeof fn === "function" && S.listeners.indexOf(fn) < 0) S.listeners.push(fn);
    return fn;
  }

  function emit(deviceId) {
    S.listeners.slice().forEach(function (fn) {
      try { fn(deviceId); } catch (e) { log("TELEMETRY_STORE_LISTENER_ERROR err=" + e); }
    });
  }

  /* Fin de session / changement de Take : on oublie. Une mosaïque ne doit
   * jamais afficher une valeur d'une session précédente comme si elle était
   * courante. */
  function clear(sessionId) {
    if (sessionId) {
      if (S.bySession[sessionId]) { delete S.bySession[sessionId]; S.stats.cleared += 1; }
      return;
    }
    S.bySession = {};
    S.stats.cleared += 1;
  }

  function stats() {
    var devices = 0;
    Object.keys(S.bySession).forEach(function (sid) { devices += Object.keys(S.bySession[sid]).length; });
    return {
      sessions: Object.keys(S.bySession).length,
      devices: devices,
      sets: S.stats.sets,
      ignoredOlder: S.stats.ignoredOlder,
      cleared: S.stats.cleared
    };
  }

  function reset() {
    S.bySession = {};
    S.listeners = [];
    S.stats = { sets: 0, ignoredOlder: 0, cleared: 0 };
  }

  global.MultiCamTelemetryStore = {
    set: set,
    get: get,
    all: all,
    viewOf: viewOf,
    onChange: onChange,
    emit: emit,
    clear: clear,
    stats: stats,
    reset: reset,
    _state: S
  };

})(window);