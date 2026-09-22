/* MultiCam — écran 03 (Session / Vue Master) en panneau monodocument.
 * Conforme maquette validée ui/03-master-session/ pour les jalons J04 (session
 * + second Master) et J05 (membres + sessionRoles).
 * - Header + barre de contexte : état (OUVERTE/FERMÉE), PIN Master persistant.
 * - Renommage (LMW locale via session-ws.renameSession) + "Terminer la session".
 * - J05 — "Devices dans la session" : membres avec sessionRoles ; l'ajout/édition
 *   se fait via la modal locale (Ajouter / crayon) qui ne propose que les rôles
 *   couvrant les skills annoncées du device (décision 31.1 : jamais un rôle non
 *   annoncé). Retrait = membership + rôles supprimés (tombstone), jamais les
 *   skills globales.
 * - J05 — "Disponibles sur le LAN" : peers de discovery (table MultiCamDiscovery,
 *   keyée deviceId) NON membres de la session ; bouton Ajouter.
 * - Présence : liveness WebSocket (décision 30.4) — un membre absent reste
 *   membre mais Déconnecté.
 * - J04 SPA : show(cfg, params) invoqué par le routeur ; les convergences
 *   push (sync/rename/close/member) re-rendent l'écran via onChanged (30.7).
 * Journalisation parsable : SCREEN03_*, MEMBER_*, SESSION_* (côté session-ws). */

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

  var state = { sid: null, session: null, connected: {}, modalDevice: null, modalMember: null };
  var bound = false;

  function selfDid() {
    var mk = global.MultiCamSessionWs;
    return (mk && mk.status && mk.status().localDid) || "";
  }

  function escRoles(roles) {
    return (roles || []).map(function (r) { return esc(r); }).join(", ");
  }

  /* ---------- rendu ---------- */

  function render() {
    var s = state.session;
    if (!s) return;
    var closed = s.state === "closed";
    byId("sessionName").textContent = s.name;

    var badge = byId("sessionBadge");
    badge.textContent = closed ? "FERMÉE" : "OUVERTE";
    badge.className = "badge rounded-pill " + (closed ? "text-bg-danger" : "text-bg-success");
    byId("sessionPin").textContent = "PIN " + s.pin;
    byId("sessionMeta").textContent = "Créée le " + (new Date(s.createdAtMs || Date.now())).toLocaleString("fr-FR")
      + (s.updatedAtMs ? " · modifiée " + (new Date(s.updatedAtMs)).toLocaleTimeString("fr-FR") : "");

    var mk = global.MultiCamSessionWs;
    var selfDidLocal = selfDid();
    var connected = (mk && mk.connectedPeers) ? mk.connectedPeers(s.sessionId) : {};
    state.connected = connected;

    var members = s.members || [];
    /* Un member dont le deviceId est absent de la liste maîtres peut être un
     * device non-Master (capture/storage pur) : présence réseau = liveness WS
     * si Master, sinon non connecté (pas d'autre signal V1). */
    var memberById = {};
    members.forEach(function (m) { memberById[m.deviceId] = m; });
    var mastersById = {};
    (s.masters || []).forEach(function (m) { mastersById[m.deviceId] = m; });

    var allRows = [];
    members.forEach(function (m) {
      var online = m.deviceId === selfDidLocal || !!(connected[m.deviceId]);
      allRows.push({
        deviceId: m.deviceId,
        name: m.deviceName || m.deviceId,
        online: online,
        self: m.deviceId === selfDidLocal,
        roles: (m.sessionRoles || []).slice(),
        enabled: (m.enabledSkills || []).slice(),
        isMember: true,
        isMaster: !!mastersById[m.deviceId]
      });
    });
    Object.keys(mastersById).forEach(function (did) {
      if (memberById[did]) return; /* déjà montré comme membre */
      var m = mastersById[did];
      var online = did === selfDidLocal || !!(connected[did]);
      allRows.push({
        deviceId: did,
        name: m.deviceName || did,
        online: online,
        self: did === selfDidLocal,
        roles: [],
        enabled: [],
        isMember: false,
        isMaster: true
      });
    });
    allRows.sort(function (a, b) { return a.name.localeCompare(b.name); });

    byId("membersCount").textContent = String(allRows.length);
    if (!allRows.length) {
      byId("membersList").innerHTML = '<div class="empty-state">Aucun device dans la session</div>';
    } else {
      byId("membersList").innerHTML = allRows.map(function (row) {
        var statusTxt = row.self ? "Cet appareil" : (row.online ? "Connecté" : "Déconnecté");
        var badges = "";
        if (row.isMaster) badges += '<span class="cap">Master</span>';
        row.roles.forEach(function (r) {
          badges += '<span class="cap" data-role="' + esc(r) + '">' + esc(r) + "</span>";
        });
        var editBtn = row.isMember
          ? '<button class="btn btn-outline-light glass icon member-edit" data-device="' + esc(row.deviceId) + '" type="button" aria-label="Modifier les rôles"><i class="fa-solid fa-pen"></i></button>'
          : "";
        return '<article class="card glass rounded-4"><div class="card-body p-3 d-flex align-items-center gap-3">'
          + '<i class="fa-solid fa-mobile-screen fs-4"></i>'
          + '<div class="flex-grow-1"><div class="fw-semibold text-truncate">' + esc(row.name) + "</div>"
          + '<div class="small muted">' + esc(statusTxt) + "</div>"
          + (badges ? '<div class="d-flex flex-wrap gap-1 mt-1">' + badges + "</div>" : "")
          + "</div>"
          + '<span class="' + (row.online ? "dot" : "dot off") + '"></span>'
          + editBtn
          + "</div></article>";
      }).join("");
    }

    renderAvailable(closed);

    var renameBtn = byId("renameButton");
    if (renameBtn) renameBtn.classList.toggle("d-none", closed);
    byId("actionsArea").classList.toggle("d-none", closed);
  }

  /* Devices détectés sur le LAN, NON membres de la session (décision 31.1).
   * Source : table de discovery (MultiCamDiscovery, keyée deviceId). */
  function renderAvailable(closed) {
    var s = state.session;
    var listEl = byId("availableList");
    var countEl = byId("availableCount");
    if (!listEl) return;
    if (closed) {
      listEl.innerHTML = "";
      countEl.textContent = "0";
      return;
    }
    var members = s.members || [];
    var memberSet = {};
    members.forEach(function (m) { memberSet[m.deviceId] = true; });
    var peers = (global.MultiCamDiscovery && global.MultiCamDiscovery.peers) ? global.MultiCamDiscovery.peers() : [];
    var available = peers.filter(function (p) { return p && p.deviceId && !memberSet[p.deviceId]; });
    countEl.textContent = String(available.length);
    if (!available.length) {
      listEl.innerHTML = '<div class="empty-state">Aucun device disponible sur le LAN</div>';
      return;
    }
    listEl.innerHTML = available.map(function (p) {
      return '<article class="card glass rounded-4"><div class="card-body p-3 d-flex align-items-center gap-3">'
        + '<i class="fa-solid fa-mobile-screen-button fs-4"></i>'
        + '<div class="flex-grow-1"><div class="fw-semibold text-truncate">' + esc(p.name || p.deviceId) + "</div>"
        + '<div class="small muted">' + esc((p.enabledSkills || []).join(" · ")) + "</div>"
        + "</div>"
        + '<button class="btn btn-sm btn-primary member-add" data-device="' + esc(p.deviceId) + '" type="button"><i class="fa-solid fa-plus me-1"></i>Ajouter</button>'
        + "</div></article>";
    }).join("");
  }

  /* ---------- modal locale (Ajouter / Modifier / Retirer) ---------- */

  function openModal(deviceRow, member) {
    state.modalDevice = deviceRow;
    state.modalMember = member || null;
    var title = byId("mmTitle");
    var nameEl = byId("mmDeviceName");
    var metaEl = byId("mmDeviceMeta");
    var rolesEl = byId("mmRoles");
    var saveBtn = byId("mmSave");
    var removeBtn = byId("mmRemove");
    var saveLabel = byId("mmSaveLabel");

    if (member) {
      title.textContent = "Modifier le device";
      saveLabel.textContent = "Enregistrer";
      removeBtn.classList.remove("d-none");
    } else {
      title.textContent = "Ajouter un device";
      saveLabel.textContent = "Ajouter";
      removeBtn.classList.add("d-none");
    }
    nameEl.textContent = deviceRow.deviceName || deviceRow.deviceId;
    metaEl.textContent = (deviceRow.enabledSkills || []).join(" · ") || "Aucune skill annoncée";

    /* La modal ne propose QUE les rôles couverts par les skills annoncées. */
    var enabled = deviceRow.enabledSkills || [];
    var currentRoles = member ? (member.sessionRoles || []) : [];
    var html = (global.MultiCamSessionModel.VALID_ROLES || ["capture", "storage"]).map(function (role) {
      if (enabled.indexOf(role) < 0) return ""; /* jamais proposé si non annoncé */
      var checked = currentRoles.indexOf(role) >= 0 ? " checked" : "";
      return '<label class="cap member-role-option' + (checked ? " checked" : "") + '">'
        + '<input type="checkbox" data-role="' + esc(role) + '"' + checked + '> '
        + (role === "capture" ? "Capture" : "Storage") + "</label>";
    }).join("");
    var anyProposable = html.indexOf("type=\"checkbox\"") >= 0;
    rolesEl.innerHTML = anyProposable ? html : '<div class="small muted">Aucun rôle n\'est proposable pour ce device (skills non annoncées).</div>';
    saveBtn.disabled = !anyProposable;
    byId("mmHint").textContent = anyProposable
      ? "Au moins un rôle requis. Les rôles non annoncés sont ignorés."
      : "Impossible d'ajouter ce device : aucun rôle de session ne correspond à ses skills.";
    byId("memberModal").classList.add("show");
    console.log("SCREEN03_MODAL_OPEN mode=" + (member ? "edit" : "add") + " did=" + deviceRow.deviceId
      + " enabled=[" + enabled.join(",") + "] proposed=[" + selectedRoles().join(",") + "]");
  }

  function closeModal() {
    byId("memberModal").classList.remove("show");
    state.modalDevice = null;
    state.modalMember = null;
  }

  function selectedRoles() {
    var out = [];
    var inputs = document.querySelectorAll("#mmRoles input[type=checkbox]:checked");
    Array.prototype.forEach.call(inputs, function (el) { out.push(el.getAttribute("data-role")); });
    return out;
  }

  function ops() { return global.MultiCamSessionWs; }

  function confirmModalSave() {
    var s = state.session;
    if (!s || state.session.state === "closed") return;
    var roles = selectedRoles();
    if (!roles.length) { showToast("Sélectionnez au moins un rôle"); return; }
    var device = state.modalDevice;
    var member = state.modalMember;
    var did = device.deviceId;
    var p;
    if (member) {
      p = ops().updateMemberRoles(s, did, roles);
    } else {
      p = ops().addMember(s, { deviceId: did, deviceName: device.deviceName || did, enabledSkills: device.enabledSkills || [] }, roles);
    }
    p.then(function (upd) {
      console.log("SCREEN03_MEMBER_SAVE mode=" + (member ? "edit" : "add") + " did=" + did + " roles=[" + roles.join(",") + "]");
      state.session = upd;
      closeModal();
      render();
    }).catch(function (err) {
      var msg = (err && err.message) || "rejected";
      console.log("SCREEN03_MEMBER_SAVE_FAIL did=" + did + " reason=" + msg + " roles=[" + roles.join(",") + "]");
      showToast(msg === "no_valid_role_for_device" ? "Rôle non annoncé par le device" : "Modification impossible");
    });
  }

  function confirmModalRemove() {
    var s = state.session;
    var member = state.modalMember;
    if (!s || !member || s.state === "closed") return;
    if (!global.confirm("Retirer « " + (member.deviceName || member.deviceId) + " » de la session ?")) return;
    ops().removeMember(s, member.deviceId).then(function (upd) {
      console.log("SCREEN03_MEMBER_REMOVE did=" + member.deviceId);
      state.session = upd;
      closeModal();
      render();
    }).catch(function (err) {
      console.log("SCREEN03_MEMBER_REMOVE_FAIL did=" + member.deviceId + " reason=" + String((err && err.message) || err));
    });
  }

  /* ---------- rename / close ---------- */

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

    /* Délégation : contenu généré dynamiquement (members + LAN + modal). */
    document.body.addEventListener("click", function (ev) {
      var add = ev.target.closest ? ev.target.closest(".member-add") : null;
      var edit = ev.target.closest ? ev.target.closest(".member-edit") : null;
      if (add) {
        var did = add.getAttribute("data-device");
        var peer = null;
        if (global.MultiCamDiscovery && global.MultiCamDiscovery.peers) {
          global.MultiCamDiscovery.peers().forEach(function (p) { if (p.deviceId === did) peer = p; });
        }
        if (!peer) {
          showToast("Device introuvable sur le LAN");
          return;
        }
        openModal(peer, null);
        return;
      }
      if (edit) {
        var didE = edit.getAttribute("data-device");
        var member = null;
        (state.session.members || []).forEach(function (m) { if (m.deviceId === didE) member = m; });
        if (!member) return;
        openModal(member, member);
      }
    });
    byId("mmClose").addEventListener("click", closeModal);
    byId("mmCancel").addEventListener("click", closeModal);
    var backdrop = document.querySelector("#memberModal .modal-backdrop");
    if (backdrop) backdrop.addEventListener("click", function () { closeModal(); });
    byId("mmSave").addEventListener("click", confirmModalSave);
    byId("mmRemove").addEventListener("click", confirmModalRemove);
    byId("mmRoles").addEventListener("change", function () {
      /* Proposer les rôle-options en "checked" visuellement + garde ≥1 */
      var any = selectedRoles().length > 0;
      var opts = document.querySelectorAll("#mmRoles .member-role-option");
      Array.prototype.forEach.call(opts, function (o) {
        var input = o.querySelector("input[type=checkbox]");
        o.classList.toggle("checked", input && input.checked);
      });
      byId("mmSave").disabled = !any;
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
     * rename, close, memberAdded/RolesChanged/Removed) re-rend l'écran. */
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
    /* Mise à jour de présence en continu : liveness WS + arrivées/disparitions
     * LAN (un device retiré revient dans les disponibles immédiatement). */
    if (global.MultiCamDiscovery && global.MultiCamDiscovery.onChanged) {
      global.MultiCamDiscovery.onChanged(function () {
        if (state.session && state.session.state === "open") render();
      });
    }
    setInterval(function () {
      if (state.session) render();
    }, 5000);
  }

  global.MultiCamSessionScreen = {
    show: function (cfg, params) { ensureReactive(cfg); show(cfg, params); }
  };
})(window);