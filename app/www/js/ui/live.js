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

  function tiles(modelView, rec) {
    var v = modelView || {};
    var slots = Array.isArray(v.slots) ? v.slots : [];
    var now = (rec && typeof rec.nowMs === "number") ? rec.nowMs : Date.now();
    return slots.map(function (s) { return tileOf(s, now); });
  }

  function gridClass(count) {
    return "live-grid cols-" + (COLS[count] || colsFor(count));
  }

  function view(modelView, rec) {
    var v = modelView || {};
    var r = rec || {};
    var ts = tiles(v, r);
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
      empty: ts.length === 0
    };
  }

  /* ---------- COUCHÉ DOM ---------- */

  function byId(id) { return global.document ? global.document.getElementById(id) : null; }

  var NODES = {};      /* key -> {root, media, img, name, state, badge} */

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
    var empty = byId("liveEmpty");
    if (empty) empty.classList.toggle("d-none", !v.empty);
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
  }

  global.MultiCamLiveScreen = {
    render: render,
    view: view,
    tiles: tiles,
    tileOf: tileOf,
    clear: clear,
    _nodes: NODES
  };

})(window);
