# VALIDATION.md — J06 Take « Préparation »

- Jalon : `docs/PLAN-DEVELOPPEMENT-V1.md` → J06
- État : **PASS technique — en attente revue humaine**
- Date campagne : 2026-09-24 (campaign finale, `tests/e2e/j06-campaign.sh clean`) + campagne complémentaire (J06-C) + corrections ciblées post-revue (J06-FIX T1/T2/T3, même date)
- Statut des 2 défauts détectés en revue : **corrigés et non-régressés** (cf. section « Corrections ciblées post-revue »)
- Branche : `feat/j06-take-preparation` (départ `490e652`)
- Décisions appliquées : `MULTICAM_DECISIONS_REFERENCE.md` §32 (globals jamais réécrits, best-effort 4K→FHD→HD documenté, warnings, `gpsFeature=false` → effectif Off, jamais de fallback silencieux côté natif, honnêteté `capsUnknown`, bullet SIMULATED via `setFixtureMap` uniquement, restauration par `clearFixtures()`) — architecture transport J04/J05 inchangée
- Devices physiques : B = `61d54bba7d91` (Cam 07, hôte) et C = `c0d8514d7d87` (Cam 07, second Master + device membre). `61cc29567d91` présent sur le hub **HORS PÉRIMÈTRE** (décision utilisateur) : jamais installé, jamais utilisé.
- Matériel conforme qualification : les 2 Xiaomi `24075RP89G` — sdk 36, arrière/avant `["FHD","HD"]`, **pas de 2160P**, `gpsFeature:false`, `audioMic:true`.

## Artefact validé

- APK : `app/platforms/android/app/build/outputs/apk/debug/app-debug.apk` installé **identique** sur B et C (hash vérifié au build + `adb install`)
- SHA-256 : `27115b7d55c18456648c09502a79e3408f3eec1a01abbe51b092d4957c1abad2` (cf. `apk-sha256.txt`)
- **APK corrigé (post-revue)** : rebuilt via la même chaîne `app/setup-android.sh` → SHA-256 `822da2fa2df5cd45df7b0c26573e2b99a2aa02a82829cbb0cdb7329966b81f3b` (cf. `apk-sha256-fix.txt`), installé identique sur B et C, présence PixelCopy/capture-capabilities re-vérifiée dans les sources compilées
- **APK FINAL J06 (verrouillé)** : rebuilt `app/setup-android.sh` sur HEAD `5406142` — contient `8c941e7` (transfert + mutations atomiques) + `cb98f32` (preuves T1/T2/T3) + `5406142` (idempotence `mergeSessions`) → SHA-256 `e0c460a4756a4120d92a2ebcfa3ac76bcf9daae9d3a5177f064c885710b206be` (cf. `apk-sha256-final.txt`), installé **identique** sur B et C, hash re-vérifié après `adb install` sur les deux devices (packages `base.apk` extraits == SHA build). Smoke device : démarrage sans erreur JS, session existante « Fix J06 » reprise (open, 2 membres, Take 001 4K/PRECISE), écran 05 ouvert (accordéon Transfert hors `#tkSettings`), re-sync B↔C borné (14 lignes sync/take sur 14 s) **sans boucle ni rebond** (`TAKE_IGNORED_STALE` = 0), Take final identique B==C
- Chaîne de build reproductible : `app/setup-android.sh` (npm install → platform → plugins → 3 patches dans `pixelcopy-patch/` + `capture-profile` + `capture-capabilities` → build).

## Modèle de données J06 (implémenté dans `app/www/js/state/take-model.js`)

- Take = `{ takeNumber, status:"PREPARATION", captures:[dids], storages:[dids], settings:{video:{resolution,quality,camera,orientation}, audio, gpsProfile, countdownSeconds, transferAuto, deleteLocalAfterVerifiedReplication}, captureOverrides:{<did>:{video|null,audio|null,gpsProfile|null}}, createdAtMs, updatedAtMs, updatedByDeviceId }`.
- Take 001 : FHD / HIGH / REAR / LANDSCAPE, audio true, GPS NORMAL, 5 s, transferAuto true, deleteLocalAfterVerifiedReplication true. Take 002 : deep-clone de Take 001 : sélections, réglages globaux et `captureOverrides` sont hérités ; le nouvel objet reste indépendant de Take 001.
- Overrides : hérite par défaut (`null` = global) ; personnalisation par Capture seulement (jamais les globals).
- **Horloge LMW systématique** : TOUTE mutation d'un Take (`setCapture(s)`, `setStorage(s)`, `setSetting`, `setOverride`) avance `updatedAtMs` et marque `updatedByDeviceId = acteur` — c'est la clé de convergence (§31). `takeWinner` : `(updatedAtMs, updatedByDeviceId)` puis départage canonique (clés triées récursivement) du contenu — **jamais** `JSON.stringify` brut non trié.

## Protocole J06 (`app/www/js/net/session-ws.js`)

- Déjà J04/J05 : enveloppes versionnées + `sync` / `sync_please` / take_update déjà introduit en J05 (toile de fond). J06 n'ajoute AUCUN canal : le bulletin UseCase 4.b repose sur `take_update` + `sync` + télémetry_update existants.
- **Anti-rebond take** (`handleTakeUpdate`) : un `take_update` stale (clé LMW plus vieille ou égale à un contenu local plus riche) est rejeté — log `TAKE_IGNORED_STALE` — un écho ne répresse jamais un Take local plus récent.
- Télémétrie device : `batteryLevel` + `freeBytes` + `capabilities` publiés par chaque Master pour son propre device (auto-déclarés), fusionnés dans `members[].telemetry`.

## Capacités (`app/www/js/native/capture-capabilities.js`)

- `probe()` = build chaîne native reproductible (patches capture-profile/capture-capabilities) → `{ model, sdk, cameras:{rear,front}, gpsFeature, audioMic, source:"native|fixture", unknown:false }`.
- `selfDeviceId()` = identité réelle du device (`MultiCamSessionWs.status().localDid`) — **corrigé** : elle se résolvait à `""` (l'ancien lien `MultiCamConfig.deviceId` n'existe pas dans le scope global app), ce qui cassait `capabilitiesFor(self)` → `{unknown:true}` partout.
- `capabilitiesFor(did, session)` : self → probe/cache ; peer → télémétrie auto-déclarée de la session ; sinon `{unknown:true}` honnête (jamais inventé).
- Hook SIMULATED : `setFixtureMap(did, raw)` (injecte + purge le cache) / `clearFixtures()` (**purge aussi le cache** — corrigé : la restauration repartait sur la fixture mise en cache).

## Écran 05 Take préparation (`app/www/index.html` + `app/www/js/ui/take.js`)

- En-tête : « Take 001 », badge PREPARATION, bouton Nouveau take (confirmation), ARM (J07 placeholder).
- Cards Capture (deviceId + télémétrie + 3 icônes conformité `video/audio/gps` + crayon overrides + switch) et Storage (switch). Groupes « Tout capturer » / « Tout stocker ».
- Réglages globaux : 4 selects vidéo + toggles audio/GPS + accordéon transfert (transferAuto + deleteAfterReplication) — modifiables seulement si ≥1 Capture pour vidéo/GPS/audio.
- Avertissements par device (warnings `effectiveForCapture`, override compris) + note honnête « capsUnknown ».
- Modal overrides : sections video/audio/gps, boîtes « Hériter du réglage global », sélecteurs RESTREINTS aux capacités (un device `gpsFeature:false` ne voit que `[OFF]`), boutons Sauvegarder/Annuler.

## Garde-fous déterministes (`tests/plugin-lab/`)

| Suite | Verdict |
|---|---|
| `session/take-model.test.js` (cas 1-16, dont LMW systématique, takeWinner canonique anti-vide, warnings override-aware, normalizeCapabilities idempotent) | **16/16 PASS** |
| `session/takes-session.test.js` (persistance + navigation) | **8/8 PASS** |
| `session/members-model.test.js` (J05, non-régression) | **17/17 PASS** |
| `session/merge-model.test.js` (J04 : PIN, closed>open, LMW, masters) | **7/7 PASS** |
| `node --check` sur tous les JS app modifiés | **OK** |

## Scénarios exécutés (campaign finale, `tests/e2e/j06-campaign.sh clean`)

Invariant à chaque navigation : `PANELS_OK active=panel-…` (exactement UN panneau `.active`).

| # | Scénario | État clé (dumps) | Capture | Résultat |
|---|---|---|---|---|
| J06-01 | B crée « Tournage Studio J06 » : sid, PIN, serveur 45102, 0 take, 1 Master | `J06-01-B-created.json` : sid, open, pin, takes=0, masters=1 | `J06-01-B-create-screen.png` / `J06-01-B-session-screen.png` | **PASS** |
| J06-02 | C rejoint (PIN réel) → 2 Masters égaux, 0 membre | `J06-02-B-2masters.json` : masters=2 ; `J06-02-C-joined.json` : masters=2 ; `J06-02-C-lan.json` (annonceur) | `J06-02-B/C-session-2masters.png` | **PASS** |
| J06-03 | B ajoute C membre `[capture,storage]` (cumul §31.2) → convergence SANS refresh | `J06-03-B-members.json` et `J06-03-C-converged-members.json` identiques (2 membres) | `J06-03-B-members.png` | **PASS** |
| J06-04 | B ouvre l'écran Take 001 : défauts conformes, ARM bloqué (0 capture), 2 cards | `J06-04-B-take001.json` (Take 001 défauts) ; `J06-04-B-ui-state.json` : armDisabled=true, captures=2 | `J06-04-B-take001-arm-blocked.png` | **PASS** |
| J06-05 | Capacités natives réelles sur les 2 devices, publiées + relayées ; caps numériques cohérentes | `J06-05-C-native-caps.json` : 24075RP89G, sdk 36, rear `[FHD,HD]`, gpsFeature=false ; `J06-05-B-telemetry.json` : **capsKnown=true** B et C ; `J06-05-C-take-converged.json` (Take 001 sur C) | `J06-05-B-captures-with-telemetry.png` ; `J06-05-C-take-screen.png` | **PASS** |
| J06-06 | « Tout capturer » + « Tout stocker » → captures/storages `[B,C]` persistés, ARM **débloqué** | `J06-06-B-captures-all.json` ; `J06-06-B-storages-all.json` (transferSummary) ; `J06-06-B-arm-enabled.json` : armDisabled=false | `J06-06-B-arm-enabled.png` ; `J06-06-B-storages-all.png` | **PASS** |
| J06-07 | Globals 4K + GPS Précis (au-delà des capacités) : globale non réduite, warnings `4K→FHD` + `GPS→Off` des 2 côtés, effectif C FHD/OFF | `J06-07-B-warnings.json` : globalUnchanged=true, wB=wC=[video,gps], effectiveC={FHD,OFF,fallback} ; `J06-07-C-settings-converged.json` : converged=true | `J06-07-B-warnings-4k-gps.png` | **PASS** |
| J06-08 | Modal overrides de C : section vidéo/audio/gps, GPS restreint à `[OFF]` (gpsFeature=false), personnalisation audio OFF + GPS OFF → override persisté ET converge sur C | `J06-08-B-override-ui.json` : sections=3, gpsOpts=`["OFF"]` ; `J06-08-B-overrides-c.json` et `J06-08-C-overrides-converged.json` : `{video:null,audio:false,gpsProfile:"OFF"}` **des 2 côtés** | `J06-08-B-override-modal.png` ; `J06-08-B-after-overrides.png` (GPS conformé, différent de J06-07) ; `J06-08-C-overrides-converged.png` | **PASS** |
| J06-09 | Retour « Hériter » → override C nettoyé et convergence (J06-07 == J06-09 visuellement, état restauré) | `J06-09-B-overrides-clean.json` : overridesGone=true ; `J06-09-C-overrides-clean-converged.json` : true | `J06-09-B-overrides-clean.png` (identique J06-07, état identique) | **PASS** |
| J06-10 | Take 002 (confirmation) : HMÉRITE captures/storages/4K/PRECISE, overrides vides ; Take 001 intact | `J06-10-B-take002-inherited.json` : t2 copies t1, overrides{} ; `J06-10-C-take002-converged.json` : t2=true ; `J06-10-B-take001-before-new.json` | `J06-10-B-take002.png` | **PASS** |
| J06-11 | Redémarrage B : session + Taks 001/002 persistés, current take 2 | `J06-11-B-restart-persisted.json` : count=2, captures/storages/4K | `J06-11-B-take-persisted-after-restart.png` | **PASS** |
| J06-12 | SIMULATED (`SimulatedCam4K`, 4K+GPS, LABELLÉ) sur C vs réel B : C **sans** warning, B avec warnings — **contrast=true** ; restauration native ensuite | `J06-12-C-simulated-publish.json` : SIMULATED_PUBLISHED ; `J06-12-B-simulated-contrast.json` : contrast=true ; `J06-12-C-simulated-cleanup.json` : **REAL_RESTORED model=24075RP89G** | `J06-12-B-simulated-contrast.png` | **PASS** |
| J06-13 | Convergence finale : dumps B et C **byte-identiques** (2 Taks, captures/storages `[B,C]`, 4K/PRECISE/5s, 2 membres) | `J06-13-B-final-session.json` == `J06-13-C-final-session.json` → **FINAL_CONVERGENCE takes_equal_B_C=true** | `J06-13-B/C-final.png`, `J06-13-B/C-session-view.png` | **PASS** |

Preuves : `dumps/` (32 JSON), `logs/` (parsables : `TAKE_UPDATE_LOCAL`, `TAKE_CHANGED learned_from=`, `SCREEN05_*`, `WS_*`, `MEMBER_*`), `screenshots/` (34 PNG — `png-shas.txt`), `apk-sha256.txt`.

## Complément revue humaine — preuves visuelles écran 05 (campagne evidence-only)

Campagne **evidence-only** (aucun changement de code, AUCUN rebuild) demandée par la revue humaine : elle juge la campagne initiale insuffisante pour la **partie basse** de l'écran 05 (accordéons réglages/transfert, ARM). Même APK déjà testé `27115b7d55c18456648c09502a79e3408f3eec1a01abbe51b092d4957c1abad2` (vérifié sur les 2 devices par `shasum` du `base.apk` installé). Nouvelle session « Complement J06 » `S8SDRUKR` sur B (`61d54bba7d91`) + C (`c0d8514d7d87`) second Master/membre `[capture,storage]`. Chaque capture est **validée par assertions DOM** au moment de la prise (état réel à l'écran, pas seulement le JSON).

| Check | Exigence revue humaine | Preuve visuelle (`screenshots/`) | Assertions DOM au moment de la prise |
|---|---|---|---|
| 1 | Réglages Take 001 par défaut | `J06-C-01-take001-video-defaults.png` (accordéon Vidéo ouvert) ; `J06-C-02-take001-audio-gps-countdown.png` (Audio/GPS/Compte à rebours ouverts) | 4K off / **FHD on**, **Haute on** (Éco off), **Arrière on**, **Paysage on**, **Audio Activé on**, **GPS Normal on** (Précis off), **5 s on** ; summaries « Full HD · Haute · Arrière · Paysage » / « Activé » / « Normal » / « 5 s » |
| 2 | Aucun Storage sélectionné : section Transfert visible + contrôles désactivés + warning + ARM restant possible | `J06-C-05-no-storage-transfer-disabled.png` (groupe Storage + warning + accordéon Transfert grisé) | 0 `.storage-switch:checked`, `tkStorageWarning` visible (« Aucun Storage sélectionné — les médias resteront sur les Captures. »), card Transfert `disabled-arm`, summary « Aucun Storage », body replié, **ARM activable** (1 capture cochée) |
| 3 | Storage sélectionné : contrôles transfert actifs, transfert auto ON, suppression locale ON | `J06-C-06-storage-selected-transfer-on.png` (accordéon Transfert ouvert) | 2 storages cochés, `aria-expanded=true`, transferSummary « Auto · suppression après réplication », `tkTransferAuto` checked+enabled, `tkDeleteLocal` checked+enabled, classe `disabled-arm` retirée |
| 4 | Gating visuel ARM : 0 capture → ARM désactivé ; ≥1 capture → ARM activé | `J06-C-03-arm-blocked-zero-captures.png` (ARM grisé + hint) ; `J06-C-04-arm-enabled-capture-selected.png` (ARM vert + hint) | (03) `armDisabled=true`, classes `disabled disabled-arm`, hint « Sélectionne au moins une Capture. », 0 checked / 2 switches ; (04) `armDisabled=false`, hint « Prêt. ARM lance l'écran d'armement (J07). », captures `[B]` |
| 5 | Globals incompatibles : 4K + GPS Précis visibles, warnings effectifs (4K→Full HD, GPS Précis→Off), globals inchangés | `J06-C-07-global-4k-gps-precise.png` (accordéons Vidéo/GPS ouverts, 4K et Précis sélectionnés) ; `J06-C-08-warnings-fallback.png` (2 cards, warnboxes révélées) | model `res=4K gps=PRECISE`, DOM `res4K true, gpsPrecise true` ; 2 warnboxes par card : « 4K indisponible → Full HD » + « GPS Précis indisponible → Off » ; `globalUnchanged` res=4K/gps=PRECISE, **non réduits** |
| 6 | Héritage Take 002 visible dans les contrôles (pas seulement JSON) | `J06-C-09-take002-identity.png` (« Take 002 » + PREPARATION, cards sélectionnées) ; `J06-C-10-take002-inherited-video-settings.png` (accordéon Vidéo, 4K listé) ; `J06-C-11-take002-inherited-audio-gps-countdown-transfer.png` (Audio/GPS/CD/Transfert ouverts) | `tkTakeName=Take 002`, modèle Take 2 : 4K/HIGH/REAR/LANDSCAPE/audio true/PRECISE/5 s/transferAuto true/deleteLocal true, captures `[B]`, storages `[B,C]`, overrides `{}` ; DOM contrôles reflètent l'héritage |
| 7 | Télémétrie finale des 2 devices connectés | `J06-C-12-final-telemetry-both-devices.png` (2 cards captures, lignes télémétrie) | la durée d'attente écoulée, les 2 membres (B et C) publient `telemetry=true` **des 2 côtés** ; cards B et C affichent « 100 % · 40.3/40.1 Go libres » ; **aucun « télémétrie indisponible »** dans le DOM |

**Résultat des 7 checks : 7/7 OK** — l'affichage complet de la partie basse de l'écran 05 (réglages, transfert, ARM, warnings, héritage, télémétrie) est démontré sur device physique avec l'APK exact déjà testé.

### Constats complémentaires (deux constats techniques, AUCUN correctif appliqué dans cette campagne evidence-only)

1. **Gating transfert non réellement appliqué (comportement, affichage correct)** : avec 0 Storage, l'affichage est correct (card grisée `disabled-arm`, warning, carte repliée) **mais** `tkAccTransferBtn`, `tkTransferAuto` et `tkDeleteLocal` ne sont pas réellement `disabled` : le DOM rapporte `disabled=false` et l'utilisateur peut déplier le panneau et basculer `transferAuto` (prouvé : changement effectivement persisté). Cause : l'accordéon Transfert (`#tkAccTransfer`) est **à l'intérieur de `#tkSettings`**, et la boucle de verrouillage en fin de `renderSettings` (`inputs[i].disabled = isClosed`, `take.js`) réactive ces contrôles **après** `renderStorages` (qui les avait désactivés). N'affecte pas le rendu demandé (check 2 affiché correctement) → **signalé pour décision**, correction possible : exclure le Transfert de la boucle `tkSettings`, déplacer l'accordéon hors de `#tkSettings`, ou ré-appliquer le `disabled` après `renderSettings`.
2. **Course de deux réglages dans la même tick JS (perte d'une valeur)** : deux `dispatchEvent('change')` de radios dans la même tick ont généré deux `upsertTake` construits sur le **même** `state.take` stale → le dernier écrit a écrasé le premier (GPS perdu). Un humain peut atteindre cette fenêtre (2 clics très rapprochés sur LAN). N'affecte pas le rendu demandé → **signalé pour décision** (rendre les commits de réglage séquentiels/atomiques).

## Vérification croisée captures ↔ dumps/logs + doublons

- **Invariant SPA** : `PANELS_OK active=panel-session/home/take` à chaque étape des 2 devices (pas d'empilement).
- **Dumps vs logs** : `TAKE_UPDATE_LOCAL sessionId=… take=2 event=takeChanged by=<did>` puis `TAKE_CHANGED learned_from=<did>` — un changement local est d'abord commité localement (`updatedAtMs` avancé), l'écho converge ensuite sans régression (`TAKE_IGNORED_STALE` jamais déclenché dans le run final — clocks OK).
- **Doublons** : 1 paire byte-identique **attendu** — `J06-07` == `J06-09` (retour Hériter restaure exactement l'état des warnings). « Après override » (J06-08) **diffère** → preuve visuelle de l'adaptation des warnings à l'override.

## Critères d'acceptation du plan J06

| Critère | Verdict |
|---|---|
| Take 001 créé avec les defaults attendus | ✅ J06-04 : defaults persistés et UI concordante |
| Take 002 reprend sélections, réglages et overrides du Take précédent | ✅ J06-10 : héritage par deep-clone ; indépendance Take 001 / Take 002 vérifiée |
| Les devices incompatibles montrent un warning au lieu de bloquer arbitrairement | ✅ J06-07/J06-12 : 4K→FHD et GPS→Off visibles ; ARM reste autorisable avec au moins une Capture |
| Le JSON reflète exactement l'UI | ✅ dumps/captures croisés, convergence finale B==C en J06-13 |

## Défauts corrigés pendant la validation (convergence distribuée)

1. **Convergence des captures → vidées pour toujours** (bug le plus grave) : `setCaptures`/`setStorages`/`setOverride` ne faisaient PAS avancer `updatedAtMs` → le Take modifié partait avec la même clé LMW que la copie du pair ; `takeWinner` départageait alors sur `JSON.stringify` brut → la copie **vide** gagnait (lexicographique `]` > `"`), et comme elle était immortelle, les membres convergeaient vers **zéro capture**. Corrigé : LMW systématique sur toute mutation + `takeWinner` canonique (clés triées, longueur des captures/storages prime) + anti-rebond `TAKE_IGNORED_STALE`. Preuves : `J06-06` convergé, `J06-08` convergé, `J06-13` B==C.
2. **Capacités jamais connues** : `selfDeviceId()` résolvait `""` (`MultiCamConfig.deviceId` inexistant dans le scope global) → `capabilitiesFor(self)` et la télémétrie publiait `{unknown:true}` malgré un probe natif fonctionnel. Corrigé : identité = `MultiCamSessionWs.status().localDid`. Preuves : `J06-05-B-telemetry.json` capsKnown=true B+C ; `J06-05-C-native-caps.json`.
3. **Warnings ignorants l'override** : `warningsForCapture` calculait sur les globals — un override GPS OFF sur un device sans GPS signalait quand même « GPS Précis indisponible → Off ». Corrigé : warnings basés sur `effectiveForCapture` (override appliqué). Preuve visuelle : `J06-08-B-after-overrides.png` ≠ `J06-07` (GPS conformé).
4. **`clearFixtures()` ne purgeait pas le cache** → la restauration SIMULATED republiait le fixture (SimulatedCam4K) même après nettoyage. Corrigé : purge `DEBUG_FIXTURES` **et** `CACHE`. Preuve : `J06-12-C-simulated-cleanup.json` → `REAL_RESTORED model=24075RP89G`.

## Corrections ciblées post-revue (campagne J06-FIX T1/T2/T3 — défauts détectés en revue humaine)

Deux défauts réels détectés en revue des preuves J06-C ont été **corrigés seuls** (aucune autre modification, aucune réouverture de conception J06, aucun jalon lancé). APK re-buildé + réinstallé identique sur B et C, mini-campagne physique dédiée.

| # | Défaut (racine) | Correction (fichiers) | Non-régression automatisée |
|---|---|---|---|
| 1 | **Transfert grisé mais interactif** : `#tkAccTransfer` (accordéon + `tkTransferAuto`/`tkDeleteLocal`) était imbriqué dans `#tkSettings` ; à la fin de `renderSettings`, la boucle de verrouillage `tkSettings.querySelectorAll("input, .tk-acc-btn") → disabled = isClosed` **ré-activait** les contrôles transfert juste après les avoir désactivés dans `renderStorages`. Résultat : avec 0 Storage, le bouton restait cliquable et basculait `transferAuto` dans le Take | **1)** `app/www/index.html` : `#tkAccTransfer` déplacé **hors** de `#tkSettings` (la boucle de verrouillage ne le touche plus) ; **2)** `app/www/js/state/take-model.js` : prédicat `transferControlsEnabled(take, isClosed)` = `anyStorage && !isClosed`, source unique de vérité ; **3)** `app/www/js/ui/take.js` `renderStorages` : les 3 contrôles (`tkAccTransferBtn`, `tkTransferAuto`, `tkDeleteLocal`) pilotés par la prédicat (le repli/aria/summary/warning restent gérés par `any`) | take-model.test.js **Case 18** (5 scénarios prédicat) + **Case 17** (batch) → 18/18 |
| 2 | **Mutation double même tick → valeur perdue** : deux changements de réglages globaux émis dans le **même tick JS** construisaient chacun `updated` depuis le même `state.take` et partaient en `upsertTake` parallèles → « last-writer-wins » a perdu une valeur (repro : 4K OK, PRECISE perdu) | **`app/www/js/ui/take.js`** : sérialisation des commits — file `commitQueue` + `drainCommitQueue`, chaque tâche (`enqueueTakeUpdate(fn)`) applique sur le Take **le plus frais confirmé** (`state.take` après résolution du upsert précédent) ; toutes les mutations converties (`applySettingRadio`, `saveOverrides`, `groupCaptures`/`toggleCapture`, `groupStorages`/`toggleStorage`, TRANSFER auto, DELETE_LOCAL). **`take-model.js`** : `applySettingBatch(take, pairs, actor, atMs)` cumulatif ajouté **et exporté** | take-model.test.js **Case 17** (batch cumulatif : [4K, PRECISE] même lot → les deux présents) |

**Résultats automatisés (host)** — `tests/plugin-lab/` :
- `take-model.test.js` → **18 cases OK** (16 existantes + Case 17 `applySettingBatch` + Case 18 `transferControlsEnabled`) ; `takes-session.test.js` 8 OK ; `members-model.test.js` 17 OK ; `merge-model.test.js` 7 OK — **aucune régression**.
- `ui/panels-check.test.js` → SPA OK ; `node --check` de tous les JS app OK ; `git grep commitTake` → aucune référence résiduelle.

**Mini-campagne physique (B = hôte, C = 2e Master + membre ; session « Fix J06 » `X5K25E5N`)** — preuves dans `dumps/fix-T*.json`, `logs/fix-T*.log`, `screenshots/J06-FIX-*.png` (+ `apk-sha256-fix.txt`) :

| Test | Scénario | Résultat |
|---|---|---|
| **T1** (défaut 1, 0 Storage) | 1 Capture sélectionnée, 0 Storage → DOM : `tkAccTransferBtn.disabled=true` (attribut présent), `auto/delete.disabled=true`, warning visible, « Aucun Storage », `aria-expanded=false` ; **tentatives réelles d'interaction** (clic accordéon + `.checked=false` + clic sur le switch) → accordéon non ouvert, `transferAuto` **inchangé** (`true`), `tkArm.disabled=false` (l'ARM reste indépendant) | ✅ PASS |
| **T2** (défaut 1, ≥1 Storage) | +1 Storage → les 3 contrôles `.disabled=false`, warning masqué, résumé « Auto · suppression après réplication », accordéon ouvrable ; double-clic toggle UI → round-trip **persisté** `false → true → false` (UI `checked` et model `transferAuto` en sync à chaque coup) | ✅ PASS |
| **T3** (défaut 2, même tick) | Une seule évaluation => **deux** dispatch change **synchrones** (`tkRes4K` + `tkGpsPRECISE`) — repro exact du bug : Take final `{resolution:"4K", gpsProfile:"PRECISE"}` **les deux présents** ; sur C, convergence **sans refresh** au bout de quelques secondes avec l'écho complet (`updatedBy`=B) | ✅ PASS |

Verdict des 2 corrections : **PASS technique — en attente revue humaine** (aucune acceptance humaine, aucune fusion). Le correctif d'idempotence `5406142` (mergeSessions — flake latent détecté en revue) est **intégré à l'artefact final J06** verrouillé `e0c460a4…`.

## Limitations et notes honnêtes

- **Flake `mergeSessions` / `updatedAtMs` détecté pendant la revue : corrigé et verrouillé.** Le correctif `5406142` rend le re-merge d’un état identique idempotent (`changed:false`, timestamp inchangé) et ajoute les tests déterministes correspondants ; `merge-model` est désormais à 9/9. Le correctif est inclus dans l’APK final SHA-256 `e0c460a4756a4120d92a2ebcfa3ac76bcf9daae9d3a5177f064c885710b206be`.
- **`ui/` mockups** : invariants respectés (écran 05) — l'écran production reste une implémentation Cordova (pas le mockup).
- **Fenêtre de reprise ≥4 h/24 h** : non horodatée (aucun timer de reprise dans la V1 — décision ; la persistance J06-11 prouve la non-perte).
- **3 appareils simultanés** (convergence à 3 Masters) : **NOT TESTED — DEFERRED** (même logique que J05 ; décision utilisateur, critère non affaibli).
- **Écran ARM / J07** : bouton débloqué (J06-06) mais non fonctionnel — placeholder explicite « ARM lance l'écran d'armement (J07) » (jalon suivant).
- **OCR automatique des captures** : non exécuté en V1 (pas de tesseract garantie sur le poste) — les PNG sont fournis pour revue humaine (colonnes « Capture »).

## Lancer la campagne

```bash
adb devices                          # B et C branchés (61cc29567d91 ignoré)
bash tests/e2e/j06-campaign.sh clean
```

Résultat attendu : 13 PASS technique + invariants `PANELS_OK`, `TERMINÉ`, `FINAL_CONVERGENCE takes_equal_B_C=true`.