/**
 * MultiCam POC - C2 qualification app.
 * Generic WebSocket server (cordova-websocket-server@1.1.0) + standard WebView client.
 * Contains NO MultiCam business logic.
 */
(function () {
  'use strict';

  var wsserver = window.plugins ? window.plugins.wsserver : (window.cordova && cordova.plugins && cordova.plugins.wsserver);

  var serverConns = {}; // uuid -> conn object (from plugin callbacks)
  var clientWs = null;
  var seq = 0;
  var clientRx = 0, clientTx = 0, clientHb = 0;
  var serverRx = 0, serverTx = 0, serverHbSent = 0, serverHbAck = 0;
  var pendingBin = null; // {len, crc32, seq} for binary integrity check
  var hbTimer = null;
  var label = 'A';

  // ---- helpers ----------------------------------------------------------
  function $(id) { return document.getElementById(id); }

  function log(level, msg) {
    var line = '[' + new Date().toISOString().substr(11, 12) + '] ' + msg;
    console.log(line);
    var pre = $('log');
    var span = document.createElement('span');
    span.className = 'l' + level;
    span.textContent = line + '\n';
    pre.appendChild(span);
    if ($('auto-scroll').checked) pre.scrollTop = pre.scrollHeight;
  }

  function setText(id, txt) { $(id).textContent = txt; }

  // ---- CRC32 (IEEE, standard) ------------------------------------------
  var CRC_TABLE = (function () {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();

  function crc32(buf) {
    var b;
    if (typeof buf === 'string') {
      b = new Uint8Array(buf.length);
      for (var i = 0; i < buf.length; i++) b[i] = buf.charCodeAt(i);
    } else {
      b = new Uint8Array(buf);
    }
    var crc = 0xFFFFFFFF;
    for (var j = 0; j < b.length; j++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ b[j]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function crcHex(buf) {
    var c = crc32(buf);
    return ('00000000' + c.toString(16)).slice(-8);
  }

  // ---- payloads ---------------------------------------------------------
  var PAYL_PATTERN = 'MultiCam-POC-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdefghijklmnopqrstuvwxyz-.';
  var payloadCache = {};

  function getPayload(sizeKB) {
    var key = sizeKB + 'kb';
    if (!payloadCache[key]) {
      var n = sizeKB * 1024;
      var s = '';
      while (s.length < n) s += PAYL_PATTERN;
      payloadCache[key] = s.substr(0, n);
    }
    return payloadCache[key];
  }

  function blobForSize(kind) {
    var v = $('msg-size').value;
    if (v === 'tiny') return 'TINY-' + Date.now();
    return getPayload(parseInt(v, 10));
  }

  // ---- envelope ---------------------------------------------------------
  function envelope(kind, role, payload, extra) {
    var e = {
      v: 1, kind: kind, from: label, role: role, seq: ++seq, ts: Date.now()
    };
    if (payload !== undefined && payload !== null) {
      e.len = typeof payload === 'string' ? payload.length : payload.byteLength;
      e.crc32 = crcHex(payload);
      if (kind === 'test' || kind === 'ack' || kind === 'hb') e.blob = payload;
    }
    if (extra) for (var k in extra) e[k] = extra[k];
    return e;
  }

  function verifyScalars(env, payload) {
    var okLen = true, okCrc = true;
    var len = env.len !== undefined ? env.len : -1;
    var gotLen = typeof payload === 'string' ? payload.length : payload.byteLength;
    okLen = (len === gotLen);
    if (env.crc32 !== undefined) okCrc = (crcHex(payload) === env.crc32);
    return { okLen: okLen, okCrc: okCrc, gotLen: gotLen };
  }

  // ---- interfaces -------------------------------------------------------
  function refreshInterfaces() {
    if (!wsserver) return;
    wsserver.getInterfaces(function (ifaces) {
      var parts = [];
      Object.keys(ifaces).forEach(function (name) {
        ifaces[name].ipv4Addresses.forEach(function (ip) {
          parts.push(name + '=' + ip);
        });
      });
      setText('ifaces', parts.join('  ') || '(none)');
      log('INFO', 'getInterfaces: ' + JSON.stringify(ifaces));
    }, function (err) {
      log('ERROR', 'getInterfaces failed: ' + JSON.stringify(err));
    });
  }

  // ---- server -----------------------------------------------------------
  function serverStart() {
    if (!wsserver) { log('ERROR', 'wsserver plugin not found'); return; }
    var portStr = $('server-port').value.trim();
    var port = /^\d+$/.test(portStr) ? parseInt(portStr, 10) : 0;
    log('INFO', 'start server port=' + port);
    wsserver.start(port, {
      origins: null,
      protocols: null,
      tcpNoDelay: true,
      onOpen: function (conn) {
        serverConns[conn.uuid] = conn;
        log('INFO', 'onOpen uuid=' + conn.uuid.substr(0, 8) + '… remote=' + conn.remoteAddr + ' res=' + conn.resource);
        updateConnList();
      },
      onMessage: function (conn, msg) {
        serverRx++;
        if (typeof msg === 'string') {
          onServerText(conn, msg);
        } else {
          onServerBinary(conn, msg);
        }
        updateStats();
      },
      onClose: function (conn, code, reason, wasClean) {
        delete serverConns[conn.uuid];
        log('WARN', 'onClose uuid=' + conn.uuid.substr(0, 8) + '… code=' + code + ' reason=' + reason + ' wasClean=' + wasClean);
        updateConnList();
      },
      onFailure: function (addr, port, reason) {
        log('ERROR', 'SERVER FAILURE addr=' + addr + ' port=' + port + ' reason=' + reason);
        setText('server-status', 'FAILED: ' + reason);
        updateConnList();
      }
    }, function (addr, port) {
      setText('server-status', 'listening on :' + port + ' (bind ' + addr + ')');
      log('INFO', 'onStart OK addr=' + addr + ' port=' + port);
    }, function (err) {
      log('ERROR', 'start failure cb: ' + JSON.stringify(err));
      setText('server-status', 'ERROR: ' + JSON.stringify(err));
    });
    updateStats();
  }

  function serverStop() {
    if (!wsserver) return;
    log('INFO', 'stop server');
    wsserver.stop(function (addr, port) {
      setText('server-status', 'stopped (was ' + addr + ':' + port + ')');
      log('INFO', 'server stopped');
    }, function (err) {
      log('ERROR', 'stop failure: ' + JSON.stringify(err));
    });
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    serverConns = {};
    updateConnList();
  }

  // ---- server: start with port fallback (Part A qualification) ---------
  // base = #server-port ; tries base..base+#fallback-window sequentially.
  // A bind failure surfaces async via the plugin 'onFailure' event (the JS
  // exec failure cb may also fire); both paths advance to the next port.
  // Records a deterministic 'FALLBACK' log trail + sets #effective-port.
  function serverStartFallback() {
    if (!wsserver) { log('ERROR', 'wsserver plugin not found'); return; }
    var base = parseInt($('server-port').value, 10);
    var win = parseInt($('fallback-window').value, 10);
    if (!(base > 0) || !(win >= 0)) { log('ERROR', 'fallback: bad base/window'); return; }
    if (win > 50) win = 50;
    var tried = [];
    var idx = 0;
    setText('effective-port', '');
    setText('server-status', 'fallback starting at ' + base + ' (window ' + win + ')');
    log('WARN', 'FALLBACK start base=' + base + ' window=' + win);
    var t0 = Date.now();
    var attempt = function () {
      var port = base + idx;
      if (idx > win) {
        setText('server-status', 'FAILED: no port in [' + base + ',' + (base + win) + ']');
        log('ERROR', 'FALLBACK exhausted tried=' + JSON.stringify(tried) + ' total=' + (Date.now() - t0) + 'ms');
        return;
      }
      var ta = Date.now();
      var settled = false;
      log('INFO', 'FALLBACK attempt port=' + port);
      var advance = function (tag) {
        if (settled) return;          // only one signal per port attempt
        settled = true;
        var dt = Date.now() - ta;
        tried.push(':' + port + '(' + tag + ',' + dt + 'ms)');
        log('WARN', 'FALLBACK busy port=' + port + ' via=' + tag + ' dt=' + dt + 'ms');
        idx++;
        attempt();
      };
      wsserver.start(port, {
        origins: null,
        protocols: null,
        tcpNoDelay: true,
        onOpen: function (conn) {
          serverConns[conn.uuid] = conn;
          log('INFO', 'onOpen uuid=' + conn.uuid.substr(0, 8) + '… remote=' + conn.remoteAddr + ' res=' + conn.resource);
          updateConnList();
        },
        onMessage: function (conn, msg) {
          serverRx++;
          if (typeof msg === 'string') { onServerText(conn, msg); } else { onServerBinary(conn, msg); }
          updateStats();
        },
        onClose: function (conn, code, reason, wasClean) {
          delete serverConns[conn.uuid];
          log('WARN', 'onClose uuid=' + conn.uuid.substr(0, 8) + '… code=' + code + ' reason=' + reason + ' wasClean=' + wasClean);
          updateConnList();
        },
        onFailure: function (addr, p, reason) {
          if (p !== port) { log('ERROR', 'FALLBACK mismatched onFailure addr=' + addr + ' p=' + p); }
          advance('onFailure:' + reason);
        }
      }, function (addr, port) {
        settled = true;               // success — do not advance on later 'continue'
        setText('effective-port', String(port));
        setText('server-status', 'listening on :' + port + ' (bind ' + addr + ', fallback #' + idx + ')');
        var dt = Date.now() - t0;
        log('WARN', 'FALLBACK OK port=' + port + ' attemptIdx=' + idx + ' total=' + dt + 'ms');
        log('WARN', 'FALLBACK summary base=' + base + ' tried=' + JSON.stringify(tried) + ' total=' + dt + 'ms');
        updateStats();
      }, function (err) {
        advance('execcb:' + JSON.stringify(err));
      });
    };
    attempt();
  }

  function updateConnList() {
    var sel = $('server-conn-list');
    sel.innerHTML = '';
    Object.keys(serverConns).forEach(function (uuid) {
      var c = serverConns[uuid];
      var opt = document.createElement('option');
      opt.value = uuid;
      opt.textContent = uuid.substr(0, 8) + '…  ' + c.remoteAddr;
      sel.appendChild(opt);
    });
  }

  function updateStats() {
    setText('server-stats', 'rx=' + serverRx + ' tx=' + serverTx + ' hbSent=' + serverHbSent + ' hbAck=' + serverHbAck + ' conns=' + Object.keys(serverConns).length);
    setText('send-status', 'client rx=' + clientRx + ' tx=' + clientTx + ' hb=' + clientHb);
  }

  // server receive handlers
  function onServerText(conn, text) {
    log('INFO', 'server rx text len=' + text.length);
    var env;
    try { env = JSON.parse(text); } catch (e) { log('ERROR', 'server parse error'); return; }
    if (!env || !env.kind) return;
    switch (env.kind) {
      case 'test':
        var r = verifyScalars(env, env.blob === undefined ? '' : env.blob);
        log('TEST', 'server got test from=' + env.from + ' seq=' + env.seq + ' len=' + r.gotLen + '/' + env.len + ' crc=' + (r.okCrc ? 'OK' : 'FAIL'));
        if ($('auto-echo').checked) {
          var ack = envelope('ack', 'server', env.blob === undefined ? '' : env.blob, { echo_of: env.seq });
          wsserver.send(conn, JSON.stringify(ack));
          serverTx++;
          log('TEST', 'server ack sent to from=' + env.from + ' echo_of=' + env.seq);
        }
        break;
      case 'bin':
        pendingBin = { len: env.len, crc32: env.crc32, seq: env.seq, from: env.from };
        log('INFO', 'server expecting binary len=' + env.len + ' from=' + env.from);
        break;
      case 'hb':
        log('INFO', 'server rx hb from=' + env.from);
        break;
      case 'hb_ack':
        serverHbAck++;
        log('WARN', 'server rx hb_ack from=' + env.from);
        break;
      case 'ack':
        var rr = verifyScalars(env, env.blob === undefined ? '' : env.blob);
        log('TEST', 'server rx ack echo_of=' + env.echo_of + ' len=' + rr.gotLen + '/' + env.len + ' crc=' + (rr.okCrc ? 'OK' : 'FAIL'));
        break;
    }
    updateStats();
  }

  function onServerBinary(conn, buf) {
    log('INFO', 'server rx binary bytes=' + buf.byteLength);
    if (pendingBin) {
      var r = verifyScalars(pendingBin, buf);
      var ok = r.okLen && r.okCrc;
      log('TEST', 'server binary ' + (ok ? 'VERIFIED' : 'FAIL') + ' len=' + r.gotLen + '/' + pendingBin.len + ' crc=' + (r.okCrc ? 'OK' : 'FAIL'));
      if (ok && $('auto-echo').checked && pendingBin.len === buf.byteLength) {
        wsserver.send(conn, buf);
        serverTx++;
        log('TEST', 'server echoed binary back to ' + conn.remoteAddr);
      }
      pendingBin = null;
    } else {
      log('WARN', 'server binary without pending envelope (bytes=' + buf.byteLength + ')');
    }
    updateStats();
  }

  // server broadcast (JS composition - C2-06, C2-12)
  function serverBroadcast(msg) {
    var uuids = Object.keys(serverConns);
    uuids.forEach(function (uuid) {
      wsserver.send(serverConns[uuid], msg);
      serverTx++;
    });
    log('INFO', 'server broadcast to ' + uuids.length + ' conn(s)');
    updateStats();
  }

  function serverSendToSelected(msg) {
    var sel = $('server-conn-list');
    if (!sel.selectedIndex && sel.options.length === 1) sel.selectedIndex = 0;
    var uuid = sel.value;
    if (!uuid || !serverConns[uuid]) { log('ERROR', 'no selected server conn'); return; }
    wsserver.send(serverConns[uuid], msg);
    serverTx++;
    log('INFO', 'server -> selected conn ' + uuid.substr(0, 8) + '…');
    updateStats();
  }

  function toggleHeartbeat() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; log('INFO', 'heartbeat off'); return; }
    if (!$('heartbeat').checked) return;
    hbTimer = setInterval(function () {
      if (Object.keys(serverConns).length) {
        var hb = JSON.stringify(envelope('hb', 'server', null));
        serverBroadcast(hb);
        serverHbSent++;
        updateStats();
      }
    }, 2000);
    log('INFO', 'heartbeat on (2s)');
  }

  // ---- client (standard WebView WebSocket) ------------------------------
  function clientConnect() {
    if (clientWs) { log('WARN', 'client already connected'); return; }
    var host = $('client-host').value.trim();
    var port = $('client-port').value.trim();
    if (!host) { log('ERROR', 'no host'); return; }
    var url = 'ws://' + host + ':' + port;
    log('INFO', 'client connecting to ' + url);
    setText('client-status', 'connecting…');
    try {
      clientWs = new WebSocket(url);
    } catch (e) {
      log('ERROR', 'WebSocket ctor error: ' + e);
      clientWs = null;
      setText('client-status', 'ctor error');
      return;
    }
    clientWs.binaryType = 'arraybuffer';
    clientWs.onopen = function () {
      log('INFO', 'client OPEN ' + url);
      setText('client-status', 'OPEN');
    };
    clientWs.onmessage = function (ev) {
      clientRx++;
      if (typeof ev.data === 'string') {
        onClientText(ev.data);
      } else if (ev.data instanceof ArrayBuffer) {
        onClientBinary(ev.data);
      } else {
        log('WARN', 'client rx unknown type ' + ev.data.constructor.name);
      }
      updateStats();
    };
    clientWs.onclose = function (ev) {
      log('WARN', 'client CLOSE code=' + ev.code + ' reason=' + ev.reason + ' clean=' + ev.wasClean);
      setText('client-status', 'CLOSED (' + ev.code + ')');
      clientWs = null;
    };
    clientWs.onerror = function (ev) {
      log('ERROR', 'client ERROR event');
      setText('client-status', 'error');
      var ws = clientWs;
      setTimeout(function () {
        // a failed socket may not emit 'close'; release it so Connect can be retried
        if (ws && ws.readyState === WebSocket.CLOSED) clientWs = null;
      }, 1000);
    };
  }

  function clientDisconnect() {
    if (!clientWs) { log('WARN', 'client not connected'); return; }
    log('INFO', 'client closing');
    try { clientWs.close(1000, 'by user'); } catch (e) { log('ERROR', 'close: ' + e); }
  }

  function onClientText(text) {
    log('INFO', 'client rx text len=' + text.length);
    var env;
    try { env = JSON.parse(text); } catch (e) { log('ERROR', 'client parse error'); return; }
    if (!env || !env.kind) return;
    switch (env.kind) {
      case 'test':
        var r = verifyScalars(env, env.blob === undefined ? '' : env.blob);
        log('TEST', 'client got test from=' + env.from + ' seq=' + env.seq + ' len=' + r.gotLen + '/' + env.len + ' crc=' + (r.okCrc ? 'OK' : 'FAIL'));
        break;
      case 'ack':
        var rr = verifyScalars(env, env.blob === undefined ? '' : env.blob);
        log('TEST', 'client rx ACK echo_of=' + env.echo_of + ' len=' + rr.gotLen + '/' + env.len + ' crc=' + (rr.okCrc ? 'OK' : 'FAIL') + ' (roundtrip OK)');
        break;
      case 'bin':
        pendingBin = { len: env.len, crc32: env.crc32, seq: env.seq, from: env.from };
        log('INFO', 'client expecting binary len=' + env.len + ' from=' + env.from);
        break;
      case 'hb':
        clientHb++;
        clientWs.send(JSON.stringify(envelope('hb_ack', 'client', null)));
        clientTx++;
        log('INFO', 'client rx hb #' + clientHb + ' from=' + env.from + ' -> hb_ack');
        break;
    }
    updateStats();
  }

  function onClientBinary(buf) {
    log('INFO', 'client rx binary bytes=' + buf.byteLength);
    if (pendingBin) {
      var r = verifyScalars(pendingBin, buf);
      var ok = r.okLen && r.okCrc;
      log('TEST', 'client binary ' + (ok ? 'VERIFIED' : 'FAIL') + ' len=' + r.gotLen + '/' + pendingBin.len + ' crc=' + (r.okCrc ? 'OK' : 'FAIL') + ' from=' + pendingBin.from);
      pendingBin = null;
    } else {
      log('WARN', 'client binary without pending envelope (bytes=' + buf.byteLength + ')');
    }
    updateStats();
  }

  // ---- send master ------------------------------------------------------
  function doSend() {
    var mode = $('msg-mode').value;
    var payload = blobForSize();
    var env;

    switch (mode) {
      case 'client-text':
        if (!clientWs || clientWs.readyState !== WebSocket.OPEN) { log('ERROR', 'client not open'); return; }
        env = envelope('test', 'client', payload);
        clientWs.send(JSON.stringify(env));
        clientTx++;
        log('INFO', 'client sends test seq=' + env.seq + ' len=' + env.len);
        break;

      case 'client-binary':
        if (!clientWs || clientWs.readyState !== WebSocket.OPEN) { log('ERROR', 'client not open'); return; }
        var bytes = new TextEncoder().encode(payload);
        env = envelope('bin', 'client', bytes);
        clientWs.send(JSON.stringify(env));
        clientWs.send(bytes.buffer);
        clientTx += 2;
        pendingBin = { len: env.len, crc32: env.crc32, seq: env.seq, from: 'client' };
        log('INFO', 'client sends binary env seq=' + env.seq + ' len=' + env.len + ' + frame');
        break;

      case 'server-broadcast-text':
        if (!Object.keys(serverConns).length) { log('ERROR', 'no server conns'); return; }
        env = envelope('test', 'server', payload);
        serverBroadcast(JSON.stringify(env));
        log('INFO', 'server broadcast test seq=' + env.seq);
        break;

      case 'server-broadcast-binary':
        if (!Object.keys(serverConns).length) { log('ERROR', 'no server conns'); return; }
        var b2 = new TextEncoder().encode(payload);
        env = envelope('bin', 'server', b2);
        serverBroadcast(JSON.stringify(env));
        serverBroadcast(b2.buffer);
        log('INFO', 'server broadcast binary seq=' + env.seq + ' len=' + env.len);
        break;

      case 'server-select-text':
        if (!Object.keys(serverConns).length) { log('ERROR', 'no server conns'); return; }
        env = envelope('test', 'server', payload);
        serverSendToSelected(JSON.stringify(env));
        log('INFO', 'server -> selected test seq=' + env.seq);
        break;

      case 'server-select-binary':
        if (!Object.keys(serverConns).length) { log('ERROR', 'no server conns'); return; }
        var b3 = new TextEncoder().encode(payload);
        env = envelope('bin', 'server', b3);
        serverSendToSelected(JSON.stringify(env));
        serverSendToSelected(b3.buffer);
        log('INFO', 'server -> selected binary seq=' + env.seq + ' len=' + env.len);
        break;
    }
    updateStats();
  }

  // ---- wiring -----------------------------------------------------------
  function bind() {
    $('btn-save-label').onclick = function () {
      label = $('device-label').value.trim() || 'A';
      localStorage.setItem('c2label', label);
      log('INFO', 'device label = ' + label);
    };
    $('btn-refresh-interfaces').onclick = refreshInterfaces;
    $('btn-server-start').onclick = serverStart;
    $('btn-server-fallback').onclick = serverStartFallback;
    $('btn-server-stop').onclick = serverStop;
    $('btn-client-connect').onclick = clientConnect;
    $('btn-client-disconnect').onclick = clientDisconnect;
    $('btn-send').onclick = doSend;
    $('btn-clear-log').onclick = function () { $('log').innerHTML = ''; };
    $('heartbeat').onchange = toggleHeartbeat;
    $('msg-size').onchange = function () {
      var v = $('msg-size').value;
      setText('payload-note', v === 'tiny' ? 'small echo payload' : 'payload = ' + v + ' KB of deterministic text (integrity via len+crc32)');
    };
    $('server-port').onkeydown = function (e) { if (e.key === 'Enter') serverStart(); };
    $('client-port').onkeydown = function (e) { if (e.key === 'Enter') clientConnect(); };
    $('auto-fallback-boot').onchange = function () {
      localStorage.setItem('c2autofb', $('auto-fallback-boot').checked ? '1' : '0');
      log('INFO', 'auto fallback boot = ' + $('auto-fallback-boot').checked);
    };
  }

  function init() {
    label = localStorage.getItem('c2label') || 'A';
    $('device-label').value = label;
    var autofb = localStorage.getItem('c2autofb') === '1';
    $('auto-fallback-boot').checked = autofb;
    setText('ua', navigator.userAgent);
    setText('server-status', 'stopped');
    setText('client-status', 'idle');
    log('INFO', 'C2 POC ready. label=' + label + ' autofb=' + autofb);
    refreshInterfaces();
    if (autofb) {
      log('INFO', 'AUTO FALLBACK start at boot');
      setTimeout(serverStartFallback, 1500);
    }
  }

  document.addEventListener('deviceready', function () {
    wsserver = cordova.plugins && cordova.plugins.wsserver;
    if (!wsserver) { log('ERROR', 'cordova.plugins.wsserver missing'); return; }
    bind();
    init();
  }, false);
})();