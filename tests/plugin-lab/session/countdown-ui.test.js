/* MultiCam J08 — tests du CONTRAT D'INTERFACE de l'écran 07 (+ placeholder 08).
 *
 * Le rendu de countdown.js est du DOM ; ce qui mérite d'être testé sans device
 * est sa LOGIQUE de décision, celle qui encode les invariants de la maquette
 * validée ui/07-countdown :
 *   - quelle vue choisir selon rôle × phase (Master / Capture / excluée / REC) ;
 *   - le panneau à ouvrir (countdown) ou NON (Storage, countdown 0 s) ;
 *   - le retour à l'écran ARM quand le plan s'éteint ;
 *   - le badge compact du Storage, jamais un plein écran.
 *
 * On charge countdown.js dans un contexte vm avec un DOM minimal (parcours
 * d'enfants, textContent, classList, querySelector sur backdrop) et un service
 * START factice qui renvoie des vues construites à la main. Aucun device requis.
 *
 * Usage :  node session/countdown-ui.test.js
 */

"use strict";

const path = require("path");
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const SRC = path.resolve(__dirname, "../../../app/www/js/ui/countdown.js");
const HTML = path.resolve(__dirname, "../../../app/www/index.html");
const CSS = path.resolve(__dirname, "../../../app/www/css/countdown.css");

let blocks = 0;
function block(title, fn) {
  blocks++;
  console.log("\n[" + String(blocks).padStart(2, "0") + "] " + title);
  fn();
}

/* ---------- faux DOM minimal ---------- */

function makeEl(id) {
  const classes = new Set();
  return {
    id: id,
    textContent: "",
    innerHTML: "",
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => { if (on === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); } else if (on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c)
    },
    _classes: classes,
    addEventListener: function () { },
    setAttribute: function () { },
    getAttribute: function () { return null; },
    querySelector: function () { return null; }
  };
}

function makeSandbox(view) {
  const ids = ["cdMaster", "cdCapture", "cdExcluded", "cdRec", "cdSession", "cdTake", "cdDigitMaster",
    "cdWaitMaster", "cdSessionCap", "cdTakeCap", "cdDeviceCap", "cdDigitCap", "cdLocalCap",
    "cdExclCause", "cdRecSession", "cdRecTake", "cdRecTimer", "cdRecDelta", "cdEmergency",
    "cdStopModal", "cdStopConfirm", "cdStopCancel", "recBadge", "recBadgeTake", "recBadgeVal"];
  const els = {};
  ids.forEach((i) => { els[i] = makeEl(i); });
  const shown = [];

  const win = {
    MultiCamStartService: {
      start: (sid) => Promise.resolve(view),
      view: () => view,
      cancel: () => Promise.resolve(view),
      stopLocal: () => Promise.resolve(view)
    },
    MultiCamNav: { cfg: () => ({ deviceId: "D1", deviceName: "Cam D1", enabledSkills: ["capture"], permissions: { camera: true, recordAudio: true }, storage: { mode: "internal" } }), show: () => { } }
  };
  const document = {
    getElementById: (id) => els[id] || null,
    querySelector: () => null
  };
  const sandbox = { window: win, document: document, console: { log: () => { } }, setTimeout: setTimeout, clearTimeout: clearTimeout };
  sandbox.self = win;
  sandbox.globalThis = win;
  vm.createContext(sandbox);
  win.document = document;
  win.console = sandbox.console;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox, { filename: "countdown.js" });

  return { screen: win.MultiCamCountdownScreen, els: els, shown: shown };
}

function view(over) {
  return Object.assign({
    active: true,
    phase: "COUNTDOWN",
    sid: "sess-j08",
    sessionName: "Regie J08",
    takeNumber: 3,
    startPlanId: "sess-j08#3#1#1",
    isMaster: true,
    isCapture: false,
    isStorage: false,
    countdownSeconds: 5,
    digit: 5,
    showCountdown: true,
    excluded: false,
    excludeMessage: "",
    countdownResolved: true,
    offsetMs: 0,
    offsetKnown: true,
    recElapsedMs: 0,
    lastStart: null,
    showEmergencyStop: false,
    camera: { prepared: true, recording: false }
  }, over || {});
}

function visibleViews(els) {
  return ["cdMaster", "cdCapture", "cdExcluded", "cdRec"]
    .filter((id) => !els[id].classList.contains("d-none"));
}

/* ---------- 1. sélection de vue par rôle × phase ---------- */
{
  const cases = [
    ["Master en countdown", view(), "cdMaster"],
    ["Capture non-Master en countdown", view({ isMaster: false, isCapture: true }), "cdCapture"],
    ["Capture exclue", view({ isMaster: false, isCapture: true, phase: "EXCLUDED", excluded: true, excludeMessage: "camera_unavailable" }), "cdExcluded"],
    ["Master en REC", view({ phase: "REC", digit: 0 }), "cdRec"],
    ["Capture en REC", view({ isMaster: false, isCapture: true, phase: "REC", digit: 0 }), "cdRec"]
  ];
  block("vue unique par rôle × phase (jamais deux vues visibles)", function () {
    cases.forEach((c) => {
      const box = makeSandbox(c[1]);
      box.screen.render(c[1]);
      const vis = visibleViews(box.els);
      assert.deepStrictEqual(vis, [c[2]], c[0] + " → " + c[2] + " (obtenu " + JSON.stringify(vis) + ")");
    });
  });
}

{
  block("Storage : AUCUNE vue plein écran, badge compact countdown", function () {
    const v = view({ isMaster: false, isCapture: false, isStorage: true });
    const box = makeSandbox(v);
    box.screen.render(v);
    assert.deepStrictEqual(visibleViews(box.els), [], "aucune vue de plein écran");
    assert.strictEqual(box.els.recBadge.classList.contains("d-none"), false, "badge visible");
    assert.strictEqual(box.els.recBadgeVal.textContent, "countdown 5", "badge countdown");
    assert.strictEqual(box.els.recBadgeTake.textContent, "Take 003");
  });
}

{
  block("Storage en REC : badge 'REC mm:ss', pas d'écran", function () {
    const v = view({ isMaster: false, isCapture: false, isStorage: true, phase: "REC", digit: 0, recElapsedMs: 65000 });
    const box = makeSandbox(v);
    box.screen.render(v);
    assert.deepStrictEqual(visibleViews(box.els), []);
    assert.strictEqual(box.els.recBadgeVal.textContent, "REC 01:05", "timer REC en mm:ss");
    assert.strictEqual(box.els.recBadge.classList.contains("rec"), true, "style REC");
  });
}

/* ---------- 2. digit jamais 0 ---------- */
{
  block("jamais de chiffre 0 (invariant 5→1 puis REC direct)", function () {
    [[5, 5], [4, 4], [1, 1]].forEach((p) => {
      const v = view({ digit: p[0] });
      const box = makeSandbox(v);
      box.screen.render(v);
      assert.strictEqual(box.els.cdDigitMaster.textContent, String(p[1]));
    });
    const v = view({ digit: 0, phase: "REC", recElapsedMs: 1000 });
    const box = makeSandbox(v);
    box.screen.render(v);
    /* en REC le chiffre n'est plus affiché du tout (vue cdRec) */
    assert.deepStrictEqual(visibleViews(box.els), ["cdRec"]);
    assert.strictEqual(box.els.cdRecTimer.textContent, "00:01", "timer REC");
  });
}

/* ---------- 3. exclusion : cause affichée, aucun bouton ---------- */
{
  block("Capture écartée : cause explicite, aucun bouton d'action", function () {
    const v = view({ isMaster: false, isCapture: true, phase: "EXCLUDED", excluded: true, excludeMessage: "camera_permission_missing" });
    const box = makeSandbox(v);
    box.screen.render(v);
    assert.strictEqual(box.els.cdExclCause.textContent, "camera_permission_missing");
    /* Le bouton STOP vit dans la vue cdRec : c'est le PARENT qui doit être
     * masqué (d-none porte sur toute la vue, descendants compris). */
    assert.strictEqual(box.els.cdRec.classList.contains("d-none"), true, "vue REC masquée → STOP invisible");
    /* la vue exclue ne contient aucun bouton : vérifié sur le HTML lui-même */
    const html = fs.readFileSync(HTML, "utf8");
    const blockHtml = html.slice(html.indexOf('id="cdExcluded"'), html.indexOf('id="cdRec"'));
    assert.ok(blockHtml.indexOf("<button") === -1, "aucun <button> dans la vue exclue");
  });
}

/* ---------- 4. réintégration ---------- */
{
  block("réintégrée avant le top → la vue countdown revient", function () {
    const box = makeSandbox(view());
    box.screen.render(view({ isMaster: false, isCapture: true, phase: "EXCLUDED", excluded: true, excludeMessage: "x" }));
    assert.deepStrictEqual(visibleViews(box.els), ["cdExcluded"]);
    const back = view({ isMaster: false, isCapture: true, excluded: false, excludeMessage: "" });
    box.screen.render(back);
    assert.deepStrictEqual(visibleViews(box.els), ["cdCapture"], "retour à la vue Capture");
    assert.strictEqual(box.els.cdDigitCap.textContent, "5", "temps restant repris");
  });
}

/* ---------- 5. routeur : countdown 0 s saute l'écran 07 ---------- */
{
  block("countdown 0 s → écran 07 ENTIÈREMENT sauté (routeur renvoie '')", function () {
    const v = view({ countdownSeconds: 0 });
    const box = makeSandbox(v);
    assert.strictEqual(box.screen.route(v), "", "aucun panneau 07");
  });
}

{
  block("countdown > 0 → panneau 07 demandé", function () {
    const v = view();
    const box = makeSandbox(v);
    assert.strictEqual(box.screen.route(v), "countdown");
    const rec = view({ phase: "REC", digit: 0 });
    assert.strictEqual(box.screen.route(rec), "countdown", "REC : même panneau (vue interne 08)");
  });
}

{
  block("Storage → le routeur ne demande AUCUN changement de panneau", function () {
    const v = view({ isMaster: false, isCapture: false, isStorage: true });
    const box = makeSandbox(v);
    assert.strictEqual(box.screen.route(v), "", "le Storage reste sur son écran");
    const rec = view({ isMaster: false, isCapture: false, isStorage: true, phase: "REC", digit: 0 });
    assert.strictEqual(box.screen.route(rec), "", "même en REC");
  });
}

/* ---------- 6. STOP d'urgence réservé au cas sans Master ---------- */
{
  block("STOP d'urgence affiché seulement quand la vue l'implique", function () {
    const v = view({ isMaster: false, isCapture: true, phase: "REC", digit: 0, recElapsedMs: 3000, showEmergencyStop: true });
    const box = makeSandbox(v);
    box.screen.render(v);
    assert.strictEqual(box.els.cdEmergency.classList.contains("d-none"), false, "STOP visible");
    const v2 = view({ phase: "REC", digit: 0, recElapsedMs: 3000, showEmergencyStop: false });
    const box2 = makeSandbox(v2);
    box2.screen.render(v2);
    assert.strictEqual(box2.els.cdEmergency.classList.contains("d-none"), true, "STOP masqué si un Master est là");
  });
}

/* ---------- 7. delta de top affiché tel que mesuré ---------- */
{
  block("placeholder 08 : delta top + delta accusé natif, non arrondis à 0", function () {
    const v = view({ phase: "REC", digit: 0, recElapsedMs: 5000, lastStart: { deltaMs: -37.4, ackMs: 1000, ackDeltaMs: 12.6 } });
    const box = makeSandbox(v);
    box.screen.render(v);
    assert.ok(box.els.cdRecDelta.textContent.indexOf("-37 ms") >= 0, "delta top : " + box.els.cdRecDelta.textContent);
    assert.ok(box.els.cdRecDelta.textContent.indexOf("+13 ms") >= 0, "delta accusé : " + box.els.cdRecDelta.textContent);
  });
}

/* ---------- 8. CSS : fond sombre statique, aucun son ---------- */
{
  const css = fs.readFileSync(CSS, "utf8");
  block("CSS 07 : aucune animation de valeur, preview transparente", function () {
    assert.ok(css.indexOf(".cd-screen") >= 0, "style d'écran présent");
    assert.ok(css.indexOf("background: transparent") >= 0, "WebView transparent (preview native visible)");
    assert.ok(!/@keyframes/.test(css), "aucune animation par clés (fond statique)");
    assert.ok(!/:animation|animation:/.test(css), "aucune propriété animation");
  });
  block("index.html : les deux modales/panneaux J08 sont déclarés", function () {
    const html = fs.readFileSync(HTML, "utf8");
    ["panel-countdown", "cdMaster", "cdCapture", "cdExcluded", "cdRec", "cdStopModal", "recBadge"].forEach((id) => {
      assert.ok(html.indexOf('id="' + id + '"') >= 0, "id manquant : " + id);
    });
    ["js/state/start-model.js", "js/state/start-service.js", "js/native/camera-record.js", "js/ui/countdown.js", "css/countdown.css"].forEach((f) => {
      assert.ok(html.indexOf(f) >= 0, "ressource non branchée : " + f);
    });
    /* ordre de chargement : le modèle et le service AVANT l'UI */
    const iModel = html.indexOf("js/state/start-model.js");
    const iSvc = html.indexOf("js/state/start-service.js");
    const iUi = html.indexOf("js/ui/countdown.js");
    assert.ok(iModel >= 0 && iModel < iSvc && iSvc < iUi, "ordre de chargement modèle < service < UI");
  });
}

console.log("\nOK — " + blocks + " blocs, tous verts.");
