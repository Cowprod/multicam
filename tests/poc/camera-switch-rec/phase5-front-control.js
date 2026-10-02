/* J09 POC — PHASE 5 : groupe de contrôle FRONT pur, sans aucun switch.
 *
 * LA QUESTION RESTANTE : la phase 4 a montré
 *   REAR  → PixelCopy lisible (luma ~91)
 *   FRONT → PixelCopy NOIR   (luma 0), alors que le switch avait réussi
 * et le MP4 du REC ne contenait que des frames REAR lisibles.
 *
 * Deux explications restent compatibles avec ces mesures :
 *   (a) la caméra FRONT ne produit aucune image sur ce device ;
 *   (b) la caméra FRONT filme, mais la PREVIEW FRONT ne s'affiche pas, donc
 *       PixelCopy lit un surface noir — et le fichier serait le seul à le dire.
 *
 * On les sépare ici en démarrant DIRECTEMENT en front, sans passer par un
 * switch : si un REC front pur contient des frames lisibles, alors (b) est
 * confirmé et le switch n'y est pour rien. Si le fichier est noir de bout en
 * bout, alors (a).
 *
 * Un groupe témoin REAR dans la même session rend la comparaison honnête.
 */

"use strict";

const L = require("./lib.js");
const A = require("./analyse.js");
const fs = require("fs");
const path = require("path");

/* Un REC complet sur la caméra demandée, sans switch. */
async function segmentSansSwitch(cdp, tag, camera) {
  const say = L.say;
  say("");
  say("--- segment " + tag + " (camera=" + camera + ", AUCUN switch) ---");

  /* Purge AVANT chaque REC : cette phase enchaîne deux REC et la purge de début
   * de phase ne couvre pas le second. Sans elle, l'analyse du segment FRONT
   * reposait sur le `videoTmp.mp4` laissé par le segment REAR (et inversement) —
   * deux segments identiques octet pour octet, ce qui a été constaté. */
  say("PURGE_CACHE " + L.purgeCacheRecordings());

  const rec = await cdp.evJson("(" + L.JS_REC_START.toString() + ")(null)", true);
  say("REC_START " + L.json(rec));
  if (!rec.ok) throw new Error(tag + " REC impossible: " + rec.reason);
  const tReq = rec.requestMs;

  await L.sleep(5000);
  const p = await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('" + tag + "')", true);
  const j = A.judgeJpeg(p.base64, tag + ".jpg");
  say("PIXELCOPY luma=" + j.lumaMoyenne + " noir=" + j.noir + (p.reason ? " raison=" + p.reason : ""));

  const stop = await cdp.evJson("(" + L.JS_REC_STOP.toString() + ")()", true);
  say("REC_STOP " + L.json(stop));
  await L.sleep(1500);

  const segs = A.analyseRecording(tag + "-");
  say("SEGMENTS " + L.json(segs));
  const s = segs[0] || null;
  if (!s) return null;

  /* Framesillonnées : une caméra front qui filme mal (noir, ou|image fixe) ne
   * se distingue d'une caméra front morte qu'en regardant plusieurs points. On
   * ajoute aussi les dimensions EXACTES de la piste : une image 1080x1920
   * (portrait) sur un capteur dont le facing est FRORT est un indice fort. */
  const frames = s.pisteVideoPresente ? L.extractFrameLuma(s.mediaHorsDepot, [0.1, 0.3, 0.5, 0.7, 0.9]) : [];
  say("FRAMES_VIDEO " + L.json(frames));

  return {
    tag, camera, pixelcopy: { ok: p.ok, raison: p.reason || null, luma: j.lumaMoyenne, noir: j.noir },
    segment: s, framesVideo: frames,
    recWallMs: stop.atMs - tReq
  };
}

async function main() {
  L.say("=== POC J09 — phase 5 : FRONT pur vs REAR pur, aucun switch ===");
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

  /* On ouvre la caméra FRONT dès le départ. Le plugin accepte `camera:"front"`
   * au startCamera : c'est le seul moyen de tester le front sans passer par un
   * switch, donc sans le confondre avec le bug étudié. */
  const prep = await cdp.evJson("(" + L.JS_PREPARE.toString() + ")('front')", true);
  L.say("PREPARE " + L.json(prep));
  await L.sleep(2000);

  const front = await segmentSansSwitch(cdp, "p5-front", "front");

  /* On rebascule en REAR pour le témoin, toujours sans switch pendant le REC. */
  L.say("");
  L.say("bascule REAR (hors REC, entre deux segments)");
  const sw = await cdp.evJson("(" + L.JS_SWITCH.toString() + ")()", true);
  L.say("SWITCH_HS " + L.json(sw));
  await L.sleep(3000);

  const rear = await segmentSansSwitch(cdp, "p5-rear", "rear");

  const state = await cdp.evJson(L.JS_POC_STATE);
  L.ev.phases.push({ phase: "phase5-front-vs-rear-sans-switch", front: front, rear: rear, events: state.events });

  fs.mkdirSync(L.OUT, { recursive: true });
  fs.writeFileSync(path.join(L.OUT, "rapport-phase5.json"), JSON.stringify(L.ev, null, 2));
  fs.writeFileSync(path.join(L.OUT, "phase5-console.txt"), L.logLines.join("\n"));
  L.ecrireLogcat("phase5-logcat", L.adbTry(["logcat", "-d", "-v", "time"]));

  /* Lecture : le front filme-t-il, ou la preview front est-elle noire ? */
  L.say("");
  L.say("--- synthèse phase 5 ---");
  for (const r of [front, rear]) {
    if (!r) continue;
    const lumas = (r.framesVideo || []).map((f) => f.luma);
    const lisibles = lumas.filter((x) => typeof x === "number" && x >= 8).length;
    L.say("  " + r.camera + " : pixelcopy luma=" + r.pixelcopy.luma + " noir=" + r.pixelcopy.noir
      + " | video " + (r.segment.video ? r.segment.video.dureeSec + " s" : "ABSENTE")
      + " | frames lisibles " + lisibles + "/" + lumas.length + " -> " + L.json(lumas));
  }
  /* Le verdict doit distinguer trois cas, pas deux. "Toutes les frames
   * trouvées sont noires" et "aucune frame n'a pu être extraite" ne se
   * ressemblent que dans le JSON et signifient des choses opposées : le
   * premier est une mesure, le second une panne d'outil. On exige que chaque
   * frame extraite soit RÉELLEMENT stata avant de conclure "noir". */
  const f = front;
  let verdictFront;
  if (!f) verdictFront = "INCONNU (aucun segment front)";
  else if (!f.segment.pisteVideoPresente) verdictFront = "FRONT : aucune piste video";
  else {
    const trouvees = (f.framesVideo || []).filter((x) => x.frameTrouvee);
    if (!trouvees.length) verdictFront = "INDETERMINE (extraction impossible, outil en cause)";
    else {
      const lisibles = trouvees.filter((x) => typeof x.luma === "number" && x.luma >= 8);
      verdictFront = lisibles.length
        ? "FRONT FILME (" + lisibles.length + "/" + trouvees.length + " frames lisibles)"
        : "FRONT : " + trouvees.length + "/" + trouvees.length + " frames NOIRES";
    }
  }
  L.say("  VERDICT " + verdictFront);
  L.say("  (rappel : switch etat = " + (sw.ok ? "OK" : "ECHEC") + ", aucun switch pendant le REC de cette phase)");
  L.say("RAPPORT " + path.join(L.OUT, "rapport-phase5.json"));
  cdp.close();
  L.say("=== fin phase 5 ===");
}

main().catch((e) => {
  L.say("ERREUR " + e.message);
  try {
    fs.mkdirSync(L.OUT, { recursive: true });
    fs.writeFileSync(path.join(L.OUT, "rapport-phase5.json"), JSON.stringify(L.ev, null, 2));
    fs.writeFileSync(path.join(L.OUT, "phase5-console.txt"), L.logLines.join("\n"));
    L.ecrireLogcat("phase5-logcat", L.adbTry(["logcat", "-d", "-v", "time"]));
  } catch (e2) {}
  process.exit(1);
});
