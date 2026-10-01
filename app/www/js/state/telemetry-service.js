/* MultiCam — J09-06 : collecte de la télémétrie opérationnelle, côté Capture.
 *
 * ROLE : mesurer, assembler UN snapshot, le publier. Rien d'autre. Ni le DOM, ni
 * la mosaïque, ni le WebSocket en direct : ce module appelle le transport par son
 * API publique, comme le fait l'écran 05 avant lui.
 *
 * ---------- POURQUOI UN SERVICE ET PAS L'ÉCRAN ----------
 *
 * La télémétrie doit continuer pendant le REC, c'est-à-dire quand l'opérateur
 * (local) regarde l'écran 08. Elle était attachée à l'écran 05, donc pilotée par
 * l'affichage : un écran masqué, une navigation, une réouverture et la
 * supervision s'arrêtait. La mission demande l'inverse — « le Master doit
 * superviser sans ouvrir plusieurs écrans » — donc la collecte sort de l'UI et
 * devient un service, activé tant qu'une session ouverte existe.
 *
 * ---------- CADENCE (choix explicite) ----------
 *
 * La télémétrie NE SUIT PAS la cadence des previews. Une image par seconde, par
 * Capture, pour apprendre qu'il reste 40 % de batterie n'est pas de la
 * supervision, c'est du bruit sur le réseau et de l'usure. On retient :
 *
 *   - 1 snapshot toutes les 5 s (périodique) ;
 *   - + 1 publication IMMÉDIATE sur changement notable : niveau de batterie,
 *     basculement charge/décharge, démarrage/arrêt du REC ;
 *   - les mesures LENTES (espace libre, type réseau) sont rafraîchies au plus
 *     toutes les 15 s : re-mesurer un `StatFs` ou un `ConnectivityManager` 12
 *     fois par minute n'apprendrait rien, et la valeur affichée resterait
 *     identique.
 *
 * Conséquence sur la fraîcheur affichée : la valeur « batterie » est toujours
 * celle de l'événement natif le plus récent, donc fraîche ; « stockage » et
 * « réseau » ont au plus 15 s de retard, et la télémétrie l'affiche comme telle
 * (`atMs`) plutôt que de faire croire à une mesure instantanée.
 *
 * ---------- JAMAIS DE FILE, JAMAIS DE BLOCAGE ----------
 *
 * Un publish est en vol au maximum : si un changement survient pendant ce temps,
 * il est mémorisé comme `pending` et republié UNE fois à la fin, avec les
 * valeurs les plus récentes. Il n'y a donc ni accumulation, ni retard qui
 * s'allonge, ni mémoire qui grossit : « latest state wins ». La collecte ne
 * bloque jamais le REC ni PixelCopy : elle n'est ni sur le chemin d'écriture
 * vidéo, ni dans le callback de preview (`preview_frame` garde la priorité, cf.
 * `state/preview-transport.js`).
 */

"use strict";
(function (global) {

  var CADENCE_MS = 5000;        /* 1 snapshot / 5 s */
  var MEASURE_TTL_MS = 15000;   /* espace libre + réseau : 1 mesure / 15 s */

  var S = {
    bound: false,
    deviceId: "",
    deviceName: "",
    running: false,
    sessionId: "",
    session: null,
    timer: null,
    /* Mesures en cours de fraîcheur */
    battery: null,              /* { level, charging, atMs } */
    space: null,                /* { freeBytes, totalBytes, atMs } */
    net: null,                  /* { type, atMs } */
    caps: null,
    recording: null,            /* true | false | null (inconnu) */
    /* Vol */
    inFlight: 0,
    pending: false,
    lastPublishAtMs: 0,
    lastErrorAtMs: 0,
    stats: { collects: 0, publishes: 0, errors: 0, coalesced: 0, immediate: 0 }
  };

  function nowMs() { return Date.now(); }

  function log() {
    try {
      var args = [];
      for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
      global.console.log(args.join(" "));
    } catch (e) {}
  }

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  function capsProbe() {
    var cap = global.MultiCamCaptureCapabilities;
    if (!cap || typeof cap.capabilitiesFor !== "function") return Promise.resolve(S.caps);
    return Promise.resolve(cap.capabilitiesFor(S.deviceId, S.session)).then(function (c) {
      S.caps = c || S.caps;
      return S.caps;
    }).catch(function () { return S.caps; });
  }

  /* Espace libre : natif `StatFs` sur le répertoire d'écriture utilisé par le
   * Take. En mode SAF l'URL n'est pas un chemin système : on ne FABRIQUE pas de
   * chiffre, la valeur reste inconnue (null) et l'UI affiche un état neutre. */
  function measureSpace(force) {
    if (S.space && !force && nowMs() - S.space.atMs < MEASURE_TTL_MS) {
      return Promise.resolve(S.space);
    }
    var st = global.MultiCamStorage, nat = global.MultiCamNative;
    if (!st || typeof st.systemPath !== "function" || !nat || typeof nat.freeSpace !== "function") {
      return Promise.resolve(null);
    }
    var path;
    try { path = st.systemPath(st.defaultPath()); } catch (e) { return Promise.resolve(null); }
    if (!path) return Promise.resolve(null);
    return Promise.resolve(nat.freeSpace(path)).then(function (r) {
      if (!r || !isNum(r.availableBytes)) return S.space;
      S.space = {
        freeBytes: r.availableBytes,
        totalBytes: isNum(r.totalBytes) ? r.totalBytes : null,
        atMs: nowMs()
      };
      return S.space;
    }).catch(function (err) {
      log("TELEMETRY_SPACE_UNAVAILABLE err=" + String((err && err.message) || err));
      return S.space;
    });
  }

  /* Type de réseau ACTIF, tel que ConnectivityManager le rapporte
   * (NetworkCapabilities.hasTransport). C'est une MESURE de transport, pas une
   * qualité, et elle ne dit rien du lien vers la régie — c'est le liveness WS
   * côté Master qui|en dit. On ne dérive donc aucun indicateur de « qualité ». */
  function measureNet(force) {
    if (S.net && !force && nowMs() - S.net.atMs < MEASURE_TTL_MS) {
      return Promise.resolve(S.net);
    }
    var nat = global.MultiCamNative;
    if (!nat || typeof nat.networkType !== "function") return Promise.resolve(S.net);
    return Promise.resolve(nat.networkType()).then(function (t) {
      if (typeof t !== "string" || !t) return S.net;
      S.net = { type: t, atMs: nowMs() };
      return S.net;
    }).catch(function () { return S.net; });
  }

  /* L'état de l'enregistreur est lu, pas deviné : c'est la même source que celle
   * qui déclenche REC/STOPPED. */
  function measureRecording() {
    var cam = global.MultiCamCameraRecord;
    if (!cam || typeof cam.isRecording !== "function") return null;
    try { return !!cam.isRecording(); } catch (e) { return null; }
  }

  /* ---------- ÉCHELLE DE BATTERIE : deux conventions coexistent ----------
   *
   * L'événement `batterystatus` de Cordova expose `level` en FRACTION (0.62 =
   * 62 %), mais certaines versions de plugin et certains WebView Android
   * remontent un pourcentage direct (100).
   *
   * Constaté PHYSIQUEMENT en J09-06 : le device de test renvoyait 100, la
   * conversion fraction → pourcentage produisait 10000, et le contrat
   * rejetait la valeur — la batterie disparaissait de la mosaïque, sans erreur
   * et sans faux 0 %. Un test en fraction n'aurait jamais trouvé ça.
   *
   * La normalisation est donc faite ICI, une fois pour toutes, et `S.battery.level`
   * est stocké DÉJÀ en pourcentage : plus aucun `* 100` ailleurs dans ce module,
   * donc plus deux échelles qui divergent.
   *
   * Hors bornes (négatif, > 100) : `null`. On ne « recale » pas une mesure
   * absurde, on la déclare non mesurée. */
  function batteryPct(raw) {
    if (typeof raw !== "number" || !isFinite(raw) || raw < 0) return null;
    var pct = raw > 1 ? raw : raw * 100;
    if (pct > 100) return null;
    return Math.round(pct);
  }

  /* Le snapshot publié. Uniquement ce que l'UI sait afficher ; ce qui n'a pas pu
   * être mesuré est ABSENT plutôt qu'à 0. `sessionId`/`deviceId` voyagent déjà
   * dans l'enveloppe et dans la fiche membre : ne pas les recopier. */
  function buildSnapshot() {
    var t = { atMs: nowMs() };
    if (S.caps) t.capabilities = S.caps;
    if (S.battery && isNum(S.battery.level)) t.batteryLevel = S.battery.level;
    if (S.battery && typeof S.battery.charging === "boolean") t.batteryCharging = S.battery.charging;
    if (S.space && isNum(S.space.freeBytes)) t.freeBytes = S.space.freeBytes;
    if (S.space && isNum(S.space.totalBytes)) t.totalBytes = S.space.totalBytes;
    if (S.net && S.net.type) t.netType = S.net.type;
    if (typeof S.recording === "boolean") t.recording = S.recording;
    return t;
  }

  /* La session courante, la plus fraîche possible : `updateMemberTelemetry`
   * travaille sur une COPIE, et republier une copie périmée écraserait les
   * changements concurrents (rôles, état de session). Sans store disponible
   * (tests, démarrage), la copie en mémoire suffit. */
  function currentSession() {
    var sid = S.sessionId;
    var store = global.MultiCamSessionStore;
    if (sid && store && typeof store.get === "function") {
      return Promise.resolve(store.get(sid)).then(function (s) {
        if (s) S.session = s;
        return S.session;
      }).catch(function () { return S.session; });
    }
    return Promise.resolve(S.session);
  }

  function isMemberOf(session) {
    if (!session || session.state !== "open" || !S.deviceId) return false;
    return (session.members || []).some(function (m) { return m.deviceId === S.deviceId; });
  }

  function publish(snapshot) {
    var ws = global.MultiCamSessionWs;
    if (!ws || typeof ws.updateMemberTelemetry !== "function") return Promise.resolve(false);
    return currentSession().then(function (session) {
      if (!isMemberOf(session)) {
        /* Pas encore membre (ou session refermée) : rien à déclarer. Ce n'est pas
         * une erreur, c'est un état normal avant le JOIN. */
        return false;
      }
      return Promise.resolve(ws.updateMemberTelemetry(session, S.deviceId, snapshot)).then(function (upd) {
        if (upd && upd.sessionId) S.session = upd;
        else if (upd) S.session = upd;
        S.lastPublishAtMs = nowMs();
        S.stats.publishes += 1;
        log("TELEMETRY_SENT did=" + S.deviceId
          + " battery=" + (snapshot.batteryLevel == null ? "—" : snapshot.batteryLevel)
          + " charging=" + (snapshot.batteryCharging == null ? "—" : snapshot.batteryCharging)
          + " free=" + (snapshot.freeBytes == null ? "—" : snapshot.freeBytes)
          + " net=" + (snapshot.netType == null ? "—" : snapshot.netType)
          + " rec=" + (snapshot.recording == null ? "—" : snapshot.recording)
          + " bytes=" + JSON.stringify(snapshot).length);
        return true;
      }).catch(function (err) {
        S.stats.errors += 1;
        S.lastErrorAtMs = nowMs();
        log("TELEMETRY_SEND_FAIL did=" + S.deviceId
          + " reason=" + String((err && err.message) || err));
        return false;
      });
    });
  }

  /* Une collecte = une publication, au plus une en vol. Si un changement est
   * arrivé pendant le publish, on le republie UNE fois avec les valeurs
   * courantes : c'est la règle « latest state wins », et non pas une file. */
  function collectNow(reason) {
    if (!S.bound || !S.running) return Promise.resolve(false);
    if (S.inFlight > 0) {
      S.pending = true;
      S.stats.coalesced += 1;
      return Promise.resolve(false);
    }
    S.recording = measureRecording();
    S.inFlight += 1;
    S.stats.collects += 1;
    return Promise.all([capsProbe(), measureSpace(false), measureNet(false)])
      .then(function () {
        return publish(buildSnapshot());
      })
      .then(function (ok) {
        S.inFlight -= 1;
        if (S.pending) {
          S.pending = false;
          return collectNow("coalesced");
        }
        return ok;
      })
      .catch(function (err) {
        S.inFlight -= 1;
        S.stats.errors += 1;
        log("TELEMETRY_COLLECT_FAIL reason=" + String((err && err.message) || err));
        return false;
      });
  }

  /* Publication immédiate sur changement notable. Le `force` n'est PAS
   * prioritaire sur un publish en vol : il est fusionné (voir collectNow), ce qui
   * garantit qu'aucun envoi ne s'empile. */
  function collectNowIfRunning(reason) {
    if (!S.running) return Promise.resolve(false);
    S.stats.immediate += 1;
    log("TELEMETRY_TRIGGER reason=" + (reason || "change"));
    return collectNow(reason);
  }

  function bindBattery() {
    var dev = global.MultiCamDevice;
    if (bindBattery._done || !dev || typeof dev.batteryStatus !== "function") return;
    bindBattery._done = true;
    dev.batteryStatus(function (b) {
      if (!b) return;
      var prev = S.battery;
      /* Normalisé ICI : `S.battery.level` est un pourcentage (0–100). */
      var level = batteryPct(b.level);
      var charging = (typeof b.isPlugged === "boolean") ? b.isPlugged : null;
      S.battery = { level: level, charging: charging, atMs: nowMs() };
      if (!prev) return;
      var levelChanged = prev.level !== null && level !== null && prev.level !== level;
      var chargingChanged = prev.charging !== null && charging !== null && prev.charging !== charging;
      if (levelChanged || chargingChanged) {
        /* Seuil de vigilance : inutile d'avertir l'opérateur à chaque point de
         * pourcentage, mais un franchissement de seuil doit être visible tout de
         * suite (le storage est lui mesuré par la cadence, lui est lent). */
        var crossesWarn = prev.level !== null && level !== null && prev.level > BATTERY_WARN
          && level <= BATTERY_WARN;
        if (chargingChanged || crossesWarn) {
          collectNowIfRunning(chargingChanged ? "charging" : "battery_threshold");
        } else {
          log("TELEMETRY_BATTERY_EVENT level=" + level);
        }
      }
    });
  }

  /* Même seuil que `state/arm-model.js` (FREE_WARN_BYTES) côté stockage : la
   * vigilance doit être la même decision d'écran à l'écran. */
  /* Seuils : source unique `state/session-model.js`. Le service ne REDÉFINIT
   * rien — c'est lui qui décide QUAND publier, pas quel chiffre afficher. */
  var BATTERY_WARN = (global.MultiCamSessionModel && global.MultiCamSessionModel.BATTERY_WARN_PCT) || 25;

  function start(session) {
    if (!session || !session.sessionId) return false;
    stop();
    S.session = session;
    S.sessionId = session.sessionId;
    S.running = true;
    S.timer = global.setInterval(function () { collectNow("cadence"); }, CADENCE_MS);
    log("TELEMETRY_COLLECTOR_START did=" + S.deviceId
      + " sessionId=" + S.sessionId + " cadenceMs=" + CADENCE_MS + " measureTtlMs=" + MEASURE_TTL_MS);
    /* Premier snapshot dès l'ouverture : le Master ne doit pas attendre 5 s pour
     * afficher une batterie. */
    collectNowIfRunning("open");
    return true;
  }

  function stop() {
    if (S.timer) {
      global.clearInterval(S.timer);
      S.timer = null;
    }
    if (S.running) log("TELEMETRY_COLLECTOR_STOP did=" + S.deviceId + " sessionId=" + (S.sessionId || "—"));
    S.running = false;
    S.sessionId = "";
    S.session = null;
    S.pending = false;
  }

  function bind(cfg) {
    var c = cfg || {};
    if (c.deviceId) S.deviceId = c.deviceId;
    if (c.deviceName) S.deviceName = c.deviceName;
    S.bound = !!S.deviceId;
    bindBattery();
    log("TELEMETRY_COLLECTOR_READY did=" + (S.deviceId || "—")
      + " cadenceMs=" + CADENCE_MS + " measureTtlMs=" + MEASURE_TTL_MS
      + " batteryWarn=" + BATTERY_WARN);
    return S.bound;
  }

  /* L'observation du REC est aussi déclenchée par le service START (J07/J09) :
   * sans ça, un arrêt entre deux snapshots mettrait jusqu'à 5 s à apparaître. */
  function onRecordingChanged() {
    collectNowIfRunning("recording");
  }

  function view() {
    return {
      bound: S.bound,
      running: S.running,
      deviceId: S.deviceId,
      sessionId: S.sessionId,
      cadenceMs: CADENCE_MS,
      measureTtlMs: MEASURE_TTL_MS,
      inFlight: S.inFlight,
      pending: S.pending,
      lastPublishAtMs: S.lastPublishAtMs,
      lastErrorAtMs: S.lastErrorAtMs,
      battery: S.battery,
      space: S.space,
      net: S.net,
      recording: S.recording,
      errors: S.stats.errors,
      stats: {
        collects: S.stats.collects,
        publishes: S.stats.publishes,
        errors: S.stats.errors,
        coalesced: S.stats.coalesced,
        immediate: S.stats.immediate
      }
    };
  }

  function reset() {
    stop();
    S.bound = false;
    S.deviceId = "";
    S.deviceName = "";
    S.battery = null;
    S.space = null;
    S.net = null;
    S.caps = null;
    S.recording = null;
    S.inFlight = 0;
    S.lastPublishAtMs = 0;
    S.stats = { collects: 0, publishes: 0, errors: 0, coalesced: 0, immediate: 0 };
  }

  global.MultiCamTelemetryService = {
    CADENCE_MS: CADENCE_MS,
    MEASURE_TTL_MS: MEASURE_TTL_MS,
    BATTERY_WARN: BATTERY_WARN,
    bind: bind,
    start: start,
    stop: stop,
    collectNow: collectNowIfRunning,
    onRecordingChanged: onRecordingChanged,
    view: view,
    reset: reset,
    _state: S
  };

})(window);