# RAPPORT J09-08g — mini-smoke physique : le Master reçoit le `camera_state` du segment 1

**Résultat : CONFORME — 48 contrôles PASS / 0 FAIL / 2 OBS.**
Aucun fichier produit n'a été modifié. Aucune correction n'a été tentée.

---

## 1. Identification

| Élément | Valeur |
|---|---|
| Jalon | J09-08g (preuve physique que le Master reçoit le `camera_state` initial du segment 1) |
| Branche | `feat/j09-rec-previews` |
| HEAD | `184fc30` — « J09-08f : le premier camera_state atteint enfin les Masters » |
| APK | `app/platforms/android/app/build/outputs/apk/debug/app-debug.apk` |
| APK SHA-256 | `fa98c1b8215c55a9fe97c908754f504821fa314c785db725935b9bb989da66e0` (4 727 813 octets) |
| Session de preuve | `YURXSBPG` (pin 8916) |
| Tag d'artefacts | `J0908g-091024` |
| Harness | `tests/e2e/validation/J09-rec-previews/run-j09-08g.sh` |
| Médias | aucun (aucun MP4 produit ni tiré du device) |

Le run est **1 Master + 1 Capture, sans switch caméra** : la mission interdisait de
cibler l'état `switching` et d'enchaîner deux bascules.

## 2. Devices

| Rôle | Série | Modèle | deviceId | Nom affiché | Skills |
|---|---|---|---|---|---|
| A — Master | `61cc29567d91` | 24075RP89G | `91e0d5e6-a086-4c4b-820e-0435b7d97b22` | `Cam 05` | capture, storage, controller |
| B — Capture | `61d54bba7d91` | 24075RP89G | `afd69dd6-1409-4d00-b4bc-01318afc22e3` | `Cam 07` | capture, storage, controller |

Wi-Fi `CL07` : A `192.168.92.147/24`, B `192.168.92.162/24`. Endpoint annonceur :
`192.168.92.147:45102`.

A n'a **aucun rôle de membre** : il est Master pur (`aIsMember=false`), seul B est
admis avec `roles=["capture"]`. Les deux `deviceId` diffèrent de ceux de J09-08e :
les données applicatives avaient été réinitialisées entre-temps (`pm clear`), ce qui
a aussi révoqué les permissions — `CAMERA` et `RECORD_AUDIO` ont été réaccordées
avant tout run.

## 3. Déroulé de la preuve

| Étape | Résultat |
|---|---|
| Preflight (permissions, focus, preview, phase) | 10/10 PASS sur les 2 devices |
| Session créée, B rejoint par l'annonceur | PASS, endpoint lu |
| Admission de B | `member=true`, `roles=["capture"]`, membres = 1 |
| Take : sélection + ARM | 1 seule Capture proposée, `recEligible=true` |
| Ouverture du segment 1 | PASS — `CAMERA_SEGMENT_OPEN segmentIndex=1 camera=REAR take=1` |
| Émission côté Capture | PASS — `CAMERA_STATE_TX … masters=1` (1 émission) |
| Réception côté Master | PASS — inbox alimentée, `mSeen=1` |
| UI Master | PASS — 4 contrôles (plus « Caméra inconnue », caméra active, segment 1, état REC) |
| Aucun rejet | PASS — ni `CAMERA_STATE_DROP` ni `CAMERA_TRANSPORT_DROP` |
| STOP propre | PASS — 6 contrôles |
| Code produit intact pendant le run | PASS |

## 4. La preuve

### Côté Capture (B) — l'émission

```
10-06 09:11:23.896  CAMERA_REC_OK startPlanId=YURXSBPG#1#1#1 take=1 ackAtMs=1791270683896 callDt=521ms detail="OK"
10-06 09:11:23.899  CAMERA_SEGMENT_OPEN segmentIndex=1 camera=REAR take=1
10-06 09:11:23.904  CAMERA_STATE_TX sessionId=YURXSBPG deviceId=afd69dd6-…-01318afc22e3 activeCamera=REAR switchingCamera=— masters=1
```

La **première** `CAMERA_STATE_TX` du tampon porte `masters=1` : le défaut décrit par
`RAPPORT-J09-08E.md` (commit `060fd88`, `masters=0` à l'émission du segment 1) ne
s'est pas reproduit. `activeCamera=REAR` est la
relecture native, `switchingCamera=—` (aucune bascule).

### Côté Master (A) — la réception

`dumps/J0908g-091024-11-A-inbox-seg1.json` :

```
mCam=REAR | mSeg=1 | mSegState=recording | mRec=true | mTake=1
mUpdatedAt=1791270684098 | mAtMs=1791270683898 | mSeen=1
```

- `mSeg=1` / `mSegState=recording` / `mRec=true` : le segment 1 du REC est bien connu
  du Master **pendant** le REC.
- `mCam=REAR` : **identique** à `activeCamera` de B — pas de divergence.
- `mTake=1` : rattaché au même Take que celui engagé depuis A.
- `mAtMs>0` : le paquet porte une mesure horodatée de la Capture (pas d'un relais).

Aucun log de réception n'existe côté Master (le produit n'en émet pas) : la preuve de
réception est l'inbox + l'**absence** de `CAMERA_STATE_DROP` / `CAMERA_TRANSPORT_DROP`
dans `logs/…-master-rec.log` (21 lignes, aucun rejet).

### Côté Master — l'UI (avant toute bascule)

`logs/J0908g-091024-arrivee-master.txt` :

```
1791270685855 mSeg=1 mSegState=recording mRec=true mCam=REAR mSeen=1
```

Modal Master (`#ldCamState`) : **`Caméra Arrière · segment 1 · enregistrement`**
(screenshot `screenshots/J0908g-091024-02-master-modal-seg1.png`).

Donc : plus de « Caméra inconnue », caméra active visible, segment 1 visible, état
enregistrement visible — **sans aucune bascule, au moment exact du début du REC**.

### STOP propre

| | Capture (B) | Master (A) |
|---|---|---|
| état | `rec=false`, `seg=0`, `segState` vide | `mSeg=0`, `mRec=false` |
| modal | — | `Caméra Arrière · aucun segment actif · n'enregistre pas` |
| logs | `CAMERA_REC_STOP_OK … previewKept=1`, `CAMERA_SEGMENT_FINAL … reason=stop` | aucun rejet |

Aucune mention de « segment 0 ». Screenshot `…-03-master-modal-stop.png`.

## 5. Mesures

| Mesure | Valeur | Portée |
|---|---|---|
| Observation du segment 1 sur le Master | **+336 ms** | borne haute, **horloge A** (écart entre l'observation du REC et la première observation de l'état) |
| Publication côté Capture | `updatedAtMs − atMs` = **200 ms** | horloge B, latence locale de publication |

Les horloges A et B ne sont pas synchrones : aucun écart inter-device n'est utilisé
comme preuve. Voir §7 (OBS n°1).

## 6. Conformité aux exigences de J09-08g

| Exigence | Résultat |
|---|---|
| Capture : `activeCamera` confirmée | **PASS** (`REAR`, relecture native) |
| Capture : `segmentIndex=1` | **PASS** |
| Capture : `segmentState=recording` | **PASS** |
| Capture : `recording=true` | **PASS** |
| Capture : `CAMERA_STATE_TX … masters=1` | **PASS** |
| Master : réception du `camera_state` segment 1 | **PASS** (`mSeen=1`) |
| Master : `activeCamera` identique à celle de B | **PASS** (`REAR`) |
| Master : `segmentIndex=1` | **PASS** |
| Master : `segmentState=recording` | **PASS** |
| Master : `recording=true` | **PASS** |
| Master : plus « Caméra inconnue » | **PASS** |
| Master : caméra active visible avant toute bascule | **PASS** |
| Master : segment 1 visible | **PASS** |
| Master : état enregistrement visible | **PASS** |
| STOP propre | **PASS** (6 contrôles) |

## 7. Observations hors périmètre (non traitées, décision attendue)

1. **Sync dégradée sur le Take** : le modal d'incident d'ARM s'est ouvert sur
   `« Dégradée · delta −177 ms / dispersion 32 ms »` (`skillStatus=WARNING`,
   `key=sync`), contourné par « Continuer REC ». Cela n'affecte pas la réception du
   `camera_state`, mais **fragilise toute mesure d'horodatage inter-device** : les
   chiffres du §5 sont des bornes hautes locales, pas des latences réseau.
2. **`availableCameras` vide au segment 1** : `dumps/…-10-B-view-seg1.json` donne
   `availableCameras: []`, donc la modal Master affiche `ldCamNote = « Aucune caméra
   annoncée par cette Capture. »` et propose 0 bouton de caméra.
   **Identique en J09-08e** (dump `J0908e-222328-10-B-view-seg1.json`) : c'est le
   comportement de référence, pas une régression introduite par J09-08f/08g.
   `refreshAvailability()` n'est appelé que depuis `prepareForSwitch()`
   (`camera-switch-service.js:678`) — hors périmètre de cette mission (0 switch).
3. **`session.masters` contient 2 entrées** (`91e0d5e6…` et `afd69dd6…`) alors qu'il
   n'y a qu'un Master. Ce n'est **pas** une liste de rôles : tout joiner y est upserté
   (`session-ws.js:1306` sur `join_req`, `:1479`), et le dump de référence
   `J0908e-222328-03-A-members.json` montre la même paire. Le contrôle de topologie
   a donc été reformulé sur `members` (1 seul membre, `capture`, A absent) ;
   `masterRoster` est conservé en OBS.
4. **Take résiduel après STOP** : le Master reste `phase=REC` et la Capture
   `phase=STOPPED` jusqu'à une nouvelle session (comportement de référence, J09-08e
   s'arrête aussi en STOP local). Le harness fait donc un cycle
   `force-stop` + relance + attente de boot `IDLE` avant chaque exécution.

## 8. Historique des exécutions (3 runs)

| Tag | Issue | Décision |
|---|---|---|
| `J0908g-083946` | **Environnement** : `RECORD_AUDIO` non accordé → `GrantPermissionsActivity` recouvre l'app → `foreground=false` → recorder natif jamais démarré (`CAMERA_REC_STOP_KO … recorderRunning=0` NPE) → aucun segment, 0 `CAMERA_STATE_TX` | invalidé, artefacts retirés |
| `J0908g-085842` | Mesures conformes, **1 faux-échec du harness** : contrôle « exactement UN Master » formulé sur `session.masters` (voir §7 n°3) | invalidé, artefacts retirés, contrôle reformulé |
| `J0908g-091024` | **48 PASS / 0 FAIL** | **preuve retenue** |

Correctifs de harness appliqués entre les runs : permissions en preflight bloquant,
cycle de remise à zéro (§7 n°4), `logcat -G 4M` et purge au bon moment (le run 1
avait perdu les journaux du REC en purgant après le REC), contrôle de topologie
reformulé sur `members`, `logcat` non purgé au STOP, `T_REC`/`T_ARR` relevés sur
l'horloge de A.

## 9. Artefacts

```
tests/e2e/validation/J09-rec-previews/
├── RAPPORT-J09-08G.md               ce rapport
├── run-j09-08g.sh                   harness (outil de preuve, non produit)
├── logs/J0908g-091024-*             12 fichiers (checks, mesures, arrivée, apk,
│                                    logcat Capture/Master par étape, console)
├── dumps/J0908g-091024-*            15 dumps JSON (boot, session, join, membres,
│                                    rôles, arm, incident, état Capture, inbox Master,
│                                    detail Master, état après STOP)
└── screenshots/J0908g-091024-*      3 captures (take, modal segment 1, modal STOP)
```

Points d'entrée : `logs/J0908g-091024-checks.txt` (48 PASS / 0 FAIL),
`logs/J0908g-091024-61d54bba7d91-capture-rec.log` (l'émission),
`logs/J0908g-091024-61cc29567d91-master-rec.log` (la non-réception de rejet),
`dumps/J0908g-091024-11-A-inbox-seg1.json` (la réception),
`screenshots/J0908g-091024-02-master-modal-seg1.png` (l'UI).

**Aucun MP4 dans le dépôt.** Le seul `.mp4` sous `tests/e2e/` est
`logs/40-preview-transport-30s/capture-take.mp4`, déjà versionné avant cette mission
(et non modifié).

## 10. Reproductibilité

```
./tests/e2e/validation/J09-rec-previews/run-j09-08g.sh
```

Le script vérifie seul l'environnement (permissions, focus, preview, phase), refuse
de produire des preuves en cas d'échec de preflight, repart d'une remise à zéro, et
écrit sa synthèse dans `logs/<TAG>-checks.txt`. Un nouvel exécution produit un nouveau
`TAG` horodaté ; les fichiers J09-08e et J09-08f antérieurs sont intacts.

## 11. Conclusion

Sur cette prise, **le premier `camera_state` atteint le Master à l'ouverture du
segment 1**, avec la bonne caméra, le bon segment, l'état `recording`, et
`masters=1` dès la première émission — donc **le défaut J09-08e est bien corrigé par
`184fc30`**, vérifié sur matériel réel et sans aucun switch.

`git status --short` avant commit : uniquement `run-j09-08g.sh`,
`RAPPORT-J09-08G.md` et les artefacts `J0908g-091024-*` ; aucun fichier produit
modifié.
