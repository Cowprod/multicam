# VALIDATION.md — J05 Membres + rôles de session

- Jalon : `docs/PLAN-DEVELOPPEMENT-V1.md` → J05
- État : **PASS — accepté en revue humaine**
- Date campagne : 2026-09-22 (campaign 1 finale, `tests/e2e/j05-campaign.sh clean`)
- Branche : `feat/j05-membres-roles` (départ `ecb9aae` == `main`)
- Décisions appliquées : `MULTICAM_DECISIONS_REFERENCE.md` §31 (membres : ajout/édition/retrait initiés par un Master ; rôle non annoncé rejeté ; device retiré ré-ajoutable immédiatement) et §31.2 (rôles cumulables capture+storage) — architecture inchangée
- Devices physiques : B = `61d54bba7d91` (Cam 07, 192.168.92.76, hôte) et C = `c0d8514d7d87` (Cam 07, 192.168.92.192, second Master + device membre). `61cc29567d91` présent sur le hub **HORS PÉRIMÈTRE** (décision utilisateur) : jamais installé, jamais utilisé.

## Artefact validé

- APK : `app/platforms/android/app/build/outputs/apk/debug/app-debug.apk`
- SHA-256 : `fe4f2d13138785bdd3c7198b5b47f7ccc46f4ee0cae687785a0b51c19d36dc02` (même APK B et C, cf. `apk-sha256.txt`)
- PixelCopy natif vérifié à la compilation (setup-android.sh : 3 greps `capturePreviewSurface`/`CAPTURE_PREVIEW_SURFACE_ACTION` sur `CameraPreview.java`/`CameraActivity.java`).

## Modèle de données J05 (implémenté dans `app/www/js/state/session-model.js`)

- `VALID_ROLES = ["capture","storage"]` (lowercase). `controller` reste une **skill** device (J02), jamais un rôle de session.
- Membre = `{ deviceId, deviceName, enabledSkills, sessionRoles, addedAtMs, addedByDeviceId, roleUpdatedMs, roleByDeviceId }`. Identité = `deviceId` (jamais IP). ≥1 rôle valide requis pour rester membre.
- `validateRoles(enabledSkills, requested)` : un rôle non annoncé est **rejeté** (`no_valid_role_for_device`) — impossible d'injecter un rôle non couvert, y compris depuis l'API (J05-03).
- Retrait = **suppression du membership + rôles**, **tombstone horodaté** (`removedMembers[deviceId] = {removedAtMs, removedByDeviceId}`). Ne touche JAMAIS aux skills globales du device. Absence de remote ≠ retrait (J05-11).
- Ré-ajout immédiat : le tombstone est levé (J05-9). Le chemin convergence (merge) lève aussi le tombstone — déterminisme B↔C (J05-17).
- Merge déterministe : LMW `(roleUpdatedMs, roleByDeviceId)` + départage lexicographique des rôles ; `closed` gagne absolutement ; pruning d'un membre qui perd tous ses rôles valides.

## Protocole J05 (`app/www/js/net/session-ws.js`)

- Enveloppes ciblées `member_add` / `member_update` / `member_remove` **en parallèle** du broadcast complet du `sharedView` (qui porte `members` + `removedMembers`) → convergence immédiate, `semanticEqual` étendu (membres + tombstones) pour éviter tout écho.
- Événements parsables (`logs/`) : `MEMBER_ADD_LOCAL/UPDATE_LOCAL/REMOVE_LOCAL`, `MEMBER_BROADCAST kind=… peers=N`, `MEMBER_ADDED/ROLES_CHANGED/REMOVED/RESTORED `learned_from=<did>`.

## Écran 03 J05 (`app/www/index.html` + `app/www/js/ui/session.js`)

- Section **« Devices dans la session »** : membres avec rôles (`capture`/`storage` pills), `Master` pill pour les Masters, présence = liveness WS (`Connecté`/`Cet appareil`/`Déconnecté`), crayon = édition rôles → modal.
- Section **« Disponibles sur le LAN »** : peers de discovery MINUS membres (décision 31.1), skills annoncées affichées, bouton **Ajouter** → modal.
- **Modal locale** (Ajouter / Modifier / Retirer) : n'expose QUE les rôles couverts par les skills annoncées du device ; ≥1 rôle requis ; Retirer confirmé avant suppression.
- Modal = `div`, pas un `section.panel-*` → les 5 panneaux SPA restent intacts (`panels-check` 18/18).

## Garde-fous déterministes (`tests/plugin-lab/`)

| Suite | Verdict |
|---|---|
| `session/members-model.test.js` (cas mission 1-16 + déterministe J05-17) | **17/17 PASS** |
| `session/merge-model.test.js` (J04 : PIN, closed>open, LMW, masters) | **7/7 PASS** (pas de régression) |
| `ui/panels-check.test.js` (SPA : exactement 1 panneau actif, CSS `.screen`, badges) | **18/18 OK** |
| `node --check` sur tous les JS app modifiés | **OK** |

## Scénarios exécutés (campaign 1, `tests/e2e/j05-campaign.sh clean`)

Invariant à chaque navigation : `PANELS_OK active=panel-…` (exactement UN panneau `.active`).

| # | Scénario | État clé (dumps) | Capture (OCR vérifié) | Résultat |
|---|---|---|---|---|
| J05-01 | B crée la session : sid persistant, PIN 4 chiffres, serveur 45102, DNS-SD, 0 membre | `J05-01-B-created.json` : HKD4NHCW, open, pin=4208, members=0, masters=1 | `J05-01-B-create-screen.png` (« NOUVELLE SESSION ») ; `J05-01-B-session-screen.png` (« 4208 », « Cet appareil », « DISPONIBLES SUR LE LAN ») | **PASS** |
| J05-02 | C découvre le LAN puis rejoint (PIN réel) → 2 Masters égaux ; table « disponibles » de B contient le device C (non membre) | `J05-02-B-2masters.json` : masters=2 par deviceId ; `J05-02-B-available-lan.json` : peer C (did `ecfc17ba…`) dans `available` ; `J05-02-C-joined.json` : masters=2 | `J05-02-C-home-lan.png` (LAN+Rejoindre) ; `J05-02-B/C-session-2masters.png` | **PASS** |
| J05-03 | Injection API d'un rôle NON annoncé (`['storage']` sur device `['capture']`) → rejet `no_valid_role_for_device`, aucun membre créé | `J05-03-B-injection.json` : `REJECTED no_valid_role_for_device` ; `J05-03-B-before/after.json` : members 0→0 | — (API, pas d'UI) | **PASS** |
| J05-04 | B ajoute C en membre `[capture]` → C converge SANS refresh ; C disparaît des « disponibles » de B | `J05-04-B-state.json` / `J05-04-C-converged.json` : membres `[{ecfc17ba: capture}]` identiques ; `J05-04-B-available-after.json` : `memberFiltered=[ecfc17ba]` | `J05-04-B-member-added.png` : « Cam J05 Connecté … capture » ; `J05-04-C-member-added.png` : miroir « Cam J05 Cet appareil · capture » | **PASS** |
| J05-05 | Édition des rôles de C `[capture]`→`[capture,storage]` (cumul 31.2) → convergence SANS refresh | `J05-05-B-roles.json` / `J05-05-C-roles.json` : `roles:[capture,storage], dual:true` | `J05-05-B/C-roles-dual.png` : pills « capture storage » les 2 côtés | **PASS** |
| J05-06 | Force-stop + relance C → membership + rôles conservés (persistance) | `J05-06-C-restart.json` : storedCount=1, open, members=`[{ecfc17ba: capture,storage}]` | `J05-06-C-restart-home.png` | **PASS** |
| J05-07 | Retrait de C par B → membership+rôles supprimés, tombstone, C converge ; C de retour dans « disponibles » | `J05-07-B-remove.json` + `J05-07-C-converged-remove.json` : members=[], tombstone vrai des 2 côtés ; `J05-07-B-available-again.json` : C dans available | `J05-07-B/C-member-removed.png` : « Cam J05 » absent, LauMaster+"Cam 07 Connecté" seuls | **PASS** |
| J05-08 | Ré-ajout immédiat de C (tombstone levé) → convergence, tombstones LEVÉS des 2 côtés (déterminisme B↔C) | `J05-08-B-readd.json` : `tombstoneGone:true` ; `J05-08-C-converged-readd.json` : `gotMember:true, tombstone:false` | `J05-08-C-member-readd.png` : « Cam J05 Cet appareil · capture » | **PASS** |
| J05-09 | Déconnexion C (force-stop) → membre absent RESTE membre sur B (pas de tombstone) ; reconnexion → upsert, AUCUN doublon | `J05-09-B-member-stays.json` : `stillMember:true, tombstone:false` ; `J05-09-B-after-reconnect.json` : memberCount=1 | `J05-09-B-member-still-listed.png` ; `J05-09-B-member-single-after-reconnect.png` | **PASS** |
| J05-10 | Fermeture depuis B → C apprend `closed` ; membres préservés | `J05-10-B-closed.json` / `J05-10-C-closed.json` : state=closed | `J05-10-B/C-closed-screen.png` (badge FERMÉE, « DISPONIBLES SUR LE LAN » vide) | **PASS** |

Preuves : `dumps/` (27 JSON), `logs/` (parsables, MEMBER_*), `screenshots/` (17 PNG — `png-shas.txt`, **aucun doublon byte-identique**), `apk-sha256.txt`.

## Vérification croisée captures ↔ dumps/logs + doublons

- **Invariant SPA** : `1|panel-session/home` à chaque navigation (pas d'empilement).
- **OCR** (tesseract fra, psm 11) : chaque capture contient le texte attendu — PIN « 4208 », « Cam J05 », pills « capture » puis « capture storage », « Cet appareil » / « Connecté », disparition de « Cam J05 » au retrait puis retour au ré-ajout, « DISPONIBLES SUR LE LAN » vide à la fermeture.
- **Doublons** : 17 PNG, **aucun doublon byte-identique** (`uniq -d` vide).

## Critères d'acceptation du plan J05

| Critère | Verdict |
|---|---|
| Un Master peut ajouter / modifier / retirer un device dans la session (écran 03) | ✅ J05-04/05/07 (modal + API, dumps + captures) |
| Les rôles proposés correspondent aux skills annoncées ; un rôle non annoncé est impossible | ✅ J05-03 (injection rejetée) ; modal n'expose que les rôles annoncés |
| Les Masters égaux convergent SANS refresh | ✅ J05-04/05/07/08 (dumps B=C, logs `learned_from`) |
| Le membership et les rôles survivent à un redémarrage | ✅ J05-06 |
| Un member absent reste membre ; le retrait vient d'un tombstone ; ré-ajout immédiat possible | ✅ J05-09 + J05-07/08 |

## Défaut corrigé pendant la validation (déterminisme)

- **Ré-ajout après retrait — tombstones désynchronisés B↔C** : le chemin `addMember` local levait le tombstone, mais le chemin **convergence** (merge) ne levait pas le tombstone local → après ré-ajout, B avait `tombstone:false` et C `tombstone:true` (état divergent, polluait `semanticEqual`). Corrigé dans `session-model.js` (égalisation des tombstones après pruning) et verrouillé par le test **J05-17**. Vérifié physiquement : `J05-08-C-converged-readd.json → tombstone:false`.

## Limitations et notes honnêtes

- **TTL DNS-SD système** : après `pm clear`, le résolveur système peut répondre pour des runs précédents jusqu'à ~120-180 s. Pendant la campagne, la table LAN « brute » de B montre des ghosts non-membres (`9c3eb398…`, `366c35c2…`) — **ils restent « disponibles » (non membres)**, seul le device C (`ecfc17ba…`) est member-filtered. Comportement UI conforme (filtre par membres).
- Nom « Cam J05 » utilisé dans l'API de la campagne (addMember) plutôt que « Cam 07 » annoncé — donnée de la campagne, sans impact sur la sémantique (identité = deviceId).
- Scénarios 3 appareils — **NOT TESTED — DEFERRED** (décision utilisateur, PAS affaiblis) : tracking de présence d'un membre non-Master appuyé sur 3 joueurs, retrait concurrent depuis 3 Masters.
- Revue humaine des 17 captures effectuée et **acceptée le 2026-09-23**.

## Lancer la campagne

```bash
adb devices                          # B et C branchés (61cc29567d91 ignoré)
bash tests/e2e/j05-campaign.sh clean
```

Résultat attendu : 10 PASS technique + invariants `PANELS_OK`, `TERMINÉ`, 0 doublon de capture.