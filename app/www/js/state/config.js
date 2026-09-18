/* MultiCam — état local persistant (J02).
 * Gestion centralisée de la configuration persistante dans le fichier JSON
 * cordova.file.dataDirectory + "config.json" (source de vérité).
 * - deviceId : UUID v4 généré UNE fois à la première création, jamais dérivé du
 *   réseau / d'une adresse IP, distinct du device.uuid Cordova.
 * - nom du device modifiable ; skills supportées distinctes des skills activées ;
 *   destination de stockage (interne par défaut ou dossier SAF).
 * - schéma versionné (schemaVersion) avec migration raisonnée.
 * Toutes les lectures/écritures passent par cette couche (log parsable). */

(function (global) {
  "use strict";

  var SCHEMA_VERSION = 1;
  var FILE_NAME = "config.json";
  var DEFAULT_DEVICE_NAME = "Cam 07";
  var DEFAULT_SUPPORTED = ["capture", "storage", "controller"];

  var SKILL_META = {
    capture: { icon: "fa-video", label: "Capture" },
    storage: { icon: "fa-hard-drive", label: "Storage" },
    controller: { icon: "fa-sliders", label: "Master" }
  };

  var STATE = null;

  function defaultConfig() {
    return {
      schemaVersion: SCHEMA_VERSION,
      deviceId: uuidv4(),
      deviceName: DEFAULT_DEVICE_NAME,
      supportedSkills: DEFAULT_SUPPORTED.slice(),
      enabledSkills: ["capture", "storage", "controller"],
      storage: { mode: "internal", treeUri: null, displayName: null }
    };
  }

  /* UUID v4 aléatoire (crypto.getRandomValues du WebView ; repli Math.random). */
  function uuidv4() {
    var b = new Uint8Array(16);
    if (global.crypto && global.crypto.getRandomValues) {
      global.crypto.getRandomValues(b);
    } else {
      for (var i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var hex = "";
    for (var j = 0; j < 16; j++) hex += (b[j] < 16 ? "0" : "") + b[j].toString(16);
    return hex.substr(0, 8) + "-" + hex.substr(8, 4) + "-" + hex.substr(12, 4) + "-" + hex.substr(16, 4) + "-" + hex.substr(20);
  }

  /* Migration raisonnée : complète les champs manquants, respecte le deviceId existant. */
  function sanitize(raw) {
    var cfg = (raw && typeof raw === "object") ? raw : {};
    var supported = Array.isArray(cfg.supportedSkills) && cfg.supportedSkills.length ? cfg.supportedSkills : DEFAULT_SUPPORTED.slice();
    var out = {
      schemaVersion: SCHEMA_VERSION,
      deviceId: typeof cfg.deviceId === "string" && cfg.deviceId ? cfg.deviceId : uuidv4(),
      deviceName: typeof cfg.deviceName === "string" && cfg.deviceName.trim() ? cfg.deviceName : DEFAULT_DEVICE_NAME,
      supportedSkills: supported,
      enabledSkills: Array.isArray(cfg.enabledSkills) ? cfg.enabledSkills.filter(function (s) {
        return supported.indexOf(s) >= 0;
      }) : [],
      storage: {
        mode: cfg.storage && cfg.storage.mode === "saf" ? "saf" : "internal",
        treeUri: cfg.storage && typeof cfg.storage.treeUri === "string" ? cfg.storage.treeUri : null,
        displayName: cfg.storage && typeof cfg.storage.displayName === "string" ? cfg.storage.displayName : null
      }
    };
    return out;
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
      global.resolveLocalFileSystemURL(global.cordova.file.dataDirectory, resolve, reject);
    });
  }

  function persist() {
    var text = JSON.stringify(STATE, null, 2);
    if (!global.cordova || !global.cordova.file || !global.resolveLocalFileSystemURL) {
      try { global.localStorage.setItem("multicam.config.json", text); } catch (e) {}
      return Promise.resolve(STATE);
    }
    return workingDir().then(function (dir) {
      return new Promise(function (resolve, reject) {
        dir.getFile(FILE_NAME, { create: true, exclusive: false }, function (entry) {
          writeFile(entry, text).then(resolve, reject);
        }, reject);
      });
    });
  }

  function loadFromDisk() {
    return workingDir().then(function (dir) {
      return new Promise(function (resolve, reject) {
        dir.getFile(FILE_NAME, { create: false, exclusive: false }, function (entry) {
          readFile(entry).then(function (text) {
            var raw = null;
            try { raw = JSON.parse(text); } catch (e) {}
            STATE = sanitize(raw);
            console.log("CONFIG_INIT source=loaded deviceId=" + STATE.deviceId
              + " schema=" + SCHEMA_VERSION
              + " deviceName=" + STATE.deviceName
              + " enabledSkills=[" + STATE.enabledSkills.join(",") + "]"
              + " storage=" + STATE.storage.mode);
            resolve(STATE);
          }, reject);
        }, function () {
          // Première exécution : le fichier n'existe pas encore.
          STATE = defaultConfig();
          persist().then(function () {
            console.log("CONFIG_INIT source=created deviceId=" + STATE.deviceId
              + " schema=" + SCHEMA_VERSION
              + " deviceName=" + STATE.deviceName
              + " enabledSkills=[" + STATE.enabledSkills.join(",") + "]"
              + " storage=" + STATE.storage.mode);
            resolve(STATE);
          }, reject);
        });
      });
    });
  }

  function loadFromWeb() {
    var text = null;
    try { text = global.localStorage.getItem("multicam.config.json"); } catch (e) {}
    if (text) {
      var raw = null;
      try { raw = JSON.parse(text); } catch (e) {}
      STATE = sanitize(raw);
      console.log("CONFIG_INIT source=web deviceId=" + STATE.deviceId + " schema=" + SCHEMA_VERSION);
    } else {
      STATE = defaultConfig();
      persist();
      console.log("CONFIG_INIT source=web-created deviceId=" + STATE.deviceId + " schema=" + SCHEMA_VERSION);
    }
    return Promise.resolve(STATE);
  }

  function load() {
    if (STATE) return Promise.resolve(STATE);
    if (global.cordova && global.cordova.file && global.resolveLocalFileSystemURL) {
      return loadFromDisk();
    }
    return loadFromWeb();
  }

  function setDeviceName(name) {
    var n = typeof name === "string" ? name.trim() : "";
    if (!n) return Promise.reject(new Error("device_name_empty"));
    STATE.deviceName = n;
    return persist().then(function () {
      console.log("DEVICE_NAME_SET name=" + STATE.deviceName);
      return STATE;
    });
  }

  function setSkill(skill, enabled) {
    if (!skill) return Promise.reject(new Error("skill_name_missing"));
    var isSupported = STATE.supportedSkills.indexOf(skill) >= 0;
    var wasEnabled = STATE.enabledSkills.indexOf(skill) >= 0;
    if (enabled && !isSupported) {
      console.log("SKILL_SET skill=" + skill + " enabled=1 result=REJECTED_UNSUPPORTED");
      return Promise.reject(new Error("unsupported_skill:" + skill));
    }
    if (enabled === wasEnabled) {
      console.log("SKILL_SET skill=" + skill + " enabled=" + (enabled ? 1 : 0) + " result=NOOP");
      return Promise.resolve(STATE);
    }
    if (enabled) STATE.enabledSkills.push(skill);
    else STATE.enabledSkills = STATE.enabledSkills.filter(function (s) { return s !== skill; });
    return persist().then(function () {
      console.log("SKILL_SET skill=" + skill + " enabled=" + (enabled ? 1 : 0) + " result=OK");
      return STATE;
    });
  }

  function setStorage(mode, treeUri, displayName) {
    if (mode !== "saf" && mode !== "internal") return Promise.reject(new Error("bad_storage_mode:" + mode));
    STATE.storage = {
      mode: mode,
      treeUri: mode === "saf" ? treeUri : null,
      displayName: mode === "saf" ? displayName : null
    };
    return persist().then(function () {
      console.log("STORAGE_SET mode=" + STATE.storage.mode
        + (STATE.storage.mode === "saf" ? " displayName=" + STATE.storage.displayName : ""));
      return STATE;
    });
  }

  function resetStorage() {
    STATE.storage = { mode: "internal", treeUri: null, displayName: null };
    return persist().then(function () {
      console.log("STORAGE_RESET mode=internal");
      return STATE;
    });
  }

  global.MultiCamConfig = {
    load: load,
    get: function () { return STATE; },
    setDeviceName: setDeviceName,
    setSkill: setSkill,
    setStorage: setStorage,
    resetStorage: resetStorage,
    isControllerEnabled: function () {
      return STATE && STATE.enabledSkills.indexOf("controller") >= 0;
    },
    skillMeta: SKILL_META
  };
})(window);