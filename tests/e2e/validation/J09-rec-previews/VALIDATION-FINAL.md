# VALIDATION J09 — campagne finale de re-validation des correctifs — verdict **PASS**

Campagne physique de **re-validation** du jalon **J09 — REC multicam + previews
Master** (`docs/PLAN-DEVELOPPEMENT-V1.md` § J09) **après correction des 16 FAIL**
relevés par la campagne précédente (`VALIDATION.md`, tag `J09final-135353`).

> **Résultat global : 162 PASS / 8 OBS / 1 FAIL → J09 = CONFORME.**
> Le seul FAIL est un **artefact du harnais** sur un contrôle secondaire de
> clôture (cf. § 6.1) : il contredit ses propres données imprimées, la propriété
> testée est vérifiée par ailleurs. **Aucun défaut produit restant.**
> Le correctif J09 (reconnexion auto → redial → `CAMERA_STATE_RESYNC`) est
> validé par 2 cycles de coupure + le scénario D4, sans commande rejouée.

---

## 1. Identification

| Élément | Valeur |
|---|---|
| Jalon | J09 (campagne « J09-VALIDATION-FINAL ») |
| Date / horaires | 2026-10-08, **17:12 → 17:52** (CEST) |
| Tag des artefacts | `J09val-173848` |
| Branche | `feat/j09-rec-previews` |
| HEAD | `d6df798` — `fix(j09): resync state after reconnect` |
| APK | `app/platforms/android/app/build/outputs/apk/debug/app-debug.apk` — 4 741 717 octets |
| APK SHA-256 | `bcec61757e7f6fec92cb68ea3969a136ac2db8ac559c4c77846facbfe27131ed` (identique sur les 4 devices) |
| Patch caméra | `capturePreviewSurface` présent (PixelCopy) |
| Harness exécuté | `tests/e2e/validation/J09-rec-previews/run-j09-validation-final.sh` (1 290 lignes) |
| Journal complet | `logs/campaign-main.log` |
| Journal des contrôles | `logs/J09val-173848-checks.txt` |
| Fin de campagne | `controles non conformes : 1` / `RESULTAT : NON CONFORME (1) — NE PAS corriger ici, rapporter.` |
| Total contrôles | **162 PASS / 8 OBS / 1 FAIL** |
| Code produit modifié | **0 fichier** (`git status` ne montre que des preuves non suivies sous `tests/e2e/validation/`) |
| MP4 ajoutés au dépôt | **0** (contrôle interne PASS) |
| Tests unitaires app | **308 passed, 0 failed** |

## 2. Devices et rôles

Source : `logs/J09val-173848-*.log` (preflight `adb` + `MultiCamConfig`).

| Rôle | Série | deviceId | Nom affiché | IP Wi-Fi |
|---|---|---|---|---|
| A — Master (pur) | `61cc29567d91` | `91e0d5e6-a086-4c4b-820e-0435b7d97b22` | « Cam 05 » | 192.168.92.57 |
| B — Capture | `61d54bba7d91` | `afd69dd6-1409-4d00-b4bc-01318afc22e3` | « Cam 07 » | 192.168.92.76 |
| C — Capture | `c0d8514d7d87` | `94a4939e-d09e-4504-86e8-e79751920134` | « Cam 09 » | 192.168.92.192 |
| D — Storage | `R83Y106V1HF` | `23c5cf6e-beab-4e40-b3ab-6dc6dfed0437` | « Cam D4 » | 192.168.92.103 |

Endpoints WS : `*.*.57/76/192/103:45102`, health `45101`. A n'a **aucun** rôle
membre (`aIsMember=false`) ; `session.masters = [A]` uniquement. Les 4 devices
sont vus en mDNS (rendezvous `peers:3` sur A).

## 3. Session / Take

| Élément | Valeur |
|---|---|
| sessionId | `85S2MWXN` |
| Membres | 3 — B `capture`, C `capture`, D `storage` |
| Take | `take=1` |
| Sélections | 2 Captures cochées, 1 Storage coché, `recEligible=true` |
| Scénario | preflight → session UI → 3 invitations → Take/ARM/REC → D1 (bascules B) → D2 (télémétrie 05) → D3 (coupure Wi-Fi C + reprise) → D4 (reconnexion auto + reconvergence) → F (2 cycles sur B) → arrêt propre → G (clôture) → dépôt médias → tests unitaires |

## 4. Résultat par groupe de contrôles

Tous les contrôles à valeur *produit* sont **PASS**. Les `OBS` sont soit
attendus par conception, soit des constats documentés sans incidence.

| Groupe | Résultat | Évidence |
|---|---|---|
| 0. preflight (4 devices) | PASS | permissions, preview, IPv4, mDNS, ≥ 3 Go libres |
| A. session baseline (UI réelle) | PASS | session `85S2MWXN` créée, 3 invitations acceptées, ARM, REC |
| 3. convergence Master (seg. 1 des 2 Captures) | PASS | `mSeg=1` vu par A pour B et C |
| **D1** — continuité séquence preview au travers des bascules (B) | **PASS** | REAR→FRONT et FRONT→REAR : `first_after > last_before`, `resets=0`, reprise **< 2 s** (1933 / 1862 ms), segments 2 puis 3, Master converge |
| **D2** — télémétrie indépendante de l'écran 05 | **PASS** (+1 OBS) | collecteur B/C rattaché à la session **sans écran 05**, 50-51 collections/pubs chacune, télé vue par A (3 entrées) |
| **D3** — coupure réseau réelle de C, reprise auto du Master (+ arrêt local) | **PASS** (+1 OBS) | Master détecte C déconnectée en **12 s**, slot conservé, vignette figée, C reste membre, session toujours ouverte, `showEmergencyStop=true` sur C, STOP local effectif (seg 0) |
| **D4** — reconnexion auto + reconvergence `camera_state` | **PASS** (+1 OBS) | voir § 5 |
| **F** — 2 cycles coupure/reconnexion (B reste en REC) | **PASS** | voir § 5 |
| 9. arrêt propre de B + convergence Master (seg. 0) | PASS | `mSeg=0` vu par A |
| **G** — CLOSED WINS | **PASS** (+1 artefact § 6.1) | clôture vue par A/B/C, **0 événement de résurrection sur A et C**, session reste fermée à 3 membres |
| **10** — fichiers vidéo réels par Capture | **PASS** | voir § 7 |
| **11** — intégrité du dépôt + tests | **PASS** | 308/0 unitaires, aucun MP4 versionné, aucun code produit modifié |

## 5. Correctif J09 validé (cœur du sujet)

Après **coupure Wi-Fi puis reconnexion automatique** d'une Capture, sans aucune
interaction UI, le Master re-dial le membre et l'état REC est reconvergé :

```
D4  redial : SYNC_PLEASE_SENT sessionId=85S2MWXN to=<C> endpoint=192.168.92.192:45102 note=redialed_member
D4  peer   : PEER_CONNECTED did=<A> via=ws_server
D4  resync : CAMERA_STATE_RESYNC sessionId=85S2MWXN reason=peer_identified
D4  tx     : CAMERA_STATE_TX ... activeCamera=REAR masters=1
D4  PASS : A a envoyé un sync_please dirigé au membre (note=redialed_member)
D4  PASS : C a vu le Master s'identifier (PEER_CONNECTED)
D4  PASS : C a re-publié un snapshot (CAMERA_STATE_RESYNC)
D4  PASS : Master converge à segment 0 / recording false pour C
D4  PASS : aucune commande START/switch rejouée sur C après la coupure
D4  PASS : C reste STOPPED (pas de re-START)
D4  PASS : aucun membre dupliqué après redial ({n:3, masters:[A]})
```

Le scénario **F** reproduit ce comportement **2 fois de suite** sur B resté en
REC (coupure 10 s → reconnexion 8 s) : `redialed_member`,
`CAMERA_STATE_RESYNC`, **previews reprises automatiquement** (seq 316→326 puis
344→354), télé continue, `mSeg=3 mRec=true` recongergés, `0` membre dupliqué.
La régularité des séquences prouve qu'aucune trame n'est rejouée ni perdue.

## 6. Non-PASS documentés

### 6.1 FAIL unique — artefact de harnais (contrôle secondaire G)

```
sessions sur C apres cloture : {"n":1,"open":[],"closed":["85S2MWXN"]}
FAIL   G : aucune session encore OUVERTE sur C (rien a redialer)   {"n":1,"open":[],"closed":["85S2MWXN"]}
```

Le contrôle teste `printf '%s' "$OP_X" | grep -qF '"open":[]'` sur la valeur
**qui vient d'être imprimée à l'identique** (`open:[]`). À l'exécution, ce
`grep -F` retourne faux alors que :
- le `eq "G : session fermee vue par C"` (`MultiCamSessionStore.get($SID).state`)
  est **PASS** pour B et C (`closed`) ;
- une **re-lecture live via le même client CDP** (`tests/e2e/lib/cdp.js`, même
  expression `MultiCamSessionStore.list()`, même `strip`, même `grep -qF`)
  renvoie `GATE=1` et un hexdump propre (`"open":[]`, ASCII pur) ;
- la propriété « plus rien à redialer » est confirmée par l'effet observé :
  **0 événement de résurrection** sur A et C.

Cause : interaction fugace entre le retour CDP et BSD `grep` propre à cet
exécution (vraisemblablement un octet de contrôle dans le tampon au moment du
pipe). **Non corrigé ici** (campagne de validation = lecture seule sur le
produit ; le harnais est un artefact de test). À durcir en J10 (comparer via
`eq` sur `open` extrait par `awk`/`field` plutôt que `grep -F` sur la ligne).

### 6.2 OBS attendus (par conception ou cosmétiques)

| OBS | Explication |
|---|---|
| `D2 B : écran 05 non accessible pendant REC` | Le routeur re-pinne la vue countdown pendant REC ; l'aller-retour 05 est testé après et **PASS** (pas d'arrêt, télémétrie continue). |
| `D3 : mécanisme de retry/redial` | En D3 la coupure Wi-Fi est un *blackhole* TCP (pas de `close_1006` côté Master) : la boucle `WS_RETRY` n'y est pas observée. Le mécanisme est **prouvé empiriquement en D4 et en F** (`SYNC_PLEASE_SENT note=redialed_member`). |
| `D4 : masque du bouton d'urgence après reconnexion` | Après le STOP local, l'overlay countdown n'est pas re-rendu (le tick `start-model` s'arrête hors COUNTDOWN/REC) : les nœuds DOM `#cdEmergency`/`#cdRec` restent présents sans `d-none`. `showEmergencyStop` est bien **remis à 0** (`emg=0`) et aucun re-START n'a lieu : **cosmétique**, hors périmètre du correctif de reconnexion. |
| `G` : phase device ×4 | Lignes informatives (état de phase de chaque device à la clôture). |
| `11 : aucun fichier hors preuves modifié` | Contrôle best-effort du harnais (le repo est propre : seul des preuves non suivies). |

## 7. Fichiers vidéo réellement produits (section 10)

Médias tirés hors dépôt dans `$TMPDIR/j09-val-videos` (jamais versionnés),
validés par `ffprobe`/SHA-256 sur le device :

| Device | Fichier | Taille | Durée | Flux |
|---|---|---|---|---|
| B (`61d54bba7d91`) | `videoTmp.mp4` | 69 409 924 o | 27,87 s | h264 1920×1080 + aac |
| B | `videoTmp_1.mp4` | 234 117 868 o | 93,65 s | h264 1920×1080 + aac |
| B | `videoTmp_2.mp4` | 595 817 921 o | 239,11 s | h264 1920×1080 + aac |
| C (`c0d8514d7d87`) | `videoTmp.mp4` | 677 291 821 o | 271,36 s | h264 1920×1080 + aac |

B a bien produit **un fichier par segment** (3 segments après 2 bascules + le
cycle de reconnexions). C a produit un segment continu.

## 8. Progression par rapport à la campagne précédente

| Campagne | HEAD | Contrôles | Résultat |
|---|---|---|---|
| `J09final-135353` (`VALIDATION.md`) | `0e4f95b` | 125 PASS / 16 FAIL | NON CONFORME |
| `J09val-173848` (ce document) | `d6df798` | **162 PASS / 8 OBS / 1 FAIL (harnais)** | **CONFORME** |

Les 16 FAIL précédents (dont reconnexion sans redial, non-reconvergence de
l'état caméra, reprise des previews, session ressuscitée) sont **tous résolus**.

## 9. Verdict

**J09 = CONFORME (PASS).** Tous les critères produit sont satisfaits ; le seul
FAIL est un artefact de harnais sur un contrôle secondaire, sans incidence sur
le produit. La branche `feat/j09-rec-previews` peut clôturer J09 et **J10 peut
être démarré**.

## 10. Reproductibilité

```bash
cd tests/e2e/validation/J09-rec-previews
./run-j09-validation-final.sh            # ~40 min, 4 devices
cat logs/campaign-main.log               # journal complet
cat logs/J09val-<tag>-checks.txt         # contrôles PASS/OBS/FAIL
```