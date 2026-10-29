'use strict';
const assert = require('assert');
exports.register = h => {
 const click = node => (node._listeners.click || []).forEach(fn => fn.call(node, {type:"click",target:node}));
 h.describe('REC depuis les boutons de production',()=>{
  function arm() {
   const e=h.createEnv({});
   const dom=h.fakeDom(['armTakeName','armEmpty','armList','armRec','armStartError','armIncidentError','armIncidentModal','armIncidentIntro','armIncidentList','backArm','armIncidentContinue','armIncidentCancel','armIncidentClose','deviceNameArm']);
   e.document=dom;
   const v={sid:'S1',takeNumber:7,armCycleId:'S1#7#1',devices:[],rev:1,recEligible:true,incidentsEmpty:false,incidents:[{skill:'capture',skillStatus:'WARNING',status:'warn',deviceName:'Cam',message:'Espace libre inconnu'}]};
   e.MultiCamArmService={view:()=>v,onView(){},start:()=>Promise.resolve(v)};
   h.load(e,'ui/arm.js'); e.MultiCamArmScreen.show({deviceName:'Master'},{sid:'S1'});
   return {e,dom};
  }
  h.it('un refus après Continuer REC reste visible dans la fenêtre',async()=>{
   const {e,dom}=arm();let calls=0;
   e.MultiCamStartService={requestStart(){calls++;return Promise.reject(new Error('local_stopped_take'));}};
   click(dom.byId.armRec);
   click(dom.byId.armIncidentContinue);
   await h.flush(10);
   assert.strictEqual(calls,1);
   assert(dom.byId.armIncidentModal.classList.contains('show'));
   assert.match(dom.byId.armIncidentError.textContent,/déjà arrêté/);
   assert.strictEqual(dom.byId.armIncidentContinue.disabled,false);
  });
  h.it('un double clic ne crée qu’un START et ferme la fenêtre après succès',async()=>{
   const {e,dom}=arm();let calls=0,finish;
   e.MultiCamStartService={requestStart(){calls++;return new Promise(r=>{finish=r;});}};
   click(dom.byId.armRec);
   click(dom.byId.armIncidentContinue);
   click(dom.byId.armIncidentContinue);
   await h.flush(5);
   assert.strictEqual(calls,1);assert(dom.byId.armIncidentModal.classList.contains('show'));
   finish({startPlanId:'new-plan'});await h.flush(5);
   assert(!dom.byId.armIncidentModal.classList.contains('show'));
  });
  function stopped(status,newTake){
   const e=h.createEnv({});const nav=[];
   const dom=h.fakeDom(['tsSession','tsTake','tsState','tsDuration','tsList','tsDone','tsNextError']);e.document=dom;
   e.MultiCamStartService={view:()=>({sid:'S1',takeNumber:7}),machine:()=>({state:{plan:{participants:[]}}})};
   e.MultiCamSessionStore={get:()=>Promise.resolve({sessionId:'S1',takes:[{status}]})};
   e.MultiCamSessionWs={newTake};e.MultiCamNav={show:(...args)=>nav.push(args)};
   h.load(e,'ui/take-stopped.js');e.MultiCamTakeStoppedScreen.show({},{sid:'S1'});
   return {dom,nav};
  }
  h.it('une préparation déjà créée est réutilisée sans Take supplémentaire',async()=>{
   let calls=0;const {dom,nav}=stopped('PREPARATION',()=>{calls++;});
   click(dom.byId.tsDone);await h.flush(10);
   assert.strictEqual(calls,0);assert.strictEqual(nav.length,1);
  });
  h.it('la création échouée ne quitte pas l’écran et affiche une erreur',async()=>{
   let calls=0;const {dom,nav}=stopped('TERMINATED',()=>{calls++;return Promise.reject(new Error('disk_error'));});
   click(dom.byId.tsDone);click(dom.byId.tsDone);
   await h.flush(10);
   assert.strictEqual(calls,1);assert.strictEqual(nav.length,0);
   assert.match(dom.byId.tsNextError.textContent,/Impossible/);assert.strictEqual(dom.byId.tsDone.disabled,false);
  });
 });
};
