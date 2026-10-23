/* MultiCam — écran « Take arrêté » (J10, panneau minimal du STOP global).
 *
 * AFFICHAGE UNIQUEMENT. Ce panneau ne décide rien : il projette la vue du
 * service START (start-service → start-model) après un STOP coordonné. Chaque
 * ligne de Capture reflète les FAITS du protocole J10 :
 *
 *   - `stopStates[did]`    → la Capture a publié son stop_state (STOPPED,
 *                            deltaMs = écart contre son top local, path) ;
 *   - `stopIncidents[did]` → la Capture n'a PAS confirmé avant le timeout
 *                            d'ack du Master (levé par stop_state tardif ou
 *                            reconnexion) ;
 *   - ni l'un ni l'autre    → aucune confirmation (WAITING).
 *
 * La durée affichée est celle du MASTER (instant d'arrêt local − top), jamais
 * un cumul d'intervalles. Les barres de transfert sont J11 — hors périmètre.
 *
 * La couche `view()`/`rowsOf()` est PURE (aucun DOM) : c'est là que la règle
 * d'affichage se teste, `render()` n'est qu'une projection idempotente.
 */

(function (global) {
  "use strict";

  function byId(id) { return global.document ? global.document.getElementById(id) : null; }

  function el(tag, cls) {
    var e = global.document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function hms(ms) {
    var t = Math.max(0, Math.floor((ms || 0) / 1000));
    var h = Math.floor(t / 3600);
    var m = Math.floor((t % 3600) / 60);
    var s = t % 60;
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  function fmtDelta(ms) {
    if (typeof ms !== "number" || !isFinite(ms)) return "—";
    return (ms >= 0 ? "+" : "") + Math.round(ms) + " ms";
  }

  function baseName(p) {
    var s = String(p || "");
    var i = s.lastIndexOf("/");
    return i >= 0 ? s.slice(i + 1) : s;
  }

  /* J11 — formatage volume lisible (Go/Mo/ko), jamais de jargon (SHA-256…). */
  function fmtBytes(n) {
    n = Math.max(0, Number(n) || 0);
    if (n >= 1073741824) return (n / 1073741824).toFixed(1).replace(".", ",") + " Go";
    if (n >= 1048576) return (n / 1048576).toFixed(0) + " Mo";
    if (n >= 1024) return (n / 1024).toFixed(0) + " ko";
    return n + " o";
  }

  /* Vue du service de transfert (J11), ou null si absent/pas de Take. */
  function transferView() {
    var boot = global.MultiCamTransferBootInstance;
    return (boot && typeof boot.view === "function") ? boot.view() : null;
  }

  /* Noms des Storage du plan courant : did -> deviceName. */
  function storageNames() {
    var parts = planParticipants();
    var map = {};
    parts.forEach(function (p) {
      if (p && p.role === "storage") map[p.deviceId] = p.deviceName || p.deviceId;
    });
    return map;
  }

  function planParticipants() {
    var svc = global.MultiCamStartService;
    var machine = (svc && typeof svc.machine === "function") ? svc.machine() : null;
    var plan = (machine && machine.state) ? machine.state.plan : null;
    return (plan && Array.isArray(plan.participants)) ? plan.participants : [];
  }

  /* Storage attendus du plan, dans l'ordre du plan (jamais celui des transferts). */
  function planStorages() {
    return planParticipants().filter(function (p) { return p && p.role === "storage"; });
  }

  /* État d'une destination → libellé simple + classe. */
  function barState(state) {
    switch (state) {
      case "done": return { text: "Terminé", cls: "bg-success" };
      case "error": return { text: "Erreur", cls: "bg-danger" };
      case "verifying": return { text: "Vérification", cls: "" };
      case "transferring": return { text: "Transfert", cls: "" };
      /* J15 : attente réseau = NON terminal ; reprise automatique en cours. */
      case "waiting_network": return { text: "En attente réseau", cls: "bg-warning" };
      /* J16-A : l'état GLOBAL d'un transfert ne prouve JAMAIS l'état d'un
       * couple Capture → Storage. Une destination sans donnée est donc
       * « indisponible », jamais « terminée ». */
      case "unknown": return { text: "Indisponible", cls: "" };
      default: return { text: "En attente", cls: "" };
    }
  }

  /* J11 — barres PURES d'une Capture : une par Storage attendu. La progression
   * vient des FAITS remontés par les Storage (modèle de transfert), jamais d'un
   * timer local. Une réplication terminée reste visible à 100 %. Si la Capture
   * est HORS LIGNE avant d'avoir commencé (aucun transfert connu), on affiche
   * quand même les Storage attendus, en attente (README 09 §4). */
  function barsOf(v, tv, names, offline) {
    var out = [];
    tv = tv || transferView();
    names = names || storageNames();
    if (v && tv && tv.transfers) {
      Object.keys(tv.transfers).sort().forEach(function (k) {
        var t = tv.transfers[k];
        if (!t || t.sourceDeviceId !== v.deviceId) return;
        var st = barState(t.state);
        var meta;
        if (t.state === "done") meta = fmtBytes(t.total) + " / " + fmtBytes(t.total) + " · Terminé";
        else if (t.state === "error") meta = fmtBytes(t.bytes) + " / " + fmtBytes(t.total) + " · interrompu à " + t.percent + " %";
        else if (t.state === "pending") meta = "0 / " + fmtBytes(t.total);
        else meta = fmtBytes(t.bytes) + " / " + fmtBytes(t.total) + " · " + t.percent + " %";
        out.push({
          storageDeviceId: t.storageDeviceId,
          name: names[t.storageDeviceId] || t.storageDeviceId,
          state: t.state, stateText: st.text, barClass: st.cls,
          percent: t.state === "done" ? 100 : t.percent,
          meta: meta, retry: t.state === "error"
        });
      });
    }
    if (out.length || !offline) return out;
    planStorages().forEach(function (p) {
      out.push({
        storageDeviceId: p.deviceId,
        name: p.deviceName || p.deviceId,
        state: "pending", stateText: "En attente", barClass: "",
        percent: 0, meta: "En attente", retry: false
      });
    });
    return out;
  }

  var state = { sid: null, bound: false, archived: false, projection: null };

  /* Lignes PURES : une ligne = { deviceId, name, state, stateText, stateClass,
   * deltaText, path, offline, bars }. L'état est DÉRIVÉ des réplications (README
   * 09 §2) : Erreur > Terminé > Transfert > En attente (dont Capture hors ligne,
   * §4) > Préparation. Ordre = ordre du plan, jamais celui de la connectivité. */
  function rowsOf(v) {
    var out = [];
    if (!v || !v.active) return out;
    var participants = planParticipants();
    var states = v.stopStates || {};
    var incidents = v.stopIncidents || {};
    var tv = transferView();
    var names = storageNames();
    participants.forEach(function (p) {
      if (!p || p.role !== "capture") return;
      var st = states[p.deviceId];
      var incident = !st && !!incidents[p.deviceId];
      var offline = !st;   /* aucune finalisation reçue : indisponible/attente */
      var bars = barsOf({ deviceId: p.deviceId }, tv, names, offline);
      var anyError = bars.some(function (b) { return b.state === "error"; });
      var allDone = bars.length > 0 && bars.every(function (b) { return b.state === "done"; });
      var anyRun = bars.some(function (b) { return b.state === "transferring" || b.state === "verifying"; });
      var anyWaiting = bars.some(function (b) { return b.state === "waiting_network"; });
      var anyPending = bars.some(function (b) { return b.state === "pending"; });
      var simple;
      if (anyError) simple = { state: "ERROR", text: "Erreur", cls: "st-error" };
      else if (allDone) simple = { state: "DONE", text: "Terminé", cls: "st-stopped" };
      else if (anyRun) simple = { state: "TRANSFER", text: "Transfert", cls: "st-warning" };
      else if (anyWaiting) simple = { state: "WAITING_NETWORK", text: "En attente réseau", cls: "st-warning" };
      else if (offline || anyPending) simple = { state: "WAITING", text: "En attente", cls: "st-warning" };
      else simple = { state: "PREPARING", text: "Préparation", cls: "st-warning" };
      out.push({
        deviceId: p.deviceId,
        name: p.deviceName || p.deviceId,
        state: simple.state,
        stateText: simple.text,
        stateClass: simple.cls,
        deltaText: st ? fmtDelta(st.deltaMs) : "—",
        path: st ? baseName(st.path) : "",
        incident: incident,
        offline: offline,
        offlineText: offline ? ("En attente de " + (p.deviceName || p.deviceId)) : "",
        bars: bars
      });
    });
    return out;
  }

  /* État global du Take (README 09 §1) : Erreur si une réplication est en
   * erreur ; Terminé quand toutes les réplications sont terminées/vérifiées (ou,
   * sans Storage, quand toutes les Captures ont finalisé) ; sinon Transferts en
   * cours. Aucune progression globale (§1). */
  function takeStateOf(rows) {
    if (!rows.length) return { text: "Transferts en cours", cls: "text-warning" };
    var anyError = rows.some(function (r) { return r.state === "ERROR"; });
    if (anyError) return { text: "Erreur", cls: "text-danger" };
    var allDone = rows.every(function (r) { return r.state === "DONE"; });
    if (allDone) return { text: "Terminé", cls: "text-success" };
    var noStorages = planStorages().length === 0;
    var allFinalized = rows.every(function (r) { return !r.offline; });
    if (noStorages && allFinalized) return { text: "Terminé", cls: "text-success" };
    return { text: "Transferts en cours", cls: "text-warning" };
  }

  function view(v) {
    v = v || {};
    var rows = rowsOf(v);
    var ts = takeStateOf(rows);
    return {
      sessionName: v.sessionName || "",
      takeLabel: v.takeNumber ? "Take " + String(v.takeNumber).padStart(3, "0") : "Take —",
      durationText: hms(v.stopDurationMs || v.recElapsedMs || 0),
      takeStateText: ts.text,
      takeStateClass: ts.cls,
      rows: rows,
      empty: rows.length === 0,
      archived: false,
      unavailable: []
    };
  }

  /* ---------- couche DOM ---------- */

  var NODES = {};   /* deviceId -> {root, name, state, delta, path, bars, barsMap} */

  function makeRow(row) {
    var root = el("div", "ts-row");
    root.dataset.deviceId = row.deviceId;
    var name = el("div", "ts-row-name");
    var meta = el("div", "ts-row-meta");
    var stateEl = el("span", "ts-row-state");
    stateEl.dataset.state = row.state;
    var delta = el("span", "ts-row-delta");
    var path = el("span", "ts-row-path small muted");
    var offline = el("div", "ts-row-offline alert alert-secondary py-2 px-3 small");
    offline.classList.add("d-none");
    meta.appendChild(stateEl);
    meta.appendChild(delta);
    root.appendChild(name);
    root.appendChild(meta);
    root.appendChild(path);
    root.appendChild(offline);
    var bars = el("div", "ts-bars");
    root.appendChild(bars);
    return { root: root, name: name, state: stateEl, delta: delta, path: path, offline: offline, bars: bars, barsMap: {} };
  }

  function makeBar(srcDid, bar) {
    var root = el("div", "ts-bar");
    root.dataset.storageId = bar.storageDeviceId;
    var head = el("div", "ts-bar-head");
    var bname = el("span", "ts-bar-name");
    var bstate = el("span", "ts-bar-state small");
    var retry = el("button", "ts-bar-retry btn btn-sm btn-outline-light");
    retry.type = "button";
    retry.textContent = "Réessayer";
    retry.addEventListener("click", function () {
      console.log("SCREEN09_RETRY source=" + srcDid + " storage=" + bar.storageDeviceId);
      var boot = global.MultiCamTransferBootInstance;
      if (boot && typeof boot.retry === "function") boot.retry(srcDid);
    });
    head.appendChild(bname);
    head.appendChild(bstate);
    head.appendChild(retry);
    var prog = el("div", "ts-bar-progress progress");
    var fill = el("div", "ts-bar-fill progress-bar");
    prog.appendChild(fill);
    var meta = el("div", "ts-bar-meta tiny muted");
    root.appendChild(head);
    root.appendChild(prog);
    root.appendChild(meta);
    return { root: root, name: bname, state: bstate, retry: retry, fill: fill, meta: meta };
  }

  function paintBars(node, row) {
    var want = {};
    (row.bars || []).forEach(function (b) { want[b.storageDeviceId] = b; });
    Object.keys(node.barsMap).forEach(function (sid) {
      if (!want[sid]) {
        var bn = node.barsMap[sid];
        if (bn.root.parentNode) bn.root.parentNode.removeChild(bn.root);
        delete node.barsMap[sid];
      }
    });
    (row.bars || []).forEach(function (bar) {
      var bn = node.barsMap[bar.storageDeviceId];
      if (!bn) { bn = makeBar(row.deviceId, bar); node.barsMap[bar.storageDeviceId] = bn; }
      if (bn.root.parentNode !== node.bars) node.bars.appendChild(bn.root);
      if (bn.name.textContent !== bar.name) bn.name.textContent = bar.name;
      bn.state.textContent = bar.stateText;
      bn.state.classList.toggle("text-success", bar.state === "done");
      bn.state.classList.toggle("text-danger", bar.state === "error");
      var w = bar.percent + "%";
      if (bn.fill.style.width !== w) bn.fill.style.width = w;
      var fcls = "ts-bar-fill progress-bar " + (bar.barClass || "");
      if (bn.fill.className !== fcls) bn.fill.className = fcls;
      if (bn.meta.textContent !== bar.meta) bn.meta.textContent = bar.meta;
      bn.retry.classList.toggle("d-none", !bar.retry);
    });
    node.bars.classList.toggle("d-none", !(row.bars && row.bars.length));
  }

  function paint(node, row) {
    if (node.name.textContent !== row.name) node.name.textContent = row.name;
    var cls = "ts-row-state " + row.stateClass;
    if (node.state.className !== cls) node.state.className = cls;
    if (node.state.dataset.state !== row.state) node.state.dataset.state = row.state;
    if (node.state.textContent !== row.stateText) node.state.textContent = row.stateText;
    var delta = "écart " + row.deltaText;
    if (node.delta.textContent !== delta) node.delta.textContent = delta;
    if (node.path.textContent !== row.path) node.path.textContent = row.path;
    node.path.classList.toggle("d-none", !row.path);
    /* Capture hors ligne (§4) : bandeau explicite, la carte reste visible. */
    if (node.offline.textContent !== row.offlineText) node.offline.textContent = row.offlineText;
    node.offline.classList.toggle("d-none", !row.offlineText);
    paintBars(node, row);
  }

  /* ---------- J16-A : mode ARCHIVÉ (consultation d'un Take précédent) ---------- */

  /* État d'une Capture ARCHIVÉE → libellé + classe.
   * Les six premiers états sont EXACTEMENT ceux du mode direct : l'écran parle
   * la même langue en direct et en archive. Les trois derniers disent ce qui
   * est connu et ce qui ne l'est pas. */
  function archivedRowState(state) {
    switch (state) {
      case "ERROR": return { text: "Erreur", cls: "st-error" };
      case "DONE": return { text: "Terminé", cls: "st-stopped" };
      case "TRANSFER": return { text: "Transfert", cls: "st-warning" };
      case "WAITING_NETWORK": return { text: "En attente réseau", cls: "st-warning" };
      case "WAITING": return { text: "En attente", cls: "st-warning" };
      /* La Capture est arrêtée mais l'état de réplication n'est pas documenté. */
      case "RECORDED": return { text: "Enregistré", cls: "st-stopped" };
      /* Une partie des destinations est documentée, l'autre non. */
      case "PARTIAL": return { text: "Réplication partielle", cls: "st-warning" };
      default: return { text: "Information indisponible", cls: "st-unknown" };
    }
  }

  /* État global d'un Take ARCHIVÉ → libellé + classe. */
  function archivedTakeState(state) {
    switch (state) {
      case "error": return { text: "Erreur", cls: "text-danger" };
      case "done": return { text: "Terminé", cls: "text-success" };
      case "running": return { text: "Transferts en cours", cls: "text-warning" };
      case "waiting": return { text: "En attente de réplication", cls: "text-warning" };
      case "partial": return { text: "Réplication partielle", cls: "text-warning" };
      case "none": return { text: "Aucune Capture", cls: "text-secondary" };
      default: return { text: "Information indisponible", cls: "text-secondary" };
    }
  }

  /* Projection ARCHIVÉE : transforme les FAITS reconstruits (module pur
   * `state/take-archive-model.js`) en lignes d'AFFICHAGE. La FORME du
   * résultat est celle de `view()` : le DOM est donc identique.
   *
   * Deux différences assumées avec le mode direct :
   *  - le bouton « Réessayer » n'a AUCUN sens en archive (le transfert est
   *    terminé ou inconnu) : il n'est jamais proposé ;
   *  - une Capture sans confirmation d'arrêt affiche « aucune confirmation »
   *    (et non « en attente de … ») : en archive, une attente n'a pas de sens. */
  function archivedView(arch) {
    arch = arch || {};
    var rows = (arch.rows || []).map(function (r) {
      var st = archivedRowState(r.state);
      var bars = (r.destinations || []).map(function (d) {
        var bs = barState(d.state);
        var meta;
        if (d.state === "unknown") {
          meta = "Information de réplication indisponible";
        } else if (d.state === "done") {
          meta = fmtBytes(d.bytes) + " / " + fmtBytes(d.total) + " · Terminé";
        } else if (d.state === "error") {
          meta = fmtBytes(d.bytes) + " / " + fmtBytes(d.total) + " · interrompu à " + d.percent + " %";
        } else if (d.state === "pending") {
          meta = "0 / " + fmtBytes(d.total);
        } else {
          meta = fmtBytes(d.bytes) + " / " + fmtBytes(d.total) + " · " + d.percent + " %";
        }
        return {
          storageDeviceId: d.storageDeviceId,
          name: d.name,
          state: d.state,
          stateText: bs.text,
          barClass: bs.cls,
          percent: d.state === "done" ? 100 : d.percent,
          meta: meta,
          retry: false
        };
      });
      return {
        deviceId: r.deviceId,
        name: r.name,
        state: r.state,
        stateText: st.text,
        stateClass: st.cls,
        deltaText: (r.deltaMs === null || r.deltaMs === undefined) ? "—" : fmtDelta(r.deltaMs),
        path: r.path || "",
        incident: false,
        offline: !r.stopKnown,
        offlineText: r.stopKnown ? "" : ("Aucune confirmation d'arrêt reçue pour " + r.name),
        bars: bars
      };
    });
    var ts = archivedTakeState(arch.state);
    return {
      sessionName: arch.sessionName || "",
      takeLabel: arch.takeNumber ? "Take " + String(arch.takeNumber).padStart(3, "0") : "Take —",
      durationText: arch.durationKnown ? hms(arch.durationMs) : "—",
      takeStateText: ts.text,
      takeStateClass: ts.cls,
      rows: rows,
      empty: rows.length === 0,
      archived: true,
      unavailable: arch.unavailable || []
    };
  }

  function renderArchived(arch) {
    return paintProjection(archivedView(arch));
  }

  function render(v) {
    /* J16-A — un Take ARCHIVÉ est un fait FIGÉ. Les vues VIVANTES (START,
     * service de transfert) sont re-rendues à chaque révision par le routeur
     * (main.js) : en mode archivé, elles doivent être IGNORÉES, sinon l'écran
     * afficherait le Take courant à la place du Take consulté. */
    if (state.archived) return state.projection;
    return paintProjection(view(v));
  }

  /* J16-A — projection DOM à partir d'une VUE de panneau.
   *
   * `render()` (mode direct) et `renderArchived()` (mode archivé) convergent
   * ici : le DOM est le même, seule la PROVENANCE des faits change. Le mode
   * direct reste inchangé — il continue de passer par `view(v)`. */
  function paintProjection(pv) {
    state.projection = pv;
    var sX = byId("tsSession");
    if (sX) sX.textContent = pv.sessionName || "—";
    var tX = byId("tsTake");
    if (tX) tX.textContent = pv.takeLabel;
    var stX = byId("tsState");
    if (stX) {
      stX.textContent = pv.takeStateText;
      stX.className = "small " + pv.takeStateClass;
    }
    var dX = byId("tsDuration");
    if (dX) dX.textContent = pv.durationText;
    /* J16-A : bandeau des informations indisponibles (mode archivé seul). */
    var noteX = byId("tsArchiveNote");
    if (noteX) {
      var note = (pv.unavailable && pv.unavailable.length) ? pv.unavailable.join(" ") : "";
      if (noteX.textContent !== note) noteX.textContent = note;
      noteX.classList.toggle("d-none", !note);
    }
    /* J16-A : en archive, « Préparer le Take suivant » n'a aucun sens (le Take
     * est passé) : c'est un « Retour à la session » qui est proposé. */
    var backX = byId("tsBack");
    if (backX) backX.classList.toggle("d-none", !pv.archived);
    var doneX = byId("tsDone");
    if (doneX) doneX.classList.toggle("d-none", !!pv.archived);
    var list = byId("tsList");
    if (!list) return pv;

    var want = {};
    pv.rows.forEach(function (r) { want[r.deviceId] = r; });
    Object.keys(NODES).forEach(function (did) {
      if (!want[did]) {
        var n = NODES[did];
        if (n.root.parentNode) n.root.parentNode.removeChild(n.root);
        delete NODES[did];
      }
    });
    pv.rows.forEach(function (row, i) {
      var node = NODES[row.deviceId];
      if (!node) {
        node = makeRow(row);
        NODES[row.deviceId] = node;
      }
      if (node.root.parentNode !== list) list.appendChild(node.root);
      paint(node, row);
      var kids = Array.prototype.slice.call(list.children);
      if (kids.indexOf(node.root) !== i) list.insertBefore(node.root, kids[i] || null);
    });
    return pv;
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;
    var done = byId("tsDone");
    if (done) done.addEventListener("click", function () {
      /* README 09 §7 : « Préparer le Take suivant » renvoie TOUJOURS vers la
       * préparation (écran 05), même transferts en cours / Capture hors ligne /
       * réplication en erreur — jamais bloqué par la finalisation. */
      console.log("SCREEN09_NEXT_TAKE sessionId=" + (state.sid || "—"));
      if (global.MultiCamNav && typeof global.MultiCamNav.show === "function") {
        global.MultiCamNav.show("take", { sid: state.sid });
      }
    });
    /* J16-A : en archive, on revient à la session consultée. */
    var back = byId("tsBack");
    if (back) back.addEventListener("click", function () {
      console.log("SCREEN09_ARCHIVED_BACK sessionId=" + (state.sid || "—"));
      if (global.MultiCamNav && typeof global.MultiCamNav.show === "function") {
        global.MultiCamNav.show("session", { sid: state.sid });
      }
    });
  }

  /* J16-A — consultation d'un Take PRÉCÉDENT.
   *
   * Les données viennent du STORE (faits persistés) et sont reconstruites par
   * le module pur `state/take-archive-model.js`. Le mode direct n'est PAS
   * concerné : cette fonction ne lit ni le service START ni le service de
   * transfert (ce sont des sources VIVANTES, vides pour un Take passé). */
  function renderFromStore(sid, takeNumber) {
    try {
      var store = global.MultiCamSessionStore;
      if (!store || typeof store.get !== "function") return Promise.resolve(null);
      return Promise.resolve(store.get(sid)).then(function (s) {
        if (!s) return null;
        var takes = s.takes || [];
        var t = null;
        for (var i = 0; i < takes.length; i++) {
          if (takes[i] && takes[i].takeNumber === takeNumber) { t = takes[i]; break; }
        }
        if (!t) return null;
        var model = global.MultiCamTakeArchiveModel;
        if (!model || typeof model.reconstruct !== "function") {
          console.log("SCREEN09_ARCHIVED_UNAVAILABLE reason=archive_model_missing sessionId=" + (sid || "—"));
          return null;
        }
        var arch = model.reconstruct({ take: t, session: s });
        var pv = renderArchived(arch);
        console.log("SCREEN09_ARCHIVED sessionId=" + (sid || "—") + " take=" + takeNumber
          + " captures=" + pv.rows.length
          + " state=" + arch.state
          + " unavailable=" + (arch.unavailable ? arch.unavailable.length : 0));
        return pv;
      }).catch(function (e) {
        console.log("SCREEN09_ARCHIVED_ERR " + String((e && e.message) || e));
        return null;
      });
    } catch (e) {
      console.log("SCREEN09_ARCHIVED_ERR " + String((e && e.message) || e));
      return Promise.resolve(null);
    }
  }

  function show(cfg, params) {
    params = params || {};
    state.sid = params.sid || state.sid;
    bind();
    if (params.archived === "1" && params.takeNumber) {
      state.archived = true;
      var p = renderFromStore(params.sid || state.sid, params.takeNumber);
      console.log("SCREEN09_OPEN_ARCHIVED sessionId=" + (params.sid || state.sid) + " take=" + params.takeNumber);
      return p;
    }
    state.archived = false;
    var v = global.MultiCamStartService ? global.MultiCamStartService.view() : null;
    var pv = render(v);
    console.log("SCREEN09_OPEN sessionId=" + (state.sid || "—")
      + " take=" + (v && v.takeNumber)
      + " captures=" + pv.rows.length
      + " incidents=" + pv.rows.filter(function (r) { return r.incident; }).length);
    return pv;
  }

  global.MultiCamTakeStoppedScreen = {
    show: show,
    render: render,
    view: view,
    rowsOf: rowsOf,
    /* J16-A : projection archivée (données persistées → lignes d'affichage). */
    archivedView: archivedView,
    renderArchived: renderArchived,
    /* J16-A : l'écran sait-il qu'il consulte une archive ? Le routeur (main.js)
     * s'en sert pour ne PAS rediriger vers ARM à la fin d'un plan : l'opérateur
     * consulte un Take passé, il n'est pas en train de tourner. */
    isArchived: function () { return !!state.archived; },
    _nodes: NODES
  };
})(window);