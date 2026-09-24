# Rapport de fin de jalon — J06 Préparation Take 05 (OSV — 15 points)

Date : 2026-09-24
Branche : `feat/j06-take-preparation` (base `490e652`)
Jalon : `docs/PLAN-DEVELOPPEMENT-V1.md` → **J06**
État : **PASS technique — en attente revue humaine** (validation exhibition `tests/e2e/validation/J06-take-preparation/`)
Commandé par : campagne physique `tests/e2e/j06-campaign.sh clean` sur B+C (2 Xiaomi `61d54bba7d91` / `c0d8514d7d87`)

---

## 1. Objectif et périmètre
Implémenter l'écran 05 « Préparation Take » : sélection Captures/Storage, réglages globaux, Take 001 par défaut, héritage du Take précédent, overrides par Capture, fallbacks selon capacités, JSON de Take persistant et convergent entre Masters égaux. Aucun nouveau canal réseau : réutilisation des routes J04/J05 (`take_update`, `sync`, télémétrie device).

## 2. Décisions appliquées (conformité, non improvisée)
- `MULTICAM_DECISIONS_REFERENCE.md` §30.5 (séparation modèle/transport), §31 (LMW + departage déterministe + `closed` gagne), §31.2 (rôles cumulables), §32 (style réglages : globals jamais réécrits, best-effort documenté, warnings, `gpsFeature=false` → Off, honnêteté `capsUnknown`, `setFixtureMap`/`clearFixtures`).
- `AGENTS.md` : journalisation distribuée parsable (`TAKE_UPDATE_LOCAL`, `TAKE_CHANGED learned_from`, `SCREEN05_*`).

## 3. Chaîne de build native (reproductible)
`app/setup-android.sh` : npm install → platform android@15.1.0 → plugin camera (pin GitHub) → 3 patches (pixelcopy, capture-profile, capture-capabilities) → build. APK unique B=C : SHA-256 `27115b7d55c18456648c09502a79e3408f3eec1a01abbe51b092d4957c1abad2` (`apk-sha256.txt`).

## 4. Nouveaux modules (code production)
- `app/www/js/state/take-model.js` — modèle Take pur (defaults, mutations LMW, héritage, overrides, fallbacks/effectifs).
- `app/www/js/native/capture-capabilities.js` — probe natif + cache + hook SIMULATED + capabilitiesFor.
- `app/www/js/ui/take.js` — écran 05 (rendu, warnings, modal overrides, groupes, ARM).
- `app/www/js/net/session-ws.js` — take_update déjà présent en J05 + anti-rebond take + télémétrie/membres.
- `app/setup-android.sh` + `app/camera-patches/` — build reproductible.

## 5. Modèle de données Take (JSON)
`{takeNumber, status:"PREPARATION", captures:[], storages:[], settings:{video{resolution,quality,camera,orientation}, audio, gpsProfile, countdownSeconds, transferAuto, deleteLocalAfterVerifiedReplication}, captureOverrides:{<did>:{video|null,audio|null,gpsProfile|null}}, createdAtMs, updatedAtMs, updatedByDeviceId}`. Take 001 = défauts (FHD/HIGH/REAR/LANDSCAPE, audio true, GPS NORMAL, 5 s, autotransfert). Take 002 = clonage profond du précédent : sélections, réglages et overrides hérités ; objet indépendant du Take précédent.

## 6. Convergence distribuée (défaut le plus grave corrigé)
Toute mutation avance `updatedAtMs`/marque l'acteur (horloge LMW fiable sur captures, storages, settings, overrides). `takeWinner` : `(updatedAtMs, updatedByDeviceId)` puis départage canonique (clés triées, longueurs des captures/storages prioritaires) — la copie VIDE ne gagne jamais. Anti-rebond `TAKE_IGNORED_STALE` : un écho stale ne régresse pas un Take local plus récent. Convergence prouvée B==C (J06-13, byte-identité).

## 7. Capacités natives + télémétrie (def re #2)
`probe()` → `{model, sdk, cameras, gpsFeature, audioMic, unknown:false}` réel sur les 2 Xiaomi (24075RP89G). `selfDeviceId()` corrigée (identité = `MultiCamSessionWs.status().localDid`) → `capsKnown=true` B et C dans la télémétrie relayée (ni dégradée ni inventée).

## 8. Écran 05 (production)
En-tête Take/badge/ARM/Nouveau, cards Capture (télémétrie + icônes conformité + crayon overrides + switch) et Storage, groupes « Tout capturer/Stocker », réglages globaux, avertissements par device, modal overrides (Hériter / personnaliser, sélecteurs restreints aux capacités). SPA : exactement 1 panneau actif à chaque étape (`PANELS_OK`).

## 9. Fallbacks §32 (jamais silencieux)
Global 4K + GPS Précis posé sans réduction (`globalUnchanged=true`) ; warnings `4K indisponible → Full HD` + `GPS Précis indisponible → Off` calculés par device ; effectif C = FHD/OFF/fallback. Warnings **override-aware** (corrigés, def #3) : un override GPS OFF sur device sans GPS fait disparaître le warning.

## 10. Bullet SIMULATED (capacités déclarées de test)
`setFixtureMap` → C devient `SimulatedCam4K` (4K+GPS, `source:"fixture"`, jamais confondu avec le réel) : la carte C cesse les warnings, B (réel) les conserve — **contrast=true**, screenshot. Restauration `clearFixtures()` **purge le cache** (def #4) → `REAL_RESTORED model=24075RP89G` vérifié.

## 11. Overrides par Capture
Modal J06-08 : 3 sections (video/audio/gps), GPS listé `["OFF"]` sur device `gpsFeature:false` (restriction par capacité), personnalisation audio OFF + GPS OFF → `{video:null, audio:false, gpsProfile:"OFF"}` persisté **et** converge sur C. Retour « Hériter » J06-09 → nettoyage des overrides convergé des deux côtés.

## 12. Héritage / persistance / ARM
Take 002 hérite sélections + réglages + overrides du Take précédent et Take 001 reste intact (J06-10). Dans la campagne finale, les overrides avaient été remis à l'état Hériter avant la création de Take 002 ; le modèle et les tests couvrent néanmoins l'héritage d'overrides non nuls. Redémarrage B : session + Taks persistés (J06-11). ARM bloqué avant sélection (J06-04) puis débloqué dès ≥1 Capture (J06-06) — placeholder J07 documenté.

## 13. Garde-fous déterministes
`take-model.test.js` 16/16 (dont LMW systématique, takeWinner anti-vide, warnings override-aware, normalizeCapabilities idempotent), `takes-session.test.js` 8/8, `members-model.test.js` 17/17, `merge-model.test.js` 7/7, `panels-check`/SPA OK, `node --check` tous JS modifiés OK.

## 14. Campagne physique — preuves
`dumps/` 32 JSON (état clé par étape, B==C), `logs/` parsables (`TAKE_*`, `SCREEN05_*`, `WS_*`, `MEMBER_*`), `screenshots/` 22 PNG (`png-shas.txt`, 1 doublon ATTENDU : J06-07==J06-09 retour Hériter), `apk-sha256.txt`. 13 scénarios **13/13 PASS** + `FINAL_CONVERGENCE takes_equal_B_C=true`.

## 15. Limitations, décisions explicites, prochaine étape
- 3 appareils simultanés / 8 devices : **NOT TESTED — DEFERRED** (même logique J05, critère non affaibli) ; aucune limite structurelle (tableaux par did).
- Fenêtre de reprise 4 h/24 h : pas de timer (hors V1), persistance prouvée.
- ARM (écran J07) : débloqué mais non fonctionnel, placeholder — jalon suivant.
- **STOP** : commit des preuves sur `feat/j06-take-preparation`, **pas de merge vers `main`**, **pas d'acceptation humaine**. Étape suivante = revue humaine des captures + validation J07 (avec sync horloge).