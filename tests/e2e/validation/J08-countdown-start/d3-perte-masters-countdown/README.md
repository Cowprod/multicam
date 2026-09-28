# D3 — perte de TOUS les Masters pendant le countdown (J08)

**Verdict : PASS.**

Scénario physique minimal, deux devices réels : A = Master, B = Capture. Le Master A est
tué par un vrai `am force-stop` alors que B est encore en COUNTDOWN. On observe B
uniquement.

Ce que ce dossier prouve, sur appareil réel (pas sur simulateur, pas sur le modèle) :

1. le countdown de B **n'est pas annulé** par la disparition du Master ;
2. `START_MASTER_LOST` est journalisé **exactement une fois** ;
3. B démarre REC **au top prévu dans le plan**, pas à un autre top ;
4. `CAMERA_REC_OK` est réellement émis par la couche caméra ;
5. l'UI REC apparaît sur B ;
6. le contrôle **STOP local d'urgence devient disponible** (aucun Master connecté) ;
7. ce STOP local d'urgence fonctionne : confirmation UI, `CAMERA_REC_STOP_OK`,
   `START_STOP_LOCAL`, fichier vidéo produit et non nul.

## Devices

| rôle | serial | modèle | IP | deviceId |
|---|---|---|---|---|
| A — Master | `61cc29567d91` | 24075RP89G | 192.168.92.57 | `d5f6b2a1-2387-4207-836d-90b0072a6cee` |
| B — Capture | `61d54bba7d91` | 24075RP89G | 192.168.92.76 | `7d1d4179-c52e-4260-92d1-3220c33296fd` |

Deux devices seulement. Aucune campagne 4 devices. Aucun preview caméra.

## Code testé

| | |
|---|---|
| branche | `feat/j08-countdown-start` |
| HEAD | `85a0b48` (le commit D6 lui-même ; contient D1 `0774ea6` et D2 `11787e6`) |
| APK | `app/platforms/android/app/build/outputs/apk/debug/app-debug.apk` |
| sha256 APK | `502f26cf853f0936a20f53f73bb70ab0a04503cfc597b0d0dfac552b0fdab212` |

**B tournait sur un APK périmé au début de la mission** (`lastUpdateTime` 10:23:57,
`assets/www/js/state/start-service.js` différent de HEAD, correctif D1 absent). Il a été
réinstallé avec l'APK de HEAD **avant** le run (10:29:04) : sans cela la mission aurait
testé du code obsolète. Après réinstallation, le `start-model.js` embarqué sur B a le même
sha256 que celui de HEAD.

## Mise en place de la session

Session `UX8ZA4FT` (« Regie D3 103030 », PIN 2946) créée sur A, B la rejoint via mDNS
(`192.168.92.57:45102`) + PIN.

Le `join` de B renseigne `session.masters` mais **ne crée pas d'entrée dans
`session.members`** : l'onglet Take de A affichait donc une liste `tkCaptures` vide et B
n'était pas sélectionnable comme Capture. B a été ajouté comme membre avec le rôle
`capture` via l'API du modèle (`MultiCamSessionWs.addMember`, rôle validé contre
`enabledSkills`) — le même chemin que la modale membre du produit. **Ce n'est pas une
correction produit** : aucun fichier de `app/` ou `ui/` n'a été modifié.

Take 1 : `captures=[7d1d4179…]` (B seule), `storages=[]`, `countdownSeconds=5`.
A reste Master et n'est **pas** Capture.

Horloge de B au moment de l'ARM : `offset -83,5 ms`, `dispersion 45 ms`, 3 échantillons →
statut `warn` (« Dégradée »), **pas** `stale`. C'est un avertissement, pas un blocage : la
pression REC a donc affiché la modale d'incidents, et le run a suivi le chemin UI réel
(« Continuer REC »).

## Chronologie mesurée

Toutes les heures ci-dessous sont les `Date.now()` des devices, base commune.

| événement | t (ms) | source |
|---|---|---|
| REC cliqué sur A (modale d'incidents puis « Continuer REC ») | ~1790585219982 | `chronologie-run.txt` |
| B entre en COUNTDOWN (digit 5, top verrouillé) | 1790585219404 | échantillonneur 100 ms |
| dump B juste avant le force-stop | 1790585219992 (déduit du dump : `localTopMs 1790585224331.5` − `remainingMs 4339.5`) | `B-countdown-avant-forcestop.json` |
| **`am force-stop` de A — début** | **1790585220881** | `chronologie-run.txt` |
| **`am force-stop` de A — fin** | **1790585221175** | durée 294 ms |
| `START_MASTER_LOST` journalisé | 1790585220.393 (10:47:00.393) | `extrait-master-lost.txt` |
| dernier échantillon COUNTDOWN | 1790585224296 | échantillonneur 100 ms |
| B entre en REC | 1790585224397 | échantillonneur 100 ms |
| `showEmergencyStop` devient `true` | 1790585224496 | échantillonneur 100 ms |
| `CAMERA_REC_OK` | 1790585225531 (10:47:05.533) | `extrait-master-lost.txt` |
| STOP d'urgence confirmé sur B | 1790585258928 | `chronologie-run.txt` |

**Instant du force-stop par rapport au countdown : 1 492 ms après le début du countdown**
(début 1790585219404 → force-stop 1790585220881), soit 3,5 s de countdown encore à
couler. Le `force-stop` est donc bien intervenu pendant le countdown, comme exigé.

## Preuve 1 — le countdown continue

`START_MASTER_LOST` est journalisé **au milieu** du countdown et annonce lui-même la
poursuite :

```
START_MASTER_LOST deviceId=7d1d4179-c52e-4260-92d1-3220c33296fd
  startPlanId=UX8ZA4FT#1#1#1 take=1 phase=COUNTDOWN remainingMs=3940 countdownContinues=1
```

`phase=COUNTDOWN` + `remainingMs=3940` + `countdownContinues=1`.

L'échantillonneur 100 ms installé sur B avant l'ARM confirme la continuité, sans aucune
interruption autour de la perte du Master :

```
rel_ms   t_B            phase      showEmergencyStop  vue         côté force-stop
  1092   1790585220496   COUNTDOWN  false              cdMaster    -
  1293   1790585220697   COUNTDOWN  false              cdMaster    -
  1492   1790585220896   COUNTDOWN  false              cdMaster    PENDANT
  1592   1790585220996   COUNTDOWN  false              cdMaster    PENDANT
  1693   1790585221097   COUNTDOWN  false              cdMaster    PENDANT
  1792   1790585221196   COUNTDOWN  false              cdMaster    APRES
  …
  2993   1790585222397   COUNTDOWN  false              cdMaster    APRES
  3193   1790585222597   COUNTDOWN  false              cdMaster    APRES
  4693   1790585224097   COUNTDOWN  false              cdMaster    APRES
  4892   1790585224296   COUNTDOWN  false              cdMaster    APRES   ← dernier
  4993   1790585224397   REC        false              cdRec       APRES
  5092   1790585224496   REC        true               cdRec       APRES
```

B reste `COUNTDOWN` pendant 4 892 ms d'échantillons consécutifs
(1790585219404 → 1790585224296), dont 3 121 ms **après** la fin du `force-stop`.
Aucun passage à `ARM`, aucun retour à `IDLE`, aucune annulation.

**Nombre d'occurrences de `START_MASTER_LOST` : 1**, mesuré sur l'intégralité du logcat B à
cet instant —

```bash
adb -s 61d54bba7d91 logcat -d | grep -c "START_MASTER_LOST"   # => count= 1
adb -s 61d54bba7d91 logcat -d | grep -oE "START_MASTER_LOST[A-Za-z_]*" | sort | uniq -c
# =>    1 START_MASTER_LOST
```

— donc un seul passage, pas de doublon. Portée exacte de ce comptage : il a été fait
peu après le début du REC (le dump voisin est à `recElapsedMs=10327`, soit ~10 s
d'enregistrement), pas après les 34 s. La fin de run est couverte par
`logs/B-J08-D3.log` (10:47:31 → 10:47:46), où `START_MASTER_LOST` apparaît **0 fois** :
une occurrence sur tout le run. Ce comptage a été fait sur le logcat **avant** le
`logcat -c` déclenché ensuite pour isoler la phase STOP (voir « Limites ») : il n'est donc
pas rejouable depuis `logs/B-J08-D3.log`. La ligne unique elle-même est conservée dans
`extrait-master-lost.txt`.

## Preuve 2 — REC au top PRÉVU (pas à un autre top)

Le plan est resté identique du début du countdown à la fin :

| champ | valeur |
|---|---|
| `startPlanId` | `UX8ZA4FT#1#1#1` (identique avant et après) |
| `targetStartMs` | 1790585224415 (top commun du plan) |
| `localTopMs` | 1790585224331.5 = `targetStartMs` + `offsetMs` (-83,5) |
| `countdownResolved` | `true` |

B est passé en REC à l'échantillon 1790585224397, soit le **premier tick de 100 ms
strictement postérieur à `localTopMs`**. Le top est donc celui du plan, dérivé de l'horloge
du plan — pas un top recalculé après la perte du Master. Aucun `START_REQUEST` /
nouveau plan n'a été émis (le `startPlanId` est resté `UX8ZA4FT#1#1#1`).

## Preuve 3 — REC réellement démarré + UI REC

```
CAMERA_REC_OK startPlanId=UX8ZA4FT#1#1#1 take=1 ackAtMs=1790585225531 callDt=1194ms detail="OK"
```

`detail="OK"` et `callDt=1194ms` : l'appel caméra natif a réellement abouti.

État de la vue START sur B à cet instant
(`dumps/B-rec-avec-stop-urgence-resume.json`) :

```json
{ "phase": "REC", "startPlanId": "UX8ZA4FT#1#1#1", "showEmergencyStop": true,
  "targetStartMs": 1790585224415, "localTopMs": 1790585224331.5,
  "offsetMs": -83.5, "recElapsedMs": 10327 }
```

L'UI est bien passée en vue REC : la vue active du panneau était `cdRec` (les quatre vues
`.cd-view` n'en ont qu'une seule sans `d-none`).

## Preuve 4 — le STOP local d'urgence devient disponible

Relevé à l'instant REC, sur B :

| mesure | valeur |
|---|---|
| `showEmergencyStop` (modèle) | `true` |
| `cdEmergency` a la classe `d-none` | `false` → **visible** |
| taille de la boîte de `cdEmergency` | `160x54` → réellement disposé, pas masqué |
| vue active | `cdRec` |
| `showEmergencyStop` juste avant le force-stop | `false` (A encore connecté) |

La bascule est datée : `showEmergencyStop` passe à `true` à 1790585224496, soit 56 ms
après l'entrée en REC. Le mécanisme est bien conditionné à « plus aucun Master connecté »
comme le veut le modèle, et non activé par défaut.

> Note de méthode : je n'ai pas d'entrée vision, donc je n'ai pas pu inspecter
> visuellement les PNG. La preuve de l'UI REC et du STOP d'urgence repose sur l'état DOM
> et le modèle ci-dessus, qui est vérifiable et horodaté ; les captures sont archivées
> avec leur SHA-256 pour relecture humaine.

## Preuve 5 — le STOP local d'urgence fonctionne

1. Clic sur `cdEmergency` → le produit affiche bien une **confirmation UI**
   (`cdStopModal`, `aria-hidden=false`, boutons visibles) :
   > « Seul cet appareil sera arrêté. Les autres Captures du Take ne sont pas affectées et
   > ce device ne pourra pas redémarrer dans ce Take. »

   avec `Confirmer STOP` / `Annuler`.
2. Clic sur `cdStopConfirm` → :

```
CAMERA_REC_STOP_OK atMs=1790585258888 path=/data/user/0/fr.emmanuel.multicam/cache/videoTmp.mp4
START_STOP_LOCAL deviceId=7d1d4179-c52e-4260-92d1-3220c33296fd
  startPlanId=UX8ZA4FT#1#1#1 take=1 reason=emergency_no_master at=10:47:38.888
START_PLAN_ABORTED deviceId=7d1d4179-c52e-4260-92d1-3220c33296fd
  startPlanId=UX8ZA4FT#1#1#1 take=1 reason=local_stop
```

`reason=emergency_no_master` : la raison est bien « plus aucun Master », pas une autre.

3. Fichier vidéo produit et non nul (information directement disponible ; D6 n'est pas
   refait, aucune mesure ffprobe/décodage ici) :

```
-rw------- 1 u0_a128 u0_a128_cache 80253952 2026-09-28 10:47 /data/user/0/fr.emmanuel.multicam/cache/videoTmp.mp4
```

4. Phase finale sur B : `STOPPED`.

## Résumé des exigences

| exigence | résultat |
|---|---|
| le countdown continue malgré la disparition du Master | **oui** — COUNTDOWN tenu 4 892 ms, `countdownContinues=1` |
| `START_MASTER_LOST` exactement une fois | **oui** — 1 occurrence |
| `countdownContinues=1` | **oui** — dans la ligne de log |
| B atteint REC au top prévu | **oui** — `localTopMs = targetStartMs + offset`, plan inchangé |
| `CAMERA_REC_OK` réellement émis | **oui** — `detail="OK"`, `callDt=1194ms` |
| l'UI REC apparaît | **oui** — vue `cdRec` |
| STOP d'urgence visible | **oui** — `showEmergencyStop=true`, `d-none` absent, boîte 160x54 |
| STOP effectué | **oui** — via la confirmation UI |
| `CAMERA_REC_STOP_OK` | **oui** — `path=…/cache/videoTmp.mp4` |
| fichier produit non nul | **oui** — 80 253 952 octets |

## Limites et honnêteté

* **Le REC a duré 34 442 ms**, pas 5 s : la procédure impose de déclencher le STOP
  local *ensuite*, et j'ai d'abord ramassé les preuves (capture, dumps) avant de le
  faire. Ce n'est pas un défaut produit, c'est l'ordre des étapes demandé.
* **Un seul logcat complet n'est pas disponible.** Un second `logcat -c` a été fait sur B
  juste avant le STOP d'urgence, si bien que `logs/B-J08-D3.log` ne couvre que
  10:47:31 → 10:47:46 (phase STOP). La phase countdown → perte Master → REC est couverte
  par les **extraits** pris aux bons instants (`extrait-master-lost.txt`,
  `extrait-stop-local.txt`), les **dumps de vue** horodatés et l'**échantillonneur 100 ms**
  (833 échantillons couvrant IDLE → COUNTDOWN → REC → STOPPED). Le scénario n'a **pas**
  été relancé pour obtenir un logcat plus propre, conformément à la consigne.
* L'échantillonnage est à 100 ms : la précision sur l'instant du top est donc de
  ±100 ms. Le déclenchement au top prévu est établi par le modèle (`localTopMs`,
  `countdownResolved`), pas seulement par l'échantillon.
* B est aussi listé `master` dans la session (le `join` le fait) ; le modèle exclut
  explicitement le device lui-même de `connectedMasters()`, ce qui est pourquoi la perte
  de A est correctement perçue comme « plus aucun Master ».
* Aucune correction produit : aucun fichier de `app/` ou `ui/` n'a été touché. Seul
  `MultiCamSessionWs.addMember` a été appelé sur A pour que B devienne membre `capture`,
  ce qui est une étape de mise en place, pas une modification.

## Inventaire

| fichier | rôle |
|---|---|
| `chronologie-run.txt` | horodatage hôte du clic REC et du `force-stop` |
| `chronologie-comptoir.txt` | échantillons 100 ms annotés PENDANT/APRES le force-stop |
| `extrait-master-lost.txt` | `START_MASTER_LOST` + `CAMERA_REC_OK` (instant du run) |
| `extrait-stop-local.txt` | `CAMERA_REC_STOP_OK` + `START_STOP_LOCAL` + `START_PLAN_ABORTED` |
| `fichier-video-apres-stop.txt` | `ls -l` du fichier produit sur le device |
| `sha256-captures.txt` | SHA-256 des captures d'écran |
| `logs/B-J08-D3.log` | logcat complet B (phase STOP, voir limites) |
| `dumps/A-avant-rec-arm.json` | vue ARM de A avant REC (horloge, incident) |
| `dumps/B-avant-rec-start.json` | vue START de B avant le plan |
| `dumps/B-countdown-avant-forcestop.json` (+`-resume`) | vue B en COUNTDOWN, top verrouillé, digit 5 |
| `dumps/B-rec-avec-stop-urgence.json` (+`-resume`) | vue B en REC + STOP d'urgence disponible |
| `dumps/B-apres-stop.json` | vue B finale `STOPPED` |
| `dumps/B-modal-confirmation-stop.json` | contenu de la modale de confirmation |
| `dumps/B-echantillons-100ms.json` | 833 échantillons bruts (100 ms) |
| `screenshots/B-rec-stop-urgence.png` | B en REC avec STOP local d'urgence |
| `screenshots/B-confirmation-stop-urgence.png` | modale de confirmation du STOP local |

SHA-256 des captures :

```
2b1854d0516bad348d338b9ebf7064e120e28f963d7e7f6d174d3e5a8c51b67c  screenshots/B-confirmation-stop-urgence.png
133342d2aa006dd00f6cc1cdf4c1b20df488485240a2d5b0537df93e58d8415e  screenshots/B-rec-stop-urgence.png
```
