// one-off: attach CDP, enable Runtime, subscribe to console, trigger a ws connect
const http = require('http');
const { WebSocket } = globalThis;

const port = process.argv[2];

http.get(`http://127.0.0.1:${port}/json`, (res) => {
  let d = '';
  res.on('data', (c) => (d += c));
  res.on('end', () => {
    const targets = JSON.parse(d);
    const page = targets.find((t) => t.type === 'page');
    if (!page) { console.log('NO PAGE TARGET'); process.exit(1); }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const send = (method, params) => ws.send(JSON.stringify({ id: ++id, method, params }));
    ws.addEventListener('open', () => {
      send('Runtime.enable');
      send('Log.enable');
      setTimeout(() => {
        send('Runtime.evaluate', { expression: `(function(){
          const ws = new WebSocket('ws://127.0.0.1:45102');
          ws.onopen = () => console.log('WS=OPEN');
          ws.onerror = (e) => console.log('WS=ERROR');
        })()`, returnByValue: true });
      }, 400);
      setTimeout(() => process.exit(0), 4000);
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.consoleAPICalled') {
        if (process.argv[3]==='all') console.log('CONSOLEALL>', JSON.stringify(msg.params.args.map(a=>a.value!==undefined?a.value:a.description).join(' ')));
        const args = msg.params.args.map((a) => a.value !== undefined ? a.value : a.description).join(' ');
        const txt = msg.params.type + ': ' + args;
        if (/mixed content|WS=|insecure|websocket/i.test(txt)) console.log('CONSOLE>', txt);
      }
      if (msg.method === 'Log.entryAdded') {
        if (process.argv[3]==='all') console.log('LOGALL>', JSON.stringify(msg.params.entry.text));
        const t = msg.params.entry.text;
        if (/mixed content|insecure|websocket/i.test(t)) console.log('LOG>', t);
      }
    });
    ws.addEventListener('error', (e) => { console.log('SOCKET ERROR'); });
  });
}).on('error', (e) => { console.log('ERR', e.message); process.exit(1); });