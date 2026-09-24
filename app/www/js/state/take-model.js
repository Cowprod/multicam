/* MultiCam — modèle pur J06 du Take (écran 05) et des capacités Capture.
 * Module "UMD-lite" : utilisable dans l'app (window.MultiCamTakeModel) ET
 * chargeable en Node pour tester la convergence/fallback de manière déterministe
 * (tests/plugin-lab/session/take-model.test.js).
 *
 * Décisions figées (MULTICAM_DECISIONS_REFERENCE §32 + mission J06 + UI 05) :
 *  - premier Take : aucune Capture ni Storage sélectionnés, réglages par défaut ;
 *  - Takes suivants : héritent des sélections, réglages et overrides du précédent
 *    (copie profonde — Take 002 ne mute JAMAIS Take 001) ;
 *  - le réglage global peut dépasser les capacités d'un device : best effort par
 *    device + warning indicatif, jamais de réduction du global au plus petit
 *    dénominateur commun, jamais de blocage ARM pour une capacité ;
 *  - mapping natif : HD→720P, FHD→1080P, 4K→2160P ; fallback = meilleure
 *    résolution inférieure supportée, warning « 4K indisponible → Full HD » ;
 *  - gpsFeature=false → GPS effectif Off, warning « GPS Normal indisponible → Off » ;
 *  - warnings calculés par rapport aux RÉGLAGES GLOBAUX (jamais l'override) ;
 *  - overrides : Vidéo/Audio/GPS uniquement ; Hériter = null ; une capacité
 *    inconnue n'est JAMAIS inventée (flag capsUnknown, comportement sûr).
 *
 * Les valeurs persistées sont des identifiants stables (FHD/HIGH/REAR/LANDSCAPE/
 * NORMAL/...), les étiquettes françaises ne sont qu'un rendu (cf. ui/05).
 */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(root);
  } else {
    root.MultiCamTakeModel = factory(root);
  }
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  /* ---------- constantes ---------- */

  var RESOLUTIONS = ["HD", "FHD", "4K"];
  var QUALITIES = ["ECO", "NORMAL", "HIGH"];
  var CAMERAS = ["REAR", "FRONT"];
  var ORIENTATIONS = ["LANDSCAPE", "PORTRAIT"];
  var GPS_PROFILES = ["OFF", "ECO", "NORMAL", "PRECISE"];
  var COUNTDOWNS = [0, 3, 5, 10];
  var STATUS_PREPARATION = "PREPARATION";

  /* Échelle décroissante pour le "meilleure inférieure supportée". */
  var RESOLUTION_LADDER = ["4K", "FHD", "HD"];
  var GPS_LADDER = ["PRECISE", "NORMAL", "ECO", "OFF"];

  /* Mapping natif résolution → profil CamcorderProfile (décision 32.1). */
  var NATIVE_R_PROFILE = { HD: "720P", FHD: "1080P", "4K": "2160P" };

  /* Étiquettes françaises pour warnings / résumés. */
  var LABELS = {
    HD: "HD", FHD: "Full HD", "4K": "4K",
    ECO: "Éco", NORMAL: "Normal", HIGH: "Haute",
    REAR: "Arrière", FRONT: "Avant",
    LANDSCAPE: "Paysage", PORTRAIT: "Portrait",
    OFF: "Off", PRECISE: "Précis",
    "true": "Activé", "false": "Désactivé"
  };

  function nowMs() { return Date.now(); }

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  function defaults() {
    return {
      video: { resolution: "FHD", quality: "HIGH", camera: "REAR", orientation: "LANDSCAPE" },
      audio: true,
      gpsProfile: "NORMAL",
      countdownSeconds: 5,
      transferAuto: true,
      deleteLocalAfterVerifiedReplication: true
    };
  }

  /* ---------- sanitize ---------- */

  function oneOf(v, list) {
    return list.indexOf(v) >= 0 ? v : null;
  }

  /* Assainit les réglages : les valeurs manquantes/invalides reprennent le défaut ;
   * un champ inconnu est ignoré (schéma versionné, pas de rupture). */
  function sanitizeSettings(raw) {
    if (!raw || typeof raw !== "object") raw = {};
    var video = (raw.video && typeof raw.video === "object") ? raw.video : {};
    var d = defaults();
    return {
      video: {
        resolution: oneOf(video.resolution, RESOLUTIONS) || d.video.resolution,
        quality: oneOf(video.quality, QUALITIES) || d.video.quality,
        camera: oneOf(video.camera, CAMERAS) || d.video.camera,
        orientation: oneOf(video.orientation, ORIENTATIONS) || d.video.orientation
      },
      audio: typeof raw.audio === "boolean" ? raw.audio : d.audio,
      gpsProfile: oneOf(raw.gpsProfile, GPS_PROFILES) || d.gpsProfile,
      countdownSeconds: COUNTDOWNS.indexOf(raw.countdownSeconds) >= 0 ? raw.countdownSeconds : d.countdownSeconds,
      transferAuto: typeof raw.transferAuto === "boolean" ? raw.transferAuto : d.transferAuto,
      deleteLocalAfterVerifiedReplication: typeof raw.deleteLocalAfterVerifiedReplication === "boolean" ? raw.deleteLocalAfterVerifiedReplication : d.deleteLocalAfterVerifiedReplication
    };
  }

  /* Assainit un overrides.Capture : { video: {...}|null, audio: bool|null,
   * gpsProfile: value|null }. null = hériter du réglage global. Un override
   * vidéo doit porter les 4 sous-champs ; sinon le bloc entier vaut null. */
  function sanitizeOverride(o) {
    if (!o || typeof o !== "object") return { video: null, audio: null, gpsProfile: null };
    var video = null;
    if (o.video && typeof o.video === "object") {
      var v = o.video;
      if (oneOf(v.resolution, RESOLUTIONS) && oneOf(v.quality, QUALITIES)
          && oneOf(v.camera, CAMERAS) && oneOf(v.orientation, ORIENTATIONS)) {
        video = {
          resolution: v.resolution, quality: v.quality, camera: v.camera, orientation: v.orientation
        };
      }
    }
    var audio = null;
    if (typeof o.audio === "boolean") audio = o.audio;
    var gps = null;
    if (oneOf(o.gpsProfile, GPS_PROFILES)) gps = o.gpsProfile;
    return { video: video, audio: audio, gpsProfile: gps };
  }

  function sanitizeOverrides(raw) {
    var out = {};
    if (!raw || typeof raw !== "object") return out;
    Object.keys(raw).forEach(function (did) {
      if (!did) return;
      var o = sanitizeOverride(raw[did]);
      /* all-null = équivalent Hériter : on ne conserve pas une entrée vide. */
      if (o.video === null && o.audio === null && o.gpsProfile === null) return;
      out[did] = o;
    });
    return out;
  }

  function cleanStringArray(arr) {
    var out = [];
    var seen = {};
    (Array.isArray(arr) ? arr : []).forEach(function (x) {
      if (typeof x !== "string" || !x) return;
      if (seen[x]) return;
      seen[x] = true;
      out.push(x);
    });
    return out.sort();
  }

  /* Assainit un Take : forme canonique stable + champs de convergence
   * (updatedAtMs/updatedByDeviceId). takeNumber requis ≥ 1 (254 = Take 255 pas
   * réaliste en V1 mais pas de limite artificielle : borne haute souple 9999). */
  function sanitizeTake(raw) {
    if (!raw || typeof raw !== "object") return null;
    var n = Math.floor(raw.takeNumber);
    if (!isNum(n) || n < 1 || n > 9999) return null;
    var now = nowMs();
    var out = {
      takeNumber: n,
      status: raw.status === STATUS_PREPARATION ? STATUS_PREPARATION : STATUS_PREPARATION,
      captures: cleanStringArray(raw.captures),
      storages: cleanStringArray(raw.storages),
      settings: sanitizeSettings(raw.settings),
      captureOverrides: sanitizeOverrides(raw.captureOverrides),
      createdAtMs: isNum(raw.createdAtMs) && raw.createdAtMs > 0 ? raw.createdAtMs : now,
      updatedAtMs: isNum(raw.updatedAtMs) && raw.updatedAtMs > 0 ? raw.updatedAtMs : now,
      updatedByDeviceId: typeof raw.updatedByDeviceId === "string" ? raw.updatedByDeviceId : ""
    };
    return out;
  }

  /* Assainit une liste de Takes : dé-doublonnée par takeNumber (le dernier
   * remporte, LMW local), triée par takeNumber croissant. */
  function sanitizeTakes(arr) {
    var byN = {};
    (Array.isArray(arr) ? arr : []).forEach(function (t) {
      var c = sanitizeTake(t);
      if (c) byN[c.takeNumber] = c;
    });
    return Object.keys(byN).map(function (k) { return byN[k]; })
      .sort(function (a, b) { return a.takeNumber - b.takeNumber; });
  }

  /* ---------- création / héritage ---------- */

  function createFirstTake(actor, atMs) {
    var now = isNum(atMs) && atMs > 0 ? atMs : nowMs();
    return sanitizeTake({
      takeNumber: 1,
      status: STATUS_PREPARATION,
      captures: [],
      storages: [],
      settings: defaults(),
      captureOverrides: {},
      createdAtMs: now,
      updatedAtMs: now,
      updatedByDeviceId: actor || ""
    });
  }

  /* Copie profonde d'un Take : Take 002 n'est jamais une référence de Take 001. */
  function cloneTake(t) {
    return sanitizeTake(JSON.parse(JSON.stringify(sanitizeTake(t))));
  }

  function maxTakeNumber(takes) {
    var m = 0;
    (takes || []).forEach(function (t) { if (t && t.takeNumber > m) m = t.takeNumber; });
    return m;
  }

  /* Nouveau Take : hérite des sélections/réglages/overrides du précédent,
   * numérotation déterministe (max existant + 1), statut PREPARATION. */
  function createNextTake(prevTakes, actor, atMs) {
    var now = isNum(atMs) && atMs > 0 ? atMs : nowMs();
    var arr = sanitizeTakes(prevTakes);
    var prev = arr.length ? arr[arr.length - 1] : null;
    var n = maxTakeNumber(arr) + 1;
    var base = prev ? cloneTake(prev) : createFirstTake(actor, now);
    base.takeNumber = n;
    base.status = STATUS_PREPARATION;
    base.createdAtMs = now;
    base.updatedAtMs = now;
    base.updatedByDeviceId = actor || "";
    return sanitizeTake(base);
  }

  function takeAt(takes, n) {
    var arr = sanitizeTakes(takes);
    for (var i = 0; i < arr.length; i++) if (arr[i].takeNumber === n) return arr[i];
    return null;
  }

  /* ---------- normalisation des capacités ---------- */

  /* Normalise n'importe quelle source (native brute, fixture, rapport télémetrie)
   * vers la forme du modèle J06. La forme FIxture simple accepte :
   *   { resolutions: ["HD"], audioMic:bool, gpsFeature:bool, sdk, model, manufacturer }
   * La forme native brute (getCaptureCapabilities) :
   *   { sdk, model, manufacturer, applicationCapabilities:{audioMicFeature,gpsFeature},
   *     cameras:[{cameraId,facing}], camcorderProfiles:[{cameraId, profiles:[{quality,available}]}] }
   * Quand rien n'est déterminable → { unknown:true } (sûr, jamais inventé). */
  function normalizeCapabilities(raw) {
    if (!raw || typeof raw !== "object") return { unknown: true, probedAtMs: 0 };
    var r = raw;
    var capsObj = r.capabilities && typeof r.capabilities === "object" ? r.capabilities : r;
    var out = {
      source: capsObj.source || (r.deviceId ? "telemetry" : "fixture"),
      probedAtMs: isNum(capsObj.probedAtMs) && capsObj.probedAtMs > 0 ? capsObj.probedAtMs : 0,
      model: typeof capsObj.model === "string" ? capsObj.model : "",
      manufacturer: typeof capsObj.manufacturer === "string" ? capsObj.manufacturer : "",
      sdk: isNum(capsObj.sdk) ? capsObj.sdk : null,
      audioMic: null,
      gpsFeature: null,
      orientationModes: [],
      cameras: { rear: [], front: [] },
      unknown: false
    };

    var known = false;

    /* fixtures / forme simple */
    if (Array.isArray(capsObj.resolutions)) {
      var res = cleanStringArray(capsObj.resolutions).filter(function (v) { return RESOLUTIONS.indexOf(v) >= 0; });
      out.cameras.rear = res.slice();
      out.cameras.front = res.slice();
      if (typeof capsObj.audioMic === "boolean") { out.audioMic = capsObj.audioMic; known = true; }
      if (typeof capsObj.gpsFeature === "boolean") { out.gpsFeature = capsObj.gpsFeature; known = true; }
      if (res.length) known = true;
      out.source = "fixture";
      return finalizeCaps(out, known);
    }

    /* forme native : applicationCapabilities + camcorderProfiles */
    if (capsObj.applicationCapabilities && typeof capsObj.applicationCapabilities === "object") {
      var ac = capsObj.applicationCapabilities;
      if (typeof ac.audioMicFeature === "boolean") { out.audioMic = ac.audioMicFeature; known = true; }
      if (typeof ac.gpsFeature === "boolean") { out.gpsFeature = ac.gpsFeature; known = true; }
    }

    /* forme déjà normalisée (rapport télémétrie d'un autre Master) : cameras est
     * un OBJET {rear,front}, pas un tableau — la normalisation doit être
     * idempotente pour que le relay télémetrie ne dégrade pas une cap connue. */
    if (capsObj.cameras && !Array.isArray(capsObj.cameras) && typeof capsObj.cameras === "object") {
      var cam = capsObj.cameras;
      var rear = cleanStringArray(cam.rear).filter(function (v) { return RESOLUTIONS.indexOf(v) >= 0; });
      var front = cleanStringArray(cam.front).filter(function (v) { return RESOLUTIONS.indexOf(v) >= 0; });
      if (rear.length) out.cameras.rear = rear.slice();
      if (front.length) out.cameras.front = front.slice();
      if (out.cameras.rear.length || out.cameras.front.length) known = true;
      if (typeof capsObj.audioMic === "boolean") { out.audioMic = capsObj.audioMic; known = true; }
      if (typeof capsObj.gpsFeature === "boolean") { out.gpsFeature = capsObj.gpsFeature; known = true; }
      out.source = capsObj.source === "telemetry" ? "telemetry" : "normalized";
      return finalizeCaps(out, known);
    }
    if (Array.isArray(capsObj.orientationModes)) {
      out.orientationModes = cleanStringArray(capsObj.orientationModes)
        .filter(function (v) { return ORIENTATIONS.indexOf(v) >= 0; });
      if (out.orientationModes.length) known = true;
    }
    if (Array.isArray(capsObj.cameras) && Array.isArray(capsObj.camcorderProfiles)) {
      var facingByCam = {};
      capsObj.cameras.forEach(function (c) {
        if (c && typeof c.cameraId === "string") facingByCam[c.cameraId] = c.facing === "front" ? "front" : "rear";
      });
      capsObj.camcorderProfiles.forEach(function (cp) {
        var facing = facingByCam[cp.cameraId] || "rear";
        var profs = (cp.profiles || []).map(function (p) {
          return p && p.quality && !(p.available === false) ? p.quality : null;
        })
          .filter(function (q) { return q === "720P" || q === "1080P" || q === "2160P"; });
        var list = [];
        PROF_TO_RES.forEach(function (pr) {
          if (profs.indexOf(pr.profile) >= 0) list.push(pr.res);
        });
        out.cameras[facing] = list.slice();
        if (list.length) known = true;
      });
    }
    return finalizeCaps(out, known);
  }

  var PROF_TO_RES = [
    { profile: "2160P", res: "4K" },
    { profile: "1080P", res: "FHD" },
    { profile: "720P", res: "HD" }
  ];

  function finalizeCaps(caps, known) {
    caps.unknown = !known;
    return caps;
  }

  /* Capacités "sûres" quand inconnues : AUDIO non disponible et GPS Off ne
   * peuvent pas être prétendus — on les déclare inconnus. */

  /* ---------- best effort + warnings ---------- */

  function rankOf(v, ladder) { return ladder.indexOf(v); }

  /* Meilleure valeur ≤ demandée dans l'échelle décroissante. Renvoie la valeur
   * ou null si aucune supportée. */
  function bestEffort(requested, supported, ladder) {
    var rq = rankOf(requested, ladder);
    if (rq < 0) return null;
    if (supported.indexOf(requested) >= 0) return requested;
    for (var i = rq + 1; i < ladder.length; i++) {
      if (supported.indexOf(ladder[i]) >= 0) return ladder[i];
    }
    return null;
  }

  function label(k, val) {
    return LABELS[val] || String(val);
  }

  /* Warnings de compatibilité par Capture — calculés sur les RÉGLAGES GLOBAUX
   * (décision UI 05 §« Warnings »), jamais sur un override. Retourne
   * { warnings:[{type,message}], capsUnknown:bool }. */
  function warningsForCapture(take, caps, did) {
    if (!take || !take.settings) return { warnings: [], capsUnknown: !caps || caps.unknown };
    if (!caps || caps.unknown) return { warnings: [], capsUnknown: true };
    /* Les warnings suivent l'EFFECTIF (override du device appliqué, §32) et non le
       réglage global : un override GPS OFF sur un device sans GPS ne doit plus
       signaler « GPS … indisponible → Off ». (J06-08) */
    var eff = effectiveForCapture(take, caps, did);
    return { warnings: eff.warnings, capsUnknown: false };
  }

  /* Override effective du device (redux global + override). */
  function requestedForCapture(take, caps, did) {
    var ov = (take.captureOverrides || {})[did] || { video: null, audio: null, gpsProfile: null };
    return {
      resolution: (ov.video && ov.video.resolution) || take.settings.video.resolution,
      quality: (ov.video && ov.video.quality) || take.settings.video.quality,
      camera: (ov.video && ov.video.camera) || take.settings.video.camera,
      orientation: (ov.video && ov.video.orientation) || take.settings.video.orientation,
      audio: typeof ov.audio === "boolean" ? ov.audio : take.settings.audio,
      gpsProfile: ov.gpsProfile || take.settings.gpsProfile
    };
  }

  /* Réglages effectifs d'une Capture : override éventuel, puis best effort sur
   * les capacités réelles. Les réglages globaux et overrides ne sont JAMAIS
   * réécrits : l'effectif est calculé à la lecture (décision §32, jamais de
   * fallback silencieux côté natif — le profil à demander est calculé ici). */
  function effectiveForCapture(take, caps, did) {
    var req = requestedForCapture(take, caps, did);
    if (!caps || caps.unknown) {
      return {
        requested: req,
        resolution: req.resolution,
        quality: req.quality,
        camera: req.camera,
        orientation: req.orientation,
        audio: req.audio,
        gpsProfile: req.gpsProfile,
        warnings: [],
        capsUnknown: true,
        fallback: false
      };
    }
    var supportedRes = caps.cameras[(req.camera || "REAR").toLowerCase()] || [];
    var effRes = bestEffort(req.resolution, supportedRes, RESOLUTION_LADDER) || req.resolution;
    var gpsList = caps.gpsFeature ? GPS_LADDER : ["OFF"];
    var effGps = bestEffort(req.gpsProfile, gpsList, GPS_LADDER) || "OFF";
    var effAudio = req.audio && caps.audioMic !== false;
    var warnings = [];
    if (effRes !== req.resolution) {
      warnings.push({ type: "video", message: label("res", req.resolution) + " indisponible → " + label("res", effRes) });
    }
    if (req.audio && caps.audioMic === false) {
      warnings.push({ type: "audio", message: "Audio indisponible → Désactivé" });
    }
    if (req.gpsProfile !== effGps) {
      warnings.push({ type: "gps", message: "GPS " + label("gps", req.gpsProfile) + " indisponible → " + label("gps", effGps) });
    }
    return {
      requested: req,
      resolution: effRes,
      quality: req.quality,
      camera: req.camera,
      orientation: req.orientation,
      audio: effAudio,
      gpsProfile: effGps,
      warnings: warnings,
      capsUnknown: false,
      fallback: warnings.length > 0
    };
  }

  /* Profil CamcorderProfile natif à demander (calculé AVANT tout appel natif)
   * pour le device : profile 720P/1080P/2160P + résolution effective + warning.
   * Préparé pour J07 sans aucun démarrage d'enregistrement. */
  function effectiveNativeProfile(take, caps, did) {
    var eff = effectiveForCapture(take, caps, did);
    return {
      cameraFacing: eff.camera,
      profile: NATIVE_R_PROFILE[eff.resolution] || "HIGH",
      resolution: eff.resolution,
      quality: eff.quality,
      audio: eff.audio,
      gpsProfile: eff.gpsProfile,
      warnings: eff.warnings,
      capsUnknown: eff.capsUnknown,
      requestedResolution: eff.requested.resolution
    };
  }

  /* ---------- mutations pures (sur copie) ---------- */

  function clonePlain(o) { return JSON.parse(JSON.stringify(o)); }

  function setCapture(take, did, selected, actor, atMs) {
    var t = clonePlain(take);
    var now = isNum(atMs) && atMs > 0 ? atMs : nowMs();
    var set = {};
    t.captures.forEach(function (d) { set[d] = true; });
    if (selected) set[did] = true; else delete set[did];
    t.captures = Object.keys(set).sort();
    t.updatedAtMs = now;
    if (actor) t.updatedByDeviceId = actor;
    return sanitizeTake(t);
  }

  function setCaptures(take, dids, actor, atMs) {
    var t = clonePlain(take);
    var now = isNum(atMs) && atMs > 0 ? atMs : nowMs();
    var set = {};
    (dids || []).forEach(function (d) { if (typeof d === "string" && d) set[d] = true; });
    t.captures = Object.keys(set).sort();
    t.updatedAtMs = now;
    if (actor) t.updatedByDeviceId = actor;
    return sanitizeTake(t);
  }

  function setStorage(take, did, selected, actor, atMs) {
    var t = clonePlain(take);
    var set = {};
    t.storages.forEach(function (d) { set[d] = true; });
    if (selected) set[did] = true; else delete set[did];
    t.storages = Object.keys(set).sort();
    var now = isNum(atMs) && atMs > 0 ? atMs : nowMs();
    t.updatedAtMs = now;
    if (actor) t.updatedByDeviceId = actor;
    return sanitizeTake(t);
  }

  function setStorages(take, dids, actor, atMs) {
    var t = clonePlain(take);
    var now = isNum(atMs) && atMs > 0 ? atMs : nowMs();
    var set = {};
    (dids || []).forEach(function (d) { if (typeof d === "string" && d) set[d] = true; });
    t.storages = Object.keys(set).sort();
    t.updatedAtMs = now;
    if (actor) t.updatedByDeviceId = actor;
    return sanitizeTake(t);
  }

  function setSetting(take, key, value, actor, atMs) {
    var t = clonePlain(take);
    var now = isNum(atMs) && atMs > 0 ? atMs : nowMs();
    var s = clonePlain(t.settings);
    var VIDEO_KEYS = { resolution: RESOLUTIONS, quality: QUALITIES, camera: CAMERAS, orientation: ORIENTATIONS };
    if (VIDEO_KEYS[key]) {
      if (VIDEO_KEYS[key].indexOf(value) < 0) return sanitizeTake(t);
      s.video[key] = value;
    } else if (key === "audio") {
      if (typeof value !== "boolean") return sanitizeTake(t);
      s.audio = value;
    } else if (key === "gpsProfile") {
      if (GPS_PROFILES.indexOf(value) < 0) return sanitizeTake(t);
      s.gpsProfile = value;
    } else if (key === "countdownSeconds") {
      if (COUNTDOWNS.indexOf(value) < 0) return sanitizeTake(t);
      s.countdownSeconds = value;
    } else if (key === "transferAuto" || key === "deleteLocalAfterVerifiedReplication") {
      if (typeof value !== "boolean") return sanitizeTake(t);
      s[key] = value;
    } else {
      return sanitizeTake(t);
    }
    t.settings = s;
    t.updatedAtMs = now;
    if (actor) t.updatedByDeviceId = actor;
    return sanitizeTake(t);
  }

  /* section=video → value {resolution,quality,camera,orientation} | null
   * section=audio → value boolean | null ; section=gpsProfile → value string|null. */
  function setOverride(take, did, section, value, actor, atMs) {
    var t = clonePlain(take);
    var ov = {};
    if (take.captureOverrides && take.captureOverrides[did]) ov = clonePlain(take.captureOverrides[did]);
    var sec = null;
    if (section === "video") {
      sec = value && typeof value === "object"
        ? sanitizeOverride({ video: value }).video
        : null;
    } else if (section === "audio") {
      sec = typeof value === "boolean" ? value : null;
    } else if (section === "gpsProfile") {
      sec = GPS_PROFILES.indexOf(value) >= 0 ? value : null;
    } else {
      return sanitizeTake(t);
    }
    if (section === "video") ov.video = sec;
    if (section === "audio") ov.audio = sec;
    if (section === "gpsProfile") ov.gpsProfile = sec;
    t.captureOverrides = clonePlain(t.captureOverrides || {});
    if (ov.video === null && ov.audio === null && ov.gpsProfile === null) {
      delete t.captureOverrides[did];
    } else {
      t.captureOverrides[did] = ov;
    }
    var now = isNum(atMs) && atMs > 0 ? atMs : nowMs();
    t.updatedAtMs = now;
    if (actor) t.updatedByDeviceId = actor;
    return sanitizeTake(t);
  }

  /* ---------- convergence des Takes entre Masters (LMW déterministe) ---------- */

  function takesEqual(a, b) {
    return JSON.stringify({
      takeNumber: a.takeNumber, captures: a.captures, storages: a.storages,
      settings: a.settings, captureOverrides: a.captureOverrides
    }) === JSON.stringify({
      takeNumber: b.takeNumber, captures: b.captures, storages: b.storages,
      settings: b.settings, captureOverrides: b.captureOverrides
    });
  }

  /* Sérialisation canonique (clés triées récursivement) pour comparer des
   * Take/CDID sans dépendre de l'ordre d'insertion des clés d'un JSON.stringify
   * brut (J06 : un départage lexicographique sur JSON.stringify non trié peut
   * faire gagner une version « vide » — bug convergé sur le terrain, corrigé). */
  function canon(o) {
    if (Array.isArray(o)) return "[" + o.map(canon).join(",") + "]";
    if (o && typeof o === "object") {
      return "{" + Object.keys(o).sort().map(function (k) { return JSON.stringify(k) + ":" + canon(o[k]); }).join(",") + "}";
    }
    return JSON.stringify(o);
  }

  /* Vainqueur d'un Take concurrent : (updatedAtMs, updatedByDeviceId), puis
   * départage déterministe du contenu : nombre de Captures, nominaux, nombre de
   * Storages, nominaux, réglages, overrides (la longueur prime pour qu'une
   * sélection non vide ne perde jamais face à une copie vide au LMW égal). */
  function takeWinner(a, b) {
    var aMs = a.updatedAtMs || 0, bMs = b.updatedAtMs || 0;
    if (aMs !== bMs) return aMs > bMs ? a : b;
    var aBy = a.updatedByDeviceId || "", bBy = b.updatedByDeviceId || "";
    if (aBy !== bBy) return aBy > bBy ? a : b;
    var ac = (a.captures || []), bc = (b.captures || []);
    if (ac.length !== bc.length) return ac.length > bc.length ? a : b;
    var asc = (a.storages || []), bsc = (b.storages || []);
    if (asc.length !== bsc.length) return asc.length > bsc.length ? a : b;
    var aK = canon({ captures: ac, storages: asc, settings: a.settings, captureOverrides: a.captureOverrides });
    var bK = canon({ captures: bc, storages: bsc, settings: b.settings, captureOverrides: b.captureOverrides });
    if (aK !== bK) return aK > bK ? a : b;
    return a;
  }

  /* Fusion déterministe des Takes accueillis d'un remote dans les Takes locaux.
   * Par deviceId-par-takeNumber : présent seulement d'un côté → adopté ; présent
   * des deux côtés → takeWinner (LMW). Aucun retrait (pas de suppression de Take
   * en J06). Retourne { takes, events, changed }. */
  function mergeTakes(localTakes, remoteTakes) {
    var loc = sanitizeTakes(localTakes);
    var rem = sanitizeTakes(remoteTakes);
    var events = [];
    var byN = {};
    var changed = false;
    loc.forEach(function (t) { byN[t.takeNumber] = t; });
    rem.forEach(function (rt) {
      var lt = byN[rt.takeNumber];
      if (!lt) {
        byN[rt.takeNumber] = rt;
        events.push({ type: "takeAdded", takeNumber: rt.takeNumber });
        return;
      }
      var win = takeWinner(lt, rt);
      if (win === rt && !takesEqual(lt, rt)) {
        byN[rt.takeNumber] = rt;
        events.push({ type: "takeChanged", takeNumber: rt.takeNumber });
      }
    });
    var out = Object.keys(byN).map(function (k) { return byN[k]; })
      .sort(function (a, b) { return a.takeNumber - b.takeNumber; });
    changed = JSON.stringify(out) !== JSON.stringify(sanitizeTakes(localTakes));
    return { takes: out, events: events, changed: changed };
  }

  return {
    STATUS_PREPARATION: STATUS_PREPARATION,
    RESOLUTIONS: RESOLUTIONS,
    QUALITIES: QUALITIES,
    CAMERAS: CAMERAS,
    ORIENTATIONS: ORIENTATIONS,
    GPS_PROFILES: GPS_PROFILES,
    COUNTDOWNS: COUNTDOWNS,
    RESOLUTION_LADDER: RESOLUTION_LADDER,
    GPS_LADDER: GPS_LADDER,
    DEFAULT_SETTINGS: defaults,
    LABELS: LABELS,
    nowMs: nowMs,
    sanitizeSettings: sanitizeSettings,
    sanitizeOverrides: sanitizeOverrides,
    sanitizeTake: sanitizeTake,
    sanitizeTakes: sanitizeTakes,
    cloneTake: cloneTake,
    createFirstTake: createFirstTake,
    createNextTake: createNextTake,
    maxTakeNumber: maxTakeNumber,
    takeAt: takeAt,
    normalizeCapabilities: normalizeCapabilities,
    bestEffort: bestEffort,
    labelsOf: label,
    warningsForCapture: warningsForCapture,
    requestedForCapture: requestedForCapture,
    effectiveForCapture: effectiveForCapture,
    effectiveNativeProfile: effectiveNativeProfile,
    setCapture: setCapture,
    setCaptures: setCaptures,
    setStorage: setStorage,
    setStorages: setStorages,
    setSetting: setSetting,
    setOverride: setOverride,
    takesEqual: takesEqual,
    takeWinner: takeWinner,
    mergeTakes: mergeTakes
  };
});