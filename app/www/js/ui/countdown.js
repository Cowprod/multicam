/* MultiCam — écran 07 "Countdown / START synchronisé" (J08) + placeholder 08.
 *
 * Rendu de la machine MultiCamStartService (start-service.js → start-model.js)
 * conformément à la maquette VALIDÉE ui/07-countdown. Invariants tenus ici :
 *   - countdown STRICTEMENT visuel : aucun son, aucune vibration, pas de bip ;
 *   - affichage 5→4→3→2→1 puis REC direct — le chiffre 0 n'est JAMAIS affiché
 *     (il vient de digitFor(), borné à [1..countdown]) ;
 *   - countdown = 0 s → l'écran 07 est ENTIÈREMENT sauté (SCREEN07_SKIPPED) ;
 *   - Master : nom de session, Take, chiffre géant, bouton Annuler. Rien
 *     d'autre — ni liste de Captures, ni état des autres devices, ni message de
 *     réintégration ;
 *   - Capture non-Master : RIEN sur les autres devices (ni peers, ni incidents,
 *     ni bouton Annuler global) ;
 *   - Capture écartée : grosse icône d'erreur + CAUSE, aucun bouton d'action ;
 *     si elle redevient READY avant le top, elle réintègre et l'affichage du
 *     temps restant reprend ;
 *   - perte de tous les Masters : le countdown continue, puis REC + STOP local
 *     d'urgence (avec confirmation) tant qu'aucun Master n'est là ;
 *   - Storage : PAS de vue plein écran — badge compact (countdown puis REC
 *     mm:ss), quel que soit l'écran courant.
 *
 * L'écran 08 est un PLACEHOLDER MINIMAL en J08 : état REC + timer + delta mesuré
 * + STOP local d'urgence. Le monitoring multi-device, le transfert et l'arrêt
 * global appartiennent à J09 et ne sont PAS simulés ici.
 *
 * Navigation : ce module n'initie PAS le changement de panneau tout seul. Il
 * expose route() ; main.js l'appelle sur chaque révision de la vue, depuis un
 * abonnement unique au service (décision 30.7 : le cycle de vie ne dépend pas de
 * l'écran affiché, donc l'arrivée d'un plan distant ouvre l'écran 07 même si
 * l'utilisateur est ailleurs).
 *
 * Journalisation parsable : SCREEN07_* et SCREEN08_* (les START_* / COUNTDOWN_*
 * sont émis par le modèle).
 */

(function (global) {
  "use strict";

  function byId(id) { return document.getElementById(id); }
  function svc() { return global.MultiCamStartService; }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function pad3(n) { return String(n).padStart(3, "0"); }

  /* mm:ss à partir d'un elapsed en ms. */
  function mmss(ms) {
    var s = Math.max(0, Math.floor((ms || 0) / 1000));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return (m < 10 ? "0" : "") + m + ":" + (r < 10 ? "0" : "") + r;
  }

  var state = { sid: null, bound: false, lastView: null, stopModalOpen: false, skipLogged: false, regieLogged: false };

  /* ---------- ligne d'état local (Capture uniquement) ---------- */

  /* États LOCAUX uniquement (UI 07). `local` est rempli par le service /
   * configuration ; toute valeur absente est omise plutôt qu'inventée. */
  function localStates() {
    var cfg = (global.MultiCamNav && global.MultiCamNav.cfg) ? global.MultiCamNav.cfg() : null;
    var out = [];
    function row(icon, label, value) {
      if (value === null || value === undefined || value === "") return;
      out.push('<div class="cd-row"><i class="fa-solid ' + icon + '"></i>'
        + '<span class="cd-row-label">' + esc(label) + '</span>'
        + '<span class="cd-row-val">' + esc(value) + '</span></div>');
    }
    if (cfg) {
      var skills = (cfg.enabledSkills || []).indexOf("capture") >= 0 ? "Capture" : "";
      var perms = (cfg.permissions || {});
      row("fa-video", "Rôle", skills);
      row("fa-microphone", "Audio", perms.recordAudio === false ? "Refusé" : (perms.recordAudio === true ? "Autorisé" : ""));
      row("fa-satellite-dish", "GPS", (cfg.gps && cfg.gps.profile) || "");
      row("fa-hard-drive", "Stockage", (cfg.storage && cfg.storage.mode) === "saf" ? "SAF" : "Interne");
    }
    var v = state.lastView || {};
    if (v.camera) {
      row("fa-camera", "Caméra", v.camera.prepared ? "Prête" : "Non préparée");
      row("fa-circle-check", "Top local", v.offsetKnown ? ("offset " + Math.round(v.offsetMs) + " ms") : "Offset inconnu");
    }
    return out.join("");
  }

  /* ---------- rendu ---------- */

  function showView(name) {
    ["cdMaster", "cdCapture", "cdExcluded", "cdRec"].forEach(function (id) {
      var el = byId(id);
      if (el) el.classList.toggle("d-none", id !== name);
    });
  }

  function renderMaster(v) {
    byId("cdSession").textContent = v.sessionName || "—";
    byId("cdTake").textContent = v.takeNumber ? "Take " + pad3(v.takeNumber) : "—";
    byId("cdDigitMaster").textContent = String(v.digit || v.countdownSeconds || 0);
    /* Indicateur d'attente STRICTEMENT local (notre propre horloge) : le
     * Master n'apprend rien des états des autres devices pendant le countdown
     * (UI 07) — pas de liste de Captures, pas d'incident de pair, pas de
     * message de réintégration. */
    byId("cdWaitMaster").textContent = v.countdownResolved ? "" : "Synchronisation d'horloge…";
    showView("cdMaster");
  }

  function renderCapture(v) {
    byId("cdSessionCap").textContent = v.sessionName || "—";
    byId("cdTakeCap").textContent = v.takeNumber ? "Take " + pad3(v.takeNumber) : "—";
    var cfg = (global.MultiCamNav && global.MultiCamNav.cfg) ? global.MultiCamNav.cfg() : null;
    byId("cdDeviceCap").textContent = (cfg && cfg.deviceName) || "—";
    byId("cdDigitCap").textContent = String(v.digit || v.countdownSeconds || 0);
    byId("cdLocalCap").innerHTML = localStates();
    showView("cdCapture");
  }

  function renderExcluded(v) {
    byId("cdExclCause").textContent = v.excludeMessage || "indisponible";
    showView("cdExcluded");
  }

  function renderRec(v) {
    byId("cdRecSession").textContent = v.sessionName || "—";
    byId("cdRecTake").textContent = v.takeNumber ? "Take " + pad3(v.takeNumber) : "—";
    byId("cdRecTimer").textContent = mmss(v.recElapsedMs);
    var d = v.lastStart;
    if (d && typeof d.deltaMs === "number") {
      var txt = "Top local : " + (d.deltaMs >= 0 ? "+" : "") + Math.round(d.deltaMs) + " ms";
      if (d.ackMs && typeof d.ackDeltaMs === "number") {
        txt += " · accusé natif : " + (d.ackDeltaMs >= 0 ? "+" : "") + Math.round(d.ackDeltaMs) + " ms";
      }
      byId("cdRecDelta").textContent = txt;
    } else {
      byId("cdRecDelta").textContent = "—";
    }
    var emg = byId("cdEmergency");
    if (emg) emg.classList.toggle("d-none", !v.showEmergencyStop);
    showView("cdRec");
  }

  /* Badge compact : Storage (et tout device qui ne doit pas quitter son écran). */
  function renderBadge(v) {
    var el = byId("recBadge");
    if (!el) return;
    var show = !!v.active && v.isStorage && !v.isCapture && !v.isMaster;
    el.classList.toggle("d-none", !show);
    if (!show) return;
    byId("recBadgeTake").textContent = "Take " + pad3(v.takeNumber);
    if (v.phase === "REC") {
      el.classList.add("rec");
      byId("recBadgeVal").textContent = "REC " + mmss(v.recElapsedMs);
    } else if (v.phase === "EXCLUDED") {
      el.classList.remove("rec");
      byId("recBadgeVal").textContent = "écartée";
    } else {
      el.classList.remove("rec");
      byId("recBadgeVal").textContent = "countdown " + (v.digit || v.countdownSeconds || 0);
    }
  }

  function render(v) {
    if (!v) return;
    state.lastView = v;
    /* Le rendu est volontairement simple et idempotent : il reconstruit la vue
     * courante à chaque révision. Le coût est négligeable (une dizaine de
     * noeuds) et cela garantit qu'un compteur (timer REC) ou un digit ne peut
     * pas rester figé après un retour de phase. */
    renderBadge(v);
    if (!v.active) { showView(null); return; }  /* aucun plan : panneau vide */
    var isFull = v.isMaster || v.isCapture;      /* le Storage garde son écran */
    if (!isFull) { showView(null); return; }     /* AUCUNE vue de plein écran */
    if (v.phase === "EXCLUDED" && v.isCapture) { renderExcluded(v); return; }
    if (v.phase === "REC") { renderRec(v); return; }
    if (v.phase !== "COUNTDOWN") { showView(null); return; }  /* IDLE / STOPPED */
    if (v.isCapture && !v.isMaster) { renderCapture(v); return; }
    renderMaster(v);
  }

  /* ---------- routeur (appelé par main.js) ---------- */

  /* Renvoie le nom de panneau à afficher, ou "" pour rester où l'on est. */
  /* J09-05 : la mosaïque (écran 08) est un écran de RÉGIE. Décider « qui voit les
   * previews des autres » à partir du seul `isMaster` du modèle START serait
   * FAUX : une Capture qui rejoint une session par son PIN est enregistrée dans
   * `session.masters` (upsertMaster, §J09-04) et ressort donc `isMaster=1`.
   *
   * On exige donc un FAIT LOCAL et non ambigu : la skill « controller » ACTIVE.
   * Un device qui sait régir est un Master par construction du modèle de rôles
   * (J03), qu'il soit ou non aussi Capture — c'est ce qui donne le cas
   * Master+Capture, où la mosaïque doit afficher sa propre vignette locale.
   *
   * Ce n'est PAS une correction du modèle START (hors périmètre de J09-05,
   * décision à remonter) : c'est une règle de routage d'écran, journalisée pour
   * qu'une classification litigieuse reste visible dans les logs. */
  function isRegie(v) {
    if (!v || !v.isMaster) return false;
    var cfgm = global.MultiCamConfig;
    if (cfgm && typeof cfgm.isControllerEnabled === "function") {
      return cfgm.isControllerEnabled() === true;
    }
    return true;   /* module indisponible : on retombe sur le rôle START */
  }

  function route(v) {
    if (!v || !v.active) return "";
    var isFull = v.isMaster || v.isCapture;         /* le Storage garde son écran */
    if (!isFull) return "";
    if (v.phase === "COUNTDOWN") {
      if (v.countdownSeconds > 0 && !v.excluded) return "countdown";
      /* countdown 0 s : écran 07 ENTIÈREMENT sauté (UI 07) */
      if (v.countdownSeconds === 0 && !state.skipLogged) {
        state.skipLogged = true;
        console.log("SCREEN07_SKIPPED sessionId=" + (v.sid || "—") + " take=" + v.takeNumber
          + " reason=countdown_0 leadMs=300");
      }
      return "";
    }
    if (v.phase === "EXCLUDED") return "countdown";   /* 07 : erreur + cause */
    if (v.phase === "REC") {
      /* Capture : AUCUNE vue sur les autres devices (invariant UI 07/08) —
       * elle reste sur le placeholder 08 du panneau 07, inchangé. */
      if (isRegie(v)) {
        if (!state.regieLogged) {
          state.regieLogged = true;
          console.log("SCREEN08_ROUTE decision=regie sessionId=" + (v.sid || "—")
            + " take=" + v.takeNumber + " isMaster=" + (v.isMaster ? 1 : 0)
            + " isCapture=" + (v.isCapture ? 1 : 0)
            + " rule=isMaster_AND_controller_skill");
        }
        return "live";
      }
      return "countdown";
    }
    return "";
  }

  /* ---------- modale STOP local ---------- */

  function openStopModal() {
    var m = byId("cdStopModal");
    if (!m) return;
    state.stopModalOpen = true;
    m.classList.add("show");
    m.setAttribute("aria-hidden", "false");
    console.log("SCREEN08_STOP_CONFIRM_OPEN sessionId=" + (state.sid || "—"));
  }

  function closeStopModal() {
    var m = byId("cdStopModal");
    if (!m) return;
    state.stopModalOpen = false;
    m.classList.remove("show");
    m.setAttribute("aria-hidden", "true");
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;

    var cancel = byId("cdCancel");
    if (cancel) cancel.addEventListener("click", function () {
      console.log("SCREEN07_CANCEL_CLICK sessionId=" + (state.sid || "—"));
      Promise.resolve(svc().cancel("master_cancel")).catch(function (err) {
        console.log("SCREEN07_CANCEL_KO err=" + String((err && err.message) || err));
      });
    });

    var emg = byId("cdEmergency");
    if (emg) emg.addEventListener("click", openStopModal);

    var confirm = byId("cdStopConfirm");
    if (confirm) confirm.addEventListener("click", function () {
      console.log("SCREEN08_STOP_CONFIRMED sessionId=" + (state.sid || "—"));
      closeStopModal();
      Promise.resolve(svc().stopLocal("emergency_no_master")).catch(function (err) {
        console.log("SCREEN08_STOP_KO err=" + String((err && err.message) || err));
      });
    });

    var cancelStop = byId("cdStopCancel");
    if (cancelStop) cancelStop.addEventListener("click", function () {
      console.log("SCREEN08_STOP_CANCELLED sessionId=" + (state.sid || "—"));
      closeStopModal();
    });
    var backdrop = document.querySelector("#cdStopModal .modal-backdrop");
    if (backdrop) backdrop.addEventListener("click", closeStopModal);
  }

  function show(cfg, params) {
    params = params || {};
    var sid = params.sid || state.sid;
    state.sid = sid;
    state.lastRev = -1;
    state.regieLogged = false;
    bind();
    if (cfg) {
      var lbl = byId("cdDeviceCap");
      if (lbl) lbl.textContent = cfg.deviceName || "—";
    }
    if (!svc()) {
      console.log("SCREEN07_ERROR reason=service_unavailable sid=" + (sid || "—"));
      return Promise.resolve(null);
    }
    return Promise.resolve(svc().start(sid)).then(function (v) {
      render(v);
      console.log("SCREEN07_OPEN sessionId=" + (sid || "—")
        + " phase=" + (v && v.phase) + " isMaster=" + (v && v.isMaster ? 1 : 0)
        + " isCapture=" + (v && v.isCapture ? 1 : 0) + " isStorage=" + (v && v.isStorage ? 1 : 0)
        + " countdown=" + (v && v.countdownSeconds));
      return v;
    }).catch(function (err) {
      console.log("SCREEN07_OPEN_FAIL sessionId=" + (sid || "—") + " err=" + String((err && err.message) || err));
    });
  }

  /* Le panneau 07 sert aussi de contenant au placeholder 08 : un seul panneau,
   * quatre vues, pour éviter un second aller-retour de routeur au top. */
  global.MultiCamCountdownScreen = {
    show: show,
    render: render,
    route: route,
    openStopModal: openStopModal,
    view: function () { return state.lastView; }
  };
})(window);
