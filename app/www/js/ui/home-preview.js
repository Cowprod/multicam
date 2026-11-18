/* UI des JPEG de decouverte: pas de session, pas de video et jamais de fake.
 * La meme frame acceptee alimente vignette ET plein ecran en direct. */
(function (global) {
  "use strict";
  var S = { bound: false, current: "", seen: {}, modalSeq: 0 };
  function byId(id) { return global.document.getElementById(id); }
  function svc() { return global.MultiCamDiscoveryPreviewService; }
  function currentHome() {
    var panel = byId("panel-home");
    return !!(panel && panel.classList.contains("active"));
  }
  function close() {
    S.current = ""; S.modalSeq = 0;
    var modal = byId("discoveryPreviewModal");
    if (modal) modal.classList.add("d-none");
    var img = byId("discoveryPreviewLarge");
    if (img) img.removeAttribute("src");
  }
  function paintLarge() {
    if (!S.current) return;
    var m = byId("discoveryPreviewModal"), img = byId("discoveryPreviewLarge");
    var msg = byId("discoveryPreviewMessage"), title = byId("discoveryPreviewTitle");
    if (!m || !img || !msg || !currentHome()) { close(); return; }
    var peer = global.MultiCamNet && global.MultiCamNet.peers
      ? global.MultiCamNet.peers().filter(function (p) { return p.deviceId === S.current; })[0] : null;
    if (!peer) { close(); return; }
    title.textContent = peer.name || peer.deviceId;
    var frame = svc() && svc().latest ? svc().latest(S.current) : null;
    if (!frame) {
      img.classList.add("d-none");
      img.removeAttribute("src");
      msg.textContent = "Preview indisponible ou perimee";
      msg.classList.remove("d-none");
      S.modalSeq = 0;
    } else {
      if (S.modalSeq !== frame.seq) {
        img.src = "data:image/jpeg;base64," + frame.jpegBase64;
        S.modalSeq = frame.seq;
      }
      img.classList.remove("d-none");
      msg.classList.add("d-none");
    }
  }
  function refresh() {
    if (!currentHome()) { close(); return; }
    var list = byId("devicesList");
    if (!list || !list.querySelectorAll) return;
    var nodes = list.querySelectorAll("[data-discovery-preview]");
    Array.prototype.forEach.call(nodes, function (btn) {
      var did = btn.getAttribute("data-discovery-preview");
      var frame = svc() && svc().latest ? svc().latest(did) : null;
      var img = btn.querySelector("img");
      var wait = btn.querySelector(".discovery-preview-wait");
      btn.disabled = !frame;
      if (!img || !wait) return;
      if (frame) {
        if (img.getAttribute("data-seq") !== String(frame.seq)) {
          img.src = "data:image/jpeg;base64," + frame.jpegBase64;
          img.setAttribute("data-seq", String(frame.seq));
        }
        img.classList.remove("d-none");
        wait.classList.add("d-none");
      } else {
        img.removeAttribute("src");
        img.removeAttribute("data-seq");
        img.classList.add("d-none");
        wait.classList.remove("d-none");
      }
    });
    paintLarge();
  }
  function open(did) {
    if (!currentHome() || !svc() || !svc().latest(did)) return false;
    S.current = did; S.modalSeq = 0;
    var modal = byId("discoveryPreviewModal");
    if (!modal) return false;
    modal.classList.remove("d-none");
    paintLarge();
    return true;
  }
  function bind() {
    if (S.bound) return;
    S.bound = true;
    var list = byId("devicesList"), back = byId("discoveryPreviewBack");
    if (list) list.addEventListener("click", function (ev) {
      var node = ev.target && ev.target.closest ? ev.target.closest("[data-discovery-preview]") : null;
      if (node && !node.disabled) open(node.getAttribute("data-discovery-preview"));
    });
    if (back) back.addEventListener("click", close);
    global.document.addEventListener("keydown", function (ev) {
      if (S.current && (ev.key === "Escape" || ev.key === "Backspace")) {
        ev.preventDefault(); close();
      }
    });
    /* Cordova Android : retour physique ferme d'abord le plein ecran. */
    global.document.addEventListener("backbutton", function (ev) {
      if (S.current) { if (ev && ev.preventDefault) ev.preventDefault(); close(); }
    });
    if (svc() && svc().onChanged) svc().onChanged(refresh);
  }
  global.MultiCamHomePreview = { bind: bind, refresh: refresh, close: close, open: open };
})(window);
