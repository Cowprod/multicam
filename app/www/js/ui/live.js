/* MultiCam — J09-05 : écran REC Master (mosaïque des previews).
 *
 * RÔLE : AFFICHER. Ni transport, ni filtrage, ni décision d'ordre. Le modèle
 * (`state/live-model.js`) a déjà tranché ; cet écran ne fait que projeter sa vue
 * dans le DOM, sans jamais la contredire.
 *
 * LA FRONTIÈRE EST VOLONTAIREMENT NETTE, et c'est ce qui rend l'écran testable
 * sans navigateur :
 *
 *   tiles(view) -> descripteurs purs   (aucun DOM : c'est ici que le test
 *                                      .assert que la vignette locale n'a ni
 *                                       image réseau, ni badge « ce device »)
 *   render()    -> écrit dans le DOM   (et seulement ce qui a changé)
 *
 * `tiles()` est la partie qui porte les règles d'affichage ; `render()` est une
 * application mécanique. C'est l'inverse de l'écran 07, où tout était mêlé —
 * ici une régression d'affichage se voit sans navigateur.
 *
 * ---------- LA VIGNETTE LOCALE (Master qui est aussi Capture) ----------
 *
 * La maquette (`ui/08-live-recording/index.html`) montre un Master+Capture dont
 * la vignette locale porte UNIQUEMENT le contour bleu `--local` : pas de badge
 * « ce device », pas de vidéo de plus.
 *
 * On ne peut pas poser la SurfaceView native dans une vignette : c'est une
 * fenêtre Android distincte, superposée à la WebView, qui ne peut vivre qu'en
 * plein écran. Intégrer le flux natif « dans » une case de grille serait donc
 * soit impossible, soit un second rendu — interdit ici.
 *
 * CE QUE NOUS FAISONS, et c'est un choix assumé : la vignette locale n'affiche
 * AUCUNE image (le transport écarte déjà le self-loop, il n'y a rien à
 * afficher) et son fond reste TRANSPARENT. La preview native permanente, déjà
 * rendue en fond d'écran par le service de preview (§35.1), apparaît donc
 * derrière cette case — exactement comme dans la maquette, où le fond est la
 * caméra locale. Le contour bleu identifie le device local, et rien d'autre.
 *
 * Le résultat est vérifié visuellement au smoke (capture d'écran Master) : la
 * case locale doit laisser voir la caméra, rester lisible, et ne pas
 * produire
 * de rectangle vide au milieu de la mosaïque.
 */

"use strict";
(function (global) {

  var LABEL = {
    REC: "REC",
    STOPPED: "STOPPED",
    DECONNECTED: "Déconnecté",
    WARNING: "Avertissement",
    ERROR: "Erreur"
  };

  var ICON = {
    REC: "fa-circle",
    STOPPED: "fa-stop",
    DECONNECTED: "fa-link-slash",
    WARNING: "fa-triangle-exclamation",
    ERROR: "fa-circle-exclamation"
  };

  var STATE_CLASS = {
    REC: "st-rec",
    STOPPED: "st-stopped",
    DECONNECTED: "st-offline",
    WARNING: "st-warning",
    ERROR: "st-error"
  };

  /* ---------- J09-09c : zone Storage sous la mosaïque ----------
   *
   * Types réseau remontés dans la télémétrie (mêmes valeurs que la vue
   * détaillée) : Wi-Fi et Ethernet tels que demandés par la maquette, les
   * autres ne sont affichés que s'ils sont RÉELLEMENT remontés. Une valeur
   * inconnue s'affiche « — », jamais « Aucun réseau » : « Aucun réseau »
   * est une mesure, l'absence de mesure en est une autre. */
  var NET_LABEL = {
    wifi: "Wi-Fi",
    ethernet: "Ethernet",
    cellular: "Cellulaire",
    vpn: "VPN",
    other: "Autre",
    none: "Aucun réseau"
  };
  var NET_ICON = {
    wifi: "fa-wifi",
    ethernet: "fa-ethernet",
    cellular: "fa-signal",
    vpn: "fa-shield-halved",
    other: "fa-network-wired",
    none: "fa-plug-circle-xmark"
  };

  var STORE_STATE_LABEL = { connected: "Connecté", warning: "Avertissement", deconnected: "Déconnecté" };
  var STORE_STATE_CLASS = { connected: "st-connected", warning: "st-warning", deconnected: "st-offline" };

  /* Cartes de grille, PAR NOMBRE DE CAPTURES. La règle tient en une phrase :
   * une Capture occupe l'écran, deux se partagent la largeur, trois ou quatre
   * forment une grille 2×2, au-delà c'est une grille qui défile. Rien n'est
   * calculé à partir d'un état technique — le nombre de vignettes est le seul
   * critère, donc une déconnexion ne change pas la géométrie. */
  var COLS = { 1: 1, 2: 2, 3: 2, 4: 2 };
  function colsFor(n) {
    if (n <= 1) return 1;
    if (n === 2) return 2;
    if (n <= 4) return 2;
    return 3;
  }

  function pad3(n) {
    var s = String(n === null || n === undefined ? 0 : n);
    while (s.length < 3) s = "0" + s;
    return s;
  }

  function hms(ms) {
    var t = Math.max(0, Math.floor((ms || 0) / 1000));
    var h = Math.floor(t / 3600);
    var m = Math.floor((t % 3600) / 60);
    var s = t % 60;
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  /* ---------- J09-06 : VALEURS DE SUPERVISION ----------
   *
   * La maquette (`ui/08-live-recording`) demande, dans la vignette : le nom, l'état
   * REC / STOPPED / Déconnecté, la batterie et l'espace local libre. Pas le
   * deviceId (inutile à un opérateur, et une information technique), pas la
   * qualité réseau (on ne sait pas la mesurer), pas un timer par vignette (le
   * README l'interdit explicitement : un seul timer global pour le Take).
   *
   * Les seuils ne sont pas décoratifs : ce sont ceux de `state/arm-model.js`
   * (FREE_WARN_BYTES = 1 Go) et de `state/telemetry-service.js` (batterie 20 %),
   * pour que la vigilance soit la même décision d'écran à l'écran.
   *
   * ABSENCE DE DONNÉE ≠ ZÉRO. Une batterie non mesurée s'affiche « — » : le
   * défaut le plus grave de cet écran serait d'afficher 0 % et de déclencher une
   * alerte qui n'existe pas.
   */
  /* Seuils : lus depuis le modèle de session (source unique, voir
   * `state/session-model.js`). Le repli ci-dessous n'existe que pour que ce
   * module reste chargeable seul dans un test ; il ne doit JAMAIS être RÉÉCRIT
   * ici — un seuil dupliqué est un seuil qui divergera. */
  var FREE_WARN = (global.MultiCamSessionModel && global.MultiCamSessionModel.FREE_WARN_BYTES) || 1000000000;
  var BATTERY_WARN = (global.MultiCamSessionModel && global.MultiCamSessionModel.BATTERY_WARN_PCT) || 25;
  /* Donnée « ancienne » = trois périodes de télémétrie manquées (cadence 5 s).
   * Ce seuil signale une DONNÉE, jamais l'état du lien : une Capture dont le WS
   * est vivant et dont la télémétrie est vieille reste REC, pas « Déconnecté ». */
  var TELEMETRY_STALE_MS = 15000;

  function fmtBytes(n) {
    if (typeof n !== "number" || !isFinite(n) || n < 0) return null;
    var units = ["o", "Ko", "Mo", "Go", "To"];
    var i = 0, v = n;
    while (v >= 1000 && i < units.length - 1) { v = v / 1000; i++; }
    var r = (v < 10 && i > 0) ? Math.round(v * 10) / 10 : Math.round(v);
    return (r + " " + units[i]);
  }

  /* Échelle d'icônes calée sur les quatre exemples de la maquette validée :
   * 23 % → quarter, 54 % → half, 76 % → three-quarters, 100 % → full. */
  function batteryIcon(pct) {
    if (pct <= 0) return "fa-battery-empty";
    if (pct <= BATTERY_WARN) return "fa-battery-quarter";
    if (pct <= 50) return "fa-battery-half";
    if (pct <= 80) return "fa-battery-three-quarters";
    return "fa-battery-full";
  }

  /* Une icône de supervision = { key, known, value, text, level, icon, title }.
   * `level` ∈ ok | warn | danger | unknown : c'est la couleur d'incident, donc
   * c'est ici qu'on décide, et la décision est faite UNE fois pour la vignette
   * ET pour la vue détaillée. */
  function supervisionIcons(t, now) {
    var out = [];
    var b = t.batteryLevel;
    out.push({
      key: "battery",
      known: typeof b === "number" && isFinite(b),
      value: (typeof b === "number" && isFinite(b)) ? b : null,
      text: (typeof b === "number" && isFinite(b)) ? (b + " %") : "—",
      level: (typeof b !== "number" || !isFinite(b)) ? "unknown"
        : (b <= BATTERY_WARN ? "warn" : "ok"),
      icon: (typeof b === "number" && isFinite(b)) ? batteryIcon(b) : "fa-battery-half",
      title: (typeof b === "number" && isFinite(b)) ? ("Batterie " + b + " %") : "Batterie inconnue",
      charging: t.batteryCharging === true
    });
    var f = t.freeBytes;
    var known = typeof f === "number" && isFinite(f) && f >= 0;
    out.push({
      key: "storage",
      known: known,
      value: known ? f : null,
      text: known ? (fmtBytes(f) || "—") : "—",
      level: !known ? "unknown" : (f < FREE_WARN ? "warn" : "ok"),
      icon: "fa-hard-drive",
      title: known ? (fmtBytes(f) + " libres") : "Espace libre inconnu",
      total: (typeof t.totalBytes === "number" && isFinite(t.totalBytes) && t.totalBytes > 0) ? t.totalBytes : null
    });
    return out;
  }

  /* Les incidents affichables : ce que l'opérateur doit voir MAINTENANT. Une
   * donnée absente n'en est pas un (voir `notes`). */
  function incidentsOf(t, state, now, hasTelemetry, telemetryAt) {
    var list = [];
    if (state === "DECONNECTED") {
      list.push({ key: "disconnected", tone: "danger", label: "Connexion perdue. Dernière preview conservée." });
    }
    var b = t.batteryLevel, f = t.freeBytes;
    if (typeof b === "number" && isFinite(b) && b <= BATTERY_WARN) {
      list.push({ key: "batteryLow", tone: "warn", label: "Batterie faible (" + b + " %)." });
    }
    if (typeof f === "number" && isFinite(f) && f < FREE_WARN) {
      list.push({ key: "storageLow", tone: "warn", label: "Stockage local sous le seuil de 1 Go (" + fmtBytes(f) + " libres)." });
    }
    /* Donnée ancienne : information de fraîcheur, PAS un état de connexion. */
    if (hasTelemetry && telemetryAt && (now - telemetryAt) > TELEMETRY_STALE_MS) {
      list.push({ key: "telemetryStale", tone: "warn", label: "Dernière télémétrie reçue il y a " + fmtAge(now - telemetryAt) + "." });
    }
    return list;
  }

  function fmtAge(ms) {
    var s = Math.max(0, Math.round((ms || 0) / 1000));
    if (s < 60) return s + " s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + " min";
    return Math.floor(m / 60) + " h " + (m % 60) + " min";
  }

  /* ---------- COUCHÉ PURE : descripteurs de vignette ---------- */

  /* Une vignette = { clé stable, libellés, image, état visuel }. Les tests
   * assertent dessus ; le DOM n'est qu'une projection. */
  function tileOf(slot, nowMs) {
    var state = slot.displayState || "REC";
    var isLocal = !!slot.isLocal;
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    var t = slot.telemetry || null;
    var telemetryAt = slot.telemetryAt || 0;
    var hasTelemetry = !!t;
    var icons = supervisionIcons(t || {}, now);
    var incidents = incidentsOf(t || {}, state, now, hasTelemetry, telemetryAt);
    var worstIcon = icons.filter(function (i) { return i.level === "warn"; })[0] || null;
    /* Le device local n'a JAMAIS d'image réseau : sa source visuelle est la
     * preview native du fond. On ne fabrique donc pas de data-URL pour lui. */
    var hasNetFrame = !isLocal && !!slot.lastFrame && !!slot.lastFrame.jpegBase64;
    return {
      key: slot.deviceId + "@" + slot.take,
      deviceId: slot.deviceId,
      deviceName: slot.deviceName,
      isLocal: isLocal,
      state: state,
      stateLabel: LABEL[state] || state,
      stateIcon: ICON[state] || ICON.REC,
      stateClass: STATE_CLASS[state] || STATE_CLASS.REC,
      /* « Hors ligne » = lien perdu : on grise l'image ET on l'assombrit. Un
       * STOPPED, lui, reste en couleur : c'est un état, pas une panne. */
      dimmed: state === "DECONNECTED",
      placeholder: !hasNetFrame && !isLocal,
      nativePreview: isLocal,
      imgSrc: hasNetFrame ? ("data:image/jpeg;base64," + slot.lastFrame.jpegBase64) : null,
      seq: slot.lastFrameSeq || 0,
      frameAt: slot.lastFrameAt || 0,
      /* J09-06 — supervision. `icons` alimente la ligne d'icônes de la vignette,
       * `incidents` le détail de la vue détaillée : les deux lisent la MÊME
       * structure, donc ils ne peuvent pas diverger. */
      hasTelemetry: hasTelemetry,
      telemetryAt: telemetryAt,
      telemetryAgeMs: hasTelemetry ? Math.max(0, now - telemetryAt) : null,
      telemetryStale: !!(hasTelemetry && telemetryAt && (now - telemetryAt) > TELEMETRY_STALE_MS),
      icons: icons,
      incidents: incidents,
      /* Une seule icône d'alerte dans le coin de la vignette (la maquette n'en
       * montre qu'une) : la plus grave. Le détail est dans la vue détaillée. */
      alertIcon: (state === "DECONNECTED")
        ? { icon: "fa-triangle-exclamation", level: "danger" }
        : (worstIcon ? { icon: (worstIcon.key === "battery" ? batteryIcon(worstIcon.value) : "fa-hard-drive"), level: worstIcon.level } : null),
      /* Aucun badge textuel, et surtout pas « ce device » : la maquette
       * l'interdit explicitement. La supervision passe par `icons` (valeurs
       * mesurées) et `incidents` (ce qui exige une action), jamais par un
       * badge : un badge textuel de plus ferait de la place pour un deviceId. */
      badges: []
    };
  }

  /* ---------- J09-08d : caméra et segment RÉELS, dans la vue LOCALE ----------
   *
   * La mosaïque n'affiche pas ces valeurs et son ordre est FIGÉ par la
   * maquette J09-05 : on n'y touche pas. Elles sont donc lues ici et projetées
   * dans l'en-tête — la seule zone qui décrit CE device.
   *
   * UNE seule source : `slot.camera`, rempli par `live-model.js` soit depuis le
   * service local (ce device), soit depuis le dernier `camera_state` reçu. L'UI
   * ne recompose rien et ne devine aucune valeur :
   *
   *   - `activeCamera` vide ou absent -> « Caméra inconnue », jamais REAR ;
   *   - `requestedCamera` n'est JAMAIS promu : c'est une demande ;
   *   - `segmentIndex` 0 ou absent -> « aucun segment actif », jamais « segment 0 » ;
   *   - `recording` n'est écrit que s'il a été MESURÉ. */
  var SEG_LABEL = {
    recording: "en enregistrement",
    closed: "clôturé",
    failed: "en échec"
  };

  function camOf(c) {
    var m = global.MultiCamCameraSwitchModel;
    var active = (c && m) ? m.normalizeCamera(c.activeCamera) : "";
    var switching = (c && m) ? m.normalizeCamera(c.switchingCamera) : "";
    var segIdx = (c && typeof c.segmentIndex === "number" && isFinite(c.segmentIndex))
      ? Math.round(c.segmentIndex) : null;
    var segState = (c && typeof c.segmentState === "string") ? c.segmentState : "";
    var recKnown = !!(c && typeof c.recording === "boolean");
    var out = {
      known: !!c,
      active: active,
      activeLabel: (active && m) ? m.label(active) : "",
      requested: (c && m) ? m.normalizeCamera(c.requestedCamera) : "",
      switching: switching,
      switchingLabel: (switching && m) ? m.label(switching) : "",
      segmentIndex: segIdx,
      segmentKnown: segIdx !== null,
      hasSegment: segIdx !== null && segIdx > 0,
      segmentState: segState,
      segmentStateLabel: SEG_LABEL[segState] || "",
      recording: recKnown ? c.recording === true : null,
      recordingKnown: recKnown
    };
    out.text = cameraLine(out);
    return out;
  }

  function cameraLine(c) {
    if (!c || !c.known) return "Caméra inconnue";
    var cur = c.activeLabel || "";
    if (c.switching) {
      return (cur ? ("Caméra " + cur + " → ") : "") + "Changement vers "
        + (c.switchingLabel || "?") + "…";
    }
    var parts = [cur ? ("Caméra " + cur) : "Caméra inconnue"];
    if (c.hasSegment) {
      parts.push("segment " + c.segmentIndex + (c.segmentState === "failed" ? " en échec" : ""));
    } else if (c.segmentKnown) {
      parts.push("aucun segment actif");
    }
    if (c.recordingKnown) parts.push(c.recording ? "enregistrement" : "n'enregistre pas");
    return parts.join(" · ");
  }

  function localCamera(slots) {
    var local = (slots || []).filter(function (s) { return !!s.isLocal; })[0] || null;
    /* Pas de Capture locale = ce device n'est qu'un Master : la ligne reste
     * VIDE. « Caméra inconnue » dirait ici quelque chose de faux — il n'y a
     * même pas de caméra à ne pas connaître. */
    if (!local) return { known: false, isLocal: false, text: "" };
    var out = camOf(local.camera);
    out.isLocal = true;
    return out;
  }

  function tiles(modelView, rec) {
    var v = modelView || {};
    var slots = Array.isArray(v.slots) ? v.slots : [];
    var now = (rec && typeof rec.nowMs === "number") ? rec.nowMs : Date.now();
    return slots.map(function (s) { return tileOf(s, now); });
  }

  /* ---------- J09-09c : STORAGES DE CE TAKE (lecture seule) ----------
   *
   * La maquette (`ui/08-live-recording` §3) demande SOUS la mosaïque, pendant
   * REC, uniquement les Storage SÉLECTIONNÉS pour le Take courant : nom, état,
   * espace libre, type réseau. Pas de transfert, pas d'anciens Takes, pas de
   * réplication, pas d'action — une zone de SUPERVISION, rien de plus.
   *
   * Les données viennent des FAITS existants, jamais d'une seconde vérité :
   *
   *   `rec.take.storages`     → QUELS Storage et dans QUEL ordre (le plan) ;
   *                             une déconnexion ne réordonne jamais la liste ;
   *   `rec.telemetry`         → espace libre + type réseau mesurés (le store
   *                             de supervision, même map que la mosaïque) ;
   *   `rec.liveness`          → connectivité WS réelle (les mêmes faits que
   *                             les vignettes) ;
   *   `rec.names`             → nom du device (participants du plan).
   *
   * Comme pour les vignettes : ABSENCE DE DONNÉE ≠ ZÉRO. freeBytes absent →
   * « — », jamais « 0 o ». Le device local, s'il est un Storage du Take, est
   * joignable par construction (même règle que la mosaïque). Une Capture du
   * Take ne N'APPARAÎT JAMAIS dans la liste Storage — l'ordre est celui du
   * plan, pas celui de la connectivité. */
  function netLabelOf(net) {
    return net ? (NET_LABEL[net] || net) : "—";
  }

  function storageOf(did, rec) {
    var r = rec || {};
    var names = r.names || {};
    var telemetry = r.telemetry || {};
    var liveness = r.liveness || {};
    var entry = telemetry[did];
    var t = (entry && entry.telemetry && typeof entry.telemetry === "object") ? entry.telemetry : null;
    var f = (t && typeof t.freeBytes === "number" && isFinite(t.freeBytes) && t.freeBytes >= 0) ? t.freeBytes : null;
    var net = (t && typeof t.netType === "string" && t.netType) ? t.netType : null;
    var connected = (r.localDid && r.localDid === did) ? true : !!liveness[did];
    var freeLow = f !== null && f < FREE_WARN;
    var state = !connected ? "deconnected" : (freeLow ? "warning" : "connected");
    return {
      deviceId: did,
      deviceName: names[did] || did,
      connected: connected,
      state: state,
      stateLabel: STORE_STATE_LABEL[state],
      stateClass: STORE_STATE_CLASS[state],
      /* Absence de donnée ≠ zéro : freeBytes null = « jamais mesuré ». */
      freeKnown: f !== null,
      freeBytes: f,
      freeText: f === null ? "—" : (fmtBytes(f) || "—"),
      freeLow: freeLow,
      netKnown: net !== null,
      netType: net,
      netLabel: netLabelOf(net)
    };
  }

  /* Les Storage affichés = UNIQUEMENT ceux sélectionnés pour CE Take, dans
   * l'ordre du plan. Une Capture du Take n'apparaît jamais ici (J09-09c K). */
  function storageDids(take) {
    var caps = {};
    ((take && Array.isArray(take.captures)) ? take.captures : []).forEach(function (d) { caps[d] = true; });
    return ((take && Array.isArray(take.storages)) ? take.storages : [])
      .filter(function (d) { return typeof d === "string" && d && !caps[d]; });
  }

  function storagesOf(rec) {
    return storageDids((rec && rec.take) || null).map(function (did) { return storageOf(did, rec); });
  }

  function gridClass(count) {
    return "live-grid cols-" + (COLS[count] || colsFor(count));
  }

  function view(modelView, rec) {
    var v = modelView || {};
    var r = rec || {};
    var ts = tiles(v, r);
    var stores = storagesOf(r);
    return {
      sessionId: v.sessionId || "",
      takeNumber: v.takeNumber || 0,
      sessionName: r.sessionName || v.sessionId || "",
      phase: r.phase || "REC",
      /* Timer GLOBAL unique, dérivé du START synchronisé du Take — jamais un
       * compteur par vignette, jamais un compteur indépendant. */
      elapsedMs: Math.max(0, (r.nowMs || 0) - (r.recStartedAtMs || 0)),
      timer: hms(Math.max(0, (r.nowMs || 0) - (r.recStartedAtMs || 0))),
      takeLabel: "Take " + pad3(v.takeNumber || 0),
      count: ts.length,
      cols: COLS[ts.length] || colsFor(ts.length),
      gridClass: gridClass(ts.length),
      tiles: ts,
      /* J09-08d : l'état caméra/segment de CE device, hors mosaïque. */
      localCamera: localCamera(v.slots),
      empty: ts.length === 0,
      /* J09-09c : Storage sélectionnés pour CE Take, sous la mosaïque. */
      storages: stores,
      hasStorages: stores.length > 0
    };
  }

  /* ---------- J10 : STOP global (dock + confirmation, maquette ui/08 §4) ----------
   *
   * RÈGLE D'AFFICHAGE (purement pure : `stopVisible(v)`), même critère de
   * « régie » que le routeur de l'écran 07 (isMaster ET skill controller LE
   * device utilisateur — un device qui ne « régit » pas n'a rien à arrêter).
   *
   * Le bouton STOP n'apparaît QUE pendant la REC, sur la mosaïque (panel
   * `panel-live`). Il ne porte AUCUN état : cliquer ouvre la confirmation, et
   * la confirmation appelle le service (le modèle reste le seul décideur — le
   * bouton n'exécute rien tout seul). */
  function isRegie(v) {
    if (!v || !v.isMaster) return false;
    var cfgm = global.MultiCamConfig;
    if (cfgm && typeof cfgm.isControllerEnabled === "function") {
      return cfgm.isControllerEnabled() === true;
    }
    return true;
  }

  function stopVisible(v) {
    if (!v || !v.active) return false;
    if (v.phase !== "REC") return false;
    return isRegie(v);
  }

  var stopModal = { bound: false, open: false };

  function openStopModal() {
    var m = byId("liveStopModal");
    if (!m) return;
    stopModal.open = true;
    m.classList.add("show");
    m.setAttribute("aria-hidden", "false");
    if (global.MultiCamStartService) {
      var v = global.MultiCamStartService.view();
      console.log("SCREEN08_STOP_CONFIRM_OPEN sessionId=" + ((v && v.sid) || "—")
        + " take=" + (v && v.takeNumber));
    }
  }

  function closeStopModal() {
    var m = byId("liveStopModal");
    if (!m) return;
    stopModal.open = false;
    m.classList.remove("show");
    m.setAttribute("aria-hidden", "true");
  }

  /* Le bouton est créé DANS le dock (qui se masque seul quand il est vide), et
   * la modale est statique dans le panneau ; on ne fait que brancher les
   * écouteurs une seule fois. Aucun écouteur ne survit à render() : si le dock
   * est vidé, la prochaine création recrée le même comportement via flag. */
  function bindStopControls() {
    if (stopModal.bound) return;
    stopModal.bound = true;
    var btn = byId("liveStopBtn");
    if (btn) btn.addEventListener("click", openStopModal);
    var confirm = byId("liveStopConfirm");
    if (confirm) confirm.addEventListener("click", function () {
      var v = global.MultiCamStartService ? global.MultiCamStartService.view() : null;
      console.log("SCREEN08_STOP_CONFIRMED sessionId=" + ((v && v.sid) || "—")
        + " take=" + (v && v.takeNumber));
      closeStopModal();
      if (!global.MultiCamStartService) {
        console.log("SCREEN08_STOP_KO err=service_absent");
        return;
      }
      Promise.resolve(global.MultiCamStartService.requestStop("master_stop")).catch(function (err) {
        console.log("SCREEN08_STOP_KO err=" + String((err && err.message) || err));
      });
    });
    var cancel = byId("liveStopCancel");
    if (cancel) cancel.addEventListener("click", function () {
      console.log("SCREEN08_STOP_CANCELLED");
      closeStopModal();
    });
    var backdrop = document.querySelector("#liveStopModal .modal-backdrop");
    if (backdrop) backdrop.addEventListener("click", closeStopModal);
  }

  function renderStopControls(v) {
    var btn = byId("liveStopBtn");
    var visible = stopVisible(v);
    if (btn) btn.classList.toggle("d-none", !visible);
    if (!visible && stopModal.open) closeStopModal();
  }

  /* ---------- COUCHÉ DOM ---------- */

  function byId(id) { return global.document ? global.document.getElementById(id) : null; }

  var NODES = {};      /* key -> {root, media, img, name, state, badge} */
  var STORE_NODES = {}; /* deviceId -> {root, name, state, free, net} */

  function el(tag, cls) {
    var e = global.document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  /* Écrire l'image NE QUE si la seq a changé : réécrire un `src` identique à
   * chaque tick ferait clignoter la vignette et relancerait un décodage JPEG
   * inutile — sur un Master à 4 Captures, c'est 4 décodages par seconde en
   * continu, pour rien. */
  function paintTile(n, tile) {
    if (!n.img) {
      n.img = el("img", "tile-img");
      n.img.alt = tile.deviceName;
      n.media.appendChild(n.img);
    }
    if (tile.imgSrc && n.appliedSrc !== tile.imgSrc) {
      n.img.src = tile.imgSrc;
      n.appliedSrc = tile.imgSrc;
    } else if (!tile.imgSrc) {
      /* Placeholder : pas de source du tout (et le cache reste vide). */
      if (n.appliedSrc) { n.img.removeAttribute("src"); n.appliedSrc = null; }
    }
    n.media.classList.toggle("has-image", !!tile.imgSrc);
    n.media.classList.toggle("is-placeholder", !!tile.placeholder);
    n.media.classList.toggle("is-native", !!tile.nativePreview);

    /* ---------- J09-06 : la ligne de supervision de la vignette ----------
     *
     * Même structure que la maquette (`cam-info > .status-icons`) : deux valeurs
     * MESURÉES (batterie, stockage), colorées par niveau. On n'écrit que ce qui a
     * changé — une mosaïque est redessinée 5 fois par seconde, et réécrire deux
     * `textContent` à chaque tick ferait du travail pour rien (et sur un Master
     * à 4+ Captures, c'est 40 écritures par seconde).
     */
    (tile.icons || []).forEach(function (icon) {
      var row = n.iconRows[icon.key];
      if (!row) return;
      var cls = "fa-solid " + icon.icon + (icon.level === "unknown" ? " ic-unknown" : (icon.level === "warn" ? " ic-warn" : ""));
      if (row.i.className !== cls) row.i.className = cls;
      var txt = icon.text + (icon.charging ? " \u26a1" : "");
      if (row.txt !== txt) { row.node.textContent = txt; row.txt = txt; }
      if (row.node.dataset.known !== String(icon.known)) row.node.dataset.known = String(icon.known);
    });

    /* Une SEULE icône d'alerte, la plus grave (la maquette n'en montre qu'une).
     * Absente -> retirée : une icône d'alerte fantôme sur une Capture saine est
     * pire que pas d'icône du tout. */
    var alertCls = tile.alertIcon ? ("fa-solid " + tile.alertIcon.icon + (tile.alertIcon.level === "danger" ? " ic-danger" : " ic-warn")) : "";
    if (n.alert.className !== alertCls) n.alert.className = alertCls;

    if (n.name.textContent !== tile.deviceName) n.name.textContent = tile.deviceName;
    if (n.state.dataset.state !== tile.state) {
      n.state.dataset.state = tile.state;
      n.state.className = "tile-state " + tile.stateClass;
      /* Le libellé passe par `textContent` : jamais de HTML injecté depuis un
       * nom de device. */
      n.state.textContent = "";
      var i = el("i", "fa-solid " + tile.stateIcon);
      n.state.appendChild(i);
      n.state.appendChild(global.document.createTextNode(" " + tile.stateLabel));
    }
    if (n.root.classList.contains("offline") !== tile.dimmed) {
      n.root.classList.toggle("offline", tile.dimmed);
    }
    if (n.root.classList.contains("local") !== tile.isLocal) {
      n.root.classList.toggle("local", tile.isLocal);
    }
  }

  function makeTile(tile) {
    var root = el("article", "live-tile");
    var media = el("div", "tile-media");
    var info = el("div", "tile-info");
    var name = el("div", "tile-name");
    var state = el("div", "tile-state");
    state.dataset.state = "";
    var icons = el("div", "status-icons tiny");
    var iconRows = {};
    (tile.icons || []).forEach(function (icon) {
      var row = el("span", "supervision");
      row.dataset.known = String(icon.known);
      var ic = el("i", "fa-solid " + icon.icon);
      row.appendChild(ic);
      icons.appendChild(row);
      iconRows[icon.key] = { node: row, i: ic, txt: null };
    });
    var alert = el("i", "");
    alert.setAttribute("aria-hidden", "true");
    info.appendChild(name);
    info.appendChild(state);
    info.appendChild(icons);
    media.appendChild(alert);
    root.appendChild(media);
    root.appendChild(info);

    /* Le geste « ouvrir le détail » est délégué à la GRILLE (un seul écouteur,
     * voir `bindGridEvents`) : les nœuds sont recréés à chaque changement de
     * plan, donc un écouteur par vignette serait à réattacher en permanence —
     * et la délégation survit au `purge` sans état à reconstruire.
     * Le handler ne porte QUE l'ouverture : aucune commande ici (J10). */
    root.setAttribute("role", "button");
    root.setAttribute("tabindex", "0");
    root.dataset.deviceId = tile.deviceId;

    var node = {
      root: root, media: media, img: null, name: name, state: state,
      icons: icons, iconRows: iconRows, alert: alert, appliedSrc: null
    };
    NODES[tile.key] = node;
    return node;
  }

  /* ---------- J09-09c : ligne Storage ----------
   *
   * Lecture seule : aucune commande, aucun bouton, aucune progression de
   * transfert — la zone n'expose que nom / état / espace libre / réseau. */
  function makeStoreRow(store) {
    var root = el("div", "lv-store-row");
    root.dataset.deviceId = store.deviceId;
    var name = el("div", "lv-store-name");
    var state = el("span", "lv-store-state");
    state.dataset.storeState = store.state;
    var free = el("span", "lv-store-free");
    free.dataset.known = String(store.freeKnown);
    var net = el("span", "lv-store-net");
    var netIcon = el("i", "fa-solid " + (NET_ICON[store.netType] || "fa-circle-question"));
    netIcon.setAttribute("aria-hidden", "true");
    var netLabel = el("span");
    net.appendChild(netIcon);
    net.appendChild(netLabel);
    root.appendChild(name);
    root.appendChild(state);
    root.appendChild(free);
    root.appendChild(net);
    return { root: root, name: name, state: state, free: free, netLabel: netLabel, netIcon: netIcon };
  }

  function paintStoreRow(node, store) {
    if (node.name.textContent !== store.deviceName) node.name.textContent = store.deviceName;
    var cls = "lv-store-state " + store.stateClass;
    if (node.state.className !== cls) node.state.className = cls;
    if (node.state.dataset.storeState !== store.state) node.state.dataset.storeState = store.state;
    if (node.state.textContent !== store.stateLabel) node.state.textContent = store.stateLabel;
    var free = store.freeText;
    if (node.free.textContent !== free) node.free.textContent = free;
    if (node.free.dataset.known !== String(store.freeKnown)) node.free.dataset.known = String(store.freeKnown);
    if (node.netLabel.textContent !== store.netLabel) node.netLabel.textContent = store.netLabel;
    var nic = "fa-solid " + (NET_ICON[store.netType] || "fa-circle-question");
    if (node.netIcon.className !== nic) node.netIcon.className = nic;
  }

  /* La liste suit l'ordre du modèle (l'ordre du plan), comme la grille : pas
   * de tri, pas de recomposition — une déconnexion ne bouge pas la liste. */
  function paintStores(list, stores) {
    var want = {};
    stores.forEach(function (s) { want[s.deviceId] = s; });
    Object.keys(STORE_NODES).forEach(function (k) {
      if (!want[k]) {
        var n = STORE_NODES[k];
        if (n.root.parentNode) n.root.parentNode.removeChild(n.root);
        delete STORE_NODES[k];
      }
    });
    stores.forEach(function (store, i) {
      var node = STORE_NODES[store.deviceId];
      if (!node) {
        node = makeStoreRow(store);
        STORE_NODES[store.deviceId] = node;
      }
      if (node.root.parentNode !== list) list.appendChild(node.root);
      paintStoreRow(node, store);
      var kids = Array.prototype.slice.call(list.children);
      if (kids.indexOf(node.root) !== i) {
        list.insertBefore(node.root, kids[i] || null);
      }
    });
  }

  /* Le détail est un MODULE séparé : s'il n'est pas chargé (test, ancien
   * `index.html`), l'appui ne fait RIEN — pas d'erreur, et surtout pas un bouton
   * affiché ailleurs qui ne mènerait nulle part. */
  function openDetail(deviceId) {
    var d = global.MultiCamLiveDetail;
    if (!d || typeof d.open !== "function") return null;
    return d.open(deviceId);
  }

  /* UN écouteur sur la grille, posé une fois. Le clavier suit le pointeur : un
   * panneau de supervision piloté uniquement au doigt n'est pas utilisable en
   * régie. La remontée se fait à la main (parentNode) plutôt qu'avec
   * `closest`, qui peut manquer dans un DOM de test minimal. */
  function tileOfEvent(ev) {
    var grid = byId("liveGrid");
    var n = ev.target;
    while (n && n !== grid) {
      if (n.dataset && n.dataset.deviceId) return n;
      n = n.parentNode;
    }
    return null;
  }

  function bindGridEvents() {
    var grid = byId("liveGrid");
    if (!grid || typeof grid.addEventListener !== "function" || grid.__ldBound) return;
    grid.__ldBound = true;
    grid.addEventListener("click", function (ev) {
      var n = tileOfEvent(ev);
      if (n) openDetail(n.dataset.deviceId);
    });
    grid.addEventListener("keydown", function (ev) {
      var k = ev.key || "";
      if (k !== "Enter" && k !== " " && k !== "Spacebar") return;
      var n = tileOfEvent(ev);
      if (!n) return;
      if (ev.preventDefault) ev.preventDefault();
      openDetail(n.dataset.deviceId);
    });
  }

  /* Rendu IDEMPOTENT : les nœuds sont conservés d'un tick à l'autre, donc une
   * image déjà à l'écran n'est jamais rechargée. Seuls le nombre de cases, la
   * classe de grille et les différences d'état sont appliqués. */
  function render(modelView, rec) {
    var v = view(modelView, rec);
    var grid = byId("liveGrid");
    if (!grid) return v;
    bindGridEvents();
    if (grid.className !== v.gridClass) grid.className = v.gridClass;

    var want = {};
    v.tiles.forEach(function (t) { want[t.key] = t; });
    /* Purge des nœuds devenus inutiles (changement de Take) — le DOM suit le
     * modèle, il ne garde pas de vignette orpheline. */
    Object.keys(NODES).forEach(function (k) {
      if (!want[k]) {
        var n = NODES[k];
        if (n.root.parentNode) n.root.parentNode.removeChild(n.root);
        delete NODES[k];
      }
    });
    /* `grid.children` est une HTMLCollection : elle n'a PAS `indexOf`, et une
     * mosaïque à 4 Captures planterait au deuxième rendu. On travaille donc sur
     * un instantané en tableau, reconstruit à chaque vignette — le nombre de
     * cases d'une mosaïque est petit, la copie ne coûte rien. */
    v.tiles.forEach(function (tile, want0) {
      var node = NODES[tile.key];
      if (!node) {
        node = makeTile(tile);
        grid.appendChild(node.root);
      } else if (node.root.parentNode !== grid) {
        grid.appendChild(node.root);
      }
      paintTile(node, tile);
      /* L'ordre du DOM suit l'ordre du modèle — c'est tout. Aucune insertion
       * « intelligente », aucun tri : le modèle a déjà figé l'ordre. */
      var kids = Array.prototype.slice.call(grid.children);
      if (kids.indexOf(node.root) !== want0) {
        grid.insertBefore(node.root, kids[want0] || null);
      }
    });

    var head = byId("liveSession");
    if (head) head.textContent = v.sessionName;
    var take = byId("liveTake");
    if (take) take.textContent = v.takeLabel;
    var timer = byId("liveTimer");
    if (timer) timer.textContent = v.timer;
    var phase = byId("livePhase");
    if (phase) {
      phase.textContent = v.phase;
      phase.className = "live-phase phase-" + String(v.phase).toLowerCase();
    }
    var count = byId("liveCount");
    if (count) count.textContent = v.count + (v.count > 1 ? " Captures" : " Capture");
    var localCam = byId("liveLocalCam");
    if (localCam) localCam.textContent = v.localCamera.text;
    var empty = byId("liveEmpty");
    if (empty) empty.classList.toggle("d-none", !v.empty);
    /* J09-09c : zone Storage sous la mosaïque. Masquée tant qu'aucun Storage
     * n'est sélectionné pour CE Take : pas de placeholder trompeur. */
    var storesEl = byId("liveStores");
    if (storesEl) storesEl.classList.toggle("d-none", !v.hasStorages);
    var storeList = byId("liveStoreList");
    if (storeList && v.hasStorages) paintStores(storeList, v.storages);
    /* J10 : dock STOP global + confirmation, visibles sur la mosaïque en REC. */
    bindStopControls();
    renderStopControls(v);
    /* La modal ouverte suit le MÊME rendu (pas de second timer) : ses valeurs
     * ne peuvent pas diverger de celles des vignettes qu'elles décrivent. */
    if (global.MultiCamLiveDetail && typeof global.MultiCamLiveDetail.refresh === "function") {
      global.MultiCamLiveDetail.refresh();
    }
    return v;
  }

  function clear() {
    Object.keys(NODES).forEach(function (k) {
      var n = NODES[k];
      if (n.root.parentNode) n.root.parentNode.removeChild(n.root);
      delete NODES[k];
    });
    Object.keys(STORE_NODES).forEach(function (k) {
      var n = STORE_NODES[k];
      if (n.root.parentNode) n.root.parentNode.removeChild(n.root);
      delete STORE_NODES[k];
    });
  }

  global.MultiCamLiveScreen = {
    render: render,
    view: view,
    tiles: tiles,
    tileOf: tileOf,
    storagesOf: storagesOf,
    storageOf: storageOf,
    stopVisible: stopVisible,
    clear: clear,
    _nodes: NODES
  };

})(window);
