/* MultiCam — J09 POC : changement de caméra pendant un MediaRecorder actif.
 *
 * POC / DIAGNOSTIQUE UNIQUEMENT. Aucun fichier produit n'est modifié : ce script
 * pilote le plugin tel qu'il est installé (`startRecordVideo`, `switchCamera`,
 * `stopRecordVideo`, `capturePreviewSurface`) et mesure.
 *
 * CE QUE LE SCRIPT NE FAIT PAS, VOLONTAIREMENT :
 *   - il ne touche ni au protocole, ni au modèle produit, ni à l'UI ;
 *   - il ne choisit AUCUNE stratégie de segmentation ;
 *   - il ne masque rien : une erreur de caméra est enregistrée telle quelle.
 *
 * RÈGLE DE PREUVE : les MP4 ne sont JAMAIS écrits dans le dépôt. Ils sont tirés
 * vers un dossier temporaire hors workspace (`MEDIA`), et le rapport ne garde
 * que métadonnées ffprobe + sha256. Voir la décision §35 de ce POC.
 *
 * RÈGLE DE MESURE : la preuve décisive n'est PAS la durée du conteneur. Quand la
 * caméra est libérée en cours de route, l'audio continue d'écrire et le
 * conteneur paraît normal alors que la piste VIDÉO est tronquée. On compare donc
 * toujours video.duree à audio.duree.
 *
 * RÈGLE D'ATTRIBUTION : la fin de la piste vidéo se compare au switch en temps
 * MURAL, pas en PTS brut. Le muxer MediaRecorder conserve une queue d'environ
 * 1.5 s qui n'est écrite qu'au stop ; comparer un PTS à l'horloge murale ferait
 * conclure à tort que la vidéo meurt AVANT le switch. `decaleVideo()` calcule
 * le décalage conteneur/mur et rend la comparaison honnête.
 */

"use strict";

const fs = require("fs");
const zlib = require("zlib");
const path = require("path");
const { execFileSync } = require("child_process");

const PKG = "fr.emmanuel.multicam";
const CAP_SERIAL = process.env.CAP_SERIAL || "61d54bba7d91";
const CDP_PORT = process.env.CDP_PORT || "9223";
const HERE = __dirname;
const OUT = path.join(HERE, "evidence");
const SHOTS = path.join(OUT, "jpg");
/* Les MP4 sont LARGES (6 à 24 Mo chacun, 100 Mo pour une session). Ils ne
 * doivent JAMAIS atterrir dans le dépôt : le `.gitignore` de la racine n'exclut
 * que .DS_Store, donc un `git add -A` committerait des centaines de Mo. On les
 * écrit hors du workspace, dans un dossier temporaire, et on n'en garde que les
 * métadonnées (ffprobe) + checksums dans le rapport. */
const MEDIA = process.env.POC_MEDIA_DIR
  || path.join(require("os").tmpdir(), "multicam-j09-poc");
fs.mkdirSync(MEDIA, { recursive: true });

/* ---------- rapport ---------- */
const ev = {
  poc: "J09-changement-camera-pendant-REC",
  mediaHorsDepot: MEDIA,
  device: null,
  inventory: null,
  phases: [],
  segments: [],
  switches: [],
  pixelcopy: {},
  errors: [],
  notes: []
};
const logLines = [];
function say(line) {
  logLines.push(line);
  console.log(line);
}

/* Les preuves JPEG sont un dossier à part entière : on le crée au chargement
 * pour qu'un writeJpeg ne puisse pas échouer sur un dossier absent. */
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (o) => JSON.stringify(o);

function adb(args, opts) {
  return execFileSync("adb", ["-s", CAP_SERIAL].concat(args), Object.assign({
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024
  }, opts || {}));
}
function adbTry(args) {
  try { return adb(args); } catch (e) { return (e.stdout || "") + (e.stderr || "") + ""; }
}

function coldStart() {
  adb(["shell", "am", "force-stop", PKG]);
  adb(["shell", "am", "start", "-n", PKG + "/.MainActivity"]);
  let pid = "";
  for (let i = 0; i < 40; i++) {
    sleep(400);
    pid = adbTry(["shell", "pidof", PKG]).trim().split(/\s+/)[0] || "";
    if (pid) break;
  }
  if (!pid) throw new Error("pid introuvable");
  try { adb(["forward", "--remove", "tcp:" + CDP_PORT]); } catch (e) {}
  adb(["forward", "tcp:" + CDP_PORT, "localabstract:webview_devtools_remote_" + pid]);
  say("COLD_START serial=" + CAP_SERIAL + " pid=" + pid + " cdp=" + CDP_PORT);
  return pid;
}

async function attach(label) {
  /* Le WebView met quelques secondes à exposer sa cible CDP après le
   * démarrage du process : on réessaie au lieu de conclure trop vite. */
  let page = null, last = "";
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const list = await res.json();
      page = list.find((t) => t.type === "page" && /index\.html/.test(t.url)) || list.find((t) => t.type === "page");
      if (page) break;
      last = "aucune cible page (" + list.length + " cibles)";
    } catch (e) { last = e.message; }
    await sleep(600);
  }
  if (!page) throw new Error("CDP indisponible sur " + label + " : " + last);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res2, rej) => {
    ws.addEventListener("open", res2);
    ws.addEventListener("error", () => rej(new Error("CDP socket")));
  });
  let id = 0;
  const pend = new Map();
  ws.addEventListener("message", (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pend.has(m.id)) {
      const { res: r, rej: j } = pend.get(m.id);
      pend.delete(m.id);
      if (m.error) j(new Error(json(m.error)));
      else r(m.result);
    }
  });
  const logcat = [];
  return {
    label,
    logcat,
    /* Évalue dans le WebView. `await` active awaitPromise (promesses JS). */
    ev(expr, awaitPromise) {
      const mid = ++id;
      return new Promise((r, j) => {
        /* 60 s : un `startRecordVideo` qui ne rend jamais la main (recorder
         * resté dans un état invalide) doit être constaté comme un ÉCHEC
         * mesuré, pas comme un timeout indistinguable d'un device lent. */
        const t = setTimeout(() => { pend.delete(mid); j(new Error("timeout CDP (60s)")); }, 60000);
        pend.set(mid, {
          res: (x) => { clearTimeout(t); r(x); },
          rej: (e) => { clearTimeout(t); j(e); }
        });
        ws.send(json({
          id: mid, method: "Runtime.evaluate",
          params: { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true }
        }));
      }).then((res) => {
        if (res.exceptionDetails) {
          const ex = res.exceptionDetails.exception || res.exceptionDetails;
          throw new Error("EXCEPTION " + (ex.description || ex.value));
        }
        return res.result && res.result.value;
      });
    },
    /* `returnByValue` renvoie l'objet JS tel quel quand la promesse résout un
     * objet, et une chaîne quand elle résout du JSON : on accepte les deux
     * plutôt que d'imposer un aller-retour de sérialisation au POC. */
    evJson(expr, awaitPromise) {
      return this.ev(expr, awaitPromise).then((v) => {
        if (typeof v === "string") {
          try { return JSON.parse(v); } catch (e) { return { _brut: v }; }
        }
        return v;
      });
    },
    close() { try { ws.close(); } catch (e) {} }
  };
}

function screenshot(name) {
  const dest = path.join(SHOTS, name);
  const raw = execFileSync("adb", ["-s", CAP_SERIAL, "exec-out", "screencap", "-p"],
    { maxBuffer: 64 * 1024 * 1024, encoding: "buffer" });
  fs.writeFileSync(dest, raw);
  say("SHOT " + name + " " + raw.length + " octets");
  return dest;
}

/* ---------- liste des MP4 présents dans le cache de l'app ---------- */
function listRecordings() {
  const raw = adbTry(["exec-out", "run-as", PKG, "ls", "-la", "cache"]);
  const files = [];
  /* `ls -la` de toybox aligne par colonnes : taille, date, heure, nom. On ne
   * dépend pas du nombre d'espaces mais du NOM en fin de ligne, qui est le
   * seul champ qu'on cherche (les .mp4 du cache de l'app). */
  raw.split(/\r?\n/).forEach((l) => {
    const m = /(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(\S+\.mp4)\s*$/.exec(l);
    if (m) files.push({ name: m[2], bytes: Number(m[1]) });
  });
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/* Purge STRICTEMENT limitée aux .mp4 du cache de l'app. Aucun `rm -r`, aucun
 * glob large : on liste, on filtre sur le nom déjà validé par listRecordings,
 * puis on supprime fichier par fichier. Le but est que le POC puisse attribuer
 * chaque segment à son run, pas de faire du ménage. */
function purgeCacheRecordings() {
  const files = listRecordings();
  let n = 0;
  for (const f of files) {
    if (!/^videoTmp(_\d+)?\.mp4$/.test(f.name)) continue;   /* garde-fou */
    const out = adbTry(["exec-out", "run-as", PKG, "rm", "-f", "cache/" + f.name]);
    if (!/No such file|denied/i.test(out)) n++;
  }
  return n;
}

function pullRecording(name, destName) {
  /* Garde-fou : un préfixe `undefined` a déjà produit un fichier parasite.
   * On refuse de le réintroduire. */
  if (!destName || String(destName).indexOf("undefined") === 0) {
    throw new Error("pullRecording: prefixe de destination manquant (bug d'appel)");
  }
  const dest = path.join(MEDIA, destName);
  const raw = execFileSync("adb", ["-s", CAP_SERIAL, "exec-out", "run-as", PKG, "cat", "cache/" + name],
    { maxBuffer: 256 * 1024 * 1024, encoding: "buffer" });
  fs.writeFileSync(dest, raw);
  return { path: dest, bytes: raw.length };
}

/* `sha256` reçoit un chemin ABSOLU hors dépôt : on refuse un chemin relatif
 * pour éviter de hasher par erreur un fichier du workspace. */
function sha256(file) {
  if (!path.isAbsolute(file)) throw new Error("sha256: chemin absolu attendu, reçu " + file);
  return execFileSync("shasum", ["-a", "256", file], { encoding: "utf8" }).split(/\s+/)[0];
}

function ffprobe(file) {
  try {
    const out = execFileSync("ffprobe", [
      "-v", "error", "-print_format", "json",
      "-show_format", "-show_streams", file
    ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(out);
  } catch (e) {
    return { error: String((e.stdout || "") + (e.stderr || "")).slice(0, 400) };
  }
}

/* ---------- extraction des instants réels d'un MP4 ---------- */
function firstFramePts(file) {
  try {
    const out = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "frame=best_effort_timestamp_time,pkt_dts_time,pict_type",
      "-read_intervals", "%+#1", "-print_format", "json", file
    ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    const j = JSON.parse(out);
    const f = (j.frames || [])[0] || {};
    return Number(f.best_effort_timestamp_time);
  } catch (e) { return null; }
}

function lastFramePts(file) {
  try {
    /* On lit le nombre de frames puis on demande les dernières : ffprobe
     * n'a pas de "dernière frame", on demande donc TOUTES les timestamps et
     * on prend la dernière. Un clip de 10 s à 30 fps reste raisonnable. */
    const out = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "frame=best_effort_timestamp_time",
      "-print_format", "csv=p=0", file
    ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const lines = out.trim().split(/\r?\n/).map(Number).filter((n) => isFinite(n));
    return lines.length ? lines[lines.length - 1] : null;
  } catch (e) { return null; }
}

/* DECALAGE MUR <-> PTS.
 *
 * MediaRecorder ne scelle pas sa queue au fil de l'eau : à l'arrêt, il écrit
 * encore ~1.5 s de données déjà capturées. Le PTS de la dernière frame vidéo
 * désigne donc un instant ANTERIEUR de ~1.5 s à l'heure murale du stop.
 *
 * Conséquence : comparer `dernierPTS_video` à l'horloge murale fait croire que
 * la vidéo s'est arrêtée AVANT le switch alors qu'elle s'est arrêtée APRÈS.
 * On mesure donc le décalage du segment de référence (la piste la plus longue,
 * ici l'audio, qui elle est complète) et on l'applique à la vidéo :
 *
 *   décalage = recWall - dureeAudio
 *   mortVideo (mur) = décalage + dernierPTS_video
 *
 * C'est ce qui permet d'attribuer, ou non, la troncature au switch.
 */
function decaleVideo({ recWallMs, dureeAudioSec, dernierPtsVideoSec }) {
  if (recWallMs === undefined || recWallMs === null) return null;
  if (dureeAudioSec === undefined || dureeAudioSec === null) return null;
  if (dernierPtsVideoSec === undefined || dernierPtsVideoSec === null) return null;
  const offsetMs = recWallMs - dureeAudioSec * 1000;
  return {
    offsetMuxMs: Math.round(offsetMs),
    mortVideoMurMs: Math.round(offsetMs + dernierPtsVideoSec * 1000)
  };
}

/* Vrai écart de continuité VIDEO : plus grand saut entre deux timestamps de
 * frames consécutives, et nombre de "trous". Une piste tronquée (fin de
 * muxing) n'a pas de trou, elle s'arrête : on expose donc aussi le nombre de
 * frames et la dernière frame, pour distinguer "trou" de "fin de piste". */
function videoContinuity(file) {
  try {
    const out = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "frame=best_effort_timestamp_time",
      "-print_format", "csv=p=0", file
    ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const pts = out.trim().split(/\r?\n/).map(Number).filter((n) => isFinite(n));
    if (!pts.length) return { frames: 0 };
    /* intervalMoyen, PAS un fps : c'est l'écart moyen entre deux frames. Le
     * nommer "fps" avait fait lire 0.034 comme 0.034 fps dans un rapport, ce
     * qui est absurde ; on expose donc les deux, calculés l'un depuis l'autre. */
    const intervalMoyen = (pts[pts.length - 1] - pts[0]) / Math.max(1, pts.length - 1);
    let maxGap = 0, gapAt = null, gaps = 0;
    for (let i = 3; i < pts.length; i++) {
      const g = pts[i] - pts[i - 1];
      if (g > intervalMoyen * 3 && g > 0.2) { gaps++; }
      if (g > maxGap) { maxGap = g; gapAt = pts[i]; }
    }
    return {
      frames: pts.length,
      firstPts: pts[0],
      lastPts: pts[pts.length - 1],
      intervalMoyenSec: Number(intervalMoyen.toFixed(4)),
      fpsMoyen: Number((1 / intervalMoyen).toFixed(2)),
      maxGapSec: Number(maxGap.toFixed(3)),
      maxGapAtSec: gapAt === null ? null : Number(gapAt.toFixed(3)),
      trous_sup_200ms: gaps
    };
  } catch (e) { return { error: String(e.message).slice(0, 200) }; }
}

/* Dimensions d'un JPEG, sans dépendance externe : on lit le marqueur SOF.
 * Permet de tenter d'IDENTIFIER une caméra par la taille de son image — sur ce
 * device ça ne marche pas (la SurfaceView de preview garde la même taille pour
 * les deux caméras), mais il faut le MESURER plutôt que le supposer. */
function jpegDim(file) {
  try {
    const b = fs.readFileSync(file);
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xC0 || m === 0xC1 || m === 0xC2) {
        return { largeur: b.readUInt16BE(i + 7), hauteur: b.readUInt16BE(i + 5) };
      }
      if (m === 0xD8 || m === 0xD9 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      i += 2 + b.readUInt16BE(i + 2);
    }
    return null;
  } catch (e) { return null; }
}

/* Luminance moyenne d'un JPEG : un callback PixelCopy qui "réussit" peut
 * renvoyer une image TOUTE NOIRE (§ camera rules #5 : valider le CONTENU du
 * JPEG, pas seulement le succès du callback). On réduit à 1x1 en niveaux de
 * gris, ce qui donne la luminance moyenne sans dépendance externe. */
function jpegLuma(file) {
  try {
    const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file,
      "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
      { maxBuffer: 16 * 1024 * 1024 });
    return { mean: raw.length ? raw[0] : null };
  } catch (e) { return { error: String((e.stderr || "")).slice(0, 200) }; }
}

/* Luminance de frames EXTRAITES d'un MP4 à des positions données (0..1).
 *
 * Sert de contre-mesure à PixelCopy : si le MP4 contient des frames lisibles
 * alors que PixelCopy renvoie du noir, le défaut est dans PixelCopy et pas dans
 * la caméra. Sans cette contre-mesure, on confondrait « caméra front morte »
 * avec « PixelCopy front cassé », deux pannes très différentes. */
function extractFrameLuma(file, positions) {
  const out = [];
  /* On connaît déjà la liste des PTS vidéo : on extrait la frame à l'INDICE
   * correspondant, pas par timestamp. Un seek par timestamp au-delà de la fin
   * de piste fait retomber ffmpeg sur la dernière frame (mesure fausse), et un
   * `-ss` après un `-ss` mal placé lit la mauvaise image. L'indexation est
   * sans ambiguïté et n'exige aucune option ffmpeg exotique. */
  const cont = videoContinuity(file);
  if (!cont.frames) return positions.map((p) => ({
    positionDemandee: p, frameTrouvee: false, erreur: "aucune frame video"
  }));
  const outPts = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "frame=best_effort_timestamp_time",
    "-print_format", "csv=p=0", file
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const pts = outPts.trim().split(/\r?\n/).map(Number).filter((n) => isFinite(n));

  for (const p of positions) {
    const idx = Math.min(pts.length - 1, Math.max(0, Math.round(p * (pts.length - 1))));
    try {
      /* `-vf` doit venir APRÈS `-i` : c'est un filtre de SORTIE. Placé avant,
       * ffmpeg le prend pour une option d'entrée et refuse d'ouvrir le
       * fichier ("Option vf cannot be applied to input url"). */
      const raw = execFileSync("ffmpeg", [
        "-v", "error", "-i", file,
        "-vf", "select='eq(n\\," + idx + ")',scale=1:1",
        "-frames:v", "1",
        "-f", "rawvideo", "-pix_fmt", "gray", "-"
      ], { maxBuffer: 64 * 1024 * 1024 });
      out.push({
        positionDemandee: p,
        indexFrame: idx,
        ptsSec: pts[idx],
        frameTrouvee: raw.length > 0,
        luma: raw.length ? raw[0] : null
      });
    } catch (e) {
      out.push({
        positionDemandee: p, indexFrame: idx,
        frameTrouvee: false,
        erreur: String((e.stderr || e.message || "")).slice(0, 160)
      });
    }
  }
  return out;
}

/* Audio : instants réels de la piste audio (détection d'un trou). */
function audioSpans(file) {
  try {
    const out = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "a:0",
      "-show_entries", "packet=pts_time,duration_time",
      "-print_format", "csv=p=0", file
    ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const rows = out.trim().split(/\r?\n/).map((l) => l.split(",").map(Number)).filter((r) => isFinite(r[0]));
    if (!rows.length) return { packets: 0 };
    let maxGap = 0, gapAt = null;
    for (let i = 1; i < rows.length; i++) {
      const gap = rows[i][0] - rows[i - 1][0];
      if (gap > maxGap) { maxGap = gap; gapAt = rows[i][0]; }
    }
    return {
      packets: rows.length,
      firstPts: rows[0][0],
      lastPts: rows[rows.length - 1][0],
      maxGapSec: Number(maxGap.toFixed(3)),
      maxGapAtSec: gapAt === null ? null : Number(gapAt.toFixed(3))
    };
  } catch (e) { return { error: String(e.message).slice(0, 200) }; }
}

/* ---------- helpers JS injectés dans le WebView ---------- */

/* Un recorder brut : on n'utilise PAS MultiCamCameraRecord (il grossit avec la
 * preview permanente et n'a aucun switch). On appelle le plugin DIRECTEMENT
 * pour que chaque étape soit mesurable et attribuable. */
const JS_PREPARE = function (camera) {
  return new Promise(function (resolve) {
    var t0 = Date.now();
    if (window.__poc) { resolve({ skipped: true, atMs: t0 }); return; }
    window.__poc = { events: [], t: {} };
    function rec(name, detail) {
      var e = { name: name, atMs: Date.now(), detail: detail === undefined ? null : detail };
      window.__poc.events.push(e);
      console.log("POC_EVENT " + name + " atMs=" + e.atMs + (detail ? " detail=" + JSON.stringify(detail) : ""));
    }
    window.__poc.rec = rec;
    /* Ces trois horloges doivent être APPELABLES PLUSIEURS FOIS (la phase 3
     * fait 5 switchs dans une session). La version précédente s'écrivait
     * elle-même par-dessus sa propre fonction : le 2e appel levait
     * "p.t.request is not a function". On mémorise dans un champ à part et on
     * garde une fonction en façade. */
    window.__poc.markRequest = function () {
      window.__poc.t.request = Date.now();
      return window.__poc.t.request;
    };
    window.__poc.markRecorderStart = function () {
      window.__poc.t.recorderStart = Date.now();
      return window.__poc.t.recorderStart;
    };
    window.__poc.markRecorderStop = function () {
      window.__poc.t.recorderStop = Date.now();
      return window.__poc.t.recorderStop;
    };

    var CP = window.CameraPreview;
    if (!CP) { rec("error", "plugin_absent"); resolve({ ok: false, reason: "plugin_absent" }); return; }

    var opts = {
      x: 0, y: 0, width: window.innerWidth, height: window.innerHeight,
      camera: camera, toBack: true, tapPhoto: false, tapFocus: false,
      previewDrag: false, storeToFile: false, alpha: 0
    };
    rec("startCamera.request", { camera: camera, w: opts.width, h: opts.height });
    CP.startCamera(opts, function (r) {
      rec("startCamera.ok", r || null);
      window.__poc.t.cameraOpen = Date.now();
      resolve({ ok: true, atMs: window.__poc.t.cameraOpen, detail: r || null });
    }, function (e) {
      /* "Camera already started" n'est PAS une erreur de ce POC : la preview
       * permanente (§35.1) a déjà ouvert la caméra au boot, ce qui est
       * exactement la situation produit qu'on veut mesurer. On note qu'on
       * RÉUTILISE une caméra déjà ouverte, on ne tente pas de la rouvrir. */
      var reason = (e && e.message) ? e.message : String(e);
      rec("startCamera.error", reason);
      if (/already started/i.test(reason)) {
        window.__poc.t.cameraOpen = Date.now();
        resolve({ ok: true, reused: true, atMs: window.__poc.t.cameraOpen, reason: reason });
        return;
      }
      resolve({ ok: false, reason: reason });
    });
  });
};

/* REC via le plugin, avec les instants mesurés à chaque transition. */
const JS_REC_START = function (profile) {
  return new Promise(function (resolve) {
    var p = window.__poc;
    var CP = window.CameraPreview;
    p.rec("startRecordVideo.request", { profile: profile || "auto" });
    var payload = { cameraDirection: "back", width: 1280, height: 720, withFlash: false };
    if (profile) payload.camcorderProfile = profile;
    var t0 = Date.now();
    CP.startRecordVideo(payload, function (r) {
      var at = p.markRecorderStart();
      p.rec("startRecordVideo.ok", { ackAfterMs: at - t0 });
      resolve({ ok: true, atMs: at, ackAfterMs: at - t0, requestMs: t0 });
    }, function (e) {
      p.rec("startRecordVideo.error", String(e));
      resolve({ ok: false, reason: String(e), atMs: Date.now(), requestMs: t0 });
    });
  });
};

const JS_REC_STOP = function () {
  return new Promise(function (resolve) {
    var p = window.__poc;
    var t0 = Date.now();
    p.rec("stopRecordVideo.request");
    window.CameraPreview.stopRecordVideo(function (p2) {
      var at = p.markRecorderStop();
      p.rec("stopRecordVideo.ok", { path: p2, stopAfterMs: at - t0 });
      resolve({ ok: true, atMs: at, path: p2, stopAfterMs: at - t0 });
    }, function (e) {
      p.rec("stopRecordVideo.error", String(e));
      resolve({ ok: false, reason: String(e), atMs: Date.now(), stopAfterMs: Date.now() - t0 });
    });
  });
};

/* switchCamera : l'action du plugin, appelée telle quelle. Le plugin expose
 * `switchCamera()` qui fait `(cameraCurrentlyLocked + 1) % numberOfCameras`
 * — c'est le SEUL mécanisme de changement de caméra de la pile actuelle. */
const JS_SWITCH = function () {
  return new Promise(function (resolve) {
    var p = window.__poc;
    var t0 = p.markRequest();
    p.rec("switchCamera.request", { atMs: t0 });
    try {
      window.CameraPreview.switchCamera(function (r) {
        var at = Date.now();
        p.rec("switchCamera.ok", { afterMs: at - t0, result: r === undefined ? null : r });
        resolve({ ok: true, requestedAtMs: t0, atMs: at, afterMs: at - t0 });
      }, function (e) {
        var at = Date.now();
        p.rec("switchCamera.error", String(e));
        resolve({ ok: false, requestedAtMs: t0, atMs: at, afterMs: at - t0, reason: String(e) });
      });
    } catch (e) {
      p.rec("switchCamera.throw", String(e));
      resolve({ ok: false, requestedAtMs: t0, atMs: Date.now(), afterMs: Date.now() - t0, reason: String(e) });
    }
  });
};

/* PixelCopy : on interroge le plugin pour mesurer le PREMIER JPEG après switch.
 * On enregistre le JPEG (petit, autorisé en preuve) pour prouver de quelle
 * caméra il vient. */
const JS_PIXELCOPY = function (tag) {
  return new Promise(function (resolve) {
    var p = window.__poc;
    var t0 = Date.now();
    p.rec("capturePreviewSurface.request", { tag: tag });
    window.CameraPreview.capturePreviewSurface({ quality: 70 }, function (data) {
      var at = Date.now();
      var len = (typeof data === "string") ? data.length : 0;
      p.rec("capturePreviewSurface.ok", { tag: tag, afterMs: at - t0, b64len: len });
      resolve({ ok: true, tag: tag, atMs: at, afterMs: at - t0, base64: data });
    }, function (e) {
      var at = Date.now();
      p.rec("capturePreviewSurface.error", { tag: tag, afterMs: at - t0, err: String(e) });
      resolve({ ok: false, tag: tag, atMs: at, afterMs: at - t0, reason: String(e) });
    });
  });
};

const JS_POC_STATE = "JSON.stringify({events:window.__poc.events,t:window.__poc.t})";

/* Ecriture compressee des logcats bruts.
 *
 * Un logcat de campagne pese 2 a 6 Mo et n'a aucun interet en clair : 95 % est
 * du bruit systeme. Les 30 Mo bruts ont ete compresses a ~3 Mo sans perdre une
 * seule ligne. Les extraits `-pertinent.txt` / `-anomalies.txt` restent en clair.
 * Tous les lecteurs (logcat-filtre.js, valider-chronologie.js) acceptent les
 * deux formes. */
function ecrireLogcat(nom, texte) {
  fs.writeFileSync(path.join(OUT, nom + ".gz"), zlib.gzipSync(Buffer.from(texte, "utf8"), { level: 9 }));
  return path.join(OUT, nom + ".gz");
}

function writeJpeg(base64, name) {
  if (!base64) return null;
  const buf = Buffer.from(base64, "base64");
  /* PREUVE JPEG AUTORISÉE, mais on borne la taille : on garde des vignettes
   * de diagnostic, pas des images exploitables. */
  const dest = path.join(SHOTS, name);
  fs.writeFileSync(dest, buf);
  return { path: path.relative(HERE, dest), bytes: buf.length };
}

module.exports = {
  ecrireLogcat,
  PKG, CAP_SERIAL, CDP_PORT, HERE, OUT, SHOTS, MEDIA, ev, logLines, say,
  sleep, json, adb, adbTry, coldStart, attach, screenshot,
  listRecordings, purgeCacheRecordings, pullRecording, sha256, ffprobe, jpegDim,
  firstFramePts, lastFramePts, audioSpans, writeJpeg, jpegLuma, videoContinuity,
  decaleVideo, extractFrameLuma,
  JS_PREPARE, JS_REC_START, JS_REC_STOP, JS_SWITCH, JS_PIXELCOPY, JS_POC_STATE
};
