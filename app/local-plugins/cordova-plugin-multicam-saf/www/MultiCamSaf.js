var exec = require('cordova/exec');
exports.chooseDirectory = function(success, error) { exec(success, error, 'MultiCamSaf', 'chooseDirectory', []); };
exports.testWrite = function(uri, success, error) { exec(success, error, 'MultiCamSaf', 'testWrite', [uri]); };
exports.listPersisted = function(success, error) { exec(success, error, 'MultiCamSaf', 'listPersisted', []); };
exports.getTreeName = function(uri, success, error) { exec(success, error, 'MultiCamSaf', 'getTreeName', [uri]); };
