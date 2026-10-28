/* MultiCam J17-A — catalogue média des Takes archivés sur les Storages.
 *
 * OBJECTIF
 * --------
 * Un Master doit pouvoir SAVOIR, pour un Take arrêté, quels fichiers
 * originaux existent encore, sur QUEL Storage, et par quel chemin HTTP les
 * lire en flux (lecture progressive + seek par Range). Ce module ne lit aucun
 * fichier, n'ouvre aucune connexion et ne crée aucun serveur : il transforme
 * des FAITS (Take persisté, catalogue renvoyé par un Storage, présence des
 * pairs) en un modèle de disponibilité déterministe.
 *
 * RÈGLES NON NÉGOCIABLES
 * ----------------------
 *  1. `summary.transferState === "TERMINATED"` NE PROUVE RIEN. La disponibilité
 *     se vérifie PAR COUPLE Capture → Storage (`summary.replications`) ET par
 *     la présence RÉELLE du fichier dans la liste disque du Storage.
 *  2. Un Take qui n'est pas ARRÊTÉ n'a pas de média disponible : aucune
 *     lecture ne doit commencer pendant l'enregistrement.
 *  3. Une rumeur n'est pas un fait : un catalogue reçu avec `ok:false`, une
 *     entrée absente ou un fichier non listé rendent la copie INDISPONIBLE
 *     avec une raison explicite. On n'invente jamais un `rel`.
 *  4. Un Storage hors ligne N'EFFACE PAS l'historique : ses dernières copies
 *     connues restent dans le modèle, marquées `storage_offline`, et
 *     `summary.replications` n'est jamais modifié par ce module.
 *  5. Aucun chemin de système de fichiers n'est exposé : seuls le `rel`
 *     (relatif à la racine média du Take) et une URL HTTP confinée le sont.
 */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.MultiCamMediaCatalogueModel = factory();
  }
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* Raisons de non-disponibilité. Stables et parsables (logs/tests/UI). */
  var R = {
    TAKE_NOT_STOPPED: "take_not_stopped",
    INVALID_REL: "invalid_rel",
    REPLICATION_UNKNOWN: "replication_unknown",
    REPLICATION_ERROR: "replication_error",
    REPLICATION_NOT_DONE: "replication_not_done",
    STORAGE_OFFLINE: "storage_offline",
    STORAGE_PENDING: "storage_pending",
    STORAGE_UNKNOWN: "storage_unknown",
    STORAGE_UNSUPPORTED: "storage_unsupported",
    STORAGE_ERROR: "storage_error",
    FILE_MISSING: "file_missing",
    FILE_EMPTY: "file_empty",
    FILE_SIZE_MISMATCH: "file_size_mismatch"
  };

  var ST_READY = "ready";
  var ST_PENDING = "pending";
  var ST_ERROR = "error";
  var ST_OFFLINE = "offline";
  var ST_UNKNOWN = "unknown";

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

  /* Un segment de chemin sûr : ni vide, ni « . », ni « .. », ni séparateur,
   * ni octet nul. C'est la même règle que le routeur HTTP natif. */
  function safeSegment(v) {
    var s = String(v == null ? "" : v);
    if (!s.length) return "";
    if (s === "." || s === "..") return "";
    if (s.indexOf("/") >= 0 || s.indexOf("\\") >= 0 || s.indexOf("\0") >= 0) return "";
    return s;
  }

  /* Normalise un chemin RELATIF de média. Rend "" si dangereux : jamais de
   * chemin absolu, jamais de remontée, jamais de schéma `file:`. */
  function sanitizeRel(rel) {
    var s = String(rel == null ? "" : rel);
    if (!s.length) return "";
    if (s.charAt(0) === "/" || s.indexOf("\\") >= 0 || s.indexOf("\0") >= 0) return "";
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return "";
    var parts = s.split("/");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = safeSegment(parts[i]);
      if (!p) return "";
      out.push(p);
    }
    return out.join("/");
  }

  function encodeRel(rel) {
    var safe = sanitizeRel(rel);
    if (!safe) return "";
    return safe.split("/").map(encodeURIComponent).join("/");
  }

  /* ---------- faits d'arrêt ---------- */

  /* Captures dont l'arrêt est PROUVÉ : `summary.stopStates` (J16-A), avec le
   * repli J12 `summary.transfers[capture].state === "STOPPED"`. */
  function stoppedCaptures(take) {
    var summary = (take && take.summary && typeof take.summary === "object") ? take.summary : {};
    var caps = uniqueSorted(take && take.captures);
    var map = (summary.stopStates && typeof summary.stopStates === "object") ? summary.stopStates : {};
    var legacy = (summary.transfers && typeof summary.transfers === "object") ? summary.transfers : {};
    var out = {};
    caps.forEach(function (did) {
      if (map[did] && typeof map[did] === "object") { out[did] = true; return; }
      var l = legacy[did];
      if (l && typeof l === "object" && l.state === "STOPPED") out[did] = true;
    });
    return out;
  }

  /* Le Take est-il ARRÊTÉ ? Si des faits d'arrêt existent, ils font foi pour
   * CHAQUE Capture. Sinon seulement, on retombe sur un statut terminal connu
   * (Takes antérieurs à J16-A). */
  function takeStopped(take) {
    var caps = uniqueSorted(take && take.captures);
    var stops = stoppedCaptures(take);
    if (caps.length) {
      var known = caps.filter(function (d) { return !!stops[d]; }).length;
      if (known === caps.length) return true;
      if (known === 0) {
        var st = String((take && take.status) || "");
        return st === "STOPPED" || st === "TERMINATED" || st === "ARCHIVED";
      }
      return false;
    }
    var status = String((take && take.status) || "");
    return status === "STOPPED" || status === "TERMINATED" || status === "ARCHIVED";
  }

  /* Réplications persistées PAR COUPLE (`src|sto`), jamais l'état global. */
  function replicationMap(take) {
    var out = {};
    var map = (take && take.summary && take.summary.replications) || {};
    Object.keys(map).forEach(function (k) {
      var r = map[k];
      if (!r || typeof r !== "object") return;
      if (!isStr(r.sourceDeviceId) || !isStr(r.storageDeviceId)) return;
      out[r.sourceDeviceId + "|" + r.storageDeviceId] = {
        state: isStr(r.state) ? r.state : "",
        error: isStr(r.error) ? r.error : "",
        bytes: isNum(r.bytes) && r.bytes >= 0 ? r.bytes : 0,
        total: isNum(r.total) && r.total >= 0 ? r.total : 0
      };
    });
    return out;
  }

  function nameMap(session) {
    var out = {};
    ((session && session.members) || []).forEach(function (m) {
      if (!m || !isStr(m.deviceId)) return;
      out[m.deviceId] = isStr(m.deviceName) ? m.deviceName : m.deviceId;
    });
    return out;
  }

  /* ---------- catalogue d'un Storage ---------- */

  /* Normalise une réponse `media_catalogue_reply` en un fait manipulable.
   * Tolérant : une entrée absente ou mal formée devient une erreur explicite,
   * jamais une disponibilité implicite. */
  function normalizeCatalogue(raw) {
    if (!raw || typeof raw !== "object") return null;
    var ok = raw.ok !== false && raw.state !== ST_ERROR;
    var out = {
      ok: ok,
      reason: isStr(raw.reason) ? raw.reason : "",
      endpoint: null,
      token: isStr(raw.token) ? raw.token : "",
      sources: {},
      atMs: isNum(raw.atMs) ? raw.atMs : 0
    };
    var ep = raw.endpoint || {};
    var host = isStr(ep.host) ? ep.host : "";
    var port = isNum(ep.port) ? ep.port : (parseInt(ep.port, 10) || 0);
    if (host && port > 0 && !/[\/\s]/.test(host)) out.endpoint = { host: host, port: port };
    (Array.isArray(raw.sources) ? raw.sources : []).forEach(function (src) {
      if (!src || !isStr(src.sourceDeviceId)) return;
      var did = safeSegment(src.sourceDeviceId);
      if (!did) return;
      var files = {};
      (Array.isArray(src.files) ? src.files : []).forEach(function (f) {
        if (!f) return;
        var rel = sanitizeRel(f.rel);
        if (!rel) return;
        files[rel] = { rel: rel, bytes: isNum(f.bytes) && f.bytes >= 0 ? f.bytes : 0 };
      });
      out.sources[did] = {
        sourceDeviceId: did,
        replicationState: isStr(src.replicationState) ? src.replicationState : "",
        error: isStr(src.error) ? src.error : "",
        files: files
      };
    });
    return out;
  }

  function endpointUrl(endpoint) {
    if (!endpoint || !isStr(endpoint.host) || !isNum(endpoint.port) || endpoint.port <= 0) return "";
    return "http://" + endpoint.host + ":" + endpoint.port;
  }

  /* URL HTTP d'une copie. Le chemin est CONFINÉ au Take :
   *   /<sessionId>/<takeNumber>/<sourceDeviceId>/<rel>?token=…
   * Aucun chemin de système de fichiers n'entre dans l'URL. */
  function mediaUrl(opts) {
    opts = opts || {};
    var base = isStr(opts.baseUrl) ? opts.baseUrl.replace(/\/+$/, "") : "";
    if (!base || !/^https?:\/\/[^\/\s]+$/i.test(base)) return "";
    var sid = safeSegment(opts.sessionId);
    var src = safeSegment(opts.sourceDeviceId);
    var rel = encodeRel(opts.rel);
    var take = opts.takeNumber;
    if (!sid || !src || !rel) return "";
    if (!isNum(take) || take < 0 || Math.floor(take) !== take) return "";
    var url = base + "/" + encodeURIComponent(sid) + "/" + take + "/" + encodeURIComponent(src) + "/" + rel;
    if (isStr(opts.token)) url += "?token=" + encodeURIComponent(opts.token);
    return url;
  }

  /* ---------- disponibilité d'une copie ---------- */

  function pairKnown(rep) { return !!rep; }

  function copyReason(ctx) {
    if (!ctx.stopped) return R.TAKE_NOT_STOPPED;
    if (!ctx.rel) return R.INVALID_REL;
    if (!pairKnown(ctx.rep)) return R.REPLICATION_UNKNOWN;
    if (ctx.rep.state === "error") return R.REPLICATION_ERROR;
    if (ctx.rep.state !== "done") return R.REPLICATION_NOT_DONE;
    if (!ctx.online) return R.STORAGE_OFFLINE;
    if (!ctx.cat) return ctx.requested ? R.STORAGE_PENDING : R.STORAGE_UNKNOWN;
    if (!ctx.cat.ok) {
      if (ctx.cat.reason === "saf_unsupported") return R.STORAGE_UNSUPPORTED;
      return R.STORAGE_ERROR;
    }
    /* Le serveur média exige le token du Take : sans lui, l'URL serait un 403
     * silencieux. On refuse donc la copie explicitement. */
    if (!ctx.token) return R.STORAGE_ERROR;
    /* Le listing d'UNE source a échoué (droits, I/O) : ce n'est PAS « fichier
     * absent ». On refuse la copie sans prétendre savoir ce qu'elle contient. */
    if (ctx.srcError) return R.STORAGE_ERROR;
    if (!ctx.listed) return R.FILE_MISSING;
    if (!(ctx.listed.bytes > 0)) return R.FILE_EMPTY;
    if (ctx.sizeMismatch) return R.FILE_SIZE_MISMATCH;
    return "";
  }

  /* Construit le modèle de consultation d'un Take.
   *
   * input = {
   *   take, session,
   *   online: { storageDeviceId: true },   // présence réelle (connectedPeers)
   *   catalogues: { storageDeviceId: reply },
   *   requested: { storageDeviceId: true } // requête en vol
   * }
   */
  function buildView(input) {
    input = input || {};
    var take = input.take || {};
    var session = input.session || {};
    var sid = isStr(session.sessionId) ? session.sessionId : (isStr(take.sessionId) ? take.sessionId : "");
    var takeNumber = isNum(take.takeNumber) ? take.takeNumber : 0;
    var captures = uniqueSorted(take.captures);
    var storages = uniqueSorted(take.storages);
    var names = nameMap(session);
    var reps = replicationMap(take);
    var stopped = takeStopped(take);
    var online = input.online || {};
    var rawCats = input.catalogues || {};
    var requested = input.requested || {};

    var cats = {};
    storages.forEach(function (did) {
      cats[did] = normalizeCatalogue(rawCats[did]);
    });

    var storageRows = storages.map(function (did) {
      var cat = cats[did];
      var isOnline = online[did] === true;
      var state;
      if (!isOnline) state = ST_OFFLINE;
      else if (cat && cat.ok) state = ST_READY;
      else if (cat && !cat.ok) state = ST_ERROR;
      else if (requested[did]) state = ST_PENDING;
      else state = ST_UNKNOWN;
      var fileCount = 0;
      var bytes = 0;
      if (cat && cat.ok) {
        Object.keys(cat.sources).forEach(function (src) {
          var files = cat.sources[src].files;
          Object.keys(files).forEach(function (rel) {
            fileCount += 1;
            bytes += files[rel].bytes;
          });
        });
      }
      return {
        deviceId: did,
        name: names[did] || did,
        online: isOnline,
        state: state,
        reason: cat && !cat.ok ? cat.reason : "",
        fileCount: fileCount,
        bytes: bytes
      };
    });

    var captureRows = captures.map(function (cap) {
      var rels = {};
      storages.forEach(function (sto) {
        var cat = cats[sto];
        if (!cat || !cat.ok) return;
        var src = cat.sources[cap];
        if (!src) return;
        Object.keys(src.files).forEach(function (rel) { rels[rel] = true; });
      });
      var files = [];
      if (stopped) {
        Object.keys(rels).sort().forEach(function (rel) {
          var copies = [];
          storages.forEach(function (sto) {
            if (sto === cap) return; /* une Capture ne réplique pas vers elle-même */
            var cat = cats[sto];
            var expected = cat && cat.ok ? cat.sources[cap] : null;
            var listed = expected ? expected.files[rel] : null;
            var rep = reps[cap + "|" + sto] || null;
            /* Le total persisté du couple permet de détecter une liste
             * PARTIELLE (fichier présent mais taille totale incohérente). */
            var sizeMismatch = false;
            if (expected && rep && rep.total > 0) {
              var sum = 0;
              Object.keys(expected.files).forEach(function (r) { sum += expected.files[r].bytes; });
              if (sum !== rep.total) sizeMismatch = true;
            }
            var reason = copyReason({
              stopped: stopped, rel: rel, rep: rep,
              online: online[sto] === true, cat: cat, requested: !!requested[sto],
              token: cat ? cat.token : "",
              srcError: expected ? expected.error : "",
              listed: listed, sizeMismatch: sizeMismatch
            });
            var baseUrl = cat ? endpointUrl(cat.endpoint) : "";
            var url = (reason === "" && cat)
              ? mediaUrl({
                baseUrl: baseUrl, sessionId: sid, takeNumber: takeNumber,
                sourceDeviceId: cap, rel: rel, token: cat.token
              })
              : "";
            /* Une URL impossible à construire (endpoint absent) n'est PAS une
             * disponibilité : on retombe sur une erreur explicite. */
            if (reason === "" && !url) reason = R.STORAGE_ERROR;
            copies.push({
              storageDeviceId: sto,
              name: names[sto] || sto,
              online: online[sto] === true,
              available: reason === "",
              reason: reason,
              bytes: listed ? listed.bytes : 0,
              url: url
            });
          });
          var selected = null;
          for (var i = 0; i < copies.length; i++) {
            if (copies[i].available) { selected = copies[i]; break; }
          }
          files.push({
            rel: rel,
            bytes: selected ? selected.bytes : (copies.filter(function (c) { return c.bytes > 0; })[0] || {}).bytes || 0,
            copies: copies,
            available: !!selected,
            selectedStorageDeviceId: selected ? selected.storageDeviceId : "",
            url: selected ? selected.url : ""
          });
        });
      }
      return {
        deviceId: cap,
        name: names[cap] || cap,
        files: files,
        fileCount: files.length,
        availableCount: files.filter(function (f) { return f.available; }).length
      };
    });

    var reasons = {};
    captureRows.forEach(function (row) {
      row.files.forEach(function (f) {
        f.copies.forEach(function (c) {
          if (c.reason) reasons[c.reason] = (reasons[c.reason] || 0) + 1;
        });
      });
    });

    return {
      sessionId: sid,
      takeNumber: takeNumber,
      stopped: stopped,
      reason: stopped ? "" : R.TAKE_NOT_STOPPED,
      captures: captureRows,
      storages: storageRows,
      reasons: reasons,
      availableFiles: captureRows.reduce(function (n, r) { return n + r.availableCount; }, 0),
      totalFiles: captureRows.reduce(function (n, r) { return n + r.fileCount; }, 0)
    };
  }

  /* Sélection de la copie à lire, avec bascule : la PREMIÈRE copie disponible
   * non exclue, dans l'ordre déterministe du Take (`take.storages` trié).
   * Aucune logique de lecture complexe : le lecteur J17-B se contente de
   * rappeler cette fonction avec le Storage qui vient d'échouer. */
  function selectCopy(file, excluded) {
    if (!file || !Array.isArray(file.copies)) return null;
    var ex = {};
    (Array.isArray(excluded) ? excluded : (excluded ? [excluded] : [])).forEach(function (d) {
      if (isStr(d)) ex[d] = true;
    });
    for (var i = 0; i < file.copies.length; i++) {
      var c = file.copies[i];
      if (!c || !c.available || !c.url) continue;
      if (ex[c.storageDeviceId]) continue;
      return c;
    }
    return null;
  }

  return {
    REASON: R,
    ST_READY: ST_READY,
    ST_PENDING: ST_PENDING,
    ST_ERROR: ST_ERROR,
    ST_OFFLINE: ST_OFFLINE,
    ST_UNKNOWN: ST_UNKNOWN,
    sanitizeRel: sanitizeRel,
    safeSegment: safeSegment,
    stoppedCaptures: stoppedCaptures,
    takeStopped: takeStopped,
    replicationMap: replicationMap,
    normalizeCatalogue: normalizeCatalogue,
    mediaUrl: mediaUrl,
    buildView: buildView,
    selectCopy: selectCopy
  };
});
