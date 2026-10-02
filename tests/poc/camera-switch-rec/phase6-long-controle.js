/* J09 POC — PHASE 6 : SCÉNARIO LONG CONTRÔLÉ.
 *
 * Question à laquelle cette phase répond, et qui n'a PAS été traitée par les
 * phases 1 à 5 : que fait le FICHIER DÉJÀ OUVERT quand la demande de changement
 * de caméra arrive ?
 *
 * Les phases précédentes permettaient de dater la mort de la vidéo (~300 ms
 * après le switch) et de constater que l'audio continuait. Elles ne disent pas
 * si le fichier se referme proprement, s'il reste réparable, ni ce que devient
 * un enregistrement long. Ici on impose des fenêtres longues et un arrêt propre.
 *
 * Protocole imposé :
 *   REAR → REC → ≥ 12 s → switchCamera → ≥ 12 s → stopRecordVideo
 *
 * Les fenêtres sont de 12 s et non 10 s : on veut que le switch soit À L'INTÉRIEUR
 * de l'enregistrement, avec de la marge des deux côtés, pas collé au début ou à
 * la fin où un fichier tronqué pourrait passer pour un REC volontairement court.
 *
 * AUCUNE modification de code produit.
 */

"use strict";

const L = require("./lib.js");
const A = require("./analyse.js");
const C = require("./chronologie.js");
const fs = require("fs");
const path = require("path");

const AVANT = Number(process.env.POC_PHASE6_AVANT_MS || 12000);
const APRES = Number(process.env.POC_PHASE6_APRES_MS || 12000);
const TAG = "p6-long-";

async function main() {
  L.say("=== POC J09 — phase 6 : scénario long contrôlé ===");
  L.say("fenêtres : " + (AVANT / 1000) + " s avant le switch, " + (APRES / 1000) + " s après");
  L.say("media_hors_depot=" + L.MEDIA);

  L.coldStart();
  const cdp = await L.attach("capture");
  try { L.adb(["logcat", "-c"]); } catch (e) {}
  L.say("PURGE_CACHE " + L.purgeCacheRecordings());

  let ready = false;
  for (let i = 0; i < 40; i++) {
    const v = await cdp.ev("(function(){return !!(window.cordova && window.CameraPreview "
      + "&& typeof CameraPreview.startCamera === 'function' "
      + "&& typeof CameraPreview.getCaptureCapabilities === 'function')})()");
    if (v === true) { ready = true; break; }
    await L.sleep(600);
  }
  if (!ready) throw new Error("CameraPreview jamais exposé");
  L.say("PLUGIN_PRETE");

  const prep = await cdp.evJson("(" + L.JS_PREPARE.toString() + ")('back')", true);
  L.say("PREPARE " + L.json(prep));
  await L.sleep(2000);

  /* ---------- REC ---------- */
  const rec = await cdp.evJson("(" + L.JS_REC_START.toString() + ")(null)", true);
  L.say("REC_START " + L.json(rec));
  if (!rec.ok) throw new Error("REC impossible: " + rec.reason);
  const tRecAck = rec.atMs;
  const tRecReq = rec.requestMs;

  /* ---------- fenêtre AVANT : ≥ 10 s ---------- */
  L.say("--- " + (AVANT / 1000) + " s d'enregistrement REAR avant le switch ---");
  const jpegAvant = await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('p6-avant')", true);
  const j1 = A.judgeJpeg(jpegAvant.base64, "p6-01-avant.jpg");
  L.say("PIXELCOPY_AVANT ok=" + jpegAvant.ok + " noir=" + j1.noir + " luma=" + j1.lumaMoyenne);
  await L.sleep(AVANT - 2000);

  /* ---------- demande de switch ---------- */
  const sw = await cdp.evJson("(" + L.JS_SWITCH.toString() + ")()", true);
  L.say("SWITCH " + L.json(sw));
  const tSwitchReq = sw.requestedAtMs;
  const tSwitchAck = sw.atMs;

  /* PixelCopy immédiatement après le switch : premier JPEG de la nouvelle
   * caméra. C'est le délai mesuré au point 9 du cahier des charges. */
  const pc0 = await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('p6-immediat')", true);
  const j0 = A.judgeJpeg(pc0.base64, "p6-02-immediat.jpg");
  L.say("PIXELCOPY_IMMEDIAT ok=" + pc0.ok + " apresMs=" + pc0.afterMs
    + " noir=" + j0.noir + " luma=" + j0.lumaMoyenne + (pc0.reason ? " raison=" + pc0.reason : ""));

  /* ---------- fenêtre APRÈS : ≥ 10 s ---------- */
  L.say("--- " + (APRES / 1000) + " s d'enregistrement après le switch ---");
  const jalons = [];
  for (const ms of [2000, 5000, 10000]) {
    await L.sleep(ms - (jalons.length ? jalons[jalons.length - 1].attenduMs : 0));
    const pc = await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('p6-" + ms + "')", true);
    const jj = A.judgeJpeg(pc.base64, "p6-03-" + ms + ".jpg");
    jalons.push({ attenduMs: ms, atMs: pc.atMs, apresSwitchMs: pc.atMs - tSwitchAck, ok: pc.ok,
      raison: pc.reason || null, noir: jj.noir, luma: jj.lumaMoyenne });
    L.say("PIXELCOPY_" + ms + " ok=" + pc.ok + " apresSwitchMs=" + (pc.atMs - tSwitchAck)
      + " noir=" + jj.noir + " luma=" + jj.lumaMoyenne + (pc.reason ? " raison=" + pc.reason : ""));
  }
  const reste = APRES - 10000;
  if (reste > 0) await L.sleep(reste);

  /* ---------- arrêt propre ---------- */
  const stop = await cdp.evJson("(" + L.JS_REC_STOP.toString() + ")()", true);
  L.say("REC_STOP " + L.json(stop));
  await L.sleep(2500);

  const segs = A.analyseRecording(TAG);
  L.say("SEGMENTS " + L.json(segs.map((s) => ({
    cache: s.cache, octets: s.octets, sha256: s.sha256, conteneurSec: s.conteneurSec,
    video: s.video, audio: s.audio, verdict: s.verdictVideo, deficit: s.deficitVideoSec
  }))));

  /* ---------- chronologie ---------- */
  const logcat = L.adbTry(["logcat", "-d", "-v", "time"]);
  const entrees = C.parse(logcat);
  const bornes = { t0: tRecReq - 5000, t1: Date.now() + 5000 };
  /* Les marqueurs du switch sont fenatres sur [demande, demande+3 s] : sur toute
   * la session, `Camera started` designait le preview du PREPARE, antérieur au
   * REC, ce qui attribuait au switch une action de plusieurs secondes trop
   * tot. Une fenetre trop large est aussi fausse qu'une fenetre absente. */
  const w0 = tSwitchReq - 500, w1 = tSwitchReq + 3000;
  const natif = {
    stopRecordNatif: C.marqueur(entrees, /CameraActivity .*stopRecord$/, bornes.t0, bornes.t1),
    startingRecordingNatif: C.marqueur(entrees, /CameraActivity .*Starting recording/, bornes.t0, bornes.t1),
    switchEntreeNatif: C.marqueur(entrees, /CameraActivity .*numberOfCameras:/, w0, w1),
    cameraARelease: C.marqueur(entrees, /CameraActivity .*cameraCurrentlyLocked :=/, w0, w1),
    cameraANouvelle: C.marqueur(entrees, /CameraActivity .*cameraCurrentlyLocked new:/, w0, w1),
    cameraBOuverte: C.marqueur(entrees, /CameraActivity .*(camera parameter NULL|currentFlashMode)/, w0, w1),
    previewB: C.marqueur(entrees, /CameraPreview .*Camera started/, w0, w1)
  };
  L.say("CHRONOLOGIE_NATIVE " + L.json(natif));

  const recWallMs = (stop.atMs || Date.now()) - tRecReq;
  const etat = await cdp.evJson(L.JS_POC_STATE);

  const phase = {
    phase: "phase6-long-controle",
    protocole: { cameraDepart: "rear", avantSwitchMs: AVANT, apresSwitchMs: APRES },
    rec: { requestMs: tRecReq, ackMs: tRecAck, ackAfterMs: rec.ackAfterMs, wallMs: recWallMs },
    switch: { requestMs: tSwitchReq, ackMs: tSwitchAck, apresMs: sw.afterMs, ok: sw.ok, raison: sw.reason || null },
    preview: {
      avant: { ok: jpegAvant.ok, noir: j1.noir, luma: j1.lumaMoyenne },
      immediat: { ok: pc0.ok, raison: pc0.reason || null, apresSwitchMs: pc0.atMs - tSwitchAck,
        noir: j0.noir, luma: j0.lumaMoyenne },
      jalons
    },
    stop: { ok: stop.ok, raison: stop.reason || null, atMs: stop.atMs, apresMs: stop.afterMs || null, path: stop.path || null },
    natif,
    events: etat.events
  };

  /* Ce que la phase doit trancher : la mort de la vidéo est-elle due au switch
   * dans un enregistrement long, et l'arrêt reste-t-il propre ? */
  const attribution = [];
  for (const s of segs) {
    const a = L.decaleVideo({
      recWallMs: recWallMs,
      dureeAudioSec: s.audio ? s.audio.dureeSec : null,
      dernierPtsVideoSec: s.continuiteVideo ? s.continuiteVideo.lastPts : null
    });
    if (a.mortVideoMurMs === null) continue;
    attribution.push({
      segment: s.cache,
      decalageMuxMs: a.offsetMuxMs,
      mortVideoMurMs: a.mortVideoMurMs,
      switchMurMs: tSwitchReq - tRecReq,
      mortVideoMoinsSwitchMs: a.mortVideoMurMs - (tSwitchReq - tRecReq)
    });
  }
  phase.attribution = attribution;

  L.ev.phases.push(phase);
  fs.mkdirSync(L.OUT, { recursive: true });
  fs.writeFileSync(path.join(L.OUT, "rapport-phase6.json"), JSON.stringify(L.ev, null, 2));
  fs.writeFileSync(path.join(L.OUT, "phase6-console.txt"), L.logLines.join("\n"));
  L.ecrireLogcat("phase6-logcat", logcat);

  L.say("");
  L.say("--- synthèse phase 6 ---");
  L.say("  switch demandé à t+" + (tSwitchReq - tRecReq) + " ms après la demande de REC");
  L.say("  arrêt propre : " + (stop.ok ? "OK" : "ECHEC (" + stop.reason + ")"));
  for (const a of attribution) {
    L.say("  mort vidéo à t+" + a.mortVideoMurMs + " ms, soit " + a.mortVideoMoinsSwitchMs
      + " ms après le switch");
  }
  L.say("RAPPORT " + path.join(L.OUT, "rapport-phase6.json"));
  cdp.close();
  L.say("=== fin phase 6 ===");
}

main().catch((e) => {
  L.say("ERREUR " + e.message);
  try {
    fs.mkdirSync(L.OUT, { recursive: true });
    fs.writeFileSync(path.join(L.OUT, "rapport-phase6.json"), JSON.stringify(L.ev, null, 2));
    fs.writeFileSync(path.join(L.OUT, "phase6-console.txt"), L.logLines.join("\n"));
  } catch (e2) {}
  process.exit(1);
});
