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
      byId("recentList").innerHTML = emptyState("Aucune session récente");
      byId("lanList").innerHTML = emptyState("Aucune session disponible");
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
        // Écran 14 réel (J02) : navigation vers la page Paramètres.
        global.location.href = "settings.html";
      });
    }
    ["navHistory", "createSession"].forEach(function (id) {
      var n = byId(id);
      if (n) {
        n.addEventListener("click", function () {
          showToast("Disponible dans une version ultérieure");
        });
      }
    });
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
      window.addEventListener("pageshow", function () {
        var cfg = global.MultiCamConfig.get();
        if (cfg) renderHome(cfg);
      });
    }
  };
})(window);