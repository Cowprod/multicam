#!/usr/bin/env node
/* Pilote CDP minimal (J09) — evalue du JS dans le WebView Android via Chrome
 * DevTools Protocol. Zero dependance : utilise le WebSocket global de Node 22+.
 *
 * Preparation :
 *   PID=$(adb -s DEVICE shell pidof fr.emmanuel.multicam)
 *   adb -s DEVICE forward tcp:9222 localabstract:webview_devtools_remote_$PID
 *
 * Usage :
 *   node cdp.js 'MultiCamPreviewService.view()'
 *   node cdp.js --file script.js          # evalue un fichier
 *   node cdp.js --await 'Promise.resolve(1)'  # attend une promesse
 */
const fs = require("fs");

const PORT = process.env.CDP_PORT || "9222";

async function target() {
  const res = await fetch(`http://localhost:${PORT}/json`);
  const list = await res.json();
  const page = list.find((t) => t.type === "page" && /index\.html/.test(t.url)) || list.find((t) => t.type === "page");
  if (!page) throw new Error("aucune cible page CDP");
  return page.webSocketDebuggerUrl;
}

function once(ws, id) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout CDP")), 15000);
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(t);
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
      resolve(msg.result);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  let expr, awaitPromise = false;
  if (args[0] === "--file") expr = fs.readFileSync(args[1], "utf8");
  else if (args[0] === "--await") { expr = args[1]; awaitPromise = true; }
  else expr = args[0];
  if (!expr) { console.error("usage: node cdp.js '<js>' | --file f.js | --await '<js>'"); process.exit(2); }

  const url = await target();
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  const id = 1;
  ws.send(JSON.stringify({
    id,
    method: "Runtime.evaluate",
    params: { expression: expr, returnByValue: true, awaitPromise, userGesture: true }
  }));
  const result = await once(ws, id);
  ws.close();
  if (result.exceptionDetails) {
    console.error("EXCEPTION:", JSON.stringify(result.exceptionDetails.exception || result.exceptionDetails, null, 2));
    process.exit(1);
  }
  const v = result.result && result.result.value;
  if (typeof v === "string") console.log(v);
  else console.log(JSON.stringify(v, null, 2));
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
