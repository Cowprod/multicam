var exec = require('cordova/exec');
exports.freeSpace = function(path, success, error) { exec(success, error, 'MultiCamPlatform', 'freeSpace', [path]); };
exports.ipv4 = function(success, error) { exec(success, error, 'MultiCamPlatform', 'ipv4', []); };
exports.intentExtra = function(name, success, error) { exec(success, error, 'MultiCamPlatform', 'intentExtra', [name]); };