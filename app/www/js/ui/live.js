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

  /* ---------- COUCHÉ PURE : descripteurs de vignette ---------- */

  /* Une vignette = { clé stable, libellés, image, état visuel }. Les tests
   * assertent dessus ; le DOM n'est qu'une projection. */
  function tileOf(slot) {
    var state = slot.displayState || "REC";
    var isLocal = !!slot.isLocal;
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
      /* Aucun badge textuel, et surtout pas « ce device » : la maquette
       * l'interdit explicitement. La télémétrie (batterie, espace, réseau)
       * arrive à la mission suivante ; la case est donc vide, pas fausse. */
      badges: []
    };
  }

  function tiles(modelView) {
    var v = modelView || {};
    var slots = Array.isArray(v.slots) ? v.slots : [];
    return slots.map(tileOf);
  }

  function gridClass(count) {
    return "live-grid cols-" + (COLS[count] || colsFor(count));
  }

  function view(modelView, rec) {
    var v = modelView || {};
    var r = rec || {};
    var ts = tiles(v);
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
    info.appendChild(name);
    info.appendChild(state);
    root.appendChild(media);
    root.appendChild(info);
    var node = { root: root, media: media, img: null, name: name, state: state, appliedSrc: null };
    NODES[tile.key] = node;
    return node;
  }

  /* Rendu IDEMPOTENT : les nœuds sont conservés d'un tick à l'autre, donc une
   * image déjà à l'écran n'est jamais rechargée. Seuls le nombre de cases, la
   * classe de grille et les différences d'état sont appliqués. */
  function render(modelView, rec) {
    var v = view(modelView, rec);
    var grid = byId("liveGrid");
    if (!grid) return v;
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
