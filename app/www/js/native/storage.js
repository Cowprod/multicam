/* MultiCam — stockage (J02).
 * Emplacement par défaut = répertoire applicatif externe en écriture
 * (cordova.file.externalDataDirectory, validé par le POC avec cordova-plugin-file).
 * Un chemin n'est jamais considéré valide sur sa seule existence : test réel
 * d'écriture (probe). Destination SAF gérée via le plugiciel qualifié
 * cordova-plugin-multicam-saf (write/delete POC + getTreeName extension J02). */

(function (global) {
  "use strict";

  function defaultPath() {
    if (global.cordova && global.cordova.file && cordova.file.externalDataDirectory) {
      return cordova.file.externalDataDirectory;
    }
    return null;
  }

  /* Probe d'écriture dans le répertoire applicatif externe (default storage). */
  function writeProbe() {
    return new Promise(function (resolve, reject) {
      if (!global.resolveLocalFileSystemURL || !defaultPath()) {
        reject(new Error("file_api_unavailable"));
        return;
      }
      resolveLocalFileSystemURL(defaultPath(), function (dir) {
        var name = "multicam-io-probe-" + Date.now() + ".txt";
        var content = "MultiCam write probe " + Date.now() + "\n";
        function cleanup(entry) {
          return new Promise(function (res, rej) {
            entry.remove(function () { res({ ok: true, path: defaultPath(), bytes: content.length }); }, rej);
          });
        }
        dir.getFile(name, { create: true, exclusive: false }, function (entry) {
          entry.createWriter(function (w) {
            w.onwriteend = function () {
              cleanup(entry).then(resolve, reject);
            };
            w.onerror = function (e) { reject(e); };
            w.write(content);
          }, reject);
        }, reject);
      }, reject);
    });
  }

  /* Chemin système (sans schéma file://) pour StatFs. */
  function systemPath(fileUrl) {
    if (!fileUrl) return null;
    return String(fileUrl).replace(/^file:\/\//, "").replace(/\/$/, "") || null;
  }

  /* Emplacement courant affiché (libellé lisible). */
  function displayPath(cfg) {
    if (cfg.storage.mode === "saf") {
      return cfg.storage.displayName || cfg.storage.treeUri || "Dossier SAF";
    }
    return defaultPath();
  }

  global.MultiCamStorage = {
    defaultPath: defaultPath,
    systemPath: systemPath,
    writeProbe: writeProbe,
    displayPath: displayPath
  };
})(window);