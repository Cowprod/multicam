/* MultiCam J11 — vue Storage (écran 07, rôle Storage).
 *
 * AFFICHAGE UNIQUEMENT, CONSOMMATEUR de l'état : la vue suit PLUSIEURS sessions
 * et plusieurs Takes simultanément (groupés par session, activité récente en
 * tête, Takes repliables). Le modèle de rendu est la projection PURE
 * `storage-view-model.js` ; ici on ne fait que la peindre dans le DOM.
 *
 * Sources lues (jamais un second modèle d'état) :
 *   - les sessions du store            → MultiCamSessionStore.list()
 *   - la phase courante d'un Take      → MultiCamStartService.view()
 *   - la progression des transferts    → MultiCamTransferBootInstance.viewFor(sid,take)
 *
 * Aucun timer propre : le rafraîchissement vient soit de l'ouverture de la vue,
 * soit des notifications du boot de transfert (`onChange`) et du flux START.
 * Rouvrir la vue ne crée donc NI double abonnement NI timer. */

(function (global) {
  "use strict";

  function byId(id) { return global.document ? global.document.getElementById(id) : null; }

  function el(tag, cls) {
    var e = global.document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function clearNode(n) {
    if (n._kids) { while (n._kids.length) n.removeChild(n._kids[0]); return; }
    while (n.firstChild) n.removeChild(n.firstChild);
  }

  var state = {
    bound: false,
    sessions: null,
    collapsed: {},
    storageInfo: null,
    lastSummary: ""
  };

  function selfId() {
    var svc = global.MultiCamStartService;
    if (svc && typeof svc.selfDid === "function") {
      var s = svc.selfDid();
      if (s) return s;
    }
    var cfg = (global.MultiCamNav && global.MultiCamNav.cfg) ? global.MultiCamNav.cfg() : null;
    return (cfg && cfg.deviceId) || "";
  }

  function storageInfo() {
    var cfg = (global.MultiCamNav && global.MultiCamNav.cfg) ? global.MultiCamNav.cfg() : null;
    return state.storageInfo || (cfg && cfg.storageInfo) || {};
  }

  function transfersFor(sid, takeNumber) {
    var boot = global.MultiCamTransferBootInstance;
    return (boot && typeof boot.viewFor === "function") ? boot.viewFor(sid, takeNumber) : null;
  }

  function phaseFor(sid, takeNumber) {
    var svc = global.MultiCamStartService;
    if (!svc || typeof svc.view !== "function") return null;
    var v = svc.view();
    if (!v || !v.active || v.sid !== sid || v.takeNumber !== takeNumber) return null;
    return { phase: v.phase, digit: v.digit, recStartedAtMs: v.recStartedAtMs, recElapsedMs: v.recElapsedMs };
  }

  function model() {
    return global.MultiCamStorageViewModel;
  }

  /* Projection pure à partir de l'état courant. */
  function view() {
    var m = model();
    if (!m) return { self: selfId(), storage: {}, sessions: [] };
    return m.build({
      sessions: state.sessions || [],
      self: selfId(),
      transfersFor: transfersFor,
      phaseFor: phaseFor,
      storageInfo: storageInfo(),
      collapsed: state.collapsed,
      nowMs: Date.now()
    });
  }

  /* ---------- construction DOM ---------- */

  function deviceTextClass(dev) {
    if (dev.progressText) return dev.stateClass;
    return dev.stateClass;
  }

  function makeSegment(seg) {
    var root = el("div", "st-seg");
    var name = el("span", "st-seg-name small muted");
    name.textContent = seg.label;
    var val = el("span", "st-seg-val small");
    val.textContent = seg.progressText || seg.stateText;
    root.appendChild(name);
    root.appendChild(val);
    return root;
  }

  function makeDevice(dev) {
    var root = el("div", "st-device");
    root.dataset.deviceId = dev.deviceId;
    var head = el("div", "st-device-head d-flex justify-content-between align-items-center");
    var name = el("span", "st-device-name");
    name.textContent = dev.name;
    var val = el("span", "st-device-state small " + dev.stateClass);
    val.dataset.state = dev.state;
    val.textContent = dev.progressText || dev.stateText;
    head.appendChild(name);
    head.appendChild(val);
    root.appendChild(head);

    if (dev.sizeKnown && dev.state !== "done") {
      var prog = el("div", "st-device-progress progress");
      var fill = el("div", "st-device-fill progress-bar");
      fill.style.width = dev.percent + "%";
      prog.appendChild(fill);
      root.appendChild(prog);
    }

    if (dev.segments && dev.segments.length > 1) {
      var segs = el("div", "st-segs");
      dev.segments.forEach(function (s) { segs.appendChild(makeSegment(s)); });
      root.appendChild(segs);
    }
    return root;
  }

  function toggle(key) {
    state.collapsed[key] = !state.collapsed[key];
    render();
  }

  function makeTake(take) {
    var root = el("div", "st-take");
    root.dataset.take = String(take.takeNumber);
    var head = el("div", "st-take-head d-flex align-items-center gap-2");
    var chev = el("button", "st-take-toggle btn btn-sm btn-outline-light border-0 px-1");
    chev.type = "button";
    chev.textContent = take.open ? "\u25be" : "\u25b8";
    chev.addEventListener("click", function () { toggle(take.key); });
    var info = el("div", "st-take-info flex-grow-1");
    var label = el("div", "fw-semibold");
    label.textContent = take.label;
    var summary = el("div", "small muted");
    summary.textContent = take.summaryText;
    info.appendChild(label);
    info.appendChild(summary);
    var badge = el("span", "badge status-badge " + take.badge.cls);
    badge.dataset.badgeKind = take.badge.kind;
    badge.textContent = take.badge.text;
    head.appendChild(chev);
    head.appendChild(info);
    head.appendChild(badge);
    root.appendChild(head);

    var body = el("div", "st-take-body");
    if (!take.open) body.classList.add("d-none");
    if (take.showExpected) {
      var exp = el("div", "small muted st-expected");
      exp.textContent = take.expectedText;
      body.appendChild(exp);
    }
    take.devices.forEach(function (d) { body.appendChild(makeDevice(d)); });
    root.appendChild(body);
    return root;
  }

  function makeSession(group) {
    var root = el("div", "st-session card glass rounded-4 mb-3");
    root.dataset.sessionId = group.sessionId;
    var head = el("div", "st-session-head");
    var btn = el("button", "st-session-toggle");
    btn.type = "button";
    btn.addEventListener("click", function () { toggle(group.sessionId); });
    var name = el("span", "st-session-name fw-semibold");
    name.textContent = group.name;
    var act = el("span", "st-session-activity small muted d-block");
    act.textContent = group.activityText;
    btn.appendChild(name);
    btn.appendChild(act);
    head.appendChild(btn);
    root.appendChild(head);

    var body = el("div", "st-session-body");
    if (!group.open) body.classList.add("d-none");
    group.takes.forEach(function (t) { body.appendChild(makeTake(t)); });
    root.appendChild(body);
    return root;
  }

  function paintHeader(pv) {
    var dX = byId("stDeviceName");
    if (dX) dX.textContent = pv.storage.name || pv.self || "—";
    var fX = byId("stFree");
    if (fX) {
      fX.textContent = pv.storage.freeText || "";
      fX.classList.toggle("d-none", !pv.storage.freeText);
    }
    var nX = byId("stNetwork");
    if (nX) {
      nX.textContent = pv.storage.networkText || "";
      nX.classList.toggle("d-none", !pv.storage.networkText);
    }
  }

  function render() {
    var pv = view();
    paintHeader(pv);
    var host = byId("stSessions");
    if (!host) return pv;
    clearNode(host);
    if (!pv.sessions.length) {
      var empty = el("div", "small muted p-3");
      empty.textContent = "Aucun Take pour ce Storage.";
      host.appendChild(empty);
    } else {
      pv.sessions.forEach(function (g) { host.appendChild(makeSession(g)); });
    }
    var totalTakes = pv.sessions.reduce(function (n, g) { return n + g.takes.length; }, 0);
    state.lastSummary = "sessions=" + pv.sessions.length + " takes=" + totalTakes;
    return pv;
  }

  /* Recharge la liste des sessions (asynchrone) puis re-rend. */
  function refresh() {
    var store = global.MultiCamSessionStore;
    if (!store || typeof store.list !== "function") {
      state.sessions = state.sessions || [];
      return Promise.resolve(render());
    }
    return Promise.resolve(store.list()).then(function (sessions) {
      state.sessions = sessions || [];
      return render();
    }).catch(function (err) {
      if (global.console) global.console.log("STORAGE_VIEW_LIST_ERROR " + String((err && err.message) || err));
      return render();
    });
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;
    var boot = global.MultiCamTransferBootInstance;
    if (boot && typeof boot.onChange === "function") {
      boot.onChange(function () {
        if (global.MultiCamNav && global.MultiCamNav.current && global.MultiCamNav.current() !== "storage") return;
        render();
      });
    }
  }

  function show(cfg, params) {
    params = params || {};
    bind();
    if (cfg && cfg.storageInfo) state.storageInfo = cfg.storageInfo;
    return refresh().then(function (pv) {
      if (global.console) global.console.log("SCREEN07_STORAGE_OPEN self=" + (pv.self || "—")
        + " " + state.lastSummary);
      return pv;
    });
  }

  global.MultiCamStorageView = {
    show: show,
    render: render,
    view: view,
    refresh: refresh,
    setSessions: function (s) { state.sessions = s || []; },
    setStorageInfo: function (s) { state.storageInfo = s || {}; },
    _state: state
  };
})(window);
