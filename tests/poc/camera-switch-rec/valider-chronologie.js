/* J09 POC — validation de `chronologie.js`.
 *
 * Sans cette vérification, toutes les mesures de transition de la phase
 * segmentée reposeraient sur une conversion d'horloge non testée : une erreur
 * d'un jour ou de fuseau donnerait des « trous » entre segments absurdes mais
 * parfaitement bien chiffrés.
 *
 * On confronte donc les DEUX horloges sur des événements dont le lien est connu
 * par construction : `startRecordVideo.request` (JS) précède
 * `CameraActivity: Starting recording` (natif) de quelques millisecondes, et
 * `stopRecordVideo.ok` (JS) suit `CameraActivity: stopRecord` (natif).
 *
 * Un décalage entre les deux serait un bug de conversion. Tolérance : 3 s,
 * large devant le coût d'un aller-retour JS→natif mais assez serrée pour
 * attraper une erreur de jour, de fuseau ou de siècle.
 */

"use strict";

const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const L = require("./lib.js");
const C = require("./chronologie.js");

const TOLERANCE_MS = 3000;

function main() {
  const rapport = path.join(L.OUT, "rapport-phase1.json");
  /* Les logcats bruts sont compresses en .gz (voir logcat-filtre.js) : on
   * accepte les deux noms, sinon la validation passe silencieusement en SKIP
   * alors que les artefacts sont la. C'est exactement ce qui est arrive. */
  const logcat = [".txt", ".txt.gz"].map((e) => path.join(L.OUT, "phase1-logcat" + e))
    .find((f) => fs.existsSync(f));
  if (!fs.existsSync(rapport) || !logcat) {
    L.say("SKIP : artefacts phase 1 absents, validation impossible");
    return;
  }
  /* --- A. Les DEUX formes de ligne logcat doivent etre parsees identiquement.
   *
   * Ce test existe parce que le premier validateur ne couvrait que la forme
   * `(  pid)` : la forme `(pid)`, rencontree en phase 6, laissait le PID dans
   * le tag et faisait echouer TOUS les marqueurs natifs — silencieusement, car
   * les valeurs devenaient `null` au lieu de lever une erreur. Une mesure qui
   * disparait sans bruit est pire qu'une mesure fausse. */
  L.say("--- A. formes de lignes logcat ---");
  const formes = [
    ["10-02 10:46:57.460 D/CameraActivity(32648): numberOfCameras: 2", "CameraActivity", "numberOfCameras: 2"],
    ["10-02 02:18:24.365 D/CameraActivity( 6674): CameraPreview startRecord camera: back", "CameraActivity", "CameraPreview startRecord camera: back"],
    ["10-02 02:18:24.141 W/libc    (  960): Access denied", "libc", "Access denied"],
    ["10-02 02:18:24.449 D/CameraPreview(6674): Camera started", "CameraPreview", "Camera started"]
  ];
  let echecsForme = 0;
  for (const [ligne, tagAttendu, msgAttendu] of formes) {
    const p2 = C.parseLigne(ligne);
    const ok = !!p2 && p2.tag === tagAttendu && p2.msg === msgAttendu && typeof p2.ms === "number";
    if (!ok) {
      echecsForme++;
      L.say("  ECHEC parse : " + ligne);
      L.say("         obtenu=" + JSON.stringify(p2 && { tag: p2.tag, msg: p2.msg }));
    } else {
      L.say("  OK   tag=" + tagAttendu + " | " + msgAttendu);
    }
  }
  if (echecsForme) { L.say("ECHEC : " + echecsForme + " forme(s) de ligne non parsee(s)"); process.exit(1); }
  L.say("");

  const ev = JSON.parse(fs.readFileSync(rapport, "utf8"));
  const entrees = C.parse(/\.gz$/.test(logcat)
    ? zlib.gunzipSync(fs.readFileSync(logcat)).toString("utf8")
    : fs.readFileSync(logcat, "utf8"));
  const evenements = (ev.phases && ev.phases[0] && ev.phases[0].events) || ev.events || [];
  if (!entrees.length || !evenements.length) {
    L.say("SKIP : logcat ou evenements vides");
    return;
  }

  L.say("entrees logcat parsees : " + entrees.length);
  L.say("evenements JS : " + evenements.length);
  L.say("");

  /* bornage large : la session entiere */
  const t0 = Math.min.apply(null, evenements.map((e) => e.atMs)) - 60000;
  const t1 = Math.max.apply(null, evenements.map((e) => e.atMs)) + 60000;

  const couples = [
    ["startRecordVideo.request", /CameraActivity .*Starting recording/],
    ["stopRecordVideo.ok", /CameraActivity .*stopRecord/]
  ];

  let echecs = 0;
  for (const [nomJs, reNatif] of couples) {
    const js = evenements.filter((e) => e.name === nomJs)[0];
    const natif = C.marqueur(entrees, reNatif, t0, t1);
    if (!js) { L.say("  " + nomJs + " : absent du rapport"); echecs++; continue; }
    if (natif === null) { L.say("  " + nomJs + " : marqueur natif absent du logcat"); echecs++; continue; }
    const ecart = Math.abs(js.atMs - natif);
    const ok = ecart <= TOLERANCE_MS;
    if (!ok) echecs++;
    L.say("  " + (ok ? "OK  " : "ECHEC") + " " + nomJs
      + " JS=" + js.atMs + " natif=" + natif + " ecart=" + ecart + "ms");
  }

  L.say("");
  L.say(echecs ? "ECHEC : " + echecs + " verification(s) — conversion d'horloge non fiable"
    : "=== les deux horloges concordent : la chronologie native est exploitable ===");
  if (echecs) process.exit(1);
}

main();
