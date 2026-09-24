/* MultiCam — écran 05 (Préparer Take) + écran 06 (ARM, stub J07).
 * J06 — modèle du Take persistant, convergé entre Masters via session-ws
 * (TAKE_UPDATE / TELEMETRY_UPDATE), conforme maquette validée ui/05-take-preparation/
 * et décision MULTICAM_DECISIONS_REFERENCE §32 (best effort par Capture + warnings
 * vs réglages GLOBAUX, jamais réduction du global).
 *
 * Comportements :
 *  - premier Take auto-instancié (PREPARATION, aucune sélection) à l'ouverture si
 *    la session n'en a pas ; « + » crée le suivant en héritant (copie profonde).
 *  - Captures = membres avec sessionRole capture ; Storage = membres avec
 *    sessionRole storage. Une bascule de participation met à jour le Take via
 *    MultiCamSessionWs.upsertTake (LMW, partagé entre Masters).
 *  - Capacités par Capture : soi-même → probe natif (getCaptureCapabilities,
 *    patch applicatif) relayé en télémétrie ; autres Masters → leur télémétrie
 *    auto-déclarée. Capacité inconnue → honnête (capsUnknown), jamais inventée.
 *  - ARM : éligible dès ≥1 Capture (le Storage n'a AUCUN effet sur l'éligibilité),
 *    navigue vers l'écran 06 (stub J07).
 * Journalisation parsable : SCREEN05_* (take/settings/override/arm/telemetry).
 */

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

  function tm() {
    return global.MultiCamTakeModel || (global.MultiCamSessionModel && global.MultiCamSessionModel.takeModel) || null;
  }

  function ws() { return global.MultiCamSessionWs; }
  function store() { return global.MultiCamSessionStore; }

  function selfDid() {
    var mk = ws();
    return (mk && mk.status && mk.status().localDid) || "";
  }

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  /* 34 567 -> "34 567" ; Go/Mo pour un affichage lisible (mockup 05). */
  function fmtBytes(n) {
    if (!isNum(n) || n < 0) return "—";
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e11 ? 0 : 1) + " Go libres";
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + " Mo libres";
    return Math.round(n) + " o libres";
  }

  function pad3(n) { return String(n).padStart(3, "0"); }

  var state = {
    sid: null,
    session: null,
    take: null,
    capsCache: {},           /* soi-même : capacités prouvées (async, cache local) */
    ovrDevice: null,         /* did en cours d'édition dans la modal overrides */
    batteryLevel: null,
    freeBytes: null,
    freeAtMs: 0,
    lastPublish: 0
  };
  var bound = false;

  function closed() { return !state.session || state.session.state === "closed"; }

  function captureMembers(s) {
    return (s.members || []).filter(function (m) { return (m.sessionRoles || []).indexOf("capture") >= 0; });
  }
  function storageMembers(s) {
    return (s.members || []).filter(function (m) { return (m.sessionRoles || []).indexOf("storage") >= 0; });
  }

  function currentTake(s) {
    var arr = tm() ? tm().sanitizeTakes(s.takes || []) : (s.takes || []);
    return arr.length ? arr[arr.length - 1] : null;
  }

  function memberById(s, did) {
    var found = null;
    (s.members || []).forEach(function (m) { if (m.deviceId === did) found = m; });
    return found;
  }

  /* Capacités d'une Capture pour le rendu SYNCHRONE. Soi-même → cache local
   * (probe async re-rend quand résolu) ; un autre device → sa télémétrie
   * auto-déclarée (déjà normalisée). Sinon {unknown:true}. */
  function capsOf(did) {
    if (did === selfDid()) return state.capsCache[did] || { unknown: true, pending: true };
    var s = state.session;
    var m = s ? memberById(s, did) : null;
    if (m && m.telemetry && m.telemetry.capabilities) {
      return tm() ? tm().normalizeCapabilities(m.telemetry.capabilities) : m.telemetry.capabilities;
    }
    return { unknown: true };
  }

  function capsPending(did) {
    return did === selfDid() && !state.capsCache[did];
  }

  /* ---------- télémétrie auto-déclarée (batterie + espace + capacités) ---------- */

  function ensureFreeBytes() {
    if (typeof state.freeBytes === "number" && Date.now() - state.freeAtMs < 30000) {
      return Promise.resolve(state.freeBytes);
    }
    if (!global.MultiCamStorage || !global.MultiCamNative) return Promise.resolve(null);
    var cfg = global.MultiCamConfig ? global.MultiCamConfig.get() : null;
    if (cfg && cfg.storage && cfg.storage.mode === "saf") return Promise.resolve(null);
    try {
      var p = global.MultiCamStorage.systemPath(global.MultiCamStorage.defaultPath());
      return global.MultiCamNative.freeSpace(p).then(function (r) {
        state.freeBytes = (r && isNum(r.availableBytes)) ? r.availableBytes : null;
        state.freeAtMs = Date.now();
        return state.freeBytes;
      }).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  function publishSelfTelemetry(force) {
    var s = state.session;
    if (!s || s.state !== "open") return;
    var did = selfDid();
    if (!did) return;
    var isMember = (s.members || []).some(function (m) { return m.deviceId === did; });
    if (!isMember) return; /* pas encore membre → pas de télémétrie à déclarer */
    var now = Date.now();
    if (!force && now - state.lastPublish < 5000) return;
    var cap = global.MultiCamCaptureCapabilities;
    var capsP = cap ? cap.capabilitiesFor(did, s) : Promise.resolve({ unknown: true, probedAtMs: 0 });
    Promise.all([capsP, ensureFreeBytes()]).then(function (o) {
      var caps = o[0];
      if (caps && did === selfDid()) state.capsCache[did] = caps;
      if (!s || s.state !== "open") return;
      render();
      var telemetry = { capabilities: caps || { unknown: true } };
      if (typeof state.batteryLevel === "number") telemetry.batteryLevel = state.batteryLevel;
      if (typeof state.freeBytes === "number") telemetry.freeBytes = state.freeBytes;
      ws().updateMemberTelemetry(s, did, telemetry).then(function (upd) {
        state.session = upd;
        state.lastPublish = Date.now();
        console.log("SCREEN05_TELEMETRY_SENT did=" + did
          + " battery=" + (telemetry.batteryLevel == null ? "—" : telemetry.batteryLevel)
          + " free=" + (telemetry.freeBytes == null ? "—" : telemetry.freeBytes)
          + " capsKnown=" + (caps && !caps.unknown ? "1" : "0")
          + " capsUnknown=" + (caps && caps.unknown ? "1" : "0"));
      }).catch(function (err) {
        console.log("SCREEN05_TELEMETRY_SEND_FAIL did=" + did + " reason=" + String((err && err.message) || err));
      });
    });
  }

  function bindBattery() {
    if (bindBattery._done) return;
    bindBattery._done = true;
    if (!global.MultiCamDevice) return;
    global.MultiCamDevice.batteryStatus(function (b) {
      state.batteryLevel = Math.round(b.level || 0);
      publishSelfTelemetry(false);
    });
  }

  /* ---------- réglages (accordéon custom sans Bootstrap JS) ---------- */

  function toggleAcc(btn) {
    var body = btn && btn.parentElement ? btn.parentElement.querySelector(".tk-acc-body") : null;
    if (!body) return;
    var open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", open ? "false" : "true");
    body.style.display = open ? "none" : "block";
  }

  var SETTINGS_MAP = {
    "tk-resolution": "resolution",
    "tk-quality": "quality",
    "tk-camera": "camera",
    "tk-orientation": "orientation",
    "tk-audio": "audio",
    "tk-gps": "gpsProfile",
    "tk-countdown": "countdownSeconds"
  };

  function applySettingRadio(name, value) {
    var key = SETTINGS_MAP[name];
    if (!key || !state.take) return;
    var v = value;
    if (key === "audio") v = value === "true";
    if (key === "countdownSeconds") v = parseInt(value, 10);
    var updated = tm().setSetting(state.take, key, v, selfDid());
    if (updated && !tm().takesEqual(updated, state.take)) {
      commitTake(updated, "SETTING key=" + key + " val=" + JSON.stringify(v));
    }
  }

  function commitTake(updated, what) {
    ws().upsertTake(state.session, updated).then(function (upd) {
      console.log("SCREEN05_" + what + " take=" + updated.takeNumber);
      state.session = upd;
      state.take = currentTake(upd);
      render();
    }).catch(function (err) {
      console.log("SCREEN05_COMMIT_FAIL reason=" + String((err && err.message) || err));
      showToast("Modification impossible");
    });
  }

  /* ---------- rendu ---------- */

  function render() {
    var s = state.session;
    if (!s) return;
    var isClosed = closed();
    var take = currentTake(s);
    state.take = take;
    var did = selfDid();

    byId("tkTakeName").textContent = "Take " + (take ? pad3(take.takeNumber) : "—");
    byId("tkTakeBadge").textContent = take ? take.status : "—";
    byId("tkNew").disabled = isClosed || !take;

    var caps = captureMembers(s);
    renderCaptures(caps, take, isClosed, did);
    renderStorages(storageMembers(s), take, isClosed);
    renderSettings(take, isClosed);

    /* ARM : ≥1 Capture suffit (le Storage n'affecte que le transfert). */
    var arm = take && take.captures && take.captures.length >= 1;
    var armBtn = byId("tkArm");
    armBtn.disabled = isClosed || !arm;
    armBtn.classList.toggle("disabled", isClosed || !arm);
    armBtn.classList.toggle("disabled-arm", isClosed || !arm);
    byId("tkArmHint").textContent = isClosed
      ? "Session fermée."
      : (arm ? "Prêt. ARM lance l'écran d'armement (J07)." : "Sélectionne au moins une Capture.");
  }

  function telemetryLine(m) {
    if (!m.telemetry) return '<div class="small muted">télémétrie indisponible</div>';
    var parts = [];
    if (isNum(m.telemetry.batteryLevel)) {
      parts.push('<i class="fa-solid fa-battery-three-quarters me-1"></i>' + m.telemetry.batteryLevel + " %");
    }
    if (isNum(m.telemetry.freeBytes)) {
      parts.push('<i class="fa-solid fa-hard-drive me-1"></i>' + fmtBytes(m.telemetry.freeBytes));
    }
    if (!parts.length) return '<div class="small muted">télémétrie indisponible</div>';
    return '<div class="small muted">' + parts.join(" · ") + "</div>";
  }

  function iconBtn(cls, icon, warn, title) {
    return '<button class="device-icon tk-ico ' + cls + (warn ? " warning" : "") + '" type="button" data-ico="' + cls.split("-")[2] + '" title="' + esc(title || "") + '"><i class="fa-solid fa-' + icon + '"></i></button>';
  }

  function renderCaptures(caps, take, isClosed, did) {
    var el = byId("tkCaptures");
    if (!caps.length) {
      el.innerHTML = '<div class="empty-state">Aucun device avec le rôle Capture — ajoutez-en dans « Devices dans la session ».</div>';
      return;
    }
    el.innerHTML = caps.map(function (m) {
      var cid = m.deviceId;
      var selected = take && (take.captures || []).indexOf(cid) >= 0;
      var cap = capsOf(cid);
      var wr = take ? tm().warningsForCapture(take, cap, cid) : { warnings: [], capsUnknown: false };
      var warnVideo = !!(wr.capsUnknown) || wr.warnings.some(function (w) { return w.type === "video"; });
      var warnAudio = !!(wr.capsUnknown) || wr.warnings.some(function (w) { return w.type === "audio"; });
      var warnGps = !!(wr.capsUnknown) || wr.warnings.some(function (w) { return w.type === "gps"; });
      var warnMsgs = wr.warnings.map(function (w) { return w.message; });
      if (wr.capsUnknown) warnMsgs.push("Capacités inconnues (device hors télémétrie)");
      var warnBox = warnMsgs.length
        ? '<div class="warning-box warn mt-2 tk-warnbox" style="display:none">' + warnMsgs.map(function (x) { return "<div><i class=\"fa-solid fa-triangle-exclamation me-2\"></i>" + esc(x) + "</div>"; }).join("") + "</div>"
        : "";
      var isSelf = cid === did;
      var nameTxt = m.deviceName || cid;
      if (isSelf) nameTxt += " · cet appareil";
      var editBtn = '<button class="btn btn-sm btn-outline-light glass icon capture-edit" data-device="' + esc(cid) + '" type="button" aria-label="Overrides"' + (isClosed || !selected || cap.unknown ? " disabled" : "") + '><i class="fa-solid fa-pen"></i></button>';
      return '<article class="card glass rounded-4 capture-card" data-device="' + esc(cid) + '"><div class="card-body p-3 d-flex align-items-center gap-3">'
        + '<i class="fa-solid fa-camera fs-4"></i>'
        + '<div class="flex-grow-1"><div class="fw-semibold text-truncate">' + esc(nameTxt) + "</div>"
        + telemetryLine(m)
        + '<div class="device-icons mt-1">'
        + iconBtn("tk-ico-video", "video", warnVideo, warnMsgs.join(" · ") || "Vidéo conforme")
        + iconBtn("tk-ico-audio", "microphone", warnAudio, warnMsgs.join(" · ") || "Audio conforme")
        + iconBtn("tk-ico-gps", "location-dot", warnGps, warnMsgs.join(" · ") || "GPS conforme")
        + "</div></div>"
        + editBtn
        + '<div class="form-check form-switch m-0"><input class="form-check-input capture-switch" type="checkbox" data-device="' + esc(cid) + '"' + (selected ? " checked" : "") + (isClosed ? " disabled" : "") + "></div>"
        + "</div>" + warnBox + "</article>";
    }).join("");
  }

  function renderStorages(sts, take, isClosed) {
    var el = byId("tkStorages");
    if (!sts.length) {
      el.innerHTML = '<div class="empty-state">Aucun device avec le rôle Storage — les médias resteront sur les Captures.</div>';
    } else {
      el.innerHTML = sts.map(function (m) {
        var sid = m.deviceId;
        var selected = take && (take.storages || []).indexOf(sid) >= 0;
        var txt = m.deviceName || sid;
        var free = (m.telemetry && isNum(m.telemetry.freeBytes)) ? fmtBytes(m.telemetry.freeBytes) : null;
        return '<article class="card glass rounded-4"><div class="card-body p-3 d-flex align-items-center gap-3">'
          + '<i class="fa-solid fa-hard-drive fs-4"></i>'
          + '<div class="flex-grow-1"><div class="fw-semibold text-truncate">' + esc(txt) + "</div>"
          + '<div class="small muted">' + (free ? free : "espace libre indisponible") + "</div></div>"
          + '<div class="form-check form-switch m-0"><input class="form-check-input storage-switch" type="checkbox" data-device="' + esc(sid) + '"' + (selected ? " checked" : "") + (isClosed ? " disabled" : "") + "></div>"
          + "</div></article>";
      }).join("");
    }
    var any = take && take.storages && take.storages.length >= 1;
    byId("tkStorageWarning").classList.toggle("d-none", any);
    /* Transfert : actif uniquement si ≥1 Storage. Aucun Storage → replié + désactivé. */
    var trBtn = byId("tkAccTransferBtn");
    var trCard = byId("tkAccTransfer");
    var trBody = trCard ? trCard.querySelector(".tk-acc-body") : null;
    if (!any) {
      trBtn.disabled = true;
      if (trBody) trBody.style.display = "none";
      trBtn.setAttribute("aria-expanded", "false");
      trCard.classList.add("disabled-arm");
      byId("tkTransferSummary").textContent = "Aucun Storage";
    } else {
      trBtn.disabled = isClosed;
      trCard.classList.remove("disabled-arm");
      byId("tkTransferSummary").textContent = (take.settings.transferAuto ? "Auto" : "Manuel") + (take.settings.deleteLocalAfterVerifiedReplication ? " · suppression après réplication" : "");
    }
    byId("tkTransferAuto").disabled = isClosed || !any;
    byId("tkDeleteLocal").disabled = isClosed || !any;
  }

  function renderSettings(take, isClosed) {
    if (!take) return;
    var v = take.settings;
    setRadio("tk-resolution", v.video.resolution);
    setRadio("tk-quality", v.video.quality);
    setRadio("tk-camera", v.video.camera);
    setRadio("tk-orientation", v.video.orientation);
    setRadio("tk-audio", String(v.audio));
    setRadio("tk-gps", v.gpsProfile);
    setRadio("tk-countdown", String(v.countdownSeconds));
    byId("tkTransferAuto").checked = !!v.transferAuto;
    byId("tkDeleteLocal").checked = !!v.deleteLocalAfterVerifiedReplication;
    byId("tkVideoSummary").textContent = videoSummary(v.video);
    byId("tkAudioSummary").textContent = tm().labelsOf("audio", v.audio);
    byId("tkGpsSummary").textContent = tm().labelsOf("gps", v.gpsProfile);
    byId("tkCountdownSummary").textContent = (v.countdownSeconds === 0 ? "0" : String(v.countdownSeconds)) + " s";
    /* verrou édition quand session fermée */
    var inputs = byId("tkSettings").querySelectorAll("input, .tk-acc-btn");
    for (var i = 0; i < inputs.length; i++) inputs[i].disabled = isClosed;
  }

  function setRadio(name, value) {
    var el = document.querySelector('input[name="' + name + '"][value="' + value + '"]');
    if (el) el.checked = true;
  }

  function videoSummary(v) {
    return [tm().labelsOf("res", v.resolution), tm().labelsOf("quality", v.quality), tm().labelsOf("camera", v.camera), tm().labelsOf("orientation", v.orientation)].join(" · ");
  }

  /* ---------- modal overrides Capture (Hériter / personnaliser) ---------- */

  function capOptions() {
    var did = state.ovrDevice;
    var cap = capsOf(did);
    return cap && !cap.unknown ? cap : null;
  }

  function defIn(req, opts, ladder) {
    if (opts.indexOf(req) >= 0) return req;
    var b = ladder && req != null ? tm().bestEffort(req, opts, ladder) : null;
    return b || opts[0] || "";
  }

  function selectHtml(name, opts, current, ladder) {
    var sel = defIn(current, opts, ladder);
    return '<select class="form-select ' + name + '">' + opts.map(function (o) {
      return '<option value="' + o + '"' + (o === sel ? " selected" : "") + ">" + esc(tm().labelsOf("opt", o)) + "</option>";
    }).join("") + "</select>";
  }

  function overrideSectionHtml(key, title, icon, body, currentOwn) {
    return '<div class="ov-section" data-key="' + key + '">'
      + '<div class="ov-header"><div class="fw-semibold" style="font-size:.92rem"><i class="fa-solid ' + icon + ' me-2"></i>' + title + "</div>"
      + '<div class="form-check form-switch m-0"><input class="form-check-input tko-inherit" type="checkbox" id="tko-inherit-' + key + '"' + (currentOwn ? "" : " checked") + "></div>"
      + "</div><div class=\"ov-body\">"
      + (currentOwn ? "" : '<div class="small muted mb-2"><label class="form-check-label" for="tko-inherit-' + key + '">Hériter du réglage global</label></div>')
      + '<div class="ov-custom' + (currentOwn ? "" : " d-none") + '">' + body + "</div></div></div>";
  }

  function buildOverrides(device) {
    var did = device.deviceId;
    state.ovrDevice = did;
    var s = state.session;
    var take = currentTake(s);
    var caps = capsOf(did);
    var req = tm().requestedForCapture(take, caps, did);
    var eff = tm().effectiveForCapture(take, caps, did);
    var ov = (take.captureOverrides && take.captureOverrides[did]) || {};
    var ovVideo = ov.video || {};

    byId("tkoTitle").textContent = device.deviceName || did;
    byId("tkoMeta").textContent = (device.enabledSkills || []).join(" · ") + " · " + did;

    var note = '';
    if (!caps || caps.unknown) {
      note = '<div class="warning-box warn mb-2"><i class="fa-solid fa-triangle-exclamation me-2"></i>Capacités inconnues — réglage possible sans garantie de compatibilité.</div>';
    }

    var rear = caps && caps.cameras.rear.length ? caps.cameras.rear : [];
    var front = caps && caps.cameras.front.length ? caps.cameras.front : [];
    var resOpts = req.camera === "FRONT" && front.length ? front.slice()
      : (rear.length ? rear.slice() : (front.length ? front.slice() : tm().RESOLUTIONS.slice()));
    var camOpts = [];
    if (rear.length) camOpts.push("REAR");
    if (front.length) camOpts.push("FRONT");
    if (!camOpts.length) camOpts = tm().CAMERAS.slice();
    var oriOpts = caps && caps.orientationModes && caps.orientationModes.length
      ? caps.orientationModes.slice() : tm().ORIENTATIONS.slice();
    var audOpts = caps && caps.audioMic === false ? [false] : [true, false];
    var gpsOpts = caps && caps.gpsFeature === false ? ["OFF"] : tm().GPS_PROFILES.slice();

    var audioNote = caps && caps.audioMic === false
      ? '<div class="warning-box warn mt-2 tk-note"><i class="fa-solid fa-triangle-exclamation me-2"></i>Micro indisponible — Audio effective Désactivé.</div>' : "";
    var gpsNote = caps && caps.gpsFeature === false
      ? '<div class="warning-box warn mt-2 tk-note"><i class="fa-solid fa-triangle-exclamation me-2"></i>GPS indisponible — profil effectif Off.</div>' : "";

    var videoBody = '<label class="small muted">Résolution</label>' + selectHtml("ov-resolution", resOpts, ovVideo.resolution || req.resolution, tm().RESOLUTION_LADDER)
      + '<label class="small muted mt-2 d-block">Qualité</label>' + selectHtml("ov-quality", tm().QUALITIES.slice(), ovVideo.quality || req.quality)
      + '<label class="small muted mt-2 d-block">Caméra</label>' + selectHtml("ov-camera", camOpts, ovVideo.camera || req.camera)
      + '<label class="small muted mt-2 d-block">Orientation</label>' + selectHtml("ov-orientation", oriOpts, ovVideo.orientation || req.orientation)
      + '<div class="tk-note mt-2">Effectif : ' + esc(videoSummary(eff)) + (eff.fallback ? " (adaptation)" : "") + "</div>";

    var audioBody = '<label class="small muted">Audio</label>'
      + '<select class="form-select ov-audio">' + audOpts.map(function (o) {
        var cur = typeof ov.audio === "boolean" ? ov.audio : req.audio;
        return '<option value="' + o + '"' + (o === cur ? " selected" : "") + ">" + esc(tm().labelsOf("audio", o)) + "</option>";
      }).join("") + "</select>" + audioNote
      + '<div class="tk-note mt-2">Effectif : ' + esc(tm().labelsOf("audio", eff.audio)) + "</div>";

    var gpsBody = '<label class="small muted">GPS</label>'
      + '<select class="form-select ov-gps">' + gpsOpts.map(function (o) {
        var cur = ov.gpsProfile || req.gpsProfile;
        return '<option value="' + o + '"' + (o === cur ? " selected" : "") + ">" + esc(tm().labelsOf("gps", o)) + "</option>";
      }).join("") + "</select>" + gpsNote
      + '<div class="tk-note mt-2">Effectif : ' + esc(tm().labelsOf("gps", eff.gpsProfile)) + "</div>";

    byId("tkoSections").innerHTML = note
      + overrideSectionHtml("video", "Vidéo", "fa-video", videoBody, ov.video != null)
      + overrideSectionHtml("audio", "Audio", "fa-microphone", audioBody, typeof ov.audio === "boolean")
      + overrideSectionHtml("gpsProfile", "GPS", "fa-location-dot", gpsBody, ov.gpsProfile != null);
    byId("takeOverrideModal").classList.add("show");
    console.log("SCREEN05_OVERRIDE_OPEN did=" + did + " capsUnknown=" + (caps && caps.unknown ? "1" : "0"));
  }

  function closeOverrides() {
    byId("takeOverrideModal").classList.remove("show");
    state.ovrDevice = null;
  }

  function saveOverrides() {
    var did = state.ovrDevice;
    if (!did || !state.take) return;
    var t = state.take;
    ["video", "audio", "gpsProfile"].forEach(function (key) {
      var sec = document.querySelector('.ov-section[data-key="' + key + '"]');
      if (!sec) return;
      var inherit = sec.querySelector(".tko-inherit").checked;
      if (inherit) {
        t = tm().setOverride(t, did, key, null, selfDid());
      } else if (key === "video") {
        t = tm().setOverride(t, did, "video", {
          resolution: sec.querySelector(".ov-resolution").value,
          quality: sec.querySelector(".ov-quality").value,
          camera: sec.querySelector(".ov-camera").value,
          orientation: sec.querySelector(".ov-orientation").value
        }, selfDid());
      } else if (key === "audio") {
        t = tm().setOverride(t, did, "audio", sec.querySelector(".ov-audio").value === "true", selfDid());
      } else {
        t = tm().setOverride(t, did, "gpsProfile", sec.querySelector(".ov-gps").value, selfDid());
      }
    });
    closeOverrides();
    commitTake(t, "OVERRIDE did=" + did);
  }

  /* ---------- actions de sélection de groupe ---------- */

  function groupCaptures(dids) {
    if (!state.take) return;
    var updated = tm().setCaptures(state.take, dids, selfDid());
    commitTake(updated, "CAPTURE_GROUP dids=" + JSON.stringify(dids));
  }
  function toggleCapture(did, on) {
    if (!state.take) return;
    var updated = tm().setCapture(state.take, did, on, selfDid());
    commitTake(updated, "CAPTURE did=" + did + " on=" + on);
  }
  function groupStorages(dids) {
    if (!state.take) return;
    var updated = tm().setStorages(state.take, dids, selfDid());
    commitTake(updated, "STORAGE_GROUP dids=" + JSON.stringify(dids));
  }
  function toggleStorage(did, on) {
    if (!state.take) return;
    var updated = tm().setStorage(state.take, did, on, selfDid());
    commitTake(updated, "STORAGE did=" + did + " on=" + on);
  }

  /* ---------- bind ---------- */

  function bind() {
    if (bound) return;
    bound = true;
    bindBattery();

    byId("backTake").addEventListener("click", function () {
      global.MultiCamNav.show("session", { sid: state.sid });
    });
    byId("backArm").addEventListener("click", function () {
      global.MultiCamNav.show("take", { sid: state.sid });
    });
    byId("tkNew").addEventListener("click", function () {
      if (!state.take) return;
      if (!global.confirm("Créer le Take suivant en héritant du Take " + pad3(state.take.takeNumber) + " ?")) return;
      ws().newTake(state.session).then(function (r) {
        console.log("SCREEN05_TAKE_NEW sessionId=" + r.session.sessionId + " take=" + r.takeNumber);
        state.session = r.session;
        state.take = currentTake(r.session);
        render();
      }).catch(function (err) {
        console.log("SCREEN05_TAKE_NEW_FAIL reason=" + String((err && err.message) || err));
        showToast("Nouveau Take impossible");
      });
    });

    byId("tkCaptureAll").addEventListener("click", function () {
      groupCaptures(captureMembers(state.session).map(function (m) { return m.deviceId; }));
    });
    byId("tkCaptureNone").addEventListener("click", function () { groupCaptures([]); });
    byId("tkStorageAll").addEventListener("click", function () {
      groupStorages(storageMembers(state.session).map(function (m) { return m.deviceId; }));
    });
    byId("tkStorageNone").addEventListener("click", function () { groupStorages([]); });
    byId("tkArm").addEventListener("click", function () {
      if (this.disabled) return;
      console.log("SCREEN05_ARM_GO sessionId=" + state.sid + " take=" + (state.take ? state.take.takeNumber : "—"));
      global.MultiCamNav.show("arm", { sid: state.sid });
    });

    /* accordéon réglages */
    ["tkAccVideo", "tkAccAudio", "tkAccGps", "tkAccCountdown", "tkAccTransferBtn"].forEach(function (id) {
      var b = byId(id);
      if (b) b.addEventListener("click", function () { toggleAcc(this); });
    });

    document.addEventListener("change", function (ev) {
      var t = ev.target;
      if (!t || !t.name || t.name.indexOf("tk-") !== 0) {
        /* switches participants + transfert */
        if (t && t.id === "tkTransferAuto") {
          if (state.take) commitTake(tm().setSetting(state.take, "transferAuto", t.checked, selfDid()), "TRANSFER auto=" + t.checked);
          return;
        }
        if (t && t.id === "tkDeleteLocal") {
          if (state.take) commitTake(tm().setSetting(state.take, "deleteLocalAfterVerifiedReplication", t.checked, selfDid()), "DELETE_LOCAL=" + t.checked);
          return;
        }
        var sw = t && (t.classList.contains("capture-switch"));
        if (sw) { toggleCapture(t.getAttribute("data-device"), t.checked); return; }
        if (t && t.classList.contains("storage-switch")) { toggleStorage(t.getAttribute("data-device"), t.checked); return; }
        return;
      }
      applySettingRadio(t.name, t.value);
    });

    document.body.addEventListener("click", function (ev) {
      var edit = ev.target.closest ? ev.target.closest(".capture-edit") : null;
      if (edit) {
        var did = edit.getAttribute("data-device");
        var m = memberById(state.session, did);
        if (m) buildOverrides(m);
        return;
      }
      var ico = ev.target.closest ? ev.target.closest(".tk-ico") : null;
      if (ico) {
        var card = ico.closest ? ico.closest(".capture-card") : null;
        var wb = card ? card.querySelector(".tk-warnbox") : null;
        if (wb) wb.style.display = wb.style.display === "none" ? "block" : "none";
        return;
      }
      var iv = ev.target.closest ? ev.target.closest(".tko-inherit") : null;
      if (iv) {
        var sec = iv.closest ? iv.closest(".ov-section") : null;
        var custom = sec ? sec.querySelector(".ov-custom") : null;
        if (custom) custom.classList.toggle("d-none", iv.checked);
      }
    });

    byId("tkoClose").addEventListener("click", closeOverrides);
    byId("tkoCancel").addEventListener("click", closeOverrides);
    var tkoBackdrop = document.querySelector("#takeOverrideModal .modal-backdrop");
    if (tkoBackdrop) tkoBackdrop.addEventListener("click", closeOverrides);
    byId("tkoSave").addEventListener("click", saveOverrides);
  }

  /* ---------- show / arm / réactivité ---------- */

  function show(cfg, params) {
    var sid = params.sid;
    if (!sid) {
      global.MultiCamNav.show("home");
      return;
    }
    byId("deviceNameTake").textContent = cfg.deviceName;
    byId("deviceNameArm").textContent = cfg.deviceName;
    state.sid = sid;
    bind();

    store().get(sid).then(function (s) {
      if (!s) {
        console.log("SCREEN05_MISSING sessionId=" + sid + " → home");
        global.MultiCamNav.show("home");
        return;
      }
      state.session = s;
      state.take = currentTake(s);

      /* Premier Take : auto-instanciation à l'ouverture si la session n'en a
       * aucun (mockup : « Take 001 · PRÉPARATION » toujours affiché). */
      if (!state.take) {
        var first = tm().createFirstTake(selfDid());
        return ws().upsertTake(s, first).then(function (upd) {
          console.log("SCREEN05_TAKE_AUTO sessionId=" + sid + " take=1");
          state.session = upd;
          state.take = currentTake(upd);
          return afterShow();
        });
      }
      console.log("SCREEN05_OPEN sessionId=" + sid + " take=" + state.take.takeNumber);
      afterShow();
    });
  }

  function afterShow() {
    render();
    publishSelfTelemetry(true);
    if (state.session.state === "open") {
      global.MultiCamSessionWs.ensureServer().then(function () {
        global.MultiCamSessionWs.advertiseOpenSessions();
        global.MultiCamSessionWs.reSyncSession(state.session);
      }).catch(function (err) {
        console.log("SCREEN05_SERVER_ERROR err=" + String((err && err.message) || err));
      });
    }
  }

  function arm(cfg, params) {
    byId("deviceNameArm").textContent = cfg.deviceName;
    var t = currentTake(state.session);
    byId("armTakeName").textContent = "Take " + (t ? pad3(t.takeNumber) : "—") + " prêt";
    console.log("SCREEN06_ARM_STUB sessionId=" + state.sid + " take=" + (t ? t.takeNumber : "—"));
  }

  function ensureReactive(cfg) {
    if (ensureReactive._done) return;
    ensureReactive._done = true;
    global.MultiCamSessionWs.onChanged(function () {
      if (!state.sid) return;
      store().get(state.sid).then(function (s) {
        if (!s) return;
        var changed = !state.session || JSON.stringify(s) !== JSON.stringify(state.session);
        state.session = s;
        state.take = currentTake(s);
        if (changed) render();
        if (s.state === "open") {
          global.MultiCamSessionWs.advertiseOpenSessions();
          global.MultiCamSessionWs.reSyncSession(s);
        }
      });
    });
    /* Rafraîchissement périodique (batterie/espace + présence + convergence) et
     * republication télémétrie auto-déclarée (throttle dans publishSelfTelemetry). */
    setInterval(function () {
      if (state.session && state.session.state === "open") {
        render();
        publishSelfTelemetry(false);
      }
    }, 8000);
  }

  global.MultiCamTakeScreen = {
    show: function (cfg, params) { ensureReactive(cfg); show(cfg, params); },
    arm: arm
  };
})(window);