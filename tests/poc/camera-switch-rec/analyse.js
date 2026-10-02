/* Analyse commune aux phases du POC J09.
 *
 * Factorisée pour que la phase 1 (avec switch) et le témoin (sans switch)
 * soient mesurés EXACTEMENT de la même façon. Sans ça, une différence entre
 * les deux rapports pourrait venir de la méthode de mesure et non du switch.
 */

"use strict";

const L = require("./lib.js");
const path = require("path");

/* Analyse d'un .mp4 : conteneur, pistes V et A séparément, continuité réelle.
 *
 * Point central : on ne lit PAS la durée globale du conteneur pour conclure que
 * la capture est bonne. Un MediaRecorder dont la caméra est libérée en cours de
 * route produit un conteneur de durée NORMALE (l'audio, lui, continue) avec une
 * piste VIDÉO tronquée. Comparer video.duration à audio.duration est donc la
 * mesure décisive, pas format.duration. */
function analyseFichier(cacheName, cheminLocal) {
  {
    const pulled = { path: cheminLocal, bytes: require("fs").statSync(cheminLocal).size };
    const probe = L.ffprobe(pulled.path);
    const v = (probe.streams || []).find((s) => s.codec_type === "video") || null;
    const a = (probe.streams || []).find((s) => s.codec_type === "audio") || null;
    const conteneurSec = Number((probe.format || {}).duration);

    const cont = L.videoContinuity(pulled.path);
    const aud = L.audioSpans(pulled.path);

    /* Une piste vidéo de largeur/hauteur 0 est une piste ABSENTE : après un
     * `stop failed`, MediaRecorder laisse un mux qui ne contient QUE l'audio.
     * La traiter comme une piste vidéo de durée "conteneur" ferait dire
     * "VIDEO COMPLETE" sur un fichier où il n'y a aucune image. */
    const vPresent = !!(v && v.codec_name && Number(v.width) > 0 && Number(v.height) > 0);
    const videoSec = vPresent ? Number(v.duration) : null;
    const audioSec = a && a.codec_name ? Number(a.duration) : null;
    /* Déficit vidéo = audio - vidéo. C'est la quantité de prise de vue PERDUE
     * alors que le fichier existe et que l'audio, lui, est complet. */
    const deficit = (videoSec !== null && audioSec !== null)
      ? Number((audioSec - videoSec).toFixed(3)) : null;

    /* Verdict : le cas "aucune piste vidéo" doit être isolé AVANT de comparer
     * les durées, sinon un fichier audio-seul passe pour une capture parfaite. */
    const verdict = !vPresent
      ? "AUCUNE PISTE VIDEO (fichier audio seul)"
      : deficit === null ? "INDETERMINE"
      : deficit > 0.5 ? "VIDEO TRONQUEE"
      : deficit < -0.5 ? "VIDEO EN AVANCE (anormal)" : "VIDEO COMPLETE";

    return {
      cache: cacheName,
      /* Chemin ABSOLU hors dépôt (voir MEDIA dans lib.js). Aucun MP4 n'est
       * conservé dans le workspace. */
      mediaHorsDepot: pulled.path,
      octets: pulled.bytes,
      sha256: L.sha256(pulled.path),
      conteneurSec,
      pisteVideoPresente: vPresent,
      video: vPresent ? {
        codec: v.codec_name, luma: v.width + "x" + v.height,
        fps: v.avg_frame_rate, nbFrames: Number(v.nb_frames),
        dureeSec: videoSec
      } : null,
      audio: a && a.codec_name ? {
        codec: a.codec_name, echantillon: Number(a.sample_rate),
        canaux: a.channels, dureeSec: audioSec
      } : null,
      continuiteVideo: cont,
      continuiteAudio: aud,
      /* Chiffre qui porte la conclusion : > 0 = de la vidéo manque alors que
       * l'audio est complet. */
      deficitVideoSec: deficit,
      verdictVideo: verdict
    };
  }
}

/* Tire les .mp4 du cache du device, les analyse, ET les enregistre dans le
 * rapport.
 *
 * BUG CORRIGÉ : `analyseRecording` renvoyait les segments sans jamais les
 * écrire dans `L.ev.segments`. Seule la phase 1 faisait l'affectation
 * manuellement. Résultat : les rapports JSON des phases 2 à 5 sortaient avec
 * `segments: []` alors que l'analyse avait bien eu lieu — les chiffres n'ont
 * survécu que dans les logs console. Le segment est la donnée la plus
 * déterminante du POC (durée vidéo vs audio) : la perdre dans l'artefact
 * lisible par machine rendait les rapports non vérifiables.
 *
 * L'écriture est faite ICI, dans la fonction commune, pour que toute phase
 * appelante la conserve sans avoir à y penser. */
function analyseRecording(destPrefix) {
  const files = L.listRecordings();

  /* Garde-fou : un seul REC doit produire un seul .mp4. Plusieurs fichiers
   * signifient que le cache contenait déjà des segments d'un run précédent et
   * que l'analyse en tirerait de fausses conclusions (le même fichier mesuré
   * deux fois). On refuse plutôt que de publier un résultat ambigu. */
  if (files.length > 1) {
    throw new Error("analyseRecording: " + files.length + " .mp4 dans le cache ("
      + files.map((f) => f.name).join(", ") + "). PurgeCacheRecordings() doit etre "
      + "appele AVANT chaque startRecordVideo, pas une seule fois par phase.");
  }

  const segs = files.map((f) => {
    const pulled = L.pullRecording(f.name, destPrefix + f.name);
    return analyseFichier(f.name, pulled.path);
  });
  L.ev.segments = segs;
  return segs;
}

/* Un JPEG PixelCopy est-il une vraie image ? (camera rules #5 : valider le
 * contenu, pas le succès du callback.) Une image toute noire renvoie un mean
 * quasi nul : c'est un cas d'échec DÉGUISÉ en succès. */
function judgeJpeg(base64, name) {
  const written = L.writeJpeg(base64, name);
  if (!written) return { ecrit: false, raison: "aucun base64" };
  const luma = L.jpegLuma(path.join(L.SHOTS, name));
  const dim = L.jpegDim(path.join(L.SHOTS, name));
  return {
    ecrit: true,
    fichier: written.path,
    octets: written.bytes,
    /* Taille et dimensions de l'image : la TAILLE est ici le discriminant
     * le plus utile. Sur ce device une image noire fait 7 a 14 Ko, une vraie
     * scene 50 a 70 Ko. C'est ce qui permet de distinguer « la camera front
     * est morte » de « le PixelCopy renvoie une VIEILLE image de la camera
     * precedente ». */
    largeur: dim ? dim.largeur : null,
    hauteur: dim ? dim.hauteur : null,
    lumaMoyenne: luma.mean === undefined ? null : luma.mean,
    noir: luma.mean !== undefined && luma.mean < 8,
    erreur: luma.error || null
  };
}

module.exports = { analyseRecording, analyseFichier, judgeJpeg };
