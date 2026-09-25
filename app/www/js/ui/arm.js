/* MultiCam — écran 06 ARM distribué + synchronisation d'horloge (J07).
 * Rendu de la machine déterministe MultiCamArmService (arm-service.js →
 * arm-model.js) conformément à la maquette validée ui/06-arm :
 *  - ARM auto-démarré à l'entrée (aucun bouton intermédiaire) ; RETOUR à l'écran 05
 *    = ARM_CANCEL (cycle invalidé, aucun résultat antérieur réutilisé) ;
 *  - seuls les devices sélectionnés du Take, dans l'ordre exact de l'écran 05 ;
 *    un device apparaît une seule fois (plusieurs rôles possibles) ;
 *  - état porté par les icônes de skill (Capture fa-video / Storage fa-hard-drive)
 *    : ARMING=spinner/neutre, READY=success, WARNING=warning, ERROR=danger ; AUCUN
 *    texte à côté des icônes sur la liste principale ;
 *  - clic sur une icône = accordéon de détail du skill ; les accordéons ne
 *    s'ouvrent JAMAIS automatiquement lors d'un incident ;
 *  - dock REC fixe : éligible dès ≥1 Capture READY ou WARNING ; Storage/ARMING/
 *    ERROR n'y participent jamais ; en J07 un appui valide ne déclenche AUCUN
 *    enregistrement (J08) : journal REC_ELIGIBLE_NEXT_J08 ;
 *  - modal incidents (WARNING/ERROR/ARMING/déconnecté/Storage), auto-fermeture
 *    quand tous les incidents disparaissent.
 * Journalisation parsable : SCREEN06_* (open/back/rec/incident) ; les ARM_* et
 * CLOCK_SYNC* étant émis par le modèle.
 */

(function (global) {
  "use strict";

  function byId(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function pad3(n) { return String(n).padStart(3, "0"); }

  function am() { return global.MultiCamArmModel; }

  var state = { sid: null, bound: false, openDetail: {} };
  var lastRev = -1;

  var SKILL_ICON = { capture: "fa-video", storage: "fa-hard-drive" };
  var STATUS_CLASS = { ARMING: "arming", READY: "ready", WARNING: "warning", ERROR: "error" };
  var STATUS_ICON = { ARMING: "fa-circle-notch fa-spin", READY: "fa-circle-check", WARNING: "fa-triangle-exclamation", ERROR: "fa-circle-xmark" };
  /* l'ARMING porte un spinner en médaillon ; READY/WARNING/ERROR restent portés par
   * la couleur de l'icône de skill (aucun texte sur la liste principale) */

  function lineClass(st) {
    if (st === "ok") return "arm-ok";
    if (st === "warn") return "arm-warn";
    if (st === "err") return "arm-err";
    return "arm-pending";
  }

  function skillLine(sk, did) {
    var icon = SKILL_ICON[sk.skill] || "fa-circle";
    var cls = STATUS_CLASS[sk.status] || "arming";
    var spin = sk.status === "ARMING" ? '<i class="fa-solid fa-circle-notch fa-spin skill-state-spin"></i>' : "";
    return '<button class="skill-state ' + cls + '" data-device="' + did + '" data-skill="' + sk.skill + '" title="' + sk.skill + '">'
      + '<i class="fa-solid ' + icon + '"></i>' + spin + '</button>';
  }

  function checksHtml(sk) {
    var rows = "";
    (sk.checks || []).forEach(function (c) {
      rows += '<div class="arm-line ' + lineClass(c.status) + '">'
        + '<span class="arm-line-label">' + esc(c.label) + '</span>'
        + '<span class="arm-line-msg">' + esc(c.message || statusLabel(c.status)) + '</span>'
        + '</div>';
    });
    return rows;
  }

  function statusLabel(st) {
    if (st === "ok") return "OK";
    if (st === "warn") return "Alerte";
    if (st === "err") return "Erreur";
    return "En cours";
  }

  function deviceHtml(dev, opened) {
    var skillsButtons = "", details = "";
    (dev.skills || []).forEach(function (sk) {
      skillsButtons += skillLine(sk, dev.did);
      var key = dev.did + ":" + sk.skill;
      var open = opened[key] ? "" : " d-none";
      details += '<div class="arm-detail' + open + '" data-detail="' + key + '">' + checksHtml(sk) + '</div>';
    });
    return '<div class="arm-device" data-aware="1">'
      + '<div class="arm-device-main">'
      + '<i class="fa-solid fa-mobile-screen-button fs-4 muted"></i>'
      + '<div class="flex-grow-1">'
      + '<div class="fw-semibold">' + esc(dev.deviceName) + '</div>'
      + '<div class="small muted">' + esc(dev.did) + '</div>'
      + '</div>'
      + skillsButtons
      + '</div>'
      + details
      + '</div>';
  }

  function render(view) {
    if (!view || view.rev === lastRev) return;
    lastRev = view.rev;

    byId("armTakeName").textContent = view.takeNumber ? "Take " + pad3(view.takeNumber) + " · ARM" : "ARM";
    byId("armEmpty").classList.toggle("d-none", view.devices.length > 0);
    byId("armList").innerHTML = view.devices.map(function (d) { return deviceHtml(d, state.openDetail); }).join("");

    /* les accordéons ouverts mais dont le device/skill a disparu → nettoyés */
    var keys = Object.keys(state.openDetail);
    keys.forEach(function (k) {
      var parts = k.split(":");
      var found = view.devices.some(function (d) {
        return d.did === parts[0] && d.skills.some(function (s) { return s.skill === parts[1]; });
      });
      if (!found) delete state.openDetail[k];
    });

    var rec = byId("armRec");
    rec.disabled = !view.recEligible;
    rec.classList.toggle("btn-danger", view.recEligible);

    updateIncidentModal(view);
  }

  function updateIncidentModal(view) {
    var modal = byId("armIncidentModal");
    var open = modal.classList.contains("show");
    if (view.incidentsEmpty) {
      if (open) {
        modal.classList.remove("show");
        modal.setAttribute("aria-hidden", "true");
        console.log("SCREEN06_INCIDENT_AUTOCLOSE sessionId=" + (view.sid || "?"));
      }
      return;
    }
    if (!open) return;
    var html = view.incidents.map(function (inc) {
      var icon = SKILL_ICON[inc.skill] || "fa-circle";
      var cls = STATUS_CLASS[inc.skillStatus] || "arming";
      return '<div class="arm-incident"><span class="skill-state ' + cls + '" style="pointer-events:none;cursor:default"><i class="fa-solid ' + icon + '"></i></span>'
        + '<div class="flex-grow-1 arm-inc-line">'
        + '<div class="fw-semibold">' + esc(inc.deviceName) + '</div>'
        + '<div class="muted">' + esc(inc.message || statusLabel(inc.status)) + '</div>'
        + '</div></div>';
    }).join("");
    byId("armIncidentList").innerHTML = html;
    byId("armIncidentIntro").textContent = "Certains devices sont encore en armement, en alerte ou en erreur (" + view.incidents.length + " point(s)).";
  }

  function openIncidentModal() {
    var modal = byId("armIncidentModal");
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    render(global.MultiCamArmService.view());
  }

  function closeIncidentModal() {
    var modal = byId("armIncidentModal");
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;

    byId("backArm").addEventListener("click", function () {
      if (global.MultiCamArmService && global.MultiCamArmService.isActive()) {
        global.MultiCamArmService.cancel("back_to_take");
      }
      console.log("SCREEN06_BACK sessionId=" + state.sid);
      global.MultiCamNav.show("take", { sid: state.sid });
    });

    byId("armList").addEventListener("click", function (ev) {
      var btn = ev.target.closest ? ev.target.closest(".skill-state") : null;
      if (!btn) return;
      var key = btn.getAttribute("data-device") + ":" + btn.getAttribute("data-skill");
      var panel = document.querySelector('.arm-detail[data-detail="' + key + '"]');
      if (!panel) return;
      /* accordéon : un seul détail ouvert par device (aucun auto-open en incident) */
      var sameDevice = Object.keys(state.openDetail).filter(function (k) { return k.indexOf(btn.getAttribute("data-device") + ":") === 0; });
      var wasOpen = !!state.openDetail[key];
      sameDevice.forEach(function (k) {
        delete state.openDetail[k];
        var el = document.querySelector('.arm-detail[data-detail="' + k + '"]');
        if (el) el.classList.add("d-none");
      });
      if (!wasOpen) {
        state.openDetail[key] = true;
        panel.classList.remove("d-none");
      }
    });

    byId("armRec").addEventListener("click", function () {
      if (this.disabled) return;
      var v = global.MultiCamArmService.view();
      if (!v.incidentsEmpty) {
        console.log("SCREEN06_REC_INCIDENT sessionId=" + v.sid + " n=" + v.incidents.length);
        openIncidentModal();
        return;
      }
      console.log("REC_ELIGIBLE sessionId=" + v.sid + " take=" + v.takeNumber
        + " armCycleId=" + v.armCycleId + " eligible=1");
      console.log("REC_ELIGIBLE_NEXT_J08 sessionId=" + v.sid + " — enregistrement réel au jalon J08");
    });

    byId("armIncidentContinue").addEventListener("click", function () {
      var v = global.MultiCamArmService.view();
      console.log("REC_ELIGIBLE sessionId=" + v.sid + " take=" + v.takeNumber
        + " armCycleId=" + v.armCycleId + " via=incident_continue");
      console.log("REC_ELIGIBLE_NEXT_J08 sessionId=" + v.sid + " — enregistrement réel au jalon J08");
      closeIncidentModal();
    });
    byId("armIncidentCancel").addEventListener("click", closeIncidentModal);
    byId("armIncidentClose").addEventListener("click", closeIncidentModal);
    var ib = document.querySelector("#armIncidentModal .modal-backdrop");
    if (ib) ib.addEventListener("click", closeIncidentModal);
  }

  function show(cfg, params) {
    var sid = params.sid;
    if (!sid) {
      global.MultiCamNav.show("home");
      return;
    }
    byId("deviceNameArm").textContent = cfg.deviceName;
    state.sid = sid;
    bind();
    lastRev = -1;

    if (!global.MultiCamArmService) {
      console.log("SCREEN06_ERROR reason=service_unavailable sid=" + sid);
      return;
    }
    global.MultiCamArmService.onView(function () {
      render(global.MultiCamArmService.view());
    });
    global.MultiCamArmService.start(sid).then(function (view) {
      console.log("SCREEN06_OPEN sessionId=" + sid + " take=" + (view.takeNumber || "—")
        + " armCycleId=" + (view.armCycleId || "—") + " target=" + view.devices.length);
      render(view);
    }).catch(function (err) {
      console.log("SCREEN06_OPEN_FAIL sessionId=" + sid + " err=" + String((err && err.message) || err));
    });
  }

  global.MultiCamArmScreen = {
    show: show
  };
})(window);