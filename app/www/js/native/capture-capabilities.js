/* MultiCam — J06 Capture Capabilities (native, qualifié en POC tests/poc/capture-capabilities).
 * Le plugin cordova-plugin-camera-preview (master épinglé) reçoit l'action native
 * `getCaptureCapabilities` via app/camera-patches/apply_capture_capabilities_patch.py
 * (ré-appliquée par app/setup-android.sh). Ce module :
 *   - expose l'action native quand Cordova ne l'a pas encore (shim) ;
 *   - normalise la réponse brute (camcorderProfiles/cameras) via le modèle
 *     MultiCamTakeModel.normalizeCapabilities → forme J06 (HD/FHD/4K, GPS, audio) ;
 *   - gère un cache, la télémétrie "inconnue" honnête (aucune invention) et un
 *     hook DEBUG `setFixtureMap` réservé aux bullets SIMULATED de la campagne
 *     (jamais actif dans le flux normal : probe() lit d'abord le natif).
 *
 * Device réel non-Master (sans canal WS) : getForDevice renvoie { unknown:true }
 * documenté — limitation V1 (pas de canal télémetrie pour les non-Masters). */

(function (global) {
  "use strict";

  var PLUGIN_NAME = "CameraPreview";
  var DEBUG_FIXTURES = {}; /* deviceId -> fixture map (hook debug, bullet SIMULATED) */
  var CACHE = {};          /* deviceId -> normalizeCapabilities(result) | {unknown:true} */
  var model = null;

  function takeModel() {
    if (model) return model;
    if (global.MultiCamTakeModel) { model = global.MultiCamTakeModel; return model; }
    if (global.MultiCamSessionModel && global.MultiCamSessionModel.takeModel) {
      model = global.MultiCamSessionModel.takeModel;
      return model;
    }
    return null;
  }

  function normalizeCaps(raw) {
    var tm = takeModel();
    if (!tm) return { unknown: true, probedAtMs: 0 };
    var caps = tm.normalizeCapabilities(raw);
    caps.probedAtMs = Date.now();
    return caps;
  }

  function installShim() {
    if (!global.CameraPreview || typeof global.cordova === "undefined" || typeof cordova.exec !== "function") {
      return false;
    }
    if (typeof global.CameraPreview.getCaptureCapabilities === "function") {
      return true;
    }
    global.CameraPreview.getCaptureCapabilities = function (onSuccess, onError) {
      cordova.exec(onSuccess, onError, PLUGIN_NAME, "getCaptureCapabilities", []);
    };
    return true;
  }

  function rawProbe(deviceId) {
    return new Promise(function (resolve) {
      if (DEBUG_FIXTURES[deviceId || selfDeviceId()]) {
        resolve(DEBUG_FIXTURES[deviceId || selfDeviceId()]);
        return;
      }
      var cp = global.CameraPreview;
      if (!cp || typeof global.cordova === "undefined" || typeof cordova.exec !== "function") {
        resolve(null);
        return;
      }
      var fn = cp.getCaptureCapabilities || function (ok, err) { cordova.exec(ok, err, PLUGIN_NAME, "getCaptureCapabilities", []); };
      fn(function (res) { resolve(res || null); }, function () { resolve(null); });
    });
  }

  function selfDeviceId() {
    try {
      var ws = global.MultiCamSessionWs;
      if (ws && typeof ws.status === "function") {
        var st = ws.status();
        if (st && st.localDid) return st.localDid;
      }
    } catch (e) { /* ws pas encore prêt */ }
    try {
      var cfg = global.MultiCamConfig;
      if (typeof cfg === "function") {
        var v = cfg();
        if (v && v.deviceId) return v.deviceId;
      } else if (cfg && cfg.deviceId) {
        return cfg.deviceId;
      } else if (cfg && typeof cfg.get === "function") {
        var g = cfg.get();
        if (g && g.deviceId) return g.deviceId;
      }
    } catch (e) { /* config indisponible */ }
    return "";
  }

  /* Sonde native de CE device (aucun enregistrement démarré) et mémorise le
   * résultat normalisé. Retour Promise<capabilities normalisées>. */
  function probe(deviceIdOverride) {
    var did = deviceIdOverride || selfDeviceId();
    return rawProbe(did).then(function (raw) {
      var caps = normalizeCaps(raw);
      CACHE[did] = caps;
      return caps;
    });
  }

  /* Renvoie (Promise) les capacités d'un device : ce device (self) → sondé ;
   * un autre device connu → remonte la télémétrie auto-déclarée fusionnée dans
   * la session (jamais inventée) ; sinon → {unknown:true}. */
  function capabilitiesFor(deviceId, session) {
    var self = selfDeviceId();
    if (deviceId === self) {
      if (CACHE[self]) return Promise.resolve(CACHE[self]);
      return probe(self);
    }
    if (session && session.members && deviceId) {
      var m = session.members.filter(function (x) { return x.deviceId === deviceId; })[0];
      if (m && m.telemetry && m.telemetry.capabilities && typeof m.telemetry.capabilities === "object") {
        return Promise.resolve(normalizeCaps(m.telemetry.capabilities));
      }
    }
    return Promise.resolve({ unknown: true, probedAtMs: 0 });
  }

  /* Hook DEBUG — bullets SIMULATED de la campagne J06 uniquement. Injecte un
   * fixture brut (même forme que la réponse native) pour un deviceId donné.
   * Le flux normal n'utilise jamais ce hook. */
  function setFixtureMap(deviceId, rawFixture) {
    DEBUG_FIXTURES[deviceId] = rawFixture;
    delete CACHE[deviceId];
  }

  function clearFixtures() {
    Object.keys(DEBUG_FIXTURES).forEach(function (k) {
      delete DEBUG_FIXTURES[k];
      delete CACHE[k]; /* invalide aussi le cache pour retomber sur le probe natif */
    });
  }

  global.MultiCamCaptureCapabilities = {
    installShim: installShim,
    probe: probe,
    capabilitiesFor: capabilitiesFor,
    setFixtureMap: setFixtureMap,
    clearFixtures: clearFixtures
  };

  document.addEventListener("deviceready", installShim, false);
})(window);