#!/usr/bin/env node
/**
 * MultiCam — pilote CDP pour les tests e2e WebView (Android).
 *
 * L'UI Cordova est une WebView : uiautomator ne voit pas le DOM. On utilise le
 * WebView DevTools (CDP) exposé par les builds debug :
 *   adb forward tcp:PORT localabstract:webview_devtools_remote_<pid>
 * puis Runtime.evaluate sur la page courante.
 *
 * Usage :
 *   node lib/cdp.js <serial> list
 *   node lib/cdp.js <serial> eval '<expression js>'      (awaitPromise, by value)
 *   node lib/cdp.js <serial> nav  <url>
 *
 * Sortie : JSON sur stdout (résultat de l'expression) ou texte d'erreur.
 */

"use strict";

const { execFileSync } = require("child_process");

const APP_ID = "fr.emmanuel.multicam";

function adb(serial, args) {
  return execFileSync("adb", ["-s", serial].concat(args), { encoding: "utf8" }).trim();
}

function portFor(serial) {
  let h = 0;
  for (const c of serial) h = (h * 31 + c.charCodeAt(0)) % 2000;
  return 9300 + h;
}

async function targets(serial) {
  const pid = adb(serial, ["shell", "pidof", APP_ID]).split(/\s+/)[0];
  if (!pid) throw new Error("app_not_running pid empty");
  const port = portFor(serial);
  adb(serial, ["forward", "tcp:" + port, "localabstract:webview_devtools_remote_" + pid]);
  const res = await fetch("http://127.0.0.1:" + port + "/json");
  const list = await res.json();
  return { pid, port, list };
}

function rpc(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("cdp_timeout")); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params: params || {} }));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id === 1) {
        clearTimeout(timer);
        ws.close();
        if (msg.error) reject(new Error("cdp_error " + JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error("cdp_ws_error")); };
  });
}

async function main() {
  const [serial, cmd, arg] = process.argv.slice(2);
  if (!serial || !cmd) {
    console.error("usage: cdp.js <serial> list|eval|nav [arg]");
    process.exit(2);
  }
  const { list } = await targets(serial);
  if (cmd === "list") {
    console.log(JSON.stringify(list.map((t) => ({ url: t.url, title: t.title, ws: t.webSocketDebuggerUrl })), null, 2));
    return;
  }
  const page = list.find((t) => t.type === "page") || list[0];
  if (!page) throw new Error("no_page_target");

  if (cmd === "nav") {
    const r = await rpc(page.webSocketDebuggerUrl, "Page.navigate", { url: arg });
    console.log(JSON.stringify(r));
    return;
  }
  if (cmd === "eval") {
    const r = await rpc(page.webSocketDebuggerUrl, "Runtime.evaluate", {
      expression: arg,
      returnByValue: true,
      awaitPromise: true
    });
    if (r.exceptionDetails) {
      console.error("EVAL_EXCEPTION " + JSON.stringify(r.exceptionDetails));
      process.exit(1);
    }
    console.log(JSON.stringify(r.result && r.result.value !== undefined ? r.result.value : r.result));
    return;
  }
  console.error("unknown cmd " + cmd);
  process.exit(2);
}

main().catch((err) => { console.error("CDP_FATAL " + err.message); process.exit(1); });