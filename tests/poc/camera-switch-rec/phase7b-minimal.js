/* J09 POC — PHASE 7b : segmenté MINIMAL.
 *
 * Pourquoi un second script, et pas une option de `phase7-segmente.js` :
 * la phase 7 mesure une stratégie, mais elle intercale entre l'arrêt de A et le
 * démarrage de B une stabilisation, une ATTENTE de 1,5 s et surtout
 * l'analyse/tirage du fichier A (ffprobe + ffdecode + adb, plusieurs secondes).
 * Ce temps n'existe pas dans le produit : personne ne va faire un ffprobe entre
 * deux prises. Les trous mesurés en phase 7 (8,7–9,0 s) sont donc le trou
 * RÉEL + l'outillage du POC, et présenter ça comme un coût produit serait
 * faux. Ce script mesure le trou réel.
 *
 * Séquence par itération, SANS RIEN ENTRE :
 *     stopRecordVideo(A) -> switchCamera -> startRecordVideo(B)
 *
 * Le fichier A n'est ni tiré ni analysé à ce moment. On mémorise le CHEMIN
 * renvoyé par le callback `stopRecordVideo` et on ne récupère les segments
 * qu'une fois la séquence terminée. Sans cela, on mesurerait l'outillage et on
 * le présenterait comme le produit — l'erreur classique de ce type de POC.
 *
 * La sonde PixelCopy est lancée APRÈS le démarrage du recorder B : elle mesure
 * le délai de retour de la preview sans jamais retarder l'enregistrement, ce
 * qui est le compromis réel (on ne peut pas avoir les deux).
 */

"use strict";

const L = require("./lib.js");
const A = require("./analyse.js");
const C = require("./chronologie.js");
const fs = require("fs");
const path = require("path");

const DUREE_SEGMENT_MS = Number(process.env.POC_PHASE7B_SEG_MS || 5000);
const INTERVALLE_SONDE_MS = Number(process.env.POC_PHASE7B_SONDE_MS || 120);
const SONDE_MAX_MS = Number(process.env.POC_PHASE7B_SONDE_MAX_MS || 6000);

const PLAN = [
  { camera: "rear", tag: "p7b-A-rear" },
  { camera: "front", tag: "p7b-B-front" },
  { camera: "rear", tag: "p7b-C-rear" }
];

/* On cherche le PREMIER PixelCopy qui réussit, en gardant la trace des
 * échecs. Un seul échec suffit à affirmer « la preview n'est pas revenue
 * immédiatement » ; il faut donc journaliser les tentatives, pas seulement la
 * réussite. */
async function premierePreview(cdp, tag, tRef) {
  const tentatives = [];
  const debut = Date.now();
  let succes = null;
  while (Date.now() - debut < SONDE_MAX_MS) {
    const pc = await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('" + tag + "')", true);
    const j = pc.ok ? A.judgeJpeg(pc.base64, tag + "-" + tentatives.length + ".jpg") : null;
    tentatives.push({ atMs: pc.atMs, apresSwitchMs: tRef === null ? null : pc.atMs - tRef,
      ok: pc.ok, raison: pc.raison || null, noir: j ? j.noir : null, luma: j ? j.lumaMoyenne : null });
    if (pc.ok) { succes = tentatives[tentatives.length - 1]; break; }
    await L.sleep(INTERVALLE_SONDE_MS);
  }
  return {
    premierSuccesMs: succes ? succes.apresSwitchMs : null,
    nbTentatives: tentatives.length,
    premiereTentative: tentatives[0] || null,
    tentatives
  };
}

/* Ancre de contenu : on rattache les PTS du segment à l'horloge murale en
 * passant par l'audio, censé être COMPLET (cf. decaleVideo). Comparer
 * directement le dernier PTS vidéo à l'horloge murale ferait croire à une
 * troncature antérieure au switch — c'est l'erreur que cette fonction sert
 * précisément à éviter.
 *
 * On ne s'appuie pas sur `decaleVideo()` pour les quatre bornes : cette
 * fonction ne renvoie que `mortVideoMurMs` (la FIN de la vidéo). Il faut aussi le
 * PREMIER échantillon de chaque piste, d'où les PTS de continuité. */
function ancrer(seg) {
  const s = seg.segment;
  if (!s || !s.audio || !seg.rec || seg.rec.atMs === undefined) return null;
  const offsetMs = (seg.stop.atMs - seg.rec.atMs) - s.audio.dureeSec * 1000;
  const cv = s.continuiteVideo || {};
  const ca = s.continuiteAudio || {};
  const base = seg.rec.atMs;
  const p = (v) => (v === undefined || v === null ? null : Math.round(base + offsetMs + v * 1000));
  return {
    decalageMuxMs: Math.round(offsetMs),
    dernierVideoMurMs: p(cv.lastPts),
    premierVideoMurMs: p(cv.firstPts),
    dernierAudioMurMs: p(ca.lastPts),
    premierAudioMurMs: p(ca.firstPts),
    nbFrames: cv.frames || null,
    fpsMoyen: cv.fpsMoyen || null
  };
}

async function main() {
  L.say("=== POC J09 — phase 7b : segmenté MINIMAL (sans outillage intercalé) ===");
  L.say("séquence : " + PLAN.map((p) => p.camera).join(" -> "));
  L.say("duree par segment : " + (DUREE_SEGMENT_MS / 1000) + " s");
  L.say("sonde PixelCopy toutes les " + INTERVALLE_SONDE_MS + " ms, après démarrage du recorder");

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
  L.say("PLUGIN_PRETE");

  const prep = await cdp.evJson("(" + L.JS_PREPARE.toString() + ")('back')", true);
  L.say("PREPARE " + L.json(prep));
  await L.sleep(2500);

  const segments = [];
  const switches = [];
  let precedent = null;

  for (let i = 0; i < PLAN.length; i++) {
    const etape = PLAN[i];
    L.say("");
    L.say("=== segment " + (i + 1) + "/" + PLAN.length + " : " + etape.camera + " ===");

    /* --- lstruments bien dans l'ordre, sans rien entre --- */
    let sw = null;
    if (precedent) {
      sw = await cdp.evJson("(" + L.JS_SWITCH.toString() + ")()", true);
      L.say("  SWITCH ok=" + sw.ok + " apresMs=" + sw.afterMs
        + (sw.raison ? " raison=" + sw.raison : ""));
      switches.push({ index: i - 1, ok: sw.ok, raison: sw.raison || null,
        requestedAtMs: sw.requestedAtMs, atMs: sw.atMs, afterMs: sw.afterMs,
        versCamera: etape.camera });
      if (!sw.ok) throw new Error("switchCamera a échoué à l'étape " + i + " : " + sw.raison);
    }

    const rec = await cdp.evJson("(" + L.JS_REC_START.toString() + ")(null)", true);
    L.say("  REC_START ok=" + rec.ok + " ackApresMs=" + rec.ackAfterMs
      + (rec.raison ? " raison=" + rec.raison : ""));
    if (!rec.ok) throw new Error("startRecordVideo a échoué à l'étape " + i + " : " + rec.raison);

    /* La sonde part APRÈS le recorder : elle ne le retarde pas. */
    const sonde = await premierePreview(cdp, etape.tag, sw ? sw.requestedAtMs : null);
    L.say("  PixelCopy : premier succes a " + sonde.premierSuccesMs + " ms apres le switch"
      + " (" + sonde.nbTentatives + " tentatives), luma="
      + (sonde.premierSuccesMs === null ? "-" : sonde.tentatives[sonde.nbTentatives - 1].luma));
    if (sonde.premierSuccesMs === null) {
      L.say("  premiere tentative : " + L.json(sonde.premiereTentative));
    }

    /* On Equalise la durée de chaque segment malgré le temps pris par la sonde,
     * sinon les segments n'auraient pas la même longueur et la comparaison
     * serait bancale. */
    const ecoule = Date.now() - rec.atMs;
    if (ecoule < DUREE_SEGMENT_MS) await L.sleep(DUREE_SEGMENT_MS - ecoule);

    const stop = await cdp.evJson("(" + L.JS_REC_STOP.toString() + ")()", true);
    L.say("  REC_STOP ok=" + stop.ok + " arretApresMs=" + stop.stopAfterMs
      + " fichier=" + stop.path + (stop.raison ? " raison=" + stop.raison : ""));

    segments.push({
      index: i, camera: etape.camera, tag: etape.tag,
      rec: { requestMs: rec.requestMs, atMs: rec.atMs, ackAfterMs: rec.ackAfterMs },
      stop: { ok: stop.ok, atMs: stop.atMs, stopAfterMs: stop.stopAfterMs,
        cachePath: stop.path, cacheName: stop.path ? String(stop.path).split("/").pop() : null },
      sondePixelcopy: sonde
    });
    precedent = segments[i];
  }

  await L.sleep(1500);
  const logcat = L.adbTry(["logcat", "-d", "-v", "time"]);

  /* ---------- récupération des segments, EN FIN DE SÉQUENCE ---------- */
  L.say("");
  L.say("=== récupération des segments (hors sequence) ===");
  const presents = L.listRecordings().map((f) => f.name).filter((n) => /^videoTmp(_\d+)?\.mp4$/.test(n));
  L.say("fichiers dans le cache : " + L.json(presents));

  const attendus = segments.map((s) => s.stop.cacheName);
  const manquants = attendus.filter((n) => n && presents.indexOf(n) === -1);
  const enTrop = presents.filter((n) => attendus.indexOf(n) === -1);
  L.say("attendus : " + L.json(attendus));
  if (manquants.length) L.say("MANQUANTS : " + L.json(manquants));
  if (enTrop.length) L.say("NON ATTRIBUES : " + L.json(enTrop));

  /* On n'analyse un segment que si son chemin a été nominally rattaché à un
   * `stopRecordVideo`. Sans cette exigence, un fichier resté d'un run précédent
   * serait analysé et attribué au mauvais segment — on l'a déjà vu. */
  for (const seg of segments) {
    const nom = seg.stop.cacheName;
    if (!nom || presents.indexOf(nom) === -1) {
      seg.attribution = "AUCUN FICHIER pour le chemin declare par stopRecordVideo";
      seg.segment = null;
      continue;
    }
    const dest = seg.tag + "-" + nom;
    const tire = L.pullRecording(nom, dest);
    const a = A.analyseFichier(nom, tire.path);
    seg.segment = a;
    seg.attribution = "chemin exact retourne par stopRecordVideo du segment " + (seg.index + 1);
    L.say("  " + seg.camera + " " + dest + " : video="
      + (a.video ? a.video.dureeSec + "s/" + a.continuiteVideo.frames + "f" : "ABSENTE")
      + " audio=" + (a.audio ? a.audio.dureeSec + "s" : "aucun")
      + " verdict=" + a.verdictVideo);
    if (a.pisteVideoPresente) {
      const f = L.extractFrameLuma(a.mediaHorsDepot, [0.1, 0.3, 0.5, 0.7, 0.9]);
      seg.framesLuma = f.map((x) => x.luma);
      L.say("    lumas frames : " + L.json(seg.framesLuma));
    }
  }

  /* ---------- chronologie par transition ---------- */
  L.say("");
  L.say("=== chronologie par transition ===");
  const entrees = C.parse(logcat);
  const bornes = { t0: segments[0].rec.requestMs - 2000, t1: Date.now() + 1000 };
  const natif = {
    demarrageRec: C.marqueurs(entrees, /CameraActivity .*Starting recording/, bornes.t0, bornes.t1),
    stopRec: C.marqueurs(entrees, /CameraActivity .*stopRecord$/, bornes.t0, bornes.t1),
    switchEntree: C.marqueurs(entrees, /CameraActivity .*numberOfCameras:/, bornes.t0, bornes.t1),
    cameraRelease: C.marqueurs(entrees, /CameraActivity .*cameraCurrentlyLocked :=/, bornes.t0, bornes.t1),
    cameraNouvelle: C.marqueurs(entrees, /CameraActivity .*cameraCurrentlyLocked new:/, bornes.t0, bornes.t1),
    cameraOuverte: C.marqueurs(entrees, /CameraActivity .*(camera parameter NULL|currentFlashMode)/, bornes.t0, bornes.t1),
    videoFin: C.marqueurs(entrees, /CameraActivity .*Video (last|end)/i, bornes.t0, bornes.t1)
  };

  const transitions = [];
  for (let i = 0; i + 1 < segments.length; i++) {
    const A_ = segments[i], B = segments[i + 1];
    const sw = switches[i];
    const tSwitch = sw.requestedAtMs;

    /* Tous les instants demandés, exprimés dans la même base (Date.now() JS). */
    const T = {
      nom: A_.camera + " -> " + B.camera,
      cameraA: A_.camera, cameraB: B.camera,
      instants: {
        arretRecorderA: A_.stop.atMs,
        demandeSwitch: tSwitch,
        ackSwitch: sw.atMs,
        demandeRecorderB: B.rec.requestMs,
        ackRecorderB: B.rec.atMs,
        premierPixelcopyB: B.sondePixelcopy.premierSuccesMs === null ? null
          : tSwitch + B.sondePixelcopy.premierSuccesMs
      },
      durees: {
        arretRecorderMs: A_.stop.stopAfterMs,
        switchMs: sw.afterMs,
        demarrageRecorderMs: B.rec.ackAfterMs,
        /* Le coût RÉEL de l'enchaînement complet, hors outillage : c'est le
         * chiffre qui décide si la stratégie est envisageable. */
        totalStopVersRecorderMs: B.rec.atMs - A_.stop.atMs,
        stopVersSwitchMs: tSwitch - A_.stop.atMs,
        switchVersRecorderMs: B.rec.requestMs - sw.atMs,
        delaiPremierJPEGMs: B.sondePixelcopy.premierSuccesMs
      }
    };

    const bornesT = [tSwitch - 400, (switches[i + 1] ? switches[i + 1].requestedAtMs : bornes.t1)];
    const dans = (liste) => liste.filter((x) => x >= bornesT[0] && x <= bornesT[1]);
    T.momentsRecB = dans(natif.demarrageRec)[0] === undefined ? null : dans(natif.demarrageRec)[0];
    T.cameraRelease = dans(natif.cameraRelease)[0] === undefined ? null : dans(natif.cameraRelease)[0];
    T.cameraNouvelle = dans(natif.cameraNouvelle)[0] === undefined ? null : dans(natif.cameraNouvelle)[0];
    T.cameraOuverte = dans(natif.cameraOuverte)[0] === undefined ? null : dans(natif.cameraOuverte)[0];
    T.arretRecB = dans(natif.stopRec)[0] === undefined ? null : dans(natif.stopRec)[0];

    for (const k of ["demarrageRecB", "cameraRelease", "cameraNouvelle", "cameraOuverte", "arretRecB"]) {
      T[k + "Relatif"] = T[k] === null ? null : T[k] - tSwitch;
    }

    /* Les ancres de contenu : ce qui permet de dater le premier et le dernier
     * échantillon VIDÉO de chaque segment sans croire les durées du
     * conteneur. */
    const ancA = ancrer(A_);
    const ancB = ancrer(B);
    T.contenu = {
      dernierVideoA: ancA ? ancA.dernierVideoMurMs : null,
      dernierAudioA: ancA ? ancA.dernierAudioMurMs : null,
      premierVideoB: ancB ? ancB.premierVideoMurMs : null,
      premierAudioB: ancB ? ancB.premierAudioMurMs : null,
      trouVideoMs: (ancA && ancB && ancA.dernierVideoMurMs !== null && ancB.premierVideoMurMs !== null)
        ? ancB.premierVideoMurMs - ancA.dernierVideoMurMs : null,
      trouAudioMs: (ancA && ancB && ancA.dernierAudioMurMs !== null && ancB.premierAudioMurMs !== null)
        ? ancB.premierAudioMurMs - ancA.dernierAudioMurMs : null
    };
    transitions.push(T);

    L.say("");
    L.say("  --- " + T.nom + " ---");
    L.say("    arret A -> demande switch : " + T.durees.stopVersSwitchMs + " ms");
    L.say("    switchCamera : " + T.durees.switchMs + " ms");
    L.say("    switch -> demande REC B : " + T.durees.switchVersRecorderMs + " ms");
    L.say("    TOTAL stop A -> ack REC B : " + T.durees.totalStopVersRecorderMs + " ms");
    L.say("    camera A liberee : " + T.cameraReleaseRelatif + " ms apres la demande");
    L.say("    camera B ouverte : " + T.cameraOuverteRelatif + " ms apres la demande");
    L.say("    premier JPEG B : " + T.durees.delaiPremierJPEGMs + " ms apres la demande");
    L.say("    trou VIDEO : " + T.contenu.trouVideoMs + " ms   |   trou AUDIO : " + T.contenu.trouAudioMs + " ms");
  }

  const etat = await cdp.evJson(L.JS_POC_STATE);
  L.ev.phases.push({ phase: "phase7b-segmentation-minimale", plan: PLAN,
    dureeSegmentMs: DUREE_SEGMENT_MS, segments, switches, transitions,
    attribution: { attendus, presents, manquants, enTrop },
    marqueursNatifs: natif, events: etat.events });

  fs.mkdirSync(L.OUT, { recursive: true });
  fs.writeFileSync(path.join(L.OUT, "rapport-phase7b.json"), JSON.stringify(L.ev, null, 2));
  fs.writeFileSync(path.join(L.OUT, "phase7b-console.txt"), L.logLines.join("\n"));
  L.ecrireLogcat("phase7b-logcat", logcat);

  L.say("");
  L.say("RAPPORT " + path.join(L.OUT, "rapport-phase7b.json"));
  cdp.close();
  L.say("=== fin phase 7b ===");
}

main().catch((e) => {
  L.say("ERREUR " + e.message);
  try {
    fs.mkdirSync(L.OUT, { recursive: true });
    fs.writeFileSync(path.join(L.OUT, "rapport-phase7b.json"), JSON.stringify(L.ev, null, 2));
    fs.writeFileSync(path.join(L.OUT, "phase7b-console.txt"), L.logLines.join("\n"));
  } catch (e2) {}
  process.exit(1);
});
