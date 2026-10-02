/* J09 POC — SONDE DÉCISIVE : l'image de preview après un switch est-elle
 * fraîche (caméra B) ou périmée (dernière frame de la caméra A) ?
 *
 * POURQUOI CETTE SONDE EST NÉCESSAIRE
 * ---------------------------------
 * La phase 6 a produit une contradiction apparente :
 *   - phase 4 et phase 5 : après passage sur FRONT, PixelCopy renvoie du NOIR
 *     (luma 0, JPEG de 7 a 14 Ko) ;
 *   - phase 6 : après passage sur FRONT, PixelCopy renvoie du luma 77-78 avec
 *     des JPEG de 70 Ko, donc une VRAIE image.
 *
 * Une de ces deux mesures est trompeuse, et les deux ne peuvent pas être vraies :
 * l'Appareil photo du système montre un front noir, la phase 5 montre un front
 * noir. La piste video, elle, est morte depuis le switch — on ne peut donc pas
 * utiliser le fichier pour dire de quelle camera vient l'image de preview.
 *
 * DEUX HYPOTHÈSES, DEUX CONSÉQUENCES OPPOSÉES
 * ------------------------------------------
 *   H1 « image fraîche de la caméra B » : le front filmerait finalement, et les
 *      phases 4/5 auraient mesuré un état transitoire.
 *   H2 « frame périmée de la caméra A » : la caméra B ne livre AUCUNE frame à la
 *      SurfaceView ; PixelCopy réussit parce que la surface est valide, et copie
 *      la dernière image restée en mémoire. C'est le piège le plus grave du
 *      POC : « la preview est vivante » serait un FAUX POSITIF systématique.
 *
 * MÉTHODE
 * -------
 * On compare la TAILLE et la LUMINANCE des images avant et après le switch, sans
 * enregistrement et avec enregistrement. Un JPEG noir fait 7 a 14 Ko sur ce
 * device, une vraie scene 50 a 70 Ko : l'octetage est ici le discriminant.
 *
 * On ajoute une vérification qui ne dépend d'aucune heuristique : la taille de
 * l'image stockée sur le disque, et le nombre d'octets « stables » dans le temps.
 * Une VRAIE caméra qui filme une scène quasi statique donne des JPEG de taille
 * variable d'une image à l'autre ; une frame figée donne des octets identiques.
 */

"use strict";

const L = require("./lib.js");
const A = require("./analyse.js");
const fs = require("fs");
const path = require("path");

async function sonde(cdp, tag, nombre, intervalleMs) {
  const out = [];
  for (let i = 0; i < nombre; i++) {
    const pc = await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('" + tag + "-" + i + "')", true);
    const nom = tag + "-" + i + ".jpg";
    const j = A.judgeJpeg(pc.base64, nom);
    out.push({
      i, atMs: pc.atMs, ok: pc.ok, raison: pc.reason || null,
      noir: j.noir, luma: j.lumaMoyenne, octets: j.octets,
      largeur: j.largeur, hauteur: j.hauteur,
      sha256: fs.existsSync(path.join(L.SHOTS, nom)) ? L.sha256(path.join(L.SHOTS, nom)) : null
    });
    L.say("  " + tag + "-" + i + " ok=" + pc.ok + " luma=" + j.lumaMoyenne
      + " octets=" + j.octets + (pc.reason ? " raison=" + pc.reason : ""));
    if (i + 1 < nombre) await L.sleep(intervalleMs);
  }
  return out;
}

function conclure(out) {
  const ok = out.filter((x) => x.ok);
  if (!ok.length) return "aucun PixelCopy reussi";
  const luma = ok.map((x) => x.luma);
  const octets = ok.map((x) => x.octets);
  const shas = new Set(ok.map((x) => x.sha256));
  const tousNoirs = luma.every((l) => l !== null && l < 8);
  const tousIdentiques = shas.size === 1;
  return {
    tousNoirs,
    tousIdentiques,
    nbImages: ok.length,
    lumaMin: Math.min.apply(null, luma),
    lumaMax: Math.max.apply(null, luma),
    octetsMin: Math.min.apply(null, octets),
    octetsMax: Math.max.apply(null, octets),
    interpretation: tousNoirs
      ? "la camera B livre des frames : elles sont NOIRES"
      : tousIdentiques
        ? "IMAGE FIGEE : octets identiques d'une sonde a l'autre -> frame perimee, "
          + "la camera B ne livre rien (H2)"
        : "les images VARIENT : la camera B livre des frames vivantes (H1)"
  };
}

async function main() {
  L.say("=== POC J09 — sonde preview fraiche/perimee apres switch ===");
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

  const resultat = {};

  /* ---------- A. switch SANS enregistrement ---------- */
  L.say("");
  L.say("--- A. sans REC : REAR -> FRONT ---");
  await cdp.evJson("(" + L.JS_PREPARE.toString() + ")('back')", true);
  await L.sleep(2000);
  const aAvant = await sonde(cdp, "sp-A-rear", 3, 700);
  const swA = await cdp.evJson("(" + L.JS_SWITCH.toString() + ")()", true);
  L.say("  SWITCH ok=" + swA.ok + " apresMs=" + swA.afterMs);
  const aApres = await sonde(cdp, "sp-A-front", 5, 1200);
  resultat.sansRec = { avant: aAvant, switch: swA, apres: aApres, conclusion: conclure(aApres) };

  /* ---------- B. switch AVEC enregistrement ---------- */
  L.say("");
  L.say("--- B. avec REC : REAR -> FRONT ---");
  /* On revient explicitement sur REAR pour que le point de départ soit connu. */
  const swBack = await cdp.evJson("(" + L.JS_SWITCH.toString() + ")()", true);
  L.say("  SWITCH retour ok=" + swBack.ok);
  await L.sleep(2500);
  const rec = await cdp.evJson("(" + L.JS_REC_START.toString() + ")(null)", true);
  L.say("  REC_START ok=" + rec.ok);
  if (!rec.ok) throw new Error("REC impossible: " + rec.reason);
  await L.sleep(3000);
  const bAvant = await sonde(cdp, "sp-B-rear", 3, 700);
  const swB = await cdp.evJson("(" + L.JS_SWITCH.toString() + ")()", true);
  L.say("  SWITCH ok=" + swB.ok + " apresMs=" + swB.afterMs);
  const bApres = await sonde(cdp, "sp-B-front", 5, 1200);
  const stopB = await cdp.evJson("(" + L.JS_REC_STOP.toString() + ")()", true);
  L.say("  REC_STOP ok=" + stopB.ok + (stopB.reason ? " raison=" + stopB.reason : ""));
  await L.sleep(2000);
  resultat.avecRec = { avant: bAvant, switch: swB, apres: bApres, stop: stopB, conclusion: conclure(bApres) };

  /* ---------- verdict croisé ---------- */
  const sa = resultat.sansRec.conclusion.interpretation;
  const sb = resultat.avecRec.conclusion.interpretation;
  resultat.verdict = {
    sansRec: sa,
    avecRec: sb,
    coherent: sa === sb
      ? "les deux situations concordent"
      : "les deux situations DISCORDEENT : la preview depend du contexte (REC ou non)"
  };
  L.say("");
  L.say("--- verdict ---");
  L.say("  sans REC : " + sa);
  L.say("  avec REC : " + sb);
  L.say("  " + resultat.verdict.coherent);

  L.ev.sondePreviewFraiche = resultat;
  fs.mkdirSync(L.OUT, { recursive: true });
  fs.writeFileSync(path.join(L.OUT, "rapport-sonde-preview.json"), JSON.stringify(L.ev, null, 2));
  fs.writeFileSync(path.join(L.OUT, "sonde-preview-console.txt"), L.logLines.join("\n"));
  L.say("RAPPORT " + path.join(L.OUT, "rapport-sonde-preview.json"));
  cdp.close();
  L.say("=== fin sonde preview ===");
}

main().catch((e) => {
  L.say("ERREUR " + e.message);
  try {
    fs.mkdirSync(L.OUT, { recursive: true });
    fs.writeFileSync(path.join(L.OUT, "rapport-sonde-preview.json"), JSON.stringify(L.ev, null, 2));
    fs.writeFileSync(path.join(L.OUT, "sonde-preview-console.txt"), L.logLines.join("\n"));
  } catch (e2) {}
  process.exit(1);
});
