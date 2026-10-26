/* MultiCam — persistance locale des sessions (J04, durcissement J16-P0).
 * Suit le pattern de config.js (J02) : schema versionne, sanitization raisonnee,
 * log parsable, cordova.file.dataDirectory, comportement robuste au restart.
 * Un fichier par session : sessions/<sessionId>.json — il ne contient que l'etat
 * reellement requis par J04 (pas de structures J05/J06 en placeholder).
 *
 * J16-P0 — l'ecriture directe (<sid>.json : truncate(0) puis write) pouvait
 * laisser un fichier de 0 octet si le processus etait tue entre les deux
 * operations (incident DEBNCYNA, 2026-10-22). L'ecriture suit desormais le
 * schema "fichier temporaire verifie + version precedente conservee" :
 *
 *   1. <sid>.json.tmp  recoit le contenu complet ;
 *   2. il est RELU et compare octet par octet (preuve que l'ecriture est finie) ;
 *   3. la version courante valide devient <sid>.json.bak ;
 *   4. <sid>.json.tmp remplace <sid>.json ;
 *   5. les temporaires inutiles sont nettoyes.
 *
 * Invariant : a aucun instant il n'existe zero version valide sur disque.
 * L'atomicite de Cordova `moveTo` n'est PAS supposee : sur Android elle tente
 * `renameTo` puis retombe sur une COPIE qui tronque la destination ; le tmp
 * n'est supprime qu'apres une copie reussie, et la recuperation prefere un tmp
 * complet a un primaire partiel.
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
  var PRIMARY = ".json";
  var TMP = ".json.tmp";
  var BAK = ".json.bak";
  var M = function () { return global.MultiCamSessionModel; };

  var cache = null;            /* sessionId -> session (charge une seule fois). */
  var loading = null;          /* loadAll en cours (single flight). */
  var pendingSaves = {};       /* saves termines pendant un load (overlay). */
  var primaryGood = {};        /* sid -> le primaire contient la version verifiee. */
  var degraded = {};           /* sid -> recuperation non materialisee (ecritures refusees). */
  var removed = {};            /* sid -> tombstone : une session supprimee ne revient JAMAIS. */

  function emit(line) { console.log(line); }
  function errMsg(e) { return String((e && (e.message || e.code)) || e); }

  /* ---------- instrumentation de test (INERTE en production) ----------
   * Aucun code de l'application ne definit `MultiCamSessionStoreDebug`. Le harnais
   * de validation physique l'injecte via la console WebView (build debug) pour
   * suspendre une sauvegarde a un point nomme, le temps d'un `am force-stop`.
   * En production l'objet est absent : chaque appel est un no-op immediat. */
  function stage(name) {
    var d = global.MultiCamSessionStoreDebug;
    if (!d || d.enabled !== true) return Promise.resolve();
    global.__lastSessionStoreStage = name;
    emit("SESSION_STORE_STAGE stage=" + name);
    if (d.stage !== name) return Promise.resolve();
    if (d.kill === true) return new Promise(function () {}); /* simulation de mort */
    var ms = Number(d.delayMs) || 0;
    if (!ms) return Promise.resolve();
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* ---------- file I/O (meme meca que config.js) ---------- */

  function hasFileApi() {
    return !!(global.cordova && global.cordova.file && typeof global.resolveLocalFileSystemURL === "function");
  }

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

  /* Ecriture brute : troncature puis ecriture. Utilisee UNIQUEMENT pour le tmp
   * et pour la materialisation d'une version deja verifiee (jamais pour ecraser
   * la seule version valide d'une session). */
  function writeRaw(entry, text, instrumented) {
    return new Promise(function (resolve, reject) {
      entry.createWriter(function (w) {
        var step = 0;
        w.onwriteend = function () {
          if (step === 0) {
            step = 1;
            var afterTruncate = instrumented ? stage("tmp_truncated") : Promise.resolve();
            afterTruncate.then(function () { w.seek(0); w.write(text); }, reject);
          } else {
            resolve();
          }
        };
        w.onerror = function (e) { reject(e); };
        w.truncate(0);
      }, reject);
    });
  }

  /* Ecriture verifiee : le contenu relu doit etre IDENTIQUE au contenu ecrit.
   * C'est la preuve que l'ecriture est terminee (pas seulement "pas d'exception"). */
  function writeVerified(entry, text, instrumented) {
    return writeRaw(entry, text, instrumented).then(function () {
      if (instrumented) return stage("tmp_written");
    }).then(function () {
      return readFile(entry);
    }).then(function (got) {
      if (got !== text) throw new Error("session_write_verify_failed");
    });
  }

  function workingDir() {
    return new Promise(function (resolve, reject) {
      global.resolveLocalFileSystemURL(global.cordova.file.dataDirectory, function (root) {
        root.getDirectory(DIR_NAME, { create: true, exclusive: false }, resolve, reject);
      }, reject);
    });
  }

  function getFile(dir, name, create) {
    return new Promise(function (resolve, reject) {
      dir.getFile(name, { create: !!create, exclusive: false }, resolve, function (e) {
        reject(e || new Error("session_missing:" + name));
      });
    });
  }

  function isNotFound(e) { return !!(e && e.code === 1); }

  function removeIfExists(dir, name) {
    return getFile(dir, name, false).then(function (entry) {
      return new Promise(function (resolve, reject) {
        entry.remove(resolve, function (e) { if (isNotFound(e)) resolve(); else reject(e); });
      });
    }, function (e) {
      if (isNotFound(e)) return;
      throw e;
    });
  }

  function moveEntry(entry, dir, name) {
    return new Promise(function (resolve, reject) {
      entry.moveTo(dir, name, resolve, reject);
    });
  }

  function listNames(dir) {
    return new Promise(function (resolve, reject) {
      dir.createReader().readEntries(function (entries) {
        resolve((entries || []).filter(function (e) { return e.isFile; }).map(function (e) { return e.name; }));
      }, reject);
    });
  }

  /* ---------- validation / selection des versions ---------- */

  /* Une version n'est VALIDE que si elle est du JSON complet, dont le
   * sessionId est EXACTEMENT celui du nom de fichier. Un fichier partiel qui
   * "parse" par accident (ex. "{}") est rejete : sanitizeSession() lui
   * fabriquerait un nouvel identifiant, ce qui serait une invention. */
  function parseVersion(text, sid) {
    try {
      var raw = JSON.parse(text);
      if (!raw || typeof raw !== "object") return null;
      if (typeof raw.sessionId !== "string" || raw.sessionId !== sid) return null;
      var s = M().sanitizeSession(raw);
      if (!s || s.sessionId !== sid) return null;
      return s;
    } catch (e) {
      return null;
    }
  }

  function readCandidate(dir, name, sid) {
    return getFile(dir, name, false).then(function (entry) {
      return readFile(entry).then(function (text) {
        var s = parseVersion(text, sid);
        return s ? { text: text, session: s } : { text: text, session: null };
      });
    }, function (e) {
      if (isNotFound(e)) return null;
      throw e;
    });
  }

  function readCandidates(dir, sid) {
    return readCandidate(dir, sid + PRIMARY, sid).then(function (primary) {
      return readCandidate(dir, sid + TMP, sid).then(function (tmp) {
        return readCandidate(dir, sid + BAK, sid).then(function (bak) {
          return { primary: primary, tmp: tmp, bak: bak };
        });
      });
    });
  }

  function stateOf(c) {
    if (!c) return "missing";
    return c.session ? "valid" : "invalid";
  }

  /* Politique de recuperation DETERMINISTE (jamais d'apres une date) :
   *   1. tmp VALIDE      -> c'est l'ecriture complete la plus recente (elle a
   *                         ete verifiee avant d'etre candidate au remplacement) ;
   *   2. primaire VALIDE -> version confirmee ;
   *   3. backup VALIDE   -> derniere version precedente connue ;
   *   4. sinon           -> rien de recuperable, aucune fabrication.
   * Le primaire valide n'est jamais supprime au profit d'un candidat invalide. */
  function chooseVersion(c) {
    if (c.tmp && c.tmp.session) return { source: "tmp", version: c.tmp };
    if (c.primary && c.primary.session) return { source: "primary", version: c.primary };
    if (c.bak && c.bak.session) return { source: "backup", version: c.bak };
    return null;
  }

  /* Materialise la version choisie dans <sid>.json. La source reste intacte
   * jusqu'a ce que la copie ait ete relue et verifiee. Un echec laisse la source
   * en place et interdit les ecritures jusqu'au prochain demarrage (degraded).
   *
   * Cas "tmp choisi ET primaire valide" (mort entre la verification du tmp et
   * la rotation) : le primaire valide est D'ABORD conserve comme backup — il ne
   * doit jamais etre ecrase sans laisser de version precedente. */
  function materialize(dir, sid, c, pick) {
    function bestEffort(jobs) {
      return Promise.all(jobs).catch(function (e) {
        emit("SESSION_RECOVER_CLEANUP_WARN sid=" + sid + " err=" + errMsg(e));
      });
    }

    if (pick.source === "primary") {
      primaryGood[sid] = true;
      var stale = [];
      if (c.tmp) stale.push(removeIfExists(dir, sid + TMP));
      if (c.bak && !c.bak.session) stale.push(removeIfExists(dir, sid + BAK));
      return bestEffort(stale).then(function () { return true; });
    }

    var keepPrimaryAsBackup = !!(c.primary && c.primary.session);
    var prep;
    if (keepPrimaryAsBackup) {
      prep = removeIfExists(dir, sid + BAK).then(function () {
        return getFile(dir, sid + PRIMARY, false);
      }).then(function (primary) {
        return moveEntry(primary, dir, sid + BAK);
      });
    } else {
      prep = removeIfExists(dir, sid + PRIMARY);
    }

    return prep.then(function () {
      return getFile(dir, sid + PRIMARY, true);
    }).then(function (entry) {
      return writeVerified(entry, pick.version.text, false);
    }).then(function () {
      primaryGood[sid] = true;
      var stale = [];
      if (c.tmp) stale.push(removeIfExists(dir, sid + TMP));
      return bestEffort(stale);
    }).then(function () {
      return true;
    }, function (e) {
      primaryGood[sid] = false;
      degraded[sid] = "materialize_failed";
      emit("SESSION_RECOVER_MATERIALIZE_FAILED sid=" + sid + " source=" + pick.source + " err=" + errMsg(e));
      return false;
    });
  }

  function recoverOne(dir, sid, reason) {
    if (removed[sid]) return Promise.resolve(null);
    return readCandidates(dir, sid).then(function (c) {
      var pick = chooseVersion(c);
      if (!pick) {
        emit("SESSION_RECOVER_NONE sid=" + sid + " reason=" + reason
          + " primary=" + stateOf(c.primary) + " tmp=" + stateOf(c.tmp) + " backup=" + stateOf(c.bak));
        return null;
      }
      if (removed[sid]) return null;
      return materialize(dir, sid, c, pick).then(function (ok) {
        emit("SESSION_RECOVER sid=" + sid + " source=" + pick.source
          + " action=" + (pick.source === "primary" ? "none" : (ok ? "promoted" : "promote_failed"))
          + " reason=" + reason
          + " primary=" + stateOf(c.primary) + " tmp=" + stateOf(c.tmp) + " backup=" + stateOf(c.bak));
        return pick.version.session;
      });
    });
  }

  function baseSid(name) {
    if (typeof name !== "string") return null;
    if (name.slice(-TMP.length) === TMP) return name.slice(0, -TMP.length) || null;
    if (name.slice(-BAK.length) === BAK) return name.slice(0, -BAK.length) || null;
    if (name.slice(-PRIMARY.length) === PRIMARY) return name.slice(0, -PRIMARY.length) || null;
    return null;
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
        if (removed[sid]) return;
        var s = M().sanitizeSession(all[sid]);
        if (s && s.sessionId) out[s.sessionId] = s;
      });
    } catch (e) {}
    return out;
  }

  /* ---------- ecritures seriees par session ---------- */

  var queues = {};

  function enqueue(sid, job) {
    var prev = queues[sid] || Promise.resolve();
    var next = prev.then(function () { return job(); });
    queues[sid] = next.then(function () {}, function () {});
    return next;
  }

  /* ---------- chargement ---------- */

  function finishLoad(map) {
    Object.keys(removed).forEach(function (sid) { delete map[sid]; });
    Object.keys(pendingSaves).forEach(function (sid) {
      if (!removed[sid]) map[sid] = pendingSaves[sid];
    });
    pendingSaves = {};
    cache = map;
    return map;
  }

  function doLoad() {
    if (!hasFileApi()) return Promise.resolve(finishLoad(loadWeb()));
    return workingDir().then(function (dir) {
      return listNames(dir).then(function (names) {
        var sids = {};
        names.forEach(function (n) {
          var sid = baseSid(n);
          if (sid) sids[sid] = true;
        });
        var out = {};
        return Object.keys(sids).sort().reduce(function (p, sid) {
          return p.then(function () {
            return recoverOne(dir, sid, "boot").then(function (s) { if (s) out[sid] = s; });
          });
        }, Promise.resolve()).then(function () { return finishLoad(out); });
      });
    });
  }

  function loadAll() {
    if (cache) return Promise.resolve(cache);
    if (loading) return loading;
    loading = doLoad().then(function (map) {
      loading = null;
      return map;
    }, function (e) {
      loading = null;
      throw e;
    });
    return loading;
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

  /* ---------- sauvegarde atomique ---------- */

  /* Rotation best effort : l'ancienne version valide devient le backup. Un echec
   * n'interrompt pas la sauvegarde : le tmp verifie reste la source de verite
   * jusqu'a son remplacement (l'invariant ">= 1 version valide" tient). */
  function rotateBackup(dir, sid) {
    if (!primaryGood[sid]) {
      /* Primaire absent ou invalide : il sera remplace, ne pas polluer le backup. */
      return removeIfExists(dir, sid + PRIMARY).then(function () {
        return stage("bak_removed");
      });
    }
    return removeIfExists(dir, sid + BAK).then(function () {
      return stage("bak_removed");
    }).then(function () {
      return getFile(dir, sid + PRIMARY, false);
    }).then(function (primary) {
      return moveEntry(primary, dir, sid + BAK);
    }).then(function () {
      primaryGood[sid] = false; /* le primaire vient d'etre deplace */
    }).catch(function (e) {
      emit("SESSION_STORE_BAK_WARN sessionId=" + sid + " err=" + errMsg(e));
      /* Le primaire est-il toujours la ? S'il a disparu, la suite le remplacera. */
      return getFile(dir, sid + PRIMARY, false).then(function () {}, function () {
        primaryGood[sid] = false;
      });
    });
  }

  function commit(dir, sid, text) {
    return stage("before_tmp")
      .then(function () { return getFile(dir, sid + TMP, true); })
      .then(function (tmp) { return writeVerified(tmp, text, true); })
      .then(function () { return stage("tmp_verified"); })
      .then(function () { return rotateBackup(dir, sid); })
      .then(function () { return stage("primary_moved"); })
      .then(function () { return getFile(dir, sid + TMP, false); })
      .then(function (tmp) { return moveEntry(tmp, dir, sid + PRIMARY); })
      .then(function () { return stage("committed"); })
      .then(function () {
        primaryGood[sid] = true;
        /* Nettoyage best effort : les donnees sont deja engagees. */
        return removeIfExists(dir, sid + TMP).catch(function (e) {
          emit("SESSION_STORE_CLEANUP_WARN sessionId=" + sid + " err=" + errMsg(e));
        });
      });
  }

  /* Apres un echec d'ecriture, on retablit un etat sur disque sur AVANT de
   * rendre la main : une prochaine sauvegarde ne doit pas ecraser le seul tmp
   * valide. Si la reparation echoue, les ecritures sont refusees (degraded). */
  function repair(sid) {
    if (!hasFileApi()) return Promise.resolve();
    delete degraded[sid];
    return workingDir().then(function (dir) {
      return recoverOne(dir, sid, "repair");
    }).then(function (s) {
      if (!s) {
        degraded[sid] = "repair_no_version";
        throw new Error("session_store_repair_failed");
      }
    }, function (e) {
      degraded[sid] = "repair_failed";
      emit("SESSION_STORE_REPAIR_FAILED sessionId=" + sid + " err=" + errMsg(e));
      throw e;
    });
  }

  function save(session) {
    var sid = session && session.sessionId;
    if (!sid) return Promise.reject(new Error("session_store_missing_id"));
    var text = JSON.stringify(session, null, 2);
    if (removed[sid]) {
      emit("SESSION_STORE_SAVE_SKIPPED sessionId=" + sid + " reason=removed");
      return Promise.resolve(session);
    }
    if (degraded[sid]) {
      emit("SESSION_STORE_SAVE_REFUSED sessionId=" + sid + " reason=" + degraded[sid]);
      return Promise.reject(new Error("session_store_degraded:" + sid));
    }
    if (!hasFileApi()) {
      persistWeb(sid, text);
      if (cache) cache[sid] = session; else pendingSaves[sid] = session;
      emit("SESSION_STORE_SAVE sessionId=" + sid + " storage=web");
      return Promise.resolve(session);
    }
    var ready = loading ? loading.catch(function () {}) : Promise.resolve();
    return ready.then(function () {
      return enqueue(sid, function () {
        if (removed[sid]) {
          emit("SESSION_STORE_SAVE_SKIPPED sessionId=" + sid + " reason=removed");
          return session;
        }
        if (degraded[sid]) {
          emit("SESSION_STORE_SAVE_REFUSED sessionId=" + sid + " reason=" + degraded[sid]);
          throw new Error("session_store_degraded:" + sid);
        }
        return workingDir().then(function (dir) {
          return commit(dir, sid, text);
        }).then(function () {
          if (cache) cache[sid] = session; else pendingSaves[sid] = session;
          emit("SESSION_STORE_SAVE sessionId=" + sid + " storage=file state=" + session.state + " bak=1");
          return session;
        }, function (err) {
          emit("SESSION_STORE_SAVE_FAILED sessionId=" + sid + " err=" + errMsg(err));
          return repair(sid).then(function () { throw err; }, function () { throw err; });
        });
      });
    });
  }

  /* ---------- suppression ---------- */

  function remove(sid) {
    /* Tombstone SYNCHRONE : toute sauvegarde deja planifiee est ignoree et une
     * sauvegarde en vol ne peut pas recreer la session apres coup. */
    removed[sid] = true;
    delete pendingSaves[sid];
    delete degraded[sid];
    delete primaryGood[sid];

    function purgeCache() {
      if (cache) delete cache[sid];
      emit("SESSION_STORE_REMOVE sid=" + sid);
    }

    if (!hasFileApi()) {
      try {
        var all = JSON.parse(global.localStorage.getItem("multicam.sessions.list") || "{}");
        delete all[sid];
        global.localStorage.setItem("multicam.sessions.list", JSON.stringify(all));
      } catch (e) {}
      purgeCache();
      return Promise.resolve();
    }

    var ready = loading ? loading.catch(function () {}) : Promise.resolve();
    return ready.then(function () {
      return enqueue(sid, function () {
        return workingDir().then(function (dir) {
          return removeIfExists(dir, sid + PRIMARY)
            .then(function () { return removeIfExists(dir, sid + TMP); })
            .then(function () { return removeIfExists(dir, sid + BAK); });
        });
      });
    }).catch(function (e) {
      emit("SESSION_STORE_REMOVE_ERROR sid=" + sid + " err=" + errMsg(e));
    }).then(purgeCache);
  }

  function resetCache() {
    cache = null;
    loading = null;
    pendingSaves = {};
    primaryGood = {};
    degraded = {};
  }

  global.MultiCamSessionStore = {
    loadAll: loadAll,
    list: list,
    get: get,
    save: save,
    remove: remove,
    resetCache: resetCache
  };
})(window);
