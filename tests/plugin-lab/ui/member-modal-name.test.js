/* MultiCam J05 — garde-fou : lors de l'AJOUT d'un device, la modal affiche le
 * NOM HUMAIN du device découvert (`name`, annoncé par la découverte LAN), et
 * jamais l'UUID `deviceId`. Régression constatée en revue humaine 4 devices
 * (modal « Ajouter un device » affichait `23c5cf6e-…=43d7`, un UUID, au lieu
 * de « Cam D4 ») : cause trouvée → `ui/session.js` lisait `deviceRow.deviceName`
 * alors que la table de découverte fournit `name`.
 *
 * Le correctif centralise la résolution dans `ui/names.js` (UMD-lite, testable
 * en Node) : 1. `name` (découverte J03) → 2. `deviceName` (membre session
 * J04/J05) → 3. `deviceId` (dernier recours). `ui/session.js` l'utilise pour le
 * titre de modal ET la persistance du membre ajouté (addMember).
 *
 * Usage :  node ui/member-modal-name.test.js
 */

"use strict";

const path = require("path");
const assert = require("assert");
const fs = require("fs");

const APP = path.resolve(__dirname, "../../../app/www/js");
const names = require(path.join(APP, "ui/names.js"));
const sessionJs = fs.readFileSync(path.join(APP, "ui/session.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(APP, "../index.html"), "utf8");

let failures = 0;
function check(cond, label) {
  console.log((cond ? "ok" : "FAIL") + " — " + label);
  if (!cond) failures++;
}

/* ---- 1. Résolution logique : device découvert `name="Cam D4"` → nom humain ---- */
check(names.deviceHumanName({ deviceId: "23c5cf6e-beab-4e40-b3ab-6dc6dfed0437", name: "Cam D4" }) === "Cam D4",
  "device découvert (name) → modal affiche « Cam D4 », pas l'UUID");
check(names.deviceHumanName({ deviceId: "23c5cf6e-beab-4e40-b3ab-6dc6dfed0437", name: "Cam D4" }) !== "23c5cf6e-beab-4e40-b3ab-6dc6dfed0437",
  "l'UUID n'apparaît JAMAIS quand un nom humain est disponible");

/* ---- 2. Résolution des membres persistés (deviceName) ---- */
check(names.deviceHumanName({ deviceId: "uuid-x", deviceName: "Cam D4" }) === "Cam D4",
  "membre persisté (deviceName) → nom humain");
check(names.deviceHumanName({ deviceId: "uuid-x" }) === "uuid-x",
  "deviceId seul → deviceId (dernier recours)");
check(names.deviceHumanName(null) === "", "row undefined → chaîne vide");
check(names.deviceHumanName({}) === "", "row vide → chaîne vide");

/* ---- 3. Non-régression : la modal utilise la résolution centralisée ---- */
check(/nameEl\.textContent = humanName\(deviceRow\);/.test(sessionJs),
  "session.js : le titre de modal utilise humanName (plus jamais deviceRow.deviceName || deviceRow.deviceId)");
check(!/deviceRow\.deviceName \|\| deviceRow\.deviceId/.test(sessionJs),
  "session.js : plus aucune lecture brute deviceRow.deviceName dans la modal");
check(/deviceName: humanName\(device\),/.test(sessionJs),
  "session.js : addMember persiste le nom humain (deviceName: humanName(device))");
check(!/deviceName: device\.deviceName \|\| did/.test(sessionJs),
  "session.js : addMember ne persistait plus l'UUID comme deviceName");
check(/function humanName\(row\)/.test(sessionJs),
  "session.js : wrapper humanName présent (via MultiCamNames centralisé)");

/* ---- 4. Non-régression : le module util est chargé AVANT session.js ---- */
const idxNames = indexHtml.indexOf('src="js/ui/names.js"');
const idxSession = indexHtml.indexOf('src="js/ui/session.js"');
check(idxNames >= 0 && idxSession >= 0 && idxNames < idxSession,
  "index.html : js/ui/names.js chargé avant js/ui/session.js");

if (failures > 0) {
  console.log("\n" + failures + " échec(s)");
  process.exit(1);
}
console.log("\nOK — aucune régression de nommage J05");