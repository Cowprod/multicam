/* Couverture pre-session: vrai PixelCopy, controle LAN, anti-rejeu et UI.
 * Horloge virtuelle et CameraPreview factice, aucune emission de MP4. */
"use strict";
const fs = require("fs"), path = require("path");
function register(h) {
  const { describe, it, createEnv, loadAll } = h;
  function assert(c, m) { if (!c) throw new Error(m || "assertion failed"); }
  const JPEG = "/9j/AA==";
  const ID = "0123456789abcdef0123456789abcdef";
  function envWithSampler() {
    const env = createEnv({fakeClock:true,skills:["capture","controller"],pixelCopyMode:"auto"});
    loadAll(env, ["native/pixelcopy.js","native/camera-record.js",
      "state/preview-service.js","state/preview-sampler.js"]);
    env.CameraPreview.pixelCopy.payload = () => JPEG;
    return env;
  }
  async function ready(env) {
    const p = env.MultiCamPreviewService.bind();
    await env.clock.advance(30);
    await p;
  }
  function fakeNet(env, ps) {
    env.MultiCamNet = {peers(){return ps;}};
    env.crypto = {getRandomValues(a){for(let i=0;i<a.length;i++)a[i]=i+1;return a;}};
    const asked=[];
    env.MultiCamSessionWs = {
      setDiscoveryPreviewBridge(b){env.bridge=b;},
      requestDiscoveryPreview(did,req){asked.push({did,req});return Promise.resolve(true);}
    };
    loadAll(env, ["state/discovery-preview-service.js"]);
    env.MultiCamDiscoveryPreviewService.bind(env.MultiCamConfig.get());
    return asked;
  }
  describe("Discovery JPEG — PixelCopy partage avec le sampler existant", () => {
    it("D1. hors session et hors REC, une image native est produite sans recorder", async () => {
      const env = envWithSampler();
      await ready(env);
      assert(!env.MultiCamCameraRecord.view().recording, "precondition REC");
      const p = env.MultiCamPreviewSampler.discoverySnapshot();
      await env.clock.advance(20);
      const f = await p;
      assert(f && f.base64 === JPEG, "JPEG PixelCopy absent");
      assert(env.CameraPreview.calls.capturePreviewSurface === 1, "une seule capture");
      assert(env.CameraPreview.calls.startRecordVideo === 0, "aucun MediaRecorder ne doit demarrer");
      assert(!env.MultiCamPreviewSampler.view().running, "pas de boucle sampler permanente");
    });
    it("D2. une demande pre-session en vol bloque la premiere capture concurrente du sampler", async () => {
      const env = envWithSampler();
      await ready(env);
      env.CameraPreview.pixelCopy.mode = "manual";
      const one = env.MultiCamPreviewSampler.discoverySnapshot();
      assert(env.CameraPreview.calls.capturePreviewSurface === 1, "premiere demande native");
      assert(env.MultiCamPreviewSampler.start({sessionId:"S1",takeNumber:1,previewOnly:true}), "sampler session");
      assert(env.CameraPreview.calls.capturePreviewSurface === 1, "double PixelCopy interdit");
      env.CameraPreview.pixelCopy.settle("ok", JPEG);
      await env.clock.advance(0); await one;
      await env.clock.advance(1000);
      assert(env.CameraPreview.calls.capturePreviewSurface === 2, "sampler reprend au tick suivant");
      assert(env.CameraPreview.pixelCopy.maxInFlight === 1, "jamais deux captures en vol");
      env.MultiCamPreviewSampler.stop("test");
    });
    it("D3. en arriere-plan, aucun snapshot n'est produit", async () => {
      const env = envWithSampler();
      await ready(env);
      env.CameraPreview.pause();
      await env.clock.advance(30);
      const x = await env.MultiCamPreviewSampler.discoverySnapshot();
      assert(x === null && env.CameraPreview.calls.capturePreviewSurface === 0, "camera fermee en background");
    });
  });
  describe("Discovery JPEG — autorisation pre-session et debit borne", () => {
    it("D4. un peer Controller connu et meme IPv4 recoit un JPEG, sans session", async () => {
      const env = createEnv({fakeClock:true,skills:["capture"]});
      fakeNet(env,[{deviceId:"CTRL",enabledSkills:["controller"],state:"online",lastResolveMs:env.clock.now(),wsEndpoint:"192.168.1.3:45102"}]);
      env.MultiCamPreviewService = {view(){return {foreground:true,captureEnabled:true};}};
      env.MultiCamPreviewSampler = {discoverySnapshot(){return Promise.resolve({base64:JPEG,bytes:4,capturedAt:env.clock.now()});}};
      let out=null;
      assert(env.bridge.onRequest({from:"CTRL",requestId:ID},{remoteAddr:"/192.168.1.3:40200"},function(f){out=f;return true;}), "autorisation LAN");
      await Promise.resolve(); await Promise.resolve();
      assert(out && out.requestId === ID && out.jpegBase64 === JPEG, "reponse JPEG manquante");
      assert(!env.MultiCamSessionStore, "aucun store/session requis");
      assert(!env.bridge.onRequest({from:"CTRL",requestId:ID},{remoteAddr:"192.168.1.3"},()=>true), "limiteur global");
    });
    it("D5. IP et role mDNS non valides sont refuses", () => {
      const env=createEnv({fakeClock:true,skills:["capture"]});
      const peer={deviceId:"CTRL",enabledSkills:["controller"],state:"online",lastResolveMs:env.clock.now(),wsEndpoint:"192.168.1.3:45102"};
      fakeNet(env,[peer]);
      env.MultiCamPreviewService={view(){return {foreground:true,captureEnabled:true};}};
      let invoked=0;
      env.MultiCamPreviewSampler={discoverySnapshot(){invoked++;return Promise.resolve(null);}};
      assert(!env.bridge.onRequest({from:"CTRL",requestId:ID},{remoteAddr:"192.168.1.99"},()=>true),"IP differente");
      peer.enabledSkills=[];
      assert(!env.bridge.onRequest({from:"CTRL",requestId:ID},{remoteAddr:"192.168.1.3"},()=>true),"pas controller");
      assert(invoked===0,"PixelCopy ne doit pas etre solicite");
    });
    it("D6. seul le vrai nonce permet d'accepter la frame, puis elle perime", async () => {
      const env=createEnv({fakeClock:true,skills:["controller"]});
      const peer={deviceId:"CAP",enabledSkills:["capture"],state:"online",lastResolveMs:env.clock.now(),wsEndpoint:"192.168.1.4:45102"};
      const asked=fakeNet(env,[peer]);
      const svc=env.MultiCamDiscoveryPreviewService;
      svc.setHomeVisible(true);
      await env.clock.advance(100);
      assert(asked.length===1 && asked[0].did==="CAP", "une demande au peer decouvert");
      assert(!svc._onFrame({from:"CAP",requestId:ID,seq:1,mime:"image/jpeg",jpegBase64:JPEG,bytes:4}),"nonce errone refuse");
      const good={from:"CAP",requestId:asked[0].req,seq:1,mime:"image/jpeg",jpegBase64:JPEG,bytes:4};
      assert(svc._onFrame(good) && svc.latest("CAP"),"frame reelle recue");
      assert(!svc._onFrame(good), "nonce rejoue refuse");
      await env.clock.advance(5100);
      assert(svc.latest("CAP")===null, "la vignette ne doit pas pretendre etre vivante apres 5 s");
      svc.setHomeVisible(false);
      const before=asked.length;
      await env.clock.advance(8000);
      assert(asked.length===before, "aucun polling hors accueil");
    });
    it("D7. un payload de plus de 128KiB ne peut etre affiche", async () => {
      const env=createEnv({fakeClock:true,skills:["controller"]});
      const peer={deviceId:"CAP",enabledSkills:["capture"],state:"online",lastResolveMs:env.clock.now(),wsEndpoint:"192.168.1.4:45102"};
      const asked=fakeNet(env,[peer]);
      env.MultiCamDiscoveryPreviewService.setHomeVisible(true); await env.clock.advance(100);
      assert(!env.MultiCamDiscoveryPreviewService._onFrame({from:"CAP",requestId:asked[0].req,seq:1,
        mime:"image/jpeg",jpegBase64:"/9j/"+("A".repeat(174800)),bytes:131072}), "taille bornee");
    });
  });
  describe("Discovery JPEG — garde-fous de livraison", () => {
    it("D8. la home affiche seulement un IMG JPEG conditionnel et une modal retour", () => {
      const root=path.join(__dirname,"..","www");
      const home=fs.readFileSync(path.join(root,"js/ui/home.js"),"utf8");
      const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
      assert(home.includes("data-discovery-preview") && home.includes("En attente de preview"), "slots reels manquants");
      assert(html.includes('id="discoveryPreviewBack"') && html.includes('id="discoveryPreviewLarge"'), "modal retour absente");
      assert(html.includes("js/state/discovery-preview-service.js") && html.includes("js/ui/home-preview.js"), "modules non charges");
    });
    it("D9. le transport de session ne traite pas le cadrage decouverte comme un Take", () => {
      const src=fs.readFileSync(path.join(__dirname,"..","www/js/net/session-ws.js"),"utf8");
      assert(src.includes('case "discovery_preview_request"') && src.includes('case "discovery_preview_frame"'),"routage absent");
      assert(src.includes('requestDiscoveryPreview: requestDiscoveryPreview'),"appel cible absent");
      assert(src.includes('return sendReply(entry, serverConn, "discovery_preview_frame", null, payload)'),"reponse meme socket");
    });
  });
}
module.exports={register};
