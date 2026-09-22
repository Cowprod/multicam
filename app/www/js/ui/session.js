/* MultiCam — écran 03 (Session / Vue Master) en panneau monodocument.
 * Conforme maquette validée ui/03-master-session/ pour le jalon J04 (session
 * initiale, pas encore les Takes/cycles J05+, ni l'admission des devices).
 * - Header + barre de contexte : état (OUVERTE/FERMÉE), PIN Master persistant.
 * - Renommage (LMW locale via session-ws.renameSession) + "Terminer la session".
 * - Membres : liste des Masters de la session ; présence réévaluée en temps réel
 *   via la liveness WebSocket (décision 30.4) ; un absent reste membre mais
 *   Déconnecté.
 * - J04 SPA : show(cfg, params) invoqué par le routeur ; les convergences
 *   push (sync/rename/close) re-rendent l'écran via onChanged (30.7).
 * Journalisation parsable : SCREEN03_*, SESSION_* (côté session-ws). */

(function (global) {
  "use strict";

  function byId(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function showToast(msg) {
    var t = byId("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  var state = { sid: null, session: null, connected: {} };
  var bound = false;

  function render() {
    var s = state.session;
    if (!s) return;
    byId("sessionName").textContent = s.name;

    var closed = s.state === "closed";
    var badge = byId("sessionBadge");
    badge.textContent = closed ? "FERMÉE" : "OUVERTE";
    badge.className = "badge rounded-pill " + (closed ? "text-bg-danger" : "text-bg-success");
    byId("sessionPin").textContent = "PIN " + s.pin;
    byId("sessionMeta").textContent = "Créée le " + (new Date(s.createdAtMs || Date.now())).toLocaleString("fr-FR")
      + (s.updatedAtMs ? " · modifiée " + (new Date(s.updatedAtMs)).toLocaleTimeString("fr-FR") : "");

    var mk = global.MultiCamSessionWs;
    var selfDid = mk && mk.status ? mk.status().localDid : "";
    var connected = (mk && mk.connectedPeers) ? mk.connectedPeers(s.sessionId) : {};
    state.connected = connected;

    var members = s.masters || [];
    byId("membersCount").textContent = String(members.length);
    if (!members.length) {
      byId("membersList").innerHTML = '<div class="empty-state">Aucun device dans la session</div>';
    } else {
      byId("membersList").innerHTML = members.map(function (m) {
        var isSelf = m.deviceId === selfDid && selfDid;
        var isOnline = isSelf || !!(connected[m.deviceId]);
        var dotCls = isOnline ? "dot" : "dot off";
        var statusTxt = isSelf ? "Cet appareil" : (isOnline ? "Connecté" : "Déconnecté");
        return '<article class="card glass rounded-4"><div class="card-body p-3 d-flex align-items-center gap-3">'
          + '<i class="fa-solid fa-mobile-screen fs-4"></i>'
          + '<div class="flex-grow-1"><div class="fw-semibold text-truncate">' + esc(m.deviceName || m.deviceId) + "</div>"
          + '<div class="small muted">' + esc(statusTxt)
          + (m.endpoint ? " · " + esc(m.endpoint) : "") + "</div></div>"
          + '<span class="' + dotCls + '"></span></div></article>';
      }).join("");
    }

    var renameBtn = byId("renameButton");
    if (renameBtn) renameBtn.classList.toggle("d-none", closed);
    byId("actionsArea").classList.toggle("d-none", closed);
  }

  function toggleRenameForm(show) {
    byId("sessionNameRow").classList.toggle("d-none", show);
    byId("sessionNameForm").classList.toggle("d-none", !show);
    if (show) {
      byId("sessionNameInput").value = (state.session && state.session.name) || "";
      byId("sessionNameInput").focus();
    }
  }

  function bind() {
    if (bound) return;
    bound = true;
    var renameBtn = byId("renameButton");
    if (renameBtn) {
      renameBtn.addEventListener("click", function () { toggleRenameForm(true); });
    }
    byId("renameCancel").addEventListener("click", function () { toggleRenameForm(false); });
    byId("renameSave").addEventListener("click", function () {
      var n = byId("sessionNameInput").value.trim();
      if (!n) { showToast("Nom obligatoire"); return; }
      global.MultiCamSessionWs.renameSession(state.session, n).then(function (s) {
        console.log("SCREEN03_RENAME_TO sessionId=" + s.sessionId + " name=" + s.name);
        toggleRenameForm(false);
        state.session = s;
        render();
      }).catch(function (err) {
        showToast("Renommage impossible");
        console.log("SCREEN03_RENAME_ERROR err=" + String((err && err.message) || err));
      });
    });
    byId("closeButton").addEventListener("click", function () {
      if (!global.confirm("Terminer la session « " + state.session.name + " » ?")) return;
      global.MultiCamSessionWs.closeSession(state.session).then(function (s) {
        console.log("SCREEN03_CLOSE_OK sessionId=" + s.sessionId + " state=" + s.state);
        state.session = s;
        render();
      }).catch(function (err) {
        console.log("SCREEN03_CLOSE_ERROR err=" + String((err && err.message) || err));
        showToast("Impossible de terminer la session");
      });
    });
  }

  function show(cfg, params) {
    var sid = params.sid;
    if (!sid) {
      global.MultiCamNav.show("home");
      return;
    }
    byId("deviceNameSession").textContent = cfg.deviceName;
    state.sid = sid;
    bind();

    global.MultiCamSessionStore.get(sid).then(function (s) {
      if (!s) {
        console.log("SCREEN03_MISSING sessionId=" + sid + " → home");
        global.MultiCamNav.show("home");
        return;
      }
      state.session = s;
      if (params.fresh === "1") console.log("SCREEN03_OPEN sessionId=" + sid + " origin=fresh state=" + s.state);
      else console.log("SCREEN03_OPEN sessionId=" + sid + " origin=resume state=" + s.state);

      render();

      /* Liveness + convergence : le serveur WS est idempotent (SPA, un seul
       * démarrage natif) ; on (ré)annonce et re-synchronise vers les peers
       * connus à chaque entrée sur l'écran 03. */
      global.MultiCamSessionWs.ensureServer()
        .then(function () {
          if (state.session.state === "open") {
            return global.MultiCamSessionWs.advertiseOpenSessions().then(function () {
              global.MultiCamSessionWs.reSyncSession(state.session);
            });
          }
          /* Session fermée : serveur maintenu pour la sync de retour (30.9.3),
           * PAS d'annonce DNS-SD. */
          return global.MultiCamSessionWs.unadvertise();
        })
        .catch(function (err) {
          console.log("SCREEN03_SERVER_ERROR err=" + String((err && err.message) || err));
        });
    });
  }

  function ensureReactive(cfg) {
    if (ensureReactive._done) return;
    ensureReactive._done = true;
    /* Rendu temps réel : toute mutation locale ou convergence distante (sync,
     * rename, close, masterAdded) re-rend l'écran. */
    global.MultiCamSessionWs.onChanged(function () {
      if (!state.sid) return;
      global.MultiCamSessionStore.get(state.sid).then(function (s) {
        if (!s) return;
        var prevOpen = !!(state.session && state.session.state === "open");
        var changed = !state.session || JSON.stringify(s) !== JSON.stringify(state.session);
        state.session = s;
        if (!changed) return;
        render();
        if (s.state === "open") {
          global.MultiCamSessionWs.advertiseOpenSessions();
          global.MultiCamSessionWs.reSyncSession(s);
        } else if (prevOpen) {
          console.log("SCREEN03_CLOSED_LEARNED sessionId=" + s.sessionId + " via=sync");
          global.MultiCamSessionWs.unadvertise();
        }
      });
    });
    /* Mise à jour de présence en continu (heartbeat abaisse/remonte les dots). */
    setInterval(function () {
      if (state.session) render();
    }, 5000);
  }

  global.MultiCamSessionScreen = {
    show: function (cfg, params) { ensureReactive(cfg); show(cfg, params); }
  };
})(window);