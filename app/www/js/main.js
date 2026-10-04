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

  var panels = ["home", "create", "join", "session", "settings", "take", "arm", "countdown", "live"];
  var current = "home";

  function panelEl(name) { return document.getElementById("panel-" + name); }

  function showPanel(name, params) {
    panels.forEach(function (p) {
      var el = panelEl(p);
      if (el) el.classList.toggle("active", p === name);
    });
    current = name;
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
      case "countdown":
        /* Écran 07 + placeholder 08 : même panneau, la vue interne est choisie
         * par le rôle (Master / Capture / excluée / REC). */
        global.MultiCamCountdownScreen.show(appCfg, params || {});
        break;
      case "live":
        /* Écran 08 : la mosaïque. Le panneau n'a rien d'initialisable de
         * spécial — tout son contenu vient de `syncLive()` (modèle + rendu). On
         * l'appelle quand même pour que l'ouverture soit immédiate et ne
         * dépende pas du prochain tick du modèle START. */
        syncLive(global.MultiCamStartService ? global.MultiCamStartService.view() : null);
        break;
      case "settings":
        global.MultiCamSettings.show(appCfg);
        break;
      default:
        break;
    }
  }

  /* ---------- J09-05 : mosaïque Master (écran 08) ----------
   *
   * UN SEUL endroit assemble les trois sources de la mosaïque, appelé sur chaque
   * révision de la vue START :
   *
   *   1. le PLAN (participants, ordre, numéro de Take)  → state/live-model.js
   *   2. les IMAGES (boîte de réception J09-04)           → onFrame + latest()
   *   3. la VIVACITÉ (connexions WS de la session)        → connectedPeers()
   *   4. la SUPERVISION (J09-06, batterie / stockage)     → telemetry-store
   *
   * La 4e source est un MIROIR MEMOIRE de ce que le WS a déjà reçu : elle est
   * lue au même tick, mais elle ne décide de rien. Le liveness reste la 3e
   * source — une Capture hors ligne conserve ses dernières valeurs mesurées,
   * datées, ce qui est une information et pas une illusion de présence.
   *
   * Pourquoi ici et pas dans l'écran : parce que ces trois sources vivent à des
   * rythmes différents. Les images arrivent à ~1 img/s par Capture, la
   * connectivité peut tomber à n'importe quel instant, et le plan ne change
   * qu'au top. Un rafraîchissement à chaque tick du modèle START (200 ms) est
   * le seul endroit où les trois sont vues « au même instant », et il évite un
   * setInterval d'interface concurrent — même règle que l'écran 07.
   *
   * L'idempotence est portée par le modèle (un slot n'est créé qu'une fois, une
   * image n'est peinte que si sa seq change) : appeler `syncLive()` dix fois par
   * seconde coûte quelques comparaisons, pas un redessin. */

  var liveBound = false;

  /* Participants du Take, dans l'ordre du plan. Le modèle START est la seule
   * vérité ; `machine().state.plan` est déjà lue par l'écran 07, donc aucune
   * donnée n'est inventée ici. */
  function liveParticipants(sid) {
    var svc = global.MultiCamStartService;
    if (!svc) return [];
    var machine = svc.machine ? svc.machine() : null;
    var plan = machine && machine.state ? machine.state.plan : null;
    if (!plan) return [];
    if (sid && plan.sessionId && plan.sessionId !== sid) return [];
    return Array.isArray(plan.participants) ? plan.participants : [];
  }

  /* Une seule lecture par device, une seule fois par révision : la mosaïque ne
   * doit pas devenir une seconde source de vérité sur les previews. */
  function liveSeedFrames(model, sid, slots) {
    var inbox = global.MultiCamPreviewInbox;
    if (!inbox || typeof inbox.latest !== "function") return;
    slots.forEach(function (slot) {
      if (slot.hasFrame) return;                  /* déjà peint */
      var f = inbox.latest(sid, slot.deviceId);
      /* Le filtre session/Take reste au modèle : ici on ne fait que réveiller la
       * boîte de réception pour une vignette qui n'a pas encore reçu d'image. */
      if (f) model.onPreviewFrame(f);
    });
  }

  function liveLiveness(sid) {
    var peers = global.MultiCamSessionWs && global.MultiCamSessionWs.connectedPeers
      ? global.MultiCamSessionWs.connectedPeers(sid)
      : null;
    return peers || {};
  }

  /* États RECORDER publiés par les pairs (`start_state` → START_STATE côté
   * Master) + l'état local. `connectedPeers` ne dit QUE qui est joignable ; les
   * deux informations restent distinctes jusqu'à l'affichage. */
  function livePeerStates(v) {
    var out = {};
    var peers = (v && v.peers) || {};
    Object.keys(peers).forEach(function (did) {
      var st = peers[did] && peers[did].state;
      if (st === "STARTED") out[did] = "REC";
      else if (st === "STOPPED") out[did] = "STOPPED";
      else if (st === "FAILED") out[did] = "ERROR";
    });
    return out;
  }

  function syncLive(v) {
    var model = global.MultiCamLiveModel;
    var screen = global.MultiCamLiveScreen;
    if (!model || !screen) return null;
    if (!liveBound) {
      model.bind({
        localDid: (appCfg && appCfg.deviceId) || "",
        getParticipants: liveParticipants
      });
      /* Les images arrivent par abonnement, pas en polling : la mosaïque ne
       * redemande jamais une frame, elle reçoit celle que le transport a déjà
       * acceptée pour la boîte de réception. */
      if (global.MultiCamPreviewInbox) {
        global.MultiCamPreviewInbox.onFrame(function (frame) { model.onPreviewFrame(frame); });
      }
      liveBound = true;
      console.log("LIVE_MOSAIC_READY localDid=" + (appCfg ? appCfg.deviceId : "—")
        + " policy=plan_order_frozen transport=pure_ui=diff");
    }
    if (!v || !v.active) return null;

    /* Le Take EST la grille : changer de Take reconstruit tout. */
    model.setTake(v.sid, v.takeNumber);
    model.syncParticipants(liveParticipants(v.sid));
    var slots = model.view().slots;
    liveSeedFrames(model, v.sid, slots);

    /* J09-06 : une seule lecture du store de supervision par révision, comme
     * pour le liveness. `syncTelemetry` ignore (et compte) tout device absent du
     * plan du Take — la mosaïque ne peut pas afficher la batterie d'un device
     * qui n'en est pas. */
    if (global.MultiCamTelemetryStore) {
      model.syncTelemetry(global.MultiCamTelemetryStore.all(v.sid));
    }

    /* Une seule lecture de la session et des états pairs par révision : ces
     * données sont partagées par TOUTES les vignettes (un état global de
     * connectivité), les relire par vignette serait du travail inutile à 5 Hz. */
    var live = liveLiveness(v.sid);
    var states = livePeerStates(v);
    slots.forEach(function (slot) {
      /* Le device local est joignable par construction ; `connectedPeers()` ne le
       * liste pas (il n'a pas de socket à lui-même). */
      model.setLiveness(slot.deviceId, slot.isLocal ? true : !!live[slot.deviceId]);
      var st = slot.isLocal
        ? (v.localStoppedTake ? "STOPPED" : "REC")
        : states[slot.deviceId];
      if (st) model.setStatus(slot.deviceId, st);
    });

    if (current !== "live") return null;
    return screen.render(model.view(), {
      sessionName: v.sessionName,
      phase: v.phase,
      recStartedAtMs: v.recStartedAtMs,
      nowMs: Date.now()
    });
  }

  /* Fin de plan (annulation, refus, STOP local) : on revient à l'écran ARM
   * depuis le panneau 07. Sans ce rattrapage, l'utilisateur resterait sur une vue
   * de countdown à l'arrêt d'un plan. Le service reste maître de l'état. */
  function onStartEnded(v) {
    /* Fin de plan : la supervision affichée appartient à CETTE session/Take. La
     * laisser en place afficherait les valeurs d'un tournage terminé sur une
     * nouvelle mosaïque — la pire des confusions pour un opérateur. */
    if (global.MultiCamTelemetryStore && typeof global.MultiCamTelemetryStore.clear === "function") {
      global.MultiCamTelemetryStore.clear();
    }
    if (global.MultiCamLiveDetail && global.MultiCamLiveDetail.isOpen
      && global.MultiCamLiveDetail.isOpen()) {
      global.MultiCamLiveDetail.close();
    }
    if (current === "live") {
      console.log("NAV_AUTO reason=plan_ended target=arm from=live"
        + " sessionId=" + ((v && v.sid) || ""));
      showPanel("arm", { sid: (v && v.sid) || null });
      return;
    }
    if (current !== "countdown") return;
    console.log("NAV_AUTO reason=plan_ended target=arm from=countdown"
      + " sessionId=" + ((v && v.sid) || (appCfg ? "?" : "?")));
    showPanel("arm", { sid: (v && v.sid) || null });
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
    cfg: function () { return appCfg; },
    current: function () { return current; }
  };

  /* ---------- J08 : abonnement GLOBAL au plan de START ----------
   *
   * Un seul abonnement, posé au boot, indépendant de l'écran affiché
   * (décision 30.7) : un plan reçu d'un autre Master doit ouvrir l'écran 07
   * même si l'utilisateur est sur une autre vue. Le routeur ne fait que
   * choisir un PANNEAU ; le rendu (chiffre, états, exclusion) appartient à
   * MultiCamCountdownScreen, alimenté par la même vue.
   *
   * On ne bascule JAMAIS tant que l'utilisateur est sur un écran de
   * PARAMÈTRES ou de CRÉATION : ces écrans demandent une action explicite et
   * seraient abandonnés en cours de route. Le badge, lui, reste visible. */
  var START_RESERVED_PANELS = { settings: true, create: true };

  function onStartView() {
    var start = global.MultiCamStartService;
    var screen = global.MultiCamCountdownScreen;
    if (!start || !screen) return;
    var v = start.view();
    /* J09-07 : le service de bascule doit être attaché au Take AVANT toute
     * chose — c'est lui qui sait à quel segment il appartient. Sans cet
     * appel, `sessionId`/`takeNumber` restent vides pendant le REC et le
     * Master ne peut rattacher l'état reçu à aucun Take (constaté sur le
     * terrain : `takeNumber: null` sur tous les paquets `camera_state`). */
    var camSwitch = global.MultiCamCameraSwitchService;
    if (camSwitch && typeof camSwitch.onStartView === "function") camSwitch.onStartView(v);
    if (!v || !v.active) { onStartEnded(v); return; }
    /* Le rendu est toujours à jour, même quand on ne change pas de panneau. */
    if (current === "countdown") screen.render(v);
    /* J09-05 : la mosaïque est alimentée par ce MÊME flux (200 ms), jamais par
     * un setInterval concurrent — c'est ce qui garantit que l'image, la
     * connectivité et le timer sont lus au même instant. */
    syncLive(v);
    if (START_RESERVED_PANELS[current]) return;
    var target = screen.route(v);
    if (target && target !== current) {
      console.log("NAV_AUTO reason=start_plan target=" + target + " phase=" + v.phase
        + " from=" + current);
      showPanel(target, { sid: v.sid });
    }
  }

  function bindStartService() {
    var start = global.MultiCamStartService;
    if (!start) {
      console.log("START_NAV_UNAVAILABLE reason=service_absent");
      return;
    }
    start.bind();
    start.onView(onStartView);
    /* Le timer REC (200 ms) et les digits du countdown passent par ce même
     * flux : pas de setInterval d'interface en doublon du modèle. */
    console.log("START_NAV_READY deviceId=" + (appCfg && appCfg.deviceId));
  }

  /* ---------- boot session (J04) ---------- */

  /* Le serveur WebSocket démarre TOUJOURS au boot, même sans session locale : un
   * device qui n'a jamais été joint doit pouvoir être intégré par un Master sans
   * manipulation locale (31.2) — sans écoute, aucune invitation ne peut aboutir.
   * Ses événements ne dépendent pas de l'écran affiché (30.7) ; les sessions
   * ouvertes sont annoncées en DNS-SD (30.9/30.10). */
  function bootSession(cfg) {
    global.MultiCamSessionWs.bind(cfg);
    if (global.MultiCamSessionDiscovery) global.MultiCamSessionDiscovery.attach();
    /* J07 : la machine ARM est créée au boot pour pouvoir RÉPONDRE aux requêtes
     * ARM des autres Masters, même sans écran ARM ouvert (réponses dirigées). */
    if (global.MultiCamArmService) global.MultiCamArmService.bind();
    /* J08 : idem pour le plan de START (pont START branché sur le WS) — un plan
     * reçu sans écran ouvert doit être adopté, caméra préparée comprise. */
    if (global.MultiCamStartService) global.MultiCamStartService.bind();
    /* J09-07 : même raison pour une commande de caméra reçue sans écran ouvert.
     * Une Capture pilotée à distance doit exécuter l'ordre même si l'opérateur
     * regarde un autre écran : le pont est branché ici, au BOOT, pas à
     * l'ouverture d'une vue. */
    if (global.MultiCamCameraSwitchService) {
      Promise.resolve(global.MultiCamCameraSwitchService.bind()).catch(function (err) {
        console.log("CAMERA_SWITCH_BOOT_ERROR " + String((err && err.message) || err));
      });
    }
    return global.MultiCamSessionStore.list().then(function (sessions) {
      console.log("SESSION_BOOT stored=" + sessions.length
        + " open=" + sessions.filter(function (s) { return s.state === "open"; }).length
        + " closed=" + sessions.filter(function (s) { return s.state === "closed"; }).length);
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

      /* J09 §35.1 : la preview caméra locale est un FOND PERMANENT sur un
       * device dont la skill Capture est active — pas une conséquence d'un
       * plan de START. Le service est donc lié au boot, AVANT tout écran, et
       * c'est lui seul qui décide d'ouvrir/fermer la caméra. Il s'abonne au
       * cycle de vie Android (pause/resume) et aux changements de skill. */
      if (global.MultiCamPreviewService) {
        global.MultiCamPreviewService.bind();
        var pv = global.MultiCamPreviewService.view();
        console.log("PREVIEW_SERVICE_READY captureSkill=" + (pv.captureEnabled ? 1 : 0)
          + " foreground=" + (pv.foreground ? 1 : 0)
          + " desired=" + (pv.desired ? 1 : 0));
      } else {
        console.log("PREVIEW_SERVICE_UNAVAILABLE reason=module_absent");
      }

      /* J09-03 : l'échantillonneur de preview (~1 img/s pendant REC) est une
       * responsabilité DÉDIÉE, distincte de la preview permanente. On le lie
       * au boot pour qu'il abonne ses propres règles de cycle de vie
       * (pause/resume, perte de preview) ; il ne démarre pour autant qu'au
       * top réel d'un Take, décidé par `start-service`. */
      if (global.MultiCamPreviewSampler) {
        global.MultiCamPreviewSampler.bind();
        console.log("PREVIEW_SAMPLER_READY intervalMs=" + global.MultiCamPreviewSampler.INTERVAL_MS
          + " quality=" + global.MultiCamPreviewSampler.QUALITY
          + " running=" + (global.MultiCamPreviewSampler.view().running ? 1 : 0));
      } else {
        console.log("PREVIEW_SAMPLER_UNAVAILABLE reason=module_absent");
      }

      /* J09-04 : le transport des previews est branché APRÈS le sampler, car il
       * s'abonne à ses images. Il installe le pont de réception côté Master et
       * la file « latest frame wins » côté Capture ; il ne démarre aucun
       * enregistrement et ne touche pas à la preview permanente. */
      if (global.MultiCamPreviewTransport) {
        global.MultiCamPreviewTransport.bind().then(function () {
          console.log("PREVIEW_TRANSPORT_READY policy=latest_frame_wins pendingSlot=1"
            + " inbox=" + (global.MultiCamPreviewInbox ? "1" : "0"));
        }).catch(function (err) {
          console.log("PREVIEW_TRANSPORT_ERROR " + String((err && err.message) || err));
        });
      } else {
        console.log("PREVIEW_TRANSPORT_UNAVAILABLE reason=module_absent");
      }

      global.MultiCamHome.render(cfg);
      global.MultiCamHome.bind();
      bindBackButtons();
      bindStartService();

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
      bindStartService();
      console.log("HOME_RENDER deviceName=" + cfg.deviceName + " run=web");
    });
  }
})(window);