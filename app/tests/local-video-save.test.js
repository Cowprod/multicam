'use strict';
const assert = require('assert');
exports.register = function ({describe,it,createEnv,load}) {
  describe('P0 · conservation locale après STOP', () => {
    async function recording() {
      const env=createEnv({skills:['capture']});
      load(env,'native/camera-record.js');
      await env.MultiCamCameraRecord.prepare({camera:'REAR'});
      await env.MultiCamCameraRecord.startRecording({camera:'REAR'});
      return env;
    }
    it('attend la sauvegarde durable et utilise le dossier SAF configuré', async () => {
      const env=await recording();
      env.MultiCamConfig.get().storage={mode:'saf',treeUri:'content://dcim'};
      let finish; let done=false;
      env.cordova={exec(ok,ko,plugin,action,args){
        assert.strictEqual(plugin,'MultiCamSaf');assert.strictEqual(action,'saveVideo');
        assert.strictEqual(args[1],'content://dcim');finish=ok;
      }};
      const stopped=env.MultiCamCameraRecord.stopRecording().then(r=>{done=true;return r;});
      await new Promise(r=>setTimeout(r,15));
      assert.strictEqual(done,false);
      finish({path:'/files/recordings/take.mp4',publicUri:'content://dcim/take',bytes:1000,exported:true});
      const result=await stopped;
      assert.strictEqual(result.path,'/files/recordings/take.mp4');
      assert.strictEqual(result.publicUri,'content://dcim/take');
      assert.strictEqual(env.MultiCamCameraRecord.view().videoPath,result.path);
    });
    it('un export refusé conserve le fichier durable et expose son erreur', async () => {
      const env=await recording();
      env.cordova={exec(ok){ok({path:'/files/recordings/take.mp4',exported:false,exportError:'permission_denied'});}};
      const r=await env.MultiCamCameraRecord.stopRecording();
      assert.strictEqual(r.path,'/files/recordings/take.mp4');
      assert.strictEqual(r.exported,false);assert.strictEqual(r.exportError,'permission_denied');
    });
    it('un échec de copie conserve le chemin natif finalisé', async () => {
      const env=await recording(); const original=env.CameraPreview.videoPath;
      env.cordova={exec(ok,ko){ko('disk_full');}};
      const r=await env.MultiCamCameraRecord.stopRecording();
      assert.strictEqual(r.path,original);assert.strictEqual(r.exported,false);
      assert.strictEqual(r.exportError,'disk_full');
      assert.strictEqual(env.MultiCamCameraRecord.isRecording(),false);
    });
  });
};
