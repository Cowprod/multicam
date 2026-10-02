/* J09 POC — utile : réinjecte les segments analysés dans les rapports JSON.
 *
 * POURQUOI CE SCRIPT EXISTE
 * -------------------------
 * `analyseRecording()` renvoyait les segments mais ne les écrivait pas dans
 * `L.ev.segments`. Seule la phase 1 faisait l'affectation à la main. Les
 * rapports JSON des phases 2 à 5 sont donc sortis avec `segments: []`, alors
 * que l'analyse avait eu lieu et que les chiffres existaient — uniquement dans
 * les logs console.
 *
 * La durée vidéo contre la durée audio est LA donnée qui porte la conclusion
 * du POC. La perdre dans l'artefact machine-lisible rend les rapports
 * invérifiables. Corriger `analyse.js` empêche la récidive, mais ne rattrape
 * pas les rapports déjà écrits.
 *
 * CE QUE FAIT CE SCRIPT
 * ---------------------
 * Il réanalyse les .mp4 DÉJÀ tirés hors du dépôt et réinjecte le résultat dans
 * les rapports existants. Aucun device n'est contacté, aucune capture n'est
 * refaite : c'est une reconstruction depuis les fichiers d'origine, dont le
 * `sha256` est recalculé et comparé à celui du rapport d'origine. Un écart
 * ferait échouer le script plutôt que de publier une analyse qui ne décrit plus
 * le fichier mesuré.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const L = require("./lib.js");
const A = require("./analyse.js");

/* Rapport -> préfixe des fichiers déjà tirés hors du dépôt. */
const RAPPORTS = [
  { rapport: "rapport-phase6.json", prefixes: ["p6-long-"] },
  { rapport: "rapport-phase7.json", prefixes: ["p7-"] },
  { rapport: "rapport-phase8.json", prefixes: ["p8-"] },
  { rapport: "rapport-phase2.json", prefixes: ["p2a-switch-t3-", "p2b-switch-t8-"] },
  { rapport: "rapport-phase3.json", prefixes: ["p3-"] },
  { rapport: "rapport-phase4.json", prefixes: ["p4-"] },
  { rapport: "rapport-phase5.json", prefixes: ["p5-front-", "p5-rear-"] }
];

function sha(connu, attendu) {
  if (connu && attendu && connu !== attendu) {
    throw new Error("sha256 different de celui du rapport : le fichier a change, "
      + "cette reconstruction ne decrirait plus la capture mesuree");
  }
  return connu || attendu;
}

function main() {
  /* Les .mp4 déjà tirés, par préfixe. */
  const disponibles = fs.readdirSync(L.MEDIA).filter((f) => /\.mp4$/.test(f));
  let total = 0;

  for (const spec of RAPPORTS) {
    const chemin = path.join(L.OUT, spec.rapport);
    if (!fs.existsSync(chemin)) {
      L.say(spec.rapport + " : absent, ignore");
      continue;
    }
    const ev = JSON.parse(fs.readFileSync(chemin, "utf8"));

    /* Un rapport qui porte DÉJÀ des segments, où qu'ils soient (racine ou
     * par run), n'est pas réinjecté. Sans cette garde, une ré-exécution
     * Analysis ajoutait des fichiers PÉRIMÉS du dossier externe — le préfixe
     * `p2b-switch-t8-` correspond à deux exécutions différentes — et le
     * rapport se retrouvait avec un segment qui ne correspond à aucun run. */
    const dejaPorts = (ev.segments && ev.segments.length)
      || (ev.phases || []).some((ph) => (ph.segments && ph.segments.length)
        || (ph.runs || []).some((r) => r.segments && r.segments.length)
        || (ph.front && ph.front.segment) || (ph.rear && ph.rear.segment));
    if (dejaPorts) {
      L.say(spec.rapport + " : porte deja ses segments, non reinjecte");
      continue;
    }

    /* sha256 connus : phase 2 les a par run, sinon on ne peut pas garantir que
     * le fichier présent est bien celui qui a été mesuré. */
    const connus = new Map();
    for (const r of ev.runs || []) {
      for (const s of r.segments || []) if (s.sha256) connus.set(s.mediaHorsDepot, s.sha256);
    }

    const segs = [];
    for (const prefixe of spec.prefixes) {
      for (const nom of disponibles.filter((f) => f.indexOf(prefixe) === 0)) {
        const cheminLocal = path.join(L.MEDIA, nom);
        const seg = A.analyseFichier(nom, cheminLocal);
        const attendu = (connus.get(cheminLocal)
          || (ev.segments || []).filter((s) => s.mediaHorsDepot === cheminLocal)[0] || {}).sha256;
        sha(seg.sha256, attendu);
        segs.push(seg);
      }
    }

    if (!segs.length) {
      L.say(spec.rapport + " : aucun .mp4 hors depot pour ces prefixes, laisse tel quel");
      continue;
    }
    ev.segments = segs;
    fs.writeFileSync(chemin, JSON.stringify(ev, null, 2));
    for (const s of segs) {
      L.say("  " + path.basename(s.mediaHorsDepot) + " : "
        + (s.video ? "video " + s.video.dureeSec + "s" : "AUCUNE PISTE VIDEO")
        + " | audio " + (s.audio ? s.audio.dureeSec + "s" : "aucun")
        + " -> " + s.verdictVideo);
    }
    L.say(spec.rapport + " : " + segs.length + " segment(s) reinjectes");
    total += segs.length;
  }
  L.say("=== " + total + " segments reconstructs depuis les .mp4 hors depot ===");
}

main();
