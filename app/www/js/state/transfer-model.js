/* MultiCam J11 — modèle pur du transfert / Storage / réplication.
 *
 * Objectif (CDC J11) : après STOP, transférer les médias d'un Take vers un ou
 * plusieurs Storage, avec vérification SHA-256 et reprise après coupure.
 *
 * Décisions figées (protocole J11, cf. analyse J11) :
 *  - arborescence Session / Take (le service construit les chemins) ;
 *  - transport HTTP reprenable (Range/206) : la CAPTURE sert ses segments, le
 *    STORAGE tire ; aucun média ne passe par le bridge JS ;
 *  - progression PAR source / PAR destination ; plusieurs Storage indépendants ;
 *  - SHA-256 source (manifeste) et destination (après écriture) comparés ;
 *  - reprise : le Storage reprend à l'offset DÉJÀ reçu (`Range: bytes=N-`) ;
 *  - suppression locale SEULEMENT après réplication vérifiée si l'option est
 *    active (réglages du Take) ;
 *  - aucun transfert média pendant RECORDING (le service met en pause) ;
 *  - segments multiples transférés TELS QUELS, ordre préservé.
 *
 * Ce modèle est PUR : aucun accès fichier, réseau ou Cordova. Toutes les I/O
 * sont des dépendances injectées. Il porte l'état observable (vue) et émet des
 * messages via `deps.send` (broadcast) / `deps.sendTo` (ciblé).
 *
 * Journalisation parsable (format exigé par le plan) :
 *   MEDIA_READY take=… source=… files=… total=…
 *   TRANSFER_OFFER take=… source=… storage=… files=… total=…
 *   TRANSFER_PROGRESS take=… source=… storage=… bytes=… total=…
 *   TRANSFER_HASH take=… sourceSha256=… storageSha256=…
 *   TRANSFER_RESULT take=… source=… storage=… state=…
 *   TRANSFER_DELETE take=… source=…
 */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(root);
  } else {
    root.MultiCamTransferModel = factory(root);
  }
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var PH_PENDING = "pending";
  var PH_TRANSFERRING = "transferring";
  var PH_VERIFYING = "verifying";
  var PH_DONE = "done";
  var PH_ERROR = "error";
  /* J15 — état NON terminal : le travail est reporté faute de pair/joinable,
   * pas abandonné. `done` et `error` demeurent terminaux et absorbants
   * (§4.1) ; `waiting_network` peut redevenir `pending`/`transferring`. */
  var PH_WAITING_NETWORK = "waiting_network";

  var K_MEDIA_READY = "media_ready";
  var K_TRANSFER_OFFER = "transfer_offer";
  var K_TRANSFER_PROGRESS = "transfer_progress";
  var K_TRANSFER_RESULT = "transfer_result";
  var K_TRANSFER_DELETE = "transfer_delete";
  var K_TRANSFER_DELETE_ACK = "transfer_delete_ack";
  /* J15 / §10 — extension COMPATIBLE du protocole : le Storage publie son état
   * d'attente non terminal au Master. Un vieux peer ignore un `kind` inconnu
   * (`WS_DROP`) : la compatibilité descendante est donc naturelle, et aucun
   * résultat terminal n'est inventé. */
  var K_TRANSFER_WAITING = "transfer_waiting";

  var TERMINAL = {};
  TERMINAL[PH_DONE] = true;
  TERMINAL[PH_ERROR] = true;

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function isStr(v) { return typeof v === "string" && v.length > 0; }
  function clampBytes(v) { return isNum(v) && v > 0 ? Math.floor(v) : 0; }
  function isTerminalState(st) { return st === PH_DONE || st === PH_ERROR; }

  function key(srcDid, storageDid) { return String(srcDid) + "|" + String(storageDid); }

  /* Un fichier de transfert normalise : rel, bytes, sha256, received, state. */
  function normFile(f) {
    if (!f || typeof f !== "object") return null;
    if (!isStr(f.rel)) return null;
    var bytes = clampBytes(f.bytes);
    var received = clampBytes(f.received);
    if (received > bytes) received = bytes;
    return {
      rel: f.rel,
      segmentIndex: isNum(f.segmentIndex) ? f.segmentIndex : 0,
      bytes: bytes,
      sha256: isStr(f.sha256) ? String(f.sha256).toLowerCase() : "",
      received: received,
      state: isStr(f.state) ? f.state : PH_PENDING,
      attempts: isNum(f.attempts) ? f.attempts : 0,
      error: isStr(f.error) ? f.error : "",
      /* J15 / §5 — métadonnées d'attente observables : `lastError` (= error),
       * dernière tentative et prochaine échéance (backoff plafonné). */
      waitingSinceMs: isNum(f.waitingSinceMs) ? f.waitingSinceMs : 0,
      lastAttemptAtMs: isNum(f.lastAttemptAtMs) ? f.lastAttemptAtMs : 0,
      nextAttemptAtMs: isNum(f.nextAttemptAtMs) ? f.nextAttemptAtMs : 0
    };
  }

  function normFiles(list) {
    var out = {};
    (Array.isArray(list) ? list : []).forEach(function (f) {
      var n = normFile(f);
      if (n) out[n.rel] = n;
    });
    return out;
  }

  function totalBytes(files) {
    return Object.keys(files).reduce(function (sum, rel) { return sum + files[rel].bytes; }, 0);
  }

  function receivedBytes(files) {
    return Object.keys(files).reduce(function (sum, rel) { return sum + files[rel].received; }, 0);
  }

  /* Agrégation source × Storage — §4.2 (J15) :
   *   error      si un fichier est fatal ;
   *   done       si TOUS sont vérifiés ;
   *   transferring si un fichier est en cours (travail réellement exécuté) ;
   *   waiting_network si AUCUN travail exécutable et AU MOINS un fichier attend
   *                   (aucun actif, aucun terminé qui justifierait l'affichage) ;
   *   sinon transferring (partiel déjà vérifié) ou pending.
   * L'ordre importe : `waiting_network` doit précéder le repli `anyDone`,
   * sinon un lot [done, waiting] afficherait « en cours » alors qu'il est bloqué. */
  function computeTransferState(files) {
    var rels = Object.keys(files);
    if (!rels.length) return PH_PENDING;
    var anyError = false, anyActive = false, anyDone = false, anyWaiting = false, allDone = true;
    rels.forEach(function (rel) {
      var s = files[rel].state;
      if (s === PH_ERROR) { anyError = true; allDone = false; }
      else if (s === PH_DONE) { anyDone = true; }
      else {
        allDone = false;
        if (s === PH_TRANSFERRING || s === PH_VERIFYING) anyActive = true;
        else if (s === PH_WAITING_NETWORK) anyWaiting = true;
      }
    });
    if (allDone) return PH_DONE;
    if (anyError) return PH_ERROR;
    if (anyActive) return PH_TRANSFERRING;
    if (anyWaiting) return PH_WAITING_NETWORK;
    return anyDone ? PH_TRANSFERRING : PH_PENDING;
  }

  function createMachine(deps) {
    deps = deps || {};
    var self = deps.self || function () { return deps.deviceId || "self"; };
    var isMaster = deps.role === "master";
    var isStorage = deps.role === "storage";
    var isCapture = deps.role === "capture";
    var now = deps.now || function () { return Date.now(); };
    var log = deps.log || function () {};
    var send = deps.send || function () {};
    var sendTo = deps.sendTo || function () {};

    var state = {
      sid: deps.sid || "",
      role: deps.role || "",
      self: self(),
      takeNumber: deps.takeNumber || 0,
      sources: {},     /* srcDid -> { deviceId, host, port, totalBytes, files:{rel} } */
      transfers: {},   /* "src|storage" -> { srcDid, storageDid, state, files:{rel}, error } */
      offers: {},      /* storage : srcDid -> { source:{host,port}, files:[...] } */
      deleted: {},     /* srcDid -> true (accusé de suppression locale reçu) */
      deleteFailed: {},/* srcDid -> raison (suppression locale annoncée en échec) */
      rev: 0
    };

    var bump = function () { state.rev += 1; };

    /* Crée (ou rend) le transfert d'un couple source × Storage. Sur un récepteur
     * qui n'a pas reçu l'offre ciblée (le Master, qui agrège), les fichiers sont
     * seedés depuis le manifeste de la source (`media_ready`) pour que la
     * progression et le total soient complets dès le premier message. */
    var ensureTransfer = function (srcDid, storageDid) {
      var k = key(srcDid, storageDid);
      var t = state.transfers[k];
      if (t) return t;
      var seed = {};
      var src = state.sources[srcDid];
      if (src) {
        Object.keys(src.files).forEach(function (rel) { seed[rel] = normFile(src.files[rel]); });
      }
      t = state.transfers[k] = {
        srcDid: srcDid, storageDid: storageDid, state: PH_PENDING,
        files: seed, error: "", startedAtMs: now(), updatedAtMs: now()
      };
      return t;
    };

    /* ---------- réception ---------- */

    var sameTake = function (msg) {
      return isNum(msg.takeNumber) && msg.takeNumber === state.takeNumber;
    };

    /* Identité du manifeste (§7.1 / §10) : les snapshots et le journal sont
     * identifiés par une GÉNÉRATION déterministe, pas par l'adresse IP ou le
     * token (qui changent au redémarrage). */
    function manifestIdOf(files, host, port, token) {
      var rels = Object.keys(files).sort();
      var parts = rels.map(function (rel) {
        var f = files[rel];
        return rel + ":" + f.bytes + ":" + (f.sha256 || "");
      });
      parts.push("ep:" + (host || "") + ":" + (port || 0) + ":" + (token || ""));
      var s = parts.join("|");
      var h = 2166136261;
      for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
      return h.toString(16) + "-" + rels.length;
    }

    /* Identité forte d'un fichier de destination (§16 / contrat 1) : taille et
     * SHA source doivent correspondre pour qu'un append/état conservé soit
     * ACCEPTÉ. Une identité ambiguë n'autorise ni reprise ni monotonie. */
    function sameFileIdentity(a, b) {
      if (!a || !b) return false;
      return a.bytes === b.bytes && (a.sha256 || "") === (b.sha256 || "");
    }

    /* Un fichier re-entre en TRAVAIL actif : l'attente est levée, son échéance
     * de backoff ne doit plus être lue par le coordonnateur (sinon un run
     * déjà reparti serait planifié à nouveau). */
    function clearWaiting(f) {
      if (!f) return;
      f.waitingSinceMs = 0;
      f.nextAttemptAtMs = 0;
    }

    /* Deux annonces sont équivalentes si elles décrivent le MÊME manifeste
     * (mêmes segments, mêmes tailles, mêmes SHA-256, même endpoint). Sert à
     * écarter la LIVRAISON EN DOUBLE d'une même annonce par le transport. */
    var sameManifest = function (a, b) {
      if (!a || !b) return false;
      if (a.host !== b.host || a.port !== b.port || a.token !== b.token) return false;
      if (a.totalBytes !== b.totalBytes) return false;
      var ka = Object.keys(a.files), kb = Object.keys(b.files);
      if (ka.length !== kb.length) return false;
      for (var i = 0; i < ka.length; i++) {
        var f = a.files[ka[i]], g = b.files[ka[i]];
        if (!g || f.bytes !== g.bytes || (f.sha256 || "") !== (g.sha256 || "")) return false;
      }
      return true;
    };

    var applyMediaReady = function (msg) {
      if (!msg || !isStr(msg.deviceId)) return false;
      if (!sameTake(msg)) { log("MEDIA_READY_IGNORE take=" + (msg && msg.takeNumber) + " active=" + state.takeNumber); return false; }
      var files = normFiles(msg.files);
      var info = {
        deviceId: msg.deviceId,
        host: isStr(msg.host) ? msg.host : "",
        port: isNum(msg.port) ? msg.port : 0,
        token: isStr(msg.token) ? msg.token : "",
        totalBytes: isNum(msg.totalBytes) ? msg.totalBytes : totalBytes(files),
        files: files,
        manifestId: isStr(msg.manifestId) ? String(msg.manifestId)
          : manifestIdOf(files, msg.host, msg.port, msg.token),
        readyAtMs: now()
      };
      /* `broadcastTargeted` atteint un pair par CHACUN de ses sockets (deux
       * liens par pair sur le maillage) : une même annonce arrive donc deux
       * fois. Une annonce identique n'est PAS un nouvel état — on ne la rejoue
       * pas, sinon le Master ré-offre (deux `transfer_offer`) et le Storage
       * lance un SECOND téléchargement concurrent vers la même destination. */
      if (state.sources[msg.deviceId] && sameManifest(state.sources[msg.deviceId], info)) {
        log("MEDIA_READY_NOOP take=" + state.takeNumber + " source=" + msg.deviceId);
        return false;
      }
      state.sources[msg.deviceId] = info;
      log("MEDIA_READY take=" + state.takeNumber + " source=" + msg.deviceId
        + " files=" + Object.keys(files).length + " total=" + state.sources[msg.deviceId].totalBytes);
      bump();
      return true;
    };

    /* transfer_offer : le Master demande à UN Storage de tirer les segments d'une
     * source. Chaque Storage reçoit SON offre : les destinations restent
     * indépendantes.
     *
     * J15 / §10 — une ré-offre est un réémet IDEMPOTENT :
     *  - le terminal `done` VÉRIFIÉ est CONSERVÉ (identité taille+SHA source
     *    identique) : sinon la reconnexion du Master ferait retélécharger un
     *    média déjà répliqué, voire repasserait `done` → `pending` ;
     *  - le terminal `error` est conservé lui aussi : une cause irrécupérable
     *    démontrée (intégrité) ne doit pas être rejouée en boucle. Seul un
     *    retry MANUEL (`mode:"retry"`, bouton Réessayer) le réactive ;
     *  - l'avancement partiel (`received`) et l'état `waiting_network` sont
     *    conservés : l'offre ne réinitialise PAS la reprise (l'offset de Range
     *    reste valable, le natif l'aligne sur le disque — J14-B03) ;
     *  - l'endpoint (host/port/token) est TOUJOURS repris : il change après un
     *    redémarrage, l'offre fraîche est la seule source de vérité. */
    var applyTransferOffer = function (msg) {
      if (!msg || !isStr(msg.sourceDeviceId)) return false;
      if (!sameTake(msg)) { log("TRANSFER_OFFER_IGNORE take=" + (msg && msg.takeNumber)); return false; }
      var files = normFiles(msg.files);
      var manualRetry = msg.mode === "retry";
      var srcDid = msg.sourceDeviceId;
      state.offers[srcDid] = {
        sourceDeviceId: srcDid,
        host: isStr(msg.host) ? msg.host : "",
        port: isNum(msg.port) ? msg.port : 0,
        token: isStr(msg.token) ? msg.token : "",
        files: files,
        takeNumber: state.takeNumber,
        manifestId: manifestIdOf(files, msg.host, msg.port, msg.token),
        manualRetry: manualRetry,
        receivedAtMs: now()
      };
      var k = key(srcDid, self());
      var prev = state.transfers[k];
      var merged = {};
      var keptDone = 0, keptError = 0, keptProgress = 0;
      Object.keys(files).forEach(function (rel) {
        var nf = files[rel];
        var pf = prev && prev.files ? prev.files[rel] : null;
        if (!pf || pf.state === PH_PENDING || pf.state === PH_TRANSFERRING
            || pf.state === PH_VERIFYING || pf.state === PH_WAITING_NETWORK) {
          if (pf && sameFileIdentity(pf, nf)) {
            if (isNum(pf.received)) nf.received = Math.min(pf.received, nf.bytes);
            if (pf.state === PH_WAITING_NETWORK) {
              nf.state = PH_WAITING_NETWORK;
              nf.waitingSinceMs = pf.waitingSinceMs;
              nf.nextAttemptAtMs = pf.nextAttemptAtMs;
              nf.lastAttemptAtMs = pf.lastAttemptAtMs;
              nf.error = pf.error;
            }
            if (isNum(pf.attempts)) nf.attempts = pf.attempts;
            if (nf.received > 0) keptProgress += 1;
          }
          merged[rel] = nf;
          return;
        }
        /* État terminal du fichier précédent. */
        if (pf.state === PH_DONE && sameFileIdentity(pf, nf) && !manualRetry) {
          nf.state = PH_DONE;
          nf.received = nf.bytes;
          if (pf.sha256Destination) nf.sha256Destination = pf.sha256Destination;
          keptDone += 1;
        } else if (pf.state === PH_ERROR && sameFileIdentity(pf, nf) && !manualRetry) {
          nf.state = PH_ERROR;
          nf.error = pf.error;
          nf.received = pf.received;
          keptError += 1;
        } else {
          /* Identité différente, ou re-demande explicite : on repart proprement. */
          nf.received = 0;
        }
        merged[rel] = nf;
      });
      state.transfers[k] = {
        srcDid: srcDid,
        storageDid: self(),
        state: computeTransferState(merged),
        files: merged,
        error: "",
        startedAtMs: prev ? prev.startedAtMs : now(),
        updatedAtMs: now()
      };
      log("TRANSFER_OFFER take=" + state.takeNumber + " source=" + srcDid
        + " storage=" + self() + " files=" + Object.keys(merged).length
        + " total=" + totalBytes(merged) + " mode=" + (manualRetry ? "retry" : "resume")
        + " keptDone=" + keptDone + " keptError=" + keptError + " keptProgress=" + keptProgress);
      bump();
      return true;
    };

    /* transition d'un fichier reçue d'un Storage (progression). Accepté côté
     * Storage (echo local) comme côté Master (agrégation). */
    var applyFileUpdate = function (msg, provisional) {
      if (!msg || !isStr(msg.sourceDeviceId) || !isStr(msg.storageDeviceId)) return false;
      if (!isStr(msg.rel)) return false;
      var k = key(msg.sourceDeviceId, msg.storageDeviceId);
      var t = state.transfers[k];
      if (!t) {
        if (!provisional) return false;
        t = ensureTransfer(msg.sourceDeviceId, msg.storageDeviceId);
      }
      var f = t.files[msg.rel] || (t.files[msg.rel] = normFile({ rel: msg.rel, bytes: msg.total, sha256: msg.sha256 }));
      if (isNum(msg.total)) f.bytes = clampBytes(msg.total);
      if (isStr(msg.sha256)) f.sha256 = String(msg.sha256).toLowerCase();
      if (isNum(msg.received)) f.received = Math.min(clampBytes(msg.received), f.bytes);
      if (isStr(msg.state)) f.state = msg.state;
      if (isStr(msg.error)) f.error = msg.error;
      t.state = computeTransferState(t.files);
      t.updatedAtMs = now();
      return true;
    };

    /* transfer_progress : un Storage publie l'avancement d'un fichier. Format
     * de log EXIGÉ par le plan : TRANSFER_PROGRESS take=… source=… storage=… bytes=… total=… */
    var applyTransferProgress = function (msg) {
      if (!msg || !sameTake(msg)) return false;
      /* MONOTONIE TERMINALE (J14-C01 / D1) : un `done`/`error` est définitif. Une
       * progression tardive (retry concurrent, réémission réseau) ne doit JAMAIS
       * rétrograder un état terminal vers `transferring` — sinon un transfert
       * réussi paraîtrait de nouveau en cours et bloquerait la suppression, et un
       * échec acquitté repasserait « en cours » (T2-D). */
      var k = key(msg.sourceDeviceId, msg.storageDeviceId);
      var cur = state.transfers[k] && state.transfers[k].files[msg.rel];
      if (cur && (cur.state === PH_DONE || cur.state === PH_ERROR)) {
        log("TRANSFER_PROGRESS_IGNORE take=" + state.takeNumber
          + " source=" + msg.sourceDeviceId + " rel=" + msg.rel + " state=" + cur.state);
        return false;
      }
      var ok = applyFileUpdate(msg, true);
      if (!ok) return false;
      var f = state.transfers[k] && state.transfers[k].files[msg.rel];
      if (!f) return false;
      f.state = (f.received >= f.bytes && f.bytes > 0) ? PH_VERIFYING : PH_TRANSFERRING;
      clearWaiting(f);
      /* Recalcul APRÈS avoir posé l'état du fichier : sinon l'agrégation du lot
       * resterait calculée sur l'état précédent (ex. `waiting_network` levé par
       * cette progression). */
      state.transfers[k].state = computeTransferState(state.transfers[k].files);
      state.transfers[k].updatedAtMs = now();
      log("TRANSFER_PROGRESS take=" + state.takeNumber + " source=" + msg.sourceDeviceId
        + " storage=" + msg.storageDeviceId + " bytes=" + f.received + " total=" + f.bytes);
      bump();
      return true;
    };

    /* transfer_result : issue TERMINALE d'un fichier/d'un lot. SHA-256 source
     * (manifeste) vs destination (post-écriture). */
    var applyTransferResult = function (msg) {
      if (!msg || !sameTake(msg)) return false;
      var k = key(msg.sourceDeviceId, msg.storageDeviceId);
      var t = ensureTransfer(msg.sourceDeviceId, msg.storageDeviceId);
      var announced = msg.state === PH_DONE;
      var destHash = isStr(msg.sha256Destination) ? String(msg.sha256Destination).toLowerCase()
        : (isStr(msg.storageSha256) ? String(msg.storageSha256).toLowerCase() : "");
      var done = announced;
      if (isStr(msg.rel)) {
        var f = t.files[msg.rel] || (t.files[msg.rel] = normFile({ rel: msg.rel, bytes: msg.total, sha256: msg.sha256 }));
        if (!f) return false;

        /* Double livraison transport d'un résultat TERMINAL déjà appliqué :
         * même issue, même hash destination, mêmes octets reçus → no-op.
         * Sinon le Master ré-ordonne la suppression locale d'un Take déjà
         * traité (deux `transfer_delete` pour un même fichier). La comparaison
         * est PAR FICHIER (un transfert multi-segments reste "transférant"
         * tant que les autres segments ne sont pas reçus). */
        if (f.state === (done ? PH_DONE : PH_ERROR)
            && (done ? (f.received === f.bytes && (!destHash || destHash === String(f.sha256Destination || "").toLowerCase()))
                     : (String(msg.error || "transfer_error") === String(f.error || "transfer_error")))) {
          return false;
        }
        /* Le hash source fait FOI : un `done` annoncé avec un SHA-256
         * destination différent est un ÉCHEC, pas un succès (le Storage peut se
         * tromper ou être corrompu — c'est la vérification pure du modèle). */
        if (done && f.sha256 && destHash && destHash !== f.sha256) {
          done = false;
          msg = Object.assign({}, msg, { error: "sha256_mismatch" });
        }
        f.state = done ? PH_DONE : PH_ERROR;
        if (isNum(msg.received)) f.received = Math.min(clampBytes(msg.received), f.bytes);
        if (done) f.received = f.bytes;
        if (destHash) f.sha256Destination = destHash;
        if (!done) f.error = isStr(msg.error) ? msg.error : "transfer_error";
        if (f.sha256 || f.sha256Destination) {
          log("TRANSFER_HASH take=" + state.takeNumber + " sourceSha256=" + (f.sha256 || "—")
            + " storageSha256=" + (f.sha256Destination || "—"));
        }
      } else {
        if (done && isStr(msg.sha256) && destHash && destHash !== String(msg.sha256).toLowerCase()) {
          done = false;
          msg = Object.assign({}, msg, { error: "sha256_mismatch" });
        }
        Object.keys(t.files).forEach(function (rel) {
          var file = t.files[rel];
          file.state = done ? PH_DONE : PH_ERROR;
          if (done) file.received = file.bytes;
          if (!done) file.error = isStr(msg.error) ? msg.error : "transfer_error";
        });
      }
      t.state = computeTransferState(t.files);
      if (!done) t.error = isStr(msg.error) ? msg.error : "transfer_error";
      else if (t.state === PH_DONE) t.error = "";
      t.updatedAtMs = now();
      log("TRANSFER_RESULT take=" + state.takeNumber + " source=" + msg.sourceDeviceId
        + " storage=" + msg.storageDeviceId + " state=" + t.state);
      bump();
      return true;
    };

    var applyDeleteAck = function (msg) {
      if (!msg || !isStr(msg.sourceDeviceId)) return false;
      /* Un accusé de suppression ne vaut « réussi » que si la Capture le dit :
       * `state` absent = rétro-compatibilité (J11) ; `state:"failed"` = la
       * suppression n'a PAS été confirmée — le Master ne doit PAS croire le
       * média supprimé (J14-C01 / D3). */
      var st = isStr(msg.state) ? msg.state : PH_DONE;
      if (st === PH_ERROR || st === "failed") {
        state.deleteFailed[msg.sourceDeviceId] = isStr(msg.error) ? msg.error : "delete_failed";
        log("TRANSFER_DELETE_FAILED take=" + state.takeNumber + " source=" + msg.sourceDeviceId
          + " error=" + state.deleteFailed[msg.sourceDeviceId]);
        bump();
        return true;
      }
      delete state.deleteFailed[msg.sourceDeviceId];
      state.deleted[msg.sourceDeviceId] = true;
      log("TRANSFER_DELETE_ACK take=" + state.takeNumber + " source=" + msg.sourceDeviceId);
      bump();
      return true;
    };

    /* ---------- réconciliation / blocage (J14-C01 / D1) ---------- */

    /* Un transfert (source × Storage) est TERMINAL s'il est `done` ou `error`. */
    var isTransferTerminal = function (srcDid, storageDid) {
      var t = state.transfers[key(srcDid, storageDid)];
      return !!t && (t.state === PH_DONE || t.state === PH_ERROR);
    };

    /* Transferts NON terminaux dont l'état n'a pas bougé depuis `thresholdMs` :
     * brique de détection des transferts bloqués (Master ET Storage). Rend
     * `updatedAtMs` pour que l'appelant puisse accélérer son backoff.
     *
     * J15 / §12.2-R10 : les transferts DÉJÀ en `waiting_network` sont EXCLUS.
     * Ils sont déjà au repos, en attente du retour du réseau : les re-marquer à
     * chaque tick transformerait une attente légitime en action de watchdog
     * (et, avant J15, en erreur prématurée — la cause A du diagnostic). */
    var staleTransfers = function (thresholdMs, nowMs) {
      var t0 = isNum(nowMs) ? nowMs : now();
      var out = [];
      Object.keys(state.transfers).forEach(function (k) {
        var t = state.transfers[k];
        if (isTerminalState(t.state)) return;
        if (t.state === PH_WAITING_NETWORK) return;
        var at = isNum(t.updatedAtMs) ? t.updatedAtMs : 0;
        var stale = t0 - at;
        if (stale >= thresholdMs) {
          out.push({
            sourceDeviceId: t.srcDid, storageDeviceId: t.storageDid,
            state: t.state, staleMs: stale, updatedAtMs: at
          });
        }
      });
      return out;
    };

    /* Transferts en attente réseau : c'est LA file de lecture du
     * ResumeCoordinator (§6.3). Ne contient QUE les transferts non terminaux
     * dont AU MOINS un fichier attend ; `nextAttemptAtMs` = plus petite échéance
     * du lot (backoff plafonné, §5). */
    var waitingTransfers = function (nowMs) {
      var t0 = isNum(nowMs) ? nowMs : now();
      var out = [];
      Object.keys(state.transfers).forEach(function (k) {
        var t = state.transfers[k];
        if (t.state !== PH_WAITING_NETWORK) return;
        var next = 0, waiting = 0, worst = "", rels = [];
        Object.keys(t.files).forEach(function (rel) {
          var f = t.files[rel];
          if (f.state !== PH_WAITING_NETWORK) return;
          waiting += 1;
          rels.push(rel);
          if (!isNum(f.nextAttemptAtMs) || f.nextAttemptAtMs <= 0) return;
          if (!next || f.nextAttemptAtMs < next) next = f.nextAttemptAtMs;
          if (!worst) worst = f.error || "";
        });
        if (!waiting) return;
        out.push({
          key: k, sourceDeviceId: t.srcDid, storageDeviceId: t.storageDid,
          rels: rels,
          nextAttemptAtMs: next, ready: next <= t0, waitingFiles: waiting,
          staleMs: t0 - (isNum(t.updatedAtMs) ? t.updatedAtMs : 0),
          lastError: worst
        });
      });
      return out;
    };

    /* Y a-t-il encore un transfert NON terminal (récupérable/en cours) ? Sert au
     * journal : tant qu'il en reste, la persistance reste coalescée (§7.2). */
    var hasPendingTransfers = function () {
      return Object.keys(state.transfers).some(function (k) {
        var t = state.transfers[k];
        if (t.storageDid !== self()) return false;
        if (!isTerminalState(t.state)) return true;
        return Object.keys(t.files).some(function (rel) { return !isTerminalState(t.files[rel].state); });
      });
    };

    /* Au moins un transfert TERMINAL (done/error) confirmé ? Si tous les
     * transferts de ce Storage sont terminaux, l'écriture journal est immédiate. */
    var hasTerminalTransfers = function () {
      return Object.keys(state.transfers).some(function (k) {
        var t = state.transfers[k];
        if (t.storageDid !== self()) return false;
        return isTerminalState(t.state)
          || Object.keys(t.files).some(function (rel) { return isTerminalState(t.files[rel].state); });
      });
    };

    /* Réconciliation Storage → Master : re-diffuse l'issue TERMINALE de chaque
     * fichier. Le Master ayant pu PERDRE le message terminal pendant une coupure
     * (WS best-effort, aucune reprise), cette ré-émission à la reconnexion le
     * fait converger. Idempotent : le récepteur ignore une issue déjà connue. */
    var rebroadcastTerminalResults = function () {
      if (!isStorage) return 0;
      var n = 0;
      Object.keys(state.transfers).forEach(function (k) {
        var t = state.transfers[k];
        if (t.storageDid !== self()) return;
        Object.keys(t.files).forEach(function (rel) {
          var f = t.files[rel];
          if (f.state !== PH_DONE && f.state !== PH_ERROR) return;
          send(K_TRANSFER_RESULT, {
            sessionId: state.sid, takeNumber: state.takeNumber,
            sourceDeviceId: t.srcDid, storageDeviceId: self(), rel: rel,
            state: f.state, bytes: f.received, total: f.bytes,
            sha256Destination: f.sha256Destination || "", error: f.error || ""
          });
          n += 1;
        });
      });
      if (n) log("TRANSFER_RESYNC take=" + state.takeNumber + " results=" + n);
      return n;
    };

    /* J15 / §10 — miroir du ré-émission TERMINALE pour l'état d'ATTENTE : si le
     * message `transfer_waiting` a été perdu pendant la coupure, le Master
     * croirait à tort un `transferring` actif (et son watchdog pourrait le
     * ré-offre en rafale). Cette ré-émission à la reconnexion réaligne les deux
     * vues. Le Storage ne convertit JAMAIS `done` en attente : c'est un relevé,
     * pas une transition. */
    var rebroadcastWaitingStates = function () {
      if (!isStorage) return 0;
      var n = 0;
      Object.keys(state.transfers).forEach(function (k) {
        var t = state.transfers[k];
        if (t.storageDid !== self()) return;
        if (t.state !== PH_WAITING_NETWORK) return;
        var rels = Object.keys(t.files).filter(function (rel) {
          return t.files[rel].state === PH_WAITING_NETWORK;
        });
        if (!rels.length) return;
        var f0 = t.files[rels[0]];
        send(K_TRANSFER_WAITING, {
          sessionId: state.sid, takeNumber: state.takeNumber,
          sourceDeviceId: t.srcDid, storageDeviceId: self(),
          state: PH_WAITING_NETWORK,
          cause: waitCauseOf(f0.error),
          lastError: f0.error || "",
          waitingSinceMs: f0.waitingSinceMs || 0,
          nextAttemptAtMs: f0.nextAttemptAtMs || 0,
          received: receivedBytes(t.files), total: totalBytes(t.files)
        });
        n += 1;
      });
      if (n) log("TRANSFER_RESYNC take=" + state.takeNumber + " waiting=" + n);
      return n;
    };

    /* Cause compacte et parsable d'une attente (§10 : champ de statut/cause). */
    function waitCauseOf(msg) {
      var m = String(msg || "");
      if (/http_(\d+)/.test(m)) {
        var code = parseInt(RegExp.$1, 10);
        if (code === 401 || code === 403) return "auth";
        if (code === 404) return "source_unavailable";
        if (code === 416) return "range_conflict";
        if (code === 429 || code >= 500) return "server";
        return "http";
      }
      if (/sha256_mismatch/.test(m)) return "integrity";
      if (/download_truncated/.test(m)) return "truncated";
      if (/saf_|ENOSPC|no space|open_dest_failed/i.test(m)) return "storage";
      if (/Connect|Socket|timeout|Timed out|UnknownHost|ECONN|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|broken pipe|connection/i.test(m)) return "network";
      if (/range_mismatch/.test(m)) return "identity";
      return m ? "error" : "unknown";
    }

    /* Applique une attente réseau reçue (Master : agrégation ; Storage : echo).
     * Un fichier `done`/`error` est INTANGIBLE (§4.1 : terminaux absorbants ;
     * §10 : « Le Storage ne doit jamais convertir un done en waiting_network »). */
    var applyTransferWaiting = function (msg) {
      if (!msg || !sameTake(msg)) return false;
      if (!isStr(msg.sourceDeviceId) || !isStr(msg.storageDeviceId)) return false;
      var k = key(msg.sourceDeviceId, msg.storageDeviceId);
      var t = state.transfers[k];
      if (!t) {
        t = ensureTransfer(msg.sourceDeviceId, msg.storageDeviceId);
        if (!Object.keys(t.files).length) return false;
      }
      var onlyRel = isStr(msg.rel) ? msg.rel : null;
      var why = isStr(msg.lastError) ? msg.lastError : (isStr(msg.error) ? msg.error : "");
      var at = now();
      var nextAt = isNum(msg.nextAttemptAtMs) ? msg.nextAttemptAtMs : 0;
      var since = isNum(msg.waitingSinceMs) && msg.waitingSinceMs > 0 ? msg.waitingSinceMs : at;
      var changed = false;
      Object.keys(t.files).forEach(function (rel) {
        if (onlyRel && rel !== onlyRel) return;
        var f = t.files[rel];
        if (isTerminalState(f.state)) return;
        if (f.state === PH_WAITING_NETWORK && !why && !f.error) return;
        f.state = PH_WAITING_NETWORK;
        if (why) f.error = why;
        if (!f.waitingSinceMs) f.waitingSinceMs = since;
        if (nextAt) f.nextAttemptAtMs = nextAt;
        f.lastAttemptAtMs = at;
        changed = true;
      });
      if (!changed) return false;
      t.state = computeTransferState(t.files);
      if (why) t.error = why;
      t.updatedAtMs = at;
      log("TRANSFER_WAITING take=" + state.takeNumber + " source=" + msg.sourceDeviceId
        + " storage=" + msg.storageDeviceId + " cause=" + (isStr(msg.cause) ? msg.cause : waitCauseOf(why))
        + " nextAttemptInMs=" + (nextAt ? Math.max(0, nextAt - at) : 0));
      bump();
      return true;
    };

    /* Storage : bascule un transfert NON terminal vers `waiting_network` et le
     * PUBLIE au Master (§10 / Q4). C'est la transition que le watchdog exécute
     * quand un transfert reste figé : une absence ou une stall n'est PAS une
     * preuve d'impossibilité (§16-R5), donc jamais `error`.
     *
     * Retourne `false` si rien ne change (aucun fichier non terminal). */
    var markTransferWaiting = function (srcDid, storageDid, reason, nowMs, nextAttemptAtMs) {
      var t = state.transfers[key(srcDid, storageDid)];
      if (!t || isTerminalState(t.state)) return false;
      var why = isStr(reason) ? reason : "stalled";
      var at = isNum(nowMs) ? nowMs : now();
      var nextAt = isNum(nextAttemptAtMs) ? nextAttemptAtMs : 0;
      var rels = [];
      Object.keys(t.files).forEach(function (rel) {
        var f = t.files[rel];
        if (isTerminalState(f.state)) return;
        f.state = PH_WAITING_NETWORK;
        f.error = why;
        if (!f.waitingSinceMs) f.waitingSinceMs = at;
        f.lastAttemptAtMs = at;
        if (nextAt) f.nextAttemptAtMs = nextAt;
        rels.push(rel);
      });
      if (!rels.length) return false;
      t.state = computeTransferState(t.files);
      t.error = why;
      t.updatedAtMs = at;
      log("TRANSFER_WAITING take=" + state.takeNumber + " source=" + srcDid
        + " storage=" + storageDid + " reason=" + why + " files=" + rels.length
        + " cause=" + waitCauseOf(why));
      if (isStorage && t.storageDid === self()) {
        var f0 = t.files[rels[0]];
        send(K_TRANSFER_WAITING, {
          sessionId: state.sid, takeNumber: state.takeNumber,
          sourceDeviceId: srcDid, storageDeviceId: self(),
          state: PH_WAITING_NETWORK, cause: waitCauseOf(why), lastError: why,
          waitingSinceMs: f0.waitingSinceMs || at,
          nextAttemptAtMs: f0.nextAttemptAtMs || 0,
          received: receivedBytes(t.files), total: totalBytes(t.files)
        });
      }
      bump();
      return true;
    };

    /* Storage : publication explicite d'une attente issue du service (échec
     * transitoire avéré). Même chemin que le watchdog mais piloté par la
     * classification d'erreur, avec le backoff déjà calculé. */
    var reportWaiting = function (sourceDeviceId, info) {
      if (!isStorage) return null;
      info = info || {};
      var k = key(sourceDeviceId, self());
      var t = state.transfers[k];
      if (!t) return null;
      if (!markTransferWaiting(sourceDeviceId, self(),
          info.lastError || info.error || "network_unreachable", info.nowMs, info.nextAttemptAtMs)) {
        return null;
      }
      return state.transfers[k];
    };

    /* Storage : restaure l'état RÉCUPÉRABLE d'un Take depuis le journal (§7.3).
     * Règle d'or : le journal n'a jamais force de `done` — la TAILLE DISQUE fait
     * autorité. Donc TOUT fichier restauré ré-entre en `waiting_network` (donc
     * RÉCUPÉRABLE, non terminal), y compris ceux notés `done` : le SHA/size réel
     * sera revérifié au moment du run. Renvoie le nombre de transferts restaurés. */
    var restoreFromJournal = function (doc) {
      if (!isStorage || !doc || !Array.isArray(doc.files)) return 0;
      if (isNum(doc.takeNumber) && doc.takeNumber !== state.takeNumber) return 0;
      var bySrc = {};
      doc.files.forEach(function (jf) {
        if (!isStr(jf.sourceDeviceId) || !isStr(jf.rel)) return;
        bySrc[jf.sourceDeviceId] = bySrc[jf.sourceDeviceId] || [];
        bySrc[jf.sourceDeviceId].push(jf);
      });
      var restored = 0;
      Object.keys(bySrc).forEach(function (srcDid) {
        var t = ensureTransfer(srcDid, self());
        bySrc[srcDid].forEach(function (jf) {
          var f = t.files[jf.rel] || normFile({
            rel: jf.rel, bytes: jf.expectedBytes, sha256: jf.expectedSha256
          }) || { rel: jf.rel, segmentIndex: 0, bytes: 0, sha256: "", received: 0, state: PH_WAITING_NETWORK, attempts: 0, error: "", waitingSinceMs: 0, lastAttemptAtMs: 0, nextAttemptAtMs: 0 };
          f.bytes = isNum(jf.expectedBytes) ? jf.expectedBytes : (f.bytes || 0);
          f.sha256 = isStr(jf.expectedSha256) ? jf.expectedSha256 : (f.sha256 || "");
          f.received = isNum(jf.received) ? jf.received : 0;
          /* JAMAIS terminal d'après le journal : on récupère (§7.3). */
          f.state = PH_WAITING_NETWORK;
          f.error = isStr(jf.lastError) ? jf.lastError : "restored";
          f.waitingSinceMs = isNum(jf.waitingSinceMs) && jf.waitingSinceMs ? jf.waitingSinceMs : now();
          f.lastAttemptAtMs = isNum(jf.lastAttemptAtMs) ? jf.lastAttemptAtMs : 0;
          f.nextAttemptAtMs = 0; /* reprise immédiate planifiée par le coordinateur */
          t.files[jf.rel] = f;
          restored += 1;
        });
        t.state = computeTransferState(t.files);
        t.updatedAtMs = now();
      });
      if (restored) {
        log("TRANSFER_JOURNAL_RESTORED take=" + state.takeNumber + " storage=" + self() + " files=" + restored);
        bump();
      }
      return restored;
    };

    /* Capture : annonce au Master qu'une suppression n'a PAS été confirmée
     * (l'ordre reste côté Master ; la Capture ne ment jamais sur un succès). */
    var reportDeleteFailed = function (env, error) {
      if (!isCapture) return null;
      var out = {
        sessionId: (env && env.sessionId) || state.sid,
        takeNumber: isNum(env && env.takeNumber) ? env.takeNumber : state.takeNumber,
        sourceDeviceId: self(), state: PH_ERROR, error: isStr(error) ? error : "delete_failed"
      };
      send(K_TRANSFER_DELETE_ACK, out);
      return out;
    };

    /* Répartition des kinds entrants (le transport appelle cette fonction). */
    var onIncoming = function (env) {
      if (!env || !isStr(env.kind)) return false;
      switch (env.kind) {
        case K_MEDIA_READY: return applyMediaReady(env);
        case K_TRANSFER_OFFER: return applyTransferOffer(env);
        case K_TRANSFER_PROGRESS: return applyTransferProgress(env);
        case K_TRANSFER_RESULT: return applyTransferResult(env);
        case K_TRANSFER_DELETE: return applyTransferDeleteRequest(env);
        case K_TRANSFER_DELETE_ACK: return applyDeleteAck(env);
        case K_TRANSFER_WAITING: return applyTransferWaiting(env);
        default: return false;
      }
    };

    /* ---------- commandes ---------- */

    /* Capture : annonce ses segments après STOP. */
    var announceMedia = function (manifest) {
      if (!isCapture) return null;
      var files = normFiles(manifest && manifest.files);
      var msg = {
        sessionId: state.sid, takeNumber: state.takeNumber, deviceId: self(),
        host: (manifest && manifest.host) || "", port: (manifest && manifest.port) || 0,
        token: (manifest && manifest.token) || "",
        totalBytes: totalBytes(files),
        files: Object.keys(files).map(function (rel) { return files[rel]; })
      };
      send(K_MEDIA_READY, msg);
      applyMediaReady(msg);
      return msg;
    };

    /* Master : offre le transfert à chaque Storage sélectionné (indépendants).
     * `mode:"retry"` = re-demande MANUELLE (bouton Réessayer) : elle réactive les
     * fichiers en erreur. Toute autre offre est une « ré-offre » de reprise et
     * préserve les états terminaux (cf. applyTransferOffer). */
    var offerTransfers = function (sourceDeviceId, storageDids, mode) {
      if (!isMaster) return [];
      var src = state.sources[sourceDeviceId];
      if (!src) return [];
      var files = Object.keys(src.files).map(function (rel) { return src.files[rel]; });
      var manifestId = src.manifestId || manifestIdOf(src.files, src.host, src.port, src.token);
      var sent = [];
      (storageDids || []).forEach(function (storageDid) {
        if (!isStr(storageDid)) return;
        var msg = {
          sessionId: state.sid, takeNumber: state.takeNumber,
          sourceDeviceId: sourceDeviceId, storageDeviceId: storageDid,
          host: src.host, port: src.port, token: src.token,
          manifestId: manifestId,
          totalBytes: src.totalBytes, files: files
        };
        if (mode === "retry") msg.mode = "retry";
        sendTo(storageDid, K_TRANSFER_OFFER, msg);
        /* Le Master enregistre la destination ATTENDUE (barre `pending` sur
         * l'écran 09) : sans cela une destination jamais atteinte serait
         * invisible et la réplication paraîtrait complète à tort. */
        ensureTransfer(sourceDeviceId, storageDid);
        sent.push(msg);
      });
      return sent;
    };

    /* Storage : publie l'avancement d'un fichier (reçu/état). */
    var reportFileProgress = function (sourceDeviceId, rel, received, st) {
      if (!isStorage) return null;
      var k = key(sourceDeviceId, self());
      var t = state.transfers[k];
      if (!t || !t.files[rel]) return null;
      var f = t.files[rel];
      f.received = Math.min(clampBytes(received), f.bytes);
      f.state = st || PH_TRANSFERRING;
      clearWaiting(f);
      t.state = computeTransferState(t.files);
      t.updatedAtMs = now();
      var msg = {
        sessionId: state.sid, takeNumber: state.takeNumber,
        sourceDeviceId: sourceDeviceId, storageDeviceId: self(),
        rel: rel, received: f.received, total: f.bytes, sha256: f.sha256, state: f.state
      };
      send(K_TRANSFER_PROGRESS, msg);
      log("TRANSFER_PROGRESS take=" + state.takeNumber + " source=" + sourceDeviceId
        + " storage=" + self() + " bytes=" + f.received + " total=" + f.bytes);
      bump();
      return msg;
    };

    /* Storage : publie l'issue terminale d'un fichier. */
    var reportResult = function (sourceDeviceId, rel, st, extra) {
      if (!isStorage) return null;
      var k = key(sourceDeviceId, self());
      var t = state.transfers[k];
      if (!t) return null;
      var msg = {
        sessionId: state.sid, takeNumber: state.takeNumber,
        sourceDeviceId: sourceDeviceId, storageDeviceId: self(),
        rel: rel, state: st
      };
      if (extra) { for (var p in extra) { if (Object.prototype.hasOwnProperty.call(extra, p)) msg[p] = extra[p]; } }
      send(K_TRANSFER_RESULT, msg);
      applyTransferResult(Object.assign({}, msg, { takeNumber: state.takeNumber }));
      return msg;
    };

    /* Master : ordonne à une Capture de supprimer ses originaux (réplication
     * vérifiée). */
    var requestDelete = function (sourceDeviceId) {
      if (!isMaster) return null;
      var msg = { sessionId: state.sid, takeNumber: state.takeNumber, sourceDeviceId: sourceDeviceId };
      sendTo(sourceDeviceId, K_TRANSFER_DELETE, msg);
      log("TRANSFER_DELETE take=" + state.takeNumber + " source=" + sourceDeviceId);
      return msg;
    };

    /* Capture : exécute la demande de suppression (le service supprime les
     * fichiers locaux puis accuse réception). */
    var applyTransferDeleteRequest = function (msg) {
      if (!isCapture || !msg || !isStr(msg.sourceDeviceId)) return false;
      if (msg.sourceDeviceId !== self()) return false;
      var out = { sessionId: state.sid, takeNumber: state.takeNumber, sourceDeviceId: self() };
      send(K_TRANSFER_DELETE_ACK, out);
      applyDeleteAck(out);
      return true;
    };

    /* ---------- sélecteurs ---------- */

    /* Offset de reprise pour HTTP Range : nombre d'octets déjà reçus. */
    var resumeOffset = function (sourceDeviceId, storageDeviceId, rel) {
      var t = state.transfers[key(sourceDeviceId, storageDeviceId)];
      var f = t && t.files[rel];
      return f ? f.received : 0;
    };

    var percent = function (sourceDeviceId, storageDeviceId) {
      var t = state.transfers[key(sourceDeviceId, storageDeviceId)];
      if (!t) return 0;
      var total = totalBytes(t.files);
      if (!total) return 0;
      return Math.min(100, Math.floor((receivedBytes(t.files) * 100) / total));
    };

    /* Détail par destination (vue écran 09 / vue Storage 07). */
    var transferFor = function (sourceDeviceId, storageDeviceId) {
      var t = state.transfers[key(sourceDeviceId, storageDeviceId)];
      if (!t) return null;
      return {
        sourceDeviceId: sourceDeviceId, storageDeviceId: storageDeviceId,
        state: t.state, error: t.error || "",
        bytes: receivedBytes(t.files), total: totalBytes(t.files),
        percent: percent(sourceDeviceId, storageDeviceId),
        files: Object.keys(t.files).sort(function (a, b) {
          return (t.files[a].segmentIndex || 0) - (t.files[b].segmentIndex || 0);
        }).map(function (rel) {
          return {
            rel: rel, segmentIndex: t.files[rel].segmentIndex,
            bytes: t.files[rel].bytes, received: t.files[rel].received,
            sha256: t.files[rel].sha256, state: t.files[rel].state,
            error: t.files[rel].error || ""
          };
        })
      };
    };

    /* Toutes les destinations d'une source sont-elles `done` ? */
    var allDestinationsDone = function (sourceDeviceId) {
      var rels = Object.keys(state.transfers).filter(function (k) {
        return state.transfers[k].srcDid === sourceDeviceId;
      });
      if (!rels.length) return false;
      return rels.every(function (k) { return state.transfers[k].state === PH_DONE; });
    };

    /* Suppression locale autorisée : toutes destinations `done`, ET l'option du
     * Take active. Sans réplication complète, jamais. */
    var canDeleteLocal = function (sourceDeviceId, settings) {
      if (!settings || settings.deleteLocalAfterVerifiedReplication !== true) return false;
      return allDestinationsDone(sourceDeviceId);
    };

    var view = function () {
      var transfers = {};
      Object.keys(state.transfers).sort().forEach(function (k) {
        transfers[k] = transferFor(state.transfers[k].srcDid, state.transfers[k].storageDid);
      });
      return {
        sid: state.sid, role: state.role, self: state.self, takeNumber: state.takeNumber,
        sources: state.sources, transfers: transfers, deleted: state.deleted, rev: state.rev
      };
    };

    return {
      state: state,
      PH_PENDING: PH_PENDING,
      PH_TRANSFERRING: PH_TRANSFERRING,
      PH_VERIFYING: PH_VERIFYING,
      PH_DONE: PH_DONE,
      PH_ERROR: PH_ERROR,
      PH_WAITING_NETWORK: PH_WAITING_NETWORK,
      K_MEDIA_READY: K_MEDIA_READY,
      K_TRANSFER_OFFER: K_TRANSFER_OFFER,
      K_TRANSFER_PROGRESS: K_TRANSFER_PROGRESS,
      K_TRANSFER_RESULT: K_TRANSFER_RESULT,
      K_TRANSFER_DELETE: K_TRANSFER_DELETE,
      K_TRANSFER_DELETE_ACK: K_TRANSFER_DELETE_ACK,
      K_TRANSFER_WAITING: K_TRANSFER_WAITING,
      onIncoming: onIncoming,
      announceMedia: announceMedia,
      offerTransfers: offerTransfers,
      reportFileProgress: reportFileProgress,
      reportResult: reportResult,
      requestDelete: requestDelete,
      resumeOffset: resumeOffset,
      percent: percent,
      transferFor: transferFor,
      allDestinationsDone: allDestinationsDone,
      canDeleteLocal: canDeleteLocal,
      isTransferTerminal: isTransferTerminal,
      isTerminalState: isTerminalState,
      staleTransfers: staleTransfers,
      waitingTransfers: waitingTransfers,
      hasPendingTransfers: hasPendingTransfers,
      hasTerminalTransfers: hasTerminalTransfers,
      rebroadcastTerminalResults: rebroadcastTerminalResults,
      rebroadcastWaitingStates: rebroadcastWaitingStates,
      markTransferWaiting: markTransferWaiting,
      reportWaiting: reportWaiting,
      restoreFromJournal: restoreFromJournal,
      reportDeleteFailed: reportDeleteFailed,
      view: view
    };
  }

  return {
    PH_PENDING: PH_PENDING,
    PH_TRANSFERRING: PH_TRANSFERRING,
    PH_VERIFYING: PH_VERIFYING,
    PH_DONE: PH_DONE,
    PH_ERROR: PH_ERROR,
    PH_WAITING_NETWORK: PH_WAITING_NETWORK,
    K_MEDIA_READY: K_MEDIA_READY,
    K_TRANSFER_OFFER: K_TRANSFER_OFFER,
    K_TRANSFER_PROGRESS: K_TRANSFER_PROGRESS,
    K_TRANSFER_RESULT: K_TRANSFER_RESULT,
    K_TRANSFER_DELETE: K_TRANSFER_DELETE,
    K_TRANSFER_DELETE_ACK: K_TRANSFER_DELETE_ACK,
    K_TRANSFER_WAITING: K_TRANSFER_WAITING,
    isTerminalState: isTerminalState,
    normFiles: normFiles,
    totalBytes: totalBytes,
    receivedBytes: receivedBytes,
    computeTransferState: computeTransferState,
    createMachine: createMachine
  };
});
