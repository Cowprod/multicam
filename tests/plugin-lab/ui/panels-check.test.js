/* MultiCam J04 · garde-fou déterministe SPA monodocument.
 *
 * Empêche une régression de visibilité des panneaux (defaut constaté en revue
 * visuelle humaine : plusieurs panneaux .screen empilés à l'écran) :
 *   1. index.html déclare exactement les 5 panneaux attendus (#panel-home,
 *      #panel-create, #panel-join, #panel-session, #panel-settings), chacun
 *      portant la classe .screen.
 *   2. Au boot, au plus UN panneau est marqué .active (home).
 *   3. app.css masque .screen par défaut (display:none) et n'affiche que
 *      .screen.active — les deux règles doivent exister.
 *   4. Le routeur main.js (MultiCamNav) bascule "active" sur TOUS les panneaux
 *      avec p === name (aucun panneau ne peut rester visible hors cible).
 *
 * Zero dépendance : exécutable avec node (aucun DOM réel requis).
 */

"use strict";

const fs = require("fs");
const path = require("path");

const WWW = path.join(__dirname, "..", "..", "..", "app", "www");
const html = fs.readFileSync(path.join(WWW, "index.html"), "utf8");
const css = fs.readFileSync(path.join(WWW, "css", "app.css"), "utf8");
const mainJs = fs.readFileSync(path.join(WWW, "js", "main.js"), "utf8");

const REQUIRED_PANELS = ["home", "create", "join", "session", "settings"];

let failures = 0;
function assert(cond, label) {
  console.log((cond ? "ok" : "FAIL") + " — " + label);
  if (!cond) failures++;
}

/* ---- 1. Panneaux déclarés dans index.html ---- */
const panelIds = [];
const panelRe = /<section id="panel-[a-z]+" class="screen(?: active)?">/g;
let m;
while ((m = panelRe.exec(html)) !== null) {
  const id = /id="(panel-[a-z]+)"/.exec(m[0])[1];
  panelIds.push(id);
}
assert(panelIds.length === REQUIRED_PANELS.length,
  "index.html déclare " + REQUIRED_PANELS.length + " panneaux (trouvé: " + panelIds.length + ")");
for (const p of REQUIRED_PANELS) {
  assert(panelIds.indexOf("panel-" + p) !== -1,
    "panneau déclaré #panel-" + p);
}
const onlyExpected = panelIds.every(id => /^panel-(home|create|join|session|settings)$/.test(id));
assert(onlyExpected, "aucun panneau hors liste attendue");

/* ---- 2. Au boot, au plus UN panneau .active ---- */
const bootActives = [];
const actRe = /<section id="(panel-[a-z]+)" class="screen active">/g;
while ((m = actRe.exec(html)) !== null) bootActives.push(m[1]);
assert(bootActives.length === 1 && bootActives[0] === "panel-home",
  "au boot : exactement UN panneau .active = panel-home (trouvé: " + JSON.stringify(bootActives) + ")");

/* ---- 3. Règles CSS de visibilité obligatoires ---- */
const defaultHidden = /\.screen\s*\{\s*display\s*:\s*none\s*;?\s*\}/m;
const activeVisible = /\.screen\.active\s*\{[^}]*display\s*:\s*(flex|block)[^}]*}/m;
assert(defaultHidden.test(css), "app.css force .screen{display:none} (masqué par défaut)");
assert(activeVisible.test(css), "app.css force .screen.active{display:flex/block} (seul affiché)");
const noneAfterActive = /\.screen\.active\s*\{[^}]*display\s*:\s*none\s*[/}]/.test(css);
assert(!noneAfterActive, ".screen.active n'affiche PAS display:none");

/* ---- 4. Routeur main.js : bascule active sur tous les panneaux ---- */
const panelsDecl = /var panels\s*=\s*\[([^\]]*)\]/.exec(mainJs);
assert(panelsDecl !== null, "main.js déclare un tableau « panels »");
if (panelsDecl) {
  const names = panelsDecl[1].split(",").map(s => s.trim().replace(/["']/g, ""));
  const sameSet = names.length === REQUIRED_PANELS.length
    && names.every(n => REQUIRED_PANELS.indexOf(n) !== -1)
    && REQUIRED_PANELS.every(n => names.indexOf(n) !== -1);
  assert(sameSet, "panels (= " + JSON.stringify(names) + ") == liste attendue");
}
assert(/classList\.toggle\(\s*"active"\s*,\s*p === name\s*\)/.test(mainJs),
  "showPanel bascule « active » par panneau cible (p === name)");
assert(/function\s+showPanel\(name,\s*params\)/.test(mainJs),
  "showPanel(nom, params) existe dans le routeur");
assert(/params\.mode\s*=\s*"join"/.test(mainJs),
  "routeur : case 'join' force mode join (l'absence d'afficherait le formulaire de création — défaut revue)");
assert(/case "join"/.test(mainJs), "routeur : case \"join\" présent dans showPanel");

/* ---- 5. Rendu d'état inviolé par le fix SPA ---- */
const sessionJs = fs.readFileSync(path.join(WWW, "js", "ui", "session.js"), "utf8");
const homeJs = fs.readFileSync(path.join(WWW, "js", "ui", "home.js"), "utf8");
assert(/closed \? "FERMÉE" : "OUVERTE"/.test(sessionJs),
  "écran 03 : badge affiche FERMÉE quand closed (jamais OUVERTE)");
assert(/text-bg-danger/.test(sessionJs) && /text-bg-success/.test(sessionJs),
  "écran 03 : badge fermé = danger (rouge), ouvert = success");
assert(/s\.state === "closed"/.test(homeJs) && /FERMÉE/.test(homeJs),
  "accueil : session récente fermée affichée FERMÉE");

console.log(failures === 0
  ? "\nRésumé : UI SPA OK — aucun risque de panneaux multiples"
  : "\nRésumé : " + failures + " échec(s)");
process.exit(failures === 0 ? 0 : 1);