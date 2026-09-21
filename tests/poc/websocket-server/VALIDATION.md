# POC — Qualification physique C2 (`cordova-websocket-server@1.1.0`)

> Statut : **QUALIFIÉ (POC) — tests physiques exécutés sur 3 devices ; C2 utilisable pour MultiCam avec les limites documentées §9.**
> + **Partie A certifiée (21/09/2026) : redémarrage immédiat par repli de port, sans patch natif (§12).**
> + **Partie B analysée (21/09/2026) : origine production client WebSocket (§13) — recommandation proposée à la revue humaine dans `PRODUCTION-INTEGRATION.md`.**
> Patch de compatibilité minime autorisé par revue humaine (`fc1ec3d docs(poc): allow minimal C2 compatibility patch`).
> Date : 21 septembre 2026.

---

## 1. Objet

Prouver physiquement que C2 (`raghu2x/cordova-websocket-server@1.1.0`) peut fournir l'infrastructure WebSocket générique requise par MultiCam (serveur entrant natif + client WebView standard) sur les devices Android du projet.

Application de test isolée : `tests/poc/websocket-server/c2-test/`. Aucune logique métier MultiCam.

## 2. Résultat global

| Vérification | Résultat |
|---|---|
| Build Android sans modification du plugin | **FAIL amont** → résolu par patch de compatibilité minime (§4) |
| Installation sur devices physiques (A/B/C) | **PASS** (APK `607498b6…`, §6 ; build Partie A `e6470947…`, §12) |
| C2-01 → C2-07 | **PASS** |
| C2-08 (stop serveur + reboot même port) | **PARTIAL** : fermeture côté clients PASS ; rebind immédiat rarement FAIL (TIME_WAIT, §9) — **absorbé par le repli de port Partie A** (§12) |
| C2-09 (force-stop app + relance) | **PARTIAL** : relance app PASS ; rebind immédiat rarement FAIL (TIME_WAIT, §9) — **absorbé par le repli de port Partie A** (§12) |
| C2-10 (serveur + client WebView simultanés même device) | **PASS** |
| C2-11 (topologie 3 devices en anneau) | **PASS** |
| C2-12 (connexion soutenue 600 s) | **PASS** |
| Frames 50/100/150 Ko (texte + binaire, 2 sens) | **PASS** |
| Client WebView standard | **PASS** |
| **Partie A** — redémarrage immédiat par repli de port (A1/A2/A3 + repli forcé) | **PASS** (§12) |
| **Partie B** — origine production / client WebSocket (analyse, pas de test physique) | **RECOMMANDATION** : `http://localhost` + `ws://` LAN brut (§13) |

## 3. Environnement de build

| Composant | Version |
|---|---|
| Cordova CLI | 13.0.0 |
| cordova-android | 15.1.0 |
| Gradle (wrapper) | 8.14.2 |
| AGP | 8.10.1 |
| SDK Android (compile/target) | android-36 |
| minSdk / targetSdk (app) | 24 / 36 |
| JDK | OpenJDK 17.0.17 (Homebrew, `JAVA_HOME=/opt/homebrew/opt/openjdk@17`) |
| Plugin | `cordova-websocket-server` **1.1.0** (installe `cordova-plugin-add-swift-support` 2.0.2, iOS-only) |
| Java-WebSocket résolue (mavenCentral) | **1.6.0** (jar confirmé dans `~/.gradle/caches/modules-2/.../Java-WebSocket/1.6.0/`) |
| Node | 23.10.0 |

**Commandes de build final :**

```bash
cd c2-test
# install plugin patché local + hook cleartext + config.xml conventionnel
cordova prepare android
cd platforms/android
JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew :app:assembleDebug
```

> ⚠️ Quirk observé : `cordova build android` de ce projet sort sans erreur mais **ne recompile pas l'APK** (génère les hooks et s'arrête) ; le build effectif passe par `./gradlew :app:assembleDebug` après `cordova prepare`. À garder en tête pour tout rebuild.

## 4. Erreur de build amont et patch de compatibilité

**Erreur amont (sans patch) :** `platforms/android/app/src/main/java/cordova/wsserver/WebSocketServerPlugin.java:55`

```
error: exception IOException is never thrown in body of corresponding try statement
       } catch (IOException e) {
```

**Cause racine :** en Java-WebSocket 1.6.0, `WebSocketServer.stop()` ne déclare plus `throws IOException` (vérifié `javap`) ; deux blocs `catch (IOException)` autour de `stop()` sont devenus morts dans le fork `raghu2x` (monté à 1.6.0 sans adaptation) : `WebSocketServerPlugin.onDestroy()` et `WebSocketServerImpl.onError()`.

**Patch minime (POC uniquement, aucune API modifiée) :** `evidence/c2/plugin/C2-1.6.0-compat.patch` — suppression des 2 seuls `catch (IOException)` morts. Détails : `evidence/c2/plugin/PATCH.md`. Source amont préservée intacte dans `evidence/c2/plugin/upstream/` (extraction exacte du tarball npm `cordova-websocket-server-1.1.0.tgz`). Copie patchée installée : `c2-test/local-plugins/cordova-websocket-server/`.

## 5. Corrections POC additionnelles (sans modification du plugin)

1. **Cleartext** : hook `c2-test/hooks/after_prepare/010-enable-cleartext.js` injecte `android:usesCleartextTraffic="true"` sur `<application>` de l'AndroidManifest généré (nécessaire pour `ws://` en LAN, targetSdk 36). Confirmé dans l'APK final par `aapt2 dump xmltree` (variante `<edit-config>` abandonnée : cassait aapt2).
2. **CSP** : `www/index.html` → `connect-src 'self' ws: wss:`. La CSP d'origine bloquait toute connexion `ws://` (client WebView restait CLOSED — preuve : `cdp-console-B-CSP-block.log` + `base-C2-run3.log`).
3. **Origine WebView** : `config.xml` → `<preference name="scheme" value="http" />` + `<preference name="hostname" value="localhost" />`. Sans cela, l'origine par défaut `https://localhost` rejette `ws://` LAN dès le constructeur `new WebSocket()` (« insecure WebSocket »/mixed content). Confirmé dans l'APK (`res/xml/config.xml`). Rendu du POC : page servie en `http://localhost`. **Pour le code production, à re-statuer (WSS ou schéma dédié) — hors POC.**

## 6. APK final

- Chemin : `c2-test/platforms/android/app/build/outputs/apk/debug/app-debug.apk`
- **SHA-256 (qualification C2) : `607498b60394baf563b886912a904f7e943ab8dcf11949666b0bf61ce3384bd8`**
- Contenu vérifié : plugin patché (sans `catch (IOException)`), cleartext, CSP `ws:`, origine http://localhost.
- Même fichier binaire installé sur A/B/C (SHA-256 installé ⇔ SHA-256 du fichier). Détails : `evidence/c2/build/apk-sha256.txt`.
- **Build Partie A (delta JS, plugin inchangé)** : `e6470947c8c5efa21a74503cb0ce0123697493739cd077c39064f3653be15782` — ajoute le repli de port (§12). Détails et registre des builds : `evidence/c2/build/apk-sha256.txt`.

## 7. Dispositifs de test

| Rôle | Serial | Modèle | Android | IP wlan0 (LAN) |
|---|---|---|---|---|
| A | `61cc29567d91` | Xiaomi 24075RP89G (Redmi Note 13) | 16 (SDK 36) | 192.168.92.57 |
| B | `61d54bba7d91` | Xiaomi 24075RP89G (Redmi Note 13) | 16 (SDK 36) | 192.168.92.76 |
| C | `c0d8514d7d87` | Xiaomi 24075RP89G (Redmi Note 13) | 16 (SDK 36) | 192.168.92.192 |

IP DHCP. Debug via CDP (ports locaux 9223/9224/9225, `webview_devtools_remote_<pid>`).

## 8. Déroulement des tests

Chronologie des exécutions (toutes conservées dans `evidence/c2/run/`) :

| Run | Log | Rôle |
|---|---|---|
| run3 | `base-C2-run3.log` | Avant fix CSP → clients WebView bloqués par CSP (témoignage du défaut) |
| run4 | `base-C2-run4.log` | CSP fixée mais origine https://localhost → échec ctor `new WebSocket()` (témoignage) |
| run5 | `base-C2-run5.log` | Après fix origine http ; anomalie EADDRINUSE en cours de suite — cause racine établie en §9 |
| run6 | `base-C2-run6-final.log` | Suite de base finale (C2-01→C2-10) : C2-11/PAQUETS également exécutés mais **affectés** par le lien C→A absent et des restes TIME_WAIT en fin de course — non retenus pour ces 2 critères (run dédié ci-dessous = autorité) |
| — | `rebind-repro-C2-08-09.log` | Reproduction déterministe du défaut de rebind (C2-08/09) |
| — | `ring-C2-11-payload.log` | Topologie 3 devices en anneau (C2-11) + PAQUETS 50/100/150 Ko |
| — | `sustained-C2-12.log` | Connexion soutenue 600 s (C2-12) |

### Résultats des critères

| Test | Verdict | Preuve (log) |
|---|---|---|
| C2-01 — serveur à l'écoute sur :45102 | PASS | listening on :45102 (bind ::) |
| C2-02 — client B connecté | PASS | B client OPEN ; A onOpen uuid=… remote=192.168.92.76 |
| C2-03 — échange bidirectionnel + intégrité | PASS | B rx ACK echo_of=1 len=18/18 crc=OK ; B rx len=131 « client got test from=A seq=2 len=18/18 crc=OK » |
| C2-04 — 2 connexions distinctes | PASS | conn-list : `c76b82bc…` (B) + `f553b984…` (C), #2 |
| C2-05 — envoi ciblé | PASS | B reçu ; C non reçu (log inchangé) |
| C2-06 — broadcast JS | PASS | B reçu ET C reçu (2 conn(s)) |
| C2-07 — déconnexion/reconnexion | PASS | onClose détecté sur A, B retiré de la liste, C conservé, B reconnecté, roundtrip OK |
| C2-08 — stop serveur (rebind même port) | PARTIAL | fermeture observée B et C PASS ; **restart immédiat FAIL** `Address already in use` (§9) |
| C2-09 — force-stop app + relance | PARTIAL | relance app PASS (l'app redémarre et le serveur se rebind après expiration TIME_WAIT) ; rebind immédiat FAIL `Address already in use` (§9) |
| C2-10 — serveur + client même device | PASS | A client OPEN sur B (serveur :45102), roundtrip A→B→A + B→A→B crc=OK |
| C2-11 — anneau 3 devices | PASS | A server ← C ; B server ← A ; C server ← B ; échanges C→A→C, A→B→A, B→C→B tous roundtrip OK |
| C2-12 — soutenue 600 s | PASS | aucun disconnect/erreur ; 300 hb envoyés / 300 ack par device ; conns=1 |
| PAQUETS 50/100/150 Ko | PASS | texte + binaire, client→serveur (echo) et serveur→client, tous `crc=OK` / `client binary VERIFIED` |

Détail C2-12 (réalisé sur l'anneau actif) : A rx=301 tx=311 hbSent=300 hbAck=300 conns=1 ; B rx=311 tx=308 hbSent=300 hbAck=300 ; C rx=301 tx=301 hbSent=300 hbAck=300 ; 0 ligne d'anomalie sur les 3 devices (delta-scope). Durée commandée 600 s, mesurée 600 s (12:17:52Z → 12:27:55Z).

### Preuves visuelles

`evidence/c2/shots/` : `c2-01-A-start`, `c2-02-B-connected`, `c2-04-A-two-clients`, `c2-08-A-restarted`, `c2-10-A|B-hosts-and-clients`, `c2-11-A|B|C-ring`, `payload-A|C` (PNG 800×1340, captures device via adb). Avant-fix : sous-dossier `pre-cspfix-run3/`.

## 9. Limites documentées

1. **Rebind immédiat même port (C2-08/09).** Après un stop serveur avec des clients acceptés, ou un force-stop, un rebind immédiat sur le même port échoue : `FAILED: Address already in use`. **Cause racine démontrée** (reproduction déterministe, `rebind-repro-C2-08-09.log`, `javap`) : Java-WebSocket 1.6.0 appelle `setReuseAddr(false)` à la construction du serveur ; après fermeture, l'éphémère côté serveur reste en TCP `TIME_WAIT` (`st=01`, ~60 s) et bloque le bind. Détail observé sur A :45102 (0xB02E) 4C5CA8C0:B02E st=01. Le rebind réussit après expiration de la fenêtre (~75 s mesuré). **Propriété inhérente à l'upstream, PAS introduite par le patch.** Application MultiCam : planifier relance sans rebind immédiat, ou réserver le port avant raccordement, ou (si nécessaire) proposer `setReuseAddr(true)` en revue.
2. **Événement `onFailure`.** Le plugin ne remonte pas l'échec de bind par l'événement `onFailure(addr, port, reason)` ; l'échec transite par le callback d'échec de `start()`. Conséquence : les contrôles « pas d'événement onFailure » ne sont pas signifiants (log run6) — le verdict s'appuie sur l'état serveur (`FAILED: Address already in use`) et la non-réacceptation, vérifiés.
3. **Origine http (POC).** Le client WebView standard (Cordova) exige une origine non-HTTPS pour abattre `ws://`. Le POC baisse le schéma à `http://localhost`. **Analyse production à jour : §13 + `PRODUCTION-INTEGRATION.md`** — recommandation `http://localhost` pour V1.
4. **`cordova build` silencieux** sur ce projet (cf. §3) : utiliser `gradlew` directement.
5. **Périmètre.** Un seul POC : pas de QoS, pas de TLS/WSS, pas de multi-process canonical Android (Cordova WebView). Performance et TRC restent à établir en production (cf. plan V1).

## 10. Stop conditions / décisions

- ✅ Qualification C2 complète sur les critères physiques définis (hors limites §9, documentées et racine prouvée).
- ❌ J04 ne reprend pas automatiquement : le verdict « C2 qualifié POC » est à intégrer par la revue humaine dans le plan V1 (J04 reste suspendu jusqu'à décision).
- ✅ Patch conservé pour usage POC ; toute intégration production passe par la revue humaine.
- ❌ Pas de bascule C3 : non requis (C2 répond aux critères).

## 11. Preuves et chemins

| Preuve | Chemin |
|---|---|
| Projet POC isolé | `tests/poc/websocket-server/c2-test/` |
| Patch + amont + PATCH.md | `tests/poc/websocket-server/evidence/c2/plugin/` |
| SHA-256 APK final + builds | `tests/poc/websocket-server/evidence/c2/build/` |
| Logs de run (run3→run6, rebind-repro, ring-payload, sustained) | `tests/poc/websocket-server/evidence/c2/run/` |
| Captures device (finales + pré-fix) | `tests/poc/websocket-server/evidence/c2/shots/` |
| Scripts CDP/harness (run-c2.sh, run-c2-ring.sh, run-c2-sustained.sh, rebind-repro.sh, cdp*.js) | `tests/poc/websocket-server/evidence/c2/cdp/` |
| Partie A — logs, scripts, captures (repli de port) | `tests/poc/websocket-server/evidence/c2/fb/` |
| Partie B — analyse origine production / options client | `tests/poc/websocket-server/PRODUCTION-INTEGRATION.md` (§13) |

---

## 12. Partie A — redémarrage immédiat par repli de port (fallback)

> Objet (revue humaine 21/09/2026) : qualifier un **redémarrage immédiat** du serveur WebSocket **sans patch natif** (`setReuseAddr` interdit), par scrutation séquentielle `base..base+window` côté JS. Application POC, pas de logique métier. Build `e6470947c8c5efa21a74503cb0ce0123697493739cd077c39064f3653be15782` (delta JS uniquement, plugin inchangé). Dossier : `evidence/c2/fb/`.

### 12.1 Mécanisme implémenté (POC app, JS uniquement)

`serverStartFallback()` (`www/js/app.js`) : base=`#server-port` (45102), window=`#fallback-window` (10 → 45102..45111). Pour chaque port : `wsserver.start(port, { onFailure })` avec **garde double-settled** (l'avancement se fait sur `onFailure` **ou** sur le callback d'échec de `start()`, une seule fois par port). Chaque tentative est horodatée (ms, `Date.now()`), la pile de choix est tracée en log (`FALLBACK attempt/busy/OK/summary`). Module d'auto-démarrage au boot (`c2autofb` en localStorage, checkbox `auto-fallback-boot`) — scenarii relance. Le port effectif est publié dans `#effective-port` (→ futur `PortService`/mDNS en production).

### 12.2 Résultats

| Scénario | Rôle | Verdict | Preuve |
|---|---|---|---|
| A1 — stop serveur normal (client B RACCORDÉ) + fallback immédiat | A+B | **PASS** | rebind base immédiat (45102, total 15–51 ms), B re-OPEN sur 45102 ; log `FALLBACK` complet dans `part-A.log` |
| A1' — stop serveur, 2 clients raccordés (B+C), rebind plain | A+B+C | **PASS** | rebind base immédiat (`listening on :45102`) + fallback 45102 (`part-A2-repro.log`) |
| A2 — force-stop app + relance (autofb boot) + raccord B | A+B | **PASS** | app redémarrée (CDP), autofb déclenché, **rebind base immédiat en 37 ms** (boot→listening ≈ 3.7 s incl. WebView), B OPEN sur 45102 |
| A3 — 6 cycles force-stop/relance rapides (~11 s/cycle, B raccordé entre cycles) | A+B | **PASS** | **toujours 45102** (aucune dérive de registre de ports ; la fenêtre n'est pas consommée) ; 45102 de nouveau boundable après 75 s |
| **Repli forcé — base occupée par un tiers (nc sur 45102)** | A+B | **PASS** | plain start → `FAILED: Address already in use` (symétrique run6) ; fallback → **45103 en 31 ms** (`attemptIdx=1`, busy via `onFailure:16ms`) ; B OPEN sur 45103 ; base libérée → retour sur 45102 en 15 ms (`part-A3-forced-advance.log`) |
| Preuve visuelle (fallback effectif sur 45103) | A | — | `evidence/c2/fb/shots/partA-effective-45103.png` |

### 12.3 Conclusion Partie A

- ✅ **Le fallback JS suffit** à rendre le redémarrage immédiat déterministe : si la base est libre → base (15–50 ms) ; si la base est occupée (TIME_WAIT résiduel, cas run6 C2-08/09) → bascule sur base+1 en ~31 ms, sans patch natif.
- ✅ **Aucune dérive de la fenêtre sur redémarrages répétés** : sur 6 cycles rapides, aucun port du registre n'est consommé de façon permanente (A3).
- ⚠️ **La fenêtre de 10 ports est conservative** : le port effectif après repli est 45102 ou 45103 (jamais au-delà sur nos essais). La production doit **publier le port effectif** (mDNS/`PortService`) plutôt que supposer 45102 fixe.
- ❌ Le mécanisme est JS et dépend du plugin (donc conservé pour usage POC uniquement) ; aucune décision production n'est prise ici — elle relève de la Partie B / revue humaine.

### 12.4 Relecture du défaut C2-08/09 à la lumière de la Partie A

Les essais A1/A1'/A2 (raccords réels, rebind immédiat) n'ont **pas** reproduit d'EADDRINUSE : le défaut run6 est rare et dépend de l'état TCP transitoire (accept-socket sur le port d'écoute en `TIME_WAIT` à l'instant du rebind — ce n'était pas reproductible à chaque fois, cf. `rebind-repro.sh`). Le repli de port **absorbe ce cas** de façon déterministe (preuve : repli forcé). Conclusion : pas de `setReuseAddr` requis pour la qualification POC ; la décision reste ouverte pour la production (Partie B).

---

## 13. Partie B — origine WebView / client WebSocket : analyse production

> Objet (revue humaine 21/09/2026) : la page Cordova par défaut est servie sur **`https://localhost`** ; un WebSocket **`ws://`** vers une IP LAN en part de cette origine est **rejeté mixed content**. Déterminer le réglage d'origine recommandé pour la production, **sans expérience physique supplémentaire** (les preuves POC suffisent). Analyse complète et justification : `PRODUCTION-INTEGRATION.md`.

### 13.1 Options éliminées (sources citées dans `PRODUCTION-INTEGRATION.md` §2)

| Option | Verdict | Preuve |
|---|---|---|
| 1. https://localhost + `ws://` LAN brut | **INVOABLE** | run4 : `SecurityError` au constructeur `new WebSocket('ws://…')` (`evidence/c2/run/base-C2-run4.log`) |
| 2. https://localhost + cleartext + `MIXED_CONTENT_ALWAYS_ALLOW` | **INVOABLE** | le mixed content WebSocket est une vérification **séparée** de la WebView (`MixedContentChecker::IsWebSocketsAllowed`, `websocket_common.cc`) — le flag ne couvre que les sous-ressources ; seul changement 2026 (issue 468027766/CL 7472421) = bypass **Local Network Access** de Chrome desktop (permission utilisateur), absent de WebView |
| 3. `wss://` + TLS serveur (Java-WebSocket 1.6.0 `SSLSocketFactory`) | ⚠️ possible, non retenu V1 | keystore + confiance d'un certificat auto-signé sur toute la flotte ; trafic LAN déjà en clair ; effort élevé |
| **4. `http://localhost` + `ws://` LAN brut** | ✅ **RECOMMANDÉE V1** | origine non-sécurisée → plus de mixed content ; **prouvé physiquement** (tout le POC C2 + Partie A tourne sur cette origine) |

### 13.2 Justification de la recommandation

- La production sert la page sur `http://localhost` (config `scheme=http`, `hostname=localhost`) : élimine tout mixed content pour `ws://` LAN.
- Impact « secure context » : aucune API éligible (crypto.subtle, geolocation…) n'est utilisée dans le JS production actuel (vérifié Partie B1) — impact nul.
- Prérequis production (à déclarer lors de l'intégration, **pas implémentés ici**) : `scheme`/`hostname` dans `app/config.xml`, CSP `connect-src 'self' ws: wss:`, flag cleartext sur `<application>` — cf. `PRODUCTION-INTEGRATION.md` §4.
- B3 (expérimentation physique discriminant) : **non exécuté, non nécessaire** — options 1/2/3 tranchées par recherche + preuves existantes (cf. `PRODUCTION-INTEGRATION.md` §3).

### 13.3 Décisions à rendre (revue humaine)

1. Valider l'option 4 (`http://localhost`) pour V1 — recommandation de la qualification.
2. Sinon constituer un dossier séparé pour l'option 3 (`wss://`), hors périmètre V1.