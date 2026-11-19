/* Pre-session preview UI: consumes only real JPEG frames from a discovery service.
 * No synthetic imagery and no session/REC side effects. */
(function (global) {
  "use strict";
  var peers = Object.create(null), devices = Object.create(null), bound = false;
  var MAX_AGE_MS = 5000;
  function safeId(id) { return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_"); }
  /* Shared inbox is the only frame store, including the full-size detail. */
  function live(did) {
    var inbox = global.MultiCamPreviewInbox;
    if (!inbox || !inbox.view || !inbox.latest) return null;
    /* Discovery tiles consume only the discovery namespace. Session/REC
     * frames belong to their own consumers and must not replace this feed. */
    var best = inbox.latest("__discovery__", did);
    return best && Date.now() - best.receivedAt < MAX_AGE_MS ? best : null;
  }
  function telemetry(did) {
    var screen = global.MultiCamSessionScreen;
    var discovery = global.MultiCamDiscoveryTelemetry;
    var latest = discovery && discovery.get ? discovery.get(did) : null;
    return latest || (screen && screen.telemetryForDevice ? screen.telemetryForDevice(did) : null);
  }
  function pct(n) { return Math.max(0, Math.min(100, Math.round(n))); }
  function batteryIcon(level, charging) {
    if (charging) return "fa-battery-full";
    if (level <= 10) return "fa-battery-empty";
    if (level <= 35) return "fa-battery-quarter";
    if (level <= 60) return "fa-battery-half";
    if (level <= 85) return "fa-battery-three-quarters";
    return "fa-battery-full";
  }
  function updateGauges(el, did) {
    var t = telemetry(did), host = el.querySelector(".discovery-health");
    var v = global.MultiCamDeviceMedia.project({deviceId: did, telemetry: t, hasCamera: !!peers[did], connected: !!devices[did]});
    if (!host) return;
    var battery = v.batteryLevel;
    var disk = v.freePercent;
    var key = String(battery) + "/" + String(disk) + "/" + !!(t && t.batteryCharging);
    if (host.getAttribute("data-health") === key) return;
    host.setAttribute("data-health", key);
    host.innerHTML = (battery === null ? "" : '<span title="Batterie : ' + battery + '%" class="discovery-health-item"><i class="fa-solid fa-battery-half"></i> ' + battery + '%<b class="discovery-health-bar"><i style="width:' + battery + '%"></i></b></span>')
      + (disk === null ? "" : '<span title="Stockage libre : ' + disk + '%" class="discovery-health-item"><i class="fa-solid fa-hard-drive"></i> ' + disk + '%<b class="discovery-health-bar"><i style="width:' + disk + '%"></i></b></span>');
  }
  function cardMarkup(did) {
    return '<button type="button" class="discovery-preview tile-media border-0 p-0 overflow-hidden position-relative" ' +
      'data-preview-did="' + safeId(did) + '" aria-label="Détails de l’appareil" ' +
      'style="width:100%;aspect-ratio:16/9;background:#111827;color:white">' +
      '<img alt="" style="width:100%;height:100%;object-fit:contain;display:none">' +
      '<span class="discovery-preview-status small">En attente du flux</span>' +
      '<span class="discovery-health" aria-label="Batterie et stockage"></span></button>';
  }
  function paint() {
    document.querySelectorAll(".discovery-preview").forEach(function (el) {
      var did = el.getAttribute("data-preview-did");
      var v = global.MultiCamDeviceMedia.project({deviceId: did, frame: live(did), telemetry: telemetry(did), hasCamera: !!peers[did], connected: !!devices[did]});
      var f = v.image;
      updateGauges(el, did);
      var img = el.querySelector("img"), label = el.querySelector("span");
      if (f) {
        if (img.getAttribute("data-seq") !== String(f.seq)) {
          img.src = "data:image/jpeg;base64," + f.jpegBase64;
          img.setAttribute("data-seq", String(f.seq));
        }
        img.style.display = "block";
        label.style.display = "none";
      } else {
        img.removeAttribute("src");
        img.removeAttribute("data-seq");
        img.style.display = "none";
        label.style.display = "block";
        label.textContent = global.MultiCamDeviceMedia.statusLabel(v);
      }
    });
    if (global.MultiCamLiveDetail && global.MultiCamLiveDetail.isOpen()) global.MultiCamLiveDetail.refresh();
  }
  function refresh(list) {
    var next = Object.create(null), all = Object.create(null);
    (list || []).forEach(function (p) {
      if (!p || !p.deviceId) return;
      all[safeId(p.deviceId)] = true;
      if ((p.enabledSkills || []).indexOf("capture") >= 0) next[safeId(p.deviceId)] = true;
    });
    peers = next;
    devices = all;
    paint();
  }
  function bind() {
    if (bound) return;
    bound = true;
    document.addEventListener("click", function (ev) {
      var btn = ev.target.closest && ev.target.closest("[data-preview-did]");
      if (!btn) return;
      var did = btn.getAttribute("data-preview-did");
      if (!devices[did]) return;
      var peer = global.MultiCamNet && global.MultiCamNet.peers().filter(function (p) {
        return safeId(p.deviceId) === did;
      })[0];
      if (peer && global.MultiCamLiveDetail && global.MultiCamLiveDetail.openDiscovered)
        global.MultiCamLiveDetail.openDiscovered(peer, live);
    });
    if (global.MultiCamPreviewInbox && global.MultiCamPreviewInbox.onFrame)
      global.MultiCamPreviewInbox.onFrame(paint);
    /* Poll only visible Capture peers. The existing WS stack owns sockets,
     * and the existing sampler owns camera capture. */
    var pending = Object.create(null);
    function visibleDiscoveryTiles() {
      var ids = Object.create(null);
      document.querySelectorAll("[data-preview-did]").forEach(function (el) {
        var n = el, active = false;
        while (n && n !== document.body) {
          if (n.classList && n.classList.contains("screen")) {
            active = n.classList.contains("active");
            break;
          }
          n = n.parentNode;
        }
        if (active) ids[el.getAttribute("data-preview-did")] = true;
      });
      return ids;
    }
    function requestFrames() {
      if (document.hidden) return;
      /* The REC screen uses its existing session transport; never run the
       * discovery poller there. Session/home tiles share this one poller. */
      var visible = visibleDiscoveryTiles();
      if (!Object.keys(visible).length) return;
      var ws = global.MultiCamSessionWs;
      if (!ws || !ws.requestDiscoveryPreview) return;
      var list = global.MultiCamNet && global.MultiCamNet.peers ? global.MultiCamNet.peers() : [];
      list.forEach(function (p) {
        var did = safeId(p.deviceId);
        if (!devices[did] || !visible[did] || pending[did]) return;
        var ep = p.wsEndpoint || "";
        var match = /^(?:ws:\/\/)?([^:/]+):(\d+)$/.exec(ep);
        if (!match) return;
        pending[did] = true;
        Promise.resolve(ws.requestDiscoveryPreview(match[1], Number(match[2]), p.deviceId))
          .catch(function () {}).then(function () { delete pending[did]; });
      });
    }
    setInterval(function () { paint(); requestFrames(); }, 1500);
    requestFrames();
  }
  global.MultiCamDiscoveryPreviewUI = { bind: bind, refresh: refresh, cardMarkup: cardMarkup };
})(window);
