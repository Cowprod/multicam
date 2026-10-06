# VALIDATION J09-FINAL — verdict **FAIL**

Campagne physique du jalon **J09 — REC multicam + previews Master**
(`docs/PLAN-DEVELOPPEMENT-V1.md` § J09, lignes 404-435).

> **Résultat global : 125 PASS / 16 FAIL → J09 = NON CONFORME.**
> Aucun défaut produit n'a été corrigé. La campagne n'a pas été relancée.
> **J10 n'a pas été commencé.**

---

## 1. Identification

| Élément | Valeur |
|---|---|
| Jalon | J09 (campagne finale « J09-FINAL ») |
| Date / horaires | 2026-10-06, **13:53:53 → 14:02** (CEST) |
| Tag des artefacts | `J09final-135353` |
| Branche | `feat/j09-rec-previews` |
| HEAD | `0e4f95b` — `0e4f95ba1897967d220b0f3bf8b162009dbb2668` (« J09-09c : supervision des Storage sélectionnés sous la mosaïque Master ») |
| APK | `app/platforms/android/app/build/outputs/apk/debug/app-debug.apk` — 4 736 661 octets |
| APK SHA-256 | `616ec02983f40db114988486bbbee26bf6bd2c9d2884b0db7397a8299db37b19` (identique sur les 4 devices) |
| Patch caméra | `capturePreviewSurface` présent (PixelCopy) |
| Harness exécuté | `tests/e2e/validation/J09-rec-previews/run-j09-final.sh` (1 038 lignes, version livrée avec cette campagne) |
| Journal complet | `logs/run-j09-final-20261006-135353.log` |
| Journal des contrôles | `logs/J09final-135353-checks.txt` |
| Fin de campagne | `controles non conformes : 16` / `RESULTAT : NON CONFORME (16) — NE PAS corriger ici, rapporter.` |
| Code produit modifié | **0 fichier** (`git status --short` ne montre que des ajouts de preuves sous `tests/e2e/validation/`) |
| MP4 ajoutés au dépôt | **0** (contrôle interne PASS : « aucun MP4 ajoute au dépôt ») |

## 2. Devices et rôles

Source : `adb-devices.txt` (relevé `adb devices -l` + `MultiCamConfig` au preflight).

| Rôle | Série | Modèle | deviceId | Nom affiché | IP Wi-Fi CL07 |
|---|---|---|---|---|---|
| A — Master (pur) | `61cc29567d91` | 24075RP89G (flare) | `91e0d5e6-a086-4c4b-820e-0435b7d97b22` | « Cam 05 » | 192.168.92.147 |
| B — Capture | `61d54bba7d91` | 24075RP89G (flare) | `afd69dd6-1409-4d00-b4bc-01318afc22e3` | « Cam 07 » | 192.168.92.162 |
| C — Capture | `c0d8514d7d87` | 24075RP89G (flare) | `94a4939e-d09e-4504-86e8-e79751920134` | « Cam 09 » | 192.168.92.158 |
| D — Storage | `R83Y106V1HF` | SM-X110 (gta9wifi) | `23c5cf6e-beab-4e40-b3ab-6dc6dfed0437` | « Cam D4 » | 192.168.92.130 |

Endpoints WS : `*.*.147/162/158/130:45102`, health `45101`. A n'a **aucun**
rôle membre (`aIsMember=false`), `session.masters = [A]` uniquement.

## 3. Session / Take

| Élément | Valeur |
|---|---|
| Session | « Regie J09final-135353 » |
| sessionId | `9Y6FM3R9` |
| Membres | 3 — B `capture`, C `capture`, D `storage` |
| Take | `take=1` |
| armCycleId | `9Y6FM3R9#1#1` |
| startPlanId | `9Y6FM3R9#1#1#1` |
| Sélections | 2 Captures cochées, 1 Storage coché, `recEligible=true` |
| Durée REC observée | timer Master `00:00:36 → 00:00:40` pendant la fenêtre previews ; STOPs locaux à ~13:59 (C : `CAMERA_REC_STOP_OK atMs=1791287961263`) |
| Scénario | preflight → session → 3 invitations → Take/ARM/REC → previews → bascule B (REAR→FRONT) → coupure Wi-Fi de C → reconnexion → STOP B → STOP local B et C → dépôt des médias → tests unitaires |

## 4. Résultat global

| Indicateur | Valeur |
|---|---|
| Contrôles | **125 PASS / 16 FAIL** (141 contrôles) |
| Tests automatisés app | `288 passed, 0 failed` (`logs/J09final-135353-unit-tests.log`) |
| Verdict de fin de run | `NON CONFORME (16)` |
| **Verdict J09** | **FAIL** |

Répartition des 125 PASS : preflight 34, « Capture » 17, Grille 7,
discovery 6, invite 6, STOP 6, Topologie 5, MasterB 5, MasterC 5,
Preview 4, Master 4, Fichier 4, Take 3, UI 2, Reconnexion 2, Fichiers 2,
Arret 2, ARM 2, + 10 contrôles unitaires/mono-sujet.

## 5. Critères d'acceptation J09 — ce qui passe

| Critère J09 (plan § J09) | Verdict | Preuve |
|---|---|---|
| 2+ Captures enregistrent réellement | **PASS** | B `seg=1/seg=2 recording`, C `seg=1 recording` ; `CAMERA_REC_STOP_OK` ×2 ; dumps `10-B-view-seg1.json`, `10-C-view-seg1.json`, `12-B-view-seg2.json` |
| Fichiers vidéo présents | **PASS** | `B/videoTmp.mp4` 106 537 823 o / 42,773 s ; `B/videoTmp_1.mp4` 461 805 788 o / 184,351 s ; `C/videoTmp.mp4` 581 227 225 o sur device — `logs/*-files.txt` |
| Vidéos valides (flux/durée) | **PARTIEL** | B : h264+aac, 2/2 ≥ 5 s (PASS) ; C : **non vérifiable** (tir tronqué, voir § 9) — `logs/*-ffprobe.log` |
| Previews reçues régulièrement sans bloquer REC | **PARTIEL** | 41 émissions B / 80 réceptions A, inbox `received 38 → 66`, `dropped=0`, REC non bloqué (PASS) — **mais tuile B figée 44 s après la bascule (D1)** |
| Une déconnexion ne fait pas bouger la grille | **PASS** | 7 contrôles Grille : 2 vignettes, ordre inchangé, modèle = DOM, libellé « Déconnecté », image figée conservée |
| Dernière image figée lors d'une déconnexion | **PASS** | `seq=50` figé, `frame=1`, `disp=DECONNECTED` — dumps `14-A-slots-C-offline.json`, `screenshots/10-mosaique-C-deconnectee.png` |
| Reprise de preview à la reconnexion | **FAIL** | **D3** — aucune reconnexion sur place en 120 s |
| Reconnexion = reprise automatique | **FAIL** | **D3** (BUG PRODUIT J09) |
| Mosaïque stable + supervision batterie/espace | **FAIL** | **D2** — télémétrie jamais publiée (`18-A-telemetry.json` = `{}`) |
| Timer / état segment côté Master | **PASS** | `MasterB/C segmentIndex==1`, `activeCamera` identique, UI « Caméra Arrière · segment 1 · enregistrement », bascule reçue `segmentIndex=2 / FRONT` |

Autres PASS notables : preflight 4/4 devices (permissions, focus, preview
ouverte, `IDLE`, IP, annonce mDNS, ≥ 3 Go libres) ; discovery `wsep` publié par
les 3 pairs ; 3 `INVITE_SENT` ; topologie (2 Captures, 1 Storage, Master pur) ;
zone Storage « Cam D4 Connecté » ; `Capture B/C toujours en REC` pendant les
previews, la bascule et la coupure ; `START_MASTER_LOST` journalisé côté C ;
STOP local des deux Captures ; `STOP MasterB` convergé ; aucun MP4 ajouté au
dépôt ; `288 passed, 0 failed`.

## 6. Défauts produit

### D1 — Preview figée ~44 s après une bascule caméra

| | |
|---|---|
| **Constat** | Après la bascule B (REAR→FRONT, 13:56:13), la tuile de B est restée figée à `seq=44` pendant **44 s** (vérifié aux fenêtres 13:56:30 et 13:56:40), alors que le Master continuait de recevoir 1 image/s. Reprise à `seq=45` à 13:56:57. |
| **Cause** | Le sampler remet `seq=0` à chaque redémarrage de run (`app/www/js/state/preview-sampler.js:365`, déclenché ici par `PREVIEW_FRAME_RUN_START` à 13:56:13.204) alors que `startPlanId` reste identique (`9Y6FM3R9#1#1#1`) ; `app/www/js/state/live-model.js:237` rejette tout `frame.seq <= slot.lastFrameSeq` (anti-replay) → les frames 1→44 sont jetées jusqu'au dépassement du dernier compteur. |
| **Critère touché** | « previews reçues régulièrement » (J09) |
| **Preuves** | `logs/J09final-135353-61cc29567d91-msr-reconnect.log` (timeline seq) ; `logs/J09final-135353-61d54bba7d91-cap-switch.log` (reset à 13:56:13) ; contrôle FAIL « Capture B continue d'envoyer ses previews pendant la coupe de C seq 44 → 44 » ; `logs/J09final-135353-diag-post-campagne.txt` § D1 |
| **Traitement** | **Non corrigé ici** (règle de la mission). |

### D2 — Télémétrie jamais publiée (supervision J09-06 morte)

| | |
|---|---|
| **Constat** | `MultiCamTelemetryStore.all(9Y6FM3R9) = {}` côté Master ; 0 ligne `TELEMETRY_*` / `MEMBER_TELEMETRY` sur A ; contrôles FAIL « télémétrie publiee : 0 entree(s) », « niveau de batterie present », « espace libre presente (Mo) ». |
| **Cause** | `MultiCamTelemetryService` n'est **jamais démarré** hors écran 05 : `bound=false, collects=0, publishes=0` (relevé CDP sur B). Seul point d'appel de `bind()/start()` du dépôt : `app/www/js/ui/take.js:147-149` (`publishSelfTelemetry`, écran 05), alors que l'en-tête de `app/www/js/state/telemetry-service.js` impose explicitement une collecte détachée de l'UI. Les Captures sont restées sur l'écran 08. |
| **Critère touché** | « batterie/espace/état » (J09 attendu) |
| **Preuves** | `dumps/J09final-135353-18-A-telemetry.json` (`"{}"`) ; `logs/J09final-135353-diag-post-campagne.txt` § D2 (view complet) ; `logs/J09final-135353-checks.txt` (3 FAIL supervision) |
| **Traitement** | **Non corrigé ici.** |

### D3 — BUG PRODUIT J09 : reconnexion automatique cassée après coupure réseau

| | |
|---|---|
| **Constat** | Coupure Wi-Fi de C à 13:56:13, rétablissement constaté (adresse `.158` récupérée, `Supplicant state: COMPLETED`). **Pendant 120 s d'attente, aucun retour de connexion** : C reste `serverConns=0 / clientConns=0`, A ne revoit jamais `94a4939e`. C continue de jeter ses images : 175 × `PREVIEW_FRAME_DROP reason=no_master_connected`. |
| **Cause** | Sur A : `WS_RETRY_SKIP endpoint=192.168.92.158:45102 reason=no_open_session` (`session-ws.js:465-468`). `openSessionsFor()` (`session-ws.js:403-418`) matche `masters[].endpoint` **ou** `members[].endpoint` or `cleanMember()` (`app/www/js/state/session-model.js:180-200`) ne conserve **aucun** endpoint de membre → l'égalité est impossible. Sur C : aucune connexion client à retenter (c'est A qui a dialé C à l'invitation) et aucun déclencheur réseau (seuls `pause`/`resume`, `session-ws.js:2372-2373`, et seulement pour des endpoints déjà dans `clientRetry`). |
| **Décision** | La reconnexion automatique après perte réseau **fait partie du comportement attendu J09** ; le boot n'est pas le seul cas valide. Le comportement livré et validé par le commit **`a6a5151`** (« J09 : reconnexion automatique du WS Capture apres coupure reseau », smoke `ws-reconnect-smoke.js`, 34/34 OK le 01/10/2026, reprise 7 854 ms après le retour réseau) **doit rester vrai** — il couvre le cas Capture→Master (`masters[].endpoint`), la campagne expose le cas inverse (Master→Capture, `members[].endpoint`), qui est mort. |
| **Critère touché** | « reconnexion = reprise automatique » (J09) — **bloquant** |
| **Preuves** | `logs/J09final-135353-61cc29567d91-msr-reconnect.log` lignes 301 / 376 / 381 (`WS_CLIENT_TIMEOUT`, `WS_CLIENT_CLOSE code=1006`, `WS_RETRY_SKIP … no_open_session`) ; `logs/J09final-135353-c0d8514d7d87-cap-reconnect.log` (`START_MASTER_LOST`, 175 × `PREVIEW_FRAME_DROP`, 0 `WS_RETRY_*`) ; dumps `16-A-slots-C-reconnected.json`, `17-C-after-reconnect.json` ; `logs/J09final-135353-diag-post-campagne.txt` § D3 ; référence de comportement `logs/60-ws-reconnect/reconnect-smoke.json` |
| **Traitement** | **Non corrigé ici** (classement : BUG PRODUIT J09, à traiter hors campagne). |

### D4 — Conséquence de D3 : état Master non convergé + urgence persistante

Rattaché **entièrement à D3** : sans reconnexion, A ne reçoit ni l'état de
segment de C ni son STOP local.

| | |
|---|---|
| **Constat** | Après le STOP local de C : Master toujours à `segmentIndex=1 / recording=true` pour C (`dumps/30-A-inbox-C-after-stop.json`), contrôles FAIL « STOP MasterC segmentIndex recu == 0 (obtenu 1) » et « STOP MasterC recording recu == false (obtenu true) » ; `updatedAtMs` figé à `1791287729348` (avant la coupure). Tuile de C toujours `DECONNECTED` avec image figée (`seq=50`) malgré le retour réseau (FAIL « Reconnexion C detectee par le Master », « previews de C repris », « Master : C n'est plus Déconnecté »). Sur C, `showEmergencyStop` reste `true` (`emg=1 dom=VISIBLE`, FAIL « STOP local d'urgence masque de nouveau ») : `connectedMasters()` tombe à 0. |
| **Point de vigilance associé** | Aucun republish de `camera_state` à l'ouverture d'une connexion WS (broadcast seulement sur `rec_started/switch/stop`) : même reconnectée, C n'aurait pas re-signalé son état. **Non testable ici** (la reconnexion n'a jamais eu lieu sur place). |
| **Preuves** | dumps `14-A-slots-C-offline.json`, `16-A-slots-C-reconnected.json`, `17-C-after-reconnect.json`, `30-A-inbox-C-after-stop.json`, `15-C-emergency.json` ; `screenshots/11-C-stop-local-urgence.png`, `12-mosaique-C-reconnectee.png` ; `logs/J09final-135353-checks.txt` (5 FAIL) |
| **Traitement** | **Non corrigé ici.** |

## 7. OBS (observations, non bloquantes)

**OBS-1 — Aucun `CAMERA_SEGMENT_OPEN` pour un segment ouvert après une bascule.**
Le segment 2 s'ouvre silencieusement dans le chemin de bascule
(`camera-switch-service.js:416` : `m.openSegment(...)` sans `log()` associé) ;
seul `CAMERA_SEGMENT_FINAL … reason=camera_switch` est émis. Contrôle FAIL
« Bascule B : segment 2 reellement ouvert (CAMERA_SEGMENT_OPEN) : 0
occurrence(s) ». `CAMERA_SWITCH_CONFIRM` non plus n'a pas été observé sur ce
run (0 occurrence côté B et côté A), alors qu'il l'était sur `J0908e-222328`.
**L'état lui-même est correct** : `segmentIndex=2`, `camera=FRONT`,
`segmentState=recording` lus dans le modèle (`dumps/12-B-view-seg2.json`) et
reçus par le Master (4 contrôles PASS) — l'oracle fiable reste la lecture du
modèle (CDP), pas ce tag. **Non promu en défaut bloquant** tant que ce tag
n'est pas requis par le contrat J09.

## 8. Mesures réellement archivées

`logs/J09final-135353-mesures.txt` (extrait tel quel) :

| Mesure | Valeur |
|---|---|
| Previews Master (t0 → t12) | `received 38 → 66`, `dropped 0`, `lastSeq 19 → 33`, `stored 2` |
| Previews émises / reçues | B = 41 émises, A = 80 reçues (fenêtre ~16 s) |
| `B/videoTmp.mp4` | 106 537 823 o — 42,773333 s — sha256 `a1959ac6ea0d1edff5382ae21618eaaed3992cc8537c22cf72c22b49a83e392c` |
| `B/videoTmp_1.mp4` | 461 805 788 o — 184,350937 s — sha256 `37bbc5ea23b4907b75d156977dec4fc7bad2940f758826b0a1211865ea7bffe1` |
| `C/videoTmp.mp4` | 529 670 777 o tirés (**device : 581 227 225 o**) — sha256 `8ecc88cab38bc5ec8ee663a2cc7694ff7dd3d8958079720a3c23716c1a1ef733` — durée `?` (tir tronqué) |
| MP4 valides | 3 au total |
| Tests app | `288 passed, 0 failed` |
| Bascule | `dernier switch 1386 ms`, `seg=2`, `FRONT` |
| Énergie / stockage | indisponibles (D2) ; préflight disque : B 37 Go, C 38 Go libres |

## 9. Limites de la campagne

1. **Média de C non analysable** : le tir `adb exec-out run-as … cat` a produit
   529 670 777 o pour 581 227 225 o sur device → `moov atom not found`
   (2 FAIL). Le fichier existe et fait ≥ 581 Mo sur l'appareil, mais flux et
   durée de C restent **non vérifiés**.
2. **Télémétrie non évaluable au-delà de son absence** (D2) : aucune mesure de
   batterie/espace n'a transité, la supervision n'a donc pas été éprouvée en
   conditions réelles.
3. **Republish `camera_state` après reconnexion non testé** : la reconnexion
   sur place ayant échoué (D3), ce point de vigilance reste ouvert.
4. **Un seul Take, un seul cycle d'armement, une seule bascule, une seule
   coupure, un seul Master** : pas de répétition, pas de variance mesurée.
5. **Fenêtre de reconnexion unique** : 120 s d'attente après retour Wi-Fi ;
   aucun redémarrage d'application n'a été tenté *pendant* la fenêtre (le
   redémarrage de C à 14:17:50 est un diagnostic post-campagne, hors preuve).
6. **Topologie sensible en préambule** : le Wi-Fi de D était hors CL07 au
   démarrage et a dû être réparé par un redémarrage complet de l'app sur les 4
   devices (les autres chemins de re-annonce ne suffisent pas) — voir
   `logs/J09final-135353-00-A-discovery.json`.
7. **État post-campagne non figé** : les relevés de 14:14-14:23 (diagnostic)
   et l'état des devices à partir de 16:37 sont **hors preuve** ; seule la
   fenêtre 13:53:53 → 14:02 fait foi.
8. **Oracles ponctuels** : les contrôles d'état sont des instantanés ; seul le
   contrôle previews (t0/t12) est différentiel.

## 10. Bugs de harness découverts (documentés, **non corrigés**)

La version du harness qui a produit cette campagne est livrée telle quelle
(`run-j09-final.sh`, commitée avec les preuves) : corriger ses assertions
après coup dénaturerait l'exécution qui a généré `checks.txt`. Les 4 défauts
sont donc consignés pour une prochaine exécution.

| # | Emplacement | Défaut | Effet constaté |
|---|---|---|---|
| H1 | `run-j09-final.sh:629` et `:633` | Assertion `eq … "1" "$(python3 … print(0 if ok else 1))"` **inversée** : le python imprime `0` quand le critère est rempli, alors que `eq` attend `1`. | 2 FAIL « Capture B/C rattachee au Take : attendu=[1] obtenu=[0] » alors que `take=1` est bien lu (et que le contrôle « Take : 2 Captures selectionnees » passe). **Faux négatifs.** |
| H2 | `run-j09-final.sh:435` | `INVITE_ACCEPTED` lu sur logcat de la cible **immédiatement** après que A a vu le membre — or A enregistre le membre avant que C ait accepté (course). | 1 FAIL « invite[C] INVITE_ACCEPTED recu par le device : ABSENT », alors que la ligne est bien présente ensuite dans `logs/J09final-135353-c0d8514d7d87-any-invite.log`. **Faux négatif.** |
| H3 | `run-j09-final.sh:777` | Oracle de bascule `grep -c "CAMERA_SEGMENT_OPEN segmentIndex=2"` : ce tag n'est **jamais** émis pour un segment ouvert par une bascule (voir OBS-1). | 1 FAIL « Bascule B : segment 2 reellement ouvert » alors que l'état est correct (`seg=2`, `FRONT`). **Mauvais oracle.** |
| H4 | `run-j09-final.sh:977` | Tir des MP4 via `adb exec-out run-as … cat` **sans comparaison de taille** avant `ffprobe`/`sha256`. | 2 FAIL sur `C/videoTmp.mp4` (`moov atom not found`, `duree=?`) dus à un transfert tronqué (529 670 777 / 581 227 225 o), pas au fichier du device. |

Répartition des 16 FAIL : **10 défauts produit** — D1 ×1, D2 ×3, D3 ×3
(reconnexion), D4 ×3 (conséquence de D3) — et **6 faux négatifs de harness**
(H1 ×2, H2 ×1, H3 ×1, H4 ×2). Le verdict FAIL **ne dépend pas** du harness :
D1, D2 et D3 sont établis sur des logs bruts et des relevés d'état,
indépendamment des 6 contrôles erronés.

## 11. Verdict

| | |
|---|---|
| **Verdict global J09** | **FAIL — NON CONFORME** |
| Défauts bloquants | **D3** (BUG PRODUIT J09 : reconnexion automatique après perte réseau) avec **D4** en conséquence ; **D1** (preview figée ~44 s) ; **D2** (télémétrie jamais publiée) |
| Observation | **OBS-1** (`CAMERA_SEGMENT_OPEN` absent après bascule) — non bloquante |
| Corrections produit | **0** |
| Corrections harness | **0** (documentées en § 10) |
| Campagne relancée | **Non** |
| J10 | **Non commencé** (règle : ne pas démarrer J10 tant que J09 n'est pas validé PASS ou explicitement différé) |

## 12. Index des preuves

Tous les chemins sont relatifs à `tests/e2e/validation/J09-rec-previews/`.

| Fichier | Contenu |
|---|---|
| `logs/run-j09-final-20261006-135353.log` | journal complet du run |
| `logs/J09final-135353-checks.txt` | 125 PASS / 16 FAIL, contrôle par contrôle |
| `logs/J09final-135353-mesures.txt` | mesures (§ 8) |
| `logs/J09final-135353-unit-tests.log` | `288 passed, 0 failed` |
| `logs/J09final-135353-png-shas.txt` | SHA-256 des screenshots |
| `logs/J09final-135353-61cc29567d91-msr-{invite,previews,switch,reconnect,stop}.log` | logcat Master par phase (D1, D3) |
| `logs/J09final-135353-61d54bba7d91-cap-{previews,switch,stop}.log` | logcat Capture B (D1, OBS-1) |
| `logs/J09final-135353-c0d8514d7d87-cap-{offline,reconnect,stop}.log` | logcat Capture C (D3, D4) |
| `logs/J09final-135353-*-files.txt`, `*-ffprobe.log` | inventaire + ffprobe |
| `logs/J09final-135353-diag-post-campagne.txt` | diagnostics post-campagne D1/D2/D3 (14:14 → 14:23, hors run) |
| `dumps/J09final-135353-*.json` (26) | états CDP par phase |
| `screenshots/J09final-135353-*.png` (15) | mosaïques, modales, états |
| `adb-devices.txt`, `apk-sha256.txt` | inventaire devices + empreinte APK |
| `logs/60-ws-reconnect/*` | preuve du comportement livré par `a6a5151` (référence) |
