/* MultiCam — J16-A — reconstruction des DONNÉES ARCHIVÉES d'un Take.
 *
 * POURQUOI CE MODULE EXISTE
 * ------------------------
 * L'écran 09 (« Take arrêté ») affiche en DIRECT la vue du service START
 * (`start-service` → `start-model`) : `stopStates` (fait d'arrêt par Capture),
 * le plan (participantes) et la vue du service de transfert (barres par
 * Storage). Ces trois sources sont VOLATILES : à l'arrêt du Take, plus rien
 * n'est vivant. Un Take ouvert depuis l'historique (écran 15) ou depuis la
 * session (écran 03) n'a donc, historiquement, AUCUNE donnée à afficher —
 * d'où l'écran vide et la durée « 00:00:00 » constatés en J16 (inventaire
 * §4.1).
 *
 * Ce module RECONSTRUIT ce qui est RÉELLEMENT connu d'un Take arrêté, à
 * partir des données PERSISTÉES :
 *   - `take.captures` / `take.storages` : la sélection du Take (qui filme,
 *     où réplique) — toujours connue ;
 *   - `session.members` : les noms des devices ;
 *   - `take.summary.stopStates` : le fait d'arrêt PAR CAPTURE (J16-A) ;
 *   - `take.summary.replications` : l'état PAR COUPLE Capture → Storage
 *     (J16-A) ;
 *   - `take.summary.transfers` : l'état GLOBAL des transferts (J12), et
 *     l'historique des Takes antérieurs à J16-A (états d'arrêt par Capture,
 *     sans état de réplication).
 *
 * RÈGLES (non négociables)
 * ------------------------
 *  1. AUCUNE invention. Ce qui n'est pas dans les données persistées n'est
 *     pas affiché comme un fait : c'est signalé comme INDISPONIBLE.
 *  2. L'état GLOBAL d'un transfert (`summary.transferState`) ne permet JAMAIS
 *     de conclure qu'une réplication Capture → Storage est terminée. Seul
 *     l'état du COUPLE (`summary.replications`) le permet. Un Take ancien,
 *     sans donnée par couple, affiche donc « indisponible », jamais « Terminé ».
 *  3. L'état d'une Capture est DÉDUIT de SES réplications (comme en direct),
 *     pas de l'état global du Take.
 *  4. RÉTROCOMPATIBILITÉ : un Take antérieur à J16-A (pas de `stopStates`,
 *     pas de `replications`) se reconstruit quand même : la sélection
 *     (`captures`/`storages`) est connue, les faits d'arrêt sont lus dans
 *     `summary.transfers` (format J12), l'état de réplication est signalé
 *     indisponible.
 *
 * Le module est PUR : aucun DOM, aucun réseau, aucun service. Il ne fait que
 * transformer des DONNÉES PERSISTÉES en FAITS. La mise en forme et le DOM
 * restent dans `js/ui/take-stopped.js` (séparation reconstruction / affichage).
 */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(root);
  } else {
    root.MultiCamTakeArchiveModel = factory(root);
  }
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  /* ---------- énumérations sémantiques ---------- */

  /* État d'une Capture (ligne de l'écran 09). Les six premiers états sont
   * EXACTEMENT ceux du mode direct : la reconstruction archived parle donc la
   * même langue que l'écran vivant. Les trois derniers sont propres à
   * l'archivé : ils disent ce qui est su et ce qui ne l'est pas. */
  var ROW_ERROR = "ERROR";
  var ROW_DONE = "DONE";
  var ROW_TRANSFER = "TRANSFER";
  var ROW_WAITING_NETWORK = "WAITING_NETWORK";
  var ROW_WAITING = "WAITING";
  var ROW_RECORDED = "RECORDED";   /* Capture arrêtée, réplication non documentée */
  var ROW_PARTIAL = "PARTIAL";     /* une partie des destinations est documentée */
  var ROW_UNKNOWN = "UNKNOWN";     /* rien de connu sur cette Capture */

  /* État d'une barre (une destination de réplication). */
  var BAR_PENDING = "pending";
  var BAR_TRANSFERRING = "transferring";
  var BAR_VERIFYING = "verifying";
  var BAR_DONE = "done";
  var BAR_ERROR = "error";
  var BAR_WAITING_NETWORK = "waiting_network";
  var BAR_UNKNOWN = "unknown";     /* aucune donnée pour CE couple */

  /* État global du Take. */
  var TAKE_ERROR = "error";
  var TAKE_DONE = "done";
  var TAKE_RUNNING = "running";
  var TAKE_WAITING = "waiting";
  var TAKE_PARTIAL = "partial";
  var TAKE_UNKNOWN = "unknown";
  var TAKE_NONE = "none";

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function isStr(v) { return typeof v === "string" && v.length > 0; }

  function uniqueSorted(list) {
    var seen = {};
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (v) {
      if (!isStr(v) || seen[v]) return;
      seen[v] = true;
      out.push(v);
    });
    return out.sort();
  }

  /* ---------- entrées ---------- */

  /* Noms des devices (session.members) : identité = deviceId, jamais l'IP. */
  function nameMap(session) {
    var out = {};
    ((session && session.members) || []).forEach(function (m) {
      if (!m || !isStr(m.deviceId)) return;
      out[m.deviceId] = isStr(m.deviceName) && m.deviceName ? m.deviceName : m.deviceId;
    });
    return out;
  }

  /* Faits d'arrêt PAR CAPTURE.
   *
   * Source J16-A : `summary.stopStates` (clé = deviceId Capture).
   * Source J12 (Takes ANCIENS) : `summary.transfers`, dont les entrées
   *   indexées par un deviceId de Capture portent l'état « STOPPED » — c'est
   *   le seul format d'arrêt qui existait avant J16-A. On le lit, on ne le
   *   modifie pas. */
  function stopStatesOf(summary, captureIds) {
    var out = {};
    var map = (summary && summary.stopStates) || {};
    Object.keys(map).forEach(function (did) {
      var st = map[did];
      if (!st || typeof st !== "object") return;
      out[did] = {
        deviceId: isStr(st.deviceId) && st.deviceId ? st.deviceId : did,
        state: isStr(st.state) && st.state ? st.state : "STOPPED",
        deltaMs: isNum(st.deltaMs) ? st.deltaMs : null,
        actualMs: isNum(st.actualMs) ? st.actualMs : null,
        path: isStr(st.path) ? st.path : ""
      };
    });
    /* Repli J12 : entrée de `summary.transfers` dont la clé est une Capture
     * connue. Les réplications J16-A ont une clé « src|storage » : elles ne
     * peuvent donc pas être confondues avec un deviceId. */
    var legacy = (summary && summary.transfers) || {};
    captureIds.forEach(function (did) {
      if (out[did]) return;
      var l = legacy[did];
      if (!l || typeof l !== "object") return;
      if (l.state !== "STOPPED") return;
      out[did] = {
        deviceId: did,
        state: "STOPPED",
        deltaMs: isNum(l.deltaMs) ? l.deltaMs : null,
        actualMs: isNum(l.updatedAtMs) ? l.updatedAtMs : null,
        path: ""
      };
    });
    return out;
  }

  /* États de réplication PAR COUPLE Capture → Storage.
   *
   * Index par couple (et non par clé brute) : la clé persistée reste un
   * détail d'implémentation, le COUPLE est le fait. */
  function replicationsOf(summary) {
    var byPair = {};
    var map = (summary && summary.replications) || {};
    Object.keys(map).forEach(function (k) {
      var r = map[k];
      if (!r || typeof r !== "object") return;
      if (!isStr(r.sourceDeviceId) || !isStr(r.storageDeviceId)) return;
      byPair[r.sourceDeviceId + "|" + r.storageDeviceId] = {
        state: isStr(r.state) && r.state ? r.state : BAR_PENDING,
        error: isStr(r.error) ? r.error : "",
        bytes: isNum(r.bytes) && r.bytes >= 0 ? r.bytes : 0,
        total: isNum(r.total) && r.total >= 0 ? r.total : 0,
        percent: isNum(r.percent) && r.percent >= 0 ? Math.min(100, Math.round(r.percent)) : 0
      };
    });
    return byPair;
  }

  /* ---------- reconstruction ---------- */

  /* reconstruct({ take, session }) → faits archivés (pur).
   *
   * take   : Take persisté (sanitisé ou non — la lecture est défensive).
   * session: session persistée (pour les noms et l'intitulé). */
  function reconstruct(input) {
    input = input || {};
    var take = input.take || {};
    var session = input.session || {};
    var summary = (take.summary && typeof take.summary === "object") ? take.summary : {};
    var names = nameMap(session);

    var captures = uniqueSorted(take.captures);
    var storages = uniqueSorted(take.storages);
    var stops = stopStatesOf(summary, captures);
    var reps = replicationsOf(summary);
    var hasReplicationData = Object.keys(reps).length > 0;

    /* Durée : connue si le résumé la porte. Une durée nulle ET aucun fait
     * d'arrêt = information indisponible (pas « 00:00:00 » présenté comme un
     * fait). */
    var durationKnown = isNum(summary.durationMs) && summary.durationMs > 0;
    var durationMs = durationKnown ? summary.durationMs : 0;

    var rows = [];
    captures.forEach(function (did) {
      var name = names[did] || did;
      var stop = stops[did] || null;
      var dests = [];
      var knownCount = 0;
      storages.forEach(function (sid) {
        var rep = reps[did + "|" + sid] || null;
        if (rep) knownCount += 1;
        dests.push({
          storageDeviceId: sid,
          name: names[sid] || sid,
          state: rep ? rep.state : BAR_UNKNOWN,
          error: rep ? rep.error : "",
          bytes: rep ? rep.bytes : 0,
          total: rep ? rep.total : 0,
          percent: rep ? rep.percent : 0,
          known: !!rep
        });
      });
      rows.push({
        deviceId: did,
        name: name,
        stop: stop,
        stopKnown: !!stop,
        deltaMs: stop && isNum(stop.deltaMs) ? stop.deltaMs : null,
        path: stop ? (stop.path || "") : "",
        destinations: dests,
        knownDestinations: knownCount,
        state: rowStateOf(stop, dests, storages.length),
        replicationKnown: knownCount > 0
      });
    });

    var takeState = takeStateOf(rows, storages.length);
    var unavailable = unavailableOf({
      take: take, summary: summary, rows: rows, storages: storages,
      durationKnown: durationKnown, hasReplicationData: hasReplicationData
    });

    return {
      sessionId: isStr(session.sessionId) ? session.sessionId : "",
      sessionName: isStr(session.name) ? session.name : "",
      takeNumber: isNum(take.takeNumber) ? take.takeNumber : 0,
      status: isStr(take.status) ? take.status : "",
      durationMs: durationMs,
      durationKnown: durationKnown,
      stoppedAtMs: isNum(summary.stoppedAtMs) ? summary.stoppedAtMs : 0,
      captures: captures,
      storages: storages,
      rows: rows,
      state: takeState,
      unavailable: unavailable,
      /* État GLOBAL des transferts : exposé pour information et pour les
       * tests, JAMAIS utilisé pour dériver l'état d'une réplication (RÈGLE 2). */
      globalTransferState: isStr(summary.transferState) ? summary.transferState : "",
      hasReplicationData: hasReplicationData
    };
  }

  /* État d'une Capture, DEDUIT de ses destinations (RÈGLE 3). */
  function rowStateOf(stop, dests, storageCount) {
    if (!storageCount) {
      /* Aucune destination : l'arrêt de la Capture est le seul fait utile. */
      return stop ? ROW_DONE : ROW_UNKNOWN;
    }
    var known = dests.filter(function (d) { return d.known; });
    if (!known.length) {
      /* Aucune réplication documentée pour cette Capture : soit le Take est
       * ancien (rien n'était persisté), soit la Capture n'a jamais répliqué. */
      return stop ? ROW_RECORDED : ROW_UNKNOWN;
    }
    var anyError = known.some(function (d) { return d.state === BAR_ERROR; });
    if (anyError) return ROW_ERROR;
    var anyRun = known.some(function (d) { return d.state === BAR_TRANSFERRING || d.state === BAR_VERIFYING; });
    if (anyRun) return ROW_TRANSFER;
    var anyWaiting = known.some(function (d) { return d.state === BAR_WAITING_NETWORK; });
    if (anyWaiting) return ROW_WAITING_NETWORK;
    var anyPending = known.some(function (d) { return d.state === BAR_PENDING; });
    if (anyPending) return ROW_WAITING;
    var allDone = known.every(function (d) { return d.state === BAR_DONE; });
    if (allDone && known.length === dests.length) return ROW_DONE;
    if (allDone) return ROW_PARTIAL;   /* une destination n'est pas documentée */
    return ROW_PARTIAL;
  }

  /* État global du Take, dérivé des lignes (jamais de l'état global brut). */
  function takeStateOf(rows, storageCount) {
    if (!rows.length) return TAKE_NONE;
    if (rows.some(function (r) { return r.state === ROW_ERROR; })) return TAKE_ERROR;
    if (!storageCount) {
      var allStopped = rows.every(function (r) { return r.state === ROW_DONE; });
      return allStopped ? TAKE_DONE : TAKE_UNKNOWN;
    }
    if (rows.every(function (r) { return r.state === ROW_DONE; })) return TAKE_DONE;
    if (rows.some(function (r) { return r.state === ROW_TRANSFER || r.state === ROW_WAITING_NETWORK; })) return TAKE_RUNNING;
    if (rows.some(function (r) { return r.state === ROW_WAITING; })) return TAKE_WAITING;
    if (rows.some(function (r) { return r.state === ROW_PARTIAL; })) return TAKE_PARTIAL;
    if (rows.some(function (r) { return r.state === ROW_RECORDED; })) return TAKE_PARTIAL;
    return TAKE_UNKNOWN;
  }

  /* Ce qui n'est PAS connu, exprimé explicitement (RÈGLE 1 / exigence 6 de
   * l'arbitrage). Une liste de phrases lisibles, pas des drapeaux techniques. */
  function unavailableOf(ctx) {
    var out = [];
    if (!ctx.rows.length) {
      out.push("Aucune Capture sélectionnée pour ce Take.");
      return out;
    }
    if (!ctx.durationKnown) {
      out.push("Durée du Take indisponible pour cet enregistrement.");
    }
    if (!ctx.hasReplicationData && ctx.storages.length) {
      out.push("État des réplications indisponible : ce Take a été enregistré avant le suivi des réplications.");
    }
    var noStop = ctx.rows.filter(function (r) { return !r.stopKnown; });
    if (noStop.length) {
      out.push("Confirmation d'arrêt indisponible pour : " + noStop.map(function (r) { return r.name; }).join(", ") + ".");
    }
    var partial = ctx.rows.filter(function (r) {
      return r.knownDestinations > 0 && r.knownDestinations < r.destinations.length;
    });
    if (partial.length) {
      out.push("État de réplication indisponible pour une destination de : " + partial.map(function (r) { return r.name; }).join(", ") + ".");
    }
    var never = ctx.rows.filter(function (r) { return r.knownDestinations === 0 && r.destinations.length; });
    if (never.length && ctx.hasReplicationData) {
      out.push("Aucune réplication enregistrée pour : " + never.map(function (r) { return r.name; }).join(", ") + ".");
    }
    return out;
  }

  return {
    ROW_ERROR: ROW_ERROR,
    ROW_DONE: ROW_DONE,
    ROW_TRANSFER: ROW_TRANSFER,
    ROW_WAITING_NETWORK: ROW_WAITING_NETWORK,
    ROW_WAITING: ROW_WAITING,
    ROW_RECORDED: ROW_RECORDED,
    ROW_PARTIAL: ROW_PARTIAL,
    ROW_UNKNOWN: ROW_UNKNOWN,
    BAR_PENDING: BAR_PENDING,
    BAR_TRANSFERRING: BAR_TRANSFERRING,
    BAR_VERIFYING: BAR_VERIFYING,
    BAR_DONE: BAR_DONE,
    BAR_ERROR: BAR_ERROR,
    BAR_WAITING_NETWORK: BAR_WAITING_NETWORK,
    BAR_UNKNOWN: BAR_UNKNOWN,
    TAKE_ERROR: TAKE_ERROR,
    TAKE_DONE: TAKE_DONE,
    TAKE_RUNNING: TAKE_RUNNING,
    TAKE_WAITING: TAKE_WAITING,
    TAKE_PARTIAL: TAKE_PARTIAL,
    TAKE_UNKNOWN: TAKE_UNKNOWN,
    TAKE_NONE: TAKE_NONE,
    reconstruct: reconstruct
  };
});
