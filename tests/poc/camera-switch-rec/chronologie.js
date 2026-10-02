/* J09 POC — chronologie : reconstruction de l'axe temporel depuis le logcat natif.
 *
 * POURQUOI CE FICHIER
 * -------------------
 * Les phases 1 à 5 mesurent les instants côté WebView (`Date.now()`). Mais
 * certaines transitions n'existent QUE côté natif : la libération de la caméra
 * A et l'ouverture de la caméra B n'ont aucun événement JS associé.
 *
 * Plutôt que d'ajouter des `Log.d()` dans le plugin produit — ce qui
 * modifierait du code applicatif pour les besoins d'un POC — on lit les
 * marqueurs que le plugin ÉMET DÉJÀ. Ils sont stables et uniques :
 *
 *   CameraActivity  "numberOfCameras: N"        → entrée dans switchCamera()
 *   CameraActivity  "cameraCurrentlyLocked :="  → caméra A déjà libérée
 *   CameraActivity  "cameraCurrentlyLocked new:"→ libération faite, ouverture de B qui suit
 *   CameraActivity  "camera parameter NULL"     → Camera.open(B) a réussi
 *   CameraPreview   "Camera started"            → preview B démarrée
 *   CameraActivity  "stopRecord"                → entrée dans stopRecordVideo()
 *   CameraActivity  "Starting recording"        → entrée dans startRecordVideo()
 *
 * Les deux horloges (WebView `Date.now()` et logcat) sont celle du DEVICE, donc
 * directement comparables. Il faut seulement reconstruire l'année, absente du
 * format `-v time`, et gérer le changement de jour pendant une session.
 */

"use strict";

const L = require("./lib.js");

/* Contexte temporel du DEVICE, lu une seule fois : année et décalage UTC.
 *
 * Le logcat `-v time` donne `MM-DD HH:MM:SS.mmm` en heure LOCALE du device,
 * sans année et sans fuseau. Les événements JS (`Date.now()`) sont déjà de
 * vraies ms epoch. Il faut donc reconstruire l'epoch du device à partir de son
 * heure locale : c'est ce qui rend les deux horloges comparables.
 *
 * On lit l'année ET le décalage sur le device lui-même plutôt que de supposer
 * que l'hôte est dans le même fuseau : c'est une supposition, pas une mesure. */
let CONTEXTE = null;

function contexte() {
  if (CONTEXTE) return CONTEXTE;
  const annee = Number((/(\d{4})/.exec(L.adbTry(["shell", "date", "+%Y"])) || [])[1]);
  const decalage = String(L.adbTry(["shell", "date", "+%z"])).trim();   /* "+0200" */
  const m = /^([+-])(\d{2})(\d{2})$/.exec(decalage);
  const minutes = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  CONTEXTE = { annee: Number.isFinite(annee) ? annee : new Date().getFullYear(), minutes };
  return CONTEXTE;
}

function parseLigne(ligne) {
  /* `-v time` produit `MM-DD HH:MM:SS.mmm L/tag (  pid): message`.
   *
   * Deux pièges réels rencontrés sur ce device :
   *   - le `( pid)` est OBLIGATOIRE mais peut être écrit `(32648)` ou `( 32648)`
   *     selon la version d'Android et selon le tag. Un motif qui laisse `(`
   *     dans le tag marche sur une forme et casse sur l'autre — c'est
   *     exactement ce qui est arrivé, le validateur ne couvrant qu'une forme ;
   *   - le niveau et le tag sont séparés par `/` et non par un espace.
   * On interdit donc explicitement `(` dans le tag, et le PID est consommé par
   * un groupe optionnel. Les deux formes sont couvertes par
   * `valider-chronologie.js`, y compris sur des lignes synthétiques. */
  const m = /^(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+([VDIWEF])\/?([^\s(]*)\s*(?:\(\s*\d+\))?\s*:\s?(.*)$/.exec(ligne);
  if (!m) return null;
  const [, mm, dd, HH, MM, SS, milli, niveau, tag, msg] = m;
  const { annee, minutes } = contexte();
  /* `Date.UTC` interpréterait l'heure locale du device comme de l'UTC ; on
   * retire donc le décalage du device pour obtenir l'epoch réel. */
  const ms = Date.UTC(annee, Number(mm) - 1, Number(dd), Number(HH), Number(MM), Number(SS), Number(milli))
    - minutes * 60000;
  return {
    ligne, ms, tag: tag || "", niveau, msg,
    brut: mm + "-" + dd + " " + HH + ":" + MM + ":" + SS + "." + milli
  };
}

/* Toutes les lignes du logcat, parsées. */
function parse(logcat) {
  const out = [];
  for (const l of logcat.split(/\r?\n/)) {
    const p = parseLigne(l);
    if (p) out.push(p);
  }
  return out;
}

/* Premier timestamp (ms epoch) d'un marqueur, dans une fenêtre temporelle.
 * La fenêtre évite qu'un marqueur d'un run précédent soit attribué au run
 * courant — exactement le piège du cache non purgé, transposé au logcat. */
function marqueur(entrees, regex, tDebut, tFin) {
  for (const e of entrees) {
    if (!regex.test(e.tag + " " + e.msg)) continue;
    if (tDebut !== undefined && tDebut !== null && e.ms < tDebut) continue;
    if (tFin !== undefined && tFin !== null && e.ms > tFin) continue;
    return e.ms;
  }
  return null;
}

/* Tous les timestamps d'un marqueur (pour compter les occurrences). */
function marqueurs(entrees, regex, tDebut, tFin) {
  return entrees.filter((e) => regex.test(e.tag + " " + e.msg)
    && (tDebut === undefined || tDebut === null || e.ms >= tDebut)
    && (tFin === undefined || tFin === null || e.ms <= tFin))
    .map((e) => e.ms);
}

/* Chronologie complète d'une transition « recorder A -> caméra B -> recorder B ».
 * Chaque champ est un ms epoch côté device, ou null si non observable. */
function transition(entrees, bornes) {
  const dans = (re) => marqueur(entrees, re, bornes.t0, bornes.t1);
  return {
    tSwitchEntreeNative: dans(/numberOfCameras:/),
    tCameraARelease: dans(/cameraCurrentlyLocked :=/),
    tCameraANouvelle: dans(/cameraCurrentlyLocked new:/),
    tCameraBOuverte: dans(/camera parameter (NULL|NOT supported|not supported)/) || dans(/CameraPreview currentFlashMode/),
    tPreviewB: dans(/Camera started/),
    tStopRecorderANative: dans(/stopRecord/),
    tStartRecorderBNative: dans(/Starting recording/),
    tStopRecorderBNative: dans(/stopRecord/)
  };
}

module.exports = { parse, parseLigne, marqueur, marqueurs, transition, contexte };
