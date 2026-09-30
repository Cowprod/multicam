/* MultiCam — micro-harnais de test (J09).
 *
 * AUCUNE dépendance externe : les modules de `app/www/js` sont des IIFE
 * `(function (global) { ... })(window)`. On les évalue donc dans un contexte
 * `vm` dont l'objet global est le `window` simulé, ce qui permet de tester le
 * JS réel du WebView sans navigateur ni Cordova.
 *
 * Le harness fournit :
 *   - un `window` simulé (document, console capturé, timers, cordova) ;
 *   - un faux `CameraPreview` qui COMPTE les `startCamera` / `stopCamera`
 *     (indispensable pour prouver l'absence de double ouverture) ;
 *   - un faux `MultiCamConfig` pilotable ;
 *   - des helpers `tick()` / `flush()` pour laisser les Promises se résoudre.
 *
 * Usage : node tests/run.js            (toutes les suites)
 *         node tests/run.js preview    (filtrer par nom de fichier) */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WWW = path.join(__dirname, "..", "www", "js");

/* ---------- runner minimal ---------- */

const suites = [];
let current = null;

function describe(name, fn) {
  current = { name, tests: [] };
  suites.push(current);
  fn();
  current = null;
}

function it(name, fn) {
  if (!current) throw new Error("it() hors de describe()");
  current.tests.push({ name, fn });
}

/* ---------- horloge ---------- */

/* Les Promises du code testé sont résolues par la micro-queue de V8, mais le
 * faux `CameraPreview` répond via `setTimeout(0)` (macrotask) pour reproduire
 * le délai réel d'ouverture de la surface. `flush(n)` alterne donc les deux
 * files : sans ce macrotask, les assertions liraient un état antérieur à
 * l'accusé natif et tous les tests de cycle de vie seraient faussement rouges. */
async function flush(n) {
  for (let i = 0; i < (n || 8); i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/* ---------- faux DOM ---------- */

function fakeDocument(env) {
  const listeners = {};
  function mkClasses() {
    const set = new Set();
    const el = {
      className: "",
      _classes: set,
      _sync() { el.className = [...set].join(" "); }
    };
    el.classList = {
      add(c) { set.add(c); el._sync(); },
      remove(c) { set.delete(c); el._sync(); },
      contains(c) { return set.has(c); }
    };
    return el;
  }
  return {
    documentElement: mkClasses(),
    body: mkClasses(),
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const a = listeners[type] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    _fire(type, ev) { (listeners[type] || []).slice().forEach((fn) => fn(ev || { type })); },
    getElementById() { return null; },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {} }; },
    body_class() { return env.document.body.className; }
  };
}

/* ---------- faux CameraPreview plugin ---------- */

/* `startCamera` ne répond PAS immédiatement : on reproduit le délai réel
 * (surface créée + Camera.open) en Invokeant le callback sur le prochain tour,
 * ce qui permet de tester les démarrages concurrents. */
function fakeCameraPreview(env, opts) {
  opts = opts || {};
  const calls = { startCamera: 0, stopCamera: 0, startRecordVideo: 0, stopRecordVideo: 0, capturePreviewSurface: 0 };
  /* Les callbacks natifs passent par les timers de l'ENV : avec
   * `createEnv({fakeClock:true})` ils deviennent virtuels et pilotables. */
  const later = (fn, ms) => (env.setTimeout || setTimeout)(fn, ms);
  const api = {
    CAMERA_DIRECTION: { BACK: "back", FRONT: "front" },
    calls,
    lastStartOptions: null,
    lastRecordOptions: null,
    /* knobs de test */
    failStartCamera: opts.failStartCamera || null,
    failRecord: opts.failRecord || false,
    videoPath: opts.videoPath || "file:///storage/emulated/0/Movies/take.mp4",
    /* actions de contrôle appelées par les tests */
    pause() { env.document._fire("pause"); },
    resume() { env.document._fire("resume"); },
    setFailStartCamera(e) { api.failStartCamera = e; },

    startCamera(o, ok, ko) {
      calls.startCamera += 1;
      api.lastStartOptions = o;
      later(() => {
        if (api.failStartCamera) { if (ko) ko(String(api.failStartCamera)); return; }
        if (ok) ok("Camera started");
      }, 0);
    },
    stopCamera(ok, ko) {
      calls.stopCamera += 1;
      later(() => { if (ok) ok("Camera stopped"); }, 0);
    },
    startRecordVideo(o, ok, ko) {
      calls.startRecordVideo += 1;
      api.lastRecordOptions = o;
      later(() => {
        if (api.failRecord) { if (ko) ko("record_failed"); return; }
        if (ok) ok("OK");
      }, 0);
    },
    stopRecordVideo(ok, ko) {
      calls.stopRecordVideo += 1;
      later(() => { if (ok) ok(api.videoPath); }, 0);
    },

    /* ---------- PixelCopy (J09-03) ---------- */
    /* `mode:"auto"` : le callback répond après `latencyMs` (timer virtuel si
     * `createEnv({fakeClock:true})`). `mode:"manual"` : rien ne part tout seul,
     * le test appelle `settlePixelCopy("ok"|"ko")` — c'est ce qui permet de
     * prouver le verrou « une seule capture en vol » SANS dépendre du timing.
     * `maxInFlight` est la métrique de non-concurrence du smoke. */
    capturePreviewSurface(o, ok, ko) {
      calls.capturePreviewSurface += 1;
      api.pixelCopy.calls += 1;
      const p = api.pixelCopy;
      p.inFlight += 1;
      if (p.inFlight > p.maxInFlight) p.maxInFlight = p.inFlight;
      const job = {
        opts: o,
        settle(which, data) {
          p.inFlight -= 1;
          p.done += 1;
          if (which === "ko") { if (ko) ko(p.failWith || "pixelcopy_error"); }
          else if (ok) ok(data !== undefined ? data : p.payload()); }
      };
      p.pending.push(job);
      if (p.mode === "auto") {
        later(() => {
          p.pending = p.pending.filter((j) => j !== job);
          if (p.failWith) job.settle("ko"); else job.settle("ok");
        }, p.latencyMs);
      }
    }
  };

  /* Base64 factice de taille contrôlée : sert à mesurer la taille d'image sans
   * encoder un vrai JPEG. `len` = longueur base64 visée. */
  api.pixelCopy = {
    mode: opts.pixelCopyMode || "auto",
    latencyMs: opts.pixelCopyLatencyMs || 0,
    failWith: opts.pixelCopyFailWith || null,
    base64Length: opts.pixelCopyBase64Length || 40000,
    inFlight: 0, maxInFlight: 0, pending: [], calls: 0, done: 0,
    payload() {
      let s = "";
      const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      while (s.length < this.base64Length) s += A.charAt(s.length % A.length);
      return s.slice(0, this.base64Length);
    },
    /* Résout la capture en vol la plus ancienne. */
    settle(which, data) {
      const job = this.pending.shift();
      if (!job) throw new Error("settlePixelCopy : aucune capture en vol");
      job.settle(which, data);
    }
  };
  return api;
}

/* ---------- environnement ---------- */

/* ---------- horloge pilotable (J09-03) ---------- */

/* Remplace `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` et
 * `Date.now()` par un compteur virtual, piloté par `await env.clock.advance(ms)`.
 *
 * Pourquoi : le sampler PixelCopy a une cadence nominale de 1000 ms. Tester le
 * rythme, l'absence de chevauchement et l'absence de timer résiduel avec de
 * vraies secondes rendrait la suite lente (30 s+ par cas) et flaky. On vérifie
 * ici la LOGIQUE de planification sur une horloge déterministe ; la cadence
 * réelle est qualifiée séparément par le smoke physique.
 *
 * `advance()` alterne les timers virtuels et la micro-queue des Promises
 * (comme `flush()` pour les macrotasks), sinon les assertions liraient un état
 * antérieur à la résolution des Promises déclenchées par un timer. */
function fakeClock(env) {
  const RealDate = Date;
  let now = 1700000000000;
  let seq = 0;
  const timers = new Map();

  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  function schedule(fn, ms, every) {
    const id = ++seq;
    const delay = Math.max(0, Number(ms) || 0);
    timers.set(id, { id, at: now + delay, delay, every, fn });
    return id;
  }

  env.setTimeout = (fn, ms) => schedule(fn, ms, 0);
  env.setInterval = (fn, ms) => schedule(fn, ms, Math.max(1, Number(ms) || 1));
  env.clearTimeout = (id) => { timers.delete(id); };
  env.clearInterval = (id) => { timers.delete(id); };

  class VirtualDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(now); else super(...a); }
    static now() { return now; }
  }
  env.Date = VirtualDate;

  env.clock = {
    now: () => now,
    /* Nombre de timers EN ATTENTE : permet d'affirmer « aucun timer résiduel ». */
    pending: () => timers.size,
    ids: () => [...timers.keys()],
    async advance(ms) {
      const target = now + (Number(ms) || 0);
      let fired = 0;
      for (;;) {
        /* On laisse d'abord les Promises en VOL planifier leurs timers AVANT de
         * scanner : une implémentation qui différе son travail (le
         * `serialize(apply)` de preview-service) installerait sinon son timer
         * APRÈS le scan, et il ne serait jamais déclenché. */
        await settle();
        let best = null;
        for (const t of timers.values()) {
          if (t.at > target) continue;
          if (!best || t.at < best.at || (t.at === best.at && t.id < best.id)) best = t;
        }
        if (!best) break;
        now = best.at;
        if (best.every) best.at = now + best.delay;
        else timers.delete(best.id);
        best.fn();
        if (++fired > 200000) throw new Error("clock.advance : boucle de timers sans fin");
      }
      now = target;
      await settle();
    },
    reset() { timers.clear(); }
  };
  return env;
}

function createEnv(opts) {
  opts = opts || {};
  const logs = [];
  const env = {
    console: {
      log() { logs.push([].slice.call(arguments).join(" ")); },
      warn() {}, error() {}
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp,
    Uint8Array, ArrayBuffer, isFinite, parseInt, parseFloat,
    navigator: { userAgent: "node" },
    screen: { width: 800, height: 1280 },
    innerWidth: 800, innerHeight: 1280,
    localStorage: {
      _v: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
      setItem(k, v) { this._v[k] = String(v); }
    }
  };
  env.window = env;
  env.globalThis = env;
  env.logs = logs;
  env.logText = () => logs.join("\n");
  env.document = fakeDocument(env);
  env.window.addEventListener = env.document.addEventListener.bind(env.document);
  env.window.removeEventListener = env.document.removeEventListener.bind(env.document);
  env.window.dispatchEvent = env.document._fire.bind(env.document);

  env.CameraPreview = opts.noPlugin ? null : fakeCameraPreview(env, opts);
  if (opts.fakeClock) fakeClock(env);
  env.MultiCamConfig = opts.config || {
    _cfg: { deviceId: "DEV-1", deviceName: "Cam 07", enabledSkills: opts.skills || ["capture", "controller"], supportedSkills: ["capture", "storage", "controller"], permissions: {} },
    load() { return Promise.resolve(this._cfg); },
    get() { return this._cfg; },
    setSkill(skill, enabled) {
      const i = this._cfg.enabledSkills.indexOf(skill);
      if (enabled && i < 0) this._cfg.enabledSkills.push(skill);
      if (!enabled && i >= 0) this._cfg.enabledSkills.splice(i, 1);
      return Promise.resolve(this._cfg);
    },
    skillMeta: { capture: { icon: "fa-video", label: "Capture" } }
  };
  return env;
}

/* Charge un module de app/www/js dans l'environnement `env`. */
function load(env, relPath) {
  const file = path.join(WWW, relPath);
  const code = fs.readFileSync(file, "utf8");
  vm.runInContext(code, vm.createContext(env), { filename: file });
  return env;
}

function loadAll(env, relPaths) {
  relPaths.forEach((p) => load(env, p));
  return env;
}

module.exports = { describe, it, suites, createEnv, load, loadAll, flush, WWW };
