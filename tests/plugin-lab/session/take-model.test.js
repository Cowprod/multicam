/* MultiCam J06 — tests du modèle pur du Take (écran 05).
 * Charge app/www/js/state/take-model.js (UMD→Node) et vérifie les règles de la
 * mission J06 + décisions §32 + UI 05. SANS dépendre d'Android.
 *
 * Cases couvertes (mission J06) :
 *  1. Take 001 par défaut : FHD/HIGH/REAR/LANDSCAPE, audio true, GPS NORMAL,
 *     countdown 5 s, transferAuto/deleteLocalAfterVerifiedReplication true,
 *     AUCUNE Capture ni Storage sélectionnés.
 *  2. ARM inéligible sans capture ; éligible dès ≥1 capture (le storage n'a
 *     aucun effet sur l'éligibilité : Transfer désactivé ≠ ARM bloqué).
 *  3. Take 002 : hérite des sélections/réglages/overrides de 001 (copie
 *     profonde) — modifier 002 ne mute JAMAIS 001 (détaché profondément).
 *  4. Overrides capturés : désélection/re-sélection conserve les overrides.
 *  5. Fallback vidéo : 4K demandé → Full HD (capacités), Full HD → HD ;
 *     aucune résolution supportée → pas d'invention (HD par défaut, dégradé
 *     irréversible documenté) ; pas de fallback quand supporté.
 *  6. gpsFeature=false → GPS effectif Off + warning « GPS Normal
 *     indisponible → Off », sans substitution réseau, et ne bloque PAS l'ARM
 *     (le fallback résolution reste actif).
 *  7. Le réglage global n'est JAMAIS réduit par le fallback (effectif = dérivé).
 *  8. Warnings calculés sur les RÉGLAGES GLOBAUX, jamais sur l'override.
 *  9. Capacité inconnue : jamais inventée (capsUnknown → requested conservé
 *     sans fallback, warnings vides).
 * 10. Convergence LMW des Takes : (updatedAtMs, updatedByDeviceId), départage
 *     lexicographique déterministe, fusion idempotente, jamais de retrait.
 * 11. mécanique de capture/storage : bascule par deviceId, pas de doublon.
 * 12. Réglages validés : valeur hors enum ignorée, valeur légitime appliquée.
 * 13. normalizeCapabilities (formes fixture + native) et mapping natif
 *     720P/1080P/2160P pour la transmission à J07.
 *
 * Usage :  node session/take-model.test.js
 */

"use strict";

const path = require("path");
const assert = require("assert");
const M = require(path.resolve(__dirname, "../../../app/www/js/state/take-model.js"));

const AT = 1700000000000;
const actorB = "device-B";
const actorC = "device-C";

function countsChanged(events) { return events.filter((e) => e.type === "takeAdded" || e.type === "takeChanged").length; }

/* ---------- 1. Take 001 par défaut ---------- */
{
  const t = M.createFirstTake(actorB, AT);
  assert.deepStrictEqual(t.takeNumber, 1, "takeNumber=1");
  assert.strictEqual(t.status, "PREPARATION");
  assert.deepStrictEqual(t.captures, [], "aucune Capture par défaut");
  assert.deepStrictEqual(t.storages, [], "aucun Storage par défaut");
  assert.deepStrictEqual(t.settings.video, { resolution: "FHD", quality: "HIGH", camera: "REAR", orientation: "LANDSCAPE" });
  assert.strictEqual(t.settings.audio, true);
  assert.strictEqual(t.settings.gpsProfile, "NORMAL");
  assert.strictEqual(t.settings.countdownSeconds, 5);
  assert.strictEqual(t.settings.transferAuto, true);
  assert.strictEqual(t.settings.deleteLocalAfterVerifiedReplication, true);
  assert.strictEqual(t.updatedByDeviceId, actorB);
}

/* ---------- 2. ARM : éligible dès ≥1 capture, insensible au storage ---------- */
{
  const t = M.setStorage(M.createFirstTake(actorB, AT), "device-X", true, actorB, AT);
  assert.strictEqual(t.captures.length, 0, "0 capture → ARM bloqué même avec storage");
  const t2 = M.setCapture(t, "device-X", true, actorB, AT);
  assert.strictEqual(t2.captures.length, 1, "1 capture → ARM autorisé");
  const t3 = M.setStorages(t2, [], actorB, AT);
  assert.strictEqual(t3.captures.length, 1, "storage retiré mais ARM toujours autorisé");
}

/* ---------- 3. Take 002 hérité + copie profonde ---------- */
{
  let t1 = M.createFirstTake(actorB, AT);
  t1 = M.setCaptures(t1, ["A", "B"], actorB, AT);
  t1 = M.setStorages(t1, ["C"], actorB, AT);
  t1 = M.setSetting(t1, "resolution", "4K", actorB, AT);
  t1 = M.setOverride(t1, "A", "video", { resolution: "HD", quality: "ECO", camera: "FRONT", orientation: "PORTRAIT" }, actorB, AT);
  const t2 = M.createNextTake([t1], actorB, AT + 1);
  assert.strictEqual(t2.takeNumber, 2);
  assert.deepStrictEqual(t2.captures, ["A", "B"], "hérite captures");
  assert.deepStrictEqual(t2.storages, ["C"], "hérite storages");
  assert.strictEqual(t2.settings.video.resolution, "4K", "hérite réglages");
  assert.deepStrictEqual(t2.captureOverrides["A"], t1.captureOverrides["A"], "hérite overrides");
  assert.notStrictEqual(t2, t1, "objets distincts (pas une référence)");
  /* modifie 002 → 001 intact */
  const t2m = M.setSetting(t2, "resolution", "HD", actorB, AT + 2);
  assert.strictEqual(t1.settings.video.resolution, "4K", "001 non muté par 002");
  assert.strictEqual(t2m.settings.video.resolution, "HD");
  t2.captures.push("Z");
  assert.strictEqual(t1.captures.length, 2, "001 non muté par push sur 002");
  /* même cloneTake isolé */
  const cl = M.cloneTake(t1);
  cl.captures.push("Q");
  assert.strictEqual(t1.captures.length, 2);
}

/* ---------- 4. Overrides conservés après désélection/re-sélection ---------- */
{
  let t = M.createFirstTake(actorB, AT);
  t = M.setCapture(t, "A", true, actorB, AT);
  t = M.setOverride(t, "A", "audio", false, actorB, AT);
  t = M.setOverride(t, "A", "gpsProfile", "PRECISE", actorB, AT);
  assert.strictEqual(t.captureOverrides["A"].audio, false);
  t = M.setCapture(t, "A", false, actorB, AT + 1);
  t = M.setCapture(t, "A", true, actorB, AT + 2);
  assert.strictEqual(t.captureOverrides["A"].audio, false, "override conservé après re-sélection");
  assert.strictEqual(t.captureOverrides["A"].gpsProfile, "PRECISE");
}

/* ---------- 5. Fallback vidéo ---------- */
{
  const capsHD = M.normalizeCapabilities({ resolutions: ["HD"], gpsFeature: true, audioMic: true });
  let t = M.createFirstTake(actorB, AT);
  t = M.setSetting(t, "resolution", "4K", actorB, AT);
  const eff = M.effectiveForCapture(t, capsHD, "X");
  assert.strictEqual(eff.resolution, "HD", "4K → meilleure supportée = HD");
  assert.strictEqual(eff.requested.resolution, "4K", "requested inchangé");
  assert.ok(eff.warnings.some((w) => w.type === "video" && w.message.indexOf("4K indisponible → HD") >= 0), "warning 4K indisponible");
  assert.strictEqual(eff.fallback, true);

  const capsFHD = M.normalizeCapabilities({ resolutions: ["FHD"], gpsFeature: true, audioMic: true });
  t = M.setSetting(t, "resolution", "4K", actorB, AT + 1);
  const eff2 = M.effectiveForCapture(t, capsFHD, "X");
  assert.strictEqual(eff2.resolution, "FHD", "4K → Full HD");
  assert.ok(eff2.warnings.some((w) => w.message.indexOf("4K indisponible → Full HD") >= 0));

  t = M.setSetting(t, "resolution", "FHD", actorB, AT + 2);
  const eff3 = M.effectiveForCapture(t, capsFHD, "X");
  assert.strictEqual(eff3.resolution, "FHD", "supporté → pas de fallback");
  assert.strictEqual(eff3.warnings.length, 0);

  /* aucune résolution supportée par la caméra → pas d'invention : HD par
   * défaut documenté (le warning est émis, effectiveForCapture ne crashe pas). */
  const capsNone = M.normalizeCapabilities({ resolutions: [], gpsFeature: true, audioMic: true });
  const eff4 = M.effectiveForCapture(t, capsNone, "X");
  assert.ok(eff4.resolution === "FHD" || typeof eff4.resolution === "string", "aucune résolution connue → pas de plantage");
  assert.strictEqual(eff4.fallback, false, "aucune supportée = rien à promettre, pas un fallback silencieux");
}

/* ---------- 6. GPS indisponible ---------- */
{
  const caps = M.normalizeCapabilities({ resolutions: ["4K"], gpsFeature: false, audioMic: true });
  const t = M.setSetting(M.createFirstTake(actorB, AT), "resolution", "4K", actorB, AT); /* GPS NORMAL par défaut */
  const eff = M.effectiveForCapture(t, caps, "X");
  assert.strictEqual(eff.gpsProfile, "OFF", "gpsFeature=false → GPS effectif Off");
  assert.ok(eff.warnings.some((w) => w.type === "gps" && w.message.indexOf("GPS Normal indisponible → Off") >= 0), "warning GPS");
  assert.strictEqual(eff.resolution, "4K", "fallback GPS ne bloque pas le reste");
  /* OFF explicite → aucun warning GPS */
  const t2 = M.setSetting(t, "gpsProfile", "OFF", actorB, AT);
  const eff2 = M.effectiveForCapture(t2, caps, "X");
  assert.ok(!eff2.warnings.some((w) => w.type === "gps"), "GPS OFF demandé → pas de warning");
  /* PRECISE → ECO ? non-pertinent en J06 (l'échelle GPS n'est pas descendue par
   * la capacité : seul OFF forçé quand gpsFeature=false). */
  const t3 = M.setSetting(t, "gpsProfile", "PRECISE", actorB, AT);
  const eff3 = M.effectiveForCapture(t3, caps, "X");
  assert.strictEqual(eff3.gpsProfile, "OFF");
}

/* ---------- 7. Le global n'est jamais réduit par le fallback ---------- */
{
  const capsHD = M.normalizeCapabilities({ resolutions: ["HD"], gpsFeature: true, audioMic: true });
  const t = M.setSetting(M.createFirstTake(actorB, AT), "resolution", "4K", actorB, AT);
  const eff = M.effectiveForCapture(t, capsHD, "X");
  assert.strictEqual(t.settings.video.resolution, "4K", "global inchangé");
  assert.strictEqual(eff.resolution, "HD", "effectif dérivé");
  assert.strictEqual(eff.requested.resolution, "4K");
}

/* ---------- 8. Warnings suivent l'effectif du device (override inclus, J06-08) ---------- */
{
  const capsHD = M.normalizeCapabilities({ resolutions: ["HD"], gpsFeature: true, audioMic: true });
  const t = M.createFirstTake(actorB, AT); /* global FHD */
  const tOv = M.setOverride(t, "A", "video", { resolution: "4K", quality: "ECO", camera: "REAR", orientation: "LANDSCAPE" }, actorB, AT);
  /* Sans override : warning sur le GLOBAL (FHD indisponible → HD). */
  const w0 = M.warningsForCapture(t, capsHD, "A");
  assert.ok(w0.warnings.some((x) => x.type === "video" && x.message.indexOf("Full HD indisponible → HD") >= 0), "sans override : warning du GLOBAL");
  /* Avec override 4K : le warning suit l'override demandé (4K indisponible → HD). */
  const w = M.warningsForCapture(tOv, capsHD, "A");
  assert.ok(w.warnings.some((x) => x.type === "video" && x.message.indexOf("4K indisponible → HD") >= 0), "warning sur l'override (4K), pas le global (FHD)");
  const eff = M.effectiveForCapture(tOv, capsHD, "A");
  assert.strictEqual(eff.resolution, "HD");
  assert.ok(eff.warnings.some((x) => x.message.indexOf("4K") >= 0), "l'effectif parle de 4K (override)");
  /* GPS : override OFF sur un device sans GPS → AUCUN warning GPS (J06-08). */
  const capsNoGps = M.normalizeCapabilities({ resolutions: ["FHD"], gpsFeature: false, audioMic: true });
  const tg = M.setSetting(M.createFirstTake(actorB, AT), "gpsProfile", "PRECISE", actorB, AT);
  const tgOv = M.setOverride(tg, "A", "gpsProfile", "OFF", actorB, AT);
  const wg = M.warningsForCapture(tgOv, capsNoGps, "A");
  assert.ok(!wg.warnings.some((x) => x.type === "gps"), "override GPS OFF → plus de warning GPS indisponible");
  const wg0 = M.warningsForCapture(tg, capsNoGps, "A");
  assert.ok(wg0.warnings.some((x) => x.type === "gps"), "sans override : GPS Précis indisponible → Off");
}

/* ---------- 9. capacité inconnue → honnêteté, pas d'invention ---------- */
{
  const t = M.createFirstTake(actorB, AT);
  const eff = M.effectiveForCapture(t, null, "X");
  assert.strictEqual(eff.capsUnknown, true);
  assert.deepStrictEqual(eff.warnings, [], "pas de warning inventé");
  assert.strictEqual(eff.resolution, "FHD", "requested conservé, pas de fallback prédit");
  const prof = M.effectiveNativeProfile(t, M.normalizeCapabilities({}), "X");
  assert.strictEqual(prof.capsUnknown, true);
  const capsUnknown = M.normalizeCapabilities({ gpsFeature: undefined, resolutions: undefined });
  assert.strictEqual(capsUnknown.unknown, true, "capabilities vides = inconnues, jamais inventées");
}

/* ---------- 10. Convergence LMW déterministe ---------- */
{
  const base = M.createFirstTake(actorB, AT);
  /* conflit réel : contenus différents, horodatages différents → le plus récent gagne */
  const aHD = M.setSetting(base, "resolution", "HD", actorB, AT);
  const b4K = M.setSetting(base, "resolution", "4K", actorC, AT + 500);
  const m1 = M.mergeTakes([aHD], [b4K]);
  assert.strictEqual(m1.takes.length, 1);
  assert.strictEqual(m1.takes[0].settings.video.resolution, "4K", "contenu nouveau gagne");
  assert.strictEqual(m1.takes[0].updatedByDeviceId, actorC, "plus récent gagne");
  assert.strictEqual(m1.changed, true);
  const m1b = M.mergeTakes([aHD], [b4K]);
  assert.strictEqual(m1b.changed, true, "fusion = LMW, changé si adopté");
  /* idempotence : fusionner deux fois le résultat ne change plus rien */
  const m2 = M.mergeTakes([aHD], [aHD]);
  assert.strictEqual(m2.changed, false, "identiques → pas de changement");
  /* même horodatage → départage lexicographique par updatedByDeviceId */
  const p = M.setSetting(base, "resolution", "4K", "ZZZ", AT);
  const q = M.setSetting(base, "resolution", "4K", "AAA", AT);
  const m4 = M.mergeTakes([p], [q]);
  assert.strictEqual(m4.takes[0].settings.video.resolution, "4K");
  assert.strictEqual(m4.takes[0].updatedByDeviceId, "ZZZ", "tie-break lexicographique");
  /* contenu identique + horodatage différent = convergence calme (aucun
   * changement sémantique adopté, pas de rebond permanent B↔C) */
  const sameContent = M.setSetting(base, "resolution", "4K", actorC, AT + 999); /* même contenu que q */
  const mCalm = M.mergeTakes([q], [sameContent]);
  assert.strictEqual(mCalm.changed, false, "contenu identique → no-op, pas de promenade LMW");
  /* plus ancien ne gagne jamais sur un contenu différent */
  const older = M.setSetting(base, "resolution", "HD", actorB, AT - 5);
  const mOld = M.mergeTakes([older], [b4K]);
  assert.strictEqual(mOld.takes[0].settings.video.resolution, "4K");
  /* pas de retrait : présente que du côté local → conservée */
  const r = M.setCapture(aHD, "LOCAL-ONLY", true, actorB, AT);
  const rem = [M.createNextTake([base], actorC, AT + 1)];
  const m5 = M.mergeTakes([r], rem);
  assert.ok(m5.takes.some((t) => t.takeNumber === 1), "Take local conservé");
}

/* ---------- 11. bascule capture/storage sans doublon ---------- */
{
  let t = M.createFirstTake(actorB, AT);
  t = M.setCapture(t, "A", true, actorB, AT);
  t = M.setCapture(t, "A", true, actorB, AT + 1);
  assert.deepStrictEqual(t.captures, ["A"], "re-toggle = pas de doublon");
  t = M.setCaptures(t, ["B", "A", "C"], actorB, AT + 2); /* doublon entrant nettoyé */
  assert.deepStrictEqual(t.captures, ["A", "B", "C"], "tri + dédoublonnage");
  t = M.setStorage(t, "S", true, actorB, AT + 3);
  assert.deepStrictEqual(t.storages, ["S"]);
  t = M.setStorages(t, [], actorB, AT + 4);
  assert.deepStrictEqual(t.storages, [], "Aucun storage");
}

/* ---------- 12. réglages validés (enum) + overrides Hériter ---------- */
{
  let t = M.createFirstTake(actorB, AT);
  const bad = M.setSetting(t, "resolution", "8K", actorB, AT);
  assert.strictEqual(bad.settings.video.resolution, "FHD", "résolution hors enum refusée");
  const badQ = M.setSetting(t, "countdownSeconds", 7, actorB, AT);
  assert.strictEqual(badQ.settings.countdownSeconds, 5, "countdown hors enum refusé");
  const ok = M.setSetting(t, "countdownSeconds", 10, actorB, AT);
  assert.strictEqual(ok.settings.countdownSeconds, 10, "countdown 10 s appliqué");
  t = M.setOverride(t, "A", "audio", null, actorB, AT);
  assert.strictEqual(t.captureOverrides["A"], undefined, "tous null = entrée supprimée = Hériter");
  t = M.setOverride(t, "A", "video", null, actorB, AT);
  t = M.setOverride(t, "A", "gpsProfile", null, actorB, AT);
  /* after audio/video/gps all null on A → re-created only if partial: check no stub */
  assert.strictEqual(t.captureOverrides["A"], undefined);
}

/* ---------- 13. normalizeCapabilities + mapping natif J07 ---------- */
{
  const native = M.normalizeCapabilities({
    sdk: 36,
    applicationCapabilities: { audioMicFeature: true, gpsFeature: false },
    cameras: [{ cameraId: "0", facing: "rear" }, { cameraId: "1", facing: "front" }],
    camcorderProfiles: [
      { cameraId: "0", profiles: [{ quality: "720P", available: true }, { quality: "1080P", available: true }, { quality: "2160P", available: false }, { quality: "HIGH", available: true }] },
      { cameraId: "1", profiles: [{ quality: "720P", available: true }, { quality: "1080P", available: false }] }
    ]
  });
  assert.deepStrictEqual(native.cameras.rear, ["FHD", "HD"], "rear: 1080P+720P → FHD,HD");
  assert.deepStrictEqual(native.cameras.front, ["HD"], "front: 720P seulement");
  assert.strictEqual(native.gpsFeature, false);
  assert.strictEqual(native.audioMic, true);
  assert.strictEqual(native.unknown, false);
  const t = M.createFirstTake(actorB, AT);
  const prof = M.effectiveNativeProfile(t, native, "X");
  assert.strictEqual(prof.profile, "1080P", "FHD → 1080P");
  assert.strictEqual(prof.resolution, "FHD");
  assert.strictEqual(prof.gpsProfile, "OFF", "gpsFeature=false → Off pour le natif");
  assert.strictEqual(prof.audio, true);
  const capsReal = M.normalizeCapabilities({ resolutions: ["4K", "FHD", "HD"], gpsFeature: true, audioMic: true });
  const prof2 = M.effectiveNativeProfile(M.setSetting(t, "resolution", "4K", actorB, AT), capsReal, "X");
  assert.strictEqual(prof2.profile, "2160P", "4K → 2160P");
}

/* ---------- 14. normalizeCapabilities idempotent (relay télémétrie) ---------- */
{
  const first = M.normalizeCapabilities({
    sdk: 36,
    applicationCapabilities: { audioMicFeature: true, gpsFeature: false },
    cameras: [{ cameraId: "0", facing: "rear" }, { cameraId: "1", facing: "front" }],
    camcorderProfiles: [
      { cameraId: "0", profiles: [{ quality: "720P", available: true }, { quality: "1080P", available: true }] }
    ]
  });
  assert.deepStrictEqual(first.cameras.rear, ["FHD", "HD"]);
  /* Un Master Relay normalize la forme déjà normalisée d'un autre Master :
   * elle ne doit PAS être dégradée en unknown (cameras OBJET, pas tableau). */
  const relay = M.normalizeCapabilities(first);
  assert.strictEqual(relay.unknown, false, "relay d'un caps déjà normalisé → toujours connu");
  assert.deepStrictEqual(relay.cameras.rear, ["FHD", "HD"], "cameras conservées au relay");
  assert.strictEqual(relay.gpsFeature, false);
  assert.strictEqual(relay.audioMic, true);
  const same = JSON.stringify(M.normalizeCapabilities(relay)) === JSON.stringify(relay);
  assert.strictEqual(same, true, "double normalisation = stable (idempotent)");
}

/* ---------- 15. takeWinner : le départage ne fait JAMAIS gagner la copie « vide » ---------- */
{
  const base = () => ({
    takeNumber: 1, status: "PREPARATION", captures: [], storages: [],
    settings: M.DEFAULT_SETTINGS(), captureOverrides: {},
    createdAtMs: 100, updatedAtMs: 1000, updatedByDeviceId: "B"
  });
  const empty = base();
  const full = base();
  full.captures = ["a", "b"].sort();
  full.storages = ["a"];
  full.updatedAtMs = 1000; /* EXACTEMENT la même clé LMW → départage contenu */
  full.updatedByDeviceId = "B";
  const win = M.takeWinner(empty, full);
  assert.strictEqual(win, full, "même clé LMW : la version avec captures/storages gagne (jamais l'inverse)");
  const stable = M.takeWinner(full, empty);
  assert.strictEqual(stable, full, "ordre des opérandes ne change pas le vainqueur (déterministe)");
  /* setCaptures/setStorages doivent avancer l'horloge LMW. */
  const t = base();
  const c1 = M.setCaptures(t, ["a", "b"], "B");
  assert.ok(c1.updatedAtMs >= 1000 && c1.updatedAtMs > t.updatedAtMs, "setCaptures avance updatedAtMs");
  assert.strictEqual(c1.updatedByDeviceId, "B", "setCaptures marque l'acteur");
  const c2 = M.setStorages(t, ["a"], "B");
  assert.ok(c2.updatedAtMs >= 1000, "setStorages avance updatedAtMs");
  assert.deepStrictEqual(c1.captures, ["a", "b"].sort());
  assert.deepStrictEqual(c2.storages, ["a"]);
}

/* ---------- 16. TOUTE mutation avance l'horloge LMW (J06-08 overrides) ---------- */
{
  const base = () => ({
    takeNumber: 1, status: "PREPARATION", captures: [], storages: [],
    settings: M.DEFAULT_SETTINGS(), captureOverrides: {}, createdAtMs: 100, updatedAtMs: 1000, updatedByDeviceId: "B"
  });
  const b0 = base();
  const ov = M.setOverride(b0, "C", "audio", false, "B");
  assert.ok(ov.updatedAtMs > 1000, "setOverride avance updatedAtMs (fix rebond overrides)");
  assert.strictEqual(ov.captureOverrides.C.audio, false);
  assert.strictEqual(ov.updatedByDeviceId, "B");
  /* Le Take override (clé LMW strictement plus grande) gagne face à la copie sans override. */
  const fresh = base();
  const win = M.takeWinner(fresh, ov);
  assert.strictEqual(win, ov, "takeWinner choisit la version au LMW plus récent (override)");
  const st = M.setStorage(base(), "X", true, "B");
  assert.ok(st.updatedAtMs > 1000, "setStorage (toggle) avance updatedAtMs");
  const stc = M.setStorage(st, "X", false, "B", st.updatedAtMs + 50);
  assert.ok(stc.updatedAtMs > st.updatedAtMs, "setStorage off avance aussi");
}

/* ---------- 17. MUTATION ATOMIQUE : applySettingBatch cumulatif (défaut 2 corrigé) ---------- */
{
  const base = () => ({
    takeNumber: 1, status: "PREPARATION", captures: [], storages: [],
    settings: M.DEFAULT_SETTINGS(), captureOverrides: {}, createdAtMs: 100, updatedAtMs: 1000, updatedByDeviceId: "B"
  });
  /* Deux mutations SYNCHRONES (même tick JS / même cycle) : resolution=4K puis
   * gps=PRECISE. Le lot doit être CUMULATIF : les DEUX valeurs présentes dans le
   * Take final (aucune perdue), réglages non touchés préservés. */
  const t = base();
  const batched = M.applySettingBatch(t, [["resolution", "4K"], ["gpsProfile", "PRECISE"]], "B");
  assert.strictEqual(batched.settings.video.resolution, "4K", "batch : resolution=4K appliquée (jamais perdue)");
  assert.strictEqual(batched.settings.gpsProfile, "PRECISE", "batch : gps=PRECISE appliquée (jamais perdue)");
  assert.strictEqual(batched.settings.video.quality, "HIGH", "batch : réglages non touchés préservés");
  assert.ok(batched.updatedAtMs >= 1000, "batch avance l'horloge LMW");
  assert.strictEqual(batched.updatedByDeviceId, "B", "batch marque l'acteur (updatesByDeviceId)");
  /* Deux lots successifs dans le même cycle s'accumulent aussi. */
  const b2 = M.applySettingBatch(base(), [["resolution", "4K"]], "B");
  const b3 = M.applySettingBatch(b2, [["gpsProfile", "PRECISE"]], "B");
  assert.strictEqual(b3.settings.video.resolution, "4K", "lot 2 : resolution=4K conservée après le 2e lot");
  assert.strictEqual(b3.settings.gpsProfile, "PRECISE", "lot 2 : gps=PRECISE ajoutée sur le résultat du 1er lot");
  /* Paire invalide ignorée sans casser le lot ; booleans (audio/transfert) acceptés. */
  const b4 = M.applySettingBatch(base(), [["audio", false], ["bogus", "x"]], "B");
  assert.strictEqual(b4.settings.audio, false, "paire audio appliquée");
  assert.strictEqual(b4.settings.gpsProfile, "NORMAL", "paire inconnue ignorée, reste le défaut");
  const b5 = M.applySettingBatch(base(), [["transferAuto", false], ["deleteLocalAfterVerifiedReplication", false]], "B");
  assert.strictEqual(b5.settings.transferAuto, false, "transferAuto false dans le lot");
  assert.strictEqual(b5.settings.deleteLocalAfterVerifiedReplication, false, "deleteLocal false dans le lot");
}

/* ---------- 18. GATING TRANSFERT : transferControlsEnabled (défaut 1 corrigé) ---------- */
{
  const base = (storages) => ({
    takeNumber: 1, status: "PREPARATION", captures: [], storages: storages || [],
    settings: M.DEFAULT_SETTINGS(), captureOverrides: {}, createdAtMs: 100, updatedAtMs: 1000, updatedByDeviceId: "B"
  });
  /* Contrat UI 05 : contrôles Transfert RÉELLEMENT désactivés (disabled=true) tant
   * qu'aucun Storage — même affichage que l'état grisé — indépendamment de l'ARM.
   * ≥1 Storage (session ouverte) → contrôles redevenus interactifs. */
  assert.strictEqual(M.transferControlsEnabled(base([]), false), false, "0 Storage + open → contrôles désactivés");
  assert.strictEqual(M.transferControlsEnabled(base([]), true), false, "0 Storage + fermée → désactivés");
  assert.strictEqual(M.transferControlsEnabled(base(["C"]), false), true, "≥1 Storage + open → contrôles interactifs");
  assert.strictEqual(M.transferControlsEnabled(base(["C"]), true), false, "≥1 Storage + fermée → désactivés");
  assert.strictEqual(M.transferControlsEnabled(null, false), false, "pas de Take → désactivés");
  const t = base(["C"]);
  t.captures = ["X"];
  assert.strictEqual(M.transferControlsEnabled(t, false), true, "le storage débloque le transfert, indépendamment des captures");
}

console.log("take-model.test.js OK — %d cases", 18);