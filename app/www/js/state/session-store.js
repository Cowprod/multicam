/* MultiCam — persistance locale des sessions (J04).
 * Suit le pattern de config.js (J02) : schema versionne, sanitization raisonnee,
 * log parsable, cordova.file.dataDirectory, comportement robuste au restart.
 * Un fichier par session : sessions/<sessionId>.json — il ne contient que l'etat
 * reellement requis par J04 (pas de structures J05/J06 en placeholder).
 *
 * La connectivite (connected/lastSeenMs) est un metadonnee TRANSIENT derivee des
 * connexions WebSocket et du heartbeat applicatif : elle n'est pas persistee ici
 * (elle ne doit pas devenir une identite) — decision 30.4/30.8.
 *
 * Le PIN est conserve dans le fichier local (chaque Master persiste une copie,
 * decision 30.9.6) mais n'est JAMAIS inclus dans les logs. */

(function (global) {
  "use strict";

  var DIR_NAME = "sessions";
  var M = function () { return global.MultiCamSessionModel; };

  var cache = null; /* sessionId -> session (charge une seule fois). */

  function emit(line) { console.log(line); }

  /* ---------- file I/O (meme meca que config.js) ---------- */

  function readFile(entry) {
    return new Promise(function (resolve, reject) {
      entry.file(function (f) {
        var r = new FileReader();
        r.onloadend = function () { resolve(r.result); };
        r.onerror = function (e) { reject(e); };
        r.readAsText(f);
      }, reject);
    });
  }

  function writeFile(entry, text) {
    return new Promise(function (resolve, reject) {
      entry.createWriter(function (w) {
        var step = 0;
        w.onwriteend = function () {
          if (step === 0) { step = 1; w.seek(0); w.write(text); }
          else { resolve(); }
        };
        w.onerror = function (e) { reject(e); };
        w.truncate(0);
      }, reject);
    });
  }

  function workingDir() {
    return new Promise(function (resolve, reject) {
      global.resolveLocalFileSystemURL(global.cordova.file.dataDirectory, function (root) {
        root.getDirectory(DIR_NAME, { create: true, exclusive: false }, resolve, reject);
      }, reject);
    });
  }

  function getEntry(sid) {
    return workingDir().then(function (dir) {
      return new Promise(function (resolve, reject) {
        dir.getFile(sid + ".json", { create: false, exclusive: false }, resolve, function () {
          reject(new Error("session_missing:" + sid));
        });
      });
    });
  }

  /* ecritures seriees par session (evite les chevauchements createWriter). */
  var queues = {};

  function queueWrite(sid, text) {
    var prev = queues[sid] || Promise.resolve();
    var next = prev.then(function () {
      return workingDir().then(function (dir) {
        return new Promise(function (resolve, reject) {
          dir.getFile(sid + ".json", { create: true, exclusive: false }, function (entry) {
            writeFile(entry, text).then(resolve, reject);
          }, reject);
        });
      });
    });
    queues[sid] = next.catch(function () {});
    return next;
  }

  /* ---------- in-memory / web fallback ---------- */

  function persistWeb(sid, text) {
    try {
      var all = {};
      try { all = JSON.parse(global.localStorage.getItem("multicam.sessions.list") || "{}"); } catch (e) {}
      all[sid] = JSON.parse(text);
      global.localStorage.setItem("multicam.sessions.list", JSON.stringify(all));
    } catch (e) {}
  }

  function loadWeb() {
    var out = {};
    try {
      var all = JSON.parse(global.localStorage.getItem("multicam.sessions.list") || "{}");
      Object.keys(all).forEach(function (sid) {
        var s = M().sanitizeSession(all[sid]);
        if (s && s.sessionId) out[s.sessionId] = s;
      });
    } catch (e) {}
    return out;
  }

  /* ---------- API ---------- */

  function loadAll() {
    if (cache) return Promise.resolve(cache);
    if (!global.cordova || !global.cordova.file || !global.resolveLocalFileSystemURL) {
      cache = loadWeb();
      return Promise.resolve(cache);
    }
    return workingDir().then(function (dir) {
      var reader = dir.createReader();
      return new Promise(function (resolve, reject) {
        reader.readEntries(function (entries) {
          var jobs = entries
            .filter(function (e) { return e.isFile && /\.json$/.test(e.name); })
            .map(function (e) {
              return readFile(e).then(function (text) {
                try {
                  var s = M().sanitizeSession(JSON.parse(text));
                  if (!s || !s.sessionId) return null;
                  return { sid: s.sessionId, s: s };
                } catch (err) { return null; }
              });
            });
          Promise.all(jobs).then(function (rows) {
            var map = {};
            rows.forEach(function (r) { if (r) map[r.sid] = r.s; });
            cache = map;
            resolve(map);
          }, reject);
        }, reject);
      });
    });
  }

  function list() {
    /* ordre "recentes" : updatedAtMs decroissant (create → rename → close → merge). */
    return loadAll().then(function (map) {
      return Object.keys(map).map(function (id) { return map[id]; })
        .sort(function (a, b) { return (b.updatedAtMs || 0) - (a.updatedAtMs || 0); });
    });
  }

  function get(sid) {
    return loadAll().then(function (map) { return map[sid] || null; });
  }

  function save(session) {
    var sid = session.sessionId;
    var text = JSON.stringify(session, null, 2);
    if (!global.cordova || !global.cordova.file || !global.resolveLocalFileSystemURL) {
      persistWeb(sid, text);
      if (cache) cache[sid] = session;
      emit("SESSION_STORE_SAVE sessionId=" + sid + " storage=web");
      return Promise.resolve(session);
    }
    return queueWrite(sid, text).then(function () {
      if (cache) cache[sid] = session;
      emit("SESSION_STORE_SAVE sessionId=" + sid + " storage=file state=" + session.state);
      return session;
    });
  }

  function remove(sid) {
    var done;
    if (!global.cordova || !global.cordova.file || !global.resolveLocalFileSystemURL) {
      try {
        var all = JSON.parse(global.localStorage.getItem("multicam.sessions.list") || "{}");
        delete all[sid];
        global.localStorage.setItem("multicam.sessions.list", JSON.stringify(all));
      } catch (e) {}
      done = Promise.resolve();
    } else {
      /* le fichier peut être déjà absent (rejet, provisional) → on ne propage pas
       * l'erreur : le nettoyage du cache doit toujours s'exécuter. */
      done = getEntry(sid).then(function (entry) {
        return new Promise(function (resolve) {
          entry.remove(function () { resolve(); }, function () { resolve(); });
        });
      }).catch(function (e) {
        emit("SESSION_STORE_REMOVE_MISSING sid=" + sid + " err=" + (e && e.message));
      });
    }
    /* purge du cache dans TOUTES les branches (bug de convergence J04 : le
     * return anticipé de la branche file laissait une copie périmée servie
     * par list()/get()). */
    if (cache) delete cache[sid];
    return done.then(function () {
      emit("SESSION_STORE_REMOVE sid=" + sid);
    });
  }

  function resetCache() { cache = null; }

  global.MultiCamSessionStore = {
    loadAll: loadAll,
    list: list,
    get: get,
    save: save,
    remove: remove,
    resetCache: resetCache
  };
})(window);