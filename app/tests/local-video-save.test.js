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
    it('confirme STOP sans attendre la copie SAF, en conservant son état séparé', async () => {
      const env=await recording(); const original=env.CameraPreview.videoPath;
      env.MultiCamConfig.get().storage={mode:'saf',treeUri:'content://dcim'};
      let finish;
      env.cordova={exec(ok,ko,plugin,action,args){
        assert.strictEqual(plugin,'MultiCamSaf');assert.strictEqual(action,'saveVideo');
        assert.strictEqual(args[1],'content://dcim');finish=ok;
      }};
      const result=await env.MultiCamCameraRecord.stopRecording();
      assert.strictEqual(result.path,original);
      assert.strictEqual(env.MultiCamCameraRecord.isRecording(),false);
      assert.strictEqual(env.MultiCamCameraRecord.view().exports[original].state,'saving');
      finish({path:'/files/recordings/take.mp4',publicUri:'content://dcim/take',bytes:1000,exported:true});
      assert.strictEqual(env.MultiCamCameraRecord.view().exports[original].state,'saved');
      assert.strictEqual(env.MultiCamCameraRecord.view().exports[original].publicUri,'content://dcim/take');
      assert.strictEqual(env.MultiCamCameraRecord.view().videoPath,original);
    });
    it('un export refusé conserve le MP4 finalisé et expose son erreur séparément', async () => {
      const env=await recording();const original=env.CameraPreview.videoPath;
      env.cordova={exec(ok){ok({path:'/files/recordings/take.mp4',exported:false,exportError:'permission_denied'});}};
      const r=await env.MultiCamCameraRecord.stopRecording();
      assert.strictEqual(r.path,original);
      assert.strictEqual(env.MultiCamCameraRecord.view().exports[original].error,'permission_denied');
      assert.strictEqual(env.MultiCamCameraRecord.view().exports[original].state,'error');
    });
    it('un échec de copie ne transforme pas un STOP natif réussi en REC', async () => {
      const env=await recording(); const original=env.CameraPreview.videoPath;
      env.cordova={exec(ok,ko){ko('disk_full');}};
      const r=await env.MultiCamCameraRecord.stopRecording();
      assert.strictEqual(r.path,original);
      assert.strictEqual(env.MultiCamCameraRecord.view().exports[original].error,'disk_full');
      assert.strictEqual(env.MultiCamCameraRecord.isRecording(),false);
    });
    it('un bridge de publication en exception ne refuse pas le STOP natif', async () => {
      const env=await recording();const original=env.CameraPreview.videoPath;
      env.cordova={exec(){throw new Error('bridge_unavailable');}};
      const result=await env.MultiCamCameraRecord.stopRecording();
      assert.strictEqual(result.path,original);
      assert.strictEqual(env.MultiCamCameraRecord.isRecording(),false);
      assert.match(env.MultiCamCameraRecord.view().exports[original].error,/bridge_unavailable/);
    });
    it('une publication tardive ne remplace pas le chemin du Take suivant', async () => {
      const env=await recording();const one=env.CameraPreview.videoPath;
      const callbacks=[];env.cordova={exec(ok){callbacks.push(ok);}};
      await env.MultiCamCameraRecord.stopRecording();
      env.CameraPreview.videoPath='/cache/take-two.mp4';
      await env.MultiCamCameraRecord.startRecording({camera:'REAR'});
      await env.MultiCamCameraRecord.stopRecording();
      callbacks[1]({path:'/files/two.mp4',publicUri:'content://two',bytes:100,exported:true});
      callbacks[0]({path:'/files/one.mp4',publicUri:'content://one',bytes:100,exported:true});
      const v=env.MultiCamCameraRecord.view();
      assert.strictEqual(v.videoPath,'/cache/take-two.mp4');
      assert.strictEqual(v.exports[one].state,'saved');
      assert.strictEqual(v.exports['/cache/take-two.mp4'].state,'saved');
    });
  });
};
