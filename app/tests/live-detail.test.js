/* MultiCam — J09-09b : la modal d'une Capture montre les fonctions ACTIVES du
 * Take, pas les capacités brutes du téléphone.
 *
 * CE QUE CES TESTS FIGENT :
 *
 *   1. La SOURCE de vérité du « demandé » est le plan du Take
 *      (take.settings + captureOverrides, résolus par take-model
 *      requestedForCapture/effectiveForCapture — la MÊME fonction que l'écran
 *      05 et l'ARM). `functionsOf` ne fait que l'exprimer : rien n'est ajouté
 *      à partir de telemetry.capabilities seule.
 *   2. capability ≠ requested ≠ active. Un device PEUT (GPS/micro) mais le
 *      Take ne le demande pas → non actif. Une capability ABSENTE mais
 *      demandée → INCIDENT (indisponibilité), jamais « actif ».
 *   3. Sans plan de Take, RIEN n'est déclaré actif, et on ne dit pas « off »
 *      (qui supposerait un plan connu) : la modal dit « unknown ».
 *   4. La vidéo reste cohérente avec le rôle/plan du Take, et la section
 *      caméra/segment de la modal ne régresse pas (le travail J09-08d est
 *      intact).
 *
 * COUVERTURE :
 *   A.  GPS présent, Take GPS=off  → GPS NON actif
 *   B.  GPS présent, Take GPS=on   → GPS actif
 *   C.  micro présent, audio=off   → Audio NON actif
 *   D.  micro présent, audio=on    → Audio actif
 *   E.  fonction demandée, capability absente → INCIDENT explicite (notes)
 *   F.  vidéo cohérente avec le rôle/plan du Take
 *   G.  aucune régression caméra/segment dans la modal
 *   + : caps inconnues → unknown (jamais inventée) ; overrides de device
 *       respectés ; projection DOM des 4 états d'icône.
 */

"use strict";

function register(h) {
  const { describe, it, createEnv, loadAll, fakeDom } = h;

  function eq(actual, want, msg) {
    if (actual !== want) {
      throw new Error((msg || "valeur inattendue")
        + " — attendu " + JSON.stringify(want) + ", obtenu " + JSON.stringify(actual));
    }
  }

  const SID = "SIDAAAAA";
  const A = "aaaaaaaa-0000-0000-0000-00000000000a";      /* Capture du Take */
  const B = "bbbbbbbb-0000-0000-0000-00000000000b";      /* hors Take */

  const VIDEO = { resolution: "HD", quality: "HIGH", camera: "REAR", orientation: "AUTO" };
  const SETTINGS_OFF = {
    video: VIDEO, audio: false, gpsProfile: "OFF",
    countdownSeconds: 0, transferAuto: false, deleteLocalAfterVerifiedReplication: false
  };

  /* Capacités déjà au format normalisé take-model (forme télémétrie relayée). */
  function caps(o) {
    return Object.assign({
      unknown: false,
      audioMic: null,
      gpsFeature: null,
      cameras: { rear: ["1920x1080"], front: [] }
    }, o || {});
  }

  function take(o) {
    return Object.assign({
      takeNumber: 7,
      status: "PREPARATION",
      captures: [A],
      storages: [],
      settings: SETTINGS_OFF,
      captureOverrides: {}
    }, o || {});
  }

  function slot(did, telemetry, over) {
    return Object.assign({
      sessionId: SID, take: 7, deviceId: did, deviceName: "Cap " + did,
      isLocal: false, telemetry: telemetry || null, telemetryAt: 1000,
      lastFrame: null, lastFrameSeq: 0, lastFrameAt: 0,
      connected: true, status: "REC", displayState: "REC"
    }, over || {});
  }

  function env() {
    const e = createEnv({ fakeClock: true });
    loadAll(e, ["state/take-model.js", "state/camera-switch-model.js", "ui/live-detail.js"]);
    return e.window;
  }

  function detail(w, did, tk, cap) {
    return w.MultiCamLiveDetail.detailOf(slot(did, { capabilities: cap }, null),
      { nowMs: 1000, take: tk });
  }

  describe("J09-09b · la modal montre les fonctions ACTIVES du Take", () => {
    it("A. GPS présent mais Take GPS=off → GPS non actif (capable, non demandé)", () => {
      const w = env();
      const d = detail(w, A, take(), caps({ gpsFeature: true, audioMic: true }));
      const gps = d.functions.gps;
      eq(gps.capable, true, "le device PEUT geolocaliser");
      eq(gps.requested, false, "le Take ne le demande pas");
      eq(gps.active, false, "jamais affiché actif pour CE Take");
      eq(gps.status, "off", "statut");
    });

    it("B. GPS présent et Take GPS=on → GPS actif", () => {
      const w = env();
      const d = detail(w, A, take({ settings: Object.assign({}, SETTINGS_OFF, { gpsProfile: "PHOTO-LOG" }) }),
        caps({ gpsFeature: true }));
      const gps = d.functions.gps;
      eq(gps.capable, true, "le device PEUT geolocaliser");
      eq(gps.requested, true, "le Take le demande");
      eq(gps.active, true, "demandé ET possible → actif");
      eq(gps.status, "active", "statut");
    });

    it("C. micro présent mais audio=off → Audio non actif", () => {
      const w = env();
      const d = detail(w, A, take(), caps({ audioMic: true }));
      const audio = d.functions.audio;
      eq(audio.capable, true, "le device PEUT enregistrer le son");
      eq(audio.requested, false, "le Take ne le demande pas");
      eq(audio.active, false, "jamais affiché actif");
      eq(audio.status, "off", "statut");
    });

    it("D. micro présent et audio=on → Audio actif", () => {
      const w = env();
      const d = detail(w, A, take({ settings: Object.assign({}, SETTINGS_OFF, { audio: true }) }),
        caps({ audioMic: true }));
      const audio = d.functions.audio;
      eq(audio.capable, true, "le device PEUT enregistrer le son");
      eq(audio.active, true, "demandé ET possible → actif");
      eq(audio.status, "active", "statut");
    });

    it("E. fonction demandée mais capability absente → incident explicite", () => {
      const w = env();
      const tk = take({ settings: Object.assign({}, SETTINGS_OFF, { audio: true, gpsProfile: "NORMAL" }) });
      /* micro absent + GPS absent : les deux sont DEMANDÉS mais impossibles. */
      const d = detail(w, A, tk, caps({ audioMic: false, gpsFeature: false }));
      const audio = d.functions.audio;
      const gps = d.functions.gps;
      eq(audio.requested, true, "audio demandé");
      eq(audio.active, false, "jamais actif si la capability manque");
      eq(audio.status, "incident", "incident, pas actif");
      eq(gps.requested, true, "GPS demandé");
      eq(gps.active, false, "jamais actif");
      eq(gps.status, "incident", "incident, pas actif");
      const joined = d.notes.join(" | ");
      if (joined.indexOf("Audio demandé pour ce Take mais indisponible") < 0) {
        throw new Error("note d'incident audio absente — notes: " + JSON.stringify(d.notes));
      }
      if (joined.indexOf("GPS demandé pour ce Take mais indisponible") < 0) {
        throw new Error("note d'incident GPS absente — notes: " + JSON.stringify(d.notes));
      }
    });

    it("E2. vidéo demandée mais device sans aucune caméra → incident", () => {
      const w = env();
      /* Capacités CONNUES mais aucune caméra (la présence mic/GPS la rend
       * « mesurée »). La Capture est au plan mais n'a pas de caméra. */
      const d = detail(w, A, take(), caps({
        cameras: { rear: [], front: [] }, audioMic: true, gpsFeature: true
      }));
      const video = d.functions.video;
      eq(video.requested, true, "la Capture est dans le plan");
      eq(video.active, false, "une Capture sans caméra ne filme pas");
      eq(video.status, "incident", "incident, pas actif");
    });

    it("F. vidéo toujours cohérente avec le rôle/plan du Take", () => {
      const w = env();
      /* Même sans télémétrie, la vidéo suit le PLAN : une Capture du Take
       * filme, un device hors Take ne filme pas — jamais inventée depuis les
       * capacités. */
      const dimKnownCaps = caps({ cameras: { rear: ["1920x1080"], front: ["1280x720"] } });
      const dA = detail(w, A, take(), dimKnownCaps);
      eq(dA.functions.video.requested, true, "A participe au Take");
      eq(dA.functions.video.active, true, "A filme");
      eq(dA.functions.video.status, "active", "statut vidéo de A");

      const dB = detail(w, B, take(), dimKnownCaps);
      eq(dB.functions.video.requested, false, "B n'est pas dans le plan");
      eq(dB.functions.video.active, false, "B ne filme pas");
      eq(dB.functions.video.status, "off", "statut vidéo de B");

      /* Capacités inconnues : la vidéo reste celle du PLAN (pas d'invention). */
      const dU = detail(w, A, take(), { unknown: true });
      eq(dU.functions.video.active, true, "plan dit que A filme, même sans caps");
      eq(dU.functions.video.status, "active", "statut vidéo sans caps");
    });

    it("G. aucune régression caméra/segment dans la modal", () => {
      const w = env();
      /* Domaine D (caméra/segment) intact avec UNE Capture en cours :
       * segment 1, recording, disponibilité REAR+FRONT. */
      const camSlot = slot(A, { capabilities: caps({}) }, null);
      camSlot.camera = {
        activeCamera: "REAR", switchingCamera: "", requestedCamera: "", source: "service",
        availableCameras: ["REAR", "FRONT"], segmentIndex: 1,
        segmentState: "recording", recording: true
      };
      const dc = w.MultiCamLiveDetail.detailOf(camSlot, { nowMs: 1000, take: take() });
      eq(dc.camera.activeLabel, "Arrière", "caméra active confirmée");
      eq(dc.camera.segmentIndex, 1, "segment index");
      eq(dc.camera.segmentState, "recording", "état de segment");
      eq(dc.camera.recording, true, "relecture native");
      eq(dc.camera.hasSegment, true, "segment présent");
      eq(dc.camera.available.join(","), "REAR,FRONT", "disponibilité");
      eq(dc.cameraActions.length, 2, "actions caméra intactes");
      /* Les fonctions du Take coexistent sans avoir cassé le volet caméra. */
      eq(dc.functions.audio.status, "off", "fonctions toujours calculées");
      eq(dc.incidents.length, 0, "aucun incident fabriqué");
    });

    it("H. capacités inconnues + fonction demandée → unknown (jamais inventée)", () => {
      const w = env();
      const tk = take({ settings: Object.assign({}, SETTINGS_OFF, { audio: true, gpsProfile: "NORMAL" }) });
      const d = detail(w, A, tk, { unknown: true });
      eq(d.functions.audio.status, "unknown", "audio demandé, caps inconnues");
      eq(d.functions.audio.active, false, "jamais actif sans mesure");
      eq(d.functions.gps.status, "unknown", "GPS demandé, caps inconnues");
      eq(d.functions.gps.active, false, "jamais actif sans mesure");
      eq(d.functions.video.status, "active", "la vidéo reste celle du plan");
    });

    it("K. les overrides de device sont la source par Capture", () => {
      const w = env();
      /* Réglages globaux : audio off, GPS off. Override sur A : les deux ON. */
      const tk = take({
        captureOverrides: { [A]: { video: null, audio: true, gpsProfile: "NORMAL" } }
      });
      const d = detail(w, A, tk, caps({ audioMic: true, gpsFeature: true }));
      eq(d.functions.audio.active, true, "override audio ON respecté");
      eq(d.functions.gps.active, true, "override GPS ON respecté");
    });

    it("J. sans plan de Take → rien d'actif, tout est unknown (pas de mensonge)", () => {
      const w = env();
      /* functionsOf sans Take : « off » mentirait (non demandé suppose un plan). */
      const d = w.MultiCamLiveDetail.detailOf(slot(A, { capabilities: caps({ audioMic: true }) }), { nowMs: 1000 });
      eq(d.functions.video.status, "unknown", "aucun plan → inconnu");
      eq(d.functions.audio.status, "unknown", "aucun plan → inconnu");
      eq(d.functions.gps.status, "unknown", "aucun plan → inconnu");
      eq(d.functions.audio.active, false, "rien d'actif sans plan");
    });

    it("DOM. peinture : état d'icône par statut (on / off / missing)", () => {
      const w = env();
      const dom = fakeDom([
        "liveDetailModal", "ldClose", "ldName", "ldRecorder", "ldState",
        "ldBattery", "ldStorage", "ldNetwork", "ldTelemetryAge", "ldPreviewAge",
        "ldSkillVideo", "ldSkillAudio", "ldSkillGps", "ldImage", "ldNoImg",
        "ldIncidents", "ldCamBox", "ldCamState", "ldCamActions", "ldCamNote"
      ]);
      w.document = dom;
      /* Un seul slot factice : la modal le lit par slotOf via le live-model. */
      w.MultiCamLiveModel = {
        view() { return { slots: [slot(A, { capabilities: caps({ audioMic: true, gpsFeature: false }) })] }; }
      };
      const ld = w.MultiCamLiveDetail;
      /* Active (audio) puis incident (GPS, capability absente). */
      ld.setTakeProvider(sid => sid === SID
        ? take({ settings: { video: VIDEO, audio: true, gpsProfile: "NORMAL", countdownSeconds: 0, transferAuto: false, deleteLocalAfterVerifiedReplication: false } })
        : null);
      ld.open(A);
      eq(dom.byId["ldSkillAudio"].className, "modal-icon on", "audio demandé+possible → ON");
      eq(dom.byId["ldSkillAudio"].title, "Actif pour ce Take", "titre audio actif");
      eq(dom.byId["ldSkillGps"].className, "modal-icon off missing", "GPS demandé mais absent → MISSING");
      eq(dom.byId["ldSkillGps"].title, "Demandé pour ce Take mais indisponible", "titre GPS incident");
      /* La peinture est idempotente : re-peindre ne change pas l'état. */
      ld.refresh();
      eq(dom.byId["ldSkillGps"].className, "modal-icon off missing", "re-peinture idempotente (missing)");
      eq(dom.byId["ldSkillAudio"].className, "modal-icon on", "re-peinture idempotente (on)");
      ld.setTakeProvider(null);
    });
  });
}

module.exports = { register };