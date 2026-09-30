/* MultiCam — J09-04 : smoke PHYSIQUE du transport des previews JPEG.
 *
 * Ce que ce script doit prouver, et rien d'autre :
 *
 *   CAPTURE                                        MASTER
 *   ───────                                        ───────
 *   preview-sampler (J09-03) 1 img/s
 *        │  preview-transport : enveloppe + backpressure
 *        ▼
 *   session-ws.sendPreviewFrame()  ─── WS réel, LAN ───▶  session-ws (serveur)
 *        (filtre : Masters de la session seulement)         │ preview_frame
 *                                                            ▼
 *                                              preview-inbox : 1 frame / Capture
 *
 * DIFFÉRENCE AVEC LE SMOKE J09-03 : ici le transport est RÉEL. J09-03
 * mesurait la production locale d'images ; J09-04 mesure l'arrivée des images
 * chez un Master, sur le réseau. Aucune injection de message : le plan de
 * démarrage passe par le pont de production (`start-service.machine().onIncoming`,
 * exactement le point d'entrée qu'utilise un vrai `start_plan` reçu en WS), et
 * les frames parcourent le vrai serveur WebSocket.
 *
 * Le lien physique (WS + présence + rôles) est établi par
 * `connectTo()` + `reSyncSession()`, c'est-à-dire le chemin de production.
 *
 * Preuves : rapport JSON, logs filtrés des deux devices, 3 JPEG décodés depuis
 * l'inbox du MASTER (pas depuis la Capture — ce serait faux), et le MP4 du REC.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const CAP_PORT = process.env.CDP_PORT || "9223";
const MASTER_PORT = process.env.MASTER_CDP_PORT || "9224";
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf("--" + name);
  return (i >= 0 && argv[i + 1]) ? argv[i + 1] : def;
}
const CAP_SERIAL = process.env.CAP_SERIAL || arg("cap-serial", "61d54bba7d91");
const MASTER_SERIAL = process.env.MASTER_SERIAL || arg("master-serial", "c0d8514d7d87");
const PKG = process.env.APP_PKG || "fr.emmanuel.multicam";

/* `--sid` absent = le MASTER cree la session (API de production). */
const SID = arg("sid", "");
const REC_MS = parseInt(arg("rec-ms", "30000"), 10);
const TOP_DELAY_MS = parseInt(arg("top-delay-ms", "2500"), 10);
/* `takeNumber` n'est PAS réutilisable sur un même device : la barrière
 * anti-double-REC de J07 (`localStartedTakes[takeNumber]`) refuse à raison un
 * plan pour un Take déjà démarré ici, même dans une autre session. C'est le
 * comportement voulu — on ne le contourne pas, on prend un Take inédit. */
const TAKE_ARG = parseInt(arg("take", "0"), 10);
const OUT = arg("out-dir", "logs/40-preview-transport-30s");
/* Instantanés de l'inbox MASTER : t+4s, t+14s, t+24s. */
const SNAP_AT = [4000, 14000, 24000].map((n) => parseInt(n, 10));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (v) => JSON.stringify(v);

/* ---------- CDP minimal (identique au smoke J09-03) ---------- */

async function target(port) {
  const res = await fetch("http://127.0.0.1:" + port + "/json/list");
  const list = await res.json();
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("aucune page debuggable sur le port " + port);
  return page.webSocketDebuggerUrl;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error("ws CDP: " + url)));
  });
}

/* Un listener PAR ÉVALUATION : le WebSocket global est une API DOM
 * (`addEventListener`), pas un EventEmitter, et évite surtout qu'une réponse
 * slowly arriving d'un device ne soit consommée par l another's pending map. */
function makeEval(ws, label) {
  let seq = 0;
  return function evaluate(expression, awaitPromise) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout CDP " + label)), 30000);
      const onMsg = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.id !== id) return;
        clearTimeout(timer);
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

/* ---------- utilitaires de rapport ---------- */

const num = (a) => (a.length ? Math.min.apply(null, a) : null);
const max = (a) => (a.length ? Math.max.apply(null, a) : null);
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);

function checkJpeg(buf) {
  return {
    bytes: buf.length,
    soi: buf[0] === 0xff && buf[1] === 0xd8,
    eoi: buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9,
    /* Dimensions lues dans l'en-tête (segment SOF), comme le fait la Capture. */
    dims: readJpegDims(buf)
  };
}

function readJpegDims(b) {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xd9 || m === 0xda) return null;
    const len = (b[i + 2] << 8) | b[i + 3];
    const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (sof) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

const PHASE = 'MultiCamStartService.machine() ? MultiCamStartService.machine().state.phase : "?"';

/* Un « à froid » explicite : sans redémarrage, les compteurs/listeners
 * accumulent les runs précédents (constaté : 4 runs = 4 listeners, 30 frames
 * reçues mais 120 callbacks), et le rapport ne prouve plus rien.
 *
 * On REDÉMARRE L'APPLICATION, on ne recharge pas la page : un `location.reload()`
 * tue le contexte JS mais laisse le serveur WS natif en occupation, et la page
 * repart alors en `WS_FALLBACK_EXHAUSTED` (constaté : 45102→45111, plus aucun
 * serveur). Un vrai force-stop libère le port. */
function adb(args, opts) {
  /* `logcat -d` Easily dépasse le maxBuffer par défaut (1 Mo) : on l'élargit,
   * sinon la capture de journalisation échoue en silence (-1). */
  return require("child_process").execFileSync("adb", args,
    Object.assign({ stdio: "pipe", maxBuffer: 64 * 1024 * 1024 }, opts || {})).toString();
}

async function coldStart(serial, cdpPort, label, readyExpr) {
  const pkg = PKG;
  adb(["-s", serial, "shell", "am", "force-stop", pkg]);
  await sleep(1200);
  adb(["-s", serial, "shell", "am", "start", "-n", pkg + "/.MainActivity"]);
  /* Le socket devtools est indexé sur le PID : après un redémarrage, le
   * forwarding `tcp:<port> -> localabstract:webview_devtools_remote_<pid>`
   * pointe dans le vide. Il faut le REFAIRE sur le nouveau PID. */
  let pid = "";
  const tPid = Date.now();
  while (Date.now() - tPid < 30000) {
    /* `pidof` sort en erreur quand rien ne correspond : c'est l'état normal
     * pendant les premières centaines de ms après `am start`. */
    try { pid = adb(["-s", serial, "shell", "pidof", pkg]).trim().split(/\s+/)[0] || ""; }
    catch (e) { pid = ""; }
    if (pid) break;
    await sleep(600);
  }
  if (!pid) throw new Error("process " + pkg + " absent sur " + label);
  try { adb(["-s", serial, "forward", "--remove", "tcp:" + cdpPort]); } catch (e) {}
  adb(["-s", serial, "forward", "tcp:" + cdpPort, "localabstract:webview_devtools_remote_" + pid]);
  /* Le devtools target est recréé : il faut le reacquérir. */
  let url = null;
  const tWs = Date.now();
  while (Date.now() - tWs < 40000) {
    await sleep(700);
    try { url = await target(cdpPort); if (url) break; } catch (e) { url = null; }
  }
  if (!url) throw new Error("devtools indisponible sur " + label + " (pid " + pid + ")");
  const ws = await connect(url);
  const ev = makeEval(ws, label);
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < 40000) {
    await sleep(500);
    try {
      const v = await ev(readyExpr, false);
      if (v === "PRET") return { ws, ev, pid };
      last = String(v);
    } catch (e) { last = e.message.slice(0, 60); }
  }
  ws.close();
  throw new Error("application non prete sur " + label + " (" + last + ")");
}

/* Les deux téléphones ont des horloges INDEPENDANTES : `capturedAt` (Capture)
 * et `receivedAt` (Master) ne sont pas dans la même base. Sans correction, la
 * latence inter-appareils sort négative (constaté : -50 ms), ce qui est un
 * artefact et non une mesure. On mesure donc le décalage — comme J07 le fait
 * pour le Top de Depart — en entrelançant les lectures CDP. */
async function measureClockOffset(cap, mas) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const c0 = Date.now();
    const cVal = Number(await cap("Date.now()", false));
    const mVal = Number(await mas("Date.now()", false));
    const c1 = Date.now();
    samples.push({ masterMinusCaptureMs: mVal - cVal, roundTripMs: c1 - c0 });
    await sleep(150);
  }
  const vals = samples.map((s) => s.masterMinusCaptureMs).sort((a, b) => a - b);
  return {
    masterMinusCaptureMs: vals[Math.floor(vals.length / 2)],
    samples,
    maxRoundTripMs: Math.max.apply(null, samples.map((s) => s.roundTripMs))
  };
}

function checkMp4(buf) {
  /* Boîte `ftyp` : signature d'un fichier MP4 réel, pas d'un fichier vide. */
  const brand = buf.slice(4, 12).toString("latin1");
  return {
    bytes: buf.length,
    ftyp: brand.slice(0, 4),
    ftypOk: brand.slice(0, 4) === "ftyp",
    brand
  };
}

/* Journalisation PARSABLE (AGENTS.md) : on ne garde que les lignes de
 * console des briques concernées, dans l'ordre, sans le bruit NSD. C'est
 * l'évidence qui accompagne le rapport.json. */
const KEEP = "PREVIEW_|START_|REC|CAMERA_|WS_|PEER_|JOIN_|SESSION_CLOSE|ARM_|CLOCK_";

function grabConsole(serial, label) {
  try {
    const raw = adb(["-s", serial, "logcat", "-d", "-v", "time"]).split("\n");
    const kept = raw.filter((l) => l.indexOf("chromium") >= 0 && new RegExp(KEEP).test(l))
      .map((l) => l.replace(/^.*CONSOLE:[0-9]+\] "/, "").replace(/", source:.*$/, ""));
    const dest = path.join(OUT, label + "-console.txt");
    fs.writeFileSync(dest, kept.join("\n") + "\n");
    return kept.length;
  } catch (e) {
    return -1;
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  /* Journalisations neuves : le run doit être seul dans l'évidence. */
  for (const serial of [CAP_SERIAL, MASTER_SERIAL]) {
    try { adb(["-s", serial, "logcat", "-c"]); } catch (e) {}
  }

  /* ---------- 0. DÉMARRAGE À FROID des deux applications ---------- */

  /* « Pret » = config CHARGÉE (elle est asynchrone : `get()` rend null avant
   * `load()`) + serveur WS réellement démarré + briques J09-04 présentes. */
  const READY_CAP = "(MultiCamConfig.get()&&MultiCamSessionWs.status().serverRunning"
    + "&&typeof MultiCamPreviewTransport!=='undefined'"
    + "&&typeof MultiCamPreviewSampler!=='undefined')?'PRET':''";
  const READY_MAS = "(MultiCamConfig.get()&&MultiCamSessionWs.status().serverRunning"
    + "&&typeof MultiCamPreviewInbox!=='undefined'"
    + "&&typeof MultiCamPreviewTransport!=='undefined')?'PRET':''";
  const capC = await coldStart(CAP_SERIAL, CAP_PORT, "capture", READY_CAP);
  const masC = await coldStart(MASTER_SERIAL, MASTER_PORT, "master", READY_MAS);
  const capWs = capC.ws;
  const masWs = masC.ws;
  const cap = capC.ev;
  const mas = masC.ev;
  const j = (s) => "window.MultiCam" + s;
  console.log("COLD_START applications redemmarees (force-stop + am start),"
    + " compteurs et listeners a zero");

  /* ---------- 1. garde-fous des deux côtés ---------- */

  const pre = JSON.parse(await cap('(function(){return JSON.stringify({'
    + 'deviceId: MultiCamConfig.get().deviceId,'
    + 'intervalMs: MultiCamPreviewSampler.INTERVAL_MS,'
    + 'quality: MultiCamPreviewSampler.QUALITY,'
    + 'prepared: MultiCamCameraRecord.view().prepared,'
    + 'transport: !!MultiCamPreviewTransport,'
    + 'inbox: !!MultiCamPreviewInbox,'
    + 'ws: MultiCamSessionWs.status()})})()', false));
  console.log("PRE capture", json(pre));
  if (pre.intervalMs !== 1000) throw new Error("interval inattendu: " + pre.intervalMs);
  if (pre.quality !== 60) throw new Error("qualite inattendue: " + pre.quality);
  if (!pre.prepared) {
    /* Après un redémarrage la caméra est fermée : c'est NORMAL. On exige
     * seulement que la brique de préparation existe et soit capable de
     * s'exécuter — le REC la déclenchera. */
    console.log("INFO capture non pretee apres redemarrage (attendu) :"
      + " la preparation natif sera faite par le REC");
  }
  if (!pre.transport || !pre.inbox) throw new Error("briques J09-04 absentes de l'app");

  const masPre = JSON.parse(await mas('(function(){return JSON.stringify({'
    + 'deviceId: MultiCamConfig.get().deviceId,'
    + 'transport: !!MultiCamPreviewTransport,'
    + 'inbox: !!MultiCamPreviewInbox,'
    + 'ws: MultiCamSessionWs.status()})})()', false));
  console.log("PRE master", json(masPre));
  if (!masPre.transport || !masPre.inbox) throw new Error("briques J09-04 absentes du master");

  const capDid = pre.deviceId;
  const masDid = masPre.deviceId;
  const capIp = pre.ws.selfEndpoint ? pre.ws.selfEndpoint.split(":")[0] : null;
  const capWsPort = pre.ws.effectivePort;
  const masEndpoint = masPre.ws.selfEndpoint;      /* "ip:port" du Master */
  console.log("LINK capture=" + capDid + " @" + capIp + ":" + capWsPort
    + " master=" + masDid + " @" + masEndpoint);

  /* ---------- 2. session de travail ---------- */

  const clock = await measureClockOffset(cap, mas);
  console.log("HORLOGE master-capture=" + clock.masterMinusCaptureMs + " ms"
    + " (aller-retour CDP max " + clock.maxRoundTripMs + " ms)");
  if (Math.abs(clock.masterMinusCaptureMs) > 5000) {
    console.log("AVERTISSON decalage d'horloge important : la latence inter-appareils"
      + " sera rapportee CORRIGEE, et le bruit de mesure vaut ~"
      + clock.maxRoundTripMs + " ms");
  }

  const skills = await cap('MultiCamConfig.setSkill("controller", false)'

    + '.then(function(c){return JSON.stringify({did:c.deviceId,skills:c.enabledSkills})},'
    + 'function(){return "setSkill_indisponible"})', true);
  console.log("SKILLS capture", skills);

  let sid = SID;
  let masSess = null;
  if (!SID || argv.indexOf("--create-session") >= 0) {
    const created = await mas('MultiCamSessionWs.createSession(' + json(arg("name", "J09-04 smoke"))
      + ').then(function(s){return JSON.stringify({sessionId:s.sessionId,pin:s.pin,name:s.name,'
      + 'state:s.state,masters:(s.masters||[]).map(function(m){return m.deviceId})})})', true);
    const c = JSON.parse(created);
    sid = c.sessionId;
    masSess = c;
    console.log("SESSION creee par le MASTER", json(Object.assign({}, c, { pin: c.pin ? "***" : c.pin })));
  }
  if (!masSess) {
    masSess = JSON.parse(await mas('MultiCamSessionStore.get(' + json(sid) + ').then(function(s){'
      + 'return JSON.stringify(s ? {sessionId:s.sessionId, state:s.state, name:s.name, pin:s.pin,'
      + 'masters:(s.masters||[]).map(function(m){return m.deviceId})} : null)})', true));
    console.log("SESSION master", json(Object.assign({}, masSess, { pin: masSess.pin ? "***" : masSess.pin })));
    if (!masSess) throw new Error("session absente du MASTER : " + sid);
  }
  if (!masSess.pin) throw new Error("session sans PIN : le join reel est impossible");

  const capSess = JSON.parse(await cap('MultiCamSessionStore.get(' + json(sid) + ').then(function(s){'
    + 'return JSON.stringify(s ? {sessionId:s.sessionId, state:s.state,'
    + 'masters:(s.masters||[]).map(function(m){return m.deviceId})} : null)})', true));
  console.log("SESSION capture", json(capSess));

  /* ---------- 3. adhésion RÉELLE au réseau (chemin de production) ----------
   *
   * `joinSession()` est le chemin nominal d'une Capture qui rejoint une session :
   * `join_req` vers le serveur du Master, PIN à l'appui, puis `join_ok` avec
   * l'état faisant autorité (rôles, masters, PIN). C'est lui qui crée la PRÉSENCE
   * dans la session des deux côtés — c'est-à-dire la condition pour que le
   * transport ait un destinataire.
   *
   * On n'improvise pas de présence avec un `connectTo()` suivi d'un
   * `reSyncSession()` : sur un Master, `reSyncSession()` n'écrit qu'AUX AUTRES
   * masters de la session (`m.deviceId === state.localDid` est ignoré), donc
   * depuis une Regie il ne part littéralement rien. Le smoke l'a constaté.
   */
  const joinRes = await cap(j("SessionWs") + '.joinSession({host:' + json(masEndpoint.split(":")[0])
    + ',port:' + parseInt(masEndpoint.split(":")[1], 10)
    + ',sessionId:' + json(sid) + ',name:' + json(masSess.name) + '},'
    + json(masSess.pin) + ').then(function(){return "JOIN_ENVOYE"},function(e){return "JOIN_KO "+e})', true);
  console.log("JOIN capture", joinRes);
  if (!/^JOIN_ENVOYE/.test(String(joinRes))) throw new Error("adhésion refusée: " + joinRes);

  let joined = null;
  const tJoin = Date.now();
  while (Date.now() - tJoin < 20000) {
    await sleep(700);
    joined = JSON.parse(await cap('MultiCamSessionStore.get(' + json(sid) + ').then(function(s){'
      + 'return JSON.stringify({state:s.state,'
      + 'masters:(s.masters||[]).map(function(m){return m.deviceId}),'
      + 'members:(s.members||[]).map(function(m){return m.deviceId})})})', true));
    if (joined.masters.indexOf(masDid) >= 0) break;
  }
  console.log("JOINED capture", json(joined));
  if (joined.masters.indexOf(masDid) < 0) {
    throw new Error("la CAPTURE n'a pas reçu les rôles du Master : elle ne peut rien router");
  }

  await sleep(1500);
  const presence = {
    capture: JSON.parse(await cap('JSON.stringify(MultiCamSessionWs.connectedPeers(' + json(sid) + '))', false)),
    master: JSON.parse(await mas('JSON.stringify(MultiCamSessionWs.connectedPeers(' + json(sid) + '))', false))
  };
  console.log("PRESENCE", json(presence));
  if (!presence.capture[masDid]) throw new Error("présence absente côté CAPTURE : aucun destinataire possible");

  /* ---------- 4. pont de réception côté Master ---------- */

  /* Après un DÉMARRAGE À FROID il n'y a plus rien à réinitialiser : les
   * compteurs partent de zéro et il n'y a qu'un seul listener. */
  await mas('window.__j0904seen = 0, MultiCamPreviewInbox.onFrame(function(){window.__j0904seen++;}),'
    + '"PONT MASTER OK"', false);
  await cap('"TRANSPORT CAPTURE OK"', false);

  /* ---------- 5. démarrage du REC (pont de production) ---------- */

  const seenTakes = JSON.parse(await cap('(function(){var st=MultiCamStartService.machine().state||{};'
    + 'var all={};Object.keys(st.localStartedTakes||{}).forEach(function(k){all[k]=1;});'
    + 'Object.keys(st.localStoppedTakes||{}).forEach(function(k){all[k]=1;});'
    + 'return JSON.stringify(Object.keys(all).map(Number))})()', true));
  const TAKE = TAKE_ARG > 0 ? TAKE_ARG : (seenTakes.length ? Math.max.apply(null, seenTakes) + 1 : 1);
  console.log("TAKE " + TAKE + " (takes deja vus sur cette capture: " + JSON.stringify(seenTakes) + ")");

  await cap('MultiCamNav.show("arm",{sid:' + json(sid) + '})', false);
  await sleep(2500);
  const armed = await cap('(function(){var self=MultiCamConfig.get().deviceId;'
    + 'var off={}; off[self]=0;'
    + 'var plan={startPlanId:' + json("J0904#" + TAKE + "#1#1") + ',sessionId:' + json(sid) + ',takeNumber:' + TAKE + ','
    + 'targetStartMs:Date.now()+' + TOP_DELAY_MS + ',countdownSeconds:0,'
    + 'clockOffsets:off,participants:[{deviceId:self,role:"capture"}],'
    + 'createdByDeviceId:"injected-leader",profile:"FHD",createdAtMs:Date.now()};'
    + 'MultiCamStartService.machine().onIncoming({kind:"start_plan",sessionId:' + json(sid) + ','
    + 'from:"injected-leader",plan:plan}); return "PLAN " + plan.startPlanId;})()', false);
  console.log("ARM", armed);

  const t0 = Date.now();
  let phase = "";
  while (Date.now() - t0 < 45000) {
    await sleep(400);
    phase = await cap(PHASE, false);
    if (phase === "REC") break;
  }
  const recAt = Date.now();
  console.log("REC capture", phase, "apres", recAt - t0, "ms");
  if (phase !== "REC") throw new Error("la capture n'est pas en REC (phase=" + phase + ")");

  /* ---------- 5. fenêtre REC : on prélève l'INBOX du MASTER ---------- */

  const shots = [];
  let i = 0;
  while (i < SNAP_AT.length && Date.now() - recAt < REC_MS) {
    const wait = (recAt + SNAP_AT[i]) - Date.now();
    if (wait > 0) await sleep(wait);
    if (Date.now() - recAt > REC_MS) break;
    /* Côté MASTER uniquement : ce qu'on veut prouver, c'est l'arrivée. */
    const probe = JSON.parse(await mas('(function(){var f=MultiCamPreviewInbox.latest('
      + json(sid) + ',"' + capDid + '");'
      + 'return JSON.stringify(f ? {seq:f.seq, bytes:f.bytes, width:f.width, height:f.height,'
      + 'capturedAt:f.capturedAt, receivedAt:f.receivedAt, takeNumber:f.takeNumber,'
      + 'startPlanId:f.startPlanId, mime:f.mime, deviceId:f.deviceId, jpegBase64:f.jpegBase64} : null)})()',
    false) || "null");
    const file = "master-frame-" + (i + 1) + "-seq" + (probe ? probe.seq : "none") + ".jpg";
    if (probe && probe.jpegBase64) {
      const buf = Buffer.from(probe.jpegBase64, "base64");
      fs.writeFileSync(path.join(OUT, file), buf);
      delete probe.jpegBase64;
      /* Latence inter-appareils CORRIGÉE du décalage d'horloge mesuré. */
      const rawMs = probe.receivedAt - probe.capturedAt;
      const correctedMs = rawMs - clock.masterMinusCaptureMs;
      shots.push(Object.assign({ atMs: Date.now() - recAt, file }, probe, {
        fileBytes: buf.length,
        rawSendToRxMs: rawMs,
        correctedSendToRxMs: correctedMs,
        clockOffsetAppliedMs: clock.masterMinusCaptureMs
      }));
      console.log("FRAME MASTER", json(shots[shots.length - 1]));
    } else {
      shots.push({ atMs: Date.now() - recAt, file: null, received: false });
      console.log("FRAME MASTER vide a t+" + (Date.now() - recAt) + "ms");
    }
    i++;
  }

  const mid = JSON.parse(await cap('(function(){return JSON.stringify({'
    + 'sampler: MultiCamPreviewSampler.view(),'
    + 'transport: MultiCamPreviewTransport.view(),'
    + 'camera: MultiCamCameraRecord.view()})})()', false));
  console.log("MIREC transport sent=" + mid.transport.stats.sent
    + " dropped=" + mid.transport.stats.dropped
    + " recipients=" + mid.transport.stats.recipients);

  const remain = (recAt + REC_MS) - Date.now();
  if (remain > 0) await sleep(remain);

  /* ---------- 6. arrêt ---------- */

  await cap('MultiCamStartService.machine().stopLocal("smoke")', false);
  const tStop = Date.now();
  let capPhase = "";
  while (Date.now() - tStop < 30000) {
    await sleep(500);
    capPhase = await cap(PHASE, false);
    if (capPhase === "STOPPED") break;
  }
  await sleep(4000);
  console.log("STOP capture phase=" + capPhase + " en " + (Date.now() - tStop) + " ms");

  /* ---------- 7. état final des deux côtés ---------- */

  const capFinal = JSON.parse(await cap('(function(){return JSON.stringify({'
    + 'transport: MultiCamPreviewTransport.view(),'
    + 'sampler: MultiCamPreviewSampler.view(),'
    + 'machine: MultiCamStartService.machine() ? MultiCamStartService.machine().state.phase : "?",'
    + 'camera: MultiCamCameraRecord.view(),'
    + 'videoPath: MultiCamStartService.machine() ? MultiCamStartService.machine().state.lastVideoPath : null,'
    + 'take: MultiCamStartService.machine() ? MultiCamStartService.machine().state.lastStart : null})})()', false));

  const masFinal = JSON.parse(await mas('(function(){return JSON.stringify({'
    + 'inbox: MultiCamPreviewInbox.view(),'
    + 'seen: window.__j0904seen})})()', false));
  console.log("FINAL master", json(masFinal));

  /* ---------- 8. rapport ---------- */

  const ts = capFinal.transport.stats;
  const rx = masFinal.inbox.stats;
  const jpegChecks = shots.filter((s) => s.file).map((s) => {
    const b = fs.readFileSync(path.join(OUT, s.file));
    const c = checkJpeg(b);
    c.file = s.file;
    c.seq = s.seq;
    c.sha256 = require("crypto").createHash("sha256").update(b).digest("hex").slice(0, 16);
    return c;
  });

  /* La preuve que le Take est RÉELLEMENT enregistré pendant que les previews
   * circulent : on récupère le MP4 de la Capture et on vérifie sa boîte `ftyp`.
   * Un chemin déclaré par le modèle ne prouverait rien. */
  let video = { path: capFinal.camera.videoPath || null, pulled: null, error: null };
  if (capFinal.camera.videoPath) {
    const dest = path.join(OUT, "capture-take.mp4");
    /* Le MP4 est dans le CACHE PRIVÉ de l'app (`/data/user/0/...`, mode 0700) :
     * `adb pull` y échoue (constaté). Sur un build debug, `run-as` y accède —
     * la preuve porte sur le Take réellement écrit, pas sur un chemin déclaré
     * par le modèle. Le DÉPLACEMENT vers le stockage public n'est pas du ressort
     * de J09-04 (c'est le Jalon SAF). */
    try {
      require("child_process").execFileSync("sh", ["-c",
        "adb -s " + CAP_SERIAL + " exec-out run-as " + PKG
        + " cat '" + capFinal.camera.videoPath + "' > '" + dest + "'"], { stdio: "pipe" });
      const buf = fs.readFileSync(dest);
      if (!buf.length) throw new Error("fichier vide (run-as n'a rien renvoyé)");
      video.pulled = checkMp4(buf);
      video.pulled.file = "capture-take.mp4";
      video.pulled.sha256 = require("crypto").createHash("sha256").update(buf).digest("hex").slice(0, 16);
    } catch (e) {
      video.error = String(e.message || e).slice(0, 200);
    }
  }
  console.log("VIDEO", json(video));

  /* ---------- HYGIÈNE : on ne laisse pas la session ouverte sur le LAN ---------- */

  const cleanup = await mas('MultiCamSessionStore.get(' + json(sid) + ')'
    + '.then(function(s){if(!s)return "deja_absente";'
    + 'return MultiCamSessionWs.closeSession(s).then(function(){return "session_fermee"},'
    + 'function(e){return "close_ko " + e})})', true);
  console.log("CLEANUP", cleanup);

  const linesCap = grabConsole(CAP_SERIAL, "capture");
  const linesMas = grabConsole(MASTER_SERIAL, "master");
  console.log("LOGS capture=" + linesCap + " lignes, master=" + linesMas + " lignes");

  const latencies = shots.filter((s) => typeof s.correctedSendToRxMs === "number")
    .map((s) => s.correctedSendToRxMs);

  const report = {
    sessionId: sid,
    capture: { deviceId: capDid, ip: capIp, wsPort: capWsPort },
    master: { deviceId: masDid },
    intervalMs: pre.intervalMs,
    quality: pre.quality,
    recRequestedMs: REC_MS,
    recMeasuredMs: Date.now() - recAt,
    /* ÉMISSION (capture) */
    submitted: ts.submitted, sent: ts.sent, dropped: ts.dropped, droppedBy: ts.droppedBy,
    recipients: ts.recipients,
    nonMastersSkipped: ts.nonMastersSkipped,
    otherSessionSkipped: ts.otherSessionSkipped,
    selfSkipped: ts.selfSkipped,
    notOpenSkipped: ts.notOpenSkipped,
    pendingDepthAtEnd: ts.pendingDepth,
    jpegBytes: ts.jpegBytes, jsonBytes: ts.jsonBytes, sendMs: ts.sendMs,
    lastDropReason: ts.lastDropReason,
    /* RÉCEPTION (master) */
    rxReceived: rx.received, rxDropped: rx.dropped, rxDroppedBy: rx.droppedBy,
    rxStored: rx.stored, rxDevices: masFinal.inbox.sessions,
    rxLastSeq: rx.lastSeq,
    callbacksOnFrame: masFinal.seen,
    /* HORLOGES : la latence inter-appareils n'a de sens qu'une fois le
     * décalage d'horloge des deux téléphones retiré. */
    clock: {
      masterMinusCaptureMs: clock.masterMinusCaptureMs,
      maxRoundTripMs: clock.maxRoundTripMs,
      samples: clock.samples,
      note: "capturedAt est horodaté par la Capture, receivedAt par le Master : "
        + "les deux baseurs sont independantes, la latence brute est donc un artefact."
    },
    latency: {
      correctedSendToRxMs: { min: num(latencies), max: max(latencies), avg: avg(latencies) },
      intraDeviceSendMs: ts.sendMs,
      note: "envoi WS mesure sur la Capture (avg/max) ; le reste du trajet "
        + "inter-appareils n'est pas isolable ici, les deux bouts ne partageant pas d'horloge."
    },
    /* COHÉRENCE */
    coherence: {
      sentByCapture: ts.sent, receivedByMaster: rx.received,
      lostInFlight: ts.sent - rx.received,
      masterCallbackCount: masFinal.seen, inboxStored: rx.stored
    },
    sampler: {
      ok: capFinal.sampler.stats.ok, requested: capFinal.sampler.stats.requested,
      error: capFinal.sampler.stats.error, noCallback: capFinal.sampler.stats.noCallback,
      runningAfterStop: capFinal.sampler.running,
      inFlightAfterStop: capFinal.sampler.inFlight,
      timerPendingAfterStop: capFinal.sampler.timerPending
    },
    framesOnMaster: shots,
    jpegChecks,
    finalPhase: capFinal.machine,
    cameraPreparedAfterStop: capFinal.camera.prepared,
    cameraRecordingAfterStop: capFinal.camera.recording,
    video,
    videoPath: capFinal.camera.videoPath,
    sessionClosedAtEnd: String(cleanup),
    recAck: capFinal.take,
    planOrigin: "start-service.machine().onIncoming (pont WS de production)",
    transportPath: "session-ws sendPreviewFrame -> WS LAN -> session-ws (serveur) -> preview-inbox"
  };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log("REPORT", json(report));

  capWs.close(); masWs.close();
  process.exit(0);
}

main().catch((e) => { console.error("ECHEC SMOKE:", e.message); process.exit(1); });
