/* MultiCam — UI couche, écran 01 (Accueil / Découverte).
 * Rend conforme à la maquette validée ui/01-session-discovery/index.html.
 * Règles d'invariants : zéro enabledSkills autorisé ; une skill non supportée ne
 * peut pas être activée ; désactiver controller masque toute l'UI de gestion de
 * sessions. Aucune donnée de démo : sessions récentes et LAN en état vide réel. */

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

  function renderHome(cfg) {
    byId("deviceName").textContent = cfg.deviceName;
    renderSkillBadges(byId("skillBadges"), cfg);

    var isMaster = global.MultiCamConfig.isControllerEnabled();
    var sections = [byId("recentArea"), byId("masterArea"), byId("newSession")];
    sections.forEach(function (s) {
      if (s) s.style.display = isMaster ? "" : "none";
    });

    if (isMaster) {
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
      // J01 : aucune découverte active (réseau inactif), l'état vide reste affiché.
      setTimeout(function () {
        b.disabled = false;
        b.innerHTML = html;
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
    bind: function () { bindMenu(); bindRefresh(); bindStubs(); }
  };
})(window);