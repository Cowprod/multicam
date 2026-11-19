/* MultiCam - grille de cadrage (ARM et apres STOP), sans demarrer REC.
 * Les JPEG distants proviennent exclusivement de preview-inbox (controle Master),
 * la Capture locale du sampler, jamais d'une boucle reseau sur soi-meme.
 */
(function (global) {
  "use strict";
  var S = { bound: false, deviceId: "", token: 0, ctx: null, nodes: {}, local: null };
  function byId(id) { return global.document.getElementById(id); }
  function store() { return global.MultiCamSessionStore; }
  function inbox() { return global.MultiCamPreviewInbox; }
  function sampler() { return global.MultiCamPreviewSampler; }
  function visible(ctx) {
    var el = byId(ctx.panel === "arm" ? "panel-arm" : "panel-take-stopped");
    return !!(el && el.classList.contains("active"));
  }
  function rootOf(panel) { return byId(panel === "arm" ? "armFraming" : "tsFraming"); }
  function gridOf(panel) { return byId(panel === "arm" ? "armFramingGrid" : "tsFramingGrid"); }

  function frameOf(did) {
    var ctx = S.ctx;
    if (!ctx) return null;
    var f = null;
    if (did === S.deviceId) {
      var sv = sampler() && sampler().view ? sampler().view() : null;
      var local = S.local;
      if (sv && sv.sessionId === ctx.sid && Number(sv.takeNumber) === ctx.take)
        f = local;
    } else {
      f = inbox() && inbox().latest ? inbox().latest(ctx.sid, did) : null;
    }
    if (!f || f.sessionId !== ctx.sid || Number(f.takeNumber) !== ctx.take) return null;
    return f;
  }

  function paintFrame(did, f) {
    var node = S.nodes[did];
    if (!node || !f || !f.jpegBase64) return;
    /* Reuse the shared device projection without altering the Take-scoped inbox. */
    var projected = global.MultiCamDeviceMedia && global.MultiCamDeviceMedia.project({
      deviceId: did, hasCamera: true, connected: true,
      frame: { jpegBase64: f.jpegBase64, receivedAt: typeof f.receivedAt === "number" ? f.receivedAt : Date.now() }
    });
    if (projected && !projected.image) return;
    if (node.seq === f.seq && node.take === f.takeNumber) return;
    node.seq = f.seq;
    node.take = f.takeNumber;
    node.img.src = "data:image/jpeg;base64," + f.jpegBase64;
    node.img.classList.remove("d-none");
    node.note.classList.add("d-none");
    node.status.textContent = "Image " + f.seq;
  }

  function build(ctx) {
    var root = rootOf(ctx.panel), grid = gridOf(ctx.panel);
    if (!root || !grid) return;
    grid.textContent = "";
    S.nodes = {};
    ctx.captures.forEach(function (capture) {
      var card = global.document.createElement("article");
      card.className = "framing-tile";
      var media = global.document.createElement("div");
      media.className = "framing-media";
      var img = global.document.createElement("img");
      img.className = "framing-image d-none";
      img.alt = "Cadrage " + capture.name;
      var note = global.document.createElement("span");
      note.className = "framing-wait";
      note.textContent = "En attente de preview";
      media.appendChild(img);
      media.appendChild(note);
      var bottom = global.document.createElement("div");
      bottom.className = "framing-caption";
      var name = global.document.createElement("span");
      name.textContent = capture.name;
      var status = global.document.createElement("span");
      status.className = "small muted";
      status.textContent = "En attente";
      bottom.appendChild(name);
      bottom.appendChild(status);
      card.appendChild(media);
      card.appendChild(bottom);
      grid.appendChild(card);
      S.nodes[capture.did] = { img: img, note: note, status: status, seq: 0, take: null };
      paintFrame(capture.did, frameOf(capture.did));
    });
    root.classList.toggle("d-none", ctx.captures.length === 0);
  }

  function hide(panel) {
    if (panel && S.ctx && S.ctx.panel !== panel) return;
    S.token++;
    if (S.ctx) {
      var root = rootOf(S.ctx.panel);
      if (root) root.classList.add("d-none");
    }
    S.ctx = null;
    S.nodes = {};
  }

  function open(panel, sid, takeNumber) {
    if (panel !== "arm" && panel !== "stopped") return Promise.resolve(false);
    var token = ++S.token;
    hide();
    token = S.token;
    var root = rootOf(panel);
    if (root) root.classList.add("d-none");
    if (!sid || !store() || typeof store().get !== "function") return Promise.resolve(false);
    return Promise.resolve(store().get(sid)).then(function (session) {
      if (token !== S.token || !session || session.state !== "open") return false;
      if (!(session.masters || []).some(function (m) { return m && m.deviceId === S.deviceId; })) return false;
      var takes = session.takes || [];
      var take = takeNumber ? takes.filter(function (t) { return t.takeNumber === takeNumber; })[0]
        : takes[takes.length - 1];
      if (!take || !Array.isArray(take.captures)) return false;
      var names = {};
      (session.members || []).forEach(function (m) { if (m && m.deviceId) names[m.deviceId] = m.deviceName || m.deviceId; });
      var captures = take.captures.map(function (did) { return { did: did, name: names[did] || did }; });
      S.ctx = { panel: panel, sid: sid, take: take.takeNumber, captures: captures };
      build(S.ctx);
      global.console.log("FRAMING_GRID_READY panel=" + panel + " sessionId=" + sid +
        " take=" + take.takeNumber + " captures=" + captures.length);
      return true;
    }).catch(function (err) {
      global.console.log("FRAMING_GRID_ERROR panel=" + panel + " err=" + String((err && err.message) || err));
      return false;
    });
  }

  function onRemote(frame) {
    var ctx = S.ctx;
    if (!ctx || !visible(ctx) || !frame || frame.sessionId !== ctx.sid ||
        Number(frame.takeNumber) !== ctx.take || frame.deviceId === S.deviceId) return;
    paintFrame(frame.deviceId, frame);
  }

  function onSample(type, ev) {
    if (type !== "ok" || !ev) return;
    S.local = {
      sessionId: ev.sessionId,
      takeNumber: Number(ev.takeNumber),
      seq: ev.seq,
      jpegBase64: ev.base64
    };
    var ctx = S.ctx;
    if (ctx && visible(ctx) && ctx.sid === S.local.sessionId && ctx.take === S.local.takeNumber)
      paintFrame(S.deviceId, S.local);
  }

  function bind(cfg) {
    if (S.bound) return;
    S.bound = true;
    S.deviceId = cfg && cfg.deviceId || "";
    if (inbox() && typeof inbox().onFrame === "function") inbox().onFrame(onRemote);
    if (sampler() && typeof sampler().onEvent === "function") sampler().onEvent(onSample);
  }

  global.MultiCamFramingPreviews = {
    bind: bind, open: open, hide: hide
  };
})(window);
