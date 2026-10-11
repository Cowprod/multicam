
(function (global) {
  "use strict";

  function byId(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  var state = { bound: false };

  function render() {
    var list = byId("historyList");
    if (!list) return;
    var store = global.MultiCamSessionStore;
    if (!store) { list.innerHTML = '<div class="empty-state">Aucun historique</div>'; return; }
    store.list().then(function (all) {
      if (!all || !all.length) {
        list.innerHTML = '<div class="empty-state">Aucune session récente</div>';
        return;
      }
      list.innerHTML = all.map(function (s) {
        var closed = s.state === "closed";
        var badge = closed ? '<span class="badge rounded-pill text-bg-danger ms-1">FERMÉE</span>' : '<span class="badge rounded-pill text-bg-success ms-1">OUVERTE</span>';
        var takes = Array.isArray(s.takes) ? s.takes.length : 0;
        return '<button type="button" class="card glass rounded-4 w-100 text-start history-card mb-2" data-sid="' + esc(s.sessionId) + '">'
          + '<div class="card-body p-3 d-flex align-items-center gap-3">'
          + '<i class="fa-solid fa-clock-rotate-left fs-4"></i>'
          + '<div class="flex-grow-1"><div class="fw-semibold text-truncate">' + esc(s.name) + badge + "</div>"
          + '<div class="small muted">' + takes + ' Take(s)</div></div>'
          + '<i class="fa-solid fa-chevron-right muted"></i></div></button>';
      }).join("");
      var cards = document.querySelectorAll(".history-card");
      Array.prototype.forEach.call(cards, function (c) {
        c.onclick = function () {
          if (global.MultiCamNav && global.MultiCamNav.show) {
            global.MultiCamNav.show("session", { sid: c.getAttribute("data-sid") });
          }
        };
      });
    }).catch(function () {
      list.innerHTML = '<div class="empty-state">Aucun historique</div>';
    });
  }

  function show() {
    if (!state.bound) {
      state.bound = true;
      var back = byId("historyBack");
      if (back) back.onclick = function () {
        if (global.MultiCamNav && global.MultiCamNav.show) global.MultiCamNav.show("home");
      };
    }
    render();
  }

  global.MultiCamHistoryScreen = {
    show: show,
    render: render
  };
})(window);
