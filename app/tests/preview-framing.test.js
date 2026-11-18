/* Cadrage avant REC et reprise apres STOP: tests locaux sans GitHub Actions. */
"use strict";

function register(h) {
  const { describe, it, createEnv, loadAll, flush } = h;
  function eq(a, b, m) { if (a !== b) throw new Error(m + ": attendu " + b + ", recu " + a); }
  function yes(x, m) { if (!x) throw new Error(m); }

  function fakeService() {
    const env = createEnv();
    const session = { sessionId: "SESSION_A", state: "open", updatedAtMs: 10,
      members: [{ deviceId: "DEV-1" }, { deviceId: "DEV-2" }],
      masters: [{ deviceId: "DEV-2" }],
      takes: [{ takeNumber: 3, captures: ["DEV-1"] }] };
    let recording = false, prepared = true, foreground = true, phase = "IDLE";
    let sessionChanged = null, cameraChanged = null, startChanged = null;
    const starts = [], stops = [];
    let samplerState = { running: false, previewOnly: false, sessionId: "", takeNumber: "" };
    env.MultiCamSessionStore = { list: () => Promise.resolve([session]) };
    env.MultiCamCameraRecord = { view: () => ({ recording, prepared }) };
    env.MultiCamPreviewService = {
      view: () => ({ foreground, captureEnabled: true }),
      onView: fn => { cameraChanged = fn; }
    };
    env.MultiCamStartService = {
      view: () => ({ sid: "SESSION_A", active: phase !== "IDLE", phase }),
      onView: fn => { startChanged = fn; }
    };
    env.MultiCamSessionWs = { onChanged: fn => { sessionChanged = fn; } };
    env.MultiCamPreviewSampler = {
      view: () => samplerState,
      start: opts => { starts.push(opts); samplerState = { running: true,
        previewOnly: opts.previewOnly, sessionId: opts.sessionId, takeNumber: String(opts.takeNumber) }; return true; },
      stop: reason => { stops.push(reason); samplerState = Object.assign({}, samplerState, { running: false }); }
    };
    loadAll(env, ["state/preview-framing-service.js"]);
    return { env, session, starts, stops,
      recording: v => { recording = v; },
      prepared: v => { prepared = v; },
      foreground: v => { foreground = v; },
      phase: v => { phase = v; },
      sessionChanged: () => sessionChanged && sessionChanged(),
      cameraChanged: () => cameraChanged && cameraChanged(),
      startChanged: () => startChanged && startChanged(),
      sampler: () => samplerState,
      samplerStopped: () => { samplerState = Object.assign({}, samplerState, { running: false, previewOnly: false }); }
    };
  }

  describe("Cadrage Master - cycle de vie avant REC et apres STOP", () => {
    it("F1. Capture selectionnee: diffusion JPEG avant REC, sans appel recorder", async () => {
      const x = fakeService();
      await x.env.MultiCamPreviewFramingService.bind({ deviceId: "DEV-1" });
      eq(x.starts.length, 1, "un seul lancement");
      eq(x.starts[0].previewOnly, true, "mode previewOnly");
      eq(x.starts[0].takeNumber, 3, "Take courant");
      eq(x.starts[0].sessionId, "SESSION_A", "session ouverte");
      await x.env.MultiCamPreviewFramingService.reconcile("duplicate");
      eq(x.starts.length, 1, "idempotence");
    });

    it("F2. Storage seul, Capture non selectionnee ou session close: pas de diffusion", async () => {
      const x = fakeService();
      x.session.takes[0].captures = ["DEV-2"];
      await x.env.MultiCamPreviewFramingService.bind({ deviceId: "DEV-1" });
      eq(x.starts.length, 0, "pas de sampler pour un role non Capture");
      x.session.takes[0].captures = ["DEV-1"];
      x.sessionChanged();
      await flush(3);
      eq(x.starts.length, 1, "capture selectionnee rejoint le flux");
      x.session.state = "closed";
      x.sessionChanged();
      await flush(3);
      yes(x.stops.length >= 1, "session close arrete previewOnly");
    });

    it("F3. En REC le recorder garde son sampler, puis le cadrage reprend apres STOP", async () => {
      const x = fakeService();
      await x.env.MultiCamPreviewFramingService.bind({ deviceId: "DEV-1" });
      x.recording(true);
      x.phase("REC");
      x.samplerStopped();
      x.startChanged();
      await flush(3);
      eq(x.starts.length, 1, "pas de redemarrage pendant REC");
      x.recording(false);
      x.phase("STOPPED");
      x.startChanged();
      await flush(3);
      eq(x.starts.length, 2, "cadrage repris apres STOP");
      eq(x.starts[1].previewOnly, true, "jamais d'enregistrement induit");
    });

    it("F4. Arriere-plan ou preview inactive suspend l'emission", async () => {
      const x = fakeService();
      await x.env.MultiCamPreviewFramingService.bind({ deviceId: "DEV-1" });
      x.foreground(false);
      x.cameraChanged();
      await flush(3);
      yes(x.stops.length >= 1, "previewOnly stoppee en arriere-plan");
      x.foreground(true);
      x.prepared(false);
      x.cameraChanged();
      await flush(3);
      eq(x.starts.length, 1, "pas de reprise sans SurfaceView prete");
      x.prepared(true);
      x.cameraChanged();
      await flush(3);
      eq(x.starts.length, 2, "reprise quand la SurfaceView revient");
    });
  });

  describe("PixelCopy en mode cadrage", () => {
    it("F5. prepared sans recording accepte PixelCopy mais ne lance pas MediaRecorder", async () => {
      const env = createEnv({ skills: ["capture"], pixelCopyMode: "manual" });
      loadAll(env, ["native/pixelcopy.js", "native/camera-record.js",
        "state/preview-service.js", "state/preview-sampler.js"]);
      const p = env.MultiCamCameraRecord.prepare({ startPlanId: "TEST" });
      await flush(5); await p;
      yes(env.MultiCamCameraRecord.view().prepared, "camera prete");
      eq(env.MultiCamCameraRecord.view().recording, false, "aucun REC");
      const started = env.MultiCamPreviewSampler.start({
        sessionId: "SESSION_A", takeNumber: 3, previewOnly: true
      });
      yes(started, "sampler demarre avant REC");
      eq(env.CameraPreview.calls.capturePreviewSurface, 1, "premier PixelCopy immediat");
      eq(env.CameraPreview.calls.startRecordVideo, 0, "MediaRecorder jamais invoque");
      env.MultiCamPreviewSampler.stop("test_end");
    });
  });
}

module.exports = { register };
