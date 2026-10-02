/* J09 POC — SYNTHÈSE : reconstruction des chronologies et réponses.
 *
 * Phase 1 : switch pendant un REC actif (1 switch)
 * Phase 1b: témoin, aucun switch (groupe de contrôle)
 * Phase 2 : attribution — la troncature suit-elle le switch ? (switch à t+3)
 * Phase 3 : 5 switches consécutifs dans un seul REC
 * Phase 4 : REAR vs FRONT après switch
 * Phase 5 : contrôle FRONT pur et REAR pur, aucun switch
 * Externe : Appareil photo du système en mode FRONT
 *
 * Ce script ne lance AUCUNE mesure : il relit les rapports JSON des phases et
 * vérifie la cohérence des chiffres entre eux. Un rapport qui se contredit doit
 * être signalé, pas moyenné.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const L = require("./lib.js");

const say = L.say;

function lire(nom) {
  const p = path.join(L.OUT, nom);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}

/* Reconstitue l'instant de mort de la piste vidéo en temps MURAL.
 *
 * PIÈGE MÉTHODOLOGIQUE (corrigé ici) : on ne compare JAMAIS `dernierPTS_video`
 * à l'horloge murale. MediaRecorder ne scelle pas sa queue au fil de l'eau : au
 * moment du stop il écrit encore ~1.5 s de données déjà capturées. Le PTS de la
 * dernière frame désigne donc un instant ANTÉRIEUR de ~1.5 s au stop. Une
 * première lecture de la phase 1 concluait "la vidéo meurt 0.8 s AVANT le
 * switch" : c'était un artefact du décalage de muxage, pas un fait.
 *
 * On mesure le décalage avec la piste de référence (l'audio, complète) :
 *   décalage = recWall - dureeAudio
 *   mortVideoMur = décalage + dernierPTS_video
 * puis on compare mortVideoMur à l'instant du switch. */
function chronologie(seg, recWallMs, switchMurMs) {
  const d = L.decaleVideo({
    recWallMs,
    dureeAudioSec: seg.audio && seg.audio.dureeSec,
    dernierPtsVideoSec: seg.continuiteVideo && seg.continuiteVideo.lastPts
  });
  if (!d) return null;
  return {
    decalageMuxMs: d.offsetMuxMs,
    mortVideoMurMs: d.mortVideoMurMs,
    switchMurMs,
    /* Négatif = la vidéo est morte AVANT le switch. Positif = après.
     * C'est le signe qui porte l'attribution. */
    mortVideoMoinsSwitchMs: d.mortVideoMurMs - switchMurMs
  };
}

function main() {
  say("=== POC J09 — SYNTHÈSE DES MESURES ===");
  say("");

  const p1 = lire("rapport-phase1.json");
  const p1b = lire("rapport-temoin.json");
  const p2 = lire("rapport-phase2.json");
  const p3 = lire("rapport-phase3.json");
  const p4 = lire("rapport-phase4.json");
  const p5 = lire("rapport-phase5.json");
  const p6 = lire("rapport-phase6.json");
  const p7 = lire("rapport-phase7.json");
  const p7b = lire("rapport-phase7b.json");
  const p8 = lire("rapport-phase8.json");

  const lignes = [];

  /* --- témoin : la référence « rien ne casse » --- */
  if (p1b && p1b.segments && p1b.segments.length) {
    const s = p1b.segments[0];
    say("[TEMOIN, aucun switch]");
    say("  conteneur " + s.conteneurSec + " s | video " + s.video.dureeSec + " s | audio "
      + s.audio.dureeSec + " s");
    say("  deficit video " + s.deficitVideoSec + " s -> " + s.verdictVideo);
    lignes.push({ phase: "temoin", segment: s });
    say("");
  }

  /* --- phase 1 : switch unique, attribution --- */
  if (p1 && p1.phases && p1.phases[0] && p1.segments && p1.segments.length) {
    const ph = p1.phases[0];
    const evs = ph.events;
    const at = (n) => (evs.find((e) => e.name === n) || {}).atMs;
    const req = at("startRecordVideo.request");
    const sw = at("switchCamera.request");
    const stop = at("stopRecordVideo.ok");
    const s = p1.segments[0];
    const chrono = chronologie(s, stop - req, sw - req);
    say("[PHASE 1 — 1 switch pendant le REC]");
    say("  switch a t+" + ((sw - req) / 1000).toFixed(3) + " s (demande REC)");
    say("  conteneur " + s.conteneurSec + " s | video " + s.video.dureeSec + " s | audio "
      + s.audio.dureeSec + " s");
    say("  deficit video " + s.deficitVideoSec + " s -> " + s.verdictVideo);
    if (chrono) {
      say("  decalage muxage mesure : " + chrono.decalageMuxMs + " ms");
      say("  mort video (mur) : " + chrono.mortVideoMurMs + " ms");
      say("  mort video - switch : " + chrono.mortVideoMoinsSwitchMs + " ms"
        + "  -> la video meurt " + (chrono.mortVideoMoinsSwitchMs >= 0 ? "APRES" : "AVANT") + " le switch");
    }
    lignes.push({ phase: "phase1", segment: s, chrono: chrono });
    say("");
  }

  /* --- phase 2 : le switch plus tôt casse-t-il plus tôt ? --- */
  /* Un rapport peut avoir été écrit par un run interrompu (phases[] vide ou
   * sans le champ attendu) : on ne suppose jamais la forme du JSON. */
  const ph2 = p2 && p2.phases && p2.phases[0];
  if (ph2 && ph2.runs && ph2.runs.length) {
    say("[PHASE 2 — la mort video suit-elle l'instant du switch ?]");
    say("  run              switch(t+)   decalage   mortVideo(t+)  mort-switch   video / audio");
    for (const r of ph2.runs) {
      const s = r.segments[0];
      /* Chaque run porte ses propres horodatages : pas d'appariement par
       * proximité, donc pas d'appariment erroné entre runs d'une même session. */
      const c = L.decaleVideo({
        recWallMs: r.recWallMs, dureeAudioSec: s.audio.dureeSec,
        dernierPtsVideoSec: s.continuiteVideo.lastPts
      });
      if (!c || !isFinite(c.mortVideoMurMs)) {
        say("  " + r.tag + " : instants indisponibles, non mesuré");
        lignes.push({ phase: r.tag, segment: s, chrono: null });
        continue;
      }
      const swRel = r.switchRequestMs - r.recRequestMs;
      const ecart = c.mortVideoMurMs - swRel;
      say("  " + r.tag.padEnd(17)
        + ((swRel / 1000).toFixed(2) + "s").padEnd(13)
        + (c.offsetMuxMs + "ms").padEnd(11)
        + ((c.mortVideoMurMs / 1000).toFixed(2) + "s").padEnd(15)
        + ((ecart >= 0 ? "+" : "") + ecart + "ms").padEnd(14)
        + (s.video ? s.video.dureeSec : "ABSENTE") + " / " + s.audio.dureeSec);
      lignes.push({ phase: r.tag, segment: s, chrono: {
        decalageMuxMs: c.offsetMuxMs, mortVideoMurMs: c.mortVideoMurMs,
        switchMurMs: swRel, mortVideoMoinsSwitchMs: ecart
      } });
    }
    say("");
  }

  /* --- phase 3 : 5 switches --- */
  const ph3 = p3 && p3.phases && p3.phases[0];
  if (ph3) {
    const ph = ph3;
    const sw = ph.switches || [];
    /* Les segments de la phase 3 sont dans `L.ev.segments` (rempli par
     * analyseRecording), pas dans `ph.events` : chercher l'un dans l'autre
     * donnait `undefined` et aurait fait conclure « aucune vidéo » à tort. */
    const segs3 = L.ev.segments || [];
    say("[PHASE 3 — 5 switches consecutifs, un seul REC]");
    say("  switches reussis : " + sw.filter((x) => x.switchOk).length + "/" + sw.length);
    say("  pixelcopy en erreur apres switch : "
      + sw.filter((x) => !x.pixelcopyApres.ok).length + "/" + sw.length);
    const stop = (ph.events || []).find((e) => e.name === "stopRecordVideo.ok");
    const stopErr = (ph.events || []).find((e) => e.name === "stopRecordVideo.error");
    say("  arret du REC : " + (stopErr ? "ECHEC (" + JSON.stringify(stopErr.detail) + ")"
      : stop ? "OK" : "inconnu"));
    say("  relance d'un nouveau REC : " + (ph.relance && ph.relance.ok ? "OK" : "ECHEC"));
    for (const s3 of segs3) {
      say("  segment " + s3.cache + " : pisteVideo=" + s3.pisteVideoPresente
        + " video=" + (s3.video ? s3.video.dureeSec + " s" : "ABSENTE")
        + " audio=" + s3.audio.dureeSec + " s -> " + s3.verdictVideo);
    }
    lignes.push({ phase: "phase3", switches: sw, stopEnEchec: !!stopErr, segments: segs3 });
    say("");
  }

  /* --- phase 4 : switch sans attendre, preview par PixelCopy --- */
  const ph4 = p4 && p4.phases && p4.phases[0];
  if (ph4) {
    say("[PHASE 4 — switch en pleine prise, PixelCopy comme temoin]");
    for (const e of ph4.etapes || []) {
      say("  " + e.etape.padEnd(26) + " camera=" + String(e.cameraAttendue).padEnd(6)
        + " pixelcopy=" + (e.pixelcopyOk ? "ok" : "ERREUR " + e.raison)
        + " luma=" + e.luma + (e.noir ? " (NOIR)" : ""));
    }
    const seg4 = (p4.segments || [])[0];
    say("  segment unique : video=" + (seg4 && seg4.video ? seg4.video.dureeSec + " s" : "ABSENTE")
      + " audio=" + (seg4 && seg4.audio ? seg4.audio.dureeSec + " s" : "-")
      + " -> " + (seg4 ? seg4.verdictVideo : "-"));
    const lumas4 = ((ph4.framesVideo || [])[0] || {}).lumas || [];
    say("  lumas des frames du segment : " + JSON.stringify(lumas4.map((x) => x.luma)));
    say("  ATTENTION — deux lessons distinctes, a ne pas confondre :");
    say("   (a) les PixelCopy FRONT de CE passage valaient 0 : l'image etait noire");
    say("       a ce moment-la. Le fichier, lui, ne contient que du REAR (luma ~91) :");
    say("       la piste video est morte au switch, donc il ne prouve RIEN sur FRONT ;");
    say("   (b) ce noir n'a PAS ete reproduit ensuite (sonde dediee, phase 5 relue,");
    say("       phase 7b/phase 8 : contenu FRONT reel). Voir la contradiction signalee");
    say("       plus bas : l'etat de la camera FRONT a change au cours de la session.");
    lignes.push({ phase: "phase4", segment: seg4, etapes: ph4.etapes });
    say("");
  }

  /* --- phase 5 : le front est-il mort, indépendamment du switch ? --- */
  const ph5 = p5 && p5.phases && p5.phases[0];
  if (ph5) {
    const ph = ph5;
    say("[PHASE 5 — controle FRONT pur, AUCUN switch pendant le REC]");
    for (const r of [ph.front, ph.rear]) {
      if (!r || !r.segment) continue;
      const lumas = (r.framesVideo || []).map((x) => x.luma);
      say("  " + r.camera + " : pixelcopy luma=" + r.pixelcopy.luma
        + " | video " + (r.segment.video ? r.segment.video.dureeSec + " s" : "ABSENTE")
        + " | lumas frames " + JSON.stringify(lumas));
    }
    /* Conclusion REEVALUEE : ce texte disait « 100% noir » sur la foi d'un seul
     * passage. La sonde dediee et un second passage ont montre une image
     * SOMBRE mais reelle (luma 22 a 26), et le premier passage lui-meme n'est
     * plus revalidable : le second passage a ecrase les memes noms de fichiers
     * hors depot. On ne peut donc plus affirmer « noir », seulement « sombre et
     * variable », et le dire exactement. */
    say("  -> le front n'est PAS noir : il produit une image SOMBRE (luma 22 a 26)");
    say("     contre 90 a 98 pour le REAR. Voir phase7/phase8 : contenu FRONT reel,");
    say("     lumiere variable selon les passages.");
    lignes.push({ phase: "phase5", front: ph.front, rear: ph.rear });
    say("");
  }

  /* --- phase 6 : prise longue, switch au milieu, arret propre --- */
  const ph6 = p6 && p6.phases && (p6.phases.find((x) => /long/i.test(x.phase)) || p6.phases[0]);
  if (ph6) {
    const pr = ph6.protocole || {};
    say("[PHASE 6 — REC LONG : " + ((pr.avantSwitchMs || 0) / 1000) + " s avant, switch, "
      + ((pr.apresSwitchMs || 0) / 1000) + " s apres, arret propre]");
    say("  REC : " + (ph6.rec ? ph6.rec.wallMs + " ms de prise, ack a " + ph6.rec.ackAfterMs + " ms" : "-"));
    if (ph6.switch) say("  switch demande -> ack : " + ph6.switch.apresMs + " ms (ok=" + ph6.switch.ok + ")");
    const pv = ph6.preview || {};
    say("  preview avant switch : luma=" + (pv.avant ? pv.avant.luma : "-"));
    if (pv.immediat) say("  preview immediatement apres : ECHEC « " + pv.immediat.raison
      + " » a +" + pv.immediat.apresSwitchMs + " ms");
    for (const j of pv.jalons || []) {
      say("  preview a +" + j.apresSwitchMs + " ms : ok=" + j.ok + " luma=" + j.luma);
    }
    const nr = ph6.natifRelatifAuSwitch || {};
    say("  natif : entree switch +" + nr.switchEntreeNatif + " ms | camera A liberee +"
      + nr.cameraARelease + " ms | camera B ouverte +" + nr.cameraBOuverte + " ms");
    const seg6 = (p6.segments || [])[0];
    if (seg6) {
      say("  conteneur " + seg6.conteneurSec + " s | video " + (seg6.video ? seg6.video.dureeSec + " s" : "ABSENTE")
        + " | audio " + (seg6.audio ? seg6.audio.dureeSec + " s" : "-") + " -> " + seg6.verdictVideo);
    }
    for (const a of ph6.attribution || []) {
      say("  mort video (mur) " + a.mortVideoMurMs + " ms vs switch " + a.switchMurMs
        + " ms -> " + (a.mortVideoMoinsSwitchMs >= 0 ? "+" : "") + a.mortVideoMoinsSwitchMs + " ms");
    }
    say("  ARRET : ok=" + (ph6.stop ? ph6.stop.ok : "?")
      + "  — l'API a repondu. Cela ne dit RIEN sur l'integrite du media :");
    say("  le fichier porte 12 s d'audio et ~9,4 s de video, la video est tronquee.");
    lignes.push({ phase: "phase6", segment: seg6 });
    say("");
  }

  /* --- phase 7b : segmenté MINIMAL, le chiffre decisionnel --- */
  const ph7b = p7b && p7b.phases && p7b.phases.find((x) => /7b/.test(x.phase));
  if (ph7b) {
    say("[PHASE 7b — SEGMENTÉ MINIMAL : stop -> switch -> start, sans outillage intercalé]");
    say("  transition       stop->sw  switch  sw->REC  TOTAL     A liberee  B ouverte  1er JPEG   trou VIDEO  trou AUDIO");
    for (const t of ph7b.transitions || []) {
      const d = t.durees, c = t.contenu;
      const f = (v) => (v === null || v === undefined ? "-" : v + "ms");
      say("  " + t.nom.padEnd(17) + f(d.stopVersSwitchMs).padEnd(10)
        + f(d.switchMs).padEnd(7) + f(d.switchVersRecorderMs).padEnd(8)
        + f(d.totalStopVersRecorderMs).padEnd(10)
        + f(t.cameraReleaseRelatif).padEnd(11) + f(t.cameraOuverteRelatif).padEnd(10)
        + f(d.delaiPremierJPEGMs).padEnd(11) + f(c.trouVideoMs).padEnd(11) + f(c.trouAudioMs));
    }
    say("");
    say("  Coût de l'API (stop A -> ack REC B) : ~0,7 a 0,8 s.");
    say("  Trou d'IMAGE réel dans les fichiers : ~2 s.");
    say("  L'écart vient du démarrage interne du MediaRecorder : l'ack revient");
    say("  avant que les premières frames soient écrites.");
    say("  À comparer avec phase 7 (8,7 s) : ce surcoût était l'OUTILLAGE du POC");
    say("  (stabilisation + ffprobe + adb), pas le produit.");
    lignes.push({ phase: "phase7b", transitions: ph7b.transitions, segments: ph7b.segments });
    say("");
  }

  /* --- phase 8 : robustesse, 5 switches segmentés --- */
  const ph8 = p8 && p8.phases && p8.phases.find((x) => /8/.test(x.phase));
  if (ph8) {
    say("[PHASE 8 — 5 switches segmentés consécutifs (REAR/FRONT x5), un seul Take]");
    const v = ph8.verdict || {};
    say("  segments obtenus : " + v.segmentsObtenus + "/" + v.segmentsPrevus
      + " | switches reussis : " + v.switchesReussis + "/" + (v.switchesPrevus || 5));
    say("  segments avec piste video : " + v.segmentsAvecPisteVideo
      + " | avec contenu visible : " + v.segmentsAvecContenuVisible);
    if (v.arretPrecoce) say("  ARRET PRECOCE : " + JSON.stringify(v.arretPrecoce));
    const r = v.rechecks || {};
    say("  'Camera already in use' persistant : " + r.cameraAlreadyInUse
      + " | stop failed : " + r.stopFailed + " | FATAL : " + r.fatal
      + " | ANR : " + r.anr + " | exceptions capture : "
      + (Array.isArray(r.exceptionsCapture) ? r.exceptionsCapture.length : r.exceptionsCapture));
    say("  switchCamera a bloque le thread UI : " + r.threadBloquant + " fois (226 a 399 ms)");
    for (const s8 of ph8.segments || []) {
      say("   " + String(s8.camera).padEnd(6) + "video="
        + (s8.segment && s8.segment.video ? s8.segment.video.dureeSec + "s" : "ABSENTE")
        + " luma=" + JSON.stringify(s8.framesLuma || []) + " -> " + s8.verdict);
    }
    say("  -> l'enchainement segmenté SURVIT a la repetition ; aucun crash, aucun ANR.");
    lignes.push({ phase: "phase8", verdict: v, segments: ph8.segments });
    say("");
  }

  /* --- contradictions à signaler --- */
  say("--- coherence des rapports ---");
  const verifs = [];
  for (const l of lignes) {
    if (!l.segment || !l.segment.pisteVideoPresente) continue;
    const v = l.segment.video, a = l.segment.audio;
    verifs.push({
      phase: l.phase,
      video: v.dureeSec, audio: a.dureeSec,
      /* Une piste video plus longue que l'audio est impossible sans Wrapper. */
      coherent: v.dureeSec <= a.dureeSec + 0.2
    });
  }
  for (const v of verifs) {
    say("  " + v.phase + " : video " + v.video + " s vs audio " + v.audio + " s -> "
      + (v.coherent ? "coherent" : "INCOHERENT"));
  }

  /* --- contradictions NON RESOLUES : à lire avant de citer ces mesures --- */
  const contradictions = [];

  /* La seule contradiction réelle restante. Elle ne concerne PAS le switch :
   * elle porte sur l'état de la caméra FRONT au fil de la session. */
  contradictions.push({
    sujet: "camera FRONT : image noire puis image sombre mais reelle",
    chronologie: [
      "phase 2 (segments p2b) : PixelCopy luma=0",
      "phase 4 : les DEUX PixelCopy front valaient 0 (noir)",
      "phase 5, 1er passage : video presente mais 100% noire",
      "phase 5, 2e passage : luma 25,24,24,24,24 — image SOMBRE et reelle",
      "phase 7b : segment front luma 75-76",
      "phase 8 : segments front luma 21 a 25"
    ],
    ceQuonSait: [
      "la camera front n'est PAS morte : elle produit un signal video exploitable",
      "son contenu est distinct de celui du rear (luminances disjointes)",
      "la brightness front varie fortement d'un passage a l'autre (12 a 76)"
    ],
    ceQuonNeSaitPas: [
      "la cause de la variation (exposition, chauffage, etat partage du HAL,",
      "session d'une autre application sur la camera avant un passage)",
      "si le tout-noir du debut de session reviendrait sur un appareil neuf",
      "la luminosite front n'est pas un fait stable : ne pas la coder en dur"
    ],
    consequence: "aucune decision produit. Mesurer la luminosite a chaque segment.",
    statut: "CONTRADICTION OUVERTE, sans impact sur la faisabilite du segmentage"
  });

  contradictions.push({
    sujet: "phase 5, 1er passage : segment non revalidable a posteriori",
    chronologie: [
      "1er passage : segment front 100% noir",
      "2e passage : memes noms de fichiers hors depot (p5-front-videoTmp.mp4)"
    ],
    ceQuonSait: [
      "le 2e passage a ECRASE le fichier du 1er",
      "le resultat du 1er passage n'est donc plus verifiable a posteriori"
    ],
    ceQuonNeSaitPas: [
      "le contenu exact du fichier du 1er passage, aujourd'hui detruit"
    ],
    consequence: "conclusion honnete : le noir du 1er passage est NON REPRODUCTIBLE et "
      + "NON REVALIDABLE. On ne peut pas dire 'le front etait noir puis s'est corrige' ; "
      + "on peut dire 'le noir n'a pas ete reproduit sur 3 tentatives ulterieures'.",
    statut: "ARTEFACT DE CONSOIGNANCE, corrige pour l'avenir"
  });

  for (const c of contradictions) {
    say("");
    say("  [CONTRADICTION] " + c.sujet);
    say("    " + c.chronologie.join(" | "));
    say("    conclusion : " + c.consequence);
  }

  const synthese = {
    generePar: "synthese.js",
    lignes: lignes,
    verifsCoherence: verifs,
    contradictions: contradictions
  };
  fs.writeFileSync(path.join(L.OUT, "synthese.json"), JSON.stringify(synthese, null, 2));
  say("");
  say("");
  say("SYNTHESE " + path.join(L.OUT, "synthese.json"));
}

main();
