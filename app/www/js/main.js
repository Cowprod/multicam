/* MultiCam — point d'entrée application (J02 + J04).
 * Exigence journalisation distribuée : tous les événements importants en format
 * lisible/parsable (ex : APP_BOOT ...). Aucune donnée de démo n'est fabriquée.
 * Boot asynchrone : la configuration persistante (config.json) est chargée et
 * source de vérité avant le rendu de l'écran 01.
 *
 * J04 — monodocument SPA : tous les écrans sont des panneaux de index.html
 * (décision 30.7 : le cycle de vie réseau ne dépend pas de l'écran affiché ;
 * le serveur WebSocket générique démarre une fois et sa stream d'événements ne
 * meurt jamais — aucun ré-attache natif n'est nécessaire). */

(function (global) {
  "use strict";

  var appCfg = null;

  function logBoot(cfg, dev) {
    console.log("APP_BOOT app=" + "MultiCam"
      + " version=" + ((dev && dev.appVersion) || global.MultiCamDevice.appVersion)
      + " deviceId=" + cfg.deviceId
      + " deviceName=" + cfg.deviceName
      + " supportedSkills=[" + cfg.supportedSkills.join(",") + "]"
      + " enabledSkills=[" + cfg.enabledSkills.join(",") + "]"
      + " storage=" + cfg.storage.mode);
  }

  function debugTestHook(cfg) {
    if (!(global.cordova && global.MultiCamNative)) return Promise.resolve(null);
    return global.MultiCamNative.intentExtra("mcTestSkill").then(function (skill) {
      if (!skill) return null;
      console.log("TEST_HOOK skill=" + skill + " intentExtra=mcTestSkill");
      return global.MultiCamConfig.setSkill(skill, true).then(function () {
        console.log("TEST_HOOK result=" + skill + " unexpectedly_allowed");
      }).catch(function (err) {
        console.log("TEST_HOOK result=REJECTED reason=" + String((err && err.message) || err));
      });
    }).catch(function () {
      return null;
    });
  }

  /* ---------- routeur panneaux (index.html monodocument) ---------- */

  var panels = ["home", "create", "join", "session", "settings", "take", "arm"];

  function panelEl(name) { return document.getElementById("panel-" + name); }

  function showPanel(name, params) {
    panels.forEach(function (p) {
      var el = panelEl(p);
      if (el) el.classList.toggle("active", p === name);
    });
    switch (name) {
      case "create":
        global.MultiCamSessionCreate.show(appCfg, { mode: "create" });
        break;
      case "join":
        /* Le mode join doit être imposé : un appel show('join', {...}) sans
         * mode reviendrait au formulaire de CRÉATION (session-create.show
         * bascule setupCreate) — le bloc PIN (#joinArea) resterait masqué et
         * l'écran afficherait le formulaire de création. Défaut revue visuelle
         * corrigé : le routeur force le mode. */
        if (!params) params = {};
        params.mode = "join";
        global.MultiCamSessionCreate.show(appCfg, params);
        break;
      case "session":
        global.MultiCamSessionScreen.show(appCfg, params || {});
        break;
      case "take":
        global.MultiCamTakeScreen.show(appCfg, params || {});
        break;
      case "arm":
        global.MultiCamArmScreen.show(appCfg, params || {});
        break;
      case "settings":
        global.MultiCamSettings.show(appCfg);
        break;
      default:
        break;
    }
  }

  function bindBackButtons() {
    function back(name) {
      var b = document.getElementById(name);
      if (b) b.addEventListener("click", function () { showPanel("home"); });
    }
    back("backCreate");
    back("backJoin");
    back("backSession");
    back("backSettings");
  }

  global.MultiCamNav = {
    show: showPanel,
    cfg: function () { return appCfg; }
  };

  /* ---------- boot session (J04) ---------- */

  /* Le serveur WebSocket est démarré dès qu'une session locale existe (ouverte ou
   * fermée) ; ses événements ne dépendent pas de l'écran affiché (30.7). Les
   * sessions ouvertes sont annoncées en DNS-SD (30.9/30.10). */
  function bootSession(cfg) {
    global.MultiCamSessionWs.bind(cfg);
    if (global.MultiCamSessionDiscovery) global.MultiCamSessionDiscovery.attach();
    /* J07 : la machine ARM est créée au boot pour pouvoir RÉPONDRE aux requêtes
     * ARM des autres Masters, même sans écran ARM ouvert (réponses dirigées). */
    if (global.MultiCamArmService) global.MultiCamArmService.bind();
    return global.MultiCamSessionStore.list().then(function (sessions) {
      console.log("SESSION_BOOT stored=" + sessions.length
        + " open=" + sessions.filter(function (s) { return s.state === "open"; }).length
        + " closed=" + sessions.filter(function (s) { return s.state === "closed"; }).length);
      if (!sessions.length) return;
      return global.MultiCamSessionWs.ensureServer().then(function () {
        return global.MultiCamSessionWs.advertiseOpenSessions().then(function () {
          sessions.forEach(function (s) {
            if (s.state === "open") global.MultiCamSessionWs.reSyncSession(s);
          });
        });
      }).catch(function (err) {
        console.log("SESSION_BOOT_SERVER_ERROR " + String((err && err.message) || err));
      });
    }).catch(function (err) {
      console.log("SESSION_BOOT_STORE_ERROR " + String((err && err.message) || err));
    });
  }

  function boot() {
    global.MultiCamConfig.load().then(function (cfg) {
      var dev = global.MultiCamDevice.getInfo();
      logBoot(cfg, dev);

      if (dev) {
        console.log("APP_BOOT platform=" + dev.platform
          + " model=" + dev.model
          + " android=" + dev.version
          + " sdk=" + dev.sdkVersion);
      }

      global.MultiCamPixelCopy.installShim();
      console.log("PIXELCOPY_READY method=" + (global.MultiCamPixelCopy.isMethodAvailable() ? "1" : "0"));

      global.MultiCamNet.start();

      appCfg = cfg;
      bootSession(cfg);

      global.MultiCamHome.render(cfg);
      global.MultiCamHome.bind();
      bindBackButtons();

      console.log("HOME_RENDER deviceName=" + cfg.deviceName
        + " controllerEnabled=" + (global.MultiCamConfig.isControllerEnabled() ? "1" : "0"));

      debugTestHook(cfg);
    }).catch(function (err) {
      console.log("APP_ERROR " + String((err && err.message) || err));
    });
  }

  function onReady() {
    try {
      boot();
    } catch (err) {
      console.log("APP_ERROR " + String((err && err.message) || err));
    }
  }

  if (global.cordova) {
    document.addEventListener("deviceready", onReady, false);
  } else {
    console.log("APP_NOT_CORDOVA run=web");
    global.MultiCamConfig.load().then(function (cfg) {
      appCfg = cfg;
      global.MultiCamHome.render(cfg);
      global.MultiCamHome.bind();
      bindBackButtons();
      console.log("HOME_RENDER deviceName=" + cfg.deviceName + " run=web");
    });
  }
})(window);