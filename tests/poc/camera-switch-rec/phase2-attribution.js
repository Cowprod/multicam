/* J09 POC — PHASE 2 : ATTRIBUTION DE LA TRONCATURE.
 *
 * CE QUE LA PHASE 1 A MONTRÉ (et qui ne suffit pas) :
 *   switch  → conteneur 10.13 s, audio 10.13 s, VIDÉO seulement 5.50 s.
 * témoin   → conteneur  9.66 s, audio  9.66 s, vidéo       9.59 s.  (complet)
 *
 * LE PROBLÈME : dans la phase 1, la piste vidéo s'arrête à 5.50 s alors que
 * la demande de switch arrive à ~6.3 s après le début du REC. La troncature
 * PRÉCÈDE le switch d'environ 0.8 s. Donc "le switch casse la vidéo" n'est
 * PAS démontré : la vidéo était peut-être déjà condamnée avant.
 *
 * CE QUE CETTE PHASE FAIT : elle déplace le switch dans le temps pour voir si
 * la fin de la vidéo SUIT le switch (attribution) ou reste collée à ~5.5 s
 * (cause indépendante : throttling, buffer, ou un défaut du plugin).
 *
 *   run A : switch à 3 s  → si la vidéo finit vers 3 s  ⇒ le switch en est la cause
 *   run B : switch à 8 s  → si la vidéo finit vers 8 s  ⇒ confirmation
 *
 * Aucun switch n'est masqué, aucun segment n'est supprimé sans être compté.
 */

"use strict";

const L = require("./lib.js");
const A = require("./analyse.js");
const fs = require("fs");
const path = require("path");

/* Un run : REC, switch à `switchAtSec`, sonde PixelCopy, arrêt, analyse. */
async function run(cdp, tag, switchAtSec) {
  const say = L.say;
  say("");
  say("--- run " + tag + " : switch à t+" + switchAtSec + " s ---");

  /* Purge AVANT chaque REC, pas seulement au début de la phase.
   *
   * BUG CORRIGÉ : la purge unique du début de phase ne suffit pas quand une
   * phase enchaîne plusieurs REC dans la même session. Le `videoTmp.mp4` du run
   * précédent reste dans le cache, et l'analyse du run suivant le retire alors
   * comme s'il venait d'être produit : on mesurait deux fois le même fichier.
   * Constaté sur p2a/p2b, dont les segments étaient octet pour octet
   * identiques. Le purge par run rend l'attribution à un run fiable. */
  say("PURGE_CACHE " + L.purgeCacheRecordings());

  const rec = await cdp.evJson("(" + L.JS_REC_START.toString() + ")(null)", true);
  say("REC_START " + L.json(rec));
  if (!rec.ok) throw new Error(tag + " REC impossible: " + rec.reason);
  const tRec = rec.atMs;

  /* Sonde PixelCopy AVANT le switch : preuve que la caméra A filme et que la
   * preview est vivante. */
  const before = await A.judgeJpeg(
    (await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('" + tag + "-avant')", true)).base64,
    tag + "-avant.jpg");
  say("PIXELCOPY_avant luma=" + before.lumaMoyenne + " noir=" + before.noir);

  /* On attend exactement jusqu'à l'instant du switch. On mesure le fichier
   * AVANT le switch : c'est la référence pour dater la mort de la vidéo. */
  await L.sleep(Math.max(0, switchAtSec * 1000 - 300));
  const cacheAvant = L.listRecordings();
  say("CACHE_AVANT_SWITCH " + L.json(cacheAvant));

  const sw = await cdp.evJson("(" + L.JS_SWITCH.toString() + ")()", true);
  say("SWITCH " + L.json(sw));
  say("DELTA_SWITCH_APRES_DEBUT_REC_MS " + (sw.atMs - tRec));

  const imm = await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('" + tag + "-immediat')", true);
  const jImm = A.judgeJpeg(imm.base64, tag + "-immediat.jpg");
  say("PIXELCOPY_immediat ok=" + imm.ok + " raison=" + (imm.reason || "—")
    + " luma=" + jImm.lumaMoyenne);

  await L.sleep(6000);
  const tard = await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('" + tag + "-plus-tard')", true);
  const jTard = A.judgeJpeg(tard.base64, tag + "-plus-tard.jpg");
  say("PIXELCOPY_plus_tard ok=" + tard.ok + " raison=" + (tard.reason || "—")
    + " luma=" + jTard.lumaMoyenne + " NOIR=" + jTard.noir);

  const stop = await cdp.evJson("(" + L.JS_REC_STOP.toString() + ")()", true);
  say("REC_STOP " + L.json(stop));
  await L.sleep(1500);

  const segs = A.analyseRecording(tag + "-");
  say("SEGMENTS " + L.json(segs));

  /* On enregistre les instants MURAUX de CE run. Les runs partageant une
   * session, une synthèse qui apparie les événements par proximité peut se
   * tromper de run et produire des colonnes absurdes : mieux vaut que chaque
   * run porte ses propres horodatages. */
  return {
    tag, switchAtSec,
    recRequestMs: tRec,
    switchRequestMs: sw.requestedAtMs,
    switchAckMs: sw.atMs,
    recStopMs: stop.atMs,
    deltaSwitchApresRecMs: sw.atMs - tRec,
    recWallMs: stop.atMs - tRec,
    segments: segs
  };
}

async function main() {
  L.say("=== POC J09 — phase 2 : la troncature video suit-elle le switch ? ===");
  L.coldStart();
  const cdp = await L.attach("capture");
  try { L.adb(["logcat", "-c"]); } catch (e) {}
  const purged = L.purgeCacheRecordings();
  L.say("PURGE_CACHE " + purged);

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

  const runs = [];
  /* Les deux runs partagent la même session et le même recorder stoppé/redémarré
   * entre eux : c'est le protocole réel (switch puis nouveau segment), pas un
   * reboot entre chaque, ce qui rend la comparaison honnête. */
  runs.push(await run(cdp, "p2a-switch-t3", 3));
  await L.sleep(2000);
  runs.push(await run(cdp, "p2b-switch-t8", 8));

  /* Point de comparaison supplémentaire : un run SANS switch à la même
   * position que p2a (3 s) servirait de témoin apparié. Le témoin global
   * (phase 1b) suffit pour la référence « vidéo complète », donc on ne le
   * répète pas ici : on note l'absence explicitement. */
  const state = await cdp.evJson(L.JS_POC_STATE);
  L.ev.phases.push({ phase: "phase2-attribution", runs: runs, events: state.events });

  fs.mkdirSync(L.OUT, { recursive: true });
  fs.writeFileSync(path.join(L.OUT, "rapport-phase2.json"), JSON.stringify(L.ev, null, 2));
  fs.writeFileSync(path.join(L.OUT, "phase2-console.txt"), L.logLines.join("\n"));
  L.ecrireLogcat("phase2-logcat", L.adbTry(["logcat", "-d", "-v", "time"]));
  L.say("RAPPORT " + path.join(L.OUT, "rapport-phase2.json"));
  cdp.close();
  L.say("=== fin phase 2 ===");
}

main().catch((e) => {
  L.say("ERREUR " + e.message);
  try {
    fs.mkdirSync(L.OUT, { recursive: true });
    fs.writeFileSync(path.join(L.OUT, "rapport-phase2.json"), JSON.stringify(L.ev, null, 2));
    fs.writeFileSync(path.join(L.OUT, "phase2-console.txt"), L.logLines.join("\n"));
  } catch (e2) {}
  process.exit(1);
});
