# J02 — Identité persistante + Écran 14 Paramètres device — VALIDATION

## Résumé

| Élément | Valeur |
|---|---|
| Jalon | J02 — Identité persistante + Paramètres device 14 |
| Date / heure | 2026-09-18 09:05–09:20 (heure locale) |
| Commit Git testé | `303538b` (voir `commit.txt`) — contenu `app/` dont l'APK installé est issu |
| Script de validation | `tests/e2e/settings-test.sh` |
| Verdict | **PASS** | 

## Devices testés

Détail complet : `adb-devices.txt`.

| Serial | Constructeur | Modèle | Android | SDK | État |
|---|---|---|---|---|---|
| R9ZT40ALLSN | Samsung | SM-A226B | 13 | 33 | `device` (déverrouillé PIN par l'utilisateur) |
| c0d8514d7d87 | Xiaomi | 24075RP89G | 16 | 36 | `device` |

- Même APK installé sur les deux : SHA-256 `37f530ed97cbb0a1f9348ba0bce6206dee1d98bd3e82296575c569419cdf35d4`
  (`apk-sha256.txt`).
- Formats écran réels (contenu) : Samsung 1080×2208 ; Xiaomi 800×1340.

## Scénario exécuté

`settings-test.sh` : exécution complète par device, depuis état vierge (`pm clear`). Les 20
vérifications exigées du jalon ont toutes été **exercées sur les contrôles réels** (taps UI,
DocumentsUI, dialogues système de permissions), jamais seulement vérifiées par présence dans
l'arbre d'accessibilité. Preuves par captures, dumps `config.json` persistés et logs parsables.

| # | Vérification (correspondance décision J02) | Samsung | Xiaomi |
|---|---|---|---|
| R1 | Première exécution : `CONFIG_INIT source=created` → `config.json` créé | ✅ | ✅ |
| R2 | `deviceId` UUID v4 valide généré (une seule fois) | ✅ `6d7d08cf-…-8eb4` | ✅ `7fbf88be-…-c7a8` |
| R3 | `deviceId` strictement stable après force-stop + relance (2 vérifications) | ✅ | ✅ |
| R4 | Nom modifié via l'écran 14 + affiché (en-tête) + `DEVICE_NAME_SET` journalisé | ✅ | ✅ |
| R5 | Nom persisté après kill + restart (UI et `config.json`) | ✅ | ✅ |
| R6 | Skill **désactivée** puis **réactivée** (config suivie à chaque étape) | ✅ | ✅ |
| R7 | Skills activées persistées après redémarrage + alignement de l'UI Master | ✅ | ✅ |
| R8 | `enabledSkills=[]` atteint et persisté (état « zéro » autorisé) | ✅ | ✅ |
| R9 | Les 3 badges supportés (`Capture`, `Storage`, `Master`) **restent visibles** désactivés | ✅ | ✅ |
| R10 | UI de gestion de sessions **masquée** quand `controller` désactivé (3 sections absentes) | ✅ | ✅ |
| R11 | Hook debug : skill non supportée (`gps`) rejetée + `config.json` **inchangé** | ✅ | ✅ |
| R12 | Permissions = états Android **réels** (4 permissions lues, toutes `NOT_REQUESTED` initialement) | ✅ | ✅ |
| R13 | Interaction réelle : demandes via dialogues système → 4/4 **accordées** (`request_result=GRANTED`) | ✅ | ✅ |
| R14 | Écriture réelle stockage par défaut (interne) → `STORAGE_WRITE mode=internal ok=1` | ✅ | ✅ |
| R15 | Sélection SAF réelle (folders picker) + nom résolu (`getTreeName`) + `mode=saf` persisté | ✅ | ✅ |
| R16 | SAF : création + écriture + suppression réelles → `mode=saf ok=1 deleteOk=1` | ✅ | ✅ |
| R17 | Destination SAF **persistée** après redémarrage (config + chemin affiché) | ✅ | ✅ |
| R18 | Écriture SAF re-réussie après redémarrage (persistance d'accès validée) | ✅ | ✅ |
| R19 | Retour au stockage par défaut (`STORAGE_RESET mode=internal`) + écriture interne révalidée | ✅ | ✅ |
| R20 | Accueil **reflète immédiatement** nom/skills persistés après retour | ✅ | ✅ |

Résultats bruts : `settings-test-results-samsung.txt`, `settings-test-results-xiaomi.txt`
(`RESULTAT GLOBAL rc=0` sur les deux).

## Correspondance critères d'acceptation (plan §J02)

| Critère | Preuve |
|---|---|
| Modifier le nom, tuer, relancer : le nom reste | R4/R5 — `config.json` `deviceName=Cam Nord` + `03-boot-name.log` (HOME_RENDER) + screenshots `02-settings-name` |
| Le `deviceId` ne change pas après restart | R2/R3 — même UUID dans `01-firstrun` et `03-persist-name` (dumps config + logs `CONFIG_INIT`) |
| Les skills activées sont persistées | R6/R7 — `04-skills-toggle`, `06-capture-only`, `07-restart-capture` + `07-boot-capture.log` |
| Les permissions reflètent l'état Android réel | R12/R13 — `09-permissions.log` (4 états lus puis 4 `GRANTED` via dialogues) + screenshot `09-permissions.png` |
| Écran 14 conforme à la maquette fonctionnelle | sections Identité / Skills / Stockage / Autorisations / Infos appareil / Diagnostic — screenshots `02-settings-default.png`, `02-settings-name.png` |

Preuves minimales du plan : screenshots avant/après modification ✅ `02-settings-default` /
`02-settings-name` + `05-home-zero-skills` ; dump JSON de config persistée ✅ fichiers
`*-config.json` (12 étapes) ; même `deviceId` avant/après restart ✅ R3 ; screenshot permissions
et infos device ✅ `09-permissions.png`, `02-settings-default.png` ; log du test SAF sur
stockage principal ✅ `10-saf.log`, `11-saf-restart.log` (URI persistée + write/read=1).

## Détails ciblés

- **SAF (R15/R16/R18).** Même stockage externe sur les deux devices :
  `content://com.android.externalstorage.documents/tree/primary%3ADocuments`
  (`SAF_SELECTED uri=… write=1 read=1`, `SAF_TREE_NAME … name=Documents`). Écriture probe
  réelle : `bytes=38 deleteOk=1` (Samsung `elapsedMs=132`, Xiaomi `elapsedMs=118`). L'écran 14
  affiche « Espace libre : non mesurable pour un dossier SAF » (immesurable rendu explicite,
  jamais de valeur générique trompeuse — décision appliquée).
- **Permission d'interaction (R13).** Tous les boutons « Autoriser » ont été tapés et les
  dialogues système validés : `PERM_CAMERA/MIC/LOCATION/NOTIFICATIONS request_result=GRANTED`
  (états initiaux réels `NOT_REQUESTED`, puisque testés depuis état vierge après `pm clear`).
- **Espace libre (StatFs).** Dimensionnement réel du stockage par défaut (ex. Xiaomi
  « 40.4 Go disponibles »), chemin système sans schéma `file://` déduit via
  `MultiCamStorage.systemPath` (décision : `StatFs` sur la vraie destination).
- **Hook debug (R11).** `am start … --es mcTestSkill gps` → `TEST_HOOK skill=gps`,
  `SKILL_SET … result=REJECTED_UNSUPPORTED`, puis `diff` des dumps `config.json` avant/après :
  aucune modification (cible non supportée jamais ajoutée).
- **Zéro skill (R8/R9/R10).** `enabledSkills=[]` persisté ; à l'accueil les 3 badges restent
  présents (class `cap off` = désactivés, visuellement grisés — screenshot
  `05-home-zero-skills.png`) et `recentArea`/`masterArea`/`newSession` sont absents de l'arbre
  (masqués).
- **Informations appareil.** `deviceInfo` : constructeur/modèle, Android/SDK, `deviceId`
  protocolaire, versions Cordova/app, réseau/IP, batterie — rendus réels depuis `device.js`/
  `platform.js` (pic d'écran `02-settings-default.png`).

## Preuves (dans ce dossier)

| Preuve | Fichier |
|---|---|
| Résultats du test (brut) | `settings-test-results-samsung.txt`, `settings-test-results-xiaomi.txt` |
| Devices | `adb-devices.txt` |
| Environnement / versions | `versions.txt` |
| Plugins / APK + SHA-256 | `cordova-plugins.txt`, `apk-sha256.txt` |
| Commit testé | `commit.txt` |
| Dumps `config.json` (12 étapes × 2 devices) | `<serial>-NN-<étape>-config.json` |
| Logs parsables d'événements (par étape) | `<serial>-NN-<étape>.log` |
| Screenshots (écrans avant/après, skills, permissions, SAF, reset…) | `<serial>-NN-<étape>.png` |

## Défauts découverts et corrigés

1. **`settings.html` omettait `js/native/saf.js`** (round 1). Le premier tap sur « Changer »
   échouait : `Uncaught TypeError: Cannot read properties of undefined (reading
   'chooseDirectory')`. Corrigé (ligne `<script src="js/native/saf.js"></script>` ajoutée),
   rebuild + réinstallation, puis SAF intégralement re-validé (R15–R18). C'est bien ce build
   (commit de test `303538b`) qui est validé par toutes les preuves.

2. **Clamping/prune de l'arbre UiAutomator WebView** (outillage, pas défaut app). Les noeuds
   WebView hors écran sont « clampés » sur les bords de l'écran (bounds dégénérés hauteur nulle)
   et prunés quand ils deviennent trop loin → les taps sur `Changer` / « Revenir au stockage »
   pouvaient manquer silencieusement, surtout sur Samsung (2208 px de contenu). Corrigé dans
   `settings-test.sh` : défilement directionnel adaptatif + hauteur de viewport prise du bord
   bas réel du WebView + attentes de démarrage à froid — ré-exécution complète sur les deux
   devices (rc=0).

3. **Restriction Android 11+ (découverte de qualification).** Le volume racine et le dossier
   `Download` sont bloqués par la confidentialité (« Impossible d'utiliser ce dossier »).
   La validation SAF utilise donc le dossier **Documents** (sélectionnable) sur les deux
   devices — comportement conforme à la plateforme, aucun contournement de sécurité.

## Écarts et notes

1. **Déverrouillage Samsung.** Le device était verrouillé PIN ; l'utilisateur a fourni le code
   qui a été saisi via `adb input` ; tous les tests d'interaction ont ensuite été exécutés
   normalement (l'application n'a pas de contrôle sur le lockscreen).
2. Les `deviceId` sont régénérés par `pm clear` au début de chaque exécution (état vierge) :
   les valeurs citées sont celles des runs finaux ; la stabilité est prouvée **au sein** de
   chaque run (R3, deux occurrences).
3. La « griserie » des badges désactivés est une propriété visuelle (CSS `cap off`) établie par
   le code (`home.js` conditionné sur `enabledSkills`) et rendu dans `05-home-zero-skills.png` ;
   l'état fonctionnel (badges présents, UI Master absente, `enabledSkills=[]`) est prouvé par
   l'arbre d'accessibilité + `config.json` + logs.
4. État final des devices après validation : nom `Cam Nord`, `enabledSkills=[capture]`,
   permissions accordées, stockage revenu à l'interne. Les devices sont laissés dans cet état.
5. Pas de donnée de démo : ssessions récentes/disponibles restent vides (J03), aucune donnée
   fabriquée.
6. **J03 non démarqué** : aucun démarrage de découverte LAN / transport (hors périmètre J02).
7. Le nom « Cam Nord » (ASCII) est utilisé en test pour fiabiliser la saisie `adb input text`
   (les accents sont supportés par l'app, non exercés ici).

## Verdict

**PASS** — tous les critères d'acceptation J02 sont démontrés par les preuves ci-dessus sur les
deux devices physiques, sur le build du commit `303538b` (SHA-256 APK enregistré) : identité
persistante (UUID v4 stable, nom persistant), skills persistées avec état « zéro » supporté,
écran 14 réel et conforme (nom, skills, stockage interne/SAF avec probe d'écriture réelle +
retour au défaut, permissions Android réelles avec interaction, infos appareil), rejet du hook
debug des skills non supportées, et SAF qualifié réutilisé (sélection, write, delete,
persistance).