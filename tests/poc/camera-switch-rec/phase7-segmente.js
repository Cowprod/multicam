/* J09 POC — PHASE 7 : LE VRAI SCÉNARIO SEGMENTÉ.
 *
 * Ce que les phases précédentes ont établi : changer de caméra PENDANT qu'un
 * MediaRecorder écrit tue la piste vidéo (~300 ms après le switch), l'audio
 * continue. La stratégie techniquement probable est donc l'inverse : ne jamais
 * faire cohabiter un switch et un recorder actif.
 *
 * SÉQUENCE MESURÉE, avec les actions EXISTANTES du produit uniquement
 * ------------------------------------------------------------------
 *   stopRecordVideo   → le recorder est arrêté, le fichier est scellé,
 *                       la caméra A est RE-LOCKÉE par le plugin
 *   switchCamera      → libère A, ouvre B, relance la preview
 *   startRecordVideo  → verrouille B et ouvre un NOUVEAU segment
 *
 * Le plugin fait déjà tout cela dans cet ordre : `stopRecord()` relâche puis
 * re-verrouille la caméra et relance la preview (CameraActivity:976), et
 * `switchCamera()` libère/ouvre (CameraActivity:375). Aucune modification de
 * code produit n'est nécessaire pour tester cette stratégie.
 *
 * MESURES EXIGÉES, PAR TRANSITION
 * --------------------------------
 *   t_demande_switch      t_stop_recorder_A     t_dernier_video_A
 *   t_dernier_audio_A     t_camera_A_release    t_camera_B_open
 *   t_preview_B_visible   t_recorder_B_start    t_recorder_B_ack
 *   t_premier_video_B     t_premier_audio_B     t_premier_PixelCopy_B
 *
 * puis : trou vidéo entre segments, trou audio entre segments, interruption de
 * preview, délai avant premier JPEG de la nouvelle caméra, durée totale.
 *
 * Les instants « dernier_video », « premier_video », « dernier_audio » et
 * « premier_audio » sont déduits du FICHIER, pas du logcat : on replaque les
 * PTS sur l'axe mural à l'aide du décalage de muxage mesuré par segment. C'est
 * la seule façon de dater ce qui est réellement écrit, et non ce qui est
 * demandé.
 *
 * AUCUNE fusion de MP4 : on veut les segments BRUTS.
 * AUCUNE modification de code produit.
 */

"use strict";

const L = require("./lib.js");
const A = require("./analyse.js");
const C = require("./chronologie.js");
const fs = require("fs");
const path = require("path");

const DUREE_SEGMENT_MS = Number(process.env.POC_PHASE7_SEG_MS || 6000);
/* Stabilisation AVANT le nouveau REC. Ce délai est un artefact de protocole :
 * il gonfle le trou mesure entre segments. On le met a 0 pour mesurer le
 * meilleur cas reellement atteignable par une strategie produit qui
 * enchainerait stop -> switch -> start sans attendre. */
const STABILISATION_MS = Number(process.env.POC_PHASE7_STAB_MS || 2500);
const PREFIXE = process.env.POC_PHASE7_TAG || "p7-";

/* Sonde PixelCopy : mesure le PREMIER JPEG de la caméra courante et note
 * l'instant où elle réussit. */
async function pixelcopy(cdp, tag) {
  const pc = await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('" + tag + "')", true);
  const j = A.judgeJpeg(pc.base64, tag + ".jpg");
  return { atMs: pc.atMs, ok: pc.ok, raison: pc.reason || null,
    noir: j.noir, luma: j.lumaMoyenne, octets: j.octets };
}

/* Un segment : REC, quelques secondes, arrêt, analyse immédiate.
 *
 * La purge AVANT chaque REC est indispensable : le plugin réutilise le nom
 * `videoTmp.mp4`, et sans purge l'analyse du segment suivant retirerait le
 * fichier du segment précédent (bug déjà rencontré deux fois dans ce POC). */
async function segment(cdp, tag, camera) {
  L.say("");
  L.say("--- segment " + tag + " (camera=" + camera + ") ---");
  L.say("PURGE_CACHE " + L.purgeCacheRecordings());

  const rec = await cdp.evJson("(" + L.JS_REC_START.toString() + ")(null)", true);
  L.say("  REC_START " + L.json(rec));
  if (!rec.ok) {
    return { tag, camera, recOk: false, raison: rec.reason, rec };
  }

  await L.sleep(DUREE_SEGMENT_MS);
  const pc = await pixelcopy(cdp, tag + "-pixelcopy");

  const stop = await cdp.evJson("(" + L.JS_REC_STOP.toString() + ")()", true);
  L.say("  REC_STOP " + L.json(stop));
  await L.sleep(1500);

  const segs = A.analyseRecording(tag + "-");
  const s = segs[0] || null;
  L.say("  segment : " + (s
    ? "video=" + (s.video ? s.video.dureeSec + "s" : "ABSENTE")
      + " audio=" + (s.audio ? s.audio.dureeSec + "s" : "aucun")
      + " verdict=" + s.verdictVideo + " octets=" + s.octets
    : "AUCUN FICHIER PRODUIT"));

  return {
    tag, camera,
    recOk: true,
    rec: { requestMs: rec.requestMs, ackMs: rec.atMs, ackAfterMs: rec.ackAfterMs },
    pixelcopy: pc,
    stop: { ok: stop.ok, raison: stop.reason || null, atMs: stop.atMs, apresMs: stop.afterMs || null },
    recWallMs: stop.atMs - rec.requestMs,
    segment: s
  };
}

/* Replacer les PTS d'un segment sur l'axe mural.
 *
 * Le muxer MediaRecorder ne scelle pas sa file au fil de l'eau : au stop il
 * écrit encore environ 1,5 s de données déjà capturées. On mesure donc le
 * décalage `recWall - dureeAudio` et on l'ajoute aux PTS. Sans cette correction,
 * un segment paraît s'arrêter 1,5 s avant sa fin réelle — et le « trou » entre
 * deux segments serait faussé d'autant. */
function ancrer(seg) {
  const s = seg.segment;
  if (!s || !s.audio || !seg.recWallMs) return null;
  const offsetMs = seg.recWallMs - s.audio.dureeSec * 1000;
  const cv = s.continuiteVideo || {};
  const ca = s.continuiteAudio || {};
  return {
    decalageMuxMs: Math.round(offsetMs),
    /* Dernier instant réel d'écriture, vidéo et audio. */
    dernierVideoMurMs: cv.lastPts === undefined ? null : Math.round(seg.rec.ackMs + offsetMs + cv.lastPts * 1000),
    premierVideoMurMs: cv.firstPts === undefined ? null : Math.round(seg.rec.ackMs + offsetMs + cv.firstPts * 1000),
    dernierAudioMurMs: ca.lastPts === undefined ? null : Math.round(seg.rec.ackMs + offsetMs + ca.lastPts * 1000),
    premierAudioMurMs: ca.firstPts === undefined ? null : Math.round(seg.rec.ackMs + offsetMs + ca.firstPts * 1000),
    nbFrames: cv.frames || null,
    fpsMoyen: cv.fpsMoyen || null
  };
}

async function main() {
  L.say("=== POC J09 — phase 7 : vrai scenario segmente REAR -> FRONT -> REAR ===");
  L.say("duree par segment : " + (DUREE_SEGMENT_MS / 1000) + " s");
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
  await L.sleep(2500);

  const segments = [];
  const transitions = [];

  /* ---------- segment A : REAR ---------- */
  segments.push(await segment(cdp, PREFIXE + "A-rear", "rear"));
  if (!segments[0].recOk) throw new Error("segment A impossible: " + segments[0].raison);

  /* ---------- transition A -> B : REAR vers FRONT ---------- */
  L.say("");
  L.say("=== TRANSITION 1 : arret du recorder A, switch REAR -> FRONT, demarrage recorder B ===");
  const tSwitch1Req = Date.now();
  const sw1 = await cdp.evJson("(" + L.JS_SWITCH.toString() + ")()", true);
  L.say("  SWITCH ok=" + sw1.ok + " apresMs=" + sw1.afterMs);
  await L.sleep(STABILISATION_MS);

  const pcB1 = await pixelcopy(cdp, PREFIXE + "B-front-premiere");
  L.say("  premier PixelCopy B : ok=" + pcB1.ok + " apresSwitchMs=" + (pcB1.atMs - sw1.requestedAtMs)
    + " luma=" + pcB1.luma + " noir=" + pcB1.noir + (pcB1.raison ? " raison=" + pcB1.raison : ""));

  segments.push(await segment(cdp, PREFIXE + "B-front", "front"));
  transitions.push({
    nom: "REAR vers FRONT",
    tDemandeSwitchMs: tSwitch1Req,
    switchJs: sw1,
    arretRecorderA: { ok: segments[0].stop.ok, atMs: segments[0].stop.atMs, apresMs: segments[0].stop.apresMs },
    premierPixelCopyB: { atMs: pcB1.atMs, apresSwitchMs: pcB1.atMs - sw1.requestedAtMs,
      ok: pcB1.ok, raison: pcB1.raison || null, luma: pcB1.luma, noir: pcB1.noir }
  });
  if (!segments[1].recOk) throw new Error("segment B impossible: " + segments[1].raison);

  /* ---------- transition B -> C : FRONT vers REAR ---------- */
  L.say("");
  L.say("=== TRANSITION 2 : arret du recorder B, switch FRONT -> REAR, demarrage recorder C ===");
  const tSwitch2Req = Date.now();
  const sw2 = await cdp.evJson("(" + L.JS_SWITCH.toString() + ")()", true);
  L.say("  SWITCH ok=" + sw2.ok + " apresMs=" + sw2.afterMs);
  await L.sleep(STABILISATION_MS);

  const pcC1 = await pixelcopy(cdp, PREFIXE + "C-rear-premiere");
  L.say("  premier PixelCopy C : ok=" + pcC1.ok + " apresSwitchMs=" + (pcC1.atMs - sw2.requestedAtMs)
    + " luma=" + pcC1.luma + " noir=" + pcC1.noir + (pcC1.raison ? " raison=" + pcC1.raison : ""));

  segments.push(await segment(cdp, PREFIXE + "C-rear", "rear"));
  transitions.push({
    nom: "FRONT vers REAR",
    tDemandeSwitchMs: tSwitch2Req,
    switchJs: sw2,
    arretRecorderB: { ok: segments[1].stop.ok, atMs: segments[1].stop.atMs, apresMs: segments[1].stop.apresMs },
    premierPixelCopyC: { atMs: pcC1.atMs, apresSwitchMs: pcC1.atMs - sw2.requestedAtMs,
      ok: pcC1.ok, raison: pcC1.raison || null, luma: pcC1.luma, noir: pcC1.noir }
  });
  if (!segments[2].recOk) throw new Error("segment C impossible: " + segments[2].raison);

  /* ---------- chronologie complète ---------- */
  await L.sleep(1000);
  const logcat = L.adbTry(["logcat", "-d", "-v", "time"]);
  const entrees = C.parse(logcat);

  const bornes = {
    t0: segments[0].rec.requestMs - 5000,
    t1: Date.now() + 5000
  };

  /* Tous les marqueurs natifs, en une seule passe, puis rangés par transition. */
  const seq = {
    startingRecording: C.marqueurs(entrees, /CameraActivity .*Starting recording/, bornes.t0, bornes.t1),
    stopRecord: C.marqueurs(entrees, /CameraActivity .*stopRecord$/, bornes.t0, bornes.t1),
    switchEntree: C.marqueurs(entrees, /CameraActivity .*numberOfCameras:/, bornes.t0, bornes.t1),
    cameraRelease: C.marqueurs(entrees, /CameraActivity .*cameraCurrentlyLocked :=/, bornes.t0, bornes.t1),
    cameraNouvelle: C.marqueurs(entrees, /CameraActivity .*cameraCurrentlyLocked new:/, bornes.t0, bornes.t1),
    cameraOuverte: C.marqueurs(entrees, /CameraActivity .*(camera parameter NULL|currentFlashMode)/, bornes.t0, bornes.t1)
  };
  L.say("");
  L.say("MARQUEURS_NATIFS " + L.json(seq));

  /* Chaque transition est attributionnée au switch le plus proche AVANT elle.
   * Sans ce bornage, un marqueur d'une transition serait attribué à une autre
   * — c'est le piège du cache périmé, appliqué à la chronologie. */
  const swDemandes = [sw1.requestedAtMs, sw2.requestedAtMs].sort((a, b) => a - b);
  const avant = (t, i) => swDemandes.filter((x) => x <= t).slice(0, i + 1)[i];
  for (let i = 0; i < transitions.length; i++) {
    const d = swDemandes[i];
    const borne = swDemandes[i + 1] === undefined ? bornes.t1 : swDemandes[i + 1];
    const T = transitions[i];
    const prochain = (liste) => {
      const v = liste.filter((x) => x >= d - 500 && x <= (borne === bornes.t1 ? d + 20000 : borne));
      return v.length ? v[0] : null;
    };
    T.natif = {
      tCameraARelease: prochain(seq.cameraRelease),
      tCameraANouvelle: prochain(seq.cameraNouvelle),
      tCameraBOuverte: prochain(seq.cameraOuverte),
      tSwitchEntreeNative: prochain(seq.switchEntree)
    };
    for (const k in T.natif) {
      T.natif[k + "Relatif"] = T.natif[k] === null ? null : T.natif[k] - d;
    }
    L.say("  transition " + (i + 1) + " " + T.nom + " : release A a "
      + T.natif.tCameraAReleaseRelatif + " ms, camera B ouverte a "
      + T.natif.tCameraBOuverteRelatif + " ms apres la demande de switch");
  }

  /* ---------- trous entre segments ---------- */
  const ancrages = segments.map(ancrer);
  const trous = [];
  for (let i = 0; i + 1 < segments.length; i++) {
    const a = segments[i], b = segments[i + 1];
    const aa = ancrages[i], bb = ancrages[i + 1];
    const tr = {
      de: a.tag, vers: b.tag,
      cameraA: a.camera, cameraB: b.camera,
      murEntreSegmentsMs: b.rec.requestMs - a.stop.atMs,
      trouVideoMs: (aa && bb && aa.dernierVideoMurMs !== null && bb.premierVideoMurMs !== null)
        ? bb.premierVideoMurMs - aa.dernierVideoMurMs : null,
      trouAudioMs: (aa && bb && aa.dernierAudioMurMs !== null && bb.premierAudioMurMs !== null)
        ? bb.premierAudioMurMs - aa.dernierAudioMurMs : null,
      /* Délai avant le premier JPEG de la caméra suivante : c'est ce que la
       * régie voit réellement, et non « l'image est » en temps réel. */
      delaiPremierJPEGBMs: null
    };
    const sw = swDemandes[i];
    const pc = (i === 0 ? transitions[0].premierPixelCopyB : transitions[1].premierPixelCopyC);
    tr.delaiPremierJPEGBMs = pc ? pc.atMs - sw : null;
    trous.push(tr);
    L.say("");
    L.say("  TROU " + a.tag + " -> " + b.tag);
    L.say("    mur entre la fin de A et le debut de B : " + tr.murEntreSegmentsMs + " ms");
    L.say("    trou VIDEO : " + tr.trouVideoMs + " ms");
    L.say("    trou AUDIO : " + tr.trouAudioMs + " ms");
    L.say("    delai avant premier JPEG caméra B : " + tr.delaiPremierJPEGBMs + " ms");
  }

  const etat = await cdp.evJson(L.JS_POC_STATE);
  L.ev.phases.push({
    phase: "phase7-scenario-segmente",
    protocole: { dureeSegmentMs: DUREE_SEGMENT_MS, stabilisationMs: STABILISATION_MS },
    segments, transitions, trous, marqueursNatifs: seq, events: etat.events
  });

  fs.mkdirSync(L.OUT, { recursive: true });
  const nomRapport = PREFIXE === "p7-" ? "rapport-phase7.json" : "rapport-" + PREFIXE.replace(/-/g, "") + ".json";
  const nomConsole = PREFIXE === "p7-" ? "phase7-console.txt" : PREFIXE + "console.txt";
  const nomLogcat = PREFIXE === "p7-" ? "phase7-logcat" : PREFIXE + "logcat";
  fs.writeFileSync(path.join(L.OUT, nomRapport), JSON.stringify(L.ev, null, 2));
  fs.writeFileSync(path.join(L.OUT, nomConsole), L.logLines.join("\n"));
  L.ecrireLogcat(nomLogcat, logcat);

  L.say("");
  L.say("--- synthèse phase 7 ---");
  for (const s of segments) {
    L.say("  " + s.tag + " (" + s.camera + ") : "
      + (s.segment && s.segment.pisteVideoPresente
        ? "video " + s.segment.video.dureeSec + "s, " + s.segment.continuiteVideo.frames + " frames"
        : "AUCUNE PISTE VIDEO")
      + " | audio " + (s.segment && s.segment.audio ? s.segment.audio.dureeSec + "s" : "aucun")
      + " | stop " + (s.stop.ok ? "OK" : "ECHEC " + s.stop.raison));
  }
  L.say("RAPPORT " + path.join(L.OUT, nomRapport));
  cdp.close();
  L.say("=== fin phase 7 ===");
}

main().catch((e) => {
  L.say("ERREUR " + e.message);
  try {
    fs.mkdirSync(L.OUT, { recursive: true });
    fs.writeFileSync(path.join(L.OUT, "rapport-phase7.json"), JSON.stringify(L.ev, null, 2));
    fs.writeFileSync(path.join(L.OUT, "phase7-console.txt"), L.logLines.join("\n"));
  } catch (e2) {}
  process.exit(1);
});
