"use strict";
const assert = require("node:assert/strict");
const api = require("../www/js/ui/storage-pairing.js");

class Socket {
  static made = [];
  constructor(url) { this.url=url; this.readyState=0; this.listeners={}; this.closed=false; Socket.made.push(this); }
  addEventListener(n, f) { (this.listeners[n] ||= []).push(f); }
  fire(n) { if(n==="open") this.readyState=1; if(n==="close") this.readyState=3; (this.listeners[n]||[]).forEach(fn=>fn()); }
  close() { this.closed=true; this.readyState=3; }
}
const params=()=>({ endpoint:"10.52.10.1:45102", sessionId:"session-1",
  masterDeviceId:"master-1", storageDeviceId:"storage-1",
  pairingCode:"paWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaU" });
exports.register=function(h) {
  h.describe("External Storage manual pairing link", function () {
    h.it("refuses malformed IDs, endpoints and PIN without a socket", async function () {
      const link=api.createLink({Socket,auth:{sendProof:()=>Promise.resolve({authenticated:true})}});
      let p=params(); p.pairingCode="1234";
      assert.equal(await link.connect(p),false);
      p=params(); p.endpoint="10.52.10.1:45102/path"; assert.equal(await link.connect(p),false);
      p=params(); p.storageDeviceId="../storage"; assert.equal(await link.connect(p),false);
      assert.equal(api.endpoint("host.local:45102"),"ws://host.local:45102/");
      assert.equal(api.endpoint("host.local:65536"),null);
    });
    h.it("keeps authenticated WS open, drops binding on explicit stop", async function () {
      const states=[];
      const link=api.createLink({Socket,onState:s=>states.push(s),
        auth:{sendProof:async (ws, opts)=>{
          assert.equal(opts.sessionId,"session-1");
          assert.equal(opts.pairingCode,params().pairingCode);
          return {authenticated:true};
        }}});
      const result=link.connect(params());
      const ws=Socket.made.at(-1);
      assert.equal(ws.url,"ws://10.52.10.1:45102/");
      ws.fire("open");
      assert.equal(await result,true);
      assert.equal(link.status(),"authenticated");
      assert.equal(ws.closed,false);
      link.stop();
      assert.equal(ws.closed,true);
      assert.equal(link.status(),"disconnected");
    });
    h.it("rejects a false authentication and closes its socket", async function () {
      const link=api.createLink({Socket,auth:{sendProof:()=>Promise.resolve({authenticated:false})}});
      const result=link.connect(params()), ws=Socket.made.at(-1);
      ws.fire("open");
      assert.equal(await result,false);
      assert.equal(link.status(),"failed");
      assert.equal(ws.closed,true);
    });
    h.it("cancels an in-flight connection without late authentication", async function () {
      const link=api.createLink({Socket,auth:{sendProof:()=>Promise.resolve({authenticated:true})}});
      const result=link.connect(params()), ws=Socket.made.at(-1);
      link.stop();
      ws.fire("open");
      assert.equal(await result,false);
      assert.equal(link.status(),"disconnected");
      assert.equal(ws.closed,true);
    });
  });
};
