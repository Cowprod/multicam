/* J09 POC — PHASE 4 : le PixelCopy noir est-il dû au switch, ou à la caméra FRONT ?
 *
 * LA PHASE 3 A MONTRÉ : PixelCopy noir sur les sondes « avant switch » n°1 et
 * n°3 — c'est-à-dire des sondes prises SANS qu'un switch vienne de les précéder.
 * Donc « la preview est morte après le switch » n'explique pas tout : la
 * caméra FRONT elle-même pourrait renvoyer une image noire.
 *
 * Cette phase enlève le switch de l'équation : on démarre une session en
 * REAR, on bascule une fois, on rebascule, et on sonde à chaque étape. Si REAR
 * est toujours lisible et FRONT toujours noir, le switch n'est pas en cause :
 * c'est la caméra front qu'il faut interroger séparément (capteur, orientation,
 * ou simple absence d'image sur ce device).
 *
 * On compare aussi l'IMAGE ENREGISTRÉE (la piste vidéo du MP4) et non seulement
 * PixelCopy : si le REC FRANT contient de vraies images, alors le problème est
 * propre à PixelCopy et non à la caméra.
 */

"use strict";

const L = require("./lib.js");
const A = require("./analyse.js");
const fs = require("fs");
const path = require("path");

async function main() {
  L.say("=== POC J09 — phase 4 : REAR vs FRONT, sans switch pendant le REC ===");
  L.say("media_hors_depot=" + L.MEDIA);

  L.coldStart();
  const cdp = await L.attach("capture");
  try { L.adb(["logcat", "-c"]); } catch (e) {}
  L.say("PURGE_CACHE " + L.purgeCacheRecordings());

  let ready = false;
  for (let i = 0; i < 40; i++) {
    const v = await cdp.ev("(function(){return !!(window.cordova && window.CameraPreview "
      + "&& typeof CameraPreview.startCamera === 'function')})()");
    if (v === true) { ready = true; break; }
    await L.sleep(600);
  }
  if (!ready) throw new Error("CameraPreview jamais exposé");

  const prep = await cdp.evJson("(" + L.JS_PREPARE.toString() + ")('back')", true);
  L.say("PREPARE " + L.json(prep));
  await L.sleep(1500);

  const rec = await cdp.evJson("(" + L.JS_REC_START.toString() + ")(null)", true);
  L.say("REC_START " + L.json(rec));
  if (!rec.ok) throw new Error("REC impossible: " + rec.reason);
  await L.sleep(4000);

  const etapes = [];
  async function sonde(tag, attendu) {
    const p = await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('" + tag + "')", true);
    const j = A.judgeJpeg(p.base64, tag + ".jpg");
    const l = {
      etape: tag, cameraAttendue: attendu,
      pixelcopyOk: p.ok, raison: p.reason || null,
      luma: j.lumaMoyenne, noir: j.noir, octets: j.octets
    };
    etapes.push(l);
    L.say("SONDE " + L.json(l));
    return l;
  }

  await sonde("p4-rear-avant-switch-1", "rear");

  const sw1 = await cdp.evJson("(" + L.JS_SWITCH.toString() + ")()", true);
  L.say("SWITCH_1 " + L.json(sw1));
  await L.sleep(3000);
  await sonde("p4-apres-switch-vers-front", "front");

  await L.sleep(3000);
  await sonde("p4-front-stabilise", "front");

  const sw2 = await cdp.evJson("(" + L.JS_SWITCH.toString() + ")()", true);
  L.say("SWITCH_2 " + L.json(sw2));
  await L.sleep(3000);
  await sonde("p4-retour-vers-rear", "rear");

  await L.sleep(2000);
  const stop = await cdp.evJson("(" + L.JS_REC_STOP.toString() + ")()", true);
  L.say("REC_STOP " + L.json(stop));
  await L.sleep(1500);

  const segs = A.analyseRecording("p4-");
  L.say("SEGMENTS " + L.json(segs));

  /* Le point décisif : extraire des images de la piste vidéo du MP4 et mesurer
   * leur luminance. Si le segment contient des frames lisibles alors que
   * PixelCopy dit "noir", le défaut est dans PixelCopy. Si les frames sont
   * toutes noires, c'est la caméra front qui ne produit rien. */
  const framesVideo = [];
  for (const s of segs) {
    if (!s.pisteVideoPresente) continue;
    const f = L.extractFrameLuma(s.mediaHorsDepot, [0.2, 0.5, 0.8, 0.95]);
    framesVideo.push({ fichier: path.basename(s.mediaHorsDepot), lumas: f });
  }
  L.say("FRAMES_VIDEO " + L.json(framesVideo));

  const state = await cdp.evJson(L.JS_POC_STATE);
  L.ev.phases.push({ phase: "phase4-rear-vs-front", etapes: etapes, framesVideo: framesVideo, events: state.events });

  fs.mkdirSync(L.OUT, { recursive: true });
  fs.writeFileSync(path.join(L.OUT, "rapport-phase4.json"), JSON.stringify(L.ev, null, 2));
  fs.writeFileSync(path.join(L.OUT, "phase4-console.txt"), L.logLines.join("\n"));
  L.ecrireLogcat("phase4-logcat", L.adbTry(["logcat", "-d", "-v", "time"]));

  L.say("");
  L.say("--- synthèse phase 4 ---");
  for (const e of etapes) {
    L.say("  " + e.etape + " (attendu " + e.cameraAttendue + ") : luma=" + e.luma + " noir=" + e.noir
      + (e.raison ? " raison=" + e.raison : ""));
  }
  L.say("  lumas des frames du MP4 : " + L.json(framesVideo));
  L.say("RAPPORT " + path.join(L.OUT, "rapport-phase4.json"));
  cdp.close();
  L.say("=== fin phase 4 ===");
}

main().catch((e) => {
  L.say("ERREUR " + e.message);
  try {
    fs.mkdirSync(L.OUT, { recursive: true });
    fs.writeFileSync(path.join(L.OUT, "rapport-phase4.json"), JSON.stringify(L.ev, null, 2));
    fs.writeFileSync(path.join(L.OUT, "phase4-console.txt"), L.logLines.join("\n"));
    L.ecrireLogcat("phase4-logcat", L.adbTry(["logcat", "-d", "-v", "time"]));
  } catch (e2) {}
  process.exit(1);
});
