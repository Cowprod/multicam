/* MultiCam — modèle pur J07 : ARM distribué (écran 06) + synchronisation d'horloge.
 * Module "UMD-lite" (même convention que take-model.js) : window.MultiCamArmModel pour
 * l'app, require() en Node pour les tests déterministes
 * (tests/plugin-lab/session/arm-model.test.js).
 *
 * Périmètre PUR — aucun DOM, WebSocket, natif, ni Date.now implicite (l'horloge et
 * les timers arrivent via les dépendances de createMachine ; les helpers math sont
 * purs). Règles figées : mission J07 + maquette validée ui/06-arm +
 * MULTICAM_DECISIONS_REFERENCE (§42, décisions de campagne).
 *
 *  - Identité de cycle : armCycleId = "<sessionId>#<takeNumber>#<tentative>" ; chaque
 *    entrée sur l'écran 06 incrémente la tentative pour (session, take). Une réponse
 *    dont le cycle / le take ne correspond pas est ignorée (statut conservé).
 *  - Devices sélectionnés : ordre EXACT de l'écran 05 = ordre des membres ; chaque
 *    device une seule fois (plusieurs rôles OK) ; rôles dans l'ordre Capture puis
 *    Storage.
 *  - Vérifications Capture : connexion, caméra, audio, permissions requises par
 *    l'effectif, stockage local, réglages appliqués, synchronisation. Comparaison
 *    évident(e) : le best effort 4K→FHD n'est PAS une erreur ARM ; une capacité
 *    inconnue est honnête (warn), jamais inventée ; GPS effectif Off (gpsFeature
 *    false) → pas de permission localisation requise.
 *  - Vérifications Storage : connexion, espace libre (≥1 Go ok / <1 Go warn /
 *    inutilisable err), accès volume, réception transferts.
 *  - Réduction : le moindre err → ERROR ; sinon le moindre warn → WARNING ; sinon tout
 *    résolu → READY ; sinon ARMING. La sync dégradée n'est JAMAIS bloquante pour REC ;
 *    un incident Storage n'affecte JAMAIS l'éligibilité REC.
 *  - REC éligible dès ≥1 Capture READY ou WARNING (le Storage n'a aucun effet).
 *  - Incidents (modal) : lignes en WARNING / ERROR / ARMING / déconnecté ; auto-
 *    fermeture quand plus aucun incident.
 *  - Math NTP : rtt = (t3−t0)−(t2−t1) ; offset = ((t1−t0)+(t2−t3))/2 (REMARQUE :
 *    valeur positive = horloge du pair AVANCÉE par rapport à la locale). Cible ±50 ms.
 *
 * Journalisation parsable émise via deps.log : ARM_START, ARM_REQUEST, ARM_RESULT,
 * ARM_TIMEOUT, ARM_CANCEL, ARM_RECOVER, CLOCK_SYNC, ARM_STATE_CHANGED,
 * REC_ELIGIBILITY.
 */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(root);
  } else {
    root.MultiCamArmModel = factory(root);
  }
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  /* ---------- constantes (écran 06 / mission J07) ---------- */

  var FIRST_RESULT_TIMEOUT_MS = 5000;      /* attente initiale d'une réponse par (device, skill) */
  var REFRESH_MS = 8000;                   /* cycle de rafraîchissement "live" (ARM vit, pas one-shot) */
  var CLOCK_SAMPLE_TIMEOUT_MS = 3000;      /* échantillon d'horloge abandonné après ce délai */
  var CLOCK_SAMPLES_TARGET = 3;            /* échantillons utiles pour une estimation stable */
  var CLOCK_SAMPLES_MAX = 8;               /* fenêtre glissante d'échantillons conservés */
  var CLOCK_SAMPLE_SPACING_MS = 500;       /* espacement entre échantillons au démarrage */
  var FREE_WARN_BYTES = 1000000000;        /* 1 Go : seuil WARNING stockage local */
  var SYNC_WARN_OFFSET_MS = 50;            /* objectif ±50 ms (valeur absolue du delta) */
  var SYNC_WARN_DISPERSION_MS = 50;        /* dispersion (étendue des offsets) de dégradation */
  var SKILL_CAPTURE = "capture";
  var SKILL_STORAGE = "storage";
  var STATUS_ARMING = "ARMING";
  var STATUS_READY = "READY";
  var STATUS_WARNING = "WARNING";
  var STATUS_ERROR = "ERROR";

  /* ---------- helpers ---------- */

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  function lineOK() { return { status: "ok", message: "" }; }
  function lineWarn(m) { return { status: "warn", message: m }; }
  function lineErr(m) { return { status: "err", message: m }; }
  function linePending(m) { return { status: "pending", message: m }; }

  /* ---------- identité de cycle ---------- */

  /* armCycleId = sessionId + take + tentative (déterministe, sémantique de cycle). */
  function cycleId(sessionId, takeNumber, attempt) {
    return String(sessionId) + "#" + String(takeNumber) + "#" + String(attempt);
  }

  function isCycleFmt(id) {
    if (typeof id !== "string" || !id) return false;
    var parts = id.split("#");
    if (parts.length !== 3) return false;
    if (!/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2])) return false;
    return parts[0].length > 0;
  }

  /* Un cycle est-il bien la (session, take) courante ? (préfixe = cycle id parent) */
  function cycleOf(sessionId, takeNumber) {
    return String(sessionId) + "#" + String(takeNumber) + "#";
  }

  function cycleMatches(id, sessionId, takeNumber) {
    if (!isCycleFmt(id)) return false;
    return id.length > cycleOf(sessionId, takeNumber).length
      && id.indexOf(cycleOf(sessionId, takeNumber)) === 0;
  }

  /* ---------- ordre déterministe des devices sélectionnés ---------- */

  /* Devices du Take dans l'ordre EXACT de l'écran 05 (ordre des membres, chaque
   * device une seule fois, skills Capture puis Storage). */
  function orderedDevices(take, members) {
    var out = [];
    var cap = {}, sto = {};
    (take && take.captures || []).forEach(function (d) { if (typeof d === "string" && d) cap[d] = true; });
    (take && take.storages || []).forEach(function (d) { if (typeof d === "string" && d) sto[d] = true; });
    (members || []).forEach(function (m) {
      if (!m || typeof m.deviceId !== "string" || !m.deviceId) return;
      var skills = [];
      if (cap[m.deviceId]) skills.push(SKILL_CAPTURE);
      if (sto[m.deviceId]) skills.push(SKILL_STORAGE);
      if (skills.length) {
        out.push({ did: m.deviceId, deviceName: m.deviceName || m.deviceId, skills: skills });
      }
    });
    return out;
  }

  /* ---------- permissions requises par l'EFFECTIF ---------- */

  /* effective = { audio: bool, gpsProfile: string } (issue de take-model
   * effectiveForCapture : audio déjà résolu contre caps.audioMic et GPS déjà
   * ramené à Off si gpsFeature false). La permission caméra est toujours requise
   * pour une Capture ; le micro seulement si l'audio est effectif ; la localisation
   * seulement si le GPS est effectif. */
  function requirePermissions(effective) {
    var req = ["CAMERA"];
    if (effective && effective.audio) req.push("RECORD_AUDIO");
    if (effective && effective.gpsProfile && effective.gpsProfile !== "OFF") req.push("ACCESS_FINE_LOCATION");
    return req;
  }

  /* Statuts de permission explicitement REFUSÉS (seuls ceux-ci bloquent).
   * NOT_REQUESTED / statuts intermédiaires = à demander, jamais un échec d'ARM. */
  function isRefusedPermission(status) {
    return status === "DENIED" || status === "DENIED_ALWAYS" || status === "DENIED_ONCE" || status === "RESTRICTED";
  }

  /* ---------- vérifications Capture (faits locaux) ---------- */

  /* facts = {
   *   capsUnknown: bool,
   *   supportedRes: [String],          // résolutions de la caméra effective (REAR/FRONT)
   *   effective: {audio, gpsProfile, resolution, quality, camera, orientation, warnings, fallback},
   *   nativeProfile: object|null,      // effectiveNativeProfile (null si capsUnknown)
   *   perms: {CAMERA: "GRANTED"|status, ...} | null,  // null = indisponible (hors Cordova…)
   *   freeBytes: number|null,
   *   probeOk: bool                    // écriture locale prouvée (volume writable)
   * }
   * Retourne les lignes (hors connexion/synchronisation, injectées par le REQUEUR — la cible
   * ne peut pas honnêtement juger sa propre connectivité/son offset). */
  function assessCapture(facts) {
    var checks = [];
    /* caméra */
    if (!facts || facts.capsUnknown) {
      checks.push({ key: "camera", label: "Caméra", status: "warn", message: "Capacités inconnues" });
    } else if (!facts.supportedRes || facts.supportedRes.length === 0) {
      checks.push({ key: "camera", label: "Caméra", status: "err", message: "Aucune résolution supportée" });
    } else {
      checks.push({ key: "camera", label: "Caméra", status: "ok", message: "Prête" });
    }
    /* audio */
    var eff = (facts && facts.effective) || null;
    if (!eff || !eff.audio) {
      checks.push({ key: "audio", label: "Audio", status: "ok", message: "Non requise (audio désactivé)" });
    } else {
      var mic = facts && facts.perms ? (facts.perms.RECORD_AUDIO || null) : null;
      if (mic === "GRANTED") {
        checks.push({ key: "audio", label: "Audio", status: "ok", message: "Micro prêt" });
      } else if (facts && facts.perms === null) {
        checks.push({ key: "audio", label: "Audio", status: "warn", message: "Micro non vérifiable" });
      } else if (!mic) {
        /* clé absente du registre = statut encore inconnu (jamais une assertion de refus) */
        checks.push({ key: "audio", label: "Audio", status: "warn", message: "Micro non vérifié" });
      } else if (isRefusedPermission(mic)) {
        checks.push({ key: "audio", label: "Audio", status: "err", message: "Permission micro refusée" });
      } else {
        /* NOT_REQUESTED / statut intermédiaire : à demander lors du prochain REC, pas un échec d'ARM */
        checks.push({ key: "audio", label: "Audio", status: "warn", message: "Micro à autoriser" });
      }
    }
    /* permissions (uniquement celles requises par l'effectif) */
    if (!facts || facts.perms === null) {
      checks.push({ key: "permissions", label: "Permissions", status: "warn", message: "Autorisations non vérifiables" });
    } else {
      var required = requirePermissions(eff);
      var missing = required.filter(function (p) { return !facts.perms[p]; });
      var refused = required.filter(function (p) { return facts.perms[p] && isRefusedPermission(facts.perms[p]); });
      var pending = required.filter(function (p) { return facts.perms[p] && facts.perms[p] !== "GRANTED" && !isRefusedPermission(facts.perms[p]); });
      if (refused.length) {
        checks.push({ key: "permissions", label: "Permissions", status: "err", message: "Permission refusée : " + refused.join(", ") });
      } else if (pending.length) {
        checks.push({ key: "permissions", label: "Permissions", status: "pending", message: "Autorisation à demander : " + pending.join(", ") });
      } else if (missing.length) {
        checks.push({ key: "permissions", label: "Permissions", status: "pending", message: "Vérification des autorisations…" });
      } else {
        checks.push({ key: "permissions", label: "Permissions", status: "ok", message: "Autorisations requises accordées" });
      }
    }
    /* stockage local */
    if (facts && facts.probeOk === false) {
      checks.push({ key: "storageLocal", label: "Stockage local", status: "err", message: "Écriture impossible" });
    } else if (facts && !isNum(facts.freeBytes)) {
      checks.push({ key: "storageLocal", label: "Stockage local", status: "warn", message: "Espace libre inconnu" });
    } else if (facts && facts.freeBytes < FREE_WARN_BYTES) {
      checks.push({ key: "storageLocal", label: "Stockage local", status: "warn", message: "Espace < 1 Go" });
    } else {
      checks.push({ key: "storageLocal", label: "Stockage local", status: "ok", message: "≥ 1 Go disponibles" });
    }
    /* réglages appliqués */
    if (!facts || facts.capsUnknown) {
      checks.push({ key: "settings", label: "Réglages appliqués", status: "warn", message: "Capacités inconnues" });
    } else if (!facts.supportedRes || facts.supportedRes.length === 0) {
      checks.push({ key: "settings", label: "Réglages appliqués", status: "err", message: "Aucune résolution supportée" });
    } else if (eff && eff.fallback) {
      /* best effort 4K→FHD : adaptation indicative, JAMAIS une erreur d'ARM */
      checks.push({ key: "settings", label: "Réglages appliqués", status: "ok", message: "Best effort appliqué" });
    } else {
      checks.push({ key: "settings", label: "Réglages appliqués", status: "ok", message: "Réglages appliqués" });
    }
    return checks;
  }

  /* ---------- vérifications Storage (faits locaux) ---------- */

  /* facts = { connected, freeBytes, writable, storageMode }. La ligne connexion est
   * recalculée par le REQUEUR (connectivité du point de vue du Master). */
  function assessStorage(facts) {
    var checks = [];
    checks.push({ key: "connection", label: "Connexion", status: (facts && facts.connected) ? "ok" : "err", message: (facts && facts.connected) ? "Connexion établie" : "Déconnecté" });
    if (facts && facts.writable === false) {
      checks.push({ key: "freeSpace", label: "Espace libre", status: "err", message: "Espace inconnu et non accessible" });
    } else if (!facts || !isNum(facts.freeBytes)) {
      checks.push({ key: "freeSpace", label: "Espace libre", status: "warn", message: "Espace libre inconnu" });
    } else if (facts.freeBytes < FREE_WARN_BYTES) {
      checks.push({ key: "freeSpace", label: "Espace libre", status: "warn", message: "< 1 Go — espace réduit" });
    } else {
      checks.push({ key: "freeSpace", label: "Espace libre", status: "ok", message: "≥ 1 Go disponibles" });
    }
    checks.push({ key: "volume", label: "Accès volume", status: (facts && facts.writable) ? "ok" : "err", message: (facts && facts.writable) ? "Volume accessible" : "Volume inaccessible" });
    checks.push({ key: "transfers", label: "Réception transferts", status: (facts && facts.writable) ? "ok" : "err", message: (facts && facts.writable) ? "Réception des transferts OK" : "Impossible de recevoir les transferts" });
    return checks;
  }

  /* ---------- réduction / éligibilité / incidents ---------- */

  function lineRank(st) {
    if (st === "err") return 3;
    if (st === "warn") return 2;
    if (st === "pending") return 1;
    return 0; /* ok */
  }

  function reduceStatus(checks) {
    var max = -1;
    (checks || []).forEach(function (c) {
      var r = lineRank(c && c.status);
      if (r > max) max = r;
    });
    if (max <= 0) return checks && checks.length ? STATUS_READY : STATUS_ARMING;
    if (max === 1) return STATUS_ARMING;
    if (max === 2) return STATUS_WARNING;
    return STATUS_ERROR;
  }

  function statusRank(st) {
    if (st === STATUS_ERROR) return 4;
    if (st === STATUS_WARNING) return 3;
    if (st === STATUS_ARMING) return 2;
    return 1; /* READY */
  }

  /* skills = [{ skill, status }]. REC éligible dès ≥1 Capture READY ou WARNING ;
   * Storage et ARMING/ERROR ne concourent pas (et un ERROR Capture ne bloque QUE
   * la Capture concernée). */
  function recEligible(skills) {
    return recEligibleCount(skills) >= 1;
  }

  function recEligibleCount(skills) {
    var n = 0;
    (skills || []).forEach(function (s) {
      if (s && s.skill === SKILL_CAPTURE && (s.status === STATUS_READY || s.status === STATUS_WARNING)) n++;
    });
    return n;
  }

  /* Incident = toute LIGNE en err/warn/pending de chaque skill sélectionné (la
   * modal liste les devices concernés avec leur icône de skill et le message).
   * Déterminé, ordre des devices conservé. */
  function incidentsOf(view) {
    var out = [];
    (view.devices || []).forEach(function (dev) {
      (dev.skills || []).forEach(function (sk) {
        (sk.checks || []).forEach(function (c) {
          var r = lineRank(c.status);
          if (r >= 1) {
            out.push({
              did: dev.did, deviceName: dev.deviceName, skill: sk.skill,
              skillStatus: sk.status, key: c.key, status: c.status, message: c.message
            });
          }
        });
      });
    });
    return out;
  }

  function incidentsEmpty(arr) { return !arr || arr.length === 0; }

  /* ---------- math NTP (pur) ---------- */

  /* rtt = temps de boucle : (t3−t0) − durée de traitement chez le pair (t2−t1). */
  function rttOf(t0, t1, t2, t3) { return (t3 - t0) - (t2 - t1); }

  /* offset = horloge du pair − horloge locale (NTP theta). Positive → pair en avance. */
  function offsetOf(t0, t1, t2, t3) { return ((t1 - t0) + (t2 - t3)) / 2; }

  /* État de synchronisation d'un ensemble d'échantillons {t0,t1,t2,t3}.
   * Échantillon choisi = RTT minimal (le plus fiable) ; dispersion = étendue des
   * offsets ; statut dégradé si |delta| > 50 ms OU dispersion > 50 ms (WARNING, non
   * bloquant, jamais bloquant REC). */
  function syncOfSamples(samples) {
    if (!samples || !samples.length) {
      return { status: "pending", message: "Synchronisation en cours", offsetMs: null, rttMs: null, dispersionMs: null, samples: 0, lastSyncMs: null };
    }
    var best = null, minRtt = Infinity, lo = +Infinity, hi = -Infinity, lastT3 = null;
    samples.forEach(function (s) {
      var rtt = rttOf(s.t0, s.t1, s.t2, s.t3);
      var off = offsetOf(s.t0, s.t1, s.t2, s.t3);
      if (rtt < minRtt) { minRtt = rtt; best = off; }
      if (off < lo) lo = off;
      if (off > hi) hi = off;
      if (isNum(s.t3) && (lastT3 === null || s.t3 > lastT3)) lastT3 = s.t3;
    });
    var dispersion = samples.length > 1 ? hi - lo : 0;
    var absOff = Math.abs(best);
    var degraded = absOff > SYNC_WARN_OFFSET_MS || dispersion > SYNC_WARN_DISPERSION_MS;
    return {
      status: degraded ? "warn" : "ok",
      message: degraded
        ? "Dégradée · delta " + Math.round(best) + " ms / dispersion " + Math.round(dispersion) + " ms"
        : "Stable · delta " + Math.round(best) + " ms",
      offsetMs: Math.round(best * 100) / 100,
      rttMs: Math.round(minRtt * 100) / 100,
      dispersionMs: Math.round(dispersion * 100) / 100,
      samples: samples.length,
      lastSyncMs: lastT3
    };
  }

  /* Ligne "Synchronisation" du détail Capture (côté requeur). */
  function syncCheckLine(clockState, isSelf) {
    if (isSelf) {
      return { key: "sync", label: "Synchronisation", status: "ok", message: "Référence locale", offsetMs: 0, rttMs: 0, dispersionMs: 0, samples: 1 };
    }
    if (!clockState) {
      return { key: "sync", label: "Synchronisation", status: "pending", message: "Synchronisation en cours", offsetMs: null, rttMs: null, dispersionMs: null, samples: 0 };
    }
    return {
      key: "sync", label: "Synchronisation", status: clockState.status, message: clockState.message,
      offsetMs: clockState.offsetMs, rttMs: clockState.rttMs, dispersionMs: clockState.dispersionMs, samples: clockState.samples
    };
  }

  /* ---------- machine déterministe (createMachine) ---------- */

  /* deps = {
   *   nowMs(): number,
   *   schedule(fn, ms): token, clearSchedule(token): void,
   *   loadSession(sid): Promise<session|undefined>,
   *   selfDid(): string,
   *   isConnected(did): bool,          // self → toujours true
   *   assessSelf(session, take): Promise<[ {deviceId, skill, checks} ]>,  // checks sans connexion/sync
   *   sendArmRequest(session, req),    // req = {armCycleId, takeNumber, targets, skills}
   *   sendClockRequest(session, req),  // req = {armCycleId, requestId, target}
   *   log(line): void,
   *   onChange?(): void
   * } */
  function createMachine(deps) {
    var now = deps.nowMs || function () { return 0; };
    var sched = deps.schedule || function () { return null; };
    var clearSched = deps.clearSchedule || function () {};
    var self = deps.selfDid || function () { return ""; };
    var log = deps.log || function () {};

    var state = {
      active: false,
      sid: null,
      takeNumber: 0,
      attempt: 0,
      armCycleId: null,
      session: null,
      startedAtMs: 0,
      attempts: {},          /* "sid#take" -> nombre de tentatives démarrées */
      devices: [],           /* {did, deviceName, skills: {skill: {status, rawChecks, awaiting, timedOut, deadline, lastAtMs}}} */
      disconnected: {},      /* did -> true quand déclaré déconnecté */
      clock: {},             /* did -> {samples:[], status, message, offsetMs, rttMs, dispersionMs, lastSyncMs} */
      pendingClock: null,    /* {did, requestId, t0, armCycleId, timer} */
      clockSeq: 0,
      refreshTimer: null,
      sampleTimer: null,
      recEligible: false,
      incidents: [],
      rev: 0
    };

    var device = function (did) {
      for (var i = 0; i < state.devices.length; i++) if (state.devices[i].did === did) return state.devices[i];
      return null;
    };

    var lastTake = function (session) {
      var arr = (session && session.takes) || [];
      return arr.length ? arr[arr.length - 1] : null;
    };

    var bump = function () {
      state.rev++;
      if (deps.onChange) deps.onChange();
    };

    var recompute = function () {
      var skills = [];
      state.devices.forEach(function (dev) {
        Object.keys(dev.skills).forEach(function (k) {
          skills.push({ skill: k, status: dev.skills[k].status });
        });
      });
      var elig = recEligible(skills);
      if (elig !== state.recEligible) {
        log("REC_ELIGIBILITY sessionId=" + (state.sid || "?") + " take=" + state.takeNumber
          + " armCycleId=" + (state.armCycleId || "?") + " eligible=" + (elig ? 1 : 0)
          + " readyOrWarningCaptures=" + recEligibleCount(skills));
      }
      state.recEligible = elig;
      var view = makeView(skills);
      state.incidents = incidentsOf(view);
      bump();
      return view;
    };

    /* Vue de rendu : lignes finales = rawChecks + connexion (côté requeur) + synchronisation
     * (côté requeur pour une Capture). */
    var makeView = function (skills) {
      var deviceView = state.devices.map(function (dev) {
        var sks = [];
        if (dev.skills.capture) sks.push({ skill: SKILL_CAPTURE, sk: dev.skills.capture });
        if (dev.skills.storage) sks.push({ skill: SKILL_STORAGE, sk: dev.skills.storage });
        return {
          did: dev.did,
          deviceName: dev.deviceName,
          skills: sks.map(function (pair) {
            var sk = pair.sk;
            return {
              skill: pair.skill,
              status: sk.status,
              lastAtMs: sk.lastAtMs,
              checks: finalizeChecks(dev.did, pair.skill, sk.rawChecks)
            };
          })
        };
      });
      var clockView = {};
      var dids = Object.keys(state.clock);
      for (var i = 0; i < dids.length; i++) {
        var d = dids[i];
        var cl = state.clock[d];
        clockView[d] = {
          status: cl.status,
          message: cl.message,
          offsetMs: cl.offsetMs,
          rttMs: cl.rttMs,
          dispersionMs: cl.dispersionMs,
          samples: cl.samples.length,
          samplesRaw: cl.samples,
          lastSyncMs: cl.lastSyncMs
        };
      }
      return {
        active: state.active,
        sid: state.sid,
        takeNumber: state.takeNumber,
        attempt: state.attempt,
        armCycleId: state.armCycleId,
        startedAtMs: state.startedAtMs,
        rev: state.rev,
        devices: deviceView,
        clock: clockView,
        skills: skills || [],
        recEligible: state.recEligible,
        incidents: state.incidents,
        incidentsEmpty: incidentsEmpty(state.incidents)
      };
    };

    var connectionLine = function (did) {
      var ok = deps.isConnected ? deps.isConnected(did) : true;
      return {
        key: "connection", label: "Connexion",
        status: ok ? "ok" : "err",
        message: ok ? "Connexion établie" : "Déconnecté"
      };
    };

    var finalizeChecks = function (did, skill, rawChecks) {
      var out = [connectionLine(did)];
      (rawChecks || []).forEach(function (c) {
        if (c && c.key !== "connection") out.push(c);
      });
      if (skill === SKILL_CAPTURE) {
        out.push(syncCheckLine(state.clock[did] || null, did === self()));
      }
      return out;
    };

    var flattenSkills = function () {
      var out = [];
      state.devices.forEach(function (dev) {
        Object.keys(dev.skills).forEach(function (k) {
          out.push({ skill: k, status: dev.skills[k].status });
        });
      });
      return out;
    };

    /* ---- deadlines (attente initiale 5 s, réponse tardive toujours prise en compte) ---- */

    var scheduleDeadline = function (did, skill) {
      var dev = device(did);
      var sk = dev && dev.skills[skill];
      if (!dev || !sk || sk.deadline) return;
      var cycleAtSchedule = state.armCycleId;
      sk.deadline = sched(function () {
        if (!state.active || !state.armCycleId || state.armCycleId !== cycleAtSchedule) return;
        if (!sk.awaiting) return;
        sk.timedOut = true;
        sk.deadline = null;
        sk.status = STATUS_ERROR;
        log("ARM_TIMEOUT sessionId=" + state.sid + " armCycleId=" + state.armCycleId
          + " deviceId=" + did + " skill=" + skill + " waitedMs=" + FIRST_RESULT_TIMEOUT_MS);
        log("ARM_STATE_CHANGED sessionId=" + state.sid + " armCycleId=" + state.armCycleId
          + " deviceId=" + did + " skill=" + skill + " status=ERROR");
        recompute();
      }, FIRST_RESULT_TIMEOUT_MS);
    };

    var clearDeadline = function (did, skill) {
      var dev = device(did);
      var sk = dev && dev.skills[skill];
      if (sk && sk.deadline) { clearSched(sk.deadline); sk.deadline = null; }
    };

    /* ---- évaluation locale de soi-même ---- */

    var evaluateSelf = function () {
      var selfDev = device(self());
      if (!selfDev || !state.session) return Promise.resolve();
      return Promise.resolve(deps.assessSelf(state.session, lastTake(state.session)))
        .then(function (results) {
          (results || []).forEach(function (r) { processResult(r); });
        })
        .catch(function (err) {
          log("ARM_SELF_EVAL_ERROR sessionId=" + state.sid + " armCycleId=" + state.armCycleId
            + " err=" + String((err && err.message) || err));
        });
    };

    /* ---- requêtes / réponses ---- */

    var requestRemote = function () {
      var targets = [];
      state.devices.forEach(function (dev) {
        if (dev.did !== self()) targets.push(dev.did);
      });
      if (!targets.length) return;
      var req = { armCycleId: state.armCycleId, takeNumber: state.takeNumber, targets: targets, skills: [SKILL_CAPTURE, SKILL_STORAGE] };
      deps.sendArmRequest(state.session, req);
      log("ARM_REQUEST sessionId=" + state.sid + " armCycleId=" + state.armCycleId
        + " targets=[" + targets.join(",") + "]");
    };

    /* Ingestion d'un arm_result (d'abord les validations de cycle). */
    var processResult = function (r) {
      var sid = r.sessionId || state.sid;
      var cid = r.armCycleId || state.armCycleId;
      if (!state.active || !state.armCycleId) {
        log("ARM_IGNORE_STALE reason=not_active deviceId=" + (r.deviceId || "?") + " skill=" + (r.skill || "?"));
        return false;
      }
      if (sid !== state.sid || cid !== state.armCycleId) {
        log("ARM_IGNORE_STALE sessionId=" + sid + " armCycleId=" + cid
          + " active=" + state.armCycleId + " deviceId=" + (r.deviceId || "?")
          + " reason=stale_cycle");
        return false;
      }
      if (typeof r.takeNumber === "number" && r.takeNumber !== state.takeNumber) {
        log("ARM_IGNORE_STALE sessionId=" + sid + " armCycleId=" + cid
          + " deviceId=" + (r.deviceId || "?") + " take=" + r.takeNumber
          + " expected=" + state.takeNumber + " reason=take_mismatch");
        return false;
      }
      var dev = device(r.deviceId);
      var sk = dev && dev.skills[r.skill];
      if (!dev || !sk) {
        log("ARM_IGNORE_STALE sessionId=" + sid + " armCycleId=" + cid
          + " deviceId=" + (r.deviceId || "?") + " skill=" + (r.skill || "?") + " reason=not_selected");
        return false;
      }
      var prev = sk.status;
      sk.rawChecks = (r.checks || []).slice();
      sk.awaiting = false;
      sk.lastAtMs = r.generatedAtMs || now();
      clearDeadline(r.deviceId, r.skill);
      sk.status = reduceStatus(finalizeChecks(r.deviceId, r.skill, sk.rawChecks));
      delete state.disconnected[r.deviceId];
      if (sk.timedOut && sk.status !== STATUS_ERROR) {
        /* réponse tardive : le skill QUITTE l'erreur (même si encore ARMING en
         * attente de sync — la récupération est déjà effective) */
        log("ARM_RECOVER sessionId=" + state.sid + " armCycleId=" + state.armCycleId
          + " deviceId=" + r.deviceId + " skill=" + r.skill + " from=ERROR to=" + sk.status);
      }
      sk.timedOut = false;
      log("ARM_RESULT sessionId=" + state.sid + " armCycleId=" + state.armCycleId
        + " deviceId=" + r.deviceId + " skill=" + r.skill + " status=" + sk.status
        + (prev !== sk.status ? " from=" + prev : ""));
      if (prev !== sk.status) {
        log("ARM_STATE_CHANGED sessionId=" + state.sid + " armCycleId=" + state.armCycleId
          + " deviceId=" + r.deviceId + " skill=" + r.skill + " status=" + sk.status);
      }
      recompute();
      return true;
    };

    /* ---- connectivité ---- */

    var syncConnectivity = function () {
      if (!state.active) return;
      state.devices.forEach(function (dev) {
        if (dev.did === self()) return;
        var isC = deps.isConnected ? deps.isConnected(dev.did) : true;
        if (!isC) {
          if (state.disconnected[dev.did]) return;
          state.disconnected[dev.did] = true;
          Object.keys(dev.skills).forEach(function (k) {
            var sk = dev.skills[k];
            sk.status = STATUS_ERROR;
            clearDeadline(dev.did, k);
            sk.awaiting = true;
            log("ARM_STATE_CHANGED sessionId=" + state.sid + " armCycleId=" + state.armCycleId
              + " deviceId=" + dev.did + " skill=" + k + " status=ERROR check=connection");
          });
          recompute();
        } else if (state.disconnected[dev.did]) {
          delete state.disconnected[dev.did];
          Object.keys(dev.skills).forEach(function (k) {
            var sk = dev.skills[k];
            sk.status = STATUS_ARMING;
            sk.awaiting = true;
            sk.rawChecks = [];
            log("ARM_STATE_CHANGED sessionId=" + state.sid + " armCycleId=" + state.armCycleId
              + " deviceId=" + dev.did + " skill=" + k + " status=ARMING check=reconnect");
          });
          recompute();
        }
      });
      /* après traitement, on re-sollicite les pairs reconnectés pour relancer une évaluation */
      requestRemote();
    };

    /* ---- horloge (sampling requeur, TOUS les captures distants, déterministe) ---- */

    var remoteCaptureDids = function () {
      return state.devices.filter(function (d) { return d.did !== self() && d.skills.capture; })
        .map(function (d) { return d.did; });
    };

    /* Ordonnanceur : échantillonne un à un les captures distants (ordre des devices)
     * tant qu'un device n'a pas atteint CLOCK_SAMPLES_TARGET ; aucune requête en
     * vol ; appels depuis onClockReply / clockTimeout à 500 ms d'intervalle. */
    var pumpClockSamples = function () {
      if (!state.active || state.pendingClock) return;
      var dids = remoteCaptureDids();
      var target = null;
      for (var i = 0; i < dids.length; i++) {
        var d = dids[i];
        var n = state.clock[d] ? state.clock[d].samples.length : 0;
        if (n < CLOCK_SAMPLES_TARGET) { target = d; break; }
      }
      if (target) sampleOnce(target);
    };

    var clockTimeout = function (did) {
      if (state.pendingClock && state.pendingClock.did === did) {
        state.pendingClock = null;
        log("CLOCK_SYNC_DROP peer=" + did + " reason=timeout");
        state.sampleTimer = sched(pumpClockSamples, CLOCK_SAMPLE_SPACING_MS);
      }
    };

    var sampleOnce = function (did) {
      if (!state.active || state.pendingClock || did === self()) return;
      var dev = device(did);
      if (!dev || !dev.skills.capture) return;
      state.clockSeq++;
      var requestId = state.clockSeq;
      var t0 = now();
      state.pendingClock = {
        did: did, requestId: requestId, t0: t0,
        armCycleId: state.armCycleId,
        timer: sched(function () { clockTimeout(did); }, CLOCK_SAMPLE_TIMEOUT_MS)
      };
      deps.sendClockRequest(state.session, { armCycleId: state.armCycleId, requestId: requestId, target: did });
    };

    var refreshCaptureSkillSync = function (did) {
      var dev = device(did);
      var sk = dev && dev.skills.capture;
      if (!sk) return;
      var prev = sk.status;
      sk.status = reduceStatus(finalizeChecks(did, SKILL_CAPTURE, sk.rawChecks));
      if (prev !== sk.status) {
        log("ARM_STATE_CHANGED sessionId=" + state.sid + " armCycleId=" + state.armCycleId
          + " deviceId=" + did + " skill=capture status=" + sk.status + " check=sync");
      }
      recompute();
    };

    var onClockReply = function (env) {
      if (!state.active || env.sessionId !== state.sid || env.armCycleId !== state.armCycleId) {
        log("CLOCK_SYNC_IGNORE sessionId=" + env.sessionId + " armCycleId=" + env.armCycleId
          + " active=" + state.armCycleId + " reason=stale_cycle");
        return;
      }
      var p = state.pendingClock;
      if (!p || p.requestId !== env.requestId || p.did !== env.from) {
        log("CLOCK_SYNC_IGNORE sessionId=" + env.sessionId + " armCycleId=" + env.armCycleId
          + " peer=" + (env.from || "?") + " req=" + env.requestId
          + " expected=" + (p ? p.requestId : "none") + " reason=request_mismatch");
        return;
      }
      if (p.timer) clearSched(p.timer);
      state.pendingClock = null;
      if (!isNum(env.t1) || !isNum(env.t2)) {
        log("CLOCK_SYNC_DROP peer=" + p.did + " reason=malformed");
        state.sampleTimer = sched(pumpClockSamples, CLOCK_SAMPLE_SPACING_MS);
        return;
      }
      var t3 = now();
      var cl = state.clock[p.did] || (state.clock[p.did] = { samples: [] });
      cl.samples.push({ t0: p.t0, t1: env.t1, t2: env.t2, t3: t3 });
      if (cl.samples.length > CLOCK_SAMPLES_MAX) cl.samples.shift();
      var st = syncOfSamples(cl.samples);
      cl.status = st.status;
      cl.message = st.message;
      cl.offsetMs = st.offsetMs;
      cl.rttMs = st.rttMs;
      cl.dispersionMs = st.dispersionMs;
      cl.lastSyncMs = st.lastSyncMs;
      log("CLOCK_SYNC peer=" + p.did + " offset=" + Math.round(st.offsetMs) + "ms"
        + " rtt=" + Math.round(st.rttMs) + "ms samples=" + st.samples
        + " dispersion=" + Math.round(st.dispersionMs) + "ms");
      refreshCaptureSkillSync(p.did);
      /* la suite : même device tant qu'il n'a pas atteint la cible, sinon on pompe
       * le device suivant (ordre des devices) */
      var n = cl.samples.length;
      if (n < CLOCK_SAMPLES_TARGET) {
        state.sampleTimer = sched(function () { sampleOnce(p.did); }, CLOCK_SAMPLE_SPACING_MS);
      } else {
        state.sampleTimer = sched(pumpClockSamples, CLOCK_SAMPLE_SPACING_MS);
      }
    };

    /* ---- boucle de rafraîchissement "live" ---- */

    var scheduleRefresh = function () {
      state.refreshTimer = sched(function () {
        refreshLoop();
        if (state.active) scheduleRefresh();
      }, REFRESH_MS);
    };

    var refreshLoop = function () {
      if (!state.active) return;
      var sid = state.sid;
      Promise.resolve(deps.loadSession(sid)).then(function (ses) {
        if (!state.active || sid !== state.sid) return;
        if (!ses || ses.state === "closed") {
          cancelInternal("session_closed");
          return;
        }
        var take = lastTake(ses);
        if (take && state.takeNumber && take.takeNumber !== state.takeNumber) {
          log("ARM_CANCEL sessionId=" + state.sid + " armCycleId=" + state.armCycleId + " reason=take_changed (nouveau Take " + take.takeNumber + ")");
          clearTimers();
          state.active = false;
          start(sid);
          return;
        }
        state.session = ses;
        rebuildDevices(ses, take);
        requestRemote();
        syncConnectivity();
        evaluateSelf();
        pumpClockSamples();
      }).catch(function (err) {
        log("ARM_REFRESH_ERROR sessionId=" + sid + " err=" + String((err && err.message) || err));
      });
    };

    /* Reconstruit la liste des devices (membres/take à jour) en préservant l'état
     * des skills encore présents et en réinitialisant les nouveaux. */
    var rebuildDevices = function (ses, take) {
      var prev = state.devices;
      var fresh = orderedDevices(take, ses.members || []);
      state.devices = fresh.map(function (d) {
        var old = null;
        for (var i = 0; i < prev.length; i++) if (prev[i].did === d.did) { old = prev[i]; break; }
        var skills = {};
        d.skills.forEach(function (k) {
          var oldSk = old && old.skills[k];
          skills[k] = {
            status: oldSk ? oldSk.status : STATUS_ARMING,
            rawChecks: oldSk ? (oldSk.rawChecks || []).slice() : [],
            awaiting: oldSk ? oldSk.awaiting : !(d.did === self()),
            timedOut: oldSk ? oldSk.timedOut : false,
            deadline: null,
            lastAtMs: oldSk ? oldSk.lastAtMs : 0
          };
        });
        return { did: d.did, deviceName: d.deviceName, skills: skills };
      });
    };

    var clearTimers = function () {
      if (state.refreshTimer) { clearSched(state.refreshTimer); state.refreshTimer = null; }
      if (state.sampleTimer) { clearSched(state.sampleTimer); state.sampleTimer = null; }
      if (state.pendingClock && state.pendingClock.timer) { clearSched(state.pendingClock.timer); state.pendingClock = null; }
      state.devices.forEach(function (dev) {
        Object.keys(dev.skills).forEach(function (k) {
          clearDeadline(dev.did, k);
        });
      });
    };

    /* ---- API publique de la machine ---- */

    function start(sid) {
      if (!sid) return Promise.resolve(makeView([]));
      if (state.active) cancelInternal("restart");
      var sidAtCall = sid;
      return Promise.resolve(deps.loadSession(sid)).then(function (ses) {
        if (!ses) {
          log("ARM_START sessionId=" + sidAtCall + " take=— reason=unknown_session");
          state.sid = sidAtCall;
          bump();
          return makeView([]);
        }
        var take = lastTake(ses);
        var takeNumber = take ? take.takeNumber : 0;
        var key = sidAtCall + "#" + takeNumber;
        var attempt = (state.attempts[key] || 0) + 1;
        state.attempts[key] = attempt;
        state.active = true;
        state.sid = sidAtCall;
        state.session = ses;
        state.takeNumber = takeNumber;
        state.attempt = attempt;
        state.armCycleId = cycleId(sidAtCall, takeNumber, attempt);
        state.startedAtMs = now();
        state.disconnected = {};
        state.clock = {};
        state.pendingClock = null;
        state.devices = orderedDevices(take, ses.members || []).map(function (d) {
          var skills = {};
          d.skills.forEach(function (k) {
            skills[k] = {
              status: STATUS_ARMING,
              rawChecks: [],
              awaiting: !(d.did === self()),
              timedOut: false,
              deadline: null,
              lastAtMs: 0
            };
          });
          return { did: d.did, deviceName: d.deviceName, skills: skills };
        });
        log("ARM_START sessionId=" + sidAtCall + " take=" + takeNumber + " attempt=" + attempt
          + " armCycleId=" + state.armCycleId
          + " targets=[" + state.devices.map(function (d) { return d.did; }).join(",") + "]"
          + " selected=" + state.devices.length);
        recompute();
        /* deadlines : chaque (device, skill) attendu dans 5 s (dont soi-même si son
         * évaluation locale échoue) */
        state.devices.forEach(function (dev) {
          Object.keys(dev.skills).forEach(function (k) { scheduleDeadline(dev.did, k); });
        });
        /* évaluation locale + requêtes aux pairs + sampling d'horloge + boucle live */
        evaluateSelf();
        requestRemote();
        pumpClockSamples();
        scheduleRefresh();
        return makeView(flattenSkills());
      });
    }

    var cancelInternal = function (reason) {
      if (!state.active) return;
      log("ARM_CANCEL sessionId=" + (state.sid || "?") + " armCycleId=" + (state.armCycleId || "?") + " reason=" + reason);
      clearTimers();
      state.active = false;
      state.pendingClock = null;
      state.devices = [];
      state.clock = {};
      state.disconnected = {};
      recompute();
    };

    /* Point d'entrée des messages du transport (à la fois requeur et répondeur). */
    var onIncoming = function (env, reply) {
      if (env.kind === "arm_request") {
        /* Rôle RÉPONDEUR : la cible répond sur la même connexion. */
        if (!env.sessionId || !env.armCycleId || !Array.isArray(env.targets)) {
          log("ARM_REQUEST_DROP reason=malformed from=" + (env.from || "?"));
          return;
        }
        if (env.targets.indexOf(self()) < 0) return; /* pas un device cible : ne pas répondre */
        Promise.resolve(deps.loadSession(env.sessionId)).then(function (ses) {
          if (!ses) {
            log("ARM_REQUEST_DROP sessionId=" + env.sessionId + " reason=unknown_session from=" + (env.from || "?"));
            return;
          }
          var take = lastTake(ses);
          if (!take || take.takeNumber !== env.takeNumber) {
            log("ARM_REQUEST_DROP sessionId=" + env.sessionId + " take=" + env.takeNumber
              + " reason=take_mismatch from=" + (env.from || "?"));
            return;
          }
          return Promise.resolve(deps.assessSelf(ses, take)).then(function (results) {
            if (!results || !results.length) return;
            var sent = 0;
            results.forEach(function (r) {
              if (r.deviceId !== self()) return;
              if (r.skill !== SKILL_CAPTURE && r.skill !== SKILL_STORAGE) return;
              var resp = {
                armCycleId: env.armCycleId,
                takeNumber: env.takeNumber,
                deviceId: r.deviceId,
                skill: r.skill,
                checks: r.checks,
                generatedAtMs: now()
              };
              if (reply) { reply("arm_result", resp); sent++; }
            });
            if (sent) {
              log("ARM_RESULT_SENT sessionId=" + env.sessionId + " armCycleId=" + env.armCycleId
                + " to=" + (env.from || "?") + " n=" + sent);
            }
          });
        }).catch(function (err) {
          log("ARM_REQUEST_ASSESS_ERROR sessionId=" + env.sessionId + " err=" + String((err && err.message) || err));
        });
        return;
      }
      if (env.kind === "arm_result") {
        processResult({
          sessionId: env.sessionId,
          armCycleId: env.armCycleId,
          takeNumber: env.takeNumber,
          deviceId: env.deviceId,
          skill: env.skill,
          checks: env.checks,
          generatedAtMs: env.generatedAtMs || now()
        });
        return;
      }
      if (env.kind === "clock_sync") {
        /* RÉPONDEUR horloge : t1 = reçu, t2 = émis (raccourci → précision augmentée). */
        if (env.target !== self()) return;
        if (reply) {
          reply("clock_sync_reply", {
            armCycleId: env.armCycleId, requestId: env.requestId,
            target: self(), t1: now(), t2: now()
          });
        }
        return;
      }
      if (env.kind === "clock_sync_reply") {
        onClockReply(env);
        return;
      }
    };

    var view = function () {
      return makeView(flattenSkills());
    };

    return {
      start: start,
      refresh: refreshLoop,
      cancel: function (reason) { cancelInternal(reason || "user"); },
      restart: function () { if (state.active) return start(state.sid); return Promise.resolve(view()); },
      syncConnectivity: syncConnectivity,
      onIncoming: onIncoming,
      view: view,
      state: state,
      isActive: function () { return state.active; },
      cycleIdFor: cycleId,
      samplesFor: function (did) { return state.clock[did] ? state.clock[did].samples.slice() : []; },
      attemptsFor: function (sid, takeNumber) { return state.attempts[sid + "#" + takeNumber] || 0; }
    };
  }

  /* ---------- export ---------- */

  return {
    FIRST_RESULT_TIMEOUT_MS: FIRST_RESULT_TIMEOUT_MS,
    REFRESH_MS: REFRESH_MS,
    CLOCK_SAMPLE_TIMEOUT_MS: CLOCK_SAMPLE_TIMEOUT_MS,
    CLOCK_SAMPLES_TARGET: CLOCK_SAMPLES_TARGET,
    CLOCK_SAMPLES_MAX: CLOCK_SAMPLES_MAX,
    CLOCK_SAMPLE_SPACING_MS: CLOCK_SAMPLE_SPACING_MS,
    FREE_WARN_BYTES: FREE_WARN_BYTES,
    SYNC_WARN_OFFSET_MS: SYNC_WARN_OFFSET_MS,
    SYNC_WARN_DISPERSION_MS: SYNC_WARN_DISPERSION_MS,
    SKILL_CAPTURE: SKILL_CAPTURE,
    SKILL_STORAGE: SKILL_STORAGE,
    STATUS_ARMING: STATUS_ARMING,
    STATUS_READY: STATUS_READY,
    STATUS_WARNING: STATUS_WARNING,
    STATUS_ERROR: STATUS_ERROR,
    cycleId: cycleId,
    isCycleFmt: isCycleFmt,
    cycleMatches: cycleMatches,
    orderedDevices: orderedDevices,
    requirePermissions: requirePermissions,
    assessCapture: assessCapture,
    assessStorage: assessStorage,
    reduceStatus: reduceStatus,
    statusRank: statusRank,
    recEligible: recEligible,
    recEligibleCount: recEligibleCount,
    incidentsOf: incidentsOf,
    incidentsEmpty: incidentsEmpty,
    rttOf: rttOf,
    offsetOf: offsetOf,
    syncOfSamples: syncOfSamples,
    syncCheckLine: syncCheckLine,
    createMachine: createMachine
  };
});