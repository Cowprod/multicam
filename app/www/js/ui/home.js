/* MultiCam — UI couche, écran 01 (Accueil / Découverte).
 * Rend conforme à la maquette validée ui/01-session-discovery/index.html.
 * Règles d'invariants : zéro enabledSkills autorisé ; une skill non supportée ne
 * peut pas être activée ; désactiver controller masque toute l'UI de gestion de
 * sessions. Aucune donnée de démo : sessions récentes et LAN en état vide réel.
 * J03 : annonce mDNS réelle (statut "Disponible sur le réseau") + liste
 * "Périphériques détectés" alimentée par la table de peers clé deviceId. */

(function (global) {
  "use strict";

  function byId(id) { return document.getElementById(id); }

  function renderSkillBadges(container, cfg) {
    var html = cfg.supportedSkills.map(function (s) {
      var meta = global.MultiCamConfig.skillMeta[s] || { icon: "fa-question", label: s };
      var active = cfg.enabledSkills.indexOf(s) >= 0;
      return '<span class="cap' + (active ? "" : " off") + '"><i class="fa-solid ' + meta.icon + ' me-1"></i>' + meta.label + "</span>";
    }).join("");
    container.innerHTML = html;
  }

  function emptyState(text) {
    return '<div class="empty-state">' + text + "</div>";
  }

  function showToast(msg) {
    var t = byId("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }

  function updateNetStatus(cfg) {
    var st = global.MultiCamNet.status() || {};
    var line = byId("netStatus");
    if (!line) return;
    if (st.running && st.advertising && st.healthPort) {
      line.innerHTML = '<i class="fa-solid fa-wifi me-1"></i>Annonce mDNS active'
        + " · " + st.registeredName
        + " · port " + st.healthPort
        + "<i class='fa-solid fa-lg mx-2' style='display:none'></i>";
      if (st.ipv4) line.innerHTML += " · IP " + st.ipv4;
    } else if (st.running) {
      line.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin me-1"></i>Annonce mDNS en cours…';
    } else {
      line.innerHTML = '<i class="fa-solid fa-circle-xmark me-1"></i>Réseau local inactif';
    }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* Sessions récentes (écran 01, maquette validée) : 4 plus récentes de la
   * persistance locale. Un appui ouvre la Session 03 avec sa config persistée
   * (PIN, membres, rôles — reprise §30.9.1). */
  function renderRecents() {
    var list = byId("recentList");
    if (!list) return;
    var store = global.MultiCamSessionStore;
    if (!store) { list.innerHTML = ""; return; }
    store.list().then(function (all) {
      var recent = all.slice(0, 4);
      if (!recent.length) {
        list.innerHTML = emptyState("Aucune session récente");
        return;
      }
      list.innerHTML = recent.map(function (s) {
        var closed = s.state === "closed";
        var badge = closed
          ? '<span class="badge rounded-pill text-bg-danger ms-1">FERMÉE</span>'
          : '<span class="badge rounded-pill text-bg-success ms-1">OUVERTE</span>';
        return '<button type="button" class="card glass rounded-4 w-100 text-start session-card" data-sid="' + esc(s.sessionId) + '">'
          + '<div class="card-body p-3 d-flex align-items-center gap-3">'
          + '<i class="fa-solid fa-sliders fs-4"></i>'
          + '<div class="flex-grow-1"><div class="fw-semibold text-truncate">' + esc(s.name) + badge + "</div>"
          + '<div class="small muted">PIN ' + esc(s.pin) + " · " + (s.masters ? s.masters.length : 0) + " membre(s)</div></div>"
          + '<i class="fa-solid fa-chevron-right muted"></i></div></button>';
      }).join("");
      bindSessionCards();
    });
  }

  function bindSessionCards() {
    var cards = document.querySelectorAll(".session-card");
    Array.prototype.forEach.call(cards, function (c) {
      c.addEventListener("click", function () {
        global.MultiCamNav.show("session", { sid: c.getAttribute("data-sid") });
      });
    });
  }

  /* Sessions disponibles sur le LAN (J04 découverte session) : dédup par
   * sessionId, on masque celles dont on est déjà membre localement. */
  function renderLanSessions() {
    var list = byId("lanList");
    if (!list) return;
    var disc = global.MultiCamSessionDiscovery;
    if (!disc) { list.innerHTML = emptyState("Aucune session disponible"); return; }
    var store = global.MultiCamSessionStore;
    Promise.resolve(store ? store.list() : Promise.resolve([])).then(function (locals) {
      var localIds = {};
      (locals || []).forEach(function (s) { localIds[s.sessionId] = true; });
      var found = disc.list();
      var available = found.filter(function (e) { return !localIds[e.sessionId]; });
      setLanCount(available.length);
      if (!available.length) {
        list.innerHTML = emptyState("Aucune session disponible");
        return;
      }
      list.innerHTML = available.map(function (e) {
        var ann = e.announcers || [];
        var inst = ann.length ? ann[ann.length - 1] : null;
        var host = inst ? inst.host : "";
        var port = inst ? inst.port : 0;
        var endpoint = (host && port) ? escapeURI(host) + ":" + port : "";
        return '<article class="card glass rounded-4"><div class="card-body p-3 d-flex align-items-center gap-3">'
          + '<i class="fa-solid fa-sliders fs-4"></i>'
          + '<div class="flex-grow-1"><div class="fw-semibold text-truncate">' + esc(e.name) + "</div>"
          + '<div class="small muted">' + (endpoint ? esc(endpoint) : "détection en cours…")
          + " · " + ann.length + " Master(s)</div></div>"
          + '<button type="button" class="btn btn-outline-light glass session-join"'
          + ' data-sid="' + esc(e.sessionId) + '"'
          + ' data-name="' + esc(e.name) + '"'
          + ' data-host="' + esc(host) + '"'
          + ' data-port="' + String(port) + '">Rejoindre</button>'
          + "</div></article>";
      }).join("");
      bindJoinButtons();
    });
  }

  function bindJoinButtons() {
    var btns = document.querySelectorAll(".session-join");
    Array.prototype.forEach.call(btns, function (b) {
      b.addEventListener("click", function () {
        global.MultiCamNav.show("join", {
          sid: b.getAttribute("data-sid"),
          name: b.getAttribute("data-name"),
          host: b.getAttribute("data-host"),
          port: b.getAttribute("data-port")
        });
      });
    });
  }

  function escapeURI(s) { return s; }

  function setLanCount(n) {
    var c = byId("lanCount");
    if (c) c.textContent = String(n);
  }

  function renderDevices() {
    var list = byId("devicesList");
    var count = byId("devicesCount");
    if (!list) return;
    var peers = global.MultiCamNet.peers();
    if (count) count.textContent = String(peers.length);
    if (!peers.length) {
      list.innerHTML = emptyState("Aucun périphérique détecté sur le réseau");
      return;
    }
    list.innerHTML = peers.map(function (p) {
      var caps = p.enabledSkills.map(function (s) {
        var meta = global.MultiCamConfig.skillMeta[s] || { icon: "fa-question", label: s };
        return '<span class="cap"><i class="fa-solid ' + meta.icon + ' me-1"></i>' + meta.label + "</span>";
      }).join("") || '<span class="cap off">aucune skill active</span>';
      return '<article class="card glass rounded-4"><div class="card-body p-3 d-flex align-items-center gap-3">'
        + '<i class="fa-solid fa-mobile-screen fs-4"></i>'
        + '<div class="flex-grow-1"><div class="fw-semibold text-truncate">' + esc(p.name) + "</div>"
        + '<div class="small muted">' + (p.endpoint ? esc(p.endpoint) : "…") + "</div>"
        + '<div class="d-flex flex-wrap gap-1 mt-1">' + caps + "</div></div>"
        + '<span class="dot" title="En ligne"></span></div></article>';
    }).join("");
  }

  function renderHome(cfg) {
    byId("deviceName").textContent = cfg.deviceName;
    renderSkillBadges(byId("skillBadges"), cfg);
    updateNetStatus(cfg);

    var isMaster = global.MultiCamConfig.isControllerEnabled();
    ["devicesArea", "recentArea", "masterArea", "newSession"].forEach(function (id) {
      var s = byId(id);
      if (s) s.style.display = isMaster ? "" : "none";
    });

    if (isMaster) {
      renderDevices();
      renderRecents();
      renderLanSessions();
    } else {
      byId("recentList").innerHTML = "";
      byId("lanList").innerHTML = "";
    }
  }

  function bindMenu() {
    byId("menuButton").addEventListener("click", function () {
      byId("menu").classList.toggle("open");
    });
  }

  function bindRefresh() {
    byId("refresh").addEventListener("click", function () {
      var b = byId("refresh");
      var html = b.innerHTML;
      b.disabled = true;
      b.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
      setTimeout(function () {
        b.disabled = false;
        b.innerHTML = html;
        renderDevices();
        updateNetStatus(global.MultiCamConfig.get());
      }, 700);
    });
  }

  function bindStubs() {
    var nv = byId("navSettings");
    if (nv) {
      nv.addEventListener("click", function () {
        var menu = byId("menu");
        if (menu) menu.classList.remove("open");
        // Panneau Paramètres (J04 SPA : même document, pas de navigation).
        global.MultiCamNav.show("settings");
      });
    }
    var nh = byId("navHistory");
    if (nh) {
      nh.addEventListener("click", function () {
        var menu = byId("menu");
        if (menu) menu.classList.remove("open");
        showToast("Disponible dans une version ultérieure");
      });
    }
    var cs = byId("createSession");
    if (cs) {
      cs.addEventListener("click", function () {
        // Panneau Création (J04 SPA : même document, pas de navigation).
        global.MultiCamNav.show("create");
      });
    }
  }

  global.MultiCamHome = {
    render: renderHome,
    bind: function () {
      bindMenu(); bindRefresh(); bindStubs();
      if (global.MultiCamDiscovery && global.MultiCamDiscovery.onChanged) {
        global.MultiCamDiscovery.onChanged(function () {
          renderDevices();
          updateNetStatus(global.MultiCamConfig.get());
        });
      }
      if (global.MultiCamSessionDiscovery) {
        global.MultiCamSessionDiscovery.onChanged(function () {
          renderLanSessions();
        });
      }
      if (global.MultiCamSessionStore) {
        global.MultiCamSessionWs.onChanged(function () {
          renderLanSessions();
        });
      }
      window.addEventListener("pageshow", function () {
        var cfg = global.MultiCamConfig.get();
        if (cfg) renderHome(cfg);
      });
    }
  };
})(window);