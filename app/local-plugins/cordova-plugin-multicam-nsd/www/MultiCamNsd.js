var exec = require('cordova/exec');

/** MultiCamNSD native bridge (mDNS/NSD + GET /health endpoint).
 * Device path (J03) : start/reannounce/stop/status/probeLocalAccess/events.
 * Session path (J04) : advertiseSession/unadvertiseSession — annonce & découverte
 * DNS-SD du type distinct _multicam-session._tcp. (décision 30.3). Aucune logique
 * métier : TXT et port sont fournis par la couche JS. */
exports.start = function(opts, success, error) { exec(success, error, 'MultiCamNsd', 'start', [opts || {}]); };
exports.reannounce = function(opts, success, error) { exec(success, error, 'MultiCamNsd', 'reannounce', [opts || {}]); };
exports.advertiseSession = function(opts, success, error) { exec(success, error, 'MultiCamNsd', 'advertiseSession', [opts || {}]); };
exports.unadvertiseSession = function(success, error) { exec(success, error, 'MultiCamNsd', 'unadvertiseSession', []); };
exports.stop = function(success, error) { exec(success, error, 'MultiCamNsd', 'stop', []); };
exports.status = function(success, error) { exec(success, error, 'MultiCamNsd', 'status', []); };
exports.probeLocalAccess = function(opts, success, error) { exec(success, error, 'MultiCamNsd', 'probeLocalAccess', [opts || {}]); };
exports.events = function(success, error) { exec(success, error, 'MultiCamNsd', 'events', []); };