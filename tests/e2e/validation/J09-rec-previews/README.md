# J09-02 — Preuve de validation : cycle de vie permanent de la preview locale

Décision appliquée : `MULTICAM_DECISIONS_REFERENCE.md` §35.1 — **sur un device dont la
skill Capture est active et l'application au premier plan, la preview caméra locale est
le fond permanent** des écrans 01 → 08. Elle n'est plus bornée au countdown ni au REC,
et un STOP ne l'éteint pas.

## Périmètre de cette micro-mission

| Fait | Hors périmètre (non commencé) |
|---|---|
| Ouverture/fermeture de la preview caméra locale | PixelCopy périodique (~1 fps) |
| Transparence conditionnelle de l'UI au-dessus | Transport JPEG vers la Régie |
| Survival au countdown / REC / STOP | Mosaïque Master (télémétrie J09) |
| Libération en arrière-plan | STOP global synchronisé (jalon **J10**) |
| Reprise au premier plan | Transfert des médias |

## Environnement

| Rôle | Device | Modèle | IP |
|---|---|---|---|
| Master + Capture | `R83Y106V1HF` | Samsung SM-X110 (« Cam D4 ») | 192.168.92.103 |
| Capture | `61d54bba7d91` | « Cam 07 » | 192.168.92.76 |

APK debug construit depuis `app/` (mêmes bits sur les deux devices), plugin caméra patché
(`capturePreviewSurface`).

## Méthode de preuve

Trois oracles, aucun subjectif :

1. **Logs parsables** — `CAMERA_PREVIEW_START / _OK / _STOP / _STOP_DEFERRED / _ERROR /
   _STATE / _LIFECYCLE`, `CAMERA_REC_STOP_OK … previewKept=1`, `CAMERA_PREP_OK … reused=`.
2. **Analyse de pixels** (`png_stats.py`, stdlib seule) — la caméra vivante laisse
  kubiquement 0 % de pixels exactement égaux au fond de repli `#111827` ; quand elle est
   éteinte, le fond opaque du document réapparaît (≈ 26 % de l'écran en réglages).
   Une caméra photographique n'est pas un aplat : le test de « platitude » seul est
   insuffisant sur un écran riche en UI — c'est la fraction de repli qui tranche.
3. **CDP** (`cdp.js`, WebSocket natif de Node) — lecture de l'état JS réel
   (`MultiCamPreviewService.view()`, `MultiCamCameraRecord.view()`) au lieu de déduire
   l'état d'une capture d'écran. `ui.sh` pilote l'UI via `uiautomator` quand le CDP n'est
   pas nécessaire.

## Résultats — les 8 étapes du smoke test

| # | Attendu | Observé | Verdict | Preuve |
|---|---|---|---|---|
| 1 | Au boot, skill Capture active ⇒ fond caméra | `CAMERA_PREVIEW_START reason=boot` puis `_OPEN … dt=319ms` ; repli **0,5 %** | **PASS** | `logs/01-boot.log`, `screenshots/01-boot.png` |
| 2 | Naviguer 01 → 03/05/06 conserve la preview | **0** `CAMERA_PREVIEW_STOP` pendant la navigation ; repli 0,1 % en réglages | **PASS** | `screenshots/02a-nav-home.png`, `02b-nav-settings.png` |
| 3 | COUNTDOWN utilise la preview déjà ouverte | `COUNTDOWN_STATE digit=5→1`, `START_LOCAL … deltaMs=4` — **aucun** `CAMERA_PREP`, **aucun** `CAMERA_PREVIEW_START` | **PASS** | `logs/04-take-capture-full.log` (§ « trace de référence ») |
| 4 | REC utilise **la même** caméra | `CAMERA_REC_OK … callDt=1160ms` ; `starts:1` — la caméra n'a été ouverte qu'une fois, au boot | **PASS** | idem + `screenshots/04-capture-rec.png` (repli 0,3 % ⇒ image caméra bien visible derrière l'UI REC) |
| 5 | STOP arrête le REC mais **pas** la preview | `CAMERA_REC_STOP_OK … previewKept=1` ; `CAMERA_PREVIEW_STOP` count = **0** ; `prepared:true`, `starts:1` | **PASS** | `screenshots/05-capture-after-stop.png` (repli 0,6 %) |
| 6 | Arrière-plan ⇒ libération | `event=pause` → `CAMERA_PREVIEW_STOP reason=background` → `STATE active=0` | **PASS** | `logs/02-background-foreground.log` |
| 7 | Premier plan ⇒ reprise | `event=resume` → `CAMERA_PREVIEW_START reason=resume` → `_OPEN dt=185ms` → `STATE active=1` | **PASS** | `logs/02-background-foreground.log`, `screenshots/03-resume-after-background.png` |
| 8 | Skill Capture désactivée ⇒ repli sombre opaque | `CAMERA_PREVIEW_STOP reason=capture_skill_off` ; repli **26,4 %** ; réactivation ⇒ **0,1 %** | **PASS** | `logs/03-skill-toggle.log`, `screenshots/06a-capture-off.png` / `06b-capture-on.png` |

**8/8 PASS.**

### Trace de référence (étapes 3–5, Capture « Cam 07 »)

```
START_PLAN_ACCEPTED  startPlanId=RGR4M7AA#1#1#1 take=1 leader=0 countdown=5
COUNTDOWN_STATE      digit=5 remainingMs=4964
COUNTDOWN_STATE      digit=4 … 3 … 2 … 1
START_LOCAL          actual=12:35:50.721 deltaMs=4 status=OK
START_PLAN_COMPLETE  reason=started
CAMERA_REC_REQUEST   w=1280 h=720 profile=auto targetLocalMs=1790678150717.5
CAMERA_REC_OK        callDt=1160ms detail="OK"
START_NATIVE_ACK     ack=12:35:51.885 deltaMs=1168 detail=startRecordVideo_ok
… (aucune ligne CAMERA_PREP_ ni CAMERA_PREVIEW_START) …
SCREEN08_STOP_CONFIRMED
CAMERA_REC_STOP_OK   path=/data/…/cache/videoTmp_1.mp4 previewKept=1
START_STOP_LOCAL     reason=emergency_no_master
… (CAMERA_PREVIEW_STOP : 0 occurrence) …
```

État JS de la Capture au top et après STOP :
`{prepared:true, recording:false, starts:1}` et
`{active:true, desired:true, captureEnabled:true, recording:false, bodyClass:"camera-preview-active"}`.

Média réellement produit : `cache/videoTmp_1.mp4`, **122 Mo**, en-tête `ftyp mp42 / isom mp42`
— la Capture a enregistré avec la caméra ouverte depuis le boot, sans réouverture.

## Bug corrigé pendant la validation

`preview-service.js` journalisait `CAMERA_PREVIEW_STATE active=1` en dur. Le premier smoke
test l'a révélé sur le terrain (`STOP` suivi de `active=1`). Corrigé, et verrouillé par le
test **N** (« l'état journalisé reflète l'état RÉEL »).

## Tests automatisés

`app/tests/preview-lifecycle.test.js` — **24 tests, 24 PASS** (`cd app && npm test`).
Couverture : réconciliation, idempotence, refus de tuer un REC, transparence conditionnelle
(classe sur `<html>` **et** `<body>`), logs parsables, intégration `start-service`
(`cancel` / `stopLocal` ne ferment plus la caméra).

## Limites connues / à faire avant J10

- **Rejeu intégral du take non réitéré.** La première exécution a passé les étapes 3–5 ;
  les rejeux ultérieurs se sont heurtés à un problème **J08**, hors périmètre J09-02 :
  `ARM_RESULT … status=WARNING` puis `Dégradée · delta -729 ms` et un `armCycleId` périmé
  (`#1#1` évalué pendant que le cycle courant est `#1#5`), qui bloque le top. Le STOP global
  synchronisé et la reprise d'incident d'armement sont justement du ressort de **J10**.
  À reprendre quand le STOP global existera.
- La Capture redémarrée ne **re-rejoint pas** d'elle-même la session (écran 01 affiché alors
  que la Régie la liste encore membre) : comportement J08 de reprise de session, non traité ici.
- `cancel()` du plan est refusé une fois le plan démarré (`START_CANCEL_REJECT
  reason=already_started`) : inchangé, c'est le STOP global de J10 qui prend le relais.

## Repro

```sh
cd app && npm test                      # 24/24
./tests/e2e/validation/J09-rec-previews/run-take.sh   # ARM → REC → STOP, trace Capture
python3 png_stats.py screenshots/06a-capture-off.png # verdict caméra visible / absente
node cdp.js 'JSON.stringify(MultiCamPreviewService.view())'
```
