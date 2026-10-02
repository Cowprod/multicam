/* J09 POC — PHASE 3 : 5 switches consécutifs dans UN SEUL MediaRecorder.
 *
 * La phase 2 a établi (avec le témoin sans switch) que la troncature vidéo suit
 * le switch. Cette phase répond à la question opérateur : que se passe-t-il
 * quand on répète ? C'est le comportement réel de la console de régie.
 *
 * Protocole : un seul REC, 5 switch_camera() successifs espacés, une sonde
 * PixelCopy entre chaque, puis analyse du fichier final. On mesure aussi si le
 * plugin reste capable d'enchaîner (état natif) et si le REC survit.
 *
 * Aucune conclusion n'est tirée ici sur la stratégie produit : c'est une mesure.
 */

"use strict";

const L = require("./lib.js");
const A = require("./analyse.js");
const fs = require("fs");
const path = require("path");

const NB_SWITCH = Number(process.env.POC_SWITCHES || 5);
const ESPACEMENT_MS = Number(process.env.POC_ESPACEMENT_MS || 3000);

async function main() {
  L.say("=== POC J09 — phase 3 : " + NB_SWITCH + " switches consécutifs, un seul REC ===");
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
  const tRecReq = rec.requestMs;

  const sw = [];
  for (let i = 0; i < NB_SWITCH; i++) {
    /* Sonde AVANT chaque switch : c'est elle qui dit si la preview est encore
     * une image réelle ou déjà morte. Un JPEG NOIR avant le switch suivant
     * prouverait que le switch précédent a déjà cassé la preview. */
    const p0 = await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('s" + i + "-avant')", true);
    const j0 = A.judgeJpeg(p0.base64, "p3-s" + i + "-avant.jpg");

    const s = await cdp.evJson("(" + L.JS_SWITCH.toString() + ")()", true);
    const p1 = await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('s" + i + "-apres')", true);
    const j1 = A.judgeJpeg(p1.base64, "p3-s" + i + "-apres.jpg");

    const ligne = {
      index: i,
      switchOk: s.ok,
      switchAfterMs: s.afterMs,
      deltaDepuisDebutRecMs: s.atMs - tRecReq,
      deltaDepuisSwitchPrecedentMs: i === 0 ? null : s.atMs - sw[i - 1].atMs,
      pixelcopyAvant: { ok: p0.ok, raison: p0.reason || null, luma: j0.lumaMoyenne, noir: j0.noir },
      pixelcopyApres: { ok: p1.ok, raison: p1.reason || null, luma: j1.lumaMoyenne, noir: j1.noir },
      atMs: s.atMs
    };
    sw.push(ligne);
    L.say("SWITCH_" + i + " " + L.json(ligne));
    await L.sleep(ESPACEMENT_MS);
  }

  const stop = await cdp.evJson("(" + L.JS_REC_STOP.toString() + ")()", true);
  L.say("REC_STOP " + L.json(stop));
  await L.sleep(1500);

  /* Le REC a-t-il tenu jusqu'au bout ? */
  const segs = A.analyseRecording("p3-");
  L.say("SEGMENTS " + L.json(segs));

  /* Question distincte et importante : le plugin est-il encore capable de
   * démarrer UN NOUVEAU recorder après les 5 switches ? C'est ce que ferait
   * la régie pour le segment suivant. On ne l'ignore pas, on le mesure. */
  let relance = null;
  try {
    const r2 = await cdp.evJson("(" + L.JS_REC_START.toString() + ")(null)", true);
    relance = { ok: r2.ok, raison: r2.reason || null, ackAfterMs: r2.ackAfterMs };
    L.say("RELANCE_REC_apres_switchs " + L.json(relance));
    if (r2.ok) {
      const s2 = await cdp.evJson("(" + L.JS_REC_STOP.toString() + ")()", true);
      L.say("STOP_RELANCE " + L.json(s2));
      const segs2 = A.analyseRecording("p3-relance-");
      L.say("SEGMENTS_RELANCE " + L.json(segs2));
      relance.segments = segs2;
    }
  } catch (e) {
    relance = { ok: false, erreur: String(e.message) };
    L.say("RELANCE_REC_ECHOUEE " + e.message);
    L.ev.errors.push({ phase: "phase3", ou: "relance_rec_apres_switchs", err: e.message });
  }

  const state = await cdp.evJson(L.JS_POC_STATE);
  L.ev.phases.push({ phase: "phase3-switchs-multiples", switches: sw, relance: relance, events: state.events });
  L.ev.switches = sw;

  fs.mkdirSync(L.OUT, { recursive: true });
  fs.writeFileSync(path.join(L.OUT, "rapport-phase3.json"), JSON.stringify(L.ev, null, 2));
  fs.writeFileSync(path.join(L.OUT, "phase3-console.txt"), L.logLines.join("\n"));
  L.ecrireLogcat("phase3-logcat", L.adbTry(["logcat", "-d", "-v", "time"]));

  /* Console de synthèse : la question du POC est binaire, on la lit ici. */
  L.say("");
  L.say("--- synthèse phase 3 ---");
  L.say("switches réussis : " + sw.filter((s) => s.switchOk).length + "/" + NB_SWITCH);
  L.say("pixelcopy NOIR   : " + sw.filter((s) => s.pixelcopyApres.noir).length + "/" + NB_SWITCH + " après switch");
  L.say("pixelcopy ECHEC  : " + sw.filter((s) => !s.pixelcopyApres.ok).length + "/" + NB_SWITCH + " après switch");
  L.say("relance REC      : " + L.json(relance && relance.ok));
  for (const s of segs) {
    L.say("segment " + s.cache + " : video " + s.video.dureeSec + " s / audio " + s.audio.dureeSec
      + " s -> " + s.verdictVideo);
  }
  L.say("RAPPORT " + path.join(L.OUT, "rapport-phase3.json"));
  cdp.close();
  L.say("=== fin phase 3 ===");
}

main().catch((e) => {
  L.say("ERREUR " + e.message);
  try {
    fs.mkdirSync(L.OUT, { recursive: true });
    fs.writeFileSync(path.join(L.OUT, "rapport-phase3.json"), JSON.stringify(L.ev, null, 2));
    fs.writeFileSync(path.join(L.OUT, "phase3-console.txt"), L.logLines.join("\n"));
    L.ecrireLogcat("phase3-logcat", L.adbTry(["logcat", "-d", "-v", "time"]));
  } catch (e2) {}
  process.exit(1);
});
