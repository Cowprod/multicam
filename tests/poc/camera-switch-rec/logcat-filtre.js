/* J09 POC — utile : logcat réduit à ce qui concerne le switch.
 *
 * Le logcat brut fait 2 Mo par phase et contient surtout du bruit système sans
 * rapport avec la question posée (composeur, MDP, vendor power, polices…). Le
 * conserver tel quel produirait un dossier de preuves illisible et heavier que
 * nécessaire ; le supprimer serait perdre de l'information.
 *
 * On garde donc deux fichiers par phase :
 *   - <phase>-logcat-pertinent.txt : les lignes des composants qui participate
 *     à la caméra, à l'enregistrement et à l'app (la preuve exploitable) ;
 *   - <phase>-logcat-anomalies.txt : tout ce qui ressemble à une erreur, quelle
 *     qu'en soit la source, y compris hors périmètre connu.
 *
 * Une anomalie de la deuxième catégorie est exactement ce qu'il ne faut pas
 * rater : « aucune anomalie » est un résultat, pas une absence de travail.
 */

"use strict";

const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const L = require("./lib.js");

/* Composants qui participent réellement à la capture. */
const PERTINENT = /\b(MediaRecorder|MediaCodec|media\.|CameraPreview|CameraActivity|CameraDevice|CameraService|CameraService_proxy|CameraImpl|Camera2|CameraManager|CameraCaptureSession|CameraDeviceImpl|ImageReader|SurfaceTexture|BufferQueue|gralloc|PixelCopy|MultiCam|Camera)\b/i;

/* Signaux d'anomalie, indépendamment de la source. */
const ANOMALIE = /\b(FATAL|AndroidRuntime|Exception|IllegalState|IllegalArgument|SecurityException|DeadObject|ANR|Watchdog|abort|SIGSEGV|error|Error|ERROR|failed|Failed|FAILED|denied|timeout|not available|no frames)\b/;

const BRUIT_CERTAIN = /getMipiError|CcuAeeMgrDlInit|AeeSystemException|perf_lock_acq|CameraAlsSensor|CameraVirtualAlsSensor|splitClientPackageActivityName|Access denied finding property|Unknown extension type|DpEngine_WDMA|\[HWC\]|FontLog|BarFollowAnimation/i;

function classer(ligne) {
  if (ANOMALIE.test(ligne)) return "anomalie";
  if (PERTINENT.test(ligne)) return "pertinent";
  return null;
}

function reduire(texte) {
  const pertinent = [];
  const anomalies = [];
  for (const l of texte.split(/\r?\n/)) {
    if (!l.trim()) continue;
    /* Le bruit récurrent est retiré, MAIS jamais une ligne du HAL qui contient
     * aussi un mot d'erreur : on teste l'anomalie avant le bruit. */
    const c = classer(l);
    if (c === "anomalie") anomalies.push(l);
    else if (c === "pertinent" && !BRUIT_CERTAIN.test(l)) pertinent.push(l);
  }
  return { pertinent, anomalies };
}

/* Les logcats bruts pèsent ~30 Mo pour l'ensemble des campagnes : la très
 * grande majorité est du bruit système sans rapport avec la capture. On les
 * compresse en `.gz` — AUCUNE ligne n'est perdue, la preuve reste intégrale et
 * l'arbre de travail passe de 35 Mo à quelques Mo. Les extraits
 * `-pertinent.txt` / `-anomalies.txt` restent en clair et lisibles.
 * `chronologie.js` et `valider-segments.js` n'ont pas besoin des bruts. */
function lireBrut(f) {
  if (/\.gz$/.test(f)) {
    return zlib.gunzipSync(fs.readFileSync(f)).toString("utf8");
  }
  return fs.readFileSync(f, "utf8");
}

function main() {
  const args = process.argv.slice(2);
  const fichiers = args.length ? args
    : fs.readdirSync(L.OUT).filter((f) => /-logcat\.txt(\.gz)?$/.test(f))
      .map((f) => path.join(L.OUT, f));
  if (!fichiers.length) {
    L.say("aucun logcat dans " + L.OUT);
    return;
  }
  for (const f of fichiers) {
    if (!fs.existsSync(f)) continue;
    const brut = lireBrut(f);
    const { pertinent, anomalies } = reduire(brut);
    const base = path.basename(f).replace(/-logcat\.txt(\.gz)?$/, "");
    fs.writeFileSync(path.join(L.OUT, base + "-pertinent.txt"), pertinent.join("\n") + "\n");
    fs.writeFileSync(path.join(L.OUT, base + "-anomalies.txt"), anomalies.join("\n") + "\n");
    L.say(base + " : " + brut.split(/\r?\n/).length + " lignes brutes -> "
      + pertinent.length + " pertinentes, " + anomalies.length + " anomalies");
  }
}

main();
