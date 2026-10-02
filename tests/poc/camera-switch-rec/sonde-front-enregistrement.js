/* J09 POC — SONDE DÉCISIVE : la caméra FRONT est-elle morte, ou seulement
 * inexploitable à l'ENREGISTREMENT ?
 *
 * LE CONTRADICTOIRE À TRANCHER
 * ---------------------------
 * Même caméra (cameraId 1, vérifié par `cameraCurrentlyLocked:1` dans le logcat
 * de la phase 5) :
 *   - phase 5 : ouverte par `startCamera(camera:"front")`, puis REC → preview
 *     NOIRE et fichier vidéo 100 % noir ;
 *   - sonde preview : ouverte par `switchCamera()`, SANS REC → preview VIVANTE
 *     (luma 95, JPEG de 75 Ko variant d'une sonde à l'autre).
 *
 * La seule variable qui diffère est la présence d'un MediaRecorder attaché à
 * cette caméra. D'où la question : le front est-il mort, ou filmant en preview
 * mais noir dès qu'on enregistre ?
 *
 * PROTOCOLE — trois fenêtres, une seule variable changeante
 * -------------------------------------------------------
 *   C. caméra 1 ouverte, AUCUN REC          → le front filme en preview ?
 *   D. caméra 1 ouverte, REC DÉMARRÉ        → le front noircit-il ?
 *   E. REC arrêté, toujours caméra 1       → la preview redevient-elle vivante ?
 *
 * Si C est vivant, D est noir et E redevient vivant, alors la caméra front
 * n'est PAS morte : c'est l'enregistrement Camera1+MediaRecorder depuis cette
 * caméra qui produit du noir. C'est une panne d'enregistrement, pas une panne
 * matérielle — deux conclusions très différentes pour la suite.
 */

"use strict";

const L = require("./lib.js");
const A = require("./analyse.js");
const C = require("./chronologie.js");
const fs = require("fs");
const path = require("path");

async function sonde(cdp, tag, nombre, intervalleMs) {
  const out = [];
  for (let i = 0; i < nombre; i++) {
    const pc = await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('" + tag + "-" + i + "')", true);
    const nom = tag + "-" + i + ".jpg";
    const j = A.judgeJpeg(pc.base64, nom);
    out.push({ i, ok: pc.ok, raison: pc.reason || null, noir: j.noir,
      luma: j.lumaMoyenne, octets: j.octets });
    L.say("  " + nom + " ok=" + pc.ok + " luma=" + j.lumaMoyenne
      + " octets=" + j.octets + (pc.reason ? " raison=" + pc.reason : ""));
    if (i + 1 < nombre) await L.sleep(intervalleMs);
  }
  return out;
}

function resume(out) {
  const ok = out.filter((x) => x.ok);
  if (!ok.length) return "aucune image reussie";
  const lumas = ok.map((x) => x.luma);
  return {
    n: ok.length,
    lumaMin: Math.min.apply(null, lumas),
    lumaMax: Math.max.apply(null, lumas),
    octetsMin: Math.min.apply(null, ok.map((x) => x.octets)),
    tousNoirs: lumas.every((l) => l !== null && l < 8),
    etat: lumas.every((l) => l !== null && l < 8) ? "NOIR" : "VIVANT"
  };
}

async function main() {
  L.say("=== POC J09 — sonde FRONT : morte, ou noire seulement en enregistrement ? ===");
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

  /* Ouverture explicite du FRONT, sans passer par un switch. */
  const prep = await cdp.evJson("(" + L.JS_PREPARE.toString() + ")('front')", true);
  L.say("PREPARE " + L.json(prep));
  await L.sleep(3000);

  const r = {};

  /* ---- C. sans REC ---- */
  L.say("");
  L.say("--- C. caméra 1 ouverte, AUCUN REC ---");
  r.C_sansRec = { sondes: await sonde(cdp, "sf-C-sansrec", 3, 800) };
  r.C_sansRec.resume = resume(r.C_sansRec.sondes);
  L.say("  => " + JSON.stringify(r.C_sansRec.resume));

  /* ---- D. avec REC ---- */
  L.say("");
  L.say("--- D. REC démarré sur la caméra 1 ---");
  L.say("PURGE_CACHE " + L.purgeCacheRecordings());
  const rec = await cdp.evJson("(" + L.JS_REC_START.toString() + ")(null)", true);
  L.say("  REC_START " + L.json(rec));
  if (!rec.ok) throw new Error("REC impossible: " + rec.reason);
  await L.sleep(4000);
  r.D_avecRec = { sondes: await sonde(cdp, "sf-D-avecrec", 3, 800) };
  r.D_avecRec.resume = resume(r.D_avecRec.sondes);
  L.say("  => " + JSON.stringify(r.D_avecRec.resume));

  const stop = await cdp.evJson("(" + L.JS_REC_STOP.toString() + ")()", true);
  L.say("  REC_STOP ok=" + stop.ok + (stop.reason ? " raison=" + stop.reason : ""));
  await L.sleep(3000);

  /* ---- E. REC arrêté, toujours caméra 1 ---- */
  L.say("");
  L.say("--- E. REC arrêté, toujours caméra 1 ---");
  r.E_apresRec = { sondes: await sonde(cdp, "sf-E-apresrec", 3, 800) };
  r.E_apresRec.resume = resume(r.E_apresRec.sondes);
  L.say("  => " + JSON.stringify(r.E_apresRec.resume));

  /* ---- le fichier produit par D ---- */
  const segs = A.analyseRecording("sf-");
  r.segment = segs[0] || null;
  if (r.segment) {
    L.say("");
    L.say("  segment : video=" + (r.segment.video ? r.segment.video.dureeSec + "s" : "ABSENTE")
      + " audio=" + (r.segment.audio ? r.segment.audio.dureeSec + "s" : "aucun")
      + " verdict=" + r.segment.verdictVideo);
    if (r.segment.pisteVideoPresente) {
      r.frames = L.extractFrameLuma(r.segment.mediaHorsDepot, [0.1, 0.3, 0.5, 0.7, 0.9]);
      L.say("  lumas des frames du fichier FRONT : " + L.json(r.frames.map((f) => f.luma)));
    }
  }

  /* ---- quelle caméra était réellement ouverte ? ---- */
  const logcat = L.adbTry(["logcat", "-d", "-v", "time"]);
  const entrees = C.parse(logcat);
  const ouvert = C.marqueurs(entrees, /CameraActivity .*cameraCurrentlyLocked:/);
  r.cameraOuverteAuDepart = ouvert.map((t) => new Date(t).toISOString());
  r.cameraCurrentlyLocked = ouvert.length ? ouvert.length : 0;
  const dernier = C.marqueur(entrees, /CameraActivity .*cameraCurrentlyLocked:/,
    Math.max.apply(null, ouvert) - 60000, Math.max.apply(null, ouvert) + 1000);
  L.say("");
  L.say("  cameraCurrentlyLocked annonce au demarrage : "
    + (dernier === null ? "inconnu" : dernier));

  r.verdict = verdict(r);
  L.say("");
  L.say("--- verdict ---");
  L.say("  C sans REC      : " + r.C_sansRec.resume.etat);
  L.say("  D avec REC      : " + r.D_avecRec.resume.etat);
  L.say("  E apres REC     : " + r.E_apresRec.resume.etat);
  L.say("  fichier FRONT   : " + (r.segment && r.segment.verdictVideo));
  L.say("");
  L.say("  " + r.verdict.conclusion);

  L.ev.sondeFront = r;
  fs.mkdirSync(L.OUT, { recursive: true });
  fs.writeFileSync(path.join(L.OUT, "rapport-sonde-front.json"), JSON.stringify(L.ev, null, 2));
  fs.writeFileSync(path.join(L.OUT, "sonde-front-console.txt"), L.logLines.join("\n"));
  L.ecrireLogcat("sonde-front-logcat", logcat);
  L.say("RAPPORT " + path.join(L.OUT, "rapport-sonde-front.json"));
  cdp.close();
  L.say("=== fin sonde front ===");
}

function verdict(r) {
  const c = r.C_sansRec.resume.etat;
  const d = r.D_avecRec.resume.etat;
  const e = r.E_apresRec.resume.etat;
  const fichierNoir = !r.frames || r.frames.every((f) => f.luma !== null && f.luma < 8);

  if (c === "VIVANT" && d === "NOIR" && fichierNoir) {
    return {
      cameraMorte: false,
      conclusion: "la caméra FRONT FILME en preview mais produit du NOIR dès qu'un "
        + "MediaRecorder s'y attache. Ce n'est pas une caméra morte : c'est une "
        + "incapacité à ENREGISTRER cette caméra sur cette pile.",
      frontEnregistrable: false
    };
  }
  if (c === "VIVANT" && d === "VIVANT" && fichierNoir) {
    return {
      cameraMorte: false,
      conclusion: "la preview front est vivante ET reste vivante pendant le REC, mais le "
        + "FICHIER est noir : l'enregistrement ne reçoit rien alors que la preview oui.",
      frontEnregistrable: false
    };
  }
  if (c === "NOIR") {
    return {
      cameraMorte: true,
      conclusion: "la caméra FRONT est noire même en preview seule : panne materielle "
        + "ou firmware, indépendante de l'enregistrement.",
      frontEnregistrable: false
    };
  }
  return {
    cameraMorte: false,
    conclusion: "combinaison inattendue (C=" + c + ", D=" + d + ", E=" + e
      + ") : à analyser avant toute conclusion.",
    frontEnregistrable: false
  };
}

main().catch((e) => {
  L.say("ERREUR " + e.message);
  try {
    fs.mkdirSync(L.OUT, { recursive: true });
    fs.writeFileSync(path.join(L.OUT, "rapport-sonde-front.json"), JSON.stringify(L.ev, null, 2));
    fs.writeFileSync(path.join(L.OUT, "sonde-front-console.txt"), L.logLines.join("\n"));
  } catch (e2) {}
  process.exit(1);
});
