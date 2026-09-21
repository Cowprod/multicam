#!/usr/bin/env node
/**
 * Minimal Chrome DevTools Protocol driver for the C2 POC WebView.
 * usage: node cdp.js <port> '<js expression>'
 * Prints the evaluated result (JSON) or an error.
 */
const port = process.argv[2];
const expr = process.argv[3];

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.error) { console.error('CDP error:', JSON.stringify(r.error)); process.exit(1); }
  const resv = r.result.result;
  if (resv.subtype === 'error' || resv.type === 'error') {
    console.error('JS error:', JSON.stringify(resv.description || resv));
    process.exit(1);
  }
  console.log(JSON.stringify(resv.value));
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });