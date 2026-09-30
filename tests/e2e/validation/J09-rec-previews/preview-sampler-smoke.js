#!/usr/bin/env node
/* Pilote de smoke J09-03 — REC reel d'un device Capture, avec lecture des
 * statistiques du sampler LOCAL (PixelCopy) et sauvegarde de 3 JPEG.
 *
 * Le plan de START est cree par le MASTER (contrainte J08 : un Master refuse
 * de consommer la camera, il exige au moins une Capture distante). Le MASTER
 * arme puis supervise ; la CAPTURE suit le plan, entre en REC et c'est sa
 * preview locale que l'on mesure.
 *
 * Aucun transport JPEG n'est observe ni ajoute : on lit uniquement l'etat
 * local du sampler sur la Capture.
 *
 * Preparation :
 *   PID=$(adb -s DEVICE shell pidof fr.emmanuel.multicam)
 *   adb -s DEVICE forward tcp:9223 localabstract:webview_devtools_remote_$PID
 *
 * Usage :
 *   node preview-sampler-smoke.js --sid 88FQCPDK --rec-ms 38000 \
 *        --out-dir logs/30-preview-sampler-30s
 */
const fs = require("fs");
const path = require("path");

const CAP_PORT = process.env.CDP_PORT || "9223";
const MASTER_PORT = process.env.MASTER_CDP_PORT || "9224";
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const SID = arg("sid", "88FQCPDK");
const REC_MS = parseInt(arg("rec-ms", "38000"), 10);
const OUT = arg("out-dir", "logs/30-preview-sampler-30s");
const SNAP_AT = [3000, 17000, 31000].map((n) => parseInt(n, 10));
/* `--inject` : le plan est injecte par le PONT DE PRODUCTION qui recoit les
 * plans du WebSocket (machine().onIncoming, appele par session-ws). Le REC, la
 * camera, le sampler et le STOP restent du code produit reel ; seul le
 * transport LAN du plan est court-circuite (hors perimetre J09-03 : quand le
 * master ne peut pas finir son echange d'horloge J07 sur ce LAN, l'armerement
 * echoue en `clock_stale` avant meme d'atteindre la camera). */
const INJECT = argv.indexOf("--inject") >= 0;
const TAKE = arg("take", "2");
const TOP_DELAY_MS = parseInt(arg("top-delay-ms", "2000"), 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (v) => JSON.stringify(v);

async function target(port) {
  const res = await fetch(`http://localhost:${port}/json`);
  const list = await res.json();
  const page = list.find((t) => t.type === "page" && /index\.html/.test(t.url)) || list.find((t) => t.type === "page");
  if (!page) throw new Error("aucune cible page CDP sur " + port);
  return page.webSocketDebuggerUrl;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error("ws CDP: " + url)));
  });
}

function makeEval(ws, label) {
  let seq = 0;
  return function evaluate(expression, awaitPromise) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout CDP " + label)), 30000);
      const onMsg = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id !== id) return;
        clearTimeout(t);
        ws.removeEventListener("message", onMsg);
        if (msg.error) return reject(new Error(label + " CDP " + JSON.stringify(msg.error)));
        const r = msg.result || {};
        if (r.exceptionDetails) {
          const d = r.exceptionDetails;
          return reject(new Error(label + " exception: " + ((d.exception && d.exception.description) || d.text)));
        }
        resolve(r.result ? r.result.value : undefined);
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({
        id, method: "Runtime.evaluate",
        params: { expression, awaitPromise: !!awaitPromise, returnByValue: true, userGesture: true }
      }));
    });
  };
}

const PHASE_EXPR = 'MultiCamStartService.machine() ? MultiCamStartService.machine().state.phase : "?"';

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const capWs = await connect(await target(CAP_PORT));
  const masWs = await connect(await target(MASTER_PORT));
  const cap = makeEval(capWs, "capture");
  const mas = makeEval(masWs, "master");
  const R = (s) => "window.MultiCam" + s;

  /* --- garde-fous cote CAPTURE avant tout --- */
  const pre = JSON.parse(await cap('(function(){return JSON.stringify({'
    + 'intervalMs: MultiCamPreviewSampler.INTERVAL_MS,'
    + 'quality: MultiCamPreviewSampler.QUALITY,'
    + 'running: MultiCamPreviewSampler.view().running,'
    + 'prepared: MultiCamCameraRecord.view().prepared,'
    + 'body: document.body.className})})()', false));
  console.log("PRE capture", json(pre));
  if (pre.intervalMs !== 1000) throw new Error("interval inattendu: " + pre.intervalMs);
  if (pre.quality !== 60) throw new Error("qualite inattendue: " + pre.quality);
  if (!pre.prepared) throw new Error("preview native absente : REC impossible");

  const masPre = JSON.parse(await mas('(function(){return JSON.stringify({'
    + 'ready: MultiCamStartService? 1:0,'
    + 'sid: (MultiCamSessionStore.get?' + R("SessionStore") + ':null)?1:0})})()', false));
  console.log("PRE master", json(masPre));

  /* --- 1. ARMEMENT --- */
  let armRes;
  if (INJECT) {
    /* Ecran ARM reel sur la CAPTURE (ouvre le cycle d'armement J07), puis plan
     * injecte par le pont de production. */
    await cap('MultiCamNav.show("arm",{sid:' + json(SID) + '})', false);
    await sleep(2500);
    armRes = await cap('(function(){var self=MultiCamConfig.get().deviceId;'
      + 'var off={}; off[self]=0;'
      + 'var plan={startPlanId:"J0903#1#1#1",sessionId:' + json(SID) + ',takeNumber:' + parseInt(TAKE, 10) + ','
      + 'targetStartMs:Date.now()+' + TOP_DELAY_MS + ',countdownSeconds:0,'
      + 'clockOffsets:off,participants:[{deviceId:self,role:"capture"}],'
      + 'createdByDeviceId:"injected-leader",profile:"FHD",createdAtMs:Date.now()};'
      + 'MultiCamStartService.machine().onIncoming({kind:"start_plan",sessionId:' + json(SID) + ','
      + 'from:"injected-leader",plan:plan}); return "PLAN INJECTE " + plan.startPlanId;})()', false);
    console.log("ARM capture", armRes);
  } else {
    await mas('MultiCamNav.show("arm",{sid:' + json(SID) + '})', false);
    await sleep(1500);
    armRes = await mas('MultiCamStartService.requestStart(' + json(SID) + ')'
      + '.then(function(v){return "OK " + v.startPlanId + " top=" + v.targetStartMs},'
      + 'function(e){return "KO " + String(e && e.message)})', true);
    console.log("ARM master", armRes);
    if (!/^OK/.test(String(armRes))) throw new Error("armement refuse: " + armRes);
  }

  /* --- 2. La CAPTURE suit le plan : attente de l'entree reelle en REC --- */
  const t0 = Date.now();
  let phase = "";
  while (Date.now() - t0 < 45000) {
    await sleep(500);
    phase = await cap(PHASE_EXPR, false);
    if (phase === "REC") break;
  }
  const recAt = Date.now();
  console.log("REC capture", phase, "apres", recAt - t0, "ms");
  if (phase !== "REC") throw new Error("la capture n'est pas en REC (phase=" + phase + ")");

  /* --- 3. Fenetre REC : echantillons a t+3s, t+17s, t+31s --- */
  const shots = [];
  let i = 0;
  while (i < SNAP_AT.length && Date.now() - recAt < REC_MS) {
    const wait = (recAt + SNAP_AT[i]) - Date.now();
    if (wait > 0) await sleep(wait);
    if (Date.now() - recAt > REC_MS) break;
    const ok = await cap('MultiCamPreviewSampler.view().stats.ok', false);
    /* peek() rend UNE sonde locale {seq, base64, bytes, completedAt}. */
    const probe = JSON.parse(await cap('(function(){var l=MultiCamPreviewSampler.peek();'
      + 'return JSON.stringify(l ? {seq:l.seq, bytes:l.bytes, completedAt:l.completedAt,'
      + 'base64:l.base64} : null)})()', false) || "null");
    const b64 = probe ? probe.base64 : "";
    const file = "sample-" + (i + 1) + "-seq" + (probe ? probe.seq : "none") + ".jpg";
    if (b64) {
      fs.writeFileSync(path.join(OUT, file), Buffer.from(b64, "base64"));
      const st = { atMs: Date.now() - recAt, ok, file, bytes: fs.statSync(path.join(OUT, file)).size };
      shots.push(st);
      console.log("SAMPLE", json(st));
    } else {
      shots.push({ atMs: Date.now() - recAt, ok, file: null });
      console.log("SAMPLE vide (peek indisponible) a ok=" + ok);
    }
    i++;
  }

  /* --- 4. Maintien du REC jusqu'a la dureur cible --- */
  const remain = (recAt + REC_MS) - Date.now();
  if (remain > 0) await sleep(remain);
  const midView = JSON.parse(await cap('JSON.stringify(MultiCamPreviewSampler.view())', false));
  const camMid = JSON.parse(await cap('JSON.stringify(MultiCamCameraRecord.view())', false));
  console.log("MIREC running=" + midView.running, "ok=" + midView.stats.ok,
    "cameraRecording=" + camMid.recording);

  /* --- 5. STOP reel. On tente d'abord le STOP master (chemin nominal), puis
   * le STOP local de la CAPTURE : c'est ce second chemin qui est garanti sur
   * un device isole, et c'est lui que le modele expose sur l'ecran REC. --- */
  const stopRes = INJECT ? "skip (mode injecte)" : await mas(
    '(function(){var m=MultiCamStartService.machine();'
    + 'if(!m) return "pas de machine"; m.stopLocal("smoke"); return "STOP master demande"})()', false);
  console.log("STOP master", stopRes);
  const tStop = Date.now();
  let capPhase = "";
  while (Date.now() - tStop < 12000) {
    await sleep(500);
    capPhase = await cap(PHASE_EXPR, false);
    if (capPhase === "STOPPED") break;
  }
  let stopPath = "master";
  if (capPhase !== "STOPPED") {
    console.log("-> STOP local de la capture");
    await cap('MultiCamStartService.machine().stopLocal("smoke")', false);
    stopPath = "capture_local";
    while (Date.now() - tStop < 30000) {
      await sleep(500);
      capPhase = await cap(PHASE_EXPR, false);
      if (capPhase === "STOPPED") break;
    }
  }
  await sleep(4000);
  console.log("STOP capture phase=" + capPhase, "en", Date.now() - tStop, "ms", "via=" + stopPath);

  /* --- 6. Etat final cote CAPTURE --- */
  const final = JSON.parse(await cap('(function(){return JSON.stringify({'
    + 'sampler: MultiCamPreviewSampler.view(),'
    + 'machine: MultiCamStartService.machine() ? MultiCamStartService.machine().state.phase : "?",'
    + 'camera: MultiCamCameraRecord.view(),'
    + 'take: MultiCamStartService.machine() ? MultiCamStartService.machine().state.lastStart : null})})()', false));

  const v = final.sampler, s = v.stats, samples = v.samples || [];
  const deltas = [];
  for (let k = 1; k < samples.length; k++) deltas.push(samples[k].requestedAt - samples[k - 1].requestedAt);
  const num = (a) => (a.length ? Math.min.apply(null, a) : null);
  const max = (a) => (a.length ? Math.max.apply(null, a) : null);
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);

  const jpegChecks = shots.filter((x) => x.file).map((x) => {
    const b = fs.readFileSync(path.join(OUT, x.file));
    return {
      file: x.file, bytes: b.length,
      soi: b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
      eoi: b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9
    };
  });

  const report = {
    sessionId: SID,
    intervalMs: pre.intervalMs,
    quality: pre.quality,
    recRequestedMs: REC_MS,
    recMeasuredMs: Date.now() - recAt,
    runningDuringRec: midView.running,
    cameraRecordingDuringRec: camMid.recording,
    runningAfterStop: v.running,
    timerPendingAfterStop: v.timerPending,
    inFlightAfterStop: v.inFlight,
    requested: s.requested, ok: s.ok,
    errors: s.error, noCallback: s.noCallback, skipped: s.skipped, lastError: s.lastError,
    finalPhase: final.machine,
    cameraPreparedAfterStop: final.camera.prepared,
    cameraRecordingAfterStop: final.camera.recording,
    durationMs: { min: num(samples.map((x) => x.durationMs)), max: max(samples.map((x) => x.durationMs)), avg: avg(samples.map((x) => x.durationMs)) },
    intervalObservedMs: { min: num(deltas), max: max(deltas), avg: avg(deltas) },
    bytes: { min: num(samples.map((x) => x.bytes)), max: max(samples.map((x) => x.bytes)), avg: avg(samples.map((x) => x.bytes)) },
    base64Length: { min: num(samples.map((x) => x.base64Length)), max: max(samples.map((x) => x.base64Length)), avg: avg(samples.map((x) => x.base64Length)) },
    jpegChecks,
    shots,
    recAck: final.take,
    stopPath,
    planOrigin: INJECT ? "onIncoming (pont WS de production)" : "requestStart master",
    videoPath: final.videoPath
  };

  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log("REPORT", json(report));

  capWs.close(); masWs.close();
  process.exit(0);
}

main().catch((e) => { console.error("ECHEC SMOKE:", e.message); process.exit(1); });
