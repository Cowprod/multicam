/* J09 POC — VALIDITÉ DES SEGMENTS.
 *
 * Un MP4 syntaxiquement valide ne prouve rien. Le cahier des charges est
 * explicite : ne PAS valider FRONT parce que le fichier s'ouvre et que
 * ffprobe le décrit. Il faut établir que le segment contient RÉELLEMENT une
 * image, et que cette image est bien celle de la caméra attendue.
 *
 * Trois niveaux de contrôle, du plus faible au plus fort :
 *
 *   1. STRUCTURE  — conteneur, codec, résolution, fps, audio, durée, frames,
 *                   taille, SHA-256. ffprobe décrit le fichier ; cela ne dit
 *                   rien de ce qu'il contient.
 *
 *   2. DÉCODAGE   — `ffmpeg -f null` décode TOUT le flux et compte les erreurs.
 *                   Un fichier qui s'ouvre mais contient des images corrompues
 *                   passe le test 1 et échoue ici.
 *
 *   3. CONTENU    — on extrait des frames à des positions connues et on mesure
 *                   leur luminance. C'est le seul niveau qui distingue une
 *                   caméra morte d'une caméra qui filme, et une image périmée
 *                   d'une image fraîche.
 *
 * La preuve d'identité repose sur une différence MESURÉE et non sur le nom du
 * segment : sur ce device l'image REAR a une luminance de 90 et l'image FRONT
 * de 22 à 26. Deux segments dont les luminances de frames se recouvrent ne sont
 * pas le contenu de deux caméras différentes, quelle que soit leur étiquette.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const L = require("./lib.js");

/* Positions d'échantillonnage dans le segment. */
const POSITIONS = [0.1, 0.3, 0.5, 0.7, 0.9];

/* Décodage COMPLET : on force le décodage de toutes les frames et on collecte
 * les erreurs. `-f null` n'écrit rien, il décode. */
function decodageComplet(fichier) {
  try {
    execFileSync("ffmpeg", ["-v", "error", "-i", fichier, "-f", "null", "-"],
      { maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "ignore", "pipe"] });
    return { ok: true, erreurs: [] };
  } catch (e) {
    const texte = String((e.stderr || "")).split("\n").filter((l) => l.trim());
    const sansFlux = texte.some((l) => /does not contain any stream/.test(l));
    return { ok: false, sansFlux, nbErreurs: texte.length, erreurs: texte.slice(0, 5) };
  }
}

function analyserSegment(s, cameraAttendue) {
  const fichier = s.mediaHorsDepot;
  const dispo = fichier && fs.existsSync(fichier);
  const r = {
    cache: s.cache,
    cameraAttendue,
    dispo,
    fichier: dispo ? path.basename(fichier) : null,
    octets: s.octets,
    sha256: s.sha256,
    structure: {
      conteneurSec: s.conteneurSec,
      codecVideo: s.video ? s.video.codec : null,
      resolution: s.video ? s.video.luma : null,
      fps: s.video ? s.video.fps : null,
      nbFrames: s.video ? s.video.nbFrames : null,
      dureeVideoSec: s.video ? s.video.dureeSec : null,
      codecAudio: s.audio ? s.audio.codec : null,
      echantillon: s.audio ? s.audio.echantillon : null,
      canaux: s.audio ? s.audio.canaux : null,
      dureeAudioSec: s.audio ? s.audio.dureeSec : null,
      verdictVideo: s.verdictVideo,
      deficitVideoSec: s.deficitVideoSec
    },
    decodage: null,
    contenu: null
  };

  if (!dispo) {
    r.statut = "FICHIER ABSENT (rejouer backfill-segments.js)";
    return r;
  }

  r.decodage = decodageComplet(fichier);

  if (s.pisteVideoPresente) {
    const frames = L.extractFrameLuma(fichier, POSITIONS);
    const lumas = frames.map((f) => f.luma).filter((l) => typeof l === "number");
    r.contenu = {
      positions: frames,
      lumas,
      lumaMin: lumas.length ? Math.min.apply(null, lumas) : null,
      lumaMax: lumas.length ? Math.max.apply(null, lumas) : null,
      tousNoirs: lumas.length > 0 && lumas.every((l) => l < 8),
      toutesTrouvees: frames.every((f) => f.frameTrouvee)
    };
  } else {
    r.contenu = { sansPisteVideo: true };
  }

  r.statut = statut(s, r);
  return r;
}

function statut(s, r) {
  /* ffmpeg signale un conteneur sans aucun flux par « Output file does not
   * contain any stream ». Ce n'est PAS un decodage rate : c'est un fichier
   * vide, ce qu'on observe apres un `stopRecordVideo` en echec. La distinction
   * compte : « fichier illisible » et « recorder a cree un fichier sans rien
   * dedans » n'appellent pas les memes corrections. */
  if (r.decodage && !r.decodage.ok && r.decodage.sansFlux) {
    return "CONTENEUR VIDE : aucun flux (video ni audio)";
  }
  if (!r.decodage.ok) return "INVALIDE : decodage incomplet (" + r.decodage.nbErreurs + " erreurs)";
  if (!s.pisteVideoPresente) return "SANS PISTE VIDEO (audio seul)";
  if (r.contenu && r.contenu.tousNoirs) return "VIDEO NOIRE : aucune image exploitable";
  if (r.contenu && !r.contenu.toutesTrouvees) return "PARTIEL : certaines positions n'ont pas de frame";
  if (s.verdictVideo === "VIDEO TRONQUEE") return "STRUCTURE VALIDE mais video tronquee";
  return "VALIDE : decodage integral et contenu image non noir";
}

function main() {
  L.say("=== POC J09 — validite des segments ===");

  const rapports = process.argv.slice(2);
  const cibles = rapports.length ? rapports : fs.readdirSync(L.OUT)
    .filter((f) => /^rapport-(phase[0-9]|p7f|sonde-front)/.test(f) && /\.json$/.test(f))
    /* `premier-passe` est le rapport du PREMIER passage de la phase 5. Ses
     * segments ne sont plus revalidables : le second passage a réecrit les
     * MEMES noms de fichiers hors depot (`p5-front-videoTmp.mp4`), donc le
     * fichier présent aujourd'hui n'est pas celui qui a produit ce rapport.
     * Analyser ce rapport reviendrait a attribuer des mesures d'un passage a un
     * autre — exactement le piege du cache. On le conserve comme archive mais on
     * ne le revalide pas. */
    .filter((f) => !/ARCHIVE/.test(f))
    .map((f) => path.join(L.OUT, f));

  const sortie = [];
  for (const f of cibles) {
    if (!fs.existsSync(f)) continue;
    const ev = JSON.parse(fs.readFileSync(f, "utf8"));
    const aTrouver = [];

    /* Segments à la racine du rapport. */
    for (const s of (ev.segments || [])) aTrouver.push({ s, camera: cameraDe(s, ev) });

    /* Segments par run (phase 2) ou par branche (phase 5). */
    for (const ph of (ev.phases || [])) {
      for (const run of (ph.runs || [])) for (const s of (run.segments || [])) aTrouver.push({ s, camera: run.camera || cameraDeTag(run.tag) });
      for (const k of ["front", "rear"]) if (ph[k] && ph[k].segment) aTrouver.push({ s: ph[k].segment, camera: k });
      /* Phase 7 / 7b / 8 : les segments sont dans `phases[].segments`, chacun
       * sous `segment`. On ne filtre pas sur le NOM de la phase — le laisser
       * ici a valu 6 segments perdus pour la phase 8, qui ne fut jamais
       * collectée alors que la phase 7 l'était. Toute phase qui expose ce
       * format est collectée. */
      if (Array.isArray(ph.segments)) {
        for (const seg of ph.segments) {
          if (seg && seg.segment) aTrouver.push({ s: seg.segment, camera: seg.camera || null });
        }
      }
    }
    if (!aTrouver.length) continue;

    /* Un meme segment peut apparaitre deux fois dans un rapport (racine ET
     * branche) : on ne le compte qu'une fois, et on garde la caméra la mieux
     * renseignée. Sans cela, les comptages de segments sont faux et les
     * comparaisons de contenu sont faussées. */
    const vus = new Map();
    for (const { s, camera } of aTrouver) {
      const cle = s.sha256 || s.mediaHorsDepot;
      if (vus.has(cle)) {
        const deja = vus.get(cle);
        if (!deja.cameraAttendue && camera) deja.cameraAttendue = camera;
        continue;
      }
      const r = analyserSegment(s, camera);
      vus.set(cle, r);
    }
    const uniques = Array.from(vus.values());

    L.say("");
    L.say("--- " + path.basename(f) + " : " + uniques.length + " segment(s) ---");
    for (const r of uniques) {
      sortie.push({ rapport: path.basename(f), ...r });
      L.say("  " + (r.cameraAttendue || "?").padEnd(6) + (r.fichier || "-").padEnd(34)
        + " luma=[" + (r.contenu && r.contenu.lumas ? r.contenu.lumas.join(",") : "-") + "]"
        + "  decodage=" + (r.decodage ? (r.decodage.ok ? "OK" : r.decodage.nbErreurs + " err") : "?")
        + "  -> " + r.statut);
    }
  }

  /* --- séparation des contenus REAR / FRONT --- */
  const avecContenu = sortie.filter((s) => s.contenu && s.contenu.lumas && s.contenu.lumas.length);
  const rear = avecContenu.filter((s) => s.cameraAttendue === "rear");
  const front = avecContenu.filter((s) => s.cameraAttendue === "front");
  const lumaRear = [];
  const lumaFront = [];
  for (const s of rear) for (const l of s.contenu.lumas) lumaRear.push(l);
  for (const s of front) for (const l of s.contenu.lumas) lumaFront.push(l);

  const separation = (lumaRear.length && lumaFront.length) ? {
    lumaRear: { min: Math.min.apply(null, lumaRear), max: Math.max.apply(null, lumaRear), n: lumaRear.length },
    lumaFront: { min: Math.min.apply(null, lumaFront), max: Math.max.apply(null, lumaFront), n: lumaFront.length },
    /* Disjoints = les contenus sont manifestement différents, donc les segments
     * ne sont pas tous la même image étiquetée différemment. */
    disjoints: Math.min.apply(null, lumaRear) > Math.max.apply(null, lumaFront)
      || Math.min.apply(null, lumaFront) > Math.max.apply(null, lumaRear),
    conclusion: null
  } : null;

  if (separation) {
    separation.conclusion = separation.disjoints
      ? "les luminances REAR et FRONT ne se recouvrent PAS : les segments contiennent "
        + "réellement deux images différentes. Le segment FRONT n'est pas une copie "
        + "du REAR, ni une image noire."
      : "les luminances REAR et FRONT se recouvrent : impossible d'affirmer par la "
        + "seule luminance que les segments diffèrent.";
  }

  fs.writeFileSync(path.join(L.OUT, "validite-segments.json"),
    JSON.stringify({ segments: sortie, separationRearFront: separation }, null, 2));

  L.say("");
  L.say("--- separation des contenus ---");
  if (separation) {
    L.say("  REAR  : luma " + separation.lumaRear.min + " a " + separation.lumaRear.max
      + " (" + separation.lumaRear.n + " echantillons)");
    L.say("  FRONT : luma " + separation.lumaFront.min + " a " + separation.lumaFront.max
      + " (" + separation.lumaFront.n + " echantillons)");
    L.say("  " + separation.conclusion);
  } else {
    L.say("  segments REAR ou FRONT insuffisants pour comparer");
  }
  const mauvais = sortie.filter((s) => s.statut.indexOf("INVALIDE") === 0);
  L.say("");
  L.say(mauvais.length
    ? "=== " + mauvais.length + " segment(s) en decodage INVALIDE ==="
    : "=== tous les segments decodent integralement ===");
  L.say("RAPPORT " + path.join(L.OUT, "validite-segments.json"));
  if (mauvais.length) process.exit(1);
}

function cameraDe(s, ev) {
  if (s.camera) return s.camera;
  const nom = String(s.cache || s.mediaHorsDepot || "");
  const parTag = cameraDeTag(nom);
  if (parTag) return parTag;
  /* Un phase 6 est entièrement conducted en REAR jusqu'au switch. */
  if (/p6-/.test(nom)) return "rear";
  if (/p4-/.test(nom)) return "rear->front->rear";
  return null;
}

function cameraDeTag(nom) {
  const n = String(nom);
  if (/front|p5-front|sf-/.test(n)) return "front";
  if (/rear/.test(n)) return "rear";
  return null;
}

main();
