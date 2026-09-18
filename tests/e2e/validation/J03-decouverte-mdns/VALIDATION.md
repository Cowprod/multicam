# J03 — Découverte LAN / mDNS + endpoint /health — VALIDATION

## Résumé

| Élément | Valeur |
|---|---|
| Jalon | J03 — Découverte LAN : paire phare, table de pairs et endpoint /health (ancien transport « T ») |
| Date / heure | 2026-09-18 15:30–16:10 (heure locale) |
| Commit Git testé | voir `commit.txt` — contenu `app/` dont l'APK installé est issu |
| Script de validation | `tests/e2e/mdns-test.sh` |
| Verdict | **PASS** (Android↔Android physique : **PARTIAL**, raison documentée) |

## Devices testés

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

1. **PARTIAL assumé.** L'échange Android↔Android et `MDNS_PEER_UPDATED` « en place » (même
   deviceId re-public avec TXT modifiée) ne sont pas démontrables avec un seul device. La
   re-publication même-did teste la réutilisation d'entrée (SCR-05, réel) ; la mise à jour du
   TXT en cache NSD pour un second enregistrement même host/port n'a pas été délivrée à NsdManager
   dans les délais observés — comportement plateforme, suivi à J04. NU iteration-partielle notée.
2. **Renommage saisi en ASCII** (« Nord J3 ») : `adb input text` fiable ; l'app gère les accents
   (hors scope interaction distante).
3. **Wi-Fi.** Bascule réelle `svc wifi disable/enable` → le routeur a ré-attribué la même IP à
   l'appareil (`192.168.92.192` avant/après, fiché `ip-phone-final.txt`).
4. **L'état final du device de validation** : nom `Nord J3`, `enabledSkills=[capture,storage,
   controller]` (config « maître »), IP `192.168.92.192`, annonce `Nord J3 … :45101` active,
   aucun pair résiduel.
5. **Aucune donnée de démo.** Les sections sessions (J04) restent vides ; la table de pairs ne
   contient que des sources réelles.

## Verdict

**PASS** — sur le build du commit référencé dans `commit.txt` (SHA-256 APK enregistré,
`c1b4b1…beac6b`) : découverte LAN mDNS/DNS-SD opérationnelle (paire phare, resolve, table de
pairs stagée par deviceId, perte primaire, re-convergence sans doublon, redémarrage réseau
sans race), identité strictement par `deviceId`, annonce conforme (TXT strict, re-annonces sur
renommage/skills, indépendante du rôle, `enabled` omis à vide), endpoint `/health` minimal et
corrélé, écran 01 reflétant l'état réel — **démontré y compris par un client mDNS tiers
indépendant (Mac)**. Le sous-ensemble Android↔Android est marqué **PARTIAL** avec justification
(device bloqué à l'install) et reprise programmée à J04/J05, sans faux-PASS.