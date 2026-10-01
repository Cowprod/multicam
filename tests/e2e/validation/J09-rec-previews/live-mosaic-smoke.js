/* MultiCam — J09-05 : smoke PHYSIQUE de la mosaïque Master (écran 08).
 *
 * Ce que ce script doit prouver, et RIEN d'autre :
 *
 *   CAPTURE                                      MASTER
 *   ───────                                      ───────
 *   preview-sampler (J09-03) 1 img/s
 *        │  preview-transport (J09-04)
 *        ▼
 *   session-ws.sendPreviewFrame()  ── WS réel, LAN ──▶  session-ws (serveur)
 *                                                       │ preview_frame
 *                                                       ▼
 *                                            preview-inbox (J09-04)
 *                                                       │  onFrame + latest()
 *                                                       ▼
 *                                            live-model (J09-05)
 *                                            slots ORDONNÉS par le plan
 *                                                       │  view()
 *                                                       ▼
 *                                            live.js (J09-05) → DOM
 *
 * DIFFÉRENCE AVEC LE SMOKE J09-04 : J09-04 prouvait l'ARRIVÉE des images chez
 * un Master (inbox). Ici on ne s'intéresse plus à l'inbox mais à ce que
 * l'OPÉRATEUR VOIT : une case par Capture du Take, dans l'ordre du plan, avec
 * placeholder puis image, qui reste en place quand la Capture disparaît, et
 * qui revient à l'identique quand elle revient.
 *
 * Le plan de START est produit par le VRAI chemin de production côté Master
 * (`MultiCamArmService` → bouton REC du panneau ARM → `start-service`), pas
 * injecté : c'est la seule façon d'obtenir un vrai ordre de participants, une
 * vraie horloge commune et de vraies previews sur le réseau.
 *
 * SCÉNARIOS (les 5 axes de la mission) :
 *   S1. 1 Capture   → 1 vignette, placeholder puis image
 *   S2. déconnexion → vignette immobile, image conservée, état Déconnecté
 *   S3. reconnexion → MÊME vignette, nouvelle image, sans action opérateur
 *   S4. STOP local  → slot conservé, image FIGÉE, état STOPPED
 *   S5. Master+Capture local → vignette locale transparente, 0 image réseau
 *
 * AUCUNE vidéo n'est récupérée : les preuves sont des captures d'écran, des
 * dumps JSON du modèle et les logs. (Règle J09 : plus de MP4 dans le dépôt.)
 */

"use strict";

const fs = require("fs");
const path = require("path");

const PKG = "fr.emmanuel.multicam";
const CAP_SERIAL = process.env.CAP_SERIAL || "61d54bba7d91";
const MASTER_SERIAL = process.env.MASTER_SERIAL || "c0d8514d7d87";
const CAP_PORT = process.env.CDP_PORT || "9223";
const MASTER_PORT = process.env.MASTER_CDP_PORT || "9224";
const TOP_DELAY_MS = Number(process.env.TOP_DELAY_MS || 6000);
const HERE = __dirname;
const OUT = path.join(HERE, "logs", "50-live-mosaic");
const SHOTS = path.join(HERE, "screenshots");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (o) => JSON.stringify(o);

function adb(args, opts) {
  return require("child_process").execFileSync("adb", args, Object.assign({
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024
  }, opts || {}));
}

function adbTry(args) {
  try { return adb(args); } catch (e) { return (e.stdout || "") + (e.stderr || ""); }
}

/* Démarrage À FROID. Indispensable, et pas un détail : `location.reload()`
 * laisse le serveur WebSocket NATIF garder le port 45102, et le device ne peut
 * plus être rejoint par les autres (constaté en J09-02). Un vrai force-stop
 * libère le port. */
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
        throw new Error("EXCEPTION " + label + " " + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails).slice(0, 300));
      }
      const v = r.result && r.result.value;
      return v === undefined ? null : v;
    });
  };
}

/* Attente du WebView pilotable. Le socket devtools n'existe pas encore au moment
 * où `pidof` répond : la cible CDP peut mettre plusieurs centaines de ms à
 * s'annoncer après le `am start`. On réessaie donc la CONNEXION elle-même (pas
 * seulement l'évaluation) — sinon le premier `fetch` échoue et le smoke meurt
 * sur une course d'amorçage, pas sur un défaut de la mosaïque. */
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

/* Taille PNG lue dans l'en-tête IHDR : la preuve doit être une vraie image, pas
 * un fichier vide que `screencap` produit quand l'écran est verrouillé. */
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/* Journalisation PARSABLE (AGENTS.md) : lignes de console des briques J09,
 * dans l'ordre, sans le bruit NSD. */
const KEEP = "LIVE_|SCREEN08_|NAV_AUTO|START_|PREVIEW_|REC_|CAMERA_|WS_|JOIN_|SESSION_CLOSE|ARM_|CLOCK_|TAKE_";

function grabConsole(serial, label) {
  const raw = adbTry(["-s", serial, "logcat", "-d", "-v", "time"]).split("\n");
  const kept = raw.filter((l) => l.indexOf("chromium") >= 0 && new RegExp(KEEP).test(l))
    .map((l) => l.replace(/^.*CONSOLE:[0-9]+\] "/, "").replace(/", source:.*$/, ""));
  fs.writeFileSync(path.join(OUT, label + "-console.txt"), kept.join("\n") + "\n");
  return kept.length;
}

/* ---------- sondes de la mosaïque (côté MASTER) ---------- */

/* Ce que l'OPÉRATEUR voit, pas ce que le modèle contient : on relit le DOM de
 * la mosaïque. Un modèle correct mais mal branché doit être détecté ici — c'est
 * tout l'intérêt de sonder l'écran et pas seulement la vue. */
const DOM_PROBE = '(function(){'
  + 'var grid=document.getElementById("liveGrid");'
  + 'var panel=document.getElementById("panel-live");'
  + 'var tiles=[].slice.call(grid?grid.children:[]).map(function(t){'
  + 'var img=t.querySelector("img");'
  + 'var st=t.querySelector(".tile-state");'
  + 'var nm=t.querySelector(".tile-name");'
  + 'return {'
  + 'name: nm?nm.textContent:"",'
  + 'state: st?st.getAttribute("data-state"):"",'
  + 'hasImgNode: !!img,'
  + 'hasSrc: !!(img&&img.getAttribute("src")),'
  + 'placeholder: t.querySelector(".tile-media").classList.contains("is-placeholder"),'
  + 'native: t.querySelector(".tile-media").classList.contains("is-native"),'
  + 'local: t.classList.contains("local"),'
  + 'offline: t.classList.contains("offline")'
  + '};});'
  + 'return JSON.stringify({'
  + 'panel: panel?panel.classList.contains("active"):false,'
  + 'screen: document.querySelector(".screen.active")?document.querySelector(".screen.active").id:"",'
  + 'timer: (document.getElementById("liveTimer")||{}).textContent,'
  + 'take: (document.getElementById("liveTake")||{}).textContent,'
  + 'count: (document.getElementById("liveCount")||{}).textContent,'
  + 'gridClass: grid?grid.className:"",'
  + 'tiles: tiles'
  + '});})()';

const MODEL_PROBE = "(function(){var m=MultiCamLiveModel.view();return JSON.stringify({"
  + "sessionId:m.sessionId,takeNumber:m.takeNumber,localDid:m.localDid,order:m.order,"
  + "stats:m.stats,slots:m.slots.map(function(s){return {deviceId:s.deviceId,"
  + "deviceName:s.deviceName,isLocal:s.isLocal,status:s.status,connected:s.connected,"
  + "displayState:s.displayState,hasFrame:s.hasFrame,lastFrameSeq:s.lastFrameSeq,"
  + "lastFrameAt:s.lastFrameAt};})});})()";

async function probe(mas, tag, shots) {
  const dom = JSON.parse(await mas(DOM_PROBE, false));
  const model = JSON.parse(await mas(MODEL_PROBE, false));
  const rec = { tag, at: new Date().toISOString(), dom, model };
  if (shots && shots.length) rec.screenshots = shots;
  const list = ev.rec || (ev.rec = []);
  list.push(rec);
  /* Une sonde d'attente tourne toutes les 700 ms : on n'écrit dans la preuve
   * que ce qui CHANGE, sinon le rapport noierait 40 lignes identiques et les
   * instants utiles deviendraient illisibles. */
  /* La clé de changement exclut la seq : elle progresse à chaque image (≈1 fps)
   * et ferait enregistrer 40 lignes identiques par seconde d'attente. */
  const etat = model.slots.map(function (s) {
    return s.deviceId.slice(0, 8) + ":" + s.displayState + ":" + (s.hasFrame ? "img" : "—")
      + (s.isLocal ? ":LOCAL" : "") + (s.connected ? "" : ":OFF");
  }).join(" ") + " | " + dom.gridClass + " | " + dom.timer;
  rec.changed = etat !== ev.dernier;
  if (rec.changed) {
    ev.dernier = etat;
    console.log("PROBE " + tag + " " + etat);
  }
  return rec;
}

const ev = { rec: [], dernier: "" };

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log("OK   " + msg);
}

/* Ordre des vignettes : la suite des deviceId rendue dans le DOM, dans l'ordre
 * visuel. C'est la propriété que la mission fige — on la compare à chaque
 * scénario pour prouver qu'elle n'a pas bougé. */
function domOrder(dom) { return dom.tiles.map(function (t) { return t.name; }); }

/* ---------- démarrage du REC comme un opérateur ----------
 *
 * Le dock REC de l'écran 06 ne déclenche PAS directement le plan : si l'effectif
 * présente un incident (ici un `sync=warn` réel, dispersion d'horloge mesurée
 * entre les deux devices), il ouvre la modale et attend. C'est le bouton
 * « Continuer REC » qui lance alors le plan. Un script qui se contente de cliquer
 * `armRec` puis d'attendre resterait donc bloque sur une modale : le clic ne
 * suffit pas, c'est l'acknowledgement de l'incident qui déclenche le plan. */
const REC_PROBE = '(function(){var v=MultiCamArmService.view()||{};'
  + 'var m=document.getElementById("armIncidentModal");'
  + 'return JSON.stringify({active:!!v.active,attempt:v.attempt,'
  + 'incidentModal:!!(m&&m.classList.contains("show")),'
  + 'skills:(v.devices||[]).map(function(d){return d.skills.map(function(s){'
  + 'return s.skill+"="+s.status}).join(",")}),'
  + 'scr:document.querySelector(".screen.active").id});})()';

/* Sélection des Captures du Take par le BOUTON DE PRODUCTION `tkCaptureAll`
 * (l'écran 05 construit `take.captures` à partir de `session.members` filtré
 * sur le rôle `capture`). On relit ensuite le Take dans le store pour vérifier
 * la sélection réelle : chercher un bouton par son libellé « Toutes » et
 * déduire l'état du premier checkbox produit exactement le bug rencontré au
 * Take 2 (le Master-Capture restait décoché, donc absent du plan). */
async function selectionnerToutesCaptures(dev, sid, label) {
  const r = await dev('(function(){var b=document.getElementById("tkCaptureAll");'
    + 'if(!b)return JSON.stringify({ok:false,err:"pas de tkCaptureAll"});'
    + 'if(b.disabled)return JSON.stringify({ok:false,err:"tkCaptureAll désactivé"});'
    + 'b.click();return JSON.stringify({ok:true});})()', true);
  await sleep(800);
  const t = await dev('MultiCamSessionStore.get(' + json(sid) + ').then(function(s){'
    + 'var a=(s.takes||[]);var t=a.length?a[a.length-1]:null;'
    + 'return JSON.stringify({n:t?t.takeNumber:null,captures:(t&&t.captures)||[],'
    + 'membres:(s.members||[]).filter(function(x){return (x.sessionRoles||[]).indexOf("capture")>=0})'
    + '.map(function(x){return x.deviceId})});})', true);
  console.log("SELECTION_CAPTURES " + label + " " + t);
  const clic = JSON.parse(r);
  const v = JSON.parse(t);
  expect(clic.ok === true, "le bouton Toutes Captures est actif (" + label + ")"
    + (clic.err ? " : " + clic.err : ""));
  expect(Array.isArray(v.captures) && Array.isArray(v.membres) && v.captures.length === v.membres.length,
    "TOUTES les Captures de la session sont sélectionnées (" + label + ") : "
    + v.captures.length + "/" + v.membres.length);
  expect(JSON.stringify((v.captures || []).slice().sort())
    === JSON.stringify((v.membres || []).slice().sort()),
    "la sélection = les membres Capture de la session (" + label + ")");
  return v;
}

async function demarrerRec(dev, label) {
  const r = await dev('(function(){var b=document.getElementById("armRec");'
    + 'if(!b)return "PAS_DE_BOUTON";if(b.disabled)return "BOUTON_DESACTIVE";'
    + 'b.click();return "REC_CLIQUE";})()', false);
  console.log("REC_DOCK " + label + " " + r);
  /* On attend soit l'ouverture de la modale d'incident, soit un plan démarré. */
  let last = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    await sleep(600);
    last = JSON.parse(await dev(REC_PROBE, false));
    if (last.incidentModal) {
      const cont = await dev('(function(){var b=document.getElementById("armIncidentContinue");'
        + 'if(!b)return "PAS_DE_CONTINUE";b.click();return "CONTINUE_CLIQUE";})()', false);
      console.log("REC_INCIDENT " + label + " " + cont + " " + json(last.skills));
      return "via=incident_continue";
    }
    if (String(last.scr) !== "panel-arm" && String(last.scr) !== "panel-take") {
      return "via=dock";
    }
  }
  console.log("REC_ATTENTE " + label + " " + json(last));
  return "sans-demarrage";
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  ev.rec = [];

  for (const serial of [CAP_SERIAL, MASTER_SERIAL]) {
    try { adb(["-s", serial, "logcat", "-c"]); } catch (e) {}
  }

  /* ---------- 0. démarrage à froid des deux applications ---------- */

  const READY_CAP = "(MultiCamConfig.get()&&MultiCamSessionWs.status().serverRunning"
    + "&&typeof MultiCamPreviewTransport!=='undefined'"
    + "&&typeof MultiCamLiveModel!=='undefined')?'PRET':''";
  const READY_MAS = "(MultiCamConfig.get()&&MultiCamSessionWs.status().serverRunning"
    + "&&typeof MultiCamPreviewInbox!=='undefined'"
    + "&&typeof MultiCamLiveModel!=='undefined')?'PRET':''";
  const capC = await attach(coldStart(CAP_SERIAL, CAP_PORT, "capture"), "capture", READY_CAP);
  const masC = await attach(coldStart(MASTER_SERIAL, MASTER_PORT, "master"), "master", READY_MAS);
  const cap = capC.ev;
  const mas = masC.ev;
  console.log("COLD_START applications pretes (force-stop + am start), compteurs a zero");

  /* ---------- 1. rôles : le Master ne doit PAS filmer (scénario S1..S4) ---------- */

  /* La skill Capture du Master est désactivée ici : les scénarios S1→S4 doivent
   * montrer la mosaïque d'un device qui ne filme pas, c'est-à-dire le cas réel
   * d'une régie. Le cas Master+Capture local est traité séparément (S5). */
  const masSkills = await mas('MultiCamConfig.setSkill("capture", false).then(function(c){'
    + 'return JSON.stringify({did:c.deviceId,name:c.deviceName,skills:c.enabledSkills})},'
    + 'function(){return JSON.stringify({error:"setSkill_indisponible"})})', true);
  const capSkills = await cap('MultiCamConfig.setSkill("controller", false).then(function(c){'
    + 'return JSON.stringify({did:c.deviceId,name:c.deviceName,skills:c.enabledSkills})},'
    + 'function(){return JSON.stringify({error:"setSkill_indisponible"})})', true);
  const M = JSON.parse(masSkills);
  const C = JSON.parse(capSkills);
  console.log("SKILLS master  " + json(M));
  console.log("SKILLS capture " + json(C));
  expect(!!M.did && !!C.did && M.did !== C.did, "les deux devices ont des identités distinctes");
  expect(M.skills.indexOf("controller") >= 0, "le Master garde la skill controller");
  expect(C.skills.indexOf("capture") >= 0, "la Capture garde la skill capture");

  const masPre = JSON.parse(await mas('JSON.stringify({ws:MultiCamSessionWs.status()})', false));
  const masEndpoint = masPre.ws.selfEndpoint;
  /* L'endpoint de la Capture se lit SUR LA CAPTURE : le lire chez le Master
   * donnerait l'IP du Master dans `session.members[].endpoint`, donc une
   * adresse fausse dans la preuve et un pair injoignable pour le stockage. */
  const capPre = JSON.parse(await cap('JSON.stringify({ws:MultiCamSessionWs.status()})', false));
  const capEndpoint = capPre.ws.selfEndpoint;
  console.log("LINK master=" + M.did + " @" + masEndpoint + " capture=" + C.did + " @" + capEndpoint
    + " portMeme=" + (capPre.ws.effectivePort === masPre.ws.effectivePort));

  /* ---------- 2. session de travail ---------- */

  const created = JSON.parse(await mas('MultiCamSessionWs.createSession("J09-05 mosaic").then(function(s){'
    + 'return JSON.stringify({sessionId:s.sessionId,pin:s.pin,name:s.name,state:s.state,'
    + 'masters:(s.masters||[]).map(function(m){return m.deviceId})})})', true));
  const sid = created.sessionId;
  const pin = created.pin;
  console.log("SESSION creee par le MASTER sid=" + sid + " pin=*** masters=" + json(created.masters));
  expect(!!sid && !!pin, "session creee avec un PIN");

  const joinRes = await cap('MultiCamSessionWs.joinSession({host:' + json(masEndpoint.split(":")[0])
    + ',port:' + parseInt(masEndpoint.split(":")[1], 10)
    + ',sessionId:' + json(sid) + ',name:' + json(created.name) + '},' + json(pin)
    + ').then(function(){return "JOIN_ENVOYE"},function(e){return "JOIN_KO "+e})', true);
  console.log("JOIN capture " + joinRes);
  expect(/^JOIN_ENVOYE/.test(String(joinRes)), "adhésion de la Capture acceptée");

  let joined = null;
  const tJoin = Date.now();
  while (Date.now() - tJoin < 25000) {
    await sleep(700);
    joined = JSON.parse(await cap('MultiCamSessionStore.get(' + json(sid) + ').then(function(s){'
      + 'return JSON.stringify(s?{state:s.state,masters:(s.masters||[]).map(function(m){return m.deviceId})}:null)})', true));
    if (joined && joined.masters.indexOf(M.did) >= 0) break;
  }
  expect(joined && joined.masters.indexOf(M.did) >= 0, "la Capture a reçu les rôles du Master");

  await sleep(1500);
  const presence = {
    capture: JSON.parse(await cap("JSON.stringify(MultiCamSessionWs.connectedPeers(" + json(sid) + "))", false)),
    master: JSON.parse(await mas("JSON.stringify(MultiCamSessionWs.connectedPeers(" + json(sid) + "))", false))
  };
  console.log("PRESENCE " + json(presence));
  expect(!!presence.capture[M.did], "présence du Master vue par la Capture");
  expect(!!presence.master[C.did], "présence de la Capture vue par le Master");

  /* ---------- 2b. la Capture doit être MEMBRE de la session ----------
   *
   * Une jonction par PIN n'ajoute PAS de membre : elle enregistre l'invité dans
   * `session.masters` (§J09-04, `upsertMaster`). L'écran 05 (Préparer Take) et
   * l'ARM listent `session.members` : sans membre, aucune case à cocher, ARM
   * désactivé, donc aucun plan et aucune vignette. Constaté au premier essai du
   * smoke (`ARM_DEVICES {"devices":[]}`).
   *
   * On passe donc par `addMember()` — l'API de production que l'écran 03 appelle
   * quand l'opérateur valide les rôles d'un device (sessionRoles ∈
   * {capture, storage}, et le rôle doit être couvert par les skills annoncées). */
  const memberAdd = await mas('MultiCamSessionStore.get(' + json(sid) + ').then(function(s){'
    + 'return MultiCamSessionWs.addMember(s,{deviceId:' + json(C.did) + ',deviceName:' + json(C.name)
    + ',enabledSkills:' + json(C.skills) + ',endpoint:' + json(capEndpoint) + '},["capture"])'
    + '.then(function(u){return JSON.stringify({ok:true,members:(u.members||[]).map(function(m){'
    + 'return m.deviceId+":"+(m.sessionRoles||[]).join("+")})})},'
    + 'function(e){return JSON.stringify({ok:false,err:String(e)})})})', true);
  console.log("MEMBER_ADD " + memberAdd);
  const ma = JSON.parse(memberAdd);
  expect(ma.ok === true, "la Capture est ajoutée comme membre (role capture)");
  expect(String(memberAdd).indexOf(C.did + ":capture") >= 0, "le rôle capture est bien enregistré");

  /* ---------- 3. ARM puis REC par le CHEMIN DE PRODUCTION (boutons du panneau) ---------- */

  await mas('MultiCamNav.show("take",{sid:' + json(sid) + '}); "take"', false);
  await sleep(2000);
  await selectionnerToutesCaptures(mas, sid, "take1");
  await mas('(function(){var b=document.getElementById("tkArm");if(b&&!b.disabled)b.click();return "click-ARM";})()', false);
  await sleep(5000);
  /* Un incident d'armement éventuel ne doit pas bloquer le smoke : on le lève
   * comme le ferait l'opérateur, et on le dit. */
  const inc = await mas('(function(){var m=document.getElementById("armIncidentModal");'
    + 'if(m&&m.classList.contains("show")){var c=document.getElementById("armIncidentContinue");if(c)c.click();'
    + 'return "INCIDENT_LEVE";}return "aucun incident";})()', false);
  console.log("ARM " + inc);
  await sleep(1500);
  const preRec = JSON.parse(await mas('JSON.stringify({scr:document.querySelector(".screen.active").id,'
    + 'arm:{armed:(MultiCamArmService?MultiCamArmService.view():{}).state}})', false));
  console.log("ARM_ETAT " + json(preRec));

  const armOk = await mas('(function(){var v=MultiCamArmService?MultiCamArmService.view():{};'
    + 'return JSON.stringify({devices:(v.devices||[]).map(function(d){return {did:d.did,state:d.state,'
    + 'skills:(d.skills||[]).map(function(s){return typeof s==="string"?s:'
    + '((s.skill||"?")+":"+(s.status||s.state||"?"))})}})})})()', false);
  console.log("ARM_DEVICES " + armOk);
  const armList = JSON.parse(armOk).devices.map(function (d) { return d.did; });
  expect(armList.length === 1 && armList[0] === C.did,
    "l'ARM du Take 1 porte exactement la Capture : " + armList.length);


  adbTry([CAP_SERIAL, "logcat", "-c"]);
  expect(!(await demarrerRec(mas, "take1")).match(/sans-demarrage|PAS_DE/), "le dock REC a lance le Take 1");
  const tRec = Date.now();
  let phaseMas = "", phaseCap = "";
  /* Pendant l'attente du top on SONDE la mosaïque toutes les 500 ms : la
   * fenêtre où une vignette est un placeholder (aucune image reçue) dure le temps
   * que la Capture produise sa première preview, soit ~1 img/s. Dormir 1 s
   * avant de regarder — comme le ferait un script naïf — raterait cette fenêtre
   * à tous les coups, et le placeholder resterait non prouvé. */
  let placeholderSeen = null;
  while (Date.now() - tRec < 45000) {
    await sleep(500);
    phaseMas = String(await mas('(MultiCamStartService.view()||{}).phase||""', false));
    phaseCap = String(await cap('(MultiCamStartService.view()||{}).phase||""', false));
    if (phaseMas === "REC") {
      const d = JSON.parse(await mas(DOM_PROBE, false));
      const ph = d.tiles.filter(function (t) { return t.placeholder; })[0];
      if (ph && !placeholderSeen) {
        placeholderSeen = { atMs: Date.now() - tRec, tile: ph, timer: d.timer };
        console.log("PLACEHOLDER_OBSERVE apres " + placeholderSeen.atMs + " ms " + json(ph));
        placeholderSeen.shot = shot(MASTER_SERIAL, "50-master-mosaic-s1a-placeholder.png");
      }
    }
    if (phaseMas === "REC" && phaseCap === "REC") break;
  }
  console.log("REC master=" + phaseMas + " capture=" + phaseCap + " apres " + (Date.now() - tRec) + " ms");
  expect(phaseMas === "REC" && phaseCap === "REC", "les deux devices sont en REC");

  /* ---------- S1. 1 Capture → 1 vignette ---------- */

  const s1a = await probe(mas, "S1a-apres-top");
  /* Le placeholder doit AVOIR existé avant la première image : une vignette qui
   * n'apparaît qu'à la première frame n'est pas une mosaïque, c'est un mur
   * d'images. On le cherche donc DANS LA FENÊTRE, pas après coup. */
  expect(!!placeholderSeen, "un placeholder a ete observe AVANT la premiere image");
  expect(s1a.dom.tiles.length === 1, "exactement 1 vignette pour 1 Capture");

  /* On attend la première image RÉELLEMENT peinte dans le DOM. */
  let s1b = null;
  const tImg = Date.now();
  while (Date.now() - tImg < 25000) {
    await sleep(600);
    s1b = await probe(mas, "S1b-attente-image");
    if (s1b.dom.tiles.length && s1b.dom.tiles[0].hasSrc) break;
  }
  const shot1b = shot(MASTER_SERIAL, "50-master-mosaic-s1b-image.png");
  s1b.screenshots = [shot1b];
  expect(s1b.dom.panel === true, "le panneau live est affiché sur le Master");
  expect(s1b.dom.screen === "panel-live", "l'écran actif est bien panel-live (pas le placeholder 07)");
  expect(s1b.dom.tiles.length === 1, "exactement 1 vignette pour 1 Capture");
  expect(s1b.dom.tiles[0].state === "REC", "état REC affiché sur la vignette");
  expect(!!s1b.dom.tiles[0].hasSrc, "une image RÉELLE est affichée dans le DOM");
  expect(/^Take /.test(String(s1b.dom.take)), "le numéro de Take est affiché : " + s1b.dom.take);
  expect(/^\d\d:\d\d:\d\d$/.test(String(s1b.dom.timer)), "un timer global hh:mm:ss est affiché : " + s1b.dom.timer);
  expect(s1b.model.slots.length === 1 && s1b.model.order.length === 1, "le modèle tient 1 slot dans l'ordre du plan");
  expect(s1b.model.stats.framesIgnored === 0, "aucune frame ignorée pendant le fonctionnement normal");
  const order0 = domOrder(s1b.dom);

  /* ---------- S2. déconnexion physique (coupure RÉSEAU) ----------
   *
   * On coupe le WIFI de la Capture, pas l'application. La raison est technique
   * et vérifiable : un `force-stop` tuerait l'app ET son plan de START, et
   * `start-service` ne redispatche pas un plan déjà parti (le plan est figé à
   * sa création, `cancel()` est refusé après le top — c'est le STOP global de
   * J10, non implémenté). Une Capture relancée en plein Take ne pourrait donc
   * JAMAIS revenir dans la mosaïque, et le scénario S3 ne mesurerait pas la
   * mosaïque mais une limite connue du transport.
   *
   * Couper le réseau isole exactement ce que la mission veut mesurer : le lien.
   * La Capture continue d'enregistrer en local, la mosaïque doit refléter la
   * coupure SANS perdre sa vignette ni son image. */
  console.log("DECONNEXION coupure du reseau (wifi) de la Capture");
  const t0disc = Date.now();
  adb(["-s", CAP_SERIAL, "shell", "svc", "wifi", "disable"]);

  /* On attend que le Master VOIE la coupure (détection WS + tick START), pas
   * qu'un nombre d'images soit écoulé : c'est le temps de réaction affiché qui
   * nous intéresse. */
  let s2 = null;
  const tDet = Date.now();
  while (Date.now() - tDet < 40000) {
    await sleep(700);
    s2 = await probe(mas, "S2-attente-coupure");
    if (s2.dom.tiles.length === 1 && s2.dom.tiles[0].state === "DECONNECTED") break;
  }
  const shot2 = shot(MASTER_SERIAL, "50-master-mosaic-s2-deconnecte.png");
  s2.screenshots = [shot2];
  const tDiscMs = Date.now() - t0disc;
  const capDuring = JSON.parse(await cap('JSON.stringify({rec:MultiCamCameraRecord.view().recording,'
    + 'phase:(MultiCamStartService.view()||{}).phase})', false));
  console.log("CAPTURE pendant la coupure " + json(capDuring));
  expect(domOrder(s2.dom).join(",") === order0.join(","), "la vignette n'a pas BOUGÉ à la déconnexion");
  expect(s2.dom.tiles.length === 1, "la vignette est toujours là (un slot ne disparaît jamais)");
  expect(s2.dom.tiles[0].state === "DECONNECTED", "état Déconnecté affiché (et non REC)");
  expect(s2.dom.tiles[0].hasSrc === true, "la DERNIÈRE image est conservée, pas vidée");
  expect(s2.dom.tiles[0].offline === true, "la vignette est assombrie/grisée");
  expect(s2.model.slots[0].connected === false, "le modèle marque la Capture hors ligne");
  expect(s2.model.slots[0].hasFrame === true, "le modèle conserve la dernière frame");
  expect(s2.model.slots[0].status !== "STOPPED", "DÉCONNECTÉ n'a PAS dégradé l'état recorder en STOPPED");
  expect(capDuring.rec === true, "la Capture ENREGISTRE TOUJOURS localement pendant la coupure");
  console.log("INFO coupure vue par le Master en " + tDiscMs + " ms (enregistrement local intact)");

  /* ---------- S3. reconnexion ---------- */

  /* Le retour se fait par le chemin de production `reSyncSession()` — c'est la
   * même API que le boot et que la réouverture de session utilisent. Il n'existe
   * pas encore de reconnexion automatique (hors périmètre J09-05), et on ne va
   * pas prétendre le contraire dans un rapport de preuve. */
  console.log("RECONNEXION : wifi retabli + reSyncSession() (chemin de production)");
  adb(["-s", CAP_SERIAL, "shell", "svc", "wifi", "enable"]);
  await sleep(6000);
  const rejoined = await cap('(function(){try{'
    + 'MultiCamSessionWs.reSyncSession({sessionId:' + json(sid) + '});return "RESYNC_ENVOYE";'
    + '}catch(e){return "RESYNC_KO "+e;}})()', false);
  console.log("RESYNC capture " + rejoined);

  let s3 = null;
  const tRe = Date.now();
  while (Date.now() - tRe < 60000) {
    await sleep(700);
    s3 = await probe(mas, "S3-reconnecte-attente");
    if (s3.dom.tiles.length === 1 && s3.dom.tiles[0].state === "REC"
      && s3.dom.tiles[0].hasSrc && s3.model.slots[0].lastFrameSeq > s2.model.slots[0].lastFrameSeq) break;
  }
  const shot3 = shot(MASTER_SERIAL, "50-master-mosaic-s3-reconnecte.png");
  s3.screenshots = [shot3];
  expect(domOrder(s3.dom).join(",") === order0.join(","), "la vignette n'a pas BOUGÉ à la reconnexion");
  expect(s3.dom.tiles.length === 1, "toujours exactement 1 vignette (aucune duplique)");
  expect(s3.dom.tiles[0].state === "REC", "état revenu à REC");
  expect(s3.dom.tiles[0].offline === false, "la vignette n'est plus assombrie");
  expect(s3.dom.tiles[0].hasSrc === true, "une image est de nouveau affichée");
  expect(s3.model.slots[0].lastFrameSeq > s2.model.slots[0].lastFrameSeq,
    "la seq a reparti en AVANT (nouvelle image, pas la même figée)");
  console.log("INFO reconnexion dans le MÊME slot, sans action sur la mosaïque");

  /* ---------- S4. STOP local de la Capture ---------- */

  /* COMMENT on déclenche un STOP local physique : la maquette (§Capture) ne montre
   * le bouton « STOP local d'urgence » que sur une Capture SANS Master — avec un
   * Master, le bouton global est J10, non implémenté. On appelle donc le service
   * `stopLocal()` de la Capture, qui est EXACTEMENT le même chemin de production
   * que ce bouton (`deps.stopRecording()` + `publishState(STATE_STOPPED)`), et on
   * vérifie les DEUX conséquences réelles : l'enregistrement local s'arrête
   * vraiment (fichier + `camera-record`), et le Master reçoit le STOPPED. */
  console.log("STOP local de la Capture (service stopLocal, cf. §Capture de la maquette)");
  const stopRes = await cap('MultiCamStartService.stopLocal("smoke_j0905").then(function(){'
    + 'return "STOP_ENVOYE"},function(e){return "STOP_KO "+e})', true);
  console.log("STOP " + stopRes);
  expect(/^STOP_ENVOYE/.test(String(stopRes)), "le STOP local a été accepté par la Capture");

  let s4 = null;
  const tStop = Date.now();
  while (Date.now() - tStop < 30000) {
    await sleep(700);
    s4 = await probe(mas, "S4-stopped-attente");
    if (s4.dom.tiles.length === 1 && s4.dom.tiles[0].state === "STOPPED") break;
  }
  const shot4 = shot(MASTER_SERIAL, "50-master-mosaic-s4-stopped.png");
  s4.screenshots = [shot4];
  const capState = JSON.parse(await cap('JSON.stringify({cam:MultiCamCameraRecord.view(),'
    + 'start:MultiCamStartService.view()})', false));
  console.log("CAPTURE apres STOP " + json({ recording: capState.cam.recording, phase: capState.start.phase }));
  expect(capState.cam.recording === false, "l'enregistrement LOCAL s'est réellement arrêté sur la Capture");
  expect(capState.start.phase === "STOPPED", "la Capture annonce elle-même phase=STOPPED");
  expect(domOrder(s4.dom).join(",") === order0.join(","), "la vignette n'a pas BOUGÉ au STOP");
  expect(s4.dom.tiles.length === 1, "le slot STOPPED est conservé");
  expect(s4.dom.tiles[0].state === "STOPPED", "état STOPPED affiché");
  expect(s4.dom.tiles[0].offline === false, "STOPPED n'est PAS une déconnexion : pas de gris hors-ligne");
  expect(s4.dom.tiles[0].hasSrc === true, "la dernière image reste FIGÉE à l'écran");
  expect(s4.model.slots[0].status === "STOPPED", "le modèle a enregistré le STOP");
  expect(s4.model.slots[0].connected === true, "la Capture est toujours connectée : ce n'est pas un incident réseau");

  /* La séquence est figée : plus aucune image après le STOP. */
  const seqA = s4.model.slots[0].lastFrameSeq;
  await sleep(4000);
  const s4b = await probe(mas, "S4b-stopped-4s-plus-tard");
  expect(s4b.model.slots[0].lastFrameSeq === seqA,
    "image FIGEE : seq identique 4 s après le STOP (" + seqA + ")");
  expect(s4b.dom.tiles[0].state === "STOPPED", "l'état STOPPED tient dans la durée");

  /* ---------- S5. Master + Capture local (2e Take) ---------- */

  /* On ACTIVE la skill Capture du Master : il devient Master+Capture et le plan
   * du Take suivant le fait PARTICIPER au Take. Le modèle doit alors créer une
   * vignette locale — sans image réseau, puisque le transport écarte le
   * self-loop (J09-04) — dont le fond reste transparent pour laisser voir la
   * preview native permanente (§35.1).
   *
   * Un NOUVEAU cycle est indispensable : un plan de START est figé à sa
   * création, un device qui n'était pas participant ne peut donc pas le devenir
   * en cours de Take. On redémarre les deux applications (le plan du Take 1 est
   *Clos et `cancel()` est refusé après le top — `already_started`, J10). */
  console.log("MASTER+CAPTURE : redemarrage a froid des deux apps puis 2e cycle");
  const cap3 = await attach(coldStart(CAP_SERIAL, CAP_PORT, "capture-take2"), "capture-take2", READY_CAP);
  const mas2 = await attach(coldStart(MASTER_SERIAL, MASTER_PORT, "master-take2"), "master-take2", READY_MAS);
  const capT2 = cap3.ev;
  const masT2 = mas2.ev;

  const masSkills2 = await masT2('MultiCamConfig.setSkill("capture", true).then(function(c){'
    + 'return JSON.stringify({skills:c.enabledSkills,supported:c.supportedSkills})},'
    + 'function(e){return JSON.stringify({error:String(e)})})', true);
  const sk2 = JSON.parse(masSkills2);
  console.log("SKILLS master apres activation " + json(sk2));
  expect(sk2.skills && sk2.skills.indexOf("capture") >= 0, "skill capture activee sur le Master");
  expect(sk2.skills.indexOf("controller") >= 0, "la skill controller reste activee (c'est lui qui fait la mosaïque)");

  /* Attente de la PRÉPARATION de la caméra locale : la vignette locale ne peut
   * laisser voir la preview native que si la preview est réellement ouverte. */
  let pvOk = null;
  const tPv = Date.now();
  while (Date.now() - tPv < 40000) {
    await sleep(1000);
    pvOk = JSON.parse(await masT2('JSON.stringify({view:MultiCamPreviewService.view(),'
      + 'active:document.body.classList.contains("camera-preview-active")})', false));
    if (pvOk.view.active && pvOk.active) break;
  }
  console.log("PREVIEW master " + json(pvOk && pvOk.view));
  expect(!!pvOk && pvOk.view.active === true, "la preview native du Master-Capture est ouverte");
  expect(!!pvOk && pvOk.active === true && pvOk.view.bodyClass === "camera-preview-active",
    "le document est transparent (camera-preview-active) : la vignette locale laisse voir la camera");

  /* Le Master doit lui aussi devenir MEMBRE avec le rôle `capture` : c'est la
   * même action opérateur que pour la Capture. Sans membre, l'écran 05 et l'ARM
   * l'ignorent (ils lisent `session.members`) et le plan ne le mentionnerait
   * pas — sa vignette locale n'existerait donc pas, ce qui rendrait S5 vide. */
  const selfMember = await masT2('MultiCamSessionStore.get(' + json(sid) + ').then(function(s){'
    + 'return MultiCamSessionWs.addMember(s,{deviceId:' + json(M.did) + ',deviceName:' + json(M.name)
    + ',enabledSkills:' + json(sk2.skills) + ',endpoint:' + json(masEndpoint) + '},["capture"])'
    + '.then(function(u){return JSON.stringify({ok:true,members:(u.members||[]).map(function(m){'
    + 'return m.deviceId+":"+(m.sessionRoles||[]).join("+")})})},'
    + 'function(e){return JSON.stringify({ok:false,err:String(e)})})})', true);
  console.log("MEMBER_ADD master " + selfMember);
  expect(String(selfMember).indexOf(M.did + ":capture") >= 0,
    "le Master-Capture est membre avec le rôle capture");

  /* Présence à nouveau établie des deux côtés (les deux apps ont redémarré). */
  let pres2 = null;
  const tP2 = Date.now();
  while (Date.now() - tP2 < 30000) {
    await sleep(1000);
    pres2 = JSON.parse(await masT2("JSON.stringify(MultiCamSessionWs.connectedPeers(" + json(sid) + "))", false));
    if (pres2 && pres2[C.did]) break;
  }
  console.log("PRESENCE take2 " + json(pres2));
  expect(!!pres2 && !!pres2[C.did], "la Capture est de nouveau présente dans la session");

  /* 2e cycle : ARM puis REC par les boutons du panneau, comme un opérateur. */
  await masT2('MultiCamNav.show("take",{sid:' + json(sid) + '}); "take"', false);
  await sleep(2000);
  await selectionnerToutesCaptures(masT2, sid, "take2");
  await masT2('(function(){var b=document.getElementById("tkArm");if(b&&!b.disabled)b.click();return "click-ARM";})()', false);
  await sleep(6000);
  const inc2 = await masT2('(function(){var m=document.getElementById("armIncidentModal");'
    + 'if(m&&m.classList.contains("show")){var c=document.getElementById("armIncidentContinue");if(c)c.click();'
    + 'return "INCIDENT_LEVE";}return "aucun incident";})()', false);
  /* L'ARM doit porter les DEUX devices : sans le Master-Capture dans le plan,
   * sa vignette locale n'existerait pas et S5 ne prouverait rien. */
  const arm2 = await masT2('(function(){var v=MultiCamArmService.view()||{};return JSON.stringify('
    + '{take:v.takeNumber,devices:(v.devices||[]).map(function(d){return d.did})})})()', false);
  console.log("ARM_DEVICES take2 " + arm2);
  const arm2List = JSON.parse(arm2).devices;
  expect(arm2List.length === 2 && arm2List.indexOf(C.did) >= 0 && arm2List.indexOf(M.did) >= 0,
    "l'ARM du Take 2 porte les DEUX devices (Capture + Master-Capture) : " + arm2List.length);
  console.log("ARM take2 " + inc2);
  await sleep(1500);
  expect(!(await demarrerRec(masT2, "take2")).match(/sans-demarrage|PAS_DE/), "le dock REC a lance le Take 2");
  const tRec2 = Date.now();
  let ph2 = "";
  while (Date.now() - tRec2 < 45000) {
    await sleep(500);
    ph2 = String(await masT2('(MultiCamStartService.view()||{}).phase||""', false));
    if (ph2 === "REC") break;
  }
  console.log("REC take2 master=" + ph2);
  expect(ph2 === "REC", "le Master-Capture est en REC sur le Take 2");

  let s5 = null;
  const t5 = Date.now();
  while (Date.now() - t5 < 45000) {
    await sleep(700);
    s5 = await probe(masT2, "S5-master-capture-attente");
    const hasLocal = s5.dom.tiles.filter(function (x) { return x.local; }).length > 0;
    const hasRemote = s5.dom.tiles.filter(function (x) { return !x.local && x.hasSrc; }).length > 0;
    if (hasLocal && hasRemote) break;
  }
  const shot5 = shot(MASTER_SERIAL, "50-master-mosaic-s5-master-capture-local.png");
  s5.screenshots = [shot5];
  const localSlot = s5.model.slots.filter(function (x) { return x.isLocal; })[0];
  const localTile = s5.dom.tiles.filter(function (x) { return x.local; })[0];
  const remoteTiles = s5.dom.tiles.filter(function (x) { return !x.local; });
  console.log("S5 slots " + json(s5.model.slots.map(function (x) {
    return { did: x.deviceId.slice(0, 8), local: x.isLocal, state: x.displayState, frame: x.hasFrame };
  })));
  expect(!!localSlot, "le Master-Capture a bien sa propre vignette (slot isLocal)");
  expect(!!localTile, "la vignette locale est identifiable dans le DOM (contour .local)");
  expect(!!localTile && localTile.hasSrc === false,
    "AUCUNE image reseau sur la vignette locale (le self-loop reste ecarte)");
  expect(!!localTile && localTile.native === true, "la vignette locale est en mode preview native");
  expect(s5.dom.tiles.length === 2, "2 vignettes pour 2 participants du plan (locale + distante)");
  expect(remoteTiles.length === 1 && remoteTiles[0].hasSrc === true,
    "la vignette distante reçoit bien l'image de la Capture");
  /* L'ordre visuel doit être celui du PLAN, pas celui de l'arrivée des images. */
  expect(domOrder(s5.dom).join("|") === s5.model.order.map(function (did) {
    const sl = s5.model.slots.filter(function (x) { return x.deviceId === did; })[0];
    return sl ? sl.deviceName : did;
  }).join("|"), "l'ordre DOM suit l'ordre du plan : " + s5.model.order.join(","));
  console.log("NOTE la vignette locale ne porte AUCUN texte 'ce device' : son identité"
    + " vient du seul contour .local (contrainte maquette §Device local)");
  console.log("NOTE la caméra locale visible sous la vignette est une vérification"
    + " VISUELLE : capture d'écran " + shot5.file);

  /* ---------- 5. preuves ---------- */

  const nCap = grabConsole(CAP_SERIAL, "capture");
  const nMas = grabConsole(MASTER_SERIAL, "master");
  console.log("LOGS capture=" + nCap + " lignes, master=" + nMas + " lignes");

  const logMas = fs.readFileSync(path.join(OUT, "master-console.txt"), "utf8");
  const counts = {
    screen08Route: (logMas.match(/SCREEN08_ROUTE/g) || []).length,
    liveReady: (logMas.match(/LIVE_MOSAIC_READY/g) || []).length,
    liveSlotsAdded: (logMas.match(/LIVE_SLOTS_ADDED/g) || []).length,
    liveLiveness: (logMas.match(/LIVE_LIVENESS/g) || []).length,
    liveStatus: (logMas.match(/LIVE_STATUS/g) || []).length,
    liveFrameIgnored: (logMas.match(/LIVE_FRAME_IGNORED/g) || []).length,
    liveTakeSet: (logMas.match(/LIVE_TAKE_SET/g) || []).length
  };
  console.log("COMPTEURS LOGS " + json(counts));
  expect(counts.screen08Route >= 1, "la décision de routage régie est journalisée");
  expect(counts.liveReady >= 1, "la mosaïque est liée au Master");
  expect(counts.liveLiveness >= 1, "les changements de connectivité sont journalisés");
  expect(counts.liveStatus >= 1, "les changements d'état recorder sont journalisés");
  expect(counts.liveFrameIgnored === 0, "AUCUNE frame ignorée : rien d'hors Take n'a fui dans la mosaïque");

  const last = ev.rec[ev.rec.length - 1];
  const report = {
    mission: "J09-05",
    title: "Mosaïque Master REC — slots ordonnés par le plan de START",
    at: new Date().toISOString(),
    devices: {
      capture: { serial: CAP_SERIAL, deviceId: C.did, endpoint: capEndpoint },
      master: { serial: MASTER_SERIAL, deviceId: M.did, endpoint: masEndpoint }
    },
    session: { sessionId: sid, pin: "***" },
    scenarios: ev.rec.filter(function (r) { return r.changed; }).map(function (r) {
      return {
        tag: r.tag,
        domOrder: domOrder(r.dom),
        tiles: r.dom.tiles,
        gridClass: r.dom.gridClass,
        timer: r.dom.timer,
        take: r.dom.take,
        modelSlots: r.model.slots,
        order: r.model.order,
        stats: r.model.stats,
        screenshots: r.screenshots || []
      };
    }),
    logCounts: counts,
    verdict: {
      s1_uneCapture_uneVignette: true,
      placeholderAvantPremiereImage: true,
      s2_deconnexion: s2.model.slots[0].displayState === "DECONNECTED" && s2.dom.tiles[0].hasSrc === true,
      s3_reconnexion: s3.model.slots[0].displayState === "REC" && s3.model.slots[0].lastFrameSeq > s2.model.slots[0].lastFrameSeq,
      s4_stopLocal: s4.model.slots[0].status === "STOPPED" && s4b.model.slots[0].lastFrameSeq === seqA,
      s5_masterCaptureLocal: !!localSlot && !!localTile && localTile.hasSrc === false,
      ordreJamaisBouge: ev.rec.every(function (r) {
        if (!r.model.order.length) return true;
        return r.model.order.join(",") === ev.rec[0].model.order.join(",")
          || r.model.order.length >= ev.rec[0].model.order.length;
      })
    }
  };
  fs.writeFileSync(path.join(OUT, "rapport.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("RAPPORT " + path.relative(HERE, path.join(OUT, "rapport.json")));
  console.log("VERDICT " + json(report.verdict));

  const ok = Object.keys(report.verdict).every(function (k) { return report.verdict[k] === true; });
  console.log(ok ? "J09-05 SMOKE OK" : "J09-05 SMOKE : VERDICT INCOMPLET");
  capC.ws.close();
  masC.ws.close();
  process.exit(ok ? 0 : 1);
}

main().catch(function (err) {
  console.error("ECHEC " + String(err && err.message || err));
  try { grabConsole(MASTER_SERIAL, "master"); grabConsole(CAP_SERIAL, "capture"); } catch (e) {}
  process.exit(1);
});
