/* MultiCam — faux systeme de fichiers Cordova pour les tests Node (J16-P0).
 *
 * Le code de production (state/session-store.js) utilise l'API cordova-plugin-file
 * (resolveLocalFileSystemURL, DirectoryEntry, FileEntry, FileWriter, FileReader).
 * Ce module en fournit une imitation FIDELE pour deux comportements critiques :
 *
 *   - `moveTo` : deux modes. "rename" (POSIX : remplace atomiquement, source
 *     supprimee) et "copy" (fallback Android : destination TRONQUEE puis copie
 *     en flux, source supprimee seulement apres succes). Le mode "copy" permet
 *     de simuler une mort du processus AU MILIEU de la copie : la destination
 *     est partielle, la source intacte.
 *   - erreurs asynchrones injectables (`failNext`) et arret brutal (`kill`) :
 *     apres `kill`, plus aucun callback ne s'execute — comme un force-stop.
 *
 * Le "disque" est un objet JS partage : creer un nouvel env avec le meme disque
 * simule un redemarrage de l'application. Aucun test ne depend du vrai Cordova.
 */

"use strict";

function createDisk() {
  return {
    files: {},                 /* nom -> contenu texte (repertoire sessions/) */
    dead: false,
    timers: new Set(),
    ops: [],                   /* journal d'operations (assertions) */
    moveMode: "rename",        /* "rename" | "copy" */
    killAfterCopyBytes: null,  /* mode copy : mort apres N octets copies */
    killOnMove: null,          /* mode copy : mort pendant le Nieme moveTo (1-based) */
    moveCount: 0,
    failNext: null,            /* { op, code } : prochaine operation en erreur */
    get: function (name) { return this.files[name] !== undefined ? this.files[name] : null; },
    set: function (name, text) { this.files[name] = String(text); },
    has: function (name) { return Object.prototype.hasOwnProperty.call(this.files, name); },
    names: function () { return Object.keys(this.files).sort(); }
  };
}

function install(env, disk) {
  disk.files = disk.files || {};
  disk.timers = disk.timers || new Set();
  disk.ops = [];
  disk.dead = false;
  disk.moveCount = 0;

  function later(fn) {
    var id = setTimeout(function () {
      disk.timers.delete(id);
      if (disk.dead) return;
      fn();
    }, 0);
    disk.timers.add(id);
  }

  function kill() {
    disk.dead = true;
    disk.timers.forEach(function (id) { clearTimeout(id); });
    disk.timers.clear();
  }

  function has(name) { return Object.prototype.hasOwnProperty.call(disk.files, name); }

  function takeFault(op) {
    if (!disk.failNext || disk.failNext.op !== op) return null;
    var f = disk.failNext;
    disk.failNext = null;
    return f;
  }

  function fileObj(name) {
    return {
      name: name,
      size: (disk.files[name] || "").length,
      _content: disk.files[name] || "",
      type: "application/json"
    };
  }

  function entryFor(dir, name) {
    var entry = {
      isFile: true,
      isDirectory: false,
      name: name,
      fullPath: "/" + name,
      nativeURL: "file:///data/sessions/" + name,
      file: function (cb, err) {
        later(function () {
          if (!has(name)) { if (err) err({ code: 1 }); return; }
          cb(fileObj(name));
        });
      },
      createWriter: function (cb, err) {
        later(function () {
          var f = takeFault("createWriter");
          if (f) { if (err) err({ code: f.code || 10 }); return; }
          if (!has(name)) { if (err) err({ code: 1 }); return; }
          var pos = 0;
          var writer = {
            position: 0,
            onwriteend: null,
            onerror: null,
            seek: function (p) { pos = p; writer.position = p; },
            truncate: function (len) {
              later(function () {
                var t = takeFault("truncate");
                if (t) { if (writer.onerror) writer.onerror({ code: t.code || 10 }); return; }
                disk.files[name] = (disk.files[name] || "").slice(0, len);
                if (writer.onwriteend) writer.onwriteend();
              });
            },
            write: function (text) {
              later(function () {
                var w = takeFault("write");
                if (w) { if (writer.onerror) writer.onerror({ code: w.code || 10 }); return; }
                var cur = disk.files[name] || "";
                disk.files[name] = cur.slice(0, pos) + text + cur.slice(pos + text.length);
                pos += text.length;
                writer.position = pos;
                if (writer.onwriteend) writer.onwriteend();
              });
            }
          };
          cb(writer);
        });
      },
      remove: function (cb, err) {
        later(function () {
          if (!has(name)) { if (err) err({ code: 1 }); return; }
          delete disk.files[name];
          if (cb) cb();
        });
      },
      moveTo: function (dirEntry, newName, cb, err) {
        later(function () {
          var f = takeFault("moveTo");
          if (f) { if (err) err({ code: f.code || 10 }); return; }
          if (!has(name)) { if (err) err({ code: 1 }); return; }
          var src = disk.files[name];
          var existed = has(newName);
          disk.moveCount += 1;
          disk.ops.push({ op: "moveTo", from: name, to: newName, destExisted: existed, mode: disk.moveMode, n: disk.moveCount });
          if (disk.moveMode === "rename") {
            disk.files[newName] = src;
            delete disk.files[name];
            if (cb) cb(entryFor(dirEntry, newName));
            return;
          }
          /* Fallback Android : la destination est TRONQUEE avant la copie. */
          disk.files[newName] = "";
          var killNow = disk.killOnMove !== null ? (disk.killOnMove === disk.moveCount) : (disk.killAfterCopyBytes !== null);
          if (killNow) {
            var n = disk.killAfterCopyBytes === null ? 12 : disk.killAfterCopyBytes;
            disk.killAfterCopyBytes = null;
            disk.killOnMove = null;
            disk.files[newName] = src.slice(0, n);
            kill();
            return; /* processus mort : aucun callback */
          }
          disk.files[newName] = src;
          delete disk.files[name];
          if (cb) cb(entryFor(dirEntry, newName));
        });
      },
      copyTo: function (dirEntry, newName, cb, err) {
        later(function () {
          if (!has(name)) { if (err) err({ code: 1 }); return; }
          disk.files[newName] = disk.files[name];
          if (cb) cb(entryFor(dirEntry, newName));
        });
      }
    };
    return entry;
  }

  var dir = {
    isFile: false,
    isDirectory: true,
    name: "sessions",
    fullPath: "/sessions/",
    getFile: function (name, opts, cb, err) {
      later(function () {
        var f = takeFault("getFile");
        if (f) { if (err) err({ code: f.code || 1 }); return; }
        if (!has(name)) {
          var create = !!(opts && opts.create);
          if (!create) { if (err) err({ code: 1 }); return; }
          disk.files[name] = "";
        }
        cb(entryFor(dir, name));
      });
    },
    getDirectory: function (name, opts, cb) {
      later(function () { cb(dir); });
    },
    createReader: function () {
      return {
        readEntries: function (cb, err) {
          later(function () {
            var names = Object.keys(disk.files);
            if (err) { /* jamais */ }
            cb(names.map(function (n) { return entryFor(dir, n); }));
          });
        }
      };
    }
  };

  env.cordova = { file: { dataDirectory: "file:///data/" } };
  env.resolveLocalFileSystemURL = function (url, cb, err) {
    later(function () {
      if (fnFault(err)) return;
      cb({
        isDirectory: true,
        getDirectory: dir.getDirectory,
        getFile: dir.getFile
      });
    });
  };

  function fnFault(err) {
    var f = takeFault("resolve");
    if (!f) return false;
    if (err) err({ code: f.code || 1 });
    return true;
  }

  env.FileReader = function FakeFileReader() {
    this.result = null;
    this.onloadend = null;
    this.onerror = null;
  };
  env.FileReader.prototype.readAsText = function (file) {
    var self = this;
    later(function () {
      var f = takeFault("read");
      if (f) { if (self.onerror) self.onerror({ code: f.code || 4 }); return; }
      self.result = file._content;
      if (self.onloadend) self.onloadend();
    });
  };

  disk.kill = kill;
  disk.get = function (name) { return has(name) ? disk.files[name] : null; };
  disk.set = function (name, text) { disk.files[name] = String(text); };
  disk.has = has;
  disk.names = function () { return Object.keys(disk.files).sort(); };
  return disk;
}

module.exports = { createDisk: createDisk, install: install };
