/* J09 POC — PHASE 1b : TEMOIN, aucun switch.
 *
 * Pourquoi : la phase 1 a montré une piste VIDEO qui s'arrête à 5.503 s
 * alors que l'audio continue jusqu'à 10.09 s. Mais le switch arrive à 6.222 s
 * après le début du REC, soit APRÈS l'arrêt de la vidéo. Donc la phase 1 ne
 * prouve PAS (et suggère même le contraire) que le switch soit responsable.
 *
 * Ce témoin rejoue EXACTEMENT la même séquence SANS switch : même durée de REC,
 * mêmes sondes PixelCopy, même analyse. Sans lui, toute conclusion de la phase 1
 * serait une attribution sans groupe de contrôle.
 */

"use strict";

const L = require("./lib.js");
const A = require("./analyse.js");
const fs = require("fs");
const path = require("path");

const ev = L.ev;

async function main() {
  L.say("=== POC J09 — TEMOIN sans switch (groupe de contrôle) ===");

  L.coldStart();
  const cdp = await L.attach("capture");
  try { L.adb(["logcat", "-c"]); } catch (e) {}

  const purged = L.purgeCacheRecordings();
  L.say("PURGE_CACHE " + purged + " fichier(s) .mp4 supprimes");

  let ready = false;
  for (let i = 0; i < 40; i++) {
    const v = await cdp.ev("(function(){return !!(window.cordova && window.CameraPreview "
      + "&& typeof CameraPreview.startCamera === 'function')})()");
    if (v === true) { ready = true; break; }
    await L.sleep(600);
  }
  if (!ready) throw new Error("CameraPreview jamais exposé par le WebView");
  L.say("PLUGIN_PRETE");

  const prep = await cdp.evJson("(" + L.JS_PREPARE.toString() + ")('back')", true);
  L.say("PREPARE " + L.json(prep));
  await L.sleep(1500);

  /* Mêmes paliers que la phase 1 pour que seule la variable « switch » change :
   * REC ~11 s, PixelCopy au début et 4 s plus tard. */
  const rec = await cdp.evJson("(" + L.JS_REC_START.toString() + ")(null)", true);
  L.say("REC_START " + L.json(rec));
  if (!rec.ok) throw new Error("REC impossible: " + rec.reason);

  const pc1 = await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('teminin-avant')", true);
  ev.pixelcopy.avant = A.judgeJpeg(pc1.base64, "10-teminin-pixelcopy-avant.jpg");
  L.say("PIXELCOPY_avant ok=" + pc1.ok + " afterMs=" + pc1.afterMs
    + " luma=" + ev.pixelcopy.avant.lumaMoyenne + " noir=" + ev.pixelcopy.avant.noir);

  await L.sleep(6000);

  const pc2 = await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('teminin-milieu')", true);
  ev.pixelcopy.milieu = A.judgeJpeg(pc2.base64, "11-teminin-pixelcopy-milieu.jpg");
  L.say("PIXELCOPY_milieu ok=" + pc2.ok + " afterMs=" + pc2.afterMs
    + " luma=" + ev.pixelcopy.milieu.lumaMoyenne + " noir=" + ev.pixelcopy.milieu.noir);

  await L.sleep(4000);

  const stop = await cdp.evJson("(" + L.JS_REC_STOP.toString() + ")()", true);
  L.say("REC_STOP " + L.json(stop));
  await L.sleep(1500);

  ev.segments = A.analyseRecording("teminin-");

  const state = await cdp.evJson(L.JS_POC_STATE);
  ev.phases.push({ phase: "temoin", events: state.events, t: state.t });

  fs.mkdirSync(L.OUT, { recursive: true });
  const log = L.adbTry(["logcat", "-d", "-v", "time"]);
  L.ecrireLogcat("teminin-logcat", log);

  fs.writeFileSync(path.join(L.OUT, "rapport-temoin.json"), JSON.stringify(ev, null, 2));
  fs.writeFileSync(path.join(L.OUT, "teminin-console.txt"), L.logLines.join("\n"));
  L.say("RAPPORT " + path.join(L.OUT, "rapport-temoin.json"));

  cdp.close();
  L.say("=== fin temoin ===");
}

main().catch((e) => {
  L.say("ERREUR " + e.message);
  try {
    fs.mkdirSync(L.OUT, { recursive: true });
    fs.writeFileSync(path.join(L.OUT, "rapport-temoin.json"), JSON.stringify(ev, null, 2));
    fs.writeFileSync(path.join(L.OUT, "teminin-console.txt"), L.logLines.join("\n"));
  } catch (e2) {}
  process.exit(1);
});
