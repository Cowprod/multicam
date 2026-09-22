# VALIDATION.md — J04 Sessions + second Master

- Jalon : `docs/PLAN-DEVELOPPEMENT-V1.md` → J04
- État : **PASS technique — en attente revue humaine** (revue visuelle non effectuée)
- Date campagne : 2026-09-22 (campaign 8 ; refonte visuelle après revue humaine KO 1)
- Branche : `fix/j04-websocket`
- Décisions appliquées : `MULTICAM_DECISIONS_REFERENCE.md` §28 (transport WS LAN), §30 (sessions, PIN immuable, fermeture, masters égaux) — architecture inchangée
- Devices physiques : B = `61d54bba7d91` (Cam 07, 192.168.92.76) et C = `c0d8514d7d87` (Cam 07, 192.168.92.192). A indisponible et exclu (décision utilisateur).

## Artefact validé

- APK : `tests/e2e/validation/J04-sessions/artifacts/multicam-j04.apk`
- SHA-256 : `ba7c85f3e9b957c8e43dce24a61b53fd80d4f7af1758e76d82982315bea7ae38`
- Installé sur B et C via `pm install -r -t` ; **le même APK** sur les deux devices.

## Défauts SPA corrigés pendant la refonte visuelle (revue humaine KO 1)

La revue humaine a rejeté les captures précédentes : (a) plusieurs panneaux visibles empilés,
(b) joint/PIN non montré, (c) badge OUVERTE sur session fermée, (d) captures byte-identiques
entre scénarios. Trois défauts rendus réels, corrigés — SANS changer la sémantique session/network :

1. **CSS** `app/www/css/app.css` : aucune règle `.screen` n'existait → tous les panneaux étaient
   rendus empilés. Ajout : `.screen{display:none}` + `.screen.active{display:flex;flex-direction:column}`.
2. **Routeur** `app/www/js/main.js` : `showPanel` case `join` ne forçait pas `mode:"join"` →
   l'écran Rejoindre affichait le formulaire de CRÉATION et `#joinArea` (bloc PIN) restait
   masqué. Le routeur force désormais le mode join ; `ui/home.js` passe aussi `mode:"join"`.
3. **Rendu temps réel** `app/www/js/ui/home.js` : `renderRecents()` n'était pas rappelé sur les
   mutations de session → l'accueil gardait `OUVERTE` pour une session apprise fermée. Corrigé
   (Accueil re-refait aussi les sessions récentes).

Garde-fous déterministes : `tests/plugin-lab/ui/panels-check.test.js` (exactement 1 panneau
`.active`, règles CSS obligatoires, routeur force mode join, badges FERMÉE/OUVERTE) — **18/18 OK** ;
`tests/plugin-lab/session/merge-model.test.js` — **7/7 OK**; `node --check` sur tous les JS app.

## Scénarios exécutés (campaign 8, `tests/e2e/j04-campaign.sh clean`)

À chaque navigation, invariant vérifié : `PANELS_OK active=panel-…` (exactement UN panneau `.active`).

| # | Scénario | État clé (dump/log) | Capture visuelle (OCR vérifié) | Résultat |
|---|---|---|---|---|
| J04-01 | Création session B : `sessionId` persistant, PIN 4 chiffres, serveur 45102, DNS-SD | `J04-01-B-created.json` : sid=A8CG3YXR, open, pin=7431, masters=1, selfEndpoint=.76:45102, serverConns=0 | `J04-01-B-create-screen.png` (« NOUVELLE SESSION ») ; `J04-01-B-session-screen.png` (« DEVICES DANS LA SESSION … 1 », « Terminer la session ») | **PASS** |
| J04-02 | Découverte LAN par C (Home) | `J04-02-C-lan.json` : 1 annonceur A8CG3YXR did=B host .76 port 45102 TXT sid/name/did/ver/sver | `J04-02-C-home-lan.png` : « Studio J04 · 192.168.92.76:45102 · 1 Master(s) · Rejoindre » | **PASS** |
| J04-05 | PIN erroné sur C (1111) → rejet `pin_mismatch`, session B intacte | `J04-05-C-reject.json` : storedCount=0, panelVisible=true, pinStatus=« PIN incorrect » ; `J04-05-B-unchanged.json` : open/pin 7431/masters 1 | `J04-05-C-join-screen.png` : « REJOINDRE LA SESSION · Studio J04 · PIN Master » (4 cases vides) ; `J04-05-C-wrong-pin.png` : « … PIN incorrect » visible | **PASS** |
| J04-03 | C rejoint avec le PIN réel → convergence 2 Masters | `J04-03-C-joined.json` / `J04-03-B-converged.json` : mêmes nom/PIN/sessionId, masters [[76,76]] exacts par deviceId, panel=[panel-session] | `J04-03-B-session-2masters.png` : « DEVICES DANS LA SESSION … 2 … Connecté · 192.168.92.192:45102 » ; `J04-03-C-session-screen.png` idem miroir | **PASS** |
| J04-04 | Renommage depuis C → propagé B et C + TXT | `J04-04-B-name.json` / `J04-04-C-name.json` : name=« Studio J04 renommee », nameBy=did(C) ; `J04-04-B-lan-txt.json` : TXT renommé, 1 annonceur | `J04-04-B-renamed.png`, `J04-04-C-renamed.png` : seule bande diff vs J04-03 = rangée NOM (pixel-band y=420-479, 0.6 %) | **PASS** |
| J04-08 | Force-stop + relance B → même session, PAS de nouvelle | `J04-08-B-restart.json` : count=1, A8CG3YXR renommé, open, pin 7431, masters 2 | `J04-08-B-restart-home.png` : Accueil, récente « Studio J04 renommee (OUVERTE) · PIN 7431 · 2 membre(s) » | **PASS** |
| J04-06 | Fermeture depuis C → B/C closed, LAN vidé | `J04-06-B-closed.json`/`J04-06-C-closed.json` : state=closed ; `J04-06-B-lan-after-close.json` : lan=[] | `J04-06-B-closed-screen.png` : badge FERMÉE, « Terminer la session » masqué ; `J04-06-B-home-closed.png` : récente « (FERMÉE) » + « Aucune session disponible » ; `J04-06-C-closed-screen.png` idem | **PASS** |
| J04-09 | Purge DNS-SD de la session fermée (fenêtre stale 150 s) | `J04-09-B-lan-purged.json` : lan=[] | — | **PASS** |
| J04-07 | Re-jonction d'une session fermée → refus `session_closed`, store vidé | `J04-07-C-closed-reject.json` : storedCount=0, panelVisible=false, pinStatus=« Session indisponible » | — (retour Accueil automatique) | **PASS** |
| — | Unités fusion + garde-fou SPA | `merge-model.test.js` 7/7 ; `panels-check.test.js` 18/18 | — | **PASS** |

Preuves : logs parsables dans `logs/` (J04-01…09 + boots), dumps JSON `dumps/`, captures `screenshots/`
(13 PNG, manifeste SHA-256 `png-shas.txt`).

## Critères d'acceptation du plan J04

| Critère | Verdict |
|---|---|
| Les deux Masters affichent le même nom, PIN et `sessionId` | ✅ J04-03 (dumps identiques, masters par `deviceId`) + captures les 2 côtés |
| Un restart n'en crée pas une nouvelle | ✅ J04-08 (count=1, même sid) |
| La session réapparaît dans les sessions récentes | ✅ J04-08 (Accueil, récente avec état/pin/membres persistés) |
| L'écran 03 devient la vue principale réelle de session | ✅ J04-03 (panel-session, `MultiCamSessionScreen`, convergence temps réel) |

## Vérification croisée capture ↔ dump/log + doublons

- **Invariant SPA** : `1|panel-create/join/session/home` vérifié à chaque navigation (pas d'empilement).
- **OCR** (tesseract fra, psm 11) : chaque capture contient le texte attendu du scénario (listé ci-dessus).
- **Pixel-band** (diff BMP par bandes de 60 px) :
  - J04-03-B → J04-04-B et J04-03-C → J04-04-C : seule diff = rangée du NOM (y=420-479, 0,6 %) → renommage visible, rien d'autre ne bouge ;
  - J04-05-join → J04-05-wrong-pin : diff concentrée zone form/PIN (y=300-839, jusqu'à 89,5 %) → saisie/rejet visibles ;
  - J04-06-B-home-closed → J04-08-B-restart-home : diff y=1080-1139 (6,4 %) = badge FERMÉE vs OUVERTE sur la carte récente.
- **Doublons** : 13 PNG, **aucun doublon byte-identique** (`uniq -d` vide).

## Limitations et notes honnêtes

- **TTL DNS-SD système** : après force-stop/`pm clear`, le résolveur système peut encore répondre
  pour des annonces du run précédent jusqu'à ~120-180 s (observations campaigns 3-7). La campagne
  attend l'expiration sur B **et** C avant de commencer (`wait_lan_clear` ×2) afin que les preuves
  LAN ne portent QUE sur la campagne courante. Un résidu manuel d'investigation (session « Repro Visual J04 »,
  créée hors campagne pour le diagnostic visuel) avait contaminé le run 7 — d'où le run 8 final.
- La purge après fermeture est vérifiée ≤ fenêtre stale 150 s (J04-09).
- Scénarios 3 appareils — **NOT TESTED — DEFERRED** (décision utilisateur, PAS affaiblis) :
  déterminisme à 3 Masters, rejet d'un 3ᵉ concurrent, délestage/retour d'un pair en cours de REC.

## Lancer la campagne

```bash
adb devices                          # B et C branchés
bash tests/e2e/j04-campaign.sh clean
```

Résultat attendu : 9 PASS technique + invariants `PANELS_OK`, `TERMINÉ`.