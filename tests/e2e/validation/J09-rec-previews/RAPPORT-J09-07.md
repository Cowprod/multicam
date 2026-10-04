# J09-07 — Changement de caméra pendant le REC

Bascule REAR ↔ FRONT d'une Capture, demandée par le Master **pendant l'enregistrement**,
avec clôture du segment en cours et reprise de l'enregistrement sur la nouvelle caméra.

Date de validation : 2026-10-04
Devices : Master `61cc29567d91` (`0c542f4c-c3d8-43cd-9e03-aaf004ba3ee4`) — Capture `61d54bba7d91` (`68f01a99-254d-47d8-926b-bbf62be09230`)
Campagne reproductible : `tests/e2e/validation/J09-rec-previews/run-camera-switch.sh`

---

## 1. Verdict

**PASS.** La bascule demandée par le Master pendant le REC est exécutée, segmentée,
confirmée par relecture native, et relayée au Master. Le REC n'est pas interrompu.

Trois exécutions consécutives ont produit le même résultat. Session de référence :
`6NV42BFH`, Take 1, `commandId=cs-mut2oku9-6k2dqu`.

## 2. Ce qui est démontré sur device

| Critère | Preuve | Valeur |
|---|---|---|
| Commande du Master pendant REC | `CAMERA_SWITCH_BEGIN` | `recording=1`, `requested=FRONT`, `active=REAR` |
| Segment N clos **avant** bascule | `CAMERA_SWITCH_SEGMENT_CLOSED` | `videoTmp_10.mp4`, `stopDt=489 ms` |
| Bascule native | `J09_CAMERA_SWITCH_NATIVE` | `from=0 to=1 facing=front dt=524 ms` |
| Confirmation par **relecture**, pas par callback | `CAMERA_SWITCH_OK` | `confirmed=FRONT cameraId=1 nativeMs=524` |
| Reprise du REC sur la nouvelle caméra | `CAMERA_SWITCH_SEGMENT_OK` | `segmented=1 restarted=1 gapMs=1680` |
| Segment indexé, avec caméras | `CAMERA_SWITCH_CONFIRM` | `segmentIndex=1 fromCamera=REAR toCamera=FRONT` |
| ACK au Master | `CAMERA_SWITCH_REPLY` | `ok=1` |
| **REC non interrompu** | `10-B-rec-integrity.json` | `starts=2 recording=true prepared=true` |
| Preview toujours une image réelle | `png_stats.py` × 3 | `VERDICT: CAMERA_LIVE`, `FLAT: NO (photographic)` |
| Cible hors modèle refusée | `CAMERA_SWITCH_REJECT` | `code=unknown_camera`, aucun segment clos |
|Supervision Master correcte | `09-A-inbox.json` | `phase:"REC"`, `cameraPhase:"active:FRONT"`, `availableCameras:["REAR","FRONT"]` |

Chronologie reconstituée depuis `logs/80-camera-switch-run.txt` :

```
CAMERA_SWITCH_ATTACH  sessionId=6NV42BFH take=1 segmentIndex=0
CAMERA_SWITCH_BEGIN   commandId=cs-mut2oku9-6k2dqu requested=FRONT active=REAR recording=1
CAMERA_REC_STOP_OK    path=.../videoTmp_10.mp4 previewKept=1
CAMERA_SWITCH_SEGMENT_CLOSED target=FRONT path=.../videoTmp_10.mp4 stopDt=489ms
J09_CAMERA_SWITCH_NATIVE from=0 to=1 facing=front dt=524ms
CAMERA_SWITCH_OK      confirmed=FRONT alreadyActive=0 cameraId=1 nativeMs=524 callDt=480ms
CAMERA_REC_OK         startPlanId=6NV42BFH#1#1#1 take=1
CAMERA_SWITCH_SEGMENT_OK segmented=1 restarted=1 gapMs=1680
CAMERA_SWITCH_CONFIRM commandId=cs-mut2oku9-6k2dqu confirmed=FRONT segmentIndex=1 gapMs=1680
CAMERA_SWITCH_REPLY   ok=1
CAMERA_REC_STOP_OK    path=.../videoTmp_11.mp4        (STOP local)
```

`starts=2` : le device a bien exécuté deux `startRecordVideo`, encadrés par un segment
clos. Le gap de 1680 ms est le temps où le film est.interrompu — mesuré, publié, non masqué.

## 3. Défauts trouvés par le device, corrigés

Aucun de ces défauts n'aurait été visible sur les tests unitaires.

### 3.1 `phase` : deux notions sous un même nom

Le service de bascule exposait `view().phase = "switching:FRONT"`, et la diffusion
`camera_state` reprenait cette valeur. La supervision Master affichait donc
« phase : FRONT » — un **facing** présenté comme une **phase de session**.

Le même nom existait déjà dans le modèle pour la phase START (`IDLE`/`COUNTDOWN`/`REC`).

Corrigé : `phase` ne porte plus que la phase START, relayée depuis le start-service ;
l'état caméra s'appelle `cameraPhase` (`active:REAR`, `switching:FRONT`, `unknown`).
Test B1/B1b/B1c : un facing ne peut plus se lire comme une phase.

### 3.2 `fromCamera` fabriqué à partir de la cible

Le segment se clôture **après** la bascule, donc `activeCamera` vaut déjà la cible.
Reprendre cette valeur pour `fromCamera` produisait `from == to` et rattachait le
fichier à la mauvaise caméra.

Corrigé : plus de repli sur la cible. Un départ inconnu reste `""`. Tests M11/M11b.

### 3.3 `activeCamera` vide : une information native perdue

Au boot la caméra n'est pas préparée, donc `activeCamera` restait `""` jusqu'à la première
bascule — et le premier segment se retrouvait avec `fromCamera:""` alors que le natif
savait qu'on filmait en REAR.

Corrigé : `syncActiveCamera()` est relu avant chaque bascule. Test S8b.
Désormais `CAMERA_SWITCH_BEGIN ... active=REAR` et `fromCamera:"REAR"` sur device.

### 3.4 Packaging : le wrapper JS plugin n'arrive jamais au build

`cordova prepare` ne rafraichit pas `platform_www/`. Le build embarquait donc un
`CameraPreview.js` **construit avant le patch**, sans `switchCameraTo`/`getCameraState`,
alors que les sources du plugin, elles, étaient patchées. Le Java compilait (recopié
explicitement), donc rien ne signalait l'écart.

**Piège fermé — et surtout pas contourné.** Copier le wrapper depuis `plugins/` ne
fonctionne pas : Cordova enveloppe chaque `www` de plugin dans
`cordova.define("id.nom", function(require, exports, module) {…})` à l'installation.
Une copie brute produit, mesuré sur les deux devices :

```
Uncaught ReferenceError: require is not defined   (CameraPreview.js:1)
→ deviceready ne part plus → l'application ne démarre plus
```

Un wrapper cassé vaut bien pire qu'un wrapper incomplet. Le complétion est donc laissée
à `installSwitchShim()` côté application (chemin `cordova.exec`, testé, et celui qui a
validé ce rapport). `setup-android.sh` **constate** l'absence et le dit, au lieu de
laisser une divergence silencieuse.

### 3.5 Outillage de campagne (non produit)

- Le bouton REC ouvre un **modal d'incident** quand une Capture est en `WARNING`
  (ici : synchronisation dégradée, `delta -971 ms`). Le script fermait ce modal *avant*
  d'avoir cliqué REC : le REC ne partait jamais.
- Les dumps CDP sont des chaînes JSON : leurs guillemets sont échappés. Les motifs
  shell `"rec":true` ne matchaient donc jamais, et un contrôle pourtant satisfaite
  déclenchait un `FATAL` trompeur.
- `date +%s%3N` est une extension GNU ; sur macOS il renvoie un `N` littéral.
- `shot()` ajoutait une seconde extension `.png`.

## 4. Limites connues

- **Un modal d'incident est requis pour partir.** Toute Capture en `WARNING` (sync,
  stockage, permission) impose de passer par « Continuer REC ». Le parcours est correct
  mais il est un obstacle pour quiconque pilote l'écran.
- **Désynchronisation d'horloge persistante** entre les deux devices : `delta ≈ -971 ms`,
  dispersion 15–67 ms. Sans effet sur la bascule (qui mesure des durées *intra-device*),
  mais c'est la cause du `WARNING`.
- Le gap pendant bascule est de **1.4–1.7 s** sur ce device. C'est le prix de
  `stopRecordVideo` → confirmation du fichier → `switchCameraTo` → `startRecordVideo`.
  Aucune optimisation n'a été tentée : la séquence est imposée par le modèle de segmentation.
- Un seul device Capture dans la session. La bascule **multi-cibles simultanée** n'a pas
  été testée.
- Les segments restent dans le cache applicatif (`videoTmp_*.mp4`) : le SAF et le
  renommage final ne sont pas dans le périmètre de J09-07.

## 5. Reproduction

```bash
# les deux devices doivent tourner sur des sessions propres
cd app && npx cordova build android
adb -s <MASTER>   install -r platforms/android/app/build/outputs/apk/debug/app-debug.apk
adb -s <CAPTURE>  install -r platforms/android/app/build/outputs/apk/debug/app-debug.apk

cd ../tests/e2e/validation/J09-rec-previews
./run-camera-switch.sh
```

Le script crée la session, fait rejoindre la Capture par le **chemin UI réel**, admet le
membre, arme, passe le modal d'incident, déclenche le REC, demande la bascule, relit les
preuves, tente une cible hors modèle, arrête, et collecte logs + dumps + screenshots.

Sortie de référence : `logs/80-camera-switch-run.txt`.

## 6. Tests

`cd app && node tests/run.js` → **181 passed, 0 failed**.

Bloc J09-07 : `node tests/run.js camera-switch` → 41 tests, incluant les non-régressions
B1/B1b/B1c (collision `phase`), M11/M11b (`fromCamera`), S8b (facing natif relu avant bascule).