/* MultiCam J11 — service de transfert (glue I/O, hors modèle pur).
 *
 * Le modèle `state/transfer-model.js` porte l'état et les invariants ; ce
 * service câble les EFFETS : serveur HTTP de la Capture, téléchargements natifs
 * reprenables du Storage, calcul SHA-256, suppression locale, et le lien avec le
 * Take (Storage sélectionnés, réglages, garde RECORDING).
 *
 * Toutes les dépendances sont INJECTÉES (modèle, natif, chemins, réglages,
 * horloge) : le service est testable sans Cordova.
 *
 * Rôles :
 *   capture : annonce ses segments après STOP (serveur + media_ready) et
 *             supprime ses originaux sur ordre vérifié.
 *   master  : offre le transfert aux Storage sélectionnés, agrège, et ordonne la
 *             suppression locale une fois toutes les destinations vérifiées.
 *   storage : exécute les téléchargements reprenables et publie progression et
 *             résultats.
 */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(root);
  } else {
    root.MultiCamTransferService = factory(root);
  }
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var MAX_ATTEMPTS = 3;
  /* J15 / §5 — backoff ENTRE SÉQUENCES (pas entre tentatives d'une même
   * séquence) : exponentiel, plafonné à 60 s, avec jitter. Aucune borne
   * temporelle globale (`WAITING_NETWORK_MAX_MS`) : une attente réseau n'est
   * jamais convertie en erreur terminale par simple expiration. */
  var RESUME_BASE_MS = 5000;
  var RESUME_MAX_MS = 60000;

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  /* Classification contextuelle d'une erreur (§4.3).
   *  - `transient` : cause réversible (réseau, timeout, 429, 5xx, troncature,
   *    404 potentiellement temporaire, 416 réconciliable).
   *  - `fatal`     : cause irrécupérable démontrée (intégrité SHA, écriture
   *    disque/SAF, 401/403 après échec de renouvellement n'est PAS fatal ici —
   *    on préfère transitoire et réannonce).
   * Par DÉFAUT : transitoire (§16 — « aucune preuve d'impossibilité »). Un
   * silence, une absence ou un code inconnu ne suffisent jamais à conclure. */
  function classifyError(message) {
    var m = String(message || "");
    if (/sha256_mismatch/i.test(m)) return { transient: false, cause: "integrity" };
    if (/saf_|ENOSPC|no space|open_dest_failed|create_failed|mkdir_failed/i.test(m)) {
      return { transient: false, cause: "storage" };
    }
    if (/saf_unverified/i.test(m)) return { transient: false, cause: "storage" };
    if (/download_truncated/i.test(m)) return { transient: true, cause: "truncated" };
    if (/range_mismatch/i.test(m)) return { transient: true, cause: "identity" };
    if (/download_http_401|download_http_403/i.test(m)) return { transient: true, cause: "auth" };
    if (/download_http_404/i.test(m)) return { transient: true, cause: "source_unavailable" };
    if (/download_http_416/i.test(m)) return { transient: true, cause: "range_conflict" };
    if (/download_http_429|download_http_5\d\d/i.test(m)) return { transient: true, cause: "server" };
    if (/Connect|Socket|timeout|Timed out|UnknownHost|ECONN|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|broken pipe|connection|ProtocolException/i.test(m)) {
      return { transient: true, cause: "network" };
    }
    return { transient: true, cause: "unknown" };
  }

  function createTransferService(deps) {
    deps = deps || {};
    var model = deps.model;
    var native = deps.native;
    var self = deps.self || function () { return deps.deviceId || "self"; };
    var role = deps.role || "";
    var log = deps.log || function () {};
    var take = deps.take || function () { return { sessionId: "", takeNumber: 0, storages: [] }; };
    var settings = deps.settings || function () { return {}; };
    var paths = deps.paths || {};
    var isRecording = deps.isRecording || function () { return false; };
    var deleteLocal = deps.deleteLocal || function () { return Promise.resolve(); };
    var generateToken = deps.generateToken || function () { return Math.random().toString(36).slice(2, 12); };
    var port = deps.port || 8080;
    /* Backoff injectable entre deux tentatives de téléchargement. Par défaut
     * IDENTITÉ (aucune attente) pour ne pas ralentir les tests ; le boot injecte
     * un vrai délai progressif afin d'absorber les coupures transitoires. */
    var delay = deps.delay || function () { return Promise.resolve(); };
    /* J15 : horloge et jitter injectables. Le jitter évite que plusieurs
     * Storages ne reprennent exactement au même instant après une coupure
     * commune (anti-tempête). */
    var now = deps.now || function () { return Date.now(); };
    var rand = deps.rand || Math.random;
    /* J15 : signal de reprise. Appelé quand un fichier bascule en
     * `waiting_network` : le boot planifie la prochaine séquence à
     * `nextAttemptAtMs` (déclencheur périodique + événementiel). */
    var onWaiting = deps.onWaiting || function () {};
    /* J15 : vérification d'identité optionnelle sur l'offset (reprise après 416).
     * Rend `{ bytes, sha256 }` du fichier destination, ou `null` si indisponible. */
    var statDest = deps.statDest || function () { return Promise.resolve(null); };
    /* J17-A : catalogue média à la demande. `listDir` est une I/O injectée
     * (listing natif read-only) ; `storageMode` vaut "path" ou "saf" ; le
     * modèle pur fournit l'arrêt du Take et la validation des `rel`. */
    var listDir = deps.listDir || paths.listDir || null;
    var storageMode = deps.storageMode || function () { return "path"; };
    var catalogueModel = deps.catalogueModel || function () { return root.MultiCamMediaCatalogueModel; };

    /* MultiCam D-SERVE: serveur média UNIQUE, partagé au niveau boot entre les
     * Takes. `deps.server` est injecté par la couche boot ; à défaut on crée un
     * état local (tests). `tokens` mémorise le token de chaque Take pour le
     * réutiliser à chaque ré-annonce (le token d'un Take ne change pas). */
    var server = deps.server || { running: false, url: "", host: "", port: 0, tokens: {} };
    if (!server.tokens) server.tokens = {};

    function serverKey(sessionId, takeNumber) {
      return String(sessionId == null ? "" : sessionId) + "/" + takeNumber;
    }

    /* Démarre le serveur média partagé s'il ne tourne pas déjà (idempotent :
     * plusieurs Takes/Capture réutilisent la même instance et le même port). */
    function ensureServer(root) {
      if (server.running) return Promise.resolve(server);
      return native.serveStart({ root: root, port: port, token: "" }).then(function (url) {
        server.url = url;
        server.running = true;
        var m = /^https?:\/\/([^:\/]+):(\d+)/.exec(url || "");
        server.host = m ? m[1] : "";
        server.port = m ? parseInt(m[2], 10) : port;
        return server;
      });
    }

    function encodeRel(rel) {
      return String(rel).split("/").map(encodeURIComponent).join("/");
    }

    /* --------------------------------------------------------------- capture */

    /* À appeler quand le Take local est STOPPED : calcule les empreintes
     * (streaming natif), démarre le serveur média et annonce les segments. */
    /* Segments locaux, STAGÉS si le staging est disponible (le fichier
     * enregistré vit dans le cache interne, mais le serveur sert le dossier
     * média définitif). `stageSegments` rend une promesse de liste ; à défaut
     * on retombe sur `listSegments` (synchrone) pour rester testable. */
    function segmentList() {
      var tk = take();
      var p = (paths.stageSegments
        ? paths.stageSegments(tk.sessionId, tk.takeNumber)
        : Promise.resolve(paths.listSegments ? paths.listSegments(tk.sessionId, tk.takeNumber) : []));
      return Promise.resolve(p).then(function (segs) { return segs || []; });
    }

    var captureAnnounce = function () {
      if (role !== "capture") return Promise.resolve(null);
      var tk = take();
      return segmentList().then(function (segs) {
        if (!segs.length) { log("TRANSFER_ANNOUNCE_SKIP reason=no_segments"); return null; }
        var key = serverKey(tk.sessionId, tk.takeNumber);
        var tkToken = server.tokens[key] || (server.tokens[key] = generateToken());
        var root = paths.mediaRoot(tk.sessionId, tk.takeNumber);
        return Promise.all(segs.map(function (s) {
          return native.sha256(s.path).then(function (r) {
            return { rel: s.rel, segmentIndex: s.segmentIndex || 0, bytes: r.bytes, sha256: r.sha256 };
          });
        })).then(function (files) {
          return ensureServer(root).then(function (sv) {
            return native.serveRegister({
              sessionId: tk.sessionId,
              takeNumber: tk.takeNumber,
              root: root,
              token: tkToken
            }).then(function () {
              log("TRANSFER_SERVE url=" + sv.url + " take=" + tk.takeNumber + " files=" + files.length);
              return model.announceMedia({ host: sv.host, port: sv.port, token: tkToken, files: files });
            });
          });
        });
      }).catch(function (e) {
        log("TRANSFER_ANNOUNCE_ERROR error=" + (e && e.message ? e.message : e));
        return null;
      });
    };

    /* Arrêt du serveur partagé. Réservé à la fermeture de session (ou onDestroy
     * natif) : jamais sur une simple suppression de Take. */
    var serveStop = function () {
      if (!server.running) return Promise.resolve();
      server.running = false;
      server.url = "";
      server.host = "";
      server.port = 0;
      server.tokens = {};
      return native.serveStop();
    };

    /* ------------------------------------------------------------------ J17-A */

    /* Enregistre (ou ré-enregistre) l'autorisation d'un Take sur le serveur
     * média PARTAGÉ : racine média + token PROPRE au Take. Idempotent : le token
     * d'un Take ne change pas, et CorHttpd écrase la même entrée. Aucun second
     * serveur n'est démarré — celui de la Capture/Storage est réutilisé. */
    var ensureTakeGrant = function (sid, takeNumber, root) {
      if (!isStr(sid) || !isNum(takeNumber) || takeNumber < 0 || !isStr(root)) {
        return Promise.reject(new Error("grant_invalid"));
      }
      var key = serverKey(sid, takeNumber);
      var tkToken = server.tokens[key] || (server.tokens[key] = generateToken());
      return ensureServer(root).then(function (sv) {
        return Promise.resolve(native.serveRegister({
          sessionId: sid, takeNumber: takeNumber, root: root, token: tkToken
        })).then(function () {
          return { url: sv.url, host: sv.host, port: sv.port, token: tkToken };
        });
      });
    };

    /* J17-A — catalogue média d'un Take côté STORAGE.
     *
     * Le Storage est la SEULE source de vérité sur ce qui existe réellement
     * chez lui : on liste le disque (`<racine>/<sourceDeviceId>/…`) au lieu de
     * croire un journal ou un état global. Le catalogue ne contient QUE des
     * `rel` relatifs, des tailles, l'endpoint LAN et le token du Take : jamais
     * un chemin absolu.
     *
     * Refus explicites (jamais de disponibilité inventée) :
     *   - role ≠ storage          → not_storage
     *   - Take non arrêté         → take_not_stopped
     *   - mode SAF (non servable) → saf_unsupported
     *   - racine/listing absent   → no_media_root / list_unavailable
     */
    var storageCatalogue = function (opts) {
      opts = opts || {};
      if (role !== "storage") return Promise.resolve({ ok: false, reason: "not_storage" });
      var tk = take();
      var sid = isStr(opts.sessionId) ? opts.sessionId : tk.sessionId;
      var takeNumber = isNum(opts.takeNumber) ? opts.takeNumber : tk.takeNumber;
      if (!isStr(sid) || !isNum(takeNumber) || takeNumber < 0) {
        return Promise.resolve({ ok: false, reason: "malformed" });
      }
      if (storageMode() !== "path") return Promise.resolve({ ok: false, reason: "saf_unsupported" });
      var cm = catalogueModel();
      if (cm && typeof cm.takeStopped === "function" && !cm.takeStopped(tk)) {
        return Promise.resolve({ ok: false, reason: "take_not_stopped" });
      }
      var root = (typeof paths.mediaRoot === "function") ? paths.mediaRoot(sid, takeNumber) : "";
      if (!isStr(root)) return Promise.resolve({ ok: false, reason: "no_media_root" });
      if (typeof listDir !== "function") return Promise.resolve({ ok: false, reason: "list_unavailable" });

      var reps = (tk.summary && tk.summary.replications) || {};
      var selfDid = self();
      var sources = [];
      (Array.isArray(opts.sources) ? opts.sources : []).forEach(function (d) {
        if (!isStr(d) || d === selfDid) return;
        var safe = cm ? cm.safeSegment(d) : d;
        if (!safe || sources.indexOf(safe) >= 0) return;
        sources.push(safe);
      });

      function listSource(src) {
        var dir = root.replace(/\/$/, "") + "/" + src;
        var pair = reps[src + "|" + selfDid] || null;
        return Promise.resolve(listDir(dir)).then(function (entries) {
          var files = [];
          (Array.isArray(entries) ? entries : []).forEach(function (e) {
            if (!e || e.dir === true || !isStr(e.name)) return;
            var rel = cm ? cm.sanitizeRel(e.name) : e.name;
            if (!rel) return;
            files.push({ rel: rel, bytes: isNum(e.bytes) && e.bytes >= 0 ? e.bytes : 0 });
          });
          files.sort(function (a, b) { return a.rel < b.rel ? -1 : (a.rel > b.rel ? 1 : 0); });
          return {
            sourceDeviceId: src,
            replicationState: pair && isStr(pair.state) ? pair.state : "",
            total: pair && isNum(pair.total) ? pair.total : 0,
            files: files
          };
        }, function (e) {
          var msg = String((e && e.message) || e);
          /* Dossier ABSENT = aucun fichier (fait). Tout autre échec (droits,
           * I/O) est une ERREUR de listing : on ne prétend pas que les
           * fichiers manquent. */
          if (/list_missing_dir|list_not_dir/.test(msg)) {
            return { sourceDeviceId: src, replicationState: "", total: 0, files: [] };
          }
          log("MEDIA_CATALOGUE_LIST_ERROR src=" + src + " error=" + msg);
          return { sourceDeviceId: src, replicationState: "", total: 0, files: [], error: "listing_failed" };
        });
      }

      return ensureTakeGrant(sid, takeNumber, root).then(function (ep) {
        return Promise.all(sources.map(listSource)).then(function (rows) {
          var nFiles = 0;
          rows.forEach(function (r) { nFiles += r.files.length; });
          log("MEDIA_CATALOGUE_LISTED take=" + takeNumber + " sources=" + rows.length + " files=" + nFiles);
          return {
            ok: true,
            sessionId: sid,
            takeNumber: takeNumber,
            endpoint: { host: ep.host, port: ep.port },
            token: ep.token,
            sources: rows,
            listedAtMs: now()
          };
        });
      }).catch(function (e) {
        log("MEDIA_CATALOGUE_ERROR take=" + takeNumber + " error=" + String((e && e.message) || e));
        return { ok: false, reason: "serve_unavailable" };
      });
    };

    /* Suppression locale demandée par le Master : on supprime d'abord, on
     * retire ensuite l'autorisation du Take (le serveur et les AUTRES Takes
     * restent actifs), PUIS on laisse le modèle accuser réception (ack).
     *
     * J14-C01 / D3 — deux règles fermes :
     *  1. La cible est identifiée par (session, Take) porté par la DEMANDE, et
     *     résolue dans les segments STAGÉS de ce Take — JAMAIS via la vue du Take
     *     « courant » (vidée à l'acceptation du Take suivant, ce qui rendait la
     *     suppression silencieusement vide : `files=0`).
     *  2. L'ACK n'est émis que si la suppression est RÉELLEMENT confirmée. Sinon
     *     la demande est DIFFÉRÉE (conservée), JAMAIS acquittée : le Master ne
     *     doit pas croire un média supprimé à tort.
     */

    /* Segments stagés d'un Take précis, + est-ce un Take connu de cette Capture.
     * `paths.listSegmentsFor`/`paths.hasTake` sont fournis par le boot ; à défaut
     * on retombe sur `listSegments` (tests, anciens appels). */
    function deleteTargets(sid, tk) {
      if (typeof paths.listSegmentsFor === "function") {
        var segs = paths.listSegmentsFor(sid, tk) || [];
        var known = (typeof paths.hasTake === "function") ? !!paths.hasTake(sid, tk) : segs.length > 0;
        return { known: known, paths: segs.map(function (s) { return s.path; }).filter(Boolean) };
      }
      var legacy = paths.listSegments ? (paths.listSegments(sid, tk) || []) : [];
      return { known: true, paths: legacy.map(function (s) { return s.path; }).filter(Boolean) };
    }

    /* Demandes de suppression DIFFÉRÉES (REC en cours, take inconnu, échec
     * transitoire). Conservées jusqu'à confirmation effective ou abandon. */
    var deferredDeletes = {}; /* "session/take" -> { env, sid, takeNumber, attempts } */
    var DELETE_MAX_ATTEMPTS = 5;

    function deferDelete(env, sid, tk, reason) {
      var pk = serverKey(sid, tk);
      var e = deferredDeletes[pk] || { env: env, sid: sid, takeNumber: tk, attempts: 0 };
      e.env = env || e.env; /* garder la dernière demande connue */
      e.attempts += 1;
      if (e.attempts > DELETE_MAX_ATTEMPTS) {
        delete deferredDeletes[pk];
        log("TRANSFER_LOCAL_DELETE_FAILED take=" + tk + " attempts=" + e.attempts + " reason=" + (reason || "unknown"));
        model.reportDeleteFailed(env, "delete_failed");
        return false;
      }
      deferredDeletes[pk] = e;
      log("TRANSFER_LOCAL_DELETE_DEFER take=" + tk + " reason=" + (reason || "unknown") + " attempt=" + e.attempts);
      return true;
    }

    var captureHandleDelete = function (env) {
      var sid = (env && env.sessionId) || take().sessionId;
      var tk = isNum(env && env.takeNumber) ? env.takeNumber : take().takeNumber;
      if (env && env.sourceDeviceId && env.sourceDeviceId !== self()) return Promise.resolve(false);
      /* Ne JAMAIS supprimer pendant un enregistrement : on conserve la demande
       * et on la rejouera dans des conditions sûres (voir `retryDeferredDeletes`). */
      if (isRecording()) { deferDelete(env, sid, tk, "recording"); return Promise.resolve(false); }
      return doCaptureDelete(env, sid, tk).then(function (done) {
        if (!done) deferDelete(env, sid, tk, "not_confirmed");
        return done;
      });
    };

    /* Tente la suppression ; rend `true` si (et seulement si) l'ACK a été émis. */
    function doCaptureDelete(env, sid, tk) {
      var t = deleteTargets(sid, tk);
      if (!t.known) return Promise.resolve(false);
      return Promise.resolve(deleteLocal(t.paths)).then(function (res) {
        var ok = !res || res.ok !== false;
        if (!ok) {
          log("TRANSFER_LOCAL_DELETE_RETRY take=" + tk
            + " removed=" + ((res && res.removed) || 0) + " failed=" + ((res && res.failed) || 0));
          return false;
        }
        var removed = (res && isNum(res.removed)) ? res.removed : t.paths.length;
        log("TRANSFER_LOCAL_DELETED take=" + tk + " files=" + t.paths.length + " removed=" + removed);
        delete server.tokens[serverKey(sid, tk)];
        var unreg = server.running
          ? native.serveUnregister({ sessionId: sid, takeNumber: tk })
          : Promise.resolve();
        return unreg.then(function () { model.onIncoming(env); return true; });
      });
    }

    /* Rejoue les suppressions différées (appelé par le watchdog de boot quand
     * l'appareil est de nouveau dans des conditions sûres : Take terminé). */
    var retryDeferredDeletes = function () {
      var keys = Object.keys(deferredDeletes);
      if (!keys.length) return Promise.resolve(0);
      if (isRecording()) return Promise.resolve(0);
      var done = 0;
      var chain = Promise.resolve();
      keys.forEach(function (pk) {
        chain = chain.then(function () {
          var e = deferredDeletes[pk];
          if (!e) return null;
          return doCaptureDelete(e.env, e.sid, e.takeNumber).then(function (okd) {
            if (okd) { delete deferredDeletes[pk]; done += 1; }
            else { deferDelete(e.env, e.sid, e.takeNumber, "not_confirmed"); }
            return null;
          });
        });
      });
      return chain.then(function () { return done; });
    };

    var hasDeferredDeletes = function () { return Object.keys(deferredDeletes).length; };

    /* ------------------------------------------------------------------ master */

    var masterOffer = function (sourceDeviceId) {
      var tk = take();
      var st = settings();
      if (!st.transferAuto) { log("TRANSFER_OFFER_SKIP reason=manual source=" + sourceDeviceId); return []; }
      var storages = (tk.storages || []).filter(function (d) { return d && d !== sourceDeviceId; });
      if (!storages.length) { log("TRANSFER_OFFER_SKIP reason=no_storage source=" + sourceDeviceId); return []; }
      return model.offerTransfers(sourceDeviceId, storages);
    };

    var maybeRequestDelete = function (sourceDeviceId) {
      if (model.canDeleteLocal(sourceDeviceId, settings())) {
        model.requestDelete(sourceDeviceId);
        return true;
      }
      return false;
    };

    /* ----------------------------------------------------------------- storage */

    /* Garde anti-double : un Storage ne relance jamais DEUX téléchargements
     * concurremment vers la même source. Le transport peut livrer une offre en
     * double (deux sockets par pair) ; sans cette garde, deux `download` natifs
     * écriraient dans le MÊME fichier destination en parallèle. L'état se
     * purge à la fin de la chaîne (succès OU échec), donc le retry manuel
     * (Réessayer, écran 09) peut relancer un transfert terminé en erreur. */
    var runningRuns = {}; /* sourceDeviceId -> true pendant la chaîne */

    /* Exécute les téléchargements d'une offre, séquentiellement, avec reprise. */
    var storageRun = function (offer) {
      var rk = (offer && offer.sourceDeviceId) || "";
      if (runningRuns[rk]) {
        log("TRANSFER_RUN_SKIP take=" + take().takeNumber + " source=" + rk + " reason=in_progress");
        return Promise.resolve();
      }
      runningRuns[rk] = true;
      var run = function () {
        var tk = take();
        var files = (offer.files || []).slice().sort(function (a, b) {
          return (a.segmentIndex || 0) - (b.segmentIndex || 0);
        });
        var tkTake = tk.takeNumber;
        var chain = Promise.resolve();
        files.forEach(function (f) {
          chain = chain.then(function () {
            if (isRecording()) {
              log("TRANSFER_PAUSE take=" + tkTake + " reason=recording file=" + f.rel);
              return null; /* le service sera relancé après le Take */
            }
            return downloadWithRetry(offer, f, tkTake);
          });
        });
        return chain;
      };
      return run().then(
        function (r) { delete runningRuns[rk]; return r; },
        function (e) { delete runningRuns[rk]; throw e; }
      );
    };

    /* J15 / §5 — calcule la prochaine échéance de reprise entre séquences :
     * exponentielle depuis `RESUME_BASE_MS`, plafonnée à `RESUME_MAX_MS`, avec un
     * jitter multiplicatif (0,5–1,0] pour désynchroniser les Storages. */
    function nextBackoffMs(sequence) {
      var s = Math.max(1, isNum(sequence) ? sequence : 1);
      var base = Math.min(RESUME_MAX_MS, RESUME_BASE_MS * Math.pow(2, s - 1));
      var jitter = 0.5 + 0.5 * (typeof rand === "function" ? rand() : 0.5);
      return Math.round(base * jitter);
    }

    /* Bascule un fichier en attente NON terminale et publie au Master (§4/§5/§10).
     * `sequence` = numéro de séquence échouée (backoff croissant). */
    function reportWaiting(offer, f, cause, errMsg, sequence) {
      var waitMs = nextBackoffMs(sequence);
      var at = now();
      var nextAt = at + waitMs;
      if (typeof model.reportWaiting === "function") {
        model.reportWaiting(offer.sourceDeviceId, {
          rel: f.rel, lastError: errMsg, cause: cause, nowMs: at, nextAttemptAtMs: nextAt
        });
      }
      log("TRANSFER_WAITING_NETWORK file=" + f.rel + " cause=" + cause
        + " sequence=" + sequence + " nextInMs=" + waitMs);
      try { onWaiting({ sourceDeviceId: offer.sourceDeviceId, rel: f.rel, cause: cause, nextAttemptAtMs: nextAt }); } catch (e) {}
      return nextAt;
    }

    /* Réconciliation d'un 416 : comparer taille/SHA de la destination avec
     * l'attendu. Si le fichier est COMPLET et conforme, il est déjà `done`. Sinon
     * on repart à zéro (le partiel local est incohérent vis-à-vis de la source).
     * Rend `true` si un restart à 0 est requis, `false` si le fichier est en fait
     * complet (à vérifier par l'appelant). */
    function reconcile416(offer, f, dest) {
      return Promise.resolve(statDest(dest)).then(function (st) {
        if (!st || !isNum(st.bytes)) return true; /* inconnu → restart sûr */
        if (st.bytes === f.bytes && (isStr(st.sha256) ? String(st.sha256).toLowerCase() === String(f.sha256 || "").toLowerCase() : true)) {
          return false; /* le fichier est en fait complet */
        }
        return true; /* restart à zéro */
      })["catch"](function () { return true; });
    }

    function isStr(v) { return typeof v === "string" && v.length > 0; }

    /* Télécharge UN fichier avec reprise, sur une séquence HTTP COURTE bornée par
     * `MAX_ATTEMPTS`. À l'épuisement de la séquence :
     *   - cause transitoire → `waiting_network` (NON terminal) + backoff ;
     *   - cause fatale      → `error` terminal (intégrité, stockage).
     * Un `sha256_mismatch` déclenche AU PLUS UNE récupération complète contrôlée
     * (suppression du partiel + restart à 0) avant l'erreur d'intégrité. */
    var downloadWithRetry = function (offer, f, tkTake) {
      /* `sequence` = SÉQUENCES échouées (backoff entre séquences).
       * `integrityRetryDone` = garde-fou « au plus une récupération complète ». */
      var sequence = 0;
      var integrityRetryDone = false;
      var dest = paths.destFor ? paths.destFor(offer.sessionId || take().sessionId, tkTake, offer.sourceDeviceId, f.rel) : {};

      function terminal(msg, cause) {
        model.reportResult(offer.sourceDeviceId, f.rel, model.PH_ERROR,
          { error: "download_failed: " + msg + " [cause=" + cause + "]" });
        log("TRANSFER_FILE_FATAL file=" + f.rel + " cause=" + cause);
        return false;
      }

      /* Supprime un partiel incohérent avant restart à zéro (best-effort). */
      function clearDest() {
        if (!native || typeof native.remove !== "function") return Promise.resolve();
        var p = dest && (dest.dest || dest.relPath);
        if (!p) return Promise.resolve();
        return Promise.resolve(native.remove(p))["catch"](function () { return null; });
      }

      /* Précontrôle d'intégrité (J15 / §7.3) : un fichier déjà présent peut être
       * RÉUTILISÉ sans téléchargement inutile — mais JAMAIS sur la seule foi du
       * journal : on compare la taille RÉELLE et le SHA RÉELLEMENT calculé
       * (`statDest`) aux attendus. Une taille seule ne prouve rien. Rend `true`
       * si le fichier est réutilisable tel quel. */
      function reuseIfIntact() {
        if (typeof statDest !== "function") return Promise.resolve(false);
        var d = dest && (dest.dest || dest.relPath);
        if (!d) return Promise.resolve(false);
        /* Ne TENTER la réutilisation que si une destination locale peut
         * RÉELLEMENT exister : progression enregistrée, attente restaurée, ou
         * tentative antérieure. Un transfert NEUF partirait sinon d'un précontrôle
         * inutile ; l'existence seule ne suffit jamais — le SHA réel tranche. */
        var maybeLocal = (isNum(f.received) && f.received > 0)
          || (isNum(f.waitingSinceMs) && f.waitingSinceMs > 0)
          || (isNum(f.lastAttemptAtMs) && f.lastAttemptAtMs > 0);
        if (!maybeLocal) return Promise.resolve(false);
        return Promise.resolve(statDest(dest)).then(function (st) {
          if (!st || !isNum(st.bytes)) return false;
          if (st.bytes !== f.bytes) return false; /* taille différente → pas intact */
          var want = String(f.sha256 || "").toLowerCase();
          var got = String(st.sha256 || "").toLowerCase();
          if (!want || !got || want !== got) return false;
          return true;
        })["catch"](function () { return false; });
      }

      function attemptSequence(forceRestart) {
        var attempt = 0;
        function run() {
          attempt += 1;
          var offset = forceRestart ? 0 : model.resumeOffset(offer.sourceDeviceId, self(), f.rel);
          var sid = offer.sessionId || take().sessionId;
          var base = "http://" + offer.host + ":" + offer.port + "/"
            + encodeURIComponent(sid) + "/" + encodeURIComponent(String(tkTake)) + "/" + encodeRel(f.rel);
          var opts = { url: base, token: offer.token, offset: offset, expectedBytes: f.bytes };
          applyDest(opts, dest);
          /* Le `.catch` est DANS `run` : chaque nouvelle tentative réinstalle sa
           * propre gestion d'échec (sinon une reprise échouée ne serait jamais
           * re-classifiée). */
          return native.download(opts, function (p) {
            model.reportFileProgress(offer.sourceDeviceId, f.rel, p.received);
          }).then(function (res) {
            model.reportResult(offer.sourceDeviceId, f.rel, model.PH_DONE, {
              bytes: res.received, sha256Destination: res.sha256
            });
            log("TRANSFER_FILE_DONE file=" + f.rel + " bytes=" + res.received
              + " offset=" + offset + " sequence=" + sequence);
            return true;
          }).catch(function (e) {
            var msg = e && e.message ? e.message : String(e);
            log("TRANSFER_FILE_ERROR file=" + f.rel + " attempt=" + attempt
              + " sequence=" + sequence + " error=" + msg);

            /* 416 : réconcilier taille/SHA avant de conclure (§4.3). */
            if (/download_http_416/.test(msg)) {
              return reconcile416(offer, f, dest).then(function (needRestart) {
                if (!needRestart) {
                  return Promise.resolve(statDest(dest)).then(function (s2) {
                    model.reportResult(offer.sourceDeviceId, f.rel, model.PH_DONE,
                      { bytes: (s2 && s2.bytes) || f.bytes, sha256Destination: s2 && s2.sha256 });
                    return true;
                  });
                }
                if (attempt < MAX_ATTEMPTS) return delay(attempt).then(run);
                sequence += 1;
                reportWaiting(offer, f, "range_conflict", "download_failed: " + msg, sequence);
                return false;
              });
            }

            var cls = classifyError(msg);

            /* 206 incohérent (Content-Range ≠ offset demandé) : l'offset local
             * n'est pas fiable → repartir à zéro une fois (§4.3). */
            if (/range_mismatch/.test(msg)) {
              if (!integrityRetryDone) {
                integrityRetryDone = true;
                log("TRANSFER_INTEGRITY_RESTART file=" + f.rel + " reason=" + msg);
                return clearDest().then(function () { return attemptSequence(true); });
              }
              if (attempt < MAX_ATTEMPTS) return delay(attempt).then(run);
              sequence += 1;
              reportWaiting(offer, f, "identity", "download_failed: " + msg, sequence);
              return false;
            }

            /* Intégrité : au plus UNE récupération complète contrôlée. */
            if (!cls.transient && cls.cause === "integrity") {
              if (!integrityRetryDone) {
                integrityRetryDone = true;
                log("TRANSFER_INTEGRITY_RESTART file=" + f.rel + " reason=" + msg);
                return clearDest().then(function () { return attemptSequence(true); });
              }
              return terminal(msg, cls.cause);
            }

            /* Cause fatale (stockage/SAF) : erreur terminale explicite. */
            if (!cls.transient) return terminal(msg, cls.cause);

            /* Cause transitoire : tentatives courtes, puis attente réseau. */
            if (attempt < MAX_ATTEMPTS) return delay(attempt).then(run);
            sequence += 1;
            f.received = model.resumeOffset(offer.sourceDeviceId, self(), f.rel);
            reportWaiting(offer, f, cls.cause, "download_failed: " + msg, sequence);
            return false;
          });
        }
        return run();
      }

      /* Réutilisation d'un fichier déjà intègre AVANT toute séquence HTTP. Le
       * `done` est publié par le chemin normal (`reportResult`) : la convergence
       * Master/Storage et la dédup restent inchangées. */
      return reuseIfIntact().then(function (intact) {
        if (intact) {
          log("TRANSFER_REUSE_INTACT file=" + f.rel + " bytes=" + f.bytes);
          return Promise.resolve(statDest(dest)).then(function (st) {
            model.reportResult(offer.sourceDeviceId, f.rel, model.PH_DONE, {
              bytes: (st && isNum(st.bytes)) ? st.bytes : f.bytes,
              sha256Destination: (st && st.sha256) || f.sha256
            });
            return true;
          });
        }
        return attemptSequence(false);
      });
    };

    function applyDest(opts, dest) {
      if (!dest) return;
      if (dest.treeUri) { opts.treeUri = dest.treeUri; opts.relPath = dest.relPath; }
      else if (dest.dest) { opts.dest = dest.dest; }
    }

    /* ------------------------------------------------------------ dispatcher */

    /* Traite un message entrant : effets de bord PUIS application au modèle. */
    var handle = function (env) {
      if (!env || !env.kind) return Promise.resolve(false);
      if (role === "capture" && env.kind === model.K_TRANSFER_DELETE) {
        return captureHandleDelete(env);
      }
      var applied = model.onIncoming(env);
      if (!applied) return Promise.resolve(false);
      if (role === "master" && env.kind === model.K_MEDIA_READY) {
        masterOffer(env.deviceId);
      } else if (role === "master" && env.kind === model.K_TRANSFER_RESULT && env.state === model.PH_DONE) {
        maybeRequestDelete(env.sourceDeviceId);
      } else if (role === "storage" && env.kind === model.K_TRANSFER_OFFER) {
        return storageRun(env).then(function () { return true; });
      }
      return Promise.resolve(true);
    };

    return {
      captureAnnounce: captureAnnounce,
      serveStop: serveStop,
      ensureTakeGrant: ensureTakeGrant,
      storageCatalogue: storageCatalogue,
      masterOffer: masterOffer,
      maybeRequestDelete: maybeRequestDelete,
      storageRun: storageRun,
      retryDeferredDeletes: retryDeferredDeletes,
      hasDeferredDeletes: hasDeferredDeletes,
      handle: handle,
      server: server,
      /* J15 : surfaces de test / coordination. */
      downloadWithRetry: downloadWithRetry,
      nextBackoffMs: nextBackoffMs,
      isRunning: function (src) { return !!runningRuns[src]; }
    };
  }

  return {
    MAX_ATTEMPTS: MAX_ATTEMPTS,
    RESUME_BASE_MS: RESUME_BASE_MS,
    RESUME_MAX_MS: RESUME_MAX_MS,
    classifyError: classifyError,
    createTransferService: createTransferService
  };
});
