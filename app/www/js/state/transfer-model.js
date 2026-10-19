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

  var K_MEDIA_READY = "media_ready";
  var K_TRANSFER_OFFER = "transfer_offer";
  var K_TRANSFER_PROGRESS = "transfer_progress";
  var K_TRANSFER_RESULT = "transfer_result";
  var K_TRANSFER_DELETE = "transfer_delete";
  var K_TRANSFER_DELETE_ACK = "transfer_delete_ack";

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function isStr(v) { return typeof v === "string" && v.length > 0; }
  function clampBytes(v) { return isNum(v) && v > 0 ? Math.floor(v) : 0; }

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
      error: isStr(f.error) ? f.error : ""
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

  function computeTransferState(files) {
    var rels = Object.keys(files);
    if (!rels.length) return PH_PENDING;
    var anyError = false, anyActive = false, anyDone = false, allDone = true;
    rels.forEach(function (rel) {
      var s = files[rel].state;
      if (s === PH_ERROR) { anyError = true; allDone = false; }
      else if (s === PH_DONE) { anyDone = true; }
      else { allDone = false; if (s === PH_TRANSFERRING || s === PH_VERIFYING) anyActive = true; }
    });
    if (allDone) return PH_DONE;
    if (anyError) return PH_ERROR;
    if (anyActive) return PH_TRANSFERRING;
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

    /* media_ready : une Capture annonce les segments d'un Take (chemin relatif,
     * taille, SHA-256 source). C'est la source de vérité de la liste des
     * fichiers ; le manifeste HTTP sert de secours. */
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
     * indépendantes. */
    var applyTransferOffer = function (msg) {
      if (!msg || !isStr(msg.sourceDeviceId)) return false;
      if (!sameTake(msg)) { log("TRANSFER_OFFER_IGNORE take=" + (msg && msg.takeNumber)); return false; }
      var files = normFiles(msg.files);
      /* Un même (source) ne peut pas garder une offre concurrente : la dernière
       * reçue fait foi (reprise = nouvelle offre, offsets repartent de 0 et le
       * service réutilisera la taille du fichier partiel). */
      state.offers[msg.sourceDeviceId] = {
        sourceDeviceId: msg.sourceDeviceId,
        host: isStr(msg.host) ? msg.host : "",
        port: isNum(msg.port) ? msg.port : 0,
        token: isStr(msg.token) ? msg.token : "",
        files: files,
        takeNumber: state.takeNumber,
        receivedAtMs: now()
      };
      var k = key(msg.sourceDeviceId, self());
      var prev = state.transfers[k];
      state.transfers[k] = {
        srcDid: msg.sourceDeviceId,
        storageDid: self(),
        state: PH_PENDING,
        files: files,
        error: "",
        startedAtMs: prev ? prev.startedAtMs : now(),

        updatedAtMs: now()
      };
      log("TRANSFER_OFFER take=" + state.takeNumber + " source=" + msg.sourceDeviceId
        + " storage=" + self() + " files=" + Object.keys(files).length + " total=" + totalBytes(files));
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
     * `updatedAtMs` pour que l'appelant puisse accélérer son backoff. */
    var staleTransfers = function (thresholdMs, nowMs) {
      var t0 = isNum(nowMs) ? nowMs : now();
      var out = [];
      Object.keys(state.transfers).forEach(function (k) {
        var t = state.transfers[k];
        if (t.state === PH_DONE || t.state === PH_ERROR) return;
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

    /* Force un transfert bloqué vers un état TERMINAL `error` (plus de
     * `transferring` infini). Côté Storage, l'échec est PUBLIÉ au Master. */
    var markTransferStuck = function (srcDid, storageDid, reason, nowMs) {
      var t = state.transfers[key(srcDid, storageDid)];
      if (!t || t.state === PH_DONE || t.state === PH_ERROR) return false;
      var why = isStr(reason) ? reason : "stalled";
      var changed = false;
      Object.keys(t.files).forEach(function (rel) {
        var f = t.files[rel];
        if (f.state === PH_DONE || f.state === PH_ERROR) return;
        f.state = PH_ERROR;
        f.error = why;
        changed = true;
      });
      if (!changed) return false;
      t.state = computeTransferState(t.files);
      t.error = why;
      t.updatedAtMs = isNum(nowMs) ? nowMs : now();
      log("TRANSFER_STUCK take=" + state.takeNumber + " source=" + srcDid
        + " storage=" + storageDid + " reason=" + why);
      if (isStorage && t.storageDid === self()) {
        Object.keys(t.files).forEach(function (rel) {
          var f = t.files[rel];
          send(K_TRANSFER_RESULT, {
            sessionId: state.sid, takeNumber: state.takeNumber,
            sourceDeviceId: srcDid, storageDeviceId: self(), rel: rel,
            state: PH_ERROR, error: f.error || why, received: f.received, total: f.bytes
          });
        });
      }
      bump();
      return true;
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

    /* Master : offre le transfert à chaque Storage sélectionné (indépendants). */
    var offerTransfers = function (sourceDeviceId, storageDids) {
      if (!isMaster) return [];
      var src = state.sources[sourceDeviceId];
      if (!src) return [];
      var files = Object.keys(src.files).map(function (rel) { return src.files[rel]; });
      var sent = [];
      (storageDids || []).forEach(function (storageDid) {
        if (!isStr(storageDid)) return;
        var msg = {
          sessionId: state.sid, takeNumber: state.takeNumber,
          sourceDeviceId: sourceDeviceId, storageDeviceId: storageDid,
          host: src.host, port: src.port, token: src.token,
          totalBytes: src.totalBytes, files: files
        };
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
      K_MEDIA_READY: K_MEDIA_READY,
      K_TRANSFER_OFFER: K_TRANSFER_OFFER,
      K_TRANSFER_PROGRESS: K_TRANSFER_PROGRESS,
      K_TRANSFER_RESULT: K_TRANSFER_RESULT,
      K_TRANSFER_DELETE: K_TRANSFER_DELETE,
      K_TRANSFER_DELETE_ACK: K_TRANSFER_DELETE_ACK,
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
      staleTransfers: staleTransfers,
      rebroadcastTerminalResults: rebroadcastTerminalResults,
      markTransferStuck: markTransferStuck,
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
    K_MEDIA_READY: K_MEDIA_READY,
    K_TRANSFER_OFFER: K_TRANSFER_OFFER,
    K_TRANSFER_PROGRESS: K_TRANSFER_PROGRESS,
    K_TRANSFER_RESULT: K_TRANSFER_RESULT,
    K_TRANSFER_DELETE: K_TRANSFER_DELETE,
    K_TRANSFER_DELETE_ACK: K_TRANSFER_DELETE_ACK,
    normFiles: normFiles,
    totalBytes: totalBytes,
    receivedBytes: receivedBytes,
    computeTransferState: computeTransferState,
    createMachine: createMachine
  };
});
