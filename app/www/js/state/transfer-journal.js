/* MultiCam J15 — journal technique de la machine de transfert.
 *
 * Objectif (§7) : survivre à un crash/redémarrage en restaurant les transferts
 * INTERROMPUS (`transferring`, `verifying`, `waiting_network`) comme
 * RÉCUPÉRABLES, sans jamais déclarer `done` sur la seule foi du journal (§7.3).
 *
 * Principes de durabilité (§7.2) :
 *  - écritures des transitions TERMINALES (done/error) : IMMÉDIATES ;
 *  - progressions fréquentes : COALESCÉES (la taille disque réelle fait foi au
 *    redémarrage, `received` n'est qu'indicatif) ;
 *  - écriture via un fichier `.tmp` puis renommage ATOMIQUE (`moveTo`) après
 *    relecture de vérification (round-trip) ;
 *  - un journal corrompu est CONSERVÉ (diagnostic) et ignoré, jamais réécrit
 *    aveuglément.
 *
 * Le journal est versionné et identifié par `(sessionId, takeNumber,
 * storageDeviceId)`. L'endpoint (host/port/token) sauvegardé n'est PAS fiable
 * au reboot (§7.1) : il sert de trace, jamais de vérité.
 *
 * Toutes les I/O sont injectées (`deps.fs`) pour rester testables sans Cordova.
 */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(root);
  } else {
    root.MultiCamTransferJournal = factory(root);
  }
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var VERSION = 1;
  var DIR_NAME = "transfers";
  var COALESCE_MS = 1000;

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function isStr(v) { return typeof v === "string" && v.length > 0; }

  /* ---------- adaptateur FS Cordova (par défaut) ---------- */

  function cordovaFs() {
    return {
      available: function () {
        return !!(root.cordova && root.cordova.file && root.resolveLocalFileSystemURL);
      },
      dir: function () {
        return new Promise(function (resolve, reject) {
          root.resolveLocalFileSystemURL(root.cordova.file.dataDirectory, function (r) {
            r.getDirectory(DIR_NAME, { create: true, exclusive: false }, resolve, reject);
          }, reject);
        });
      },
      read: function (dir, name) {
        return new Promise(function (resolve, reject) {
          dir.getFile(name, { create: false, exclusive: false }, function (entry) {
            entry.file(function (f) {
              var r = new FileReader();
              r.onloadend = function () { resolve(r.result); };
              r.onerror = function (e) { reject(e); };
              r.readAsText(f);
            }, reject);
          }, function () { resolve(null); /* absent */ });
        });
      },
      write: function (dir, name, text) {
        /* Écriture durable : fichier temporaire, puis renommage atomique. */
        return new Promise(function (resolve, reject) {
          dir.getFile(name + ".tmp", { create: true, exclusive: false }, function (entry) {
            entry.createWriter(function (w) {
              var step = 0;
              w.onwriteend = function () {
                if (step === 0) { step = 1; w.seek(0); w.write(text); }
                else { resolve(entry); }
              };
              w.onerror = function (e) { reject(e); };
              w.truncate(0);
            }, reject);
          }, reject);
        }).then(function (entry) {
          /* Relecture de contrôle (round-trip) avant de renommer. */
          return new Promise(function (resolve, reject) {
            dir.getFile(name + ".tmp", { create: false, exclusive: false }, function (e2) {
              e2.file(function (f) {
                var r = new FileReader();
                r.onloadend = function () {
                  if (r.result !== text) { reject(new Error("journal_roundtrip_mismatch")); return; }
                  resolve(e2);
                };
                r.onerror = function (e) { reject(e); };
                r.readAsText(f);
              }, reject);
            }, reject);
          });
        }).then(function (tmp) {
          return new Promise(function (resolve, reject) {
            tmp.moveTo(dir, name, resolve, reject);
          });
        });
      },
      list: function (dir) {
        return new Promise(function (resolve, reject) {
          var reader = dir.createReader();
          reader.readEntries(function (entries) {
            resolve((entries || []).map(function (e) { return e.name; }));
          }, reject);
        });
      },
      remove: function (dir, name) {
        return new Promise(function (resolve) {
          dir.getFile(name, { create: false, exclusive: false }, function (entry) {
            entry.remove(function () { resolve(true); }, function () { resolve(false); });
          }, function () { resolve(false); });
        });
      }
    };
  }

  function memoryFs() {
    var files = {};
    return {
      _files: files,
      available: function () { return true; },
      dir: function () { return Promise.resolve({ _mem: true }); },
      read: function (dir, name) {
        return Promise.resolve(Object.prototype.hasOwnProperty.call(files, name) ? files[name] : null);
      },
      write: function (dir, name, text) { files[name] = text; return Promise.resolve({ name: name }); },
      list: function () { return Promise.resolve(Object.keys(files)); },
      remove: function (dir, name) { delete files[name]; return Promise.resolve(true); }
    };
  }

  /* ---------- sérialisation ---------- */

  function fileFor(sessionId, takeNumber, storageDeviceId) {
    return encodeURIComponent(sessionId) + "_" + takeNumber + "_" + encodeURIComponent(storageDeviceId) + ".json";
  }

  /* Construit le document journal à partir de l'état d'une machine de transfert.
   * Uniquement les métadonnées nécessaires à la redécouverte (§7.1). */
  function buildDoc(env) {
    var files = [];
    var tf = (env && env.transfers) || {};
    Object.keys(tf).forEach(function (k) {
      var t = tf[k];
      if (!t || t.storageDid !== env.storageDeviceId) return;
      Object.keys(t.files).forEach(function (rel) {
        var f = t.files[rel];
        files.push({
          sourceDeviceId: t.srcDid, rel: rel,
          expectedBytes: f.bytes, expectedSha256: f.sha256 || "",
          state: f.state, received: f.received || 0,
          waitingSinceMs: f.waitingSinceMs || 0,
          lastAttemptAtMs: f.lastAttemptAtMs || 0,
          nextAttemptAtMs: f.nextAttemptAtMs || 0,
          lastError: f.error || ""
        });
      });
    });
    return {
      version: VERSION,
      sessionId: env.sessionId, takeNumber: env.takeNumber,
      storageDeviceId: env.storageDeviceId,
      manifestId: env.manifestId || "",
      /* Endpoint = trace seulement, jamais une vérité au reboot (§7.1). */
      endpoint: env.endpoint || null,
      updatedAtMs: isNum(env.nowMs) ? env.nowMs : Date.now(),
      files: files
    };
  }

  function createTransferJournal(deps) {
    deps = deps || {};
    var fs = deps.fs || (root.cordova ? cordovaFs() : memoryFs());
    var log = deps.log || function () {};
    var setT = deps.setTimeout || (typeof setTimeout !== "undefined" ? setTimeout : null);
    var clearT = deps.clearTimeout || (typeof clearTimeout !== "undefined" ? clearTimeout : null);
    var coalesceMs = isNum(deps.coalesceMs) ? deps.coalesceMs : COALESCE_MS;

    var pending = {};   /* name -> { doc, timer, dir } */
    var chains = {};    /* name -> Promise (sérialise les écritures) */

    function writeNow(dir, name, doc) {
      var text = JSON.stringify(doc);
      var prev = chains[name] || Promise.resolve();
      var next = prev.then(function () { return fs.write(dir, name, text); });
      chains[name] = next.catch(function () {});
      return next.then(function () {
        log("TRANSFER_JOURNAL_WRITE name=" + name + " files=" + doc.files.length);
        return true;
      }, function (e) {
        log("TRANSFER_JOURNAL_WRITE_ERR name=" + name + " error=" + String((e && e.message) || e));
        return false;
      });
    }

    /* Enregistre un document. `immediate` force une écriture synchrone (done/error).
     * Sinon coalescence pour ne pas saturer le WebView sur les progressions. */
    function save(doc, immediate) {
      var name = fileFor(doc.sessionId, doc.takeNumber, doc.storageDeviceId);
      return fs.dir().then(function (dir) {
        if (immediate || !setT) {
          /* Écriture TERMINALE (done/error) : elle fait AUTORITÉ. On ANNULE toute
           * progression coalescée encore en attente pour ce nom, sinon son timer
           * se déclencherait PLUS TARD et écraserait cet état terminal plus récent
           * par une ancienne progression (§7.2). */
          var stale = pending[name];
          if (stale) {
            if (stale.timer && clearT) clearT(stale.timer);
            delete pending[name];
          }
          return writeNow(dir, name, doc);
        }
        var p = pending[name];
        if (p && p.timer && clearT) clearT(p.timer);
        var entry = { doc: doc, dir: dir, timer: null };
        entry.timer = setT(function () {
          var cur = pending[name];
          delete pending[name];
          if (cur) writeNow(cur.dir, name, cur.doc);
        }, coalesceMs);
        if (entry.timer && typeof entry.timer.unref === "function") entry.timer.unref();
        pending[name] = entry;
        return true;
      });
    }

    /* Flush immédiat de tout ce qui est en attente (avant un état terminal). */
    function flush() {
      var names = Object.keys(pending);
      if (!names.length) return Promise.resolve(0);
      var ops = names.map(function (name) {
        var cur = pending[name];
        delete pending[name];
        if (cur && cur.timer && clearT) clearT(cur.timer);
        return cur ? writeNow(cur.dir, name, cur.doc) : Promise.resolve(false);
      });
      return Promise.all(ops).then(function (rs) {
        return rs.filter(Boolean).length;
      });
    }

    /* Lit le journal d'un Storage pour un Take. Rend `{ ok, doc }` :
     *  - `ok:false` si absent ;
     *  - `ok:false` + `corrupted:true` si JSON invalide/version inconnue (le
     *    fichier est CONSERVÉ, jamais réécrit aveuglément). */
    function restore(sessionId, takeNumber, storageDeviceId) {
      var name = fileFor(sessionId, takeNumber, storageDeviceId);
      return fs.dir().then(function (dir) {
        return fs.read(dir, name).then(function (text) {
          if (text == null) return { ok: false, doc: null };
          var doc;
          try { doc = JSON.parse(text); } catch (e) { log("TRANSFER_JOURNAL_CORRUPT name=" + name); return { ok: false, doc: null, corrupted: true }; }
          if (!doc || doc.version !== VERSION || !Array.isArray(doc.files)) {
            log("TRANSFER_JOURNAL_VERSION name=" + name + " version=" + (doc && doc.version));
            return { ok: false, doc: null, corrupted: true };
          }
          log("TRANSFER_JOURNAL_RESTORE name=" + name + " files=" + doc.files.length);
          return { ok: true, doc: doc };
        });
      }, function () { return { ok: false, doc: null }; });
    }

    /* Supprime le journal d'un Storage (uniquement après preuve persistée de tous
     * les `done`, cf. §7.4). */
    function purge(sessionId, takeNumber, storageDeviceId) {
      var name = fileFor(sessionId, takeNumber, storageDeviceId);
      return fs.dir().then(function (dir) {
        return fs.remove(dir, name).then(function () {
          log("TRANSFER_JOURNAL_PURGE name=" + name);
          return true;
        });
      }, function () { return false; });
    }

    return {
      save: save,
      flush: flush,
      restore: restore,
      purge: purge,
      _pending: function () { return Object.keys(pending).length; }
    };
  }

  return {
    VERSION: VERSION,
    buildDoc: buildDoc,
    fileFor: fileFor,
    cordovaFs: cordovaFs,
    memoryFs: memoryFs,
    createTransferJournal: createTransferJournal
  };
});
