'use strict';
const assert = require('assert');
const B = require('../www/js/state/transfer-boot.js');
const M = require('../www/js/state/transfer-model.js');
const S = require('../www/js/state/transfer-service.js');
const TM = require('../www/js/state/take-model.js');
const SID = 'recovery';
function setup(role, extra) {
  extra = extra || {};
  const self = role === 'storage' ? 'storage' : 'cam1';
  const source = '/data/user/0/app/files/recordings/video.mp4';
  const take = {takeNumber: 1, status: 'TERMINATED', captures: ['cam1', 'cam2'], storages: ['storage'], settings: {transferAuto: true, deleteLocalAfterVerifiedReplication: false}, summary: {stopStates: {cam1: {state: 'STOPPED', path: source}}}};
  const session = {sessionId: SID, state: 'open', takes: [take]};
  const logs = [];
  const timers = [], out = [], calls = {download: [], sha: [], grants: [], stage: []};
  let net, bridge, ip = '10.1.0.1', now = 100000;
  const native = {
    serveStart: () => Promise.resolve('http://10.0.0.1:8080'),
    serveRegister: o => {calls.grants.push(o); return Promise.resolve();},
    sha256: p => {calls.sha.push(p); return Promise.resolve({bytes: 100, sha256: 'aa'});},
    stage: (...a) => {calls.stage.push(a); return Promise.reject(Error('unexpected copy'));},
    download: (o, progress) => {calls.download.push(o); if (progress) progress({received: 100, verifying: true}); return Promise.resolve({received: 100, sha256: 'aa'});}
  };
  const deps = {
    cfg: {deviceId: self, enabledSkills: [role === 'capture' ? 'capture' : 'storage']},
    sessionStore: () => ({list: () => Promise.resolve([session]), get: () => Promise.resolve(session)}),
    startService: () => ({selfDid: () => self, isRecording: () => false}),
    storageNative: () => ({defaultPath: () => '/media', systemPath: p => p}),
    nativeApi: () => native, transferModel: () => M, transferService: () => S, takeModel: () => TM,
    ws: () => ({broadcastTargeted: (kind, _, msg) => out.push({kind, msg}), sendToDevice() {}, setTransferBridge: b => {bridge = b;}}),
    discovery: () => ({onNetworkChange: f => {net = f;}, status: () => ({ipv4: ip})}),
    setInterval: () => ({unref(){}}), clearInterval(){},
    setTimeout: (fn, ms) => {const t = {fn, ms, unref(){}}; timers.push(t); return t;},
    now: () => now, log: l => logs.push(l)
  };
  Object.assign(deps, extra);
  const boot = B.createTransferBoot(deps);
  return {boot, calls, native, out, timers, source, take, logs, net: () => net(), changeIp: value => {ip = value; now += 11000;}};
}
function offer(src, host, token) {
  return {kind: 'transfer_offer', sessionId: SID, takeNumber: 1, sourceDeviceId: src, storageDeviceId: 'storage', host, port: 8080, token, files: [{rel: 'video.mp4', bytes: 100, sha256: 'aa'}]};
}
async function flush() {for (let i=0;i<30;i++) await Promise.resolve();}
module.exports.register = h => {
  h.describe('Reprise après changement de réseau', () => {
    h.it('chaque capture garde son propre endpoint et token lors de la reprise', async () => {
      const x = setup('storage'); x.boot.bind();
      await x.boot._loadEntry(SID, 1); x.boot._ensureFor(SID, 1);
      const e = x.boot._entries()[SID+'|1']; const received = [];
      e.service.storageRun = o => {received.push(o); return Promise.resolve();};
      e.machine.onIncoming(offer('cam1', '10.1.0.1', 'token1'));
      e.machine.onIncoming(offer('cam2', '10.1.0.2', 'token2'));
      e.machine.markTransferWaiting('cam1', 'storage', 'network', 1000, 0);
      e.machine.markTransferWaiting('cam2', 'storage', 'network', 1000, 0);
      received.length = 0; x.boot._onNetworkChange();
      x.timers.splice(0).forEach(t => t.fn()); await flush();
      assert.strictEqual(received.length, 2);
      for (const o of received) {
        assert.strictEqual(o.host, o.sourceDeviceId === 'cam1' ? '10.1.0.1' : '10.1.0.2');
        assert.strictEqual(o.token, o.sourceDeviceId === 'cam1' ? 'token1' : 'token2');
      }
    });
    h.it('une prise arrêtée persistée est réannoncée avec la nouvelle IP sans copie ni nouveau hash', async () => {
      const x = setup('capture'); x.boot.bind(); await flush();
      assert.strictEqual(x.calls.sha.length, 1);
      assert.strictEqual(x.calls.stage.length, 0);
      assert.ok(x.calls.grants.length, JSON.stringify(x.logs));
      assert.strictEqual(x.calls.grants[0].files[0].path, x.source);
      assert.strictEqual(x.out.find(o => o.kind === 'media_ready').msg.host, '10.1.0.1');
      x.changeIp('192.168.92.76'); x.net(); await flush();
      assert.strictEqual(x.calls.sha.length, 1);
      assert.strictEqual(x.out.filter(o => o.kind === 'media_ready').pop().msg.host, '192.168.92.76');
    });
    h.it('ancienne prise : retrouve le privé complet malgré une copie de staging partielle et un résumé écrasé', async () => {
      const x = setup('capture', {privateRecordingsDir: '/data/user/0/app/files/recordings'});
      x.take.summary.stopStates = {};
      x.take.summary.replications = {'cam1|storage': {sourceDeviceId: 'cam1', storageDeviceId: 'storage', total: 100}};
      x.native.listDir = path => {x.logs.push('LIST '+path); return Promise.resolve({entries: [{name: 'video.mp4', bytes: path.includes('/recordings') ? 100 : 20, dir: false}]});};
      x.boot.bind(); await flush(); await flush();
      assert.strictEqual(x.calls.stage.length, 0);
      assert.ok(x.calls.grants.length, JSON.stringify(x.logs));
      assert.strictEqual(x.calls.grants[0].files[0].path, x.source);
      assert.strictEqual(x.out.find(o => o.kind === 'media_ready').msg.files[0].bytes, 100);
    });
    h.it('migration ambiguë : une taille privée différente ne devient pas une source', async () => {
      const x = setup('capture', {privateRecordingsDir: '/data/user/0/app/files/recordings'});
      x.take.summary.stopStates = {};
      x.take.summary.replications = {'cam1|storage': {sourceDeviceId: 'cam1', storageDeviceId: 'storage', total: 100}};
      x.native.listDir = () => Promise.resolve({entries: [{name: 'video.mp4', bytes: 20, dir: false}]});
      x.boot.bind(); await flush(); await flush();
      assert.strictEqual(x.calls.grants.length, 0);
      assert.strictEqual(x.out.filter(o => o.kind === 'media_ready').length, 0);
    });
    h.it('le storage reçoit directement une capture sélectionnée sans master et ne retélécharge pas un done', async () => {
      const x = setup('storage'); x.boot.bind();
      const env = Object.assign(offer('cam1', '10.1.0.1', 'token1'), {kind: 'media_ready', deviceId: 'cam1', from: 'cam1'});
      await x.boot._onTransferMessage(env);
      assert.strictEqual(x.calls.download.length, 1);
      await x.boot._onTransferMessage(env);
      assert.strictEqual(x.calls.download.length, 1);
      await x.boot._onTransferMessage(Object.assign({}, env, {deviceId: 'intruder', from: 'intruder'}));
      assert.strictEqual(x.calls.download.length, 1);
    });
    h.it('un checksum natif différent déclenche un seul redémarrage contrôlé au lieu de valider le fichier', async () => {
      const x = setup('storage'); let runs = 0;
      x.native.download = o => {x.calls.download.push(o); runs++; return Promise.resolve({received: 100, sha256: runs === 1 ? 'bb' : 'aa'});};
      x.boot.bind(); await x.boot._onTransferMessage(offer('cam1', '10.1.0.1', 'token1'));
      assert.strictEqual(runs, 2);
      assert.strictEqual(x.calls.download[1].offset, 0);
      assert.strictEqual(x.boot.viewFor(SID, 1).transfers['cam1|storage'].state, 'done');
    });
    h.it('le journal est restauré avant la nouvelle offre : la progression partielle est conservée', async () => {
      let restore;
      const x = setup('storage', {transferJournal: () => ({createTransferJournal: () => ({restore: () => new Promise(r => {restore = r;})})})});
      x.boot.bind();
      x.native.sha256 = () => Promise.resolve({bytes: 20, sha256: 'partial'});
      const handling = x.boot._onTransferMessage(offer('cam1', '10.1.0.1', 'token1')); await flush();
      assert.strictEqual(x.calls.download.length, 0);
      restore({ok: true, doc: {files: [{sourceDeviceId: 'cam1', rel: 'video.mp4', expectedBytes: 100, expectedSha256: 'aa', received: 20, state: 'waiting_network'}]}});
      await handling;
      assert.strictEqual(x.calls.download[0].offset, 20);
    });
  });
};
