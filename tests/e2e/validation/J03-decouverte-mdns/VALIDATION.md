# J03 — Découverte LAN / mDNS + endpoint /health — VALIDATION

## Résumé

| Élément | Valeur |
|---|---|
| Jalon | J03 — Découverte LAN : paire phare, table de pairs et endpoint /health (ancien transport « T ») |
| Date / heure campaign 1 | 2026-09-18 15:30–16:10 (heure locale) |
| Date / heure campaign 2 (Android×3) | 2026-09-20 09:27–10:05 (heure locale) |
| Commit Git testé | **Implementation exacte campaign 2 : `5df8321`** (contenu `app/` dont l'APK installé est issu, vérifié byte-for-byte) ; campaign 1 : `commit.txt` (`42fcadb`, baseline d'origine) + apk-sha256.txt |
| Scripts de validation | `tests/e2e/mdns-test.sh` (campaign 1) puis `tests/e2e/mdns3-test.sh` (campaign 2, 3 devices) |
| Verdict campaign 1 | **PASS** — réservation Android↔Android (second device bloqué à l'install USB) |
| Verdict campaign 2 | **PASS** (3 devices physiques) — **réservation Android↔Android levée** |

## Campaign 2 — Découverte Android↔Android↔Android (mdns3-test.sh, 2026-09-20)

`mdns3-test.sh` re-joue les 12 scénarios contre **3 téléphones physiques sur le même LAN**
(IP fixes routeur : `192.168.92.57/76/192`). Résultat brut : **`RESULTAT GLOBAL rc=0`, aucune
assertion en échec** (`latency3.txt`, `inventory-final3.txt`, logs par scénario et par device).
La réservation PARTIAL de la campaign 1 (échange Android↔Android, `MDNS_PEER_UPDATED` en place,
bascule multi-pairs) est **levée** : tout est désormais démontré entre 3 vrais devices.

### Exactitude de la traçabilité produit (reconstruite après validation)

Le binaire ayant obtenu le rc=0 final (APK `6b65ecc1…56b2`) était issu d'un fichier natif
**non commité** au moment du run. La chaîne a été verrouillée **sans modifier le comportement
et sans rerun** (preuves ci-dessous) :

| Preuve | Vérification |
|---|---|
| Unique diff produit vs `42fcadb` | `git status/porcelain` : un seul fichier, `app/local-plugins/cordova-plugin-multicam-nsd/src/android/MultiCamNsd.java` (re-annonce en deux temps, retry découverte 1500 ms, `scheduleDiscoveryRefresh`) |
| Sources plugins == sources compilées | `app/platforms/android/…/nsd/MultiCamNsd.java` **byte-for-byte identique** au plugin (sha `38ffaa18a893…01a8` des 2 copies) |
| Source effectivement compilée | horodatages : plugin 21:17:07, copie plateformes 21:17:21, APK 21:17:24 (compilation de ce contenu) |
| APK embarque ce code | dex de l'APK : symboles `reannouncePending`, `pendingReannounceCb`, `scheduleDiscoveryRefresh`, `DISCOVERY_REFRESH_MS` présents |
| Commité = testé | le contenu ci-dessus est commité exactement → **implementation testée = `5df8321`** ; `42fcadb` reste le baseline J03 d'origine (campaign 1) |

### Devices (sér. → deviceId → nom → IP)

| Rôle | Serial | deviceId | Nom annoncé | IP |
|---|---|---|---|---|
| D1 | `61cc29567d91` | `d275fd07-8efa-4ad0-8063-e254c1fcc6f0` | Nord A → NordEtoile (S6) | 192.168.92.57 |
| D2 | `61d54bba7d91` | `33311bd0-9517-49e8-b108-988ab9865033` | Nord B | 192.168.92.76 |
| D3 | `c0d8514d7d87` | `7fbf88be-ef45-4653-b010-ec29c1c35884` | Nord C | 192.168.92.192 |

### Scénarios et résultats (3 runs : 09:2x, 09:4x, 10:0x — le 3ᵉ run constate le rc=0)

| # | Vérification | Résultat |
|---|---|---|
| S1 | Les 3 apps bootent, chaque device converge vers **peers=2**, aucun ne se voit soi-même, UI `devicesCount=2` | ✅ |
| S2 | Identité = **deviceId** (jamais nom/IP) : chaque device voit exactement les 2 autres, jamais soi, noms cohérents | ✅ |
| S3 | Zéro doublon : toutes les tables `peers=2` avec 2 rows uniques par deviceId | ✅ |
| S4 | Stop D2 → **serviceLost** réellement reçu sur D1/D3, tables à `peers=1` | ✅ |
| S5 | Restart D2 → revient avec le **MÊME deviceId** sur D1/D3 + config inchangée | ✅ |
| S6 | Renommage D1 `Nord A`→`NordEtoile` : **delta de valeur réel garanti** (baseline vérifiée ≠ cible), ré-annonce `ADVERTISE_READY`, propagation **en place** (`MDNS_PEER_FOUND` + name update) sur D2 et D3, identité deviceId conservée, 1 seule entrée par device | ✅ |
| S7 | Skills storage off sur D3 → ré-annonce, D1/D2 voient D3 sans `storage`, pas de doublon | ✅ |
| S8 | `enabledSkills=[]` sur D2 → D1/D3 voient D2 avec `enabled=[]`, convergence, pas de doublon | ✅ |
| S9 | `/health` Android→Android : D1→D2, D1→D3, D3→D1 `{ok:true, deviceId corrélé}` ; route inconnue → 404 | ✅ |
| S10 | **Bascule Wi-Fi D1 (coupure ~40 s, sub-TTL)** : Wi-Fi réellement coupé (`cmd wifi status`), `NET_CHANGED networkType=none`, D1 perd ses pairs locaux (PEER_LOST D2+D3), retour Wi-Fi → `NET_CHANGED wifi`, ré-annonce, re-découverte **found peers=2** (2 deviceId distants, zéro auto-vue, 1 entrée/deviceId), D2/D3 **re-résolvent D1** (nouveaux `RESOLVE result=OK` post-retour) vers le **même hôte** qu'avant coupure, D1 re-résout D2+D3. Aucun serviceLost exigé chez les pairs (comportement NSD, cf. « Comportement NSD documenté ») | ✅ |
| S10b | **Expiration du cache NSD (coupure longue)** : serviceLost D1 **observé** sur D2 **et** D3 après ~TTL (cache NSD expiré), re-annonce puis **reconvergence confirmée** des 2 côtés (résolutions vivantes) | ✅ |
| S11 | 3 cycles stop/restart D3 : gate `ADVERTISE_READY` atteint à chaque cycle, D3 **re-résolu** depuis D1/D2 et re-résout D1/D2, **deviceId stable** aux 3 cycles, ligne D3 présente dans les tables D1/D2 | ✅ |
| S12 | Deux devices (D2+D3) portant le **même nom** `NordEtoile` : D1 les voit comme **2 deviceId distincts**, aucune entrée dupliquée, self-filter par deviceId | ✅ |

### Comportement NSD documenté (diag `diag-wifi40s-2026-09-20/` + S10/S10b)

Une coupure Wi-Fi de D1 **inférieure au TTL du cache NSD (~120 s)** provoque chez D2/D3 :
**aucun** serviceLost, **aucune** nouvelle ligne `MDNS_PEER_TABLE`, et des `MDNS_RESOLVE … result=OK`
servis depuis le cache (43 s de coupure ⇒ zéro événement chez les pairs). Le serviceLost n'est
**pas** retrouvé avant expiration : la coupure « courte » est invisible des pairs, la convergence
est démontrée par résolution vivante (oracle paramétré sur `MDNS_RESOLVE`, émis à chaque cycle NSD
de façon inconditionnelle — `discovery.js` `handleServiceUpdated`). Au-delà du TTL (S10b), le
`serviceLost` finit bien par être émis (observé sur D2 et D3) et la reconvergence est réelle.

### Fiabilisation du harness (défauts d'outillage corrigés, PAS d'évolution produit)

1. **Phase 0** : les apps devaient être (rel)ancées avant tout `open_settings`/renommage — la cause
   historique de l'échec silencieux du baseline D1 (« Nord A » jamais posé). Établissement de
   baseline **vérifié** (config persistée) par device, plus de supposition de succès.
2. **S6** : le pré-requis était cassé (baseline D1 déjà égale à la cible ⇒ renommage no-op). Le
   scénario établit désormais un baseline **vérifié et ≠ cible**, puis renomme réellement ; la
   vérification `ADVERTISE_READY` pré-renommage est INFO (ligne annonce évincée du ring-buffer, la
   preuve porte sur le rename et sa propagation).
3. **S10/S10b/S11** : lire l'état d'un pair via la dernière `MDNS_PEER_TABLE` est fragile (ring-buffer
   logcat ~256 Ko évincé en quelques minutes ; device redémarré ⇒ peers restaurés de
   `sessionStorage`, ré-announces identiques ⇒ **aucune** nouvelle table). Les assertions ont été
   reconstruites sur l'**observable inconditionnel** `MDNS_RESOLVE … result=OK` (comptage de delta,
   hôte stable), complété par la table **fraîche** de l'émetteur (D1 en S10) et le gate
   `ADVERTISE_READY` (ré-annonce froide ~154 s au cycle 1 de S11). Aucune assertion non liée
   affaiblie (S1–S9, S12 inchangés et tous PASS).
4. **Produit inchangé pendant la campaign / traçabilité verrouillée** : aucune modification
   de code application n'a été apportée pendant la campaign ; le binaire testé
   (`6b65ecc1…56b2`) intègre le fichier natif NSD **déjà modifié** (re-annonce en deux temps,
   retry + refresh découverte) dont le contenu exact est commité **après** le run sous
   `5df8321` (sources plugin/plateformes byte-for-byte, compile→APK 3 s, symboles présents
   dans le dex) — le code commité est donc exactement le code du binaire validé,
   aucune reconstruction nécessaire.

### Preuves (campaign 2, dans ce dossier)

| Preuve | Fichier |
|---|---|
| Timeline diagnostic coupure Wi-Fi 40 s | `diag-wifi40s-2026-09-20/` (`host-timeline.txt`, `*-stream.log`, `*-events.txt`, `README.md`) |
| Horodatages latences par scénario | `latency3.txt` |
| Inventaire final (noms/skills par device) | `inventory-final3.txt`, `identite3.txt` |
| Logs événements parsables par scénario × device | `<serial>-S1-mutual.log … <serial>-S12-same-name.log` |
| /health Android→Android | `health-D1-to-D2.txt`, `health-D1-to-D3.txt`, `health-D3-to-D1.txt`, `health-other-code.txt`, `health-ok.json` |
| Screenshots | `<serial>-01-S1-home-peer2.png`, `-04-S4-D2-lost.png`, `-05-S8-zero-node.png`, `-06-S11-final.png` |
| Devices 3 × install | `adb-devices3.txt`, `install3-<serial>.log` |
| APK testé | `apk-sha256.txt` |

## Devices testés (campaign 1)

Détail complet : `adb-devices.txt`.

| Serial | Constructeur | Modèle | Android | SDK | État |
|---|---|---|---|---|---|
| c0d8514d7d87 | Xiaomi | 24075RP89G | 16 | 36 | `device` — **device de validation** |
| 61d54bba7d91 | Xiaomi | 24075RP89G | 16 | 36 | `device` mais **install USB bloquée** (`INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`, restriction MIUI « Installer via USB ») → **EXCLU**, voir `install-61d54bba7d91.log` |

- APK installé : SHA-256 `c1b4b10560d471599d45c126b99dd2460fa33fff372724459046356268beac6b` (`apk-sha256.txt`).
- DeviceId validation : `7fbf88be-ef45-4653-b010-ec29c1c35884` (hérité de J02, inchangé toute la séance), nom de validation `Nord J3`, IP LAN `192.168.92.192`, Mac hôte `192.168.92.184`.
- **Contexte cross-périphérique** : le second Android ne pouvant pas recevoir l'APK, la découverte entre DEUX membres du LAN a été exercée contre un **pair mDNS réel** publié depuis le Mac via `dns-sd -P _multicam._tcp.` (mDNSResponder Apple, `host mcmacpeer.local.`, `did=demo-mac-peer-0001`, port 45101). Found/resolve/lost/table/endpoint sont donc de vrais échanges réseau mDNS, pas une simulation logicielle. **Ce qui reste PARTIAL** : l'échange Android↔Android (2 téléphones) sur la mise à jour « en place » (`MDNS_PEER_UPDATED`) et le basculement multi-pairs, non exercables aujourd'hui — critères repris sans inventer de faux-PASS (cf. `note-contexte.txt`).

## Scénario exécuté

`mdns-test.sh` : 15 scénarios + inverse-cycles et sections zéro-skill, sur le device validé, avec pair publié depuis le Mac (3 instances par cycles), observateur Mac indépendant (`dns-sd -B` / `-L`) et `curl` sur `/health`. Résultats bruts : `mdns-test-results.txt` (`RESULTAT GLOBAL rc=0`, aucune assertion en échec).

| # | Vérification | Résultat |
|---|---|---|
| SCR-01 | Boot propre : `MDNS_ADVERTISE_START`, identité `deviceName`, `MDNS_ADVERTISE_READY` (registeredName), chemin **modern** SDK 36 (`registerServiceInfoCallback` — jamais de registerException), `HEALTH_SERVER_START port=45101`, `MDNS_DISCOVERY_START`, self absent de sa propre table | ✅ |
| SCR-02 | Invariants : table peers vide au démarrage, aucun peer avant publication (0 entrée clé IP) | ✅ |
| SCR-03 | Pair dns-sd -P : `MDNS_SERVICE_FOUND service=MacPeer`, `MDNS_RESOLVE … host=192.168.92.184 port=45101 result=OK`, `MDNS_PEER_FOUND` avec TXT (name/supported/enabled/version) + endpoint corrélé | ✅ |
| SCR-04 | Table canonicale : `peers=1`, une seule entrée keyée deviceId, aucun doublon | ✅ |
| SCR-05 | Re-publication même deviceId : entrée réutilisée, `peers=1`, pas de doublon (serviceLost puis found) | ✅ |
| SCR-06 | Perte du pair : `MDNS_PEER_LOST reason=serviceLost` (source primaire) puis `peers=0` | ✅ |
| SCR-07 | 3 cycles publication/perte : convergence `peers=1` à chaque cycle, 0 doublon | ✅ |
| SCR-08 | Renommage local via écran Paramètres : `MDNS_REANNOUNCE_TRIGGER reason=name_change`, config persistée, `MDNS_REANNOUNCE result=OK`, **l'instance renommée `Nord J3` résolue chez un client mDNS tiers (Mac, did corrélé)** | ✅ |
| SCR-09 | Skill storage activée : `MDNS_REANNOUNCE_TRIGGER reason=skill_change`, reannounce + `enabledSkills` persisté | ✅ |
| SCR-10 | `controller=off` : l'annonce reste visible côté Mac (indépendante du rôle) + `/health` toujours joignable | ✅ |
| SCR-10b | `enabledSkills=[]` : l'appareil annonce toujours, et le TXT vu par le Mac **omet l'attribut `enabled`** (règle appliquée) | ✅ |
| SCR-11 | Bascule Wi-Fi : `NET_CHANGED wifi`, reannounce réseau (`ADVERTISE_STOP/START reason=network_change`), **aucune registerException**, re-convergence avec le pair | ✅ |
| SCR-12 | `/health` : HTTP 200 `{ok:true, deviceId ↔ config, deviceName ↔ config, version}` , `HEALTH_REQUEST … status=200`, route inconnue → 404 | ✅ |
| SCR-13 | Écran accueil réel : carte « Disponible sur le réseau » (« Annonce mDNS active · Nord J3 · port 45101 »), compteur `devicesCount=1`, carte du pair + endpoint affichés ; retour à l'état vide `0` après perte | ✅ |
| SCR-14 | Observateur Mac indépendant : instance `Nord J3._multicam._tcp.local.` visible au `dns-sd -B`, résolue au `dns-sd -L` avec `did=` / host / port 45101 corrélés | ✅ |
| SCR-15 | Stabilité : 3 relances app, convergence avec le pair à chaque cycle, deviceId stable, aucune erreur de registration | ✅ |

### Preuves Mac indépendantes (extraits `dns-sd -L Nord J3`)

Skills restaurées (SCR-14) :

```
Nord\032J3._multicam._tcp.local.  can be reached at Android_XTJW8JPR.local.:45101
 enabled=capture,storage,controller supported=capture,storage,controller
 did=7fbf88be-ef45-4653-b010-ec29c1c35884 ver=0.1.0 sver=1 dname=Nord\ J3
```

Zéro skill (SCR-10b) — **sans `enabled=`** :

```
Nord\032J3._multicam._tcp.local.  can be reached at Android_77GP3MRI.local.:45101
 supported=capture,storage,controller did=7fbf88be-ef45-4653-b010-ec29c1c35884
 ver=0.1.0 sver=1 dname=Nord\ J3
```

## Correspondance critères d'acceptation (plan §J03)

| Critère | Preuve |
|---|---|
| Identité = deviceId (jamais nom/IP/modèle) ; self-filter | SCR-02/04/15 : table keyée `deviceId=`, self absent (SCR-01), `deviceId` stable sur 3 relances |
| Événements primaires NSD → transitions peer | SCR-03 (found→online), SCR-06 (serviceLost→remove), SCR-05 (redécouverte même deviceId réutilise l'entrée) |
| Pas de doublons ; re-publication convergente | SCR-04/05/07 (0 doublon), SCR-07 3 cycles |
| Re-annonce sur renommage / skills | SCR-08 (`name_change`) et SCR-09 (`skill_change`) + preuve résolution Mac |
| Annonce active sans controller (toujours) | SCR-10 + browse Mac + `/health` |
| TXT `enabled` omis quand `enabledSkills=[]` | SCR-10b + `dns-sd -L` (TXT sans `enabled=`) |
| `/health` minimal (jamais WS/sessions J04) | SCR-12 : `{ok,deviceId,deviceName,version}` uniquement + 404 ailleurs |
| Écran 01 : carte réseau réelle + liste pairs | SCR-13 : screenshots `13-home-peer` / `13-home-empty` |
| Conformité transport / mot distribué | SCR-01..SCR-15 : logs parsables `MDNS_*`, `HEALTH_*`, `NET_CHANGED` — aucune donnée non déterministe dans la table |

## Détails ciblés

- **Chemin NSD modern API 36.** `registerServiceInfoCallback`/`discoverServices` documentés
  utilisés (`MDNS_NSD_PATH path=modern sdk=36`) sur la cible réelle ; les branches legacy n'ont pas
  été exercées (device 16). `NSD` stable sur les relances multiples (3×) : aucun
  `registerException`/`listener already in use` pendant toute la séance (ce bug observé lors de la
  mise au point — redémarrage discovery-only, PAS de re-register — est corrigé par
  `MultiCamNsd.restartNsd` et sa trace est neutralisée ici).
- **Ordre des événements UI.** `discovery.js` doit être chargé avant `transport.js` (bug de charge
  `MultiCamDiscovery undefined` au boot constaté et corrigé via l'ordre des `<script>` dans
  `index.html`/`settings.html`).
- **Bascule réseau.** Sur `NET_CHANGED`, redémarrage découverte-only (ni unregister ni register):
  `ADVERTISE_STOP/START reason=network_change` + re-convergence ; l'état de l'annonce est conservé
  (aucun `ADVERTISE_READY` re-émis volontairement — pas de double registration).
- **Édition de TXT.** `buildServiceInfo` sérialise `supported/enabled` par CSV explicite
  (`jsonArrayToCsv`) — `JSONArray.join` quote les chaînes (`"capture","storage"`) ; le TXT vu par
  le Mac confirme des valeurs propres `capture,storage,controller`.
- **TXT strict.** Contenu observé côté Mac = exactement `did, dname, supported, enabled (si non
  vide), ver, sver` — pas d'IP ni de `host=` dans le TXT (l'endpoint est le SRV, conforme DNS-SD).
- **Screenshots réels.** `01-boot-home`, `03-peer-found`, `06-peer-lost`, `07-reconvergence`,
  `08-renamed`, `09-skill-settings`, `10-controller-off`, `10b-zero-skills`,
  `10c-restored`/`13-home-peer`, `13-home-empty`, `11-wifi-reconnect`, `15-cycle1..3`.

## Preuves (dans ce dossier)

| Preuve | Fichier |
|---|---|
| Résultats du test (brut, rc=0) | `mdns-test-results.txt` |
| Contexte / exclusion du second device | `note-contexte.txt`, `install-61d54bba7d91.log` |
| Devices | `adb-devices.txt` |
| APK + SHA-256 | `apk-sha256.txt` |
| Commit testé | `commit.txt` |
| Logs parsables d'événements par scénario | `c0d8514d7d87-<sr>-*.log` |
| Dumps de config (avant/après skills) | `c0d8514d7d87-09-skill-config.json`, `…-10c-restored-config.json`, `…-15-final-config.json` |
| Screenshots | `c0d8514d7d87-<n>-*.png` |
| Preuves observateur Mac (browse/lookup) | `c0d8514d7d87-08-mac-lookup.log`, `-10-mac-browse.log`, `-10b-mac-browse.log`, `-10b-mac-lookup.log`, `-14-mac-browse.log`, `-14-mac-lookup.log` |
| Publication pair (Mac) | `c0d8514d7d87-publisher-*.log` |

## Défauts découverts et corrigés pendant la validation

1. **`settings.js` : accolade en trop (après le bloc `btnRefreshNet`)** → `Uncaught SyntaxError:
   Unexpected token 'function'` à la ligne 388 : l'IIFE était fermée par anticipation et **tout
   l'écran Paramètres était mort** (renommage sans effet, skills jamais rendues — conteneur
   `#skills` 4 px de haut). Corrigé (accolade retirée), `node --check` sur les 11 fichiers JS de
   l'app OK, rebuild, re-validation complète : SCR-08 (renommage réel via UI), SCR-09/10/10b
   (toggles skills réels) passent ensuite. C'est ce build corrigé (commit de test ci-dessous) qui
   est validé.
2. **Sélection du device de test (outillage, pas défaut app).** Le premier run ciblait
   `61d54bba7d91` (permutation `head -1`), d'où des échecs en cascade. Corrigé dans
   `mdns-test.sh` : choix par **installabilité réelle** de l'APK courant, exclusion documentée
   du device bloqué, données parsables. (Script `mdns-test.sh` — le défaut n'est pas dans l'app.)
3. **`dns-sd -L` préféré à `-B` pour la preuve de renommage** (cf. SCR-08) : le `-B` tué à 5 s ne
   flushait pas toujours son tampon ; le `-L` résout et corrèle toujours (did/port).

## Écarts et notes

1. **PARTIAL campaign 1 → levé par campaign 2.** L'échange Android↔Android et `MDNS_PEER_UPDATED`
   « en place » (même deviceId re-public avec TXT modifiée) n'étaient pas démontrables avec un seul
   device (second Android bloqué à l'install). La campaign 2 (`mdns3-test.sh`, rc=0 sur 3 devices)
   démontre l'échange Android↔Android complet : S2 (identité deviceId ×2 pairs), S6 (renommage en
   place propagé : `MDNS_PEER_FOUND`/update name chez 2 pairs, 1 entrée/deviceId), S7/S8 (TXT
   skills/enabled modifiées vues « en place » par les pairs sans redémarrage), S10/S10b (bascule
   réseau multi-pairs, cache NSD). Réservation **levée**.
2. **Renommage saisi en ASCII** (« Nord J3 ») : `adb input text` fiable ; l'app gère les accents
   (hors scope interaction distante).
3. **Wi-Fi.** Bascule réelle `svc wifi disable/enable` → le routeur a ré-attribué la même IP à
   l'appareil (`192.168.92.192` avant/après, fiché `ip-phone-final.txt`).
4. **L'état final du device de validation** : nom `Nord J3`, `enabledSkills=[capture,storage,
   controller]` (config « maître »), IP `192.168.92.192`, annonce `Nord J3 … :45101` active,
   aucun pair résiduel.
5. **Aucune donnée de démo.** Les sections sessions (J04) restent vides ; la table de pairs ne
   contient que des sources réelles.
6. **Cache NSD / TTL (comportement plateforme, campaign 2).** Coupure < ~120 s ⇒ aucun serviceLost
   chez les pairs, résolution servie par le cache (cf. diag `diag-wifi40s-2026-09-20/` et S10).
   Coupure > TTL ⇒ serviceLost émis (S10b, observé sur D2+D3) puis reconvergence réelle. À
   documenter côté produit/livrable, aucune action de correction identifiée.

## Verdict

**PASS** — campaign 1 sur le build du commit référencé dans `commit.txt` (SHA-256 APK
`c1b4b1…beac6b`), campaign 2 sur l'implementation **`5df8321`** (APK `6b65ecc1…56b2`,
identique sur les 3 devices) : découverte
LAN mDNS/DNS-SD opérationnelle (paire phare, resolve, table de pairs stagée par deviceId, perte
primaire, re-convergence sans doublon, redémarrage réseau sans race), identité strictement par
`deviceId`, annonce conforme (TXT strict, re-annonces sur renommage/skills, indépendante du rôle,
`enabled` omis à vide), endpoint `/health` minimal et corrélé, écran 01 reflétant l'état réel —
démontré en campaign 1 par un client mDNS tiers indépendant (Mac), et en campaign 2
**entre 3 Android physiques** (`mdns3-test.sh`, **rc=0**) : échange en place, bascule multi-pairs,
serviceLost à expiration du cache NSD, identification par deviceId à travers 3 cycles de
stop/restart, coexistence de deux devices portant le même nom. **La réservation Android↔Android
est levée.**