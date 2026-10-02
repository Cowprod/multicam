/* J09 POC — PHASE 1 : diagnostic SANS modification.
 *
 * Objectif : établir, sur la pile ACTUELLE, si Android Camera1 + MediaRecorder
 * permet de changer de caméra en gardant le MÊME MediaRecorder en train
 * d'écrire le MÊME fichier.
 *
 * Ce que le script fait :
 *   1. inventaire des caméras réellement exposées par le device ;
 *   2. trace du cycle réel de la caméra (logcat filtré) pendant un REC ;
 *   3. tentative de switch caméra via l'action `switchCamera` du plugin ;
 *   4. constat factuel : que se passe-t-il ?
 *
 * AUCUNE modification de code produit, aucun protocole, aucune UI.
 */

"use strict";

const L = require("./lib.js");
const A = require("./analyse.js");
const fs = require("fs");
const path = require("path");

const ev = L.ev;

/* ---------- 0. démarrage à froid + inventaire ---------- */
async function main() {
  L.say("=== POC J09 — changement de caméra pendant un REC ===");
  L.say("device=" + L.CAP_SERIAL + " (les MP4 restent sur le device)");

  L.coldStart();
  const cdp = await L.attach("capture");
  try { L.adb(["logcat", "-c"]); } catch (e) {}

  /* Purge des .mp4 AVANT la séquence. Sans ça, on ne sait plus quel fichier
   * est le segment de CE run : `videoTmp_N` s'incrémente à chaque REC et le
   * cache en garde des dizaines (141 Mo sur le device de test). On ne supprime
   * QUE les .mp4 du cache de l'app, jamais rien d'autre. */
  const purged = L.purgeCacheRecordings();
  L.say("PURGE_CACHE " + purged + " fichier(s) .mp4 supprimes");

  /* On attend que le plugin soit exposé : `CameraPreview` n'existe qu'après
   * deviceready, et l'action de capabilities peut être un shim installé par
   * `native/capture-capabilities.js`. Sans cette attente, on mesurerait un
   * état de démarrage et non la pile. */
  let ready = false;
  for (let i = 0; i < 40; i++) {
    /* `getCaptureCapabilities` n'est pas une action du plugin d'origine : c'est
     * un shim posé par `native/capture-capabilities.js` au deviceready. Attendre
     * seulement `startCamera` ne suffit donc pas, on attend les DEUX. */
    const v = await cdp.ev("(function(){return !!(window.cordova && window.CameraPreview "
      + "&& typeof CameraPreview.startCamera === 'function' "
      + "&& typeof CameraPreview.getCaptureCapabilities === 'function')})()");
    if (v === true) { ready = true; break; }
    await L.sleep(600);
  }
  if (!ready) throw new Error("CameraPreview jamais exposé par le WebView");
  L.say("PLUGIN_PRETE");

  /* ---------- 1. inventaire natif ---------- */
  const caps = await cdp.evJson(
    '(function(){return new Promise(function(res){CameraPreview.getCaptureCapabilities('
    + 'function(r){res(JSON.stringify(r))},function(e){res("{}")})})})()', true);
  ev.device = {
    serial: L.CAP_SERIAL,
    model: L.adbTry(["shell", "getprop", "ro.product.model"]).trim(),
    sdk: L.adbTry(["shell", "getprop", "ro.build.version.sdk"]).trim()
  };
  const cameras = (caps.cameras || []).map((c) => ({
    cameraId: c.cameraId,
    facing: c.facing,
    hardwareLevel: c.hardwareLevel,
    sensorPixel: c.sensorPixelWidth ? c.sensorPixelWidth + "x" + c.sensorPixelHeight : null
  }));
  const profiles = (caps.camcorderProfiles || []).map((p) => ({
    cameraId: p.cameraId,
    available: (p.profiles || []).filter((x) => x.available)
      .map((x) => x.quality + " " + x.videoFrameWidth + "x" + x.videoFrameHeight)
  }));
  /* Compte aussi via Camera1 : `dumpsys media.camera` est l'autorité du
   * framework, la sonde capabilities passe par Camera2. */
  const api1 = /Number of public camera devices visible to API1:\s*(\d+)/
    .exec(L.adbTry(["shell", "dumpsys", "media.camera"]));
  ev.inventory = {
    viaCamera2: cameras,
    camcorderProfiles: profiles,
    viaCamera1Api1: api1 ? Number(api1[1]) : null,
    /* Facing/orientation par dumpsys : le plugin ne les expose pas. */
    dumpsysFacing: (L.adbTry(["shell", "dumpsys", "media.camera"]).match(/Facing:\s*(\w+)/g) || [])
  };
  L.say("INVENTAIRE " + L.json(ev.inventory));

  /* ---------- 2. cycle réel : prepare + REC ---------- */
  L.say("");
  L.say("--- phase A : ouverture preview + REC 6 s sur la caméra par défaut ---");
  const prep = await cdp.evJson("(" + L.JS_PREPARE.toString() + ")('back')", true);
  L.say("PREPARE " + L.json(prep));
  await L.sleep(1500);

  const recA = await cdp.evJson("(" + L.JS_REC_START.toString() + ")(null)", true);
  L.say("REC_START " + L.json(recA));
  if (!recA.ok) {
    ev.errors.push({ phase: "phaseA", where: "startRecordVideo", err: recA.reason });
    throw new Error("REC impossible: " + recA.reason);
  }

  /* PixelCopy pendant le REC (PREUVE que la preview + PixelCopy fonctionnent). */
  const pcBefore = await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('avant-switch')", true);
  ev.pixelcopy.avantSwitch = A.judgeJpeg(pcBefore.base64, "01-pixelcopy-avant.jpg");
  L.say("PIXELCOPY_avant ok=" + pcBefore.ok + " afterMs=" + pcBefore.afterMs
    + " luma=" + ev.pixelcopy.avantSwitch.lumaMoyenne + " noir=" + ev.pixelcopy.avantSwitch.noir);

  await L.sleep(6000);

  /* ---------- 3. TENTATIVE de switch pendant le REC actif ---------- */
  L.say("");
  L.say("--- phase B : switchCamera() PENDANT le MediaRecorder actif ---");
  const sizeAvant = L.listRecordings().map((f) => ({ name: f.name, bytes: f.bytes }));
  L.say("CACHE_AVANT_SWITCH " + L.json(sizeAvant));
  const sw = await cdp.evJson("(" + L.JS_SWITCH.toString() + ")()", true);
  L.say("SWITCH " + L.json(sw));

  /* On observe ce que devient le recorder, la preview et PixelCopy. */
  const pcAfterImmediate = await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('apres-switch-immediat')", true);
  ev.pixelcopy.immediatApresSwitch = A.judgeJpeg(pcAfterImmediate.base64, "02-pixelcopy-immediat.jpg");
  L.say("PIXELCOPY_immediat ok=" + pcAfterImmediate.ok + " reason=" + (pcAfterImmediate.reason || "—")
    + " afterMs=" + pcAfterImmediate.afterMs
    + " luma=" + ev.pixelcopy.immediatApresSwitch.lumaMoyenne);

  /* On attend et on réessaie : un switch peut être asynchrone côté natif. */
  await L.sleep(4000);
  const pcLater = await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('apres-switch-plus-tard')", true);
  ev.pixelcopy.plusTardApresSwitch = A.judgeJpeg(pcLater.base64, "03-pixelcopy-plus-tard.jpg");
  L.say("PIXELCOPY_plus_tard ok=" + pcLater.ok + " reason=" + (pcLater.reason || "—")
    + " afterMs=" + pcLater.afterMs
    + " luma=" + ev.pixelcopy.plusTardApresSwitch.lumaMoyenne
    + " NOIR=" + ev.pixelcopy.plusTardApresSwitch.noir);

  /* On ne lit PAS `MultiCamCameraRecord.isRecording()` : ce POC appelle le
   * plugin en direct, donc cet indicateur serait toujours faux et ne
   * prouverait rien. Le VRAI état du recorder se lit dans le fichier .mp4 :
   * on note sa taille à chaque instant, un recorder actif grossit. */
  const sizeMid = L.listRecordings().map((f) => f.name + "=" + f.bytes).join(",");
  L.say("CACHE_APRES_SWITCH " + (sizeMid || "(vide)"));

  /* ---------- 4. arrêt propre ---------- */
  const stop = await cdp.evJson("(" + L.JS_REC_STOP.toString() + ")()", true);
  L.say("REC_STOP " + L.json(stop));
  await L.sleep(1500);

  /* ---------- 5. ce qui a été réellement écrit ---------- */
  ev.segments = A.analyseRecording("phase1-");

  /* ---------- 6. événements POC + logcat ---------- */
  const state = await cdp.evJson(L.JS_POC_STATE);
  ev.phases.push({ phase: "phase1", events: state.events, t: state.t });

  fs.mkdirSync(L.OUT, { recursive: true });
  /* `-s` filtre par TAG et n'accepte pas `TAG:C` : on prend tout et on filtre
   * nous-mêmes, sinon on enregistre un logcat VIDE sans le signaler. */
  const log = L.adbTry(["logcat", "-d", "-v", "time"]);
  L.ecrireLogcat("phase1-logcat", log);

  fs.writeFileSync(path.join(L.OUT, "rapport-phase1.json"), JSON.stringify(ev, null, 2));
  fs.writeFileSync(path.join(L.OUT, "phase1-console.txt"), L.logLines.join("\n"));
  L.say("RAPPORT " + path.join(L.OUT, "rapport-phase1.json"));

  cdp.close();
  L.say("=== fin phase 1 ===");
}

main().catch((e) => {
  L.say("ERREUR " + e.message);
  try {
    fs.mkdirSync(L.OUT, { recursive: true });
    fs.writeFileSync(path.join(L.OUT, "rapport-phase1.json"), JSON.stringify(ev, null, 2));
    fs.writeFileSync(path.join(L.OUT, "phase1-console.txt"), L.logLines.join("\n"));
  } catch (e2) {}
  process.exit(1);
});
