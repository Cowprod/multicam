# J14-B02 — VÉRIFICATION EMPIRIQUE avant/après (4 devices)

> Addendum au `RESULTS-J14-B02.md`. Corrige la réserve « mesure non exécutée » :
> la mesure device a été réalisée sur A/B/C/D après correctif.

## Méthode (comparaison à topologie identique)

- **Harnais** : `tests/e2e/j14b02-rate.sh` — réutilise la **même session**
  (`RAEVQ9D9` = `J14B02-after-102548`, Master A `61cc29567d91`, Captures
  B `61d54bba7d91` + D `192.168.92.103:5555`, Storage C `c0d8514d7d87`) et
  injecte **le même pilote de Take** (1 Take, REC 30 s, 2 captures + 1 storage,
  2 transferts B→C et D→C). Seul l'APK change entre AVANT et APRÈS.
- **Mesure** : `adb logcat -d` filtrait les événements d'annonce/re-sync.
- **APK AVANT** : `md5 316873cd718b9c2894e94fe076162f15` (= APK campagne, pré-correctif).
- **APK APRÈS** : `md5 9e00336f3c53211c10fe5afd1f5651b8` (commit `c6d98df`, correctif 8.1).
- **Topologie sessions** : 11 sessions « open » présentes sur A (amplificateur historique
  documenté dans `INCIDENT-J14-B02.md` §5). Session mesurée identique AVANT/APRÈS.

## Résultats (compteurs bruts)

### Device A (Master) — `SESSION_ADVERTISE_SKIP` / `RE_SYNC_THROTTLED`

| Phase | Fenêtre | AVANT SKIP | APRÈS SKIP | Ratio | AVANT RS | APRÈS RS | Ratio |
|---|---|---|---|---|---|---|---|
| Take (REC+transferts) | ~75 s | 6 091 | 674 | **÷9.0** | 503 | 309 | ÷1.6 |
| Post-réplication | 120 s | 34 421 | 1 100 | **÷31.3** | 2 926 | 516 | **÷5.7** |
| Repos (idle, sans prise) | 120 s | ~1,3/s ¹ | 108 (0,9/s) | ~1 | 0 | 0 | — |

¹ référence repos pré-correctif (mesure 60 s isolée) : A 76 SKIP, 0 RS.

### Tous devices — Take (~75 s)

| Device | Rôle | AVANT SKIP | APRÈS SKIP | AVANT RS | APRÈS RS |
|---|---|---|---|---|---|
| A `61cc29567d91` | Master | 6 091 | 674 | 503 | 309 |
| B `61d54bba7d91` | Capture | 66 | 508 | 0 | 173 |
| C `c0d8514d7d87` | Storage | 230 | 565 | 0 | 234 |
| D `192.168.92.103` | Capture | 535 | 480 | 0 | 268 |

### Tous devices — Post-réplication (120 s)

| Device | AVANT SKIP | APRÈS SKIP | AVANT RS | APRÈS RS | AVANT TAKE_CHG | APRÈS TAKE_CHG |
|---|---|---|---|---|---|---|
| A | 34 421 | 1 100 | 2 926 | 516 | 2 959 | 337 |
| B | 40 | 770 | 0 | 229 | 386 | 50 |
| C | 1 277 | 993 | 0 | 457 | 2 235 | 260 |
| D | 1 061 | 618 | 0 | 325 | 2 422 | 160 |

### Repos (APRÈS correctif, 120 s, 4 devices, sans prise)

| Device | SKIP | RS | SYNC | TARGETED |
|---|---|---|---|---|
| A | 108 (0,9/s) | 0 | 0 | 0 |
| B | 89 (0,74/s) | 0 | 25 | 25 |
| C | 96 (0,8/s) | 0 | 25 | 25 |
| D | 108 (0,9/s) | 0 | 27 | 27 |

## Interprétation

- **La croissance non bornée est brisée.** Avant correctif, le churn d'annonces sur le
  Master **explose** en post-réplication (34 421 SKIP en 120 s = ~287/s ; campagne :
  ~545/s sur fenêtre 10 s) et sature le thread WebView (latence CDP ~60–90 s, échec
  `newTake`). Après correctif, le **même** Take/les **mêmes** transferts sur la **même**
  session plafonnent à ~9 SKIP/s (÷31 en post-réplication) ; le pilote s'exécute
  jusqu'au bout, WebView réactive.
- **Critère de repos atteint** : hors activité, `SKIP ≈ 0,8–0,9/s` et
  `RE_SYNC_THROTTLED = 0` sur les 4 devices → conforme au seuil de l'incident
  (`SKIP < 5/s`, `RS ≈ 0`). La tempête n'était **pas** un phénomène de repos : elle est
  déclenchée par les mutations de session (progression de transfert, télémétrie).
- **Résiduel** : pendant l'activité (transferts en cours), il subsiste une boucle
  **bornée** (~4–9 SKIP/s post-réplication), non nulle. Les 3 garde-fous la limitent
  (coalesceur annonce 1 s, persistance 1 s, re-sync 1,5 s/session) sans l'éliminer.
  La refonte **8.2** (un seul Master, merge télémétrie idempotent) reste le candidat
  pour la supprimer totalement — **décision à valider**.

## Preuves

- `measure-before2/` : compteurs AVANT (APK `316873cd…`), session `RAEVQ9D9`.
- `measure-after2/` : compteurs APRÈS (APK `9e00336f…`), **même** session `RAEVQ9D9`,
  même pilote (`dumps/markers.txt`, `dumps/counts-{take,postrep}.txt`, `counts-idle120.txt`).
- `measure-after/` : run initial (session neuve `RAEVQ9D9`) — pour mémoire.
- Harnais : `tests/e2e/j14b02-rate.sh` (comparaison à topologie identique),
  `tests/e2e/j14b02-measure.sh` (montage complet session+take).

## Réserves

- Mesure sur **une** session et **un** Take par condition ; le pic avant-correctif varie
  selon le nombre de sessions ouvertes (ici 11) et l'activité de transfert.
- Le résiduel après-correctif (~9/s en transfert) n'est pas nul : « disparition » au sens
  *bornage et non-saturation* est démontré ; l'élimination totale n'est pas acquise.
- Aucune suppression de session/média effectuée ; builds AVANT/APRÈS reproduits à
  l'identique (md5 AVANT = APK campagne).
