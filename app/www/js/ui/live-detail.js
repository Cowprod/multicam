/* MultiCam — J09-06 : vue DÉTAILLÉE d'une Capture (modal du panneau 08).
 *
 * Un appui sur une vignette ouvre cette modal — pas un plein écran natif, pas une
 * seconde modal (README §2 de la maquette) : l'opérateur garde la mosaïque en
 * tête, ce qui est le but d'un écran de supervision.
 *
 * ---------- LECTURE SEULE, SANS EXCEPTION ----------
 *
 * J09-06 est une mission de SUPERVISION. Cette modal ne contient donc AUCUNE
 * commande : pas de réglage caméra, pas de changement de rôle, pas de STOP
 * distant, pas de transfert. Ces actions appartiennent à J10 et au panneau 05.
 * Le contrat expose `actions: []` explicite, pour qu'un test puisse vérifier
 * qu'aucune commande ne s'est glissée dans le futur : une modale de supervision
 * qui finit par agir devient un écran de contrôle, et c'est exactement ce que la
 * maquette refuse sur cet écran.
 *
 * ---------- CE QU'ELLE AFFICHE, ET OÙ ELLE LE PREND ----------
 *
 * `detailOf(slot, {nowMs})` est une FONCTION PURE, testable sans navigateur :
 * elle ne fait que mettre en forme ce que le modèle connaît de CETTE Capture.
 * Elle ne relit ni le réseau, ni la caméra, ni le store : si une information
 * n'est pas dans le slot, elle n'est pas inventée.
 *
 * Les quatre notions de fraîcheur sont TENUES SÉPARÉES, jamais fusionnées :
 *
 *   - `connected` / `state`  → liveness WS (la seule source qui ne peut pas être
 *     auto-déclarée par la Capture) ;
 *   - `telemetryAgeMs`       → âge du dernier snapshot MESURÉ ;
 *   - `preview.ageMs`        → âge de la dernière image REÇUE par le Master ;
 *   - `recorder`             → état de l'enregistreur, celui du modèle START/REC.
 *
 * Exemple qui compte : WS vivant + preview vieille de 4 s + télémétrie de 20 s
 * affiche REC, une image un peu datée et une donnée marquée ancienne — jamais
 * « Déconnecté », et jamais une image prétendument fraîche.
 */

"use strict";
(function (global) {

  var TELEMETRY_STALE_MS = 15000;
  var PREVIEW_STALE_MS = 5000;      /* 1 fps : au-delà de 5 s, l'image est datée */
  /* Mêmes seuils que la vignette, lus depuis la source unique
   * (`state/session-model.js`) — voir le commentaire détaillé là-bas. */
  var BATTERY_WARN = (global.MultiCamSessionModel && global.MultiCamSessionModel.BATTERY_WARN_PCT) || 25;
  var FREE_WARN = (global.MultiCamSessionModel && global.MultiCamSessionModel.FREE_WARN_BYTES) || 1000000000;

  var NET_LABEL = {
    wifi: "Wi-Fi",
    cellular: "Cellulaire",
    ethernet: "Ethernet",
    vpn: "VPN",
    other: "Autre",
    none: "Aucun réseau",
    unknown: null                      /* inconnu ≠ aucun réseau */
  };
  var NET_ICON = {
    wifi: "fa-wifi",
    cellular: "fa-signal",
    ethernet: "fa-ethernet",
    vpn: "fa-shield-halved",
    other: "fa-network-wired",
    none: "fa-plug-circle-xmark",
    unknown: "fa-circle-question"
  };

  var LABEL = {
    REC: "REC", STOPPED: "STOPPED", DECONNECTED: "Déconnecté",
    WARNING: "Avertissement", ERROR: "Erreur", UNKNOWN: "Inconnu"
  };
  var RECORDER_LABEL = { REC: "REC", STOPPED: "STOPPED", WARNING: "REC (avertissement)", ERROR: "REC (erreur)" };

  function byId(id) { return global.document ? global.document.getElementById(id) : null; }

  function fmtBytes(n) {
    if (typeof n !== "number" || !isFinite(n) || n < 0) return null;
    var units = ["o", "Ko", "Mo", "Go", "To"];
    var i = 0, v = n;
    while (v >= 1000 && i < units.length - 1) { v = v / 1000; i++; }
    var r = (v < 10 && i > 0) ? Math.round(v * 10) / 10 : Math.round(v);
    return (r + " " + units[i]);
  }

  function fmtAge(ms) {
    if (ms === null || ms === undefined) return "jamais";
    var s = Math.max(0, Math.round((ms || 0) / 1000));
    if (s < 60) return s + " s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + " min";
    return Math.floor(m / 60) + " h " + (m % 60) + " min";
  }

  function batteryIcon(pct) {
    if (pct <= 0) return "fa-battery-empty";
    if (pct <= BATTERY_WARN) return "fa-battery-quarter";
    if (pct <= 50) return "fa-battery-half";
    if (pct <= 80) return "fa-battery-three-quarters";
    return "fa-battery-full";
  }

  /* Les capacités viennent de la SONDE NATIVE de la Capture (J06), transportées
   * dans sa télémétrie. Elles disent ce qui EXISTE, pas ce qui a produit : un GPS
   * présent sur l'appareil mais non activé pour ce Take reste « non actif ». */
  function capabilitiesOf(t) {
    var c = (t && t.capabilities && typeof t.capabilities === "object") ? t.capabilities : null;
    if (!c || c.unknown) {
      return { known: false, video: false, audio: false, gps: false, model: "", manufacturer: "" };
    }
    var rear = (c.cameras && Array.isArray(c.cameras.rear)) ? c.cameras.rear : [];
    return {
      known: true,
      video: rear.length > 0,
      audio: c.audioMic === true,
      gps: c.gpsFeature === true,
      model: c.model || "",
      manufacturer: c.manufacturer || ""
    };
  }

  /* ---------- COUCHÉ PURE ---------- */

  function detailOf(slot, rec) {
    var s = slot || {};
    var now = (rec && typeof rec.nowMs === "number") ? rec.nowMs : Date.now();
    var t = s.telemetry || null;
    var connected = !!s.connected;
    var state = s.displayState || "UNKNOWN";
    var telemetryAt = s.telemetryAt || 0;
    var telemetryAgeMs = t ? Math.max(0, now - telemetryAt) : null;

    var b = (t && typeof t.batteryLevel === "number" && isFinite(t.batteryLevel)) ? t.batteryLevel : null;
    var f = (t && typeof t.freeBytes === "number" && isFinite(t.freeBytes) && t.freeBytes >= 0) ? t.freeBytes : null;
    var net = (t && typeof t.netType === "string" && t.netType) ? t.netType : null;
    var previewAt = s.lastFrameAt || 0;
    var previewAgeMs = previewAt ? Math.max(0, now - previewAt) : null;

    var incidents = [];
    if (state === "DECONNECTED") {
      incidents.push({
        key: "disconnected", tone: "danger",
        label: "Connexion perdue. Dernière preview conservée ; le REC local est "
          + "supposé continuer jusqu'à confirmation contraire."
      });
    }
    if (b !== null && b <= BATTERY_WARN) incidents.push({ key: "batteryLow", tone: "warn", label: "Batterie faible (" + b + " %)." });
    if (f !== null && f < FREE_WARN) incidents.push({ key: "storageLow", tone: "warn", label: "Stockage local sous le seuil de 1 Go (" + fmtBytes(f) + " libres)." });
    if (telemetryAgeMs !== null && telemetryAgeMs > TELEMETRY_STALE_MS) {
      incidents.push({ key: "telemetryStale", tone: "warn", label: "Données de supervision anciennes (" + fmtAge(telemetryAgeMs) + ")." });
    }

    /* Ce qui n'est PAS mesuré est dit comme tel — jamais remplacé par 0. */
    var notes = [];
    if (!t) notes.push("Aucune télémétrie reçue de cette Capture pour cette session.");
    else {
      if (b === null) notes.push("Batterie non mesurée par le device.");
      if (f === null) notes.push("Espace libre non mesuré (stockage SAF ?).");
      if (net === null) notes.push("Type de réseau inconnu.");
    }

    return {
      sessionId: s.sessionId || "",
      take: s.take || 0,
      deviceId: s.deviceId || "",
      deviceName: s.deviceName || s.deviceId || "",
      isLocal: !!s.isLocal,
      /* état de CONNEXION — jamais déduit de la télémétrie */
      connected: connected,
      state: state,
      stateLabel: LABEL[state] || state,
      /* état de l'ENREGISTREUR, mémorisé : c'est ce que la Capture faisait au
       * dernier signal, pas ce que le Master suppose maintenant. */
      recorder: RECORDER_LABEL[s.status] || (s.status || "—"),
      recorderFresh: connected,
      battery: {
        known: b !== null,
        value: b,
        charging: (t && typeof t.batteryCharging === "boolean") ? t.batteryCharging : null,
        icon: b !== null ? batteryIcon(b) : "fa-battery-half",
        text: b !== null ? (b + " %") : "—"
      },
      storage: {
        known: f !== null,
        value: f,
        total: (t && typeof t.totalBytes === "number" && t.totalBytes > 0) ? t.totalBytes : null,
        text: f !== null ? (fmtBytes(f) || "—") : "—",
        icon: "fa-hard-drive"
      },
      network: {
        known: net !== null && NET_LABEL[net] !== null,
        value: net,
        label: net === null ? "—" : (NET_LABEL[net] || net),
        icon: NET_ICON[net] || "fa-circle-question"
      },
      capabilities: capabilitiesOf(t),
      preview: {
        /* L'image est celle REÇUE par le Master (J09-04) : pour une Capture
         * déconnectée elle reste affichée, figée, en niveaux de gris. */
        has: !!s.lastFrame,
        seq: s.lastFrameSeq || 0,
        at: previewAt,
        ageMs: previewAgeMs,
        ageText: previewAgeMs === null ? "aucune preview" : (fmtAge(previewAgeMs) + (previewAgeMs > PREVIEW_STALE_MS ? " (datée)" : "")),
        frozen: !connected,
        src: (s.lastFrame && s.lastFrame.jpegBase64)
          ? ("data:image/jpeg;base64," + s.lastFrame.jpegBase64) : null
      },
      telemetryAgeMs: telemetryAgeMs,
      telemetryAgeText: telemetryAgeMs === null ? "—" : fmtAge(telemetryAgeMs),
      telemetryStale: telemetryAgeMs !== null && telemetryAgeMs > TELEMETRY_STALE_MS,
      incidents: incidents,
      notes: notes,
      /* Contractuel : vide en J09-06. Voir l'en-tête du module. */
      actions: []
    };
  }

  /* ---------- COUCHÉ DOM ---------- */

  var OPEN = { deviceId: null };

  function slotOf(deviceId) {
    var model = global.MultiCamLiveModel;
    if (!model || typeof model.view !== "function" || !deviceId) return null;
    var slots = model.view().slots || [];
    return slots.filter(function (s) { return s.deviceId === deviceId; })[0] || null;
  }

  function current() {
    if (!OPEN.deviceId) return null;
    var slot = slotOf(OPEN.deviceId);
    if (!slot) return null;
    return detailOf(slot, { nowMs: Date.now() });
  }

  function setText(id, text) {
    var n = byId(id);
    if (n && n.textContent !== text) n.textContent = text;
  }

  /* Les icônes de la modal : vidéo / audio / GPS quand elles sont RÉELLEMENT
   * annoncées par la Capture. Pas d'icône « cochée » sur une capacité
   * inconnue : l'absence se dit dans `notes`. */
  function paintSkills(d) {
    [["ldSkillVideo", d.capabilities.video], ["ldSkillAudio", d.capabilities.audio], ["ldSkillGps", d.capabilities.gps]]
      .forEach(function (pair) {
        var n = byId(pair[0]);
        if (!n) return;
        var on = !!pair[1];
        n.className = "modal-icon " + (on ? "on" : "off");
        n.title = !d.capabilities.known ? "Capacités non mesurées"
          : (on ? "Actif" : "Non actif pour ce Take");
      });
  }

  function paint(d) {
    if (!d) return null;
    setText("ldName", d.deviceName);
    var state = byId("ldState");
    if (state) {
      state.textContent = d.stateLabel;
      state.className = "tile-state " + (d.state === "DECONNECTED" ? "st-offline"
        : (d.state === "STOPPED" ? "st-stopped"
          : (d.state === "REC" ? "st-rec" : "st-warning")));
    }
    var rec = byId("ldRecorder");
    if (rec) {
      rec.textContent = d.recorder + (d.recorderFresh ? "" : " (dernier signal connu)");
      rec.className = "small muted";
    }
    var bat = byId("ldBattery");
    if (bat) {
      bat.textContent = "";
      bat.className = "";
      var bTxt = d.battery.known ? (d.battery.text + (d.battery.charging ? " · en charge" : "")) : "inconnue";
      bat.appendChild(mkIcon(d.battery.icon));
      bat.appendChild(textNode(" " + bTxt));
    }
    var sto = byId("ldStorage");
    if (sto) {
      sto.textContent = "";
      sto.appendChild(mkIcon("fa-hard-drive"));
      sto.appendChild(textNode(" " + (d.storage.known ? d.storage.text + " libres" : "inconnu")));
    }
    var net = byId("ldNetwork");
    if (net) {
      net.textContent = "";
      net.appendChild(mkIcon(d.network.icon));
      net.appendChild(textNode(" " + d.network.label));
    }
    setText("ldTelemetryAge", d.telemetryAgeText + (d.telemetryStale ? " · anciennes" : ""));
    setText("ldPreviewAge", d.preview.ageText);
    paintSkills(d);

    var img = byId("ldImage");
    var noimg = byId("ldNoImg");
    if (img) {
      var src = d.preview.src;
      if (src) {
        if (img.getAttribute("src") !== src) img.setAttribute("src", src);
      } else if (img.getAttribute("src")) {
        img.removeAttribute("src");
      }
      img.classList.toggle("frozen", !!d.preview.frozen);
    }
    /* Le cadre vide ne doit jamais se superposer à une image existante : sans
     * image, la Capture n'est PAS « en panne », elle n'a simplement rien
     * envoyé — le libellé le dit, et le cadre reste visible. */
    if (noimg) noimg.classList.toggle("d-none", !!(img && d.preview.src));

    var inc = byId("ldIncidents");
    if (inc) {
      inc.textContent = "";
      if (!d.incidents.length && !d.notes.length) {
        inc.appendChild(textNode("Aucun incident signalé."));
        inc.className = "incident-detail small rounded-3 p-2 bg-dark bg-opacity-50";
      } else {
        d.incidents.forEach(function (it) {
          var row = documentCreate("div", "small " + (it.tone === "danger" ? "text-danger" : "text-warning"));
          row.appendChild(mkIcon(it.key === "disconnected" ? "fa-link-slash"
            : (it.key.indexOf("battery") >= 0 ? "fa-battery-half" : (it.key.indexOf("storage") >= 0 ? "fa-hard-drive" : "fa-clock"))));
          row.appendChild(textNode(" " + it.label));
          inc.appendChild(row);
        });
        d.notes.forEach(function (n) {
          var row = documentCreate("div", "small muted");
          row.appendChild(mkIcon("fa-circle-info"));
          row.appendChild(textNode(" " + n));
          inc.appendChild(row);
        });
        inc.className = "incident-detail small rounded-3 p-2 bg-dark bg-opacity-50 d-flex flex-column gap-1";
      }
    }
    return d;
  }

  function documentCreate(tag, cls) {
    var e = global.document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }
  function mkIcon(cls) {
    var i = documentCreate("i", "fa-solid " + cls);
    return i;
  }
  function textNode(t) { return global.document.createTextNode(t); }

  /* Ouvre la modal sur CE device. Si la vignette n'existe plus (changement de
   * Take pendant l'appui), on ne montre rien plutôt qu'un détail vide. */
  function open(deviceId) {
    var d = current.call(null);
    OPEN.deviceId = deviceId;
    var slot = slotOf(deviceId);
    if (!slot) { close(); return null; }
    var view = detailOf(slot, { nowMs: Date.now() });
    bindClose();
    var modal = byId("liveDetailModal");
    if (modal) {
      /* `aria-hidden` + la classe `.show` : même convention que les autres
       * modales de l'app (`.screenmodal`), sans Bootstrap JS. */
      modal.classList.add("show");
      modal.setAttribute("aria-hidden", "false");
    }
    paint(view);
    return view;
  }

  function close() {
    OPEN.deviceId = null;
    var modal = byId("liveDetailModal");
    if (modal) {
      modal.classList.remove("show");
      modal.setAttribute("aria-hidden", "true");
    }
  }

  function isOpen() { return !!OPEN.deviceId; }

  /* Rafraîchissement pendant que la modal est ouverte : la mosaïque est rendue
   * à 5 Hz par le flux START, donc la modal suit le MÊME rythme (pas de second
   * setInterval). Fermer la modal ne change rien au REC. */
  function refresh() {
    if (!isOpen()) return null;
    var slot = slotOf(OPEN.deviceId);
    if (!slot) { close(); return null; }
    return paint(detailOf(slot, { nowMs: Date.now() }));
  }

  /* Fermeture : backdrop, croix, Échap. Même convention que les autres modales
   * de l'app (`.screenmodal` + `.modal-backdrop`, sans Bootstrap JS). Les
   * écouteurs sont posés une fois à l'ouverture de l'écran — pas à chaque
   * `open()`, sinon le même backdrop cumulerait N gestionnaires.
   *
   * Aucun autre bouton n'existe dans cette modal : il n'y a rien à câbler, et
   * c'est délibéré (J09-06 est de la supervision, pas du contrôle). */
  var BOUND = false;

  function bindClose() {
    if (BOUND) return;
    BOUND = true;
    var onClose = function () { close(); };
    var closeBtn = byId("ldClose");
    if (closeBtn && closeBtn.addEventListener) closeBtn.addEventListener("click", onClose);
    var backdrop = global.document && global.document.querySelector
      ? global.document.querySelector("#liveDetailModal .modal-backdrop")
      : null;
    if (backdrop && backdrop.addEventListener) backdrop.addEventListener("click", onClose);
    if (global.document && global.document.addEventListener) {
      global.document.addEventListener("keydown", function (ev) {
        if (!isOpen()) return;
        if (ev.key === "Escape" || ev.key === "Esc") onClose();
      });
    }
  }

  global.MultiCamLiveDetail = {
    bindClose: bindClose,
    detailOf: detailOf,
    open: open,
    close: close,
    isOpen: isOpen,
    refresh: refresh,
    clear: close,
    _state: OPEN
  };

})(window);