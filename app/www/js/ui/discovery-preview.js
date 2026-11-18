/* Pre-session preview UI: consumes only real JPEG frames from a discovery service.
 * No synthetic imagery and no session/REC side effects. */
(function (global) {
  "use strict";
  var frames = Object.create(null), peers = Object.create(null), bound = false;
  var MAX_AGE_MS = 4000, MAX_JPEG_B64 = 350000;
  function safeId(id) { return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_"); }
  function live(did) {
    var f = frames[did];
    return f && Date.now() - f.at < MAX_AGE_MS ? f : null;
  }
  function cardMarkup(did) {
    return '<button type="button" class="discovery-preview border-0 p-0 rounded-3 overflow-hidden position-relative" ' +
      'data-preview-did="' + safeId(did) + '" aria-label="Agrandir la caméra" ' +
      'style="width:144px;min-width:144px;aspect-ratio:16/9;background:#111827;color:white">' +
      '<img alt="" style="width:100%;height:100%;object-fit:contain;display:none">' +
      '<span class="discovery-preview-status small">En attente du flux</span></button>';
  }
  function paint() {
    document.querySelectorAll(".discovery-preview").forEach(function (el) {
      var did = el.getAttribute("data-preview-did"), f = live(did);
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
        label.textContent = peers[did] ? "En attente du flux" : "Hors ligne";
      }
    });
    if (global.MultiCamLiveDetail && global.MultiCamLiveDetail.isOpen()) global.MultiCamLiveDetail.refresh();
  }
  function refresh(list) {
    var next = Object.create(null);
    (list || []).forEach(function (p) {
      if (p && p.deviceId && (p.enabledSkills || []).indexOf("capture") >= 0)
        next[safeId(p.deviceId)] = true;
    });
    peers = next;
    Object.keys(frames).forEach(function (id) { if (!peers[id]) delete frames[id]; });
    paint();
  }
  function onFrame(frame) {
    if (!frame || frame.mime !== "image/jpeg" || typeof frame.jpegBase64 !== "string" ||
        !frame.jpegBase64.length || frame.jpegBase64.length > MAX_JPEG_B64 ||
        !Number.isFinite(frame.seq)) return false;
    var did = safeId(frame.deviceId);
    if (!peers[did]) return false;
    var prev = frames[did];
    if (prev && frame.seq <= prev.seq && Date.now() - prev.at < MAX_AGE_MS) return false;
    frames[did] = { jpegBase64: frame.jpegBase64, seq: frame.seq, at: Date.now() };
    paint();
    return true;
  }
  function bind() {
    if (bound) return;
    bound = true;
    document.addEventListener("click", function (ev) {
      var btn = ev.target.closest && ev.target.closest("[data-preview-did]");
      if (!btn) return;
      var did = btn.getAttribute("data-preview-did");
      if (!peers[did]) return;
      var peer = global.MultiCamNet && global.MultiCamNet.peers().filter(function (p) {
        return safeId(p.deviceId) === did;
      })[0];
      if (peer && global.MultiCamLiveDetail && global.MultiCamLiveDetail.openDiscovered)
        global.MultiCamLiveDetail.openDiscovered(peer, live);
    });
    setInterval(paint, 1000);
  }
  global.MultiCamDiscoveryPreviewUI = { bind: bind, refresh: refresh, cardMarkup: cardMarkup, onFrame: onFrame };
})(window);
