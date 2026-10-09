/* MultiCam — passerelle JS du plugin cordova-plugin-multicam-httpd (vendored
 * depuis cordova-httpd 0.9.2, licence MIT). Android-only dans ce projet.
 *
 * Différences avec l'amont :
 *  - option `token` : exigée sur chaque requête HTTP (accès LAN protégé) ;
 *  - le listing de dossier est désactivé côté natif. */
'use strict';

var exec = require('cordova/exec');

var CorHttpd = {
  startServer: function (options, success, error) {
    var defaults = {
      www_root: '',
      port: 8888,
      localhost_only: false,
      token: ''
    };
    options = options || {};
    for (var key in defaults) {
      if (typeof options[key] !== 'undefined') defaults[key] = options[key];
    }
    exec(success, error, 'CorHttpd', 'startServer', [defaults]);
  },

  stopServer: function (success, error) {
    exec(success, error, 'CorHttpd', 'stopServer', []);
  },

  getURL: function (success, error) {
    exec(success, error, 'CorHttpd', 'getURL', []);
  },

  getLocalPath: function (success, error) {
    exec(success, error, 'CorHttpd', 'getLocalPath', []);
  }
};

module.exports = CorHttpd;
