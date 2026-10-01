/* MultiCam — J09-06 : smoke PHYSIQUE de la SUPERVISION des Captures.
 *
 * Ce que ce script doit prouver, et RIEN d'autre :
 *
 *   CAPTURE (61d54bba7d91)                        MASTER (c0d8514d7d87)
 *   ──────────────────────                        ──────────────────────
 *   telemetry-service (J09-06) : MESURE réelle
 *     batterie + charge (plugin battery-status)
 *     stockage libre + total (StatFs)
 *     type de réseau (ConnectivityManager)
 *     état REC (camera-record)
 *        │  cadence 5 s + immédiat au changement
 *        ▼
 *   session-ws.updateMemberTelemetry()  ── WS réel, LAN ──▶  session-ws
 *                                                       │ telemetry_update
 *                                                       ▼
 *                                            telemetry-store (J09-06)
 *                                                       │ syncTelemetry
 *                                                       ▼
 *                                            live-model (J09-05) → live.js
 *                                            + live-detail (J09-06)
 *
 * DIFFÉRENCE AVEC LE SMOKE J09-05 : celui-là prouvait l'IMAGE (qu'une vignette
 * par Capture, dans l'ordre du plan, placeholder puis image). Ici on prouve la
 * MESURE : des valeurs qui viennent du téléphone, un nombre de messages et une
 * cadence qui tiennent la route sur un vrai réseau, une taille de message, et
 * surtout trois不会再 faits : une donnée ABSENTE reste absente (jamais 0 %), une
 * Capture déconnectée garde ses dernières valeurs (sans redevenir « vivante »),
 * et la vue détaillée ne contient AUCUNE commande (J10).
 *
 * Le plan de START est produit par le VRAI chemin de production (boutons des
 * panneaux), et la Capture ouvre l'écran 05 « Préparer Take » comme le fait un
 * opérateur : c'est là que le service de collecte démarre.
 *
 * AUCUNE vidéo n'est récupérée : les preuves sont des captures d'écran, des
 * dumps JSON et les logs. (Règle J09 : plus de MP4 dans le dépôt.)
 */

"use strict";

const fs = require("fs");
const path = require("path");

const PKG = "fr.emmanuel.multicam";
const CAP_SERIAL = process.env.CAP_SERIAL || "61d54bba7d91";
const MASTER_SERIAL = process.env.MASTER_SERIAL || "c0d8514d7d87";
const CAP_PORT = process.env.CDP_PORT || "9223";
const MASTER_PORT = process.env.MASTER_CDP_PORT || "9224";
/* Durée d'observation de la cadence : 4 périodes de 5 s suffisent à voir le
 * rythme sans allonger le smoke (et sans échauffer l'appareil). */
const CADENCE_MS = Number(process.env.CADENCE_MS || 26000);
const HERE = __dirname;
const OUT = path.join(HERE, "logs", "70-telemetry");
const SHOTS = path.join(HERE, "screenshots");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (o) => JSON.stringify(o);

function adb(args, opts) {
  return require("child_process").execFileSync("adb", args, Object.assign({
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024
  }, opts || {}));
}
function adbTry(args) {
  try { return adb(args); } catch (e) { return (e.stdout || "") + (e.stderr || "") + ""; }
}

/* Démarrage À FROID : indispensable, `location.reload()` laisse le serveur
 * WebSocket NATIF garder le port 45102 et les devices ne se revoient plus
 * (constaté en J09-02). Un vrai force-stop libère le port. */
function coldStart(serial, cdpPort, label) {
  adb(["-s", serial, "shell", "am", "force-stop", PKG]);
  adb(["-s", serial, "shell", "am", "start", "-n", PKG + "/.MainActivity"]);
  let pid = "";
  for (let i = 0; i < 40; i++) {
    sleep(400);
    pid = adbTry(["-s", serial, "shell", "pidof", PKG]).trim().split(/\s+/)[0] || "";
    if (pid) break;
  }
  if (!pid) throw new Error("pid introuvable sur " + label);
  try { adb(["-s", serial, "forward", "--remove", "tcp:" + cdpPort]); } catch (e) {}
  adb(["-s", serial, "forward", "tcp:" + cdpPort, "localabstract:webview_devtools_remote_" + pid]);
  console.log("COLD_START " + label + " serial=" + serial + " pid=" + pid + " cdp=" + cdpPort);
  return { pid, serial, cdpPort };
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", () => rej(new Error("CDP socket")));
  });
  return ws;
}

async function makeEval(ws, label) {
  let id = 0;
  const pend = new Map();
  ws.addEventListener("message", (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id);
      pend.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error)));
      else res(m.result);
    }
  });
  return function ev(expr, awaitPromise) {
    const mid = ++id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { pend.delete(mid); rej(new Error("timeout CDP " + label)); }, 20000);
      pend.set(mid, {
        res: (r) => { clearTimeout(t); res(r); },
        rej: (e) => { clearTimeout(t); rej(e); }
      });
      ws.send(JSON.stringify({
        id: mid,
        method: "Runtime.evaluate",
        params: { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true }
      }));
    }).then((r) => {
      if (r.exceptionDetails) {
        throw new Error("EXCEPTION " + label + " "
          + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails).slice(0, 300));
      }
      const v = r.result && r.result.value;
      return v === undefined ? null : v;
    });
  };
}

/* On réessaie la CONNEXION CDP elle-même : au moment du `am start` la cible
 * WebView peut mettre plusieurs centaines de ms à s'annoncer. */
async function attach(dev, label, readyExpr) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < 60000) {
    try {
      const res = await fetch("http://localhost:" + dev.cdpPort + "/json");
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && /index\.html/.test(t.url))
        || list.find((t) => t.type === "page");
      if (page && page.webSocketDebuggerUrl) {
        const ws = await connect(page.webSocketDebuggerUrl);
        const ev = await makeEval(ws, label);
        const v = await ev(readyExpr, false);
        if (v === "PRET") return { ws, ev };
        last = "eval=" + String(v).slice(0, 60);
        ws.close();
      } else {
        last = "aucune cible page";
      }
    } catch (e) { last = e.message.slice(0, 70); }
    await sleep(600);
  }
  throw new Error("application non prete sur " + label + " (" + last + ")");
}

function shot(serial, name) {
  const dest = path.join(SHOTS, name);
  const buf = require("child_process").execFileSync("adb",
    ["-s", serial, "exec-out", "screencap", "-p"], { maxBuffer: 32 * 1024 * 1024 });
  fs.writeFileSync(dest, buf);
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  console.log("SHOT " + name + " " + width + "x" + height + " " + buf.length + " octets");
  return { file: path.relative(HERE, dest), bytes: buf.length, width, height };
}

/* Journalisation PARSABLE (AGENTS.md) : lignes des briques J09, sans le bruit. */
const KEEP = "TELEMETRY_|LIVE_|SCREEN05_|SCREEN08_|NAV_AUTO|START_|PREVIEW_|REC_|CAMERA_|WS_|SESSION_CLOSE|ARM_|CLOCK_|TAKE_";

function grabConsole(serial, label) {
  const raw = adbTry(["-s", serial, "logcat", "-d", "-v", "time"]).split("\n");
  const kept = raw.filter((l) => l.indexOf("chromium") >= 0 && new RegExp(KEEP).test(l))
    .map((l) => l.replace(/^.*CONSOLE:[0-9]+\] "/, "").replace(/", source:.*$/, ""));
  fs.writeFileSync(path.join(OUT, label + "-console.txt"), kept.join("\n") + "\n");
  return kept;
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log("OK   " + msg);
}

/* ---------- sondes ---------- */

/* Côté MASTER : ce que l'OPÉRATEUR VOIT. On relit le DOM de la mosaïque, pas
 * seulement le modèle : un modèle correct mais mal branché doit être détecté. */
const DOM_PROBE = '(function(){'
  + 'var grid=document.getElementById("liveGrid");'
  + 'var tiles=[].slice.call(grid?grid.children:[]).map(function(t){'
  + 'var st=t.querySelector(".tile-state");'
  + 'var alert=t.querySelector(".tile-alert");'
  + 'return {'
  + 'name:(t.querySelector(".tile-name")||{}).textContent||"",'
  + 'state:st?st.getAttribute("data-state"):"",'
  + 'stateLabel:st?st.textContent.trim():"",'
  + 'hasImg:!!t.querySelector("img"),'
  + 'hasSrc:!!(t.querySelector("img")&&t.querySelector("img").getAttribute("src")),'
  + 'offline:t.classList.contains("offline"),'
  + 'local:t.classList.contains("local"),'
  + 'deviceId:t.getAttribute("data-device-id")||"",'
  + 'alertIcon:alert?alert.className:"",'
  + 'supervision:[].slice.call(t.querySelectorAll(".supervision")).map(function(s){'
  + 'return {txt:s.textContent.trim(),known:s.getAttribute("data-known"),'
  + 'cls:s.querySelector("i")?s.querySelector("i").className:""};})'
  + '};});'
  + 'return JSON.stringify({screen:document.querySelector(".screen.active")'
  + '?document.querySelector(".screen.active").id:"",tiles:tiles});})()';

const MODEL_PROBE = '(function(){var m=MultiCamLiveModel.view();'
  + 'return JSON.stringify({sessionId:m.sessionId,takeNumber:m.takeNumber,stats:m.stats,'
  + 'slots:m.slots.map(function(s){return {deviceId:s.deviceId,deviceName:s.deviceName,'
  + 'isLocal:s.isLocal,status:s.status,connected:s.connected,displayState:s.displayState,'
  + 'hasFrame:s.hasFrame,lastFrameSeq:s.lastFrameSeq,'
  + 'telemetry:s.telemetry,telemetryAt:s.telemetryAt};})});})()';

/* La mémoire de supervision, LUE comme une entité : c'est elle que la mosaïque
 * consomme, pas le modèle. */
function storeProbe(sidExpr) {
  return '(function(){var all=MultiCamTelemetryStore.all(' + sidExpr + ');var out={};'
    + 'Object.keys(all).forEach(function(k){var e=all[k];'
    + 'out[k]={telemetry:e.telemetry,atMs:e.atMs,local:e.local};});'
    + 'return JSON.stringify({entries:out,stats:MultiCamTelemetryStore.stats()});})()';
}

/* La Capture, elle, publie. On lit l'état du service et on MESURE la taille
 * réelle des messages en enveloppant le `send()` du plugin natif le temps du
 * smoke : c'est la seule mesure honnête de « combien d'octets sur le réseau ». */
const CAP_VIEW = '(function(){var v=MultiCamTelemetryService.view();return JSON.stringify({'
  + 'bound:v.bound,running:v.running,sessionId:v.sessionId,cadenceMs:v.cadenceMs,'
  + 'measureTtlMs:v.measureTtlMs,inFlight:v.inFlight,pending:v.pending,'
  + 'lastPublishAtMs:v.lastPublishAtMs,errors:v.errors,stats:v.stats,'
  + 'battery:v.battery,space:v.space,net:v.net,recording:v.recording});})()';

const TAP_SEND = '(function(){var p=window.cordova&&window.cordova.plugins'
  + '&&window.cordova.plugins.wsserver;if(!p||typeof p.send!=="function")'
  + 'return JSON.stringify({ok:false,err:"pas de wsserver"});'
  + 'if(p.__telem)return JSON.stringify({ok:true,deja:true,msgs:window.__telemMsgs||[]});'
  + 'var orig=p.send;p.send=function(entry,payload){try{var o=JSON.parse(payload);'
  + 'if(o&&o.kind==="telemetry_update"){(window.__telemMsgs=window.__telemMsgs||[]).push('
  + '{t:Date.now(),bytes:payload.length,telemetry:o.telemetry});}}catch(e){}'
  + 'return orig.apply(p,arguments);};'
  + 'p.__telem=orig;window.__telemMsgs=[];'
  + 'return JSON.stringify({ok:true,deja:false});})()';

const TAP_READ = 'JSON.stringify(window.__telemMsgs||[])';

/* La vue détaillée : ce que l'opérateur ouvre, et la preuve qu'il n'y a rien à
 * dessus d'autre qu'un bouton « fermer ». */
const DETAIL_PROBE = '(function(){var m=document.getElementById("liveDetailModal");'
  + 'var open=!!(m&&m.classList.contains("show"));'
  + 'var boutons=m?[].slice.call(m.querySelectorAll("button")).map(function(b){'
  + 'return b.id+":"+(b.textContent.trim()||b.getAttribute("aria-label"));}):[];'
  + 'var d=MultiCamLiveDetail.isOpen()?MultiCamLiveDetail.detailOf('
  + 'MultiCamLiveModel.view().slots.filter(function(s){return s.deviceId==='
  + 'MultiCamLiveDetail._state.deviceId;})[0],{nowMs:Date.now()}):null;'
  + 'return JSON.stringify({open:open,name:(document.getElementById("ldName")||{}).textContent,'
  + 'state:(document.getElementById("ldState")||{}).textContent,'
  + 'recorder:(document.getElementById("ldRecorder")||{}).textContent,'
  + 'battery:(document.getElementById("ldBattery")||{}).textContent,'
  + 'storage:(document.getElementById("ldStorage")||{}).textContent,'
  + 'network:(document.getElementById("ldNetwork")||{}).textContent,'
  + 'telemetryAge:(document.getElementById("ldTelemetryAge")||{}).textContent,'
  + 'previewAge:(document.getElementById("ldPreviewAge")||{}).textContent,'
  + 'incidents:(document.getElementById("ldIncidents")||{}).textContent,'
  + 'skills:[].slice.call(m?m.querySelectorAll(".modal-icon"):[]).map(function(s){'
  + 'return s.id+":"+s.className;}),'
  + 'hasImg:!!(document.getElementById("ldImage")&&document.getElementById("ldImage").getAttribute("src")),'
  + 'boutons:boutons,detail:d?{state:d.state,connected:d.connected,recorder:d.recorder,'
  + 'battery:d.battery,storage:d.storage,network:d.network,'
  + 'telemetryAgeMs:d.telemetryAgeMs,telemetryStale:d.telemetryStale,'
  + 'incidents:d.incidents,notes:d.notes,actions:d.actions}:null});})()';

/* ---------- pilotage opérateur (boutons de production) ---------- */

async function selectionnerToutesCaptures(dev, sid, label) {
  const r = await dev('(function(){var b=document.getElementById("tkCaptureAll");'
    + 'if(!b)return JSON.stringify({ok:false,err:"pas de tkCaptureAll"});'
    + 'if(b.disabled)return JSON.stringify({ok:false,err:"tkCaptureAll desactive"});'
    + 'b.click();return JSON.stringify({ok:true});})()', true);
  await sleep(800);
  const t = await dev('MultiCamSessionStore.get(' + json(sid) + ').then(function(s){'
    + 'var a=(s.takes||[]);var t=a.length?a[a.length-1]:null;'
    + 'return JSON.stringify({n:t?t.takeNumber:null,captures:(t&&t.captures)||[],'
    + 'membres:(s.members||[]).filter(function(x){return (x.sessionRoles||[]).indexOf("capture")>=0})'
    + '.map(function(x){return x.deviceId})});})', true);
  const clic = JSON.parse(r), v = JSON.parse(t);
  expect(clic.ok === true, "le bouton Toutes Captures est actif (" + label + ")");
  expect(Array.isArray(v.captures) && v.captures.length === v.membres.length,
    "TOUTES les Captures de la session sont selectionnees (" + label + ")");
  return v;
}

async function demarrerRec(dev, label) {
  await dev('(function(){var b=document.getElementById("armRec");'
    + 'if(b&&!b.disabled)b.click();return "REC_CLIQUE";})()', false);
  let last = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    await sleep(600);
    last = JSON.parse(await dev('(function(){var v=MultiCamArmService.view()||{};'
      + 'var m=document.getElementById("armIncidentModal");'
      + 'return JSON.stringify({incidentModal:!!(m&&m.classList.contains("show")),'
      + 'scr:document.querySelector(".screen.active").id});})()', false));
    if (last.incidentModal) {
      await dev('(function(){var b=document.getElementById("armIncidentContinue");'
        + 'if(b)b.click();return 1;})()', false);
      console.log("REC_INCIDENT " + label + " leve");
      return "via=incident_continue";
    }
    if (String(last.scr) !== "panel-arm" && String(last.scr) !== "panel-take") return "via=dock";
  }
  console.log("REC_ATTENTE " + label + " " + json(last));
  return "sans-demarrage";
}

/* ---------- mesures ---------- */

function statsOf(values) {
  if (!values.length) return null;
  const s = values.slice().sort(function (a, b) { return a - b; });
  const med = s[Math.floor(s.length / 2)];
  return {
    n: values.length,
    minMs: s[0],
    medianMs: med,
    maxMs: s[s.length - 1],
    moyenneMs: Math.round(values.reduce(function (a, b) { return a + b; }, 0) / values.length)
  };
}

const ev = {};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const serial of [CAP_SERIAL, MASTER_SERIAL]) {
    try { adb(["-s", serial, "logcat", "-c"]); } catch (e) {}
  }

  /* ---------- 0. démarrage à froid ---------- */
  const READY_CAP = "(MultiCamConfig.get()&&MultiCamSessionWs.status().serverRunning"
    + "&&typeof MultiCamTelemetryService!=='undefined')?'PRET':''";
  const READY_MAS = "(MultiCamConfig.get()&&MultiCamSessionWs.status().serverRunning"
    + "&&typeof MultiCamLiveDetail!=='undefined')?'PRET':''";
  const capC = await attach(coldStart(CAP_SERIAL, CAP_PORT, "capture"), "capture", READY_CAP);
  const masC = await attach(coldStart(MASTER_SERIAL, MASTER_PORT, "master"), "master", READY_MAS);
  const cap = capC.ev, mas = masC.ev;
  console.log("COLD_START applications pretes");

  /* ---------- 1. rôles ---------- */
  const M = JSON.parse(await mas('MultiCamConfig.setSkill("capture", false).then(function(c){'
    + 'return JSON.stringify({did:c.deviceId,name:c.deviceName,skills:c.enabledSkills})},'
    + 'function(){return JSON.stringify({error:"indisponible"})})', true));
  const C = JSON.parse(await cap('MultiCamConfig.setSkill("controller", false).then(function(c){'
    + 'return JSON.stringify({did:c.deviceId,name:c.deviceName,skills:c.enabledSkills})},'
    + 'function(){return JSON.stringify({error:"indisponible"})})', true));
  console.log("SKILLS master=" + json(M) + " capture=" + json(C));
  expect(!!M.did && !!C.did && M.did !== C.did, "les deux devices ont des identites distinctes");

  const masEndpoint = JSON.parse(await mas("JSON.stringify(MultiCamSessionWs.status())", false)).selfEndpoint;
  const capEndpoint = JSON.parse(await cap("JSON.stringify(MultiCamSessionWs.status())", false)).selfEndpoint;
  console.log("LINK master=" + M.did + " @" + masEndpoint + " capture=" + C.did + " @" + capEndpoint);

  /* ---------- 2. session ---------- */
  const created = JSON.parse(await mas('MultiCamSessionWs.createSession("J09-06 telemetry").then(function(s){'
    + 'return JSON.stringify({sessionId:s.sessionId,pin:s.pin,name:s.name,state:s.state})})', true));
  const sid = created.sessionId, pin = created.pin;
  console.log("SESSION sid=" + sid + " pin=***");
  expect(!!sid && !!pin, "session creee avec un PIN");

  const joinRes = await cap('MultiCamSessionWs.joinSession({host:'
    + json(masEndpoint.split(":")[0]) + ',port:' + parseInt(masEndpoint.split(":")[1], 10)
    + ',sessionId:' + json(sid) + ',name:' + json(created.name) + '},' + json(pin)
    + ').then(function(){return "JOIN_ENVOYE"},function(e){return "JOIN_KO "+e})', true);
  expect(/^JOIN_ENVOYE/.test(String(joinRes)), "adhesion de la Capture acceptee");

  let joined = null;
  const tJoin = Date.now();
  while (Date.now() - tJoin < 25000) {
    await sleep(700);
    joined = JSON.parse(await cap('MultiCamSessionStore.get(' + json(sid) + ').then(function(s){'
      + 'return JSON.stringify(s?{state:s.state,masters:(s.masters||[]).map(function(m){return m.deviceId})}:null)})', true));
    if (joined && joined.masters.indexOf(M.did) >= 0) break;
  }
  expect(joined && joined.masters.indexOf(M.did) >= 0, "la Capture a recu les roles du Master");

  /* Une jonction par PIN n'ajoute PAS de membre : il faut `addMember()`, l'API de
   * production derrière l'écran 03 (sinon pas de Capture dans le plan). */
  const memberAdd = await mas('MultiCamSessionStore.get(' + json(sid) + ').then(function(s){'
    + 'return MultiCamSessionWs.addMember(s,{deviceId:' + json(C.did) + ',deviceName:' + json(C.name)
    + ',enabledSkills:' + json(C.skills) + ',endpoint:' + json(capEndpoint) + '},["capture"])'
    + '.then(function(u){return JSON.stringify({ok:true})},'
    + 'function(e){return JSON.stringify({ok:false,err:String(e)})})})', true);
  expect(JSON.parse(memberAdd).ok === true, "la Capture est membre de la session (role capture)");

  /* ---------- 3. la Capture ouvre l'ecran 05 (flux operateur) ----------
   * C'est là que le service de collecte démarre : le service est unique, mais il
   * est déclenché par l'ecran qui possede le Take. On attend qu'il tourne
   * vraiment avant d'aller plus loin — sinon le reste du smoke mesurerait un
   * service arrêté. */
  const capSvc = JSON.parse(await cap(TAP_SEND, false));
  expect(capSvc.ok === true, "l'ecoute de mesure du send() natif est en place sur la Capture");

  await cap('MultiCamNav.show("take",{sid:' + json(sid) + '}); "take"', false);
  /* Le service ne démarre qu'une fois la Capture MEMBRE d'une session ouverte.
   * Elle l'apprend par resync : on ATTEND donc l'état réel au lieu de supposer
   * un délai — un `sleep` ici mesurerait la machine, pas le produit. */
  const tSvc = Date.now();
  let svc = null;
  while (Date.now() - tSvc < 40000) {
    await sleep(1000);
    svc = JSON.parse(await cap(CAP_VIEW, false));
    if (svc.running) break;
  }
  const demarrageMs = Date.now() - tSvc;
  console.log("SERVICE " + json(svc) + " demarrage=" + demarrageMs + " ms");
  expect(!!svc && svc.running === true, "le service de collecte tourne sur la Capture");
  expect(svc.cadenceMs === 5000, "cadence annoncee = 5000 ms");
  ev.demarrageServiceMs = demarrageMs;

  /* ---------- 4. ARM + REC par le chemin de production ---------- */
  await mas('MultiCamNav.show("take",{sid:' + json(sid) + '}); "take"', false);
  await sleep(2000);
  await selectionnerToutesCaptures(mas, sid, "take1");
  await mas('(function(){var b=document.getElementById("tkArm");if(b&&!b.disabled)b.click();return 1;})()', false);
  await sleep(5000);
  await mas('(function(){var m=document.getElementById("armIncidentModal");'
    + 'if(m&&m.classList.contains("show")){var c=document.getElementById("armIncidentContinue");if(c)c.click();'
    + 'return "INCIDENT_LEVE";}return "aucun incident";})()', false);
  await sleep(1500);
  const recStart = await demarrerRec(mas, "master");
  console.log("REC " + recStart);
  expect(recStart !== "sans-demarrage", "le plan de START a demarre (Master)");
  await sleep(9000);

  const scr = JSON.parse(await mas("JSON.stringify({s:document.querySelector('.screen.active').id})", false));
  console.log("ECRAN " + json(scr));
  expect(String(scr.s).indexOf("live") >= 0 || String(scr.s).indexOf("countdown") >= 0,
    "le Master est en panneau REC (08) ou en attente (07)");
  /* Le passage en mosaïque demande au modèle START d'être actif : on attend la
   * mosaïque, qui est l'écran que ce smoke doit observer. */
  let s1 = null;
  const tMosaic = Date.now();
  while (Date.now() - tMosaic < 30000) {
    await sleep(1000);
    const dom = JSON.parse(await mas(DOM_PROBE, false));
    if (dom.screen === "panel-live" && dom.tiles.length) { s1 = dom; break; }
  }
  expect(!!s1, "la mosaïque REC est affichee sur le Master");

  /* ---------- 5. S1 : les valeurs MESUREES sont affichees ---------- */
  await sleep(12000);   /* laisse passer au moins deux publications à 5 s */
  const dom1 = JSON.parse(await mas(DOM_PROBE, false));
  const model1 = JSON.parse(await mas(MODEL_PROBE, false));
  const store1 = JSON.parse(await mas(storeProbe(json(sid)), false));
  const capSvc1 = JSON.parse(await cap(CAP_VIEW, false));
  const shots1 = [shot(MASTER_SERIAL, "70-mosaique-telemetrie.png")];
  ev.s1 = { dom: dom1, model: model1, store: store1, capService: capSvc1, shots: shots1 };
  console.log("S1 dom=" + json(dom1.tiles));
  console.log("S1 telemetry=" + json(model1.slots.map(function (s) { return s.telemetry; })));

  const t0 = dom1.tiles[0];
  expect(!!t0, "la mosaïque a au moins une vignette");
  expect(!!(model1.slots[0].telemetry), "le modele porte un snapshot de supervision");
  expect(store1.entries[C.did] !== undefined, "le store du Master a bien l'entree de la Capture");
  expect(store1.entries[C.did].local === false, "l'entree vient du RESEAU (pas du chemin local)");
  const sup = t0.supervision || [];
  const bat = sup.filter(function (x) { return /%/.test(x.txt); })[0];
  const sto = sup.filter(function (x) { return /Ko|Mo|Go|To/.test(x.txt); })[0];
  expect(!!bat && bat.known === "true", "la vignette affiche un NIVEAU DE BATTERIE mesure : " + json(bat));
  expect(!!sto && sto.known === "true", "la vignette affiche un ESPACE LIBRE mesure : " + json(sto));
  expect(/[0-9]/.test(String(sto.txt)), "la valeur de stockage n'est pas un nombre bidon : " + sto.txt);
  expect(!!(capSvc1.space && capSvc1.space.totalBytes > 0),
    "la Capture mesure aussi le TOTAL de stockage : " + json(capSvc1.space));
  expect(!!(capSvc1.net && capSvc1.net.type), "la Capture mesure un TYPE de reseau : " + json(capSvc1.net));
  expect(capSvc1.errors === 0, "aucune erreur de publication sur la Capture");

  /* ---------- 6. S2 : cadence et taille des messages ---------- */
  const capMsgs = JSON.parse(await cap(TAP_READ, false));
  const store2 = JSON.parse(await mas(storeProbe(json(sid)), false));
  const ecarts = [];
  for (let i = 1; i < capMsgs.length; i++) ecarts.push(capMsgs[i].t - capMsgs[i - 1].t);
  const bytes = capMsgs.map(function (m) { return m.bytes; });
  const cadence = statsOf(ecarts);
  ev.s2 = {
    observeMs: CADENCE_MS,
    messages: capMsgs.length,
    cadence: cadence,
    octets: bytes.length ? { min: Math.min.apply(null, bytes), max: Math.max.apply(null, bytes),
      moyenne: Math.round(bytes.reduce(function (a, b) { return a + b; }, 0) / bytes.length) } : null,
    storePublishes: store2.stats ? store2.stats.publishes : null,
    storeIgnorees: store2.stats ? store2.stats.ignoredOlder : null,
    premier: capMsgs[0] || null,
    dernier: capMsgs[capMsgs.length - 1] || null
  };
  console.log("S2 cadence=" + json(cadence) + " messages=" + capMsgs.length + " octets=" + json(ev.s2.octets));
  expect(capMsgs.length >= 3, "au moins 3 publications observees en " + (CADENCE_MS / 1000) + " s");
  expect(!!cadence && cadence.medianMs >= 4000 && cadence.medianMs <= 7000,
    "cadence mediane dans la fenetre 4–7 s : " + (cadence ? cadence.medianMs : "—") + " ms");
  expect(!!ev.s2.octets && ev.s2.octets.max < 2048,
    "un snapshot reste COMPACT (< 2 Ko) : " + (ev.s2.octets ? ev.s2.octets.max : "—") + " octets");

  /* ---------- 7. S3 : vue detaillee (lecture seule) ---------- */
  /* Ouverture par un VRAI appui sur la vignette (délégation d'événement), pas
   * par un appel d'API : le geste de l'opérateur est ce qu'on veut prouver. */
  await mas('(function(){var t=document.querySelector("#liveGrid .live-tile");'
    + 'if(!t)return "PAS_DE_VIGNETTE";t.click();return "CLIC";})()', false);
  await sleep(1200);
  const det1 = JSON.parse(await mas(DETAIL_PROBE, false));
  const shotsDetail = [shot(MASTER_SERIAL, "70-detail-capture.png")];
  ev.s3 = { detail: det1, shots: shotsDetail };
  console.log("S3 detail=" + json(det1));
  expect(det1.open === true, "la vue detaillee s'ouvre au clic sur la vignette");
  expect(!!det1.hasImg, "la vue detaillee montre la DERNIERE preview recue");
  expect(!!det1.battery && /%/.test(String(det1.battery)), "le detail affiche la batterie : " + det1.battery);
  expect(!!det1.storage && /libres/.test(String(det1.storage)), "le detail affiche le stockage libre : " + det1.storage);
  expect(!!det1.network && det1.network !== "…", "le detail affiche le reseau : " + det1.network);
  expect(det1.boutons.length === 1 && /^ldClose:/.test(String(det1.boutons[0])),
    "la vue detaillee ne contient QU'un bouton « fermer » (aucune commande J10) : " + json(det1.boutons));
  expect(!!det1.detail && det1.detail.actions.length === 0, "le contrat du detail n'expose aucune action");
  await mas('(function(){var b=document.getElementById("ldClose");if(b)b.click();return 1;})()', false);
  await sleep(600);

  /* ---------- 8. S4 : deconnexion ---------- */
  const tOff = Date.now();
  await mas('(function(){if(window.MultiCamLiveDetail.isOpen())MultiCamLiveDetail.close();return 1;})()', false);
  console.log("CUT_WIFI master");
  adb(["-s", MASTER_SERIAL, "shell", "svc", "wifi", "disable"]);
  let s4 = null;
  const tOff2 = Date.now();
  while (Date.now() - tOff2 < 45000) {
    await sleep(1000);
    const dom = JSON.parse(await mas(DOM_PROBE, false));
    const model = JSON.parse(await mas(MODEL_PROBE, false));
    if (model.slots[0] && model.slots[0].displayState === "DECONNECTED") { s4 = { dom, model }; break; }
  }
  expect(!!s4, "la Capture passe DECONNECTEE sur la mosaique");
  await sleep(16000);   /* laisse la telemetrie devenir « ancienne » (seuil 15 s) */
  const s4b = {
    dom: JSON.parse(await mas(DOM_PROBE, false)),
    model: JSON.parse(await mas(MODEL_PROBE, false)),
    store: JSON.parse(await mas(storeProbe(json(sid)), false))
  };
  const shots4 = [shot(MASTER_SERIAL, "70-deconnecte.png")];
  ev.s4 = Object.assign({}, s4, s4b, { shots: shots4 });
  console.log("S4 telemetry=" + json(s4b.model.slots[0].telemetry)
    + " alert=" + json(s4b.dom.tiles[0].alertIcon) + " sup=" + json(s4b.dom.tiles[0].supervision));
  expect(s4b.model.slots[0].displayState === "DECONNECTED", "l'etat reste DECONNECTE (le WS prime)");
  expect(s4b.model.slots[0].telemetry !== null,
    "les DERNIERES valeurs mesurees restent affichees (informations datees)");
  expect(!!s4b.model.slots[0].telemetryAt, "le snapshot conserve son instant");
  expect(s4b.store.entries[C.did] !== undefined && s4b.store.entries[C.did].telemetry !== null,
    "le store du Master n'a PAS perdu la derniere telemetrie");
  /* Une Capture hors ligne ne peut plus rien publier : le compteur du store ne
   * doit donc pas bouger. On le note, on ne l'exige pas (une trame en vol peut
   * encore arriver) — mais on refuse qu'il ait AUGMENTÉ de plus d'une unité. */
  const capOff = JSON.parse(await cap(CAP_VIEW, false));
  ev.s4.captureService = capOff;
  expect(capOff.running === true, "la Capture continue de mesurer hors ligne (elle ne peut pas publier)");
  expect(!!capOff.space || !!capOff.battery, "la Capture mesure toujours sa batterie/stockage");

  /* ---------- 9. S5 : reconnexion ---------- */
  console.log("CUT_WIFI master off");
  adb(["-s", MASTER_SERIAL, "shell", "svc", "wifi", "enable"]);
  const tOn = Date.now();
  let s5 = null;
  const tOn2 = Date.now();
  while (Date.now() - tOn2 < 90000) {
    await sleep(1000);
    const model = JSON.parse(await mas(MODEL_PROBE, false));
    const store = JSON.parse(await mas(storeProbe(json(sid)), false));
    const ent = store.entries[C.did];
    if (model.slots[0] && model.slots[0].displayState !== "DECONNECTED" && ent && ent.atMs > s4b.model.slots[0].telemetryAt) {
      s5 = { model, store, at: Date.now() };
      break;
    }
  }
  expect(!!s5, "la Capture revient et une telemetrie FRAICHE remplace l'ancienne");
  const repriseMs = s5 ? (s5.at - tOn) : null;
  ev.s5 = Object.assign({}, s5 || {}, { repriseApresCoupureMs: repriseMs });
  console.log("S5 reprise=" + repriseMs + " ms");
  if (s5) {
    expect(s5.store.entries[C.did].atMs > s4b.model.slots[0].telemetryAt,
      "le snapshot recu est plus RECENT que celui d'avant la coupure");
    expect(!!(s5.store.entries[C.did].telemetry.batteryLevel != null),
      "la telemetrie reapparue porte bien des valeurs mesurees");
  }

  /* ---------- 10. bilans ---------- */
  const capLines = grabConsole(CAP_SERIAL, "capture");
  const masLines = grabConsole(MASTER_SERIAL, "master");
  const counts = {
    telemetrySent: capLines.filter(function (l) { return /TELEMETRY_SENT/.test(l); }).length,
    telemetryCollect: capLines.filter(function (l) { return /TELEMETRY_COLLECTOR_START|TELEMETRY_TRIGGER/.test(l); }).length,
    telemetryReceived: masLines.filter(function (l) { return /TELEMETRY_RECEIVED/.test(l); }).length,
    telemetryStoreSet: masLines.filter(function (l) { return /TELEMETRY_STORE_SET/.test(l); }).length,
    telemetryIgnored: masLines.filter(function (l) { return /LIVE_TELEMETRY_IGNORED|TELEMETRY_STORE_IGNORE/.test(l); }).length,
    screen05Unavailable: capLines.filter(function (l) { return /SCREEN05_TELEMETRY_UNAVAILABLE/.test(l); }).length
  };
  console.log("COUNTS " + json(counts));

  const report = {
    mission: "J09-06",
    title: "Supervision operationnelle des Captures — mesure, cadence, affichage, vue detaillee",
    at: new Date().toISOString(),
    devices: {
      capture: { serial: CAP_SERIAL, deviceId: C.did, endpoint: capEndpoint },
      master: { serial: MASTER_SERIAL, deviceId: M.did, endpoint: masEndpoint }
    },
    session: { sessionId: sid, pin: "***" },
    s1_valeursMesurees: ev.s1,
    s2_cadence: ev.s2,
    s3_vueDetaillee: ev.s3,
    s4_deconnexion: ev.s4,
    s5_reconnexion: ev.s5,
    logCounts: counts,
    verdict: {
      serviceDemarre: !!(svc && svc.running),
      cadence5s: !!(cadence && cadence.medianMs >= 4000 && cadence.medianMs <= 7000),
      snapshotCompact: !!(ev.s2.octets && ev.s2.octets.max < 2048),
      batterieAffichee: !!(bat && bat.known === "true"),
      stockageAffiche: !!(sto && sto.known === "true"),
      totalStockageConnu: !!(capSvc1.space && capSvc1.space.totalBytes > 0),
      reseauConnu: !!(capSvc1.net && capSvc1.net.type),
      provenanceReseau: store1.entries[C.did].local === false,
      vueDetailleeOuverteEtLireSeule: det1.open === true && det1.boutons.length === 1 && !!(det1.detail && det1.detail.actions.length === 0),
      deconnexionEtatEteintSansPerdreLesValeurs: !!(s4b.model.slots[0].telemetry
        && s4b.model.slots[0].displayState === "DECONNECTED"),
      reconnexionTelemetrieFraiche: !!s5,
      aucuneValeurInventee: !sup.some(function (x) { return x.known === "false" && /\d/.test(x.txt); })
    }
  };
  fs.writeFileSync(path.join(OUT, "rapport.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("RAPPORT " + path.relative(HERE, path.join(OUT, "rapport.json")));
  console.log("VERDICT " + json(report.verdict));

  const ok = Object.keys(report.verdict).every(function (k) { return report.verdict[k] === true; });
  console.log(ok ? "J09-06 SMOKE OK" : "J09-06 SMOKE : VERDICT INCOMPLET");
  capC.ws.close();
  masC.ws.close();
  process.exit(ok ? 0 : 1);
}

main().catch(function (err) {
  console.error("ECHEC " + String(err && err.message || err));
  try { grabConsole(MASTER_SERIAL, "master"); grabConsole(CAP_SERIAL, "capture"); } catch (e) {}
  process.exit(1);
});