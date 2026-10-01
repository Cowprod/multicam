#!/usr/bin/env node
/* ============================================================================
 * SMOKE PHYSIQUE — RECONNEXION AUTOMATIQUE DU WS (mission J09, recapautomatic)
 * ============================================================================
 *
 * CE QUE CE SMOKE PROUVE (et rien d'autre) :
 *
 *   1. une coupure réseau RÉELLE sur la Capture (Wi-Fi coupé, adresse perdue) ;
 *   2. la Capture NE SE RAPPELLE PAS d'aucune action opérateur : pendant toute
 *      la fenêtre de coupure/rétablissement, ce script n'émet QUE des sondes de
 *      lecture (présence, état du slot). Aucun `click`, aucun `reSyncSession()`,
 *      aucune navigation ;
 *   3. au retour du réseau, la Capture RÉTABLIT SON PROPRE WS
 *      (`WS_CLIENT_OPEN` + `WS_RESYNC_SESSIONS`), la présence est reconstruite
 *      chez les DEUX devices, et les previews repartent ;
 *   4. la reprise est BORNÉE : nombre de tentatives et délais pendant la coupure
 *      sont mesurés et consignés dans la preuve.
 *
 * PREUVE D'AUTOMATISME (le point non négociable) :
 * `WS_RESYNC_SESSIONS` n'est émis QUE par `reSyncSessionsFor()`, lui-même appelé
 * uniquement depuis `ws.onopen` lorsqu'une RECONNEXION vient d'aboutir. Voir sa
 * présence dans le log de la Capture = la reconnexion s'est faite seule. Aucune
 * ligne `RESYNC_MANUEL` n'est produite par ce script.
 *
 * AUCUN MP4 n'est récupéré : le REC est local au device, on n'en copie rien.
 *
 * Variables d'environnement : CAP_SERIAL, MASTER_SERIAL, CDP_PORT,
 * MASTER_CDP_PORT, CUT_MS, RECOVER_BUDGET_MS.
 * ==========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");

const PKG = "fr.emmanuel.multicam";
const CAP_SERIAL = process.env.CAP_SERIAL || "61d54bba7d91";
const MASTER_SERIAL = process.env.MASTER_SERIAL || "c0d8514d7d87";
const CAP_PORT = process.env.CDP_PORT || "9223";
const MASTER_PORT = process.env.MASTER_CDP_PORT || "9224";
/* Durée de la coupure : assez long pour voir le backoff monter, assez court
 * pour que le smoke reste un smoke. */
const CUT_MS = Number(process.env.CUT_MS || 9000);
/* Budget de reprise après retour réseau, mesuré depuis le retour du Wi-Fi. */
const RECOVER_BUDGET_MS = Number(process.env.RECOVER_BUDGET_MS || 15000);
/* Adresses attendues du laboratoire : sert au pré-vol réseau (voir
 * `lanPreflight`). Surchargables pour un autre montage. */
const MASTER_IP_LAN = process.env.MASTER_IP_LAN || "192.168.92.192";
const CAPTURE_IP_LAN = process.env.CAPTURE_IP_LAN || "192.168.92.76";
const MASTER_PORT_LAN = Number(process.env.MASTER_PORT_LAN || 45102);

const HERE = __dirname;
const OUT = path.join(HERE, "logs", "60-ws-reconnect");
const SHOTS = path.join(HERE, "screenshots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (o) => JSON.stringify(o);

/* Journal de console rejoué dans la preuve : un rapport qui n'existe que dans
 * le terminal n'est pas une preuve. */
const logLines = [];
const say = console.log.bind(console);
console.log = function (...a) {
  logLines.push(a.map((x) => (typeof x === "string" ? x : json(x))).join(" "));
  say(...a);
};

/* ---------- adb ---------- */

function adb(args, opts) {
  return require("child_process").execFileSync("adb", args, Object.assign({
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024
  }, opts || {}));
}

function adbTry(args) {
  try { return adb(args); } catch (e) { return (e.stdout || "") + (e.stderr || ""); }
}

/* Démarrage À FROID : indispensable, `location.reload()` laisse le serveur WS
 * NATIF garder le port 45102 et le device devient injoignable (constaté J09-02). */
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
  const { width, height } = pngSize(buf);
  console.log("SHOT " + name + " " + width + "x" + height + " " + buf.length + " octets");
  return { file: path.relative(HERE, dest), bytes: buf.length, width, height };
}

function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/* Journalisation PARSABLE (AGENTS.md) + les lignes de reprise J09. */
const KEEP = "LIVE_|SCREEN08_|NAV_AUTO|START_|PREVIEW_|REC_|CAMERA_|WS_|JOIN_|SESSION_CLOSE|ARM_|CLOCK_|TAKE_";

function grabConsole(serial, label) {
  const raw = adbTry(["-s", serial, "logcat", "-d", "-v", "time"]).split("\n");
  const kept = raw.filter((l) => l.indexOf("chromium") >= 0 && new RegExp(KEEP).test(l))
    .map((l) => l.replace(/^.*CONSOLE:[0-9]+\] "/, "").replace(/", source:.*$/, ""));
  fs.writeFileSync(path.join(OUT, label + "-console.txt"), kept.join("\n") + "\n");
  return kept;
}

/* ---------- mesures temporelles côté device ---------- */

/* `logcat -v time` : "MM-DD HH:MM:SS.mmm". On convertit en ms dans la journée.
 * Utile pour dater un `WS_CLIENT_OPEN` À LA SEULE PRÉCISION DU DEVICE, sans
 * dépendre du temps d'un aller-retour adb. */
function parseLogTime(line) {
  const m = /^\d\d-\d\d (\d\d):(\d\d):(\d\d)\.(\d\d\d)/.exec(line);
  if (!m) return null;
  return ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + (+m[4]);
}

function consoleWithTime(serial) {
  const raw = adbTry(["-s", serial, "logcat", "-d", "-v", "time"]).split("\n");
  return raw
    .filter((l) => l.indexOf("chromium") >= 0 && new RegExp(KEEP).test(l))
    .map((l) => ({
      t: parseLogTime(l),
      line: l.replace(/^.*CONSOLE:[0-9]+\] "/, "").replace(/", source:.*$/, "")
    }))
    .filter((x) => x.t !== null);
}

/* Fenêtre de log par HORODATAGE DEVICE, jamais par nombre de lignes : le buffer
 * logcat tourne (buffer cyclique) et un index cassé fait disappear les lignes
 * les PLUS RÉCENTES — donc précisément la preuve recherchée. Un premier essai a
 * ainsi raté le `WS_CLIENT_OPEN` de la reprise alors qu'il était bien dans le
 * fichier de preuve. */
function lastConsoleTime(serial) {
  const c = consoleWithTime(serial);
  return c.length ? c[c.length - 1].t : null;
}

function consoleSince(serial, fromMs) {
  return consoleWithTime(serial).filter((x) => fromMs === null || x.t >= fromMs);
}

/* Attendre une ligne de log. OBLIGATOIRE : la console WebView est transmise à
 * logcat avec un décalage de l'ordre de la centaine de ms : les sondes CDP
 * reviennent donc AVANT la ligne de log. Une lecture unique conclut « pas de
 * WS_CLIENT_OPEN » alors que la reconnexion vient de réussir (présence et
 * previews mesurées bonnes). On scrute jusqu'à apparition, comme pour toute
 * preuve device. */
async function waitForLog(serial, fromMs, re, timeoutMs) {
  const t0 = Date.now();
  let best = [];
  while (Date.now() - t0 < (timeoutMs || 6000)) {
    const c = consoleSince(serial, fromMs);
    best = c;
    const hit = c.filter((x) => re.test(x.line));
    if (hit.length) return hit[0];
    await sleep(300);
  }
  return null;
}

/* ---------- sondes (LECTURE SEULE) ---------- */

/* Sondes de présence. Elles ne font QUE lire : c'est la garantie que le
 * script n'a rien demandé au device pendant la coupure. */
const PRESENCE = (sid) => "JSON.stringify({"
  + "endpoint:(MultiCamSessionWs.status()||{}).selfEndpoint,"
  + "peers:Object.keys(MultiCamSessionWs.connectedPeers(" + json(sid) + "))})";

const TILE_PROBE = '(function(){var grid=document.getElementById("liveGrid");'
  + 'var tiles=[].slice.call(grid?grid.children:[]).map(function(t){'
  + 'var img=t.querySelector("img");var st=t.querySelector(".tile-state");'
  + 'var nm=t.querySelector(".tile-name");'
  + 'return {name:nm?nm.textContent:"",state:st?st.getAttribute("data-state"):"",'
  + 'hasSrc:!!(img&&img.getAttribute("src")),'
  + 'offline:t.classList.contains("offline")};});'
  + 'return JSON.stringify({screen:document.querySelector(".screen.active")'
  + '?document.querySelector(".screen.active").id:"",tiles:tiles});})()';

const LIVE_PROBE = '(function(){var m=MultiCamLiveModel.view();return JSON.stringify({'
  + 'sid:m.sessionId,takeNumber:m.takeNumber,slots:m.slots.map(function(s){'
  + 'return {deviceId:s.deviceId,status:s.status,connected:s.connected,'
  + 'displayState:s.displayState,hasFrame:s.hasFrame,lastFrameSeq:s.lastFrameSeq};})});})()';

/* L'enregistrement se vérifie SUR LA CAPTURE : le Master a sa skill capture
 * désactivée (cas d'une régie), c'est donc forcément le device Capture qui
 * filme. interroger le Master renverrait toujours false et ferait échouer le
 * smoke sur une fausse alerte. */
const CAP_REC = "JSON.stringify({recording:(MultiCamCameraRecord.view()||{}).recording,"
  + "phase:(MultiCamStartService.view()||{}).phase,"
  + "screen:document.querySelector('.screen.active')?document.querySelector('.screen.active').id:''})";

/* ---------- compteurs de preuve ---------- */

const ev = { probes: [], shots: [], checks: [], mesures: {} };

function check(cond, msg) {
  ev.checks.push({ ok: !!cond, msg });
  console.log((cond ? "  OK   " : "  ECHEC") + " " + msg);
  if (!cond) throw new Error(msg);
}

function note(tag, value) {
  ev.probes.push({ tag, at: new Date().toISOString(), value });
}

/* ---------- réseau ---------- */

function wifiIp(serial) {
  const out = adbTry(["-s", serial, "shell", "ip -4 addr show wlan0"]);
  const m = /inet (\d+\.\d+\.\d+\.\d+)/.exec(out);
  return m ? m[1] : "";
}

function lanUp(serial, targetIp) {
  const out = adbTry(["-s", serial, "shell", "ping -c 1 -W 1 " + targetIp]);
  return /1 (packets )?received/.test(out) || /bytes from/.test(out);
}

/* Pré-vol réseau. Indispensable après un `svc wifi disable/enable` : le device
 * peut se retrouver associé SANS route par défaut, ou isolé par le point
 * d'accès. Sans ce contrôle, le smoke échoue plus loin sur un `JOIN_KO` qui
 * accuse le code alors que la cause est_materiale : le réseau du laboratoire.
 * On vérifie donc, depuis CHAQUE device, que l'autre est joignable ET que le
 * port WS du Master répond. */
/* Le port sondé est le port RÉELLEMENT annoncé par l'application
 * (`status().effectivePort`), pas une constante : le serveur WS NATIF se
 * réattribue le port suivant quand l'ancien est encore occupé (constaté en
 * campagne : 45102 encore pris -> 45103). Sonder le port codé en dur testait
 * donc un port MORT et faisait échouer le smoke pour une raison étrangère au
 * produit, alors que la Capture rejoint bien l'endpoint annoncé. */
function lanPreflight(effectivePort) {
  const port = effectivePort || MASTER_PORT_LAN;
  const out = {};
  out.captureVersMaster = lanUp(CAP_SERIAL, MASTER_IP_LAN);
  out.masterVersCapture = lanUp(MASTER_SERIAL, CAPTURE_IP_LAN);
  out.portSonde = port;
  out.portWsurMaster = /TCP_OK/.test(adbTry(["-s", CAP_SERIAL, "shell",
    "echo | timeout 3 nc " + MASTER_IP_LAN + " " + port + " && echo TCP_OK"]));
  out.routeCapture = adbTry(["-s", CAP_SERIAL, "shell", "ip route | grep -c default"]).trim();
  out.ipCapture = wifiIp(CAP_SERIAL);
  out.ipMaster = wifiIp(MASTER_SERIAL);
  return out;
}

/* ---------- partenaires de production (ARM puis REC) ---------- */

async function selectionnerToutesCaptures(dev, sid, label) {
  const r = await dev('(function(){var b=document.getElementById("tkCaptureAll");'
    + 'if(!b)return JSON.stringify({ok:false,err:"pas de tkCaptureAll"});'
    + 'if(b.disabled)return JSON.stringify({ok:false,err:"tkCaptureAll desactive"});'
    + 'b.click();return JSON.stringify({ok:true});})()', true);
  await sleep(800);
  const t = await dev('MultiCamSessionStore.get(' + json(sid) + ').then(function(s){'
    + 'var a=(s.takes||[]);var t=a.length?a[a.length-1]:null;'
    + 'return JSON.stringify({captures:(t&&t.captures)||[],'
    + 'membres:(s.members||[]).filter(function(x){return (x.sessionRoles||[]).indexOf("capture")>=0})'
    + '.map(function(x){return x.deviceId})});})', true);
  const clic = JSON.parse(r);
  const v = JSON.parse(t);
  check(clic.ok === true, "le bouton Toutes Captures est actif (" + label + ")");
  check(JSON.stringify((v.captures || []).slice().sort())
    === JSON.stringify((v.membres || []).slice().sort()),
    "la selection = tous les membres Capture (" + label + ") : " + v.captures.length);
  return v;
}

async function demarrerRec(masDev, capDev, label) {
  const r = await masDev('(function(){var b=document.getElementById("armRec");'
    + 'if(!b)return "PAS_DE_BOUTON";if(b.disabled)return "BOUTON_DESACTIVE";'
    + 'b.click();return "REC_CLIQUE";})()', false);
  console.log("REC_DOCK " + label + " " + r);
  /* Le plan passe par le compte a rebours puis REC : on attend l'état RÉEL sur
   * la Capture, en levant au passage une éventuelle modale d'incident. */
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < 45000) {
    await sleep(700);
    last = String(await capDev(CAP_REC, false));
    if (/"recording":true/.test(last)) return "recording=true";
    const cont = await masDev('(function(){var m=document.getElementById("armIncidentModal");'
      + 'if(m&&m.classList.contains("show")){var b=document.getElementById("armIncidentContinue");'
      + 'if(b)b.click();return "CONTINUE";}return "";})()', false);
    if (/CONTINUE/.test(String(cont))) console.log("REC_INCIDENT " + label + " levee");
  }
  return "sans-demarrage:" + last;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const tStart = Date.now();
  console.log("=== SMOKE reconnexion automatique WS ===");

  for (const serial of [CAP_SERIAL, MASTER_SERIAL]) {
    try { adb(["-s", serial, "logcat", "-c"]); } catch (e) {}
  }

  /* ---------- 0. démarrage à froid ---------- */

  const READY_CAP = "(MultiCamConfig.get()&&MultiCamSessionWs.status().serverRunning"
    + "&&typeof MultiCamPreviewTransport!=='undefined'"
    + "&&typeof MultiCamLiveModel!=='undefined')?'PRET':''";
  const READY_MAS = "(MultiCamConfig.get()&&MultiCamSessionWs.status().serverRunning"
    + "&&typeof MultiCamPreviewInbox!=='undefined'"
    + "&&typeof MultiCamLiveModel!=='undefined')?'PRET':''";
  const cap = (await attach(coldStart(CAP_SERIAL, CAP_PORT, "capture"), "capture", READY_CAP)).ev;
  const mas = (await attach(coldStart(MASTER_SERIAL, MASTER_PORT, "master"), "master", READY_MAS)).ev;

  /* ---------- 0a. pré-vol réseau ---------- */
  const portEffectif = JSON.parse(
    await mas("JSON.stringify(MultiCamSessionWs.status())", false)).effectivePort;
  const lan = lanPreflight(portEffectif);
  console.log("LAN_PREFLIGHT " + json(lan));
  ev.mesures.lanPreflight = lan;
  check(lan.captureVersMaster && lan.masterVersCapture,
    "les deux devices se joignent sur le LAN : " + json(lan));
  check(lan.portWsurMaster, "le port WS du Master repond depuis la Capture");

  /* ---------- 0b. hygiene : purger les sessions ouvertes residuelles ----------
   *
   * Chaque smoke laisse sa session `open` derrière soi (et le Master redémarre
   * parfois sur un port effectif différent). Sans ce nettoyage, la Capture
   * compte 14 sessions ouvertes et deux endpoints de Master : le retry resterait
   * correct mais la mesure serait illisible, et le smoke ressemblerait à un
   * défaut alors que c'est un artefact de campagne. On ferme donc par l'API de
   * production, avant tout. */
  const purge = await cap('MultiCamSessionStore.list().then(function(all){'
    + 'var open=all.filter(function(s){return s.state==="open"});'
    + 'return open.reduce(function(p,s){return p.then(function(){'
    + 'return MultiCamSessionWs.closeSession(s).catch(function(){return null})});},Promise.resolve())'
    + '.then(function(){return JSON.stringify({fermees:open.length})});})', true);
  await mas('MultiCamSessionStore.list().then(function(all){'
    + 'var open=all.filter(function(s){return s.state==="open"});'
    + 'return open.reduce(function(p,s){return p.then(function(){'
    + 'return MultiCamSessionWs.closeSession(s).catch(function(){return null})});},Promise.resolve())'
    + '.then(function(){return JSON.stringify({fermees:open.length})});})', true);
  console.log("PURGE sessions ouvertes " + purge);
  await sleep(2500);

  /* ---------- 1. rôles ---------- */

  const masSkills = JSON.parse(await mas('MultiCamConfig.setSkill("capture", false).then(function(c){'
    + 'return JSON.stringify({did:c.deviceId,name:c.deviceName,skills:c.enabledSkills})},'
    + 'function(){return JSON.stringify({error:"setSkill_indisponible"})})', true));
  const capSkills = JSON.parse(await cap('MultiCamConfig.setSkill("controller", false).then(function(c){'
    + 'return JSON.stringify({did:c.deviceId,name:c.deviceName,skills:c.enabledSkills})},'
    + 'function(){return JSON.stringify({error:"setSkill_indisponible"})})', true));
  console.log("SKILLS " + json({ master: masSkills, capture: capSkills }));
  check(!!masSkills.did && !!capSkills.did && masSkills.did !== capSkills.did,
    "les deux devices ont des identites distinctes");
  check(masSkills.skills.indexOf("controller") >= 0, "le Master garde controller");
  check(capSkills.skills.indexOf("capture") >= 0, "la Capture garde capture");

  /* L'endpoint de la Capture se lit SUR LA CAPTURE : le lire chez le Master
   * donnerait l'IP du Master dans `members[].endpoint` (cf. J09-05). */
  const masStatus = JSON.parse(await mas('JSON.stringify(MultiCamSessionWs.status())', false));
  const capStatus = JSON.parse(await cap('JSON.stringify(MultiCamSessionWs.status())', false));
  const masEndpoint = masStatus.selfEndpoint;
  const capEndpoint = capStatus.selfEndpoint;
  const masIp = masEndpoint.split(":")[0];
  console.log("LINK master=" + masSkills.did + " @" + masEndpoint
    + " capture=" + capSkills.did + " @" + capEndpoint);

  /* ---------- 2. session ---------- */

  const created = JSON.parse(await mas('MultiCamSessionWs.createSession("J09-06 reconnexion").then(function(s){'
    + 'return JSON.stringify({sessionId:s.sessionId,pin:s.pin,name:s.name})})', true));
  const sid = created.sessionId;
  const pin = created.pin;
  check(!!sid && !!pin, "session creee avec un PIN sid=" + sid);

  const joinRes = await cap('MultiCamSessionWs.joinSession({host:' + json(masIp) + ',port:'
    + parseInt(masEndpoint.split(":")[1], 10) + ',sessionId:' + json(sid) + ',name:'
    + json(created.name) + '},' + json(pin) + ').then(function(){return "JOIN_ENVOYE"},'
    + 'function(e){return "JOIN_KO "+e})', true);
  check(/^JOIN_ENVOYE/.test(String(joinRes)), "adhésion de la Capture acceptee");

  let joined = null;
  const tJoin = Date.now();
  while (Date.now() - tJoin < 25000) {
    await sleep(700);
    joined = JSON.parse(await cap('MultiCamSessionStore.get(' + json(sid) + ').then(function(s){'
      + 'return JSON.stringify(s?{masters:(s.masters||[]).map(function(m){return m.deviceId})}:null)})', true));
    if (joined && joined.masters.indexOf(masSkills.did) >= 0) break;
  }
  check(joined && joined.masters.indexOf(masSkills.did) >= 0,
    "la Capture a recu les roles du Master");

  /* La Capture doit être MEMBRE : sans elle, pas de vignette ni de plan ARM. */
  const memberAdd = await mas('MultiCamSessionStore.get(' + json(sid) + ').then(function(s){'
    + 'return MultiCamSessionWs.addMember(s,{deviceId:' + json(capSkills.did) + ',deviceName:'
    + json(capSkills.name) + ',enabledSkills:' + json(capSkills.skills) + ',endpoint:'
    + json(capEndpoint) + '},["capture"]).then(function(u){return JSON.stringify({ok:true})},'
    + 'function(e){return JSON.stringify({ok:false,err:String(e)})})})', true);
  check(JSON.parse(memberAdd).ok === true, "la Capture est membre de la session (role capture)");

  /* ---------- 3. ARM + REC : il faut des previews AVANT la coupure ---------- */

  await mas('MultiCamNav.show("take",{sid:' + json(sid) + '}); "take"', false);
  await sleep(2000);
  await selectionnerToutesCaptures(mas, sid, "avant-coupure");
  await mas('(function(){var b=document.getElementById("tkArm");if(b&&!b.disabled)b.click();'
    + 'return "ARM_CLIQUE";})()', false);
  await sleep(5000);
  console.log("REC " + await demarrerRec(mas, cap, "avant-coupure"));
  const recAvant = JSON.parse(await cap(CAP_REC, false));
  note("rec-avant", recAvant);
  check(recAvant.recording === true,
    "la Capture enregistre (cadence de previews active) : " + json(recAvant));

  await mas('MultiCamNav.show("live",{sid:' + json(sid) + '}); "live"', false);
  await sleep(3000);

  /* Attendre une image RÉELLE dans le slot de la Capture : c'est l'état de
   * référence auquel la reprise devra revenir. */
  let avant = null;
  const tAvant = Date.now();
  while (Date.now() - tAvant < 40000) {
    await sleep(1000);
    const live = JSON.parse(await mas(LIVE_PROBE, false));
    const slot = (live.slots || []).find((s) => s.deviceId === capSkills.did);
    if (slot && slot.hasFrame && slot.connected) { avant = { live, at: Date.now() }; break; }
  }
  const presAvant = JSON.parse(await cap(PRESENCE(sid), false));
  const tuilesAvant = JSON.parse(await mas(TILE_PROBE, false));
  note("avant", { live: avant && avant.live, presence: presAvant, tuiles: tuilesAvant });
  console.log("AVANT " + json({ slot: avant && avant.live.slots, presence: presAvant }));
  check(!!avant, "le slot de la Capture affiche une image reelle AVANT la coupure");
  check(!!presAvant.peers.find((d) => d === masSkills.did),
    "la Capture voit la presence du Master AVANT la coupure");
  const seqAvant = (avant.live.slots.find((s) => s.deviceId === capSkills.did) || {}).lastFrameSeq || 0;
  ev.mesures.seqAvant = seqAvant;
  ev.shots.push(shot(MASTER_SERIAL, "60-recon-1-avant.png"));

  /* ---------- 4. COUPURE RÉELLE du réseau de la Capture ---------- */

  const tCoupeLog = lastConsoleTime(CAP_SERIAL);
  ev.mesures.coupeLogT = tCoupeLog;
  console.log("COUPURE wifi disable sur la Capture, " + CUT_MS + " ms");
  const tCut = Date.now();
  adb(["-s", CAP_SERIAL, "shell", "svc", "wifi", "disable"]);
  await sleep(2500);
  const ipPendant = wifiIp(CAP_SERIAL);
  check(ipPendant === "", "la Capture a perdu son adresse Wi-Fi (coupure reelle) : " + (ipPendant || "aucune"));
  ev.mesures.coupeT0 = new Date(tCut).toISOString();

  /* Pendant la coupure : uniquement des SONDES. Aucune action opérateur.
   *
   * ASYÉTRIE VOLONTAIRE ET MESURÉE : la Capture voit la coupure en ~1 s (son
   * socket meurt), le Master attend SON heartbeat (8 s) pour pronuncier la
   * déconnexion. On mesure donc cette différence au lieu de la supposer : c'est
   * la latence de détection côté régie, pas une reprise manquant. */
  const tDet0 = Date.now();
  let presMasPendant = null, tuilesPendant = null, slotPendant = null;
  const BUDGET_DETECT = 20000;
  while (Date.now() - tDet0 < BUDGET_DETECT) {
    await sleep(500);
    presMasPendant = JSON.parse(await mas(PRESENCE(sid), false));
    const vuiles = JSON.parse(await mas(TILE_PROBE, false));
    slotPendant = (JSON.parse(await mas(LIVE_PROBE, false)).slots || [])
      .find((s) => s.deviceId === capSkills.did);
    if (!presMasPendant.peers.find((d) => d === capSkills.did) && slotPendant
      && slotPendant.connected === false) {
      ev.mesures.detectionMasterMs = Date.now() - tCut;
      break;
    }
  }
  tuilesPendant = JSON.parse(await mas(TILE_PROBE, false));
  const presCapturePendant = JSON.parse(await cap(PRESENCE(sid), false).catch(() => "{}"));
  note("pendant", {
    presenceCapture: presCapturePendant, presenceMaster: presMasPendant,
    tuiles: tuilesPendant, slot: slotPendant
  });
  console.log("PENDANT " + json({
    capture: presCapturePendant, master: presMasPendant,
    tuiles: tuilesPendant, slot: slotPendant, detectionMasterMs: ev.mesures.detectionMasterMs
  }));
  check(presCapturePendant.peers.length === 0,
    "la Capture a vu partir le Master immediatement (son socket est mort)");
  check(!presMasPendant.peers.find((d) => d === capSkills.did),
    "le Master voit la Capture DECONNECTEE pendant la coupure"
    + (ev.mesures.detectionMasterMs ? " apres " + ev.mesures.detectionMasterMs + " ms (heartbeat)"
      : " (delai non mesure)"));
  check(!!slotPendant && slotPendant.connected === false,
    "le slot de la Capture est marque non connecte (meme slot conserve)");
  check(tuilesPendant.tiles.length === 1 && tuilesPendant.tiles[0].hasSrc === true,
    "la vignette reste en place et conserve la derniere image");
  ev.shots.push(shot(MASTER_SERIAL, "60-recon-2-coupure.png"));

  /* On laisse la coupure durer : c'est là que le backoff doit rester borné. */
  await sleep(Math.max(0, CUT_MS - (Date.now() - tCut)));

  const logsCoupure = consoleSince(CAP_SERIAL, tCoupeLog);
  const retries = logsCoupure.filter((x) => /WS_RETRY_(SCHEDULE|ATTEMPT)/.test(x.line));
  const dials = logsCoupure.filter((x) => /WS_DIAL_TIMEOUT/.test(x.line));
  const delais = logsCoupure
    .filter((x) => /WS_RETRY_SCHEDULE .*delay=(\d+)ms/.test(x.line))
    .map((x) => parseInt(/delay=(\d+)ms/.exec(x.line)[1], 10));
  ev.mesures.coupure = {
    retries: retries.length,
    dialTimeouts: dials.length,
    delais: delais,
    lignes: logsCoupure.map((x) => x.line)
  };
  console.log("RETRY pendant coupure " + json({ retries: retries.length, dialTimeouts: dials.length, delais: delais }));
  check(delais.every((d) => d <= 5000), "chaque delai de retry est plafonne a 5000 ms : " + json(delais));
  check(delais.every((d, i) => i === 0 || d >= delais[i - 1]),
    "les delais ne decroissent jamais : " + json(delais));
  /* Sur ~" + CUT_MS + " ms de coupure, un backoff 500/1000/2000/5000 plafonne
   * donne 2 a 4 tentatives : bien plus en signalerait une boucle serree. */
  check(delais.length <= 5, "le nombre de tentatives reste borne : " + delais.length + " en ~" + CUT_MS + " ms");

  /* ---------- 5. RETOUR DU RESEAU : aucune action de l'operateur ---------- */

  console.log("RESTAURATION wifi enable sur la Capture");
  const tRestoreCmd = Date.now();
  /* Horodatage DEVICE au moment exact de la commande : c'est la référence qui
   * permet de mesurer la LATENCE DE REPRISE, et non la durée de la coupure
   * (mesurée close->open) qui mélange les deux. */
  const tRestaurationLog = lastConsoleTime(CAP_SERIAL);
  ev.mesures.restaurationLogT = tRestaurationLog;
  adb(["-s", CAP_SERIAL, "shell", "svc", "wifi", "enable"]);

  /* On attend le retour du LAN (association + DHCP) : la mesure de reprise
   * commence la, sinon on mesurerait le temps de la Wi-Fi, pas celui du WS. */
  let lanOk = false;
  const tLan0 = Date.now();
  while (Date.now() - tLan0 < 30000) {
    await sleep(500);
    if (lanUp(CAP_SERIAL, masIp) && wifiIp(CAP_SERIAL) === capEndpoint.split(":")[0]) { lanOk = true; break; }
  }
  check(lanOk, "la Capture a retrouve le LAN a la meme adresse (" + capEndpoint.split(":")[0] + ")");
  const tLan = Date.now();
  ev.mesures.lanRstT0 = new Date(tLan).toISOString();
  ev.mesures.lanRetourMs = tLan - tRestoreCmd;

  /* MESURE 1 — presence : le Master revoit la Capture. Sondes de lecture
   * uniquement ; le script ne fait RIEN d'autre pendant cette fenetre. */
  let tPresence = -1;
  const tP0 = Date.now();
  while (Date.now() - tP0 < RECOVER_BUDGET_MS) {
    const p = JSON.parse(await mas(PRESENCE(sid), false));
    if (p.peers.find((d) => d === capSkills.did)) { tPresence = Date.now() - tP0; break; }
    await sleep(400);
  }
  note("apres-presence", { tPresence });

  /* MESURE 2 — previews : une image REALE de nouveau, avec une seq plus
   * recente qu'avant la coupure (une image presente ne suffirait pas : le
   * cache de la mosaïque pourrait mentir). */
  let tPreview = -1;
  let seqApres = 0;
  const tF0 = Date.now();
  while (Date.now() - tF0 < RECOVER_BUDGET_MS) {
    const live = JSON.parse(await mas(LIVE_PROBE, false));
    const slot = (live.slots || []).find((s) => s.deviceId === capSkills.did);
    if (slot && slot.hasFrame && slot.connected && (slot.lastFrameSeq || 0) > seqAvant) {
      seqApres = slot.lastFrameSeq;
      tPreview = Date.now() - tF0;
      note("apres-preview", { live, at: new Date().toISOString() });
      break;
    }
    await sleep(600);
  }

  const logsApres = consoleSince(CAP_SERIAL, tCoupeLog);
  const lines = logsApres.map((x) => x.line);
  /* Tri par horodatage device : l'ordre du buffer n'est pas garanti une fois
   * filtré, et c'est cet ordre qui prouve la séquence close → retry → open. */
  const tri = logsApres.slice().sort((x, y) => x.t - y.t);
  const t0Log = tri.length ? tri[0].t : 0;
  const firstAt = (re) => {
    const x = tri.find((e) => re.test(e.line));
    return x ? x.t - t0Log : -1;
  };
  const tClose = firstAt(/WS_CLIENT_CLOSE/);
  /* Preuve device : on scrute les lignes au lieu de lire une fois (voir
   * `waitForLog`) — la ligne d'ouverture peut arriver après la reprise mesurée. */
  const ligneOpen = await waitForLog(CAP_SERIAL, tCoupeLog, /WS_CLIENT_OPEN/, 8000);
  const ligneResync = await waitForLog(CAP_SERIAL, tCoupeLog, /WS_RESYNC_SESSIONS/, 8000);
  const tOpen = ligneOpen ? ligneOpen.t - t0Log : -1;
  const tResync = ligneResync ? ligneResync.t - t0Log : -1;
  /* Deux mesures distinctes, à ne pas confondre :
   *  - `coupureMs` = close -> open : inclut toute la durée d'absence réseau ;
   *  - `repriseApresReseauMs` = commande wifi enable -> WS_CLIENT_OPEN : c'est
   *    la LATENCE de reprise, seule comparable au budget annoncé. */
  const tReprise = tOpen >= 0 && tClose >= 0 ? tOpen - tClose : -1;
  const repriseApresReseauMs = ligneOpen && tRestaurationLog !== null
    ? ligneOpen.t - tRestaurationLog : -1;
  ev.mesures.lignesReprise = {
    close: logsApres.filter((x) => /WS_CLIENT_CLOSE/.test(x.line)).map((x) => x.line),
    open: ligneOpen ? ligneOpen.line : null,
    resync: ligneResync ? ligneResync.line : null
  };
  ev.mesures.ordreLog = tri.map((e) => e.line)
    .filter((l) => /WS_CLIENT_CLOSE|WS_RETRY|WS_DIAL|WS_CLIENT_OPEN|WS_RESYNC|SYNC_PLEASE/.test(l));
  const presApres = JSON.parse(await cap(PRESENCE(sid), false).catch(() => "{}"));
  const tuilesApres = JSON.parse(await mas(TILE_PROBE, false));
  note("apres", { presenceCapture: presApres, tuiles: tuilesApres });

  ev.mesures.reprise = {
    presenceMs: tPresence,
    previewMs: tPreview,
    seqAvant: seqAvant,
    seqApres: seqApres,
    wsClientCloseOffsetMs: tClose,
    wsClientOpenOffsetMs: tOpen,
    wsResyncSessionsOffsetMs: tResync,
    /* close -> open : durée totale de la coupure + reprise. */
    repriseApresCloseMs: tReprise,
    /* wifi enable -> WS_CLIENT_OPEN : la latence de reprise au sens du budget. */
    repriseApresReseauMs: repriseApresReseauMs,
    lanRetourWifiMs: ev.mesures.lanRetourMs
  };
  console.log("APRES " + json(ev.mesures.reprise));
  ev.shots.push(shot(MASTER_SERIAL, "60-recon-3-apres.png"));
  ev.shots.push(shot(CAP_SERIAL, "60-recon-4-capture-apres.png"));

  /* ---------- 6. VERDICT ---------- */

  check(tOpen >= 0, "la Capture a rouvre son WS toute seule (WS_CLIENT_OPEN)");
  check(tResync >= 0,
    "le reSync de rattrapage a ete declenche par la reconnexion (WS_RESYNC_SESSIONS)"
    + (tResync < 0 ? " -> " + json(ev.mesures.lignesReprise) : ""));
  check(tOpen >= 0 && tResync >= tOpen,
    "l'ouverture precede le reSync (" + tOpen + " ms puis " + tResync + " ms) : "
    + "la presence est reconstruite PAR la reconnexion");
  check(tPresence >= 0, "le Master revoit la Capture presente apres retour du reseau");
  check(tPresence >= 0 && tPresence <= RECOVER_BUDGET_MS,
    "presence reconstruite en " + tPresence + " ms (<= " + RECOVER_BUDGET_MS + " ms)");
  check(repriseApresReseauMs >= 0 && repriseApresReseauMs <= RECOVER_BUDGET_MS,
    "reprise du WS " + repriseApresReseauMs + " ms apres le retour du reseau"
    + " (<= " + RECOVER_BUDGET_MS + " ms), Wi-Fi reassocie en " + ev.mesures.lanRetourMs + " ms");
  check(tPreview >= 0 && seqApres > seqAvant,
    "les previews repartent : seq " + seqAvant + " -> " + seqApres + " en " + tPreview + " ms");
  check(!!presApres.peers.find((d) => d === masSkills.did),
    "la Capture voit a nouveau la presence du Master");
  const slotApres = (JSON.parse(await mas(LIVE_PROBE, false)).slots || [])
    .find((s) => s.deviceId === capSkills.did);
  check(!!slotApres && slotApres.deviceId === capSkills.did,
    "le meme slot est conserve (aucun device ajoute/supprime)");

  /* Pas de double socket : une reconnexion = UNE ouverture. On relit le log
   * APRÈS les scrutes ci-dessus : compter sur la première lecture donnait « 0 »
   * alors que l'ouverture venait d'arriver (la console WebVerse est transmise à
   * logcat avec un décalage). Un compteur faux dans une preuve est pire
   * qu'un compteur absent. */
  const logsFinal = consoleSince(CAP_SERIAL, tCoupeLog);
  const opensApres = logsFinal.filter((x) => /WS_CLIENT_OPEN/.test(x.line)).length;
  const closesApres = logsFinal.filter((x) => /WS_CLIENT_CLOSE/.test(x.line)).length;
  ev.mesures.ouverturesApresCoupure = { opens: opensApres, closes: closesApres };
  check(opensApres >= 1 && opensApres <= 2,
    "une seule reconnexion physique, pas de rafale : " + opensApres
    + " WS_CLIENT_OPEN pour " + closesApres + " fermetures");

  /* ---------- 7. arrêt du REC + preuves ---------- */

  /* Le STOP global est hors périmètre (J10) : on arrete par le chemin local de
   * la Capture, sans toucher au plan ni au START. Aucun MP4 n'est récupéré. */
  const stopRes = await cap('MultiCamStartService.stopLocal("smoke_reconnexion").then(function(){'
    + 'return "STOP_ENVOYE"},function(e){return "STOP_KO "+e})', true);
  console.log("STOP_LOCAL " + stopRes);
  await sleep(3000);
  const recApres = JSON.parse(await cap(CAP_REC, false));
  note("rec-apres", recApres);
  check(recApres.recording === false, "l'enregistrement local est bien arrêté sur la Capture");

  const keptCap = grabConsole(CAP_SERIAL, "capture");
  const keptMas = grabConsole(MASTER_SERIAL, "master");
  fs.writeFileSync(path.join(OUT, "reconnect-smoke.json"), JSON.stringify({
    devices: { capture: capSkills, master: masSkills, capEndpoint, masEndpoint },
    sessionId: sid,
    coupesReseau: { cutMs: CUT_MS, recoverBudgetMs: RECOVER_BUDGET_MS },
    mesures: ev.mesures,
    verifications: ev.checks,
    sondes: ev.probes,
    captures: ev.shots,
    aucunMP4Recupere: true,
    dureeMs: Date.now() - tStart
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(OUT, "reconnect-smoke.log"), logLines.join("\n") + "\n");
  console.log("PROOF " + path.relative(HERE, path.join(OUT, "reconnect-smoke.json")));
  console.log("CONSOLE capture=" + keptCap.length + " master=" + keptMas.length + " lignes");
  console.log("=== VERDICT: OK (" + ev.checks.length + " verifications, aucun MP4 recupere) ===");
}

main().then(() => process.exit(0)).catch((e) => {
  console.log("=== VERDICT: ECHEC ===");
  console.log("ECHEC " + (e && e.message));
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "reconnect-smoke-ECHEC.txt"),
      (e && e.stack ? e.stack : String(e)) + "\n\n"
      + "mesures=" + json(ev.mesures) + "\n"
      + "verifications=" + json(ev.checks) + "\n");
    for (const serial of [CAP_SERIAL, MASTER_SERIAL]) { try { grabConsole(serial, serial); } catch (x) {} }
    /* Le Wi-Fi doit TOUJOURS être rendu : un smoke en échec ne doit pas laisser
     * un device hors réseau pour la suite. */
    adbTry(["-s", CAP_SERIAL, "shell", "svc", "wifi", "enable"]);
  } catch (x) {}
  process.exit(1);
});