/* MultiCam J11 — passerelle JS du plugin natif de transfert média.
 *
 * Aucune donnée média ne traverse ce bridge : les opérations rendent des
 * métadonnées (sha256, octets, progression), le contenu reste natif. */
'use strict';

var exec = require('cordova/exec');

var MultiCamTransfer = {
  /* Empreinte SHA-256 d'un fichier, en streaming. `success({sha256, bytes})`. */
  sha256: function (path, success, error) {
    exec(success, error, 'MultiCamTransfer', 'sha256', [path]);
  },

  /* Déplace un fichier local vers une destination absolue (dossiers créés,
   * destination remplacée). `success({dest, bytes})`. */
  stage: function (src, dest, success, error) {
    exec(success, error, 'MultiCamTransfer', 'stage', [src, dest]);
  },

  /* Supprime un fichier local. `success({removed, path})`. */
  remove: function (path, success, error) {
    exec(success, error, 'MultiCamTransfer', 'remove', [path]);
  },

  /* J17-A — listing read-only d'un dossier. `success({path, entries:[{name,
   * bytes, dir}]})`. Seuls les fichiers RÉGULIERS sont listés. */
  list: function (path, success, error) {
    exec(success, error, 'MultiCamTransfer', 'list', [path]);
  },

  /* GET HTTP reprenable vers un fichier ou une arborescence SAF.
   * opts = { url, token, dest?, treeUri?, relPath?, offset?, expectedBytes? }
   * onProgress({received,total}) appelé périodiquement ;
   * success({done,received,total,sha256}). */
  download: function (opts, onProgress, success, error) {
    exec(function (res) {
      if (res && res.progress) {
        if (onProgress) onProgress(res);
      } else if (success) {
        success(res);
      }
    }, error, 'MultiCamTransfer', 'download', [opts || {}]);
  }
};

module.exports = MultiCamTransfer;
