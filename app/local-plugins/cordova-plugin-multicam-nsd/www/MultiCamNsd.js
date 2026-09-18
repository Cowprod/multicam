var exec = require('cordova/exec');

/** MultiCamNSD native bridge (mDNS/NSD + GET /health endpoint). */
exports.start = function(opts, success, error) { exec(success, error, 'MultiCamNsd', 'start', [opts || {}]); };
exports.reannounce = function(opts, success, error) { exec(success, error, 'MultiCamNsd', 'reannounce', [opts || {}]); };
exports.stop = function(success, error) { exec(success, error, 'MultiCamNsd', 'stop', []); };
exports.status = function(success, error) { exec(success, error, 'MultiCamNsd', 'status', []); };
exports.probeLocalAccess = function(opts, success, error) { exec(success, error, 'MultiCamNsd', 'probeLocalAccess', [opts || {}]); };
exports.events = function(success, error) { exec(success, error, 'MultiCamNsd', 'events', []); };