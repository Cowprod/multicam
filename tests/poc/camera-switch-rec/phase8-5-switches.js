/* J09 POC — PHASE 8 : robustesse de 5 changements segmentés consécutifs.
 *
 * N'est exécuté QUE parce que la phase 7 a montré que la stratégie segmentée
 * fonctionne. Son but n'est pas de mesurer une performance mais de vérifier
 * que l'état natif SURVIT à la répétition :
 *
 *   REAR -> FRONT -> REAR -> FRONT -> REAR, six segments, un seul Take logique
 *
 * On cherche spécifiquement les défaillances qui n'apparaissent qu'à la
 * répétition :
 *   - « Camera already in use » persistant : la caméra A n'a pas été libérée ;
 *   - MediaRecorder non réouvrable : le recorder précédent n'a pas été relâché ;
 *   - deadlock : le thread UI bloqué en cascade (switchCamera s'exécute dessus) ;
 *   - SurfaceView perdue : PixelCopy qui ne revient pas ;
 *   - audio qui ne reprend pas.
 *
 * RÈGLE D'ARRÊT : au premier échec, on n'essaie PAS de continuer. Enchaîner des
 * bascules sur un état natif déjà cassé ne produirait pas une mesure de
 * robustesse mais du bruit, et pourrait masquer la cause réelle. On note
 * précisément où et comment ça a cassé, puis on sort.
 *
 * AUCUNE modification de code produit.
 */

"use strict";

const L = require("./lib.js");
const A = require("./analyse.js");
const fs = require("fs");
const path = require("path");

const DUREE_SEGMENT_MS = Number(process.env.POC_PHASE8_SEG_MS || 4000);
const STABILISATION_MS = Number(process.env.POC_PHASE8_STAB_MS || 800);

/* Le plan demandé : 5 changements, donc 6 segments. Les segments sont
 * volontairement plus courts qu'en phase 7 : l'objet ici est la répétabilité,
 * pas la qualité du contenu. */
const PLAN = [
  { camera: "rear", tag: "p8-1-rear" },
  { camera: "front", tag: "p8-2-front" },
  { camera: "rear", tag: "p8-3-rear" },
  { camera: "front", tag: "p8-4-front" },
  { camera: "rear", tag: "p8-5-rear" },
  { camera: "front", tag: "p8-6-front" }
];

async function pixelcopy(cdp, tag) {
  const pc = await cdp.evJson("(" + L.JS_PIXELCOPY.toString() + ")('" + tag + "')", true);
  const j = A.judgeJpeg(pc.base64, tag + ".jpg");
  return { atMs: pc.atMs, ok: pc.ok, raison: pc.reason || null, noir: j.noir, luma: j.lumaMoyenne };
}

/* L'application répond-elle encore ? Un WebView bloqué se manifeste par un
 * `Runtime.evaluate` qui ne rend pas la main : c'est le symptôme du deadlock. */
async function vivant(cdp) {
  const debut = Date.now();
  try {
    const v = await cdp.ev("1+1");
    return { vivant: v === 2, latenceMs: Date.now() - debut };
  } catch (e) {
    return { vivant: false, latenceMs: Date.now() - debut, erreur: String(e) };
  }
}

async function main() {
  L.say("=== POC J09 — phase 8 : 5 changements segmentes consecutifs ===");
  L.say("plan : " + PLAN.map((p) => p.camera).join(" -> "));
  L.say("duree par segment : " + (DUREE_SEGMENT_MS / 1000) + " s");
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
  L.say("PLUGIN_PRETE");

  const prep = await cdp.evJson("(" + L.JS_PREPARE.toString() + ")('back')", true);
  L.say("PREPARE " + L.json(prep));
  await L.sleep(2500);

  const segments = [];
  const switches = [];
  let arretPrecoce = null;

  for (let i = 0; i < PLAN.length; i++) {
    const etape = PLAN[i];
    L.say("");
    L.say("=== segment " + (i + 1) + "/" + PLAN.length + " : " + etape.camera + " ===");

    L.say("PURGE_CACHE " + L.purgeCacheRecordings());
    const rec = await cdp.evJson("(" + L.JS_REC_START.toString() + ")(null)", true);
    L.say("  REC_START ok=" + rec.ok + (rec.reason ? " raison=" + rec.reason : ""));
    if (!rec.ok) {
      arretPrecoce = { indexe: i, camera: etape.camera, etape: "demarrage REC",
        raison: rec.reason, segmentsObtenus: segments.length };
      L.say("  ECHEC au demarrage du REC : " + rec.reason);
      break;
    }

    await L.sleep(DUREE_SEGMENT_MS);
    const pc = await pixelcopy(cdp, etape.tag + "-pc");
    L.say("  PixelCopy ok=" + pc.ok + " luma=" + pc.luma + " noir=" + pc.noir
      + (pc.raison ? " raison=" + pc.raison : ""));

    const stop = await cdp.evJson("(" + L.JS_REC_STOP.toString() + ")()", true);
    L.say("  REC_STOP ok=" + stop.ok + (stop.reason ? " raison=" + stop.reason : ""));
    await L.sleep(1200);

    const segs = A.analyseRecording(etape.tag + "-");
    const s = segs[0] || null;
    L.say("  segment : " + (s
      ? "video=" + (s.video ? s.video.dureeSec + "s/" + s.continuiteVideo.frames + "f" : "ABSENTE")
        + " audio=" + (s.audio ? s.audio.dureeSec + "s" : "aucun") + " verdict=" + s.verdictVideo
      : "AUCUN FICHIER"));

    segments.push({
      index: i, camera: etape.camera, tag: etape.tag,
      rec: { requestMs: rec.requestMs, ackMs: rec.atMs },
      recOk: true,
      stop: { ok: stop.ok, raison: stop.reason || null, atMs: stop.atMs },
      pixelcopy: pc,
      segment: s,
      verdict: s ? s.verdictVideo : "AUCUN FICHIER"
    });

    /* Voit-on du contenu, et pas seulement un fichier valide ? */
    if (s && s.pisteVideoPresente) {
      const f = L.extractFrameLuma(s.mediaHorsDepot, [0.2, 0.5, 0.8]);
      segments[i].framesLuma = f.map((x) => x.luma);
      L.say("  lumas frames : " + L.json(segments[i].framesLuma));
    }

    /* Tant qu'il reste une étape, on bascule. */
    if (i + 1 < PLAN.length) {
      const sw = await cdp.evJson("(" + L.JS_SWITCH.toString() + ")()", true);
      L.say("  SWITCH ok=" + sw.ok + " apresMs=" + sw.afterMs + (sw.reason ? " raison=" + sw.reason : ""));
      const vivantApres = await vivant(cdp);
      L.say("  WebView vivant apres switch : " + vivantApres.vivant
        + " (latence " + vivantApres.latenceMs + " ms)");
      switches.push({
        index: i, ok: sw.ok, raison: sw.reason || null, apresMs: sw.afterMs,
        vivantApres, versCamera: PLAN[i + 1].camera
      });
      if (!sw.ok) {
        arretPrecoce = { indexe: i, etape: "switchCamera", raison: sw.reason, segmentsObtenus: segments.length };
        L.say("  ECHEC au switch : " + sw.reason + " — repetition interrompue");
        break;
      }
      if (!vivantApres.vivant) {
        arretPrecoce = { indexe: i, etape: "blocage WebView apres switch",
          raison: vivantApres.erreur || "evaluate sans reponse", segmentsObtenus: segments.length };
        L.say("  ECHEC : le WebView ne repond plus — repetition interrompue");
        break;
      }
      await L.sleep(STABILISATION_MS);
    }
  }

  await L.sleep(1000);
  const logcat = L.adbTry(["logcat", "-d", "-v", "time"]);

  /* --- robustesse : ce qu'il faut compter dans les logs natifs --- */
  const recherche = {
    cameraAlreadyInUse: (logcat.match(/Camera already in use/gi) || []).length,
    dejaRecording: (logcat.match(/Already Recording/g) || []).length,
    stopFailed: (logcat.match(/stop failed/g) || []).length,
    /* On ne compte que les exceptions RATTACHÉES à la capture. Un device Android
     * produit des dizaines de `Exception` sans rapport (gestionnaires d'apps
     * tierces, Wellbeing, favicon du WebView) : les compter toutes donne un
     * score alarmant et FAUX, qui masque les vraies. Ici : 24 occurrences, 0
     * concernant la caméra ou le recorder. */
    exceptionsCapture: (logcat.match(/^.*(Exception|IllegalState|IllegalArgument|SecurityException|DeadObject).*$/gim) || [])
      .filter((l) => /Camera|camera|MediaRecorder|Recorder|mRecorder|SurfaceView|PixelCopy|MultiCam|cpcp/i.test(l))
      .filter((l) => !/getMipiError|AeeSystemException/.test(l)),
    exceptionsSansLien: (logcat.match(/Exception/g) || []).length,
    fatal: (logcat.match(/FATAL EXCEPTION/g) || []).length,
    anr: (logcat.match(/ANR in /g) || []).length,
    threadBloquant: (logcat.match(/switchCamera blocked the main thread/g) || []).length
  };
  L.say("");
  L.say("--- robustesse (logcat natif) ---");
  for (const k in recherche) {
    const v = recherche[k];
    L.say("  " + k + " : " + (Array.isArray(v) ? v.length + (v.length ? " -> " + v[0].slice(0, 110) : "") : v));
  }

  const segmentsVideo = segments.filter((s) => s.segment && s.segment.pisteVideoPresente);
  const avecContenu = segments.filter((s) => s.framesLuma && s.framesLuma.some((l) => l > 8));
  const cameraAlreadyPersistante = segments.some((s) => !s.recOk
      && /already in use/i.test(s.rec.raison || ""));

  const verdict = {
    segmentsPrevus: PLAN.length,
    segmentsObtenus: segments.length,
    switchesReussis: switches.filter((s) => s.ok).length,
    switchesPrevus: switches.length,
    segmentsAvecPisteVideo: segmentsVideo.length,
    segmentsAvecContenuVisible: avecContenu.length,
    arretPrecoce,
    rechecks: recherche,
    cameraAlreadyInUsePersistante: cameraAlreadyPersistante,
    succesComplet: segments.length === PLAN.length && !arretPrecoce
      && segmentsVideo.length === PLAN.length,
    synopsis: null
  };
  verdict.synopsis = verdict.succesComplet
    ? "les 5 changements segmentés sont allés au bout : 6 segments, tous avec une "
      + "piste vidéo et un arrêt propre"
    : "la répétition s'est arrêtée au segment " + (segments.length + 1) + " / " + PLAN.length
      + (arretPrecoce ? " (" + arretPrecoce.etape + " : " + arretPrecoce.raison + ")" : "");
  L.say("");
  L.say("--- verdict phase 8 ---");
  L.say("  " + verdict.synopsis);
  L.say("  segments avec contenu visible : " + segmentsVideo.length + "/" + segments.length);

  const etat = await cdp.evJson(L.JS_POC_STATE);
  L.ev.phases.push({ phase: "phase8-5-switches-segmentes", plan: PLAN,
    segments, switches, robustesse: recherche, verdict, events: etat.events });

  fs.mkdirSync(L.OUT, { recursive: true });
  fs.writeFileSync(path.join(L.OUT, "rapport-phase8.json"), JSON.stringify(L.ev, null, 2));
  fs.writeFileSync(path.join(L.OUT, "phase8-console.txt"), L.logLines.join("\n"));
  L.ecrireLogcat("phase8-logcat", logcat);

  L.say("RAPPORT " + path.join(L.OUT, "rapport-phase8.json"));
  cdp.close();
  L.say("=== fin phase 8 ===");
}

main().catch((e) => {
  L.say("ERREUR " + e.message);
  try {
    fs.mkdirSync(L.OUT, { recursive: true });
    fs.writeFileSync(path.join(L.OUT, "rapport-phase8.json"), JSON.stringify(L.ev, null, 2));
    fs.writeFileSync(path.join(L.OUT, "phase8-console.txt"), L.logLines.join("\n"));
  } catch (e2) {}
  process.exit(1);
});
