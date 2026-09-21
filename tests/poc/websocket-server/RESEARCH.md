# POC — Serveur WebSocket embarqué : recherche de solutions existantes (Phase 1)

> Date : 21 septembre 2026 — Statut : revue humaine requise, aucune installation ni test.
> Références vérifiées sur le dépôt amont / npm / Maven Central / GitHub Issues au moment de la rédaction.
> Contexte : `tests/poc/websocket-server/README.md`, `AGENTS.md`, `MULTICAM_DECISIONS_REFERENCE.md` §30.

---

## 1. Objet

Qualifier une brique **générique** de serveur WebSocket embarqué pour l'application Cordova Android MultiCam.
Périmètre de cette phase : recherche et comparaison **sourcée** de solutions existantes ; aucun code produit, aucun APK, aucune reprise de `rescue/j04-plugin-aborted`, aucun nouveau plugin.

Frontière d'architecture obligatoire : le composant natif ne connaît ni `session`, ni `Master`, ni `PIN`, ni `Take`, ni `Capture`, ni `Storage`.
Toute la logique métier/protocole MultiCam reste en JavaScript.

API native cible (équivalence conceptuelle) :

- `start(port)` / `stop()`
- `onOpen(client)` / `onMessage(client, payload)` / `onClose(client)`
- `send(clientId, payload)` / `broadcast(payload)`

Rappels de décisions MultiCam applicables (§30 du cahier de décisions) :

- transport applicatif de session = **WebSocket** (§30.5) ; pas de short-poll HTTP ;
- port de base session **45102**, fallback sur les ports suivants en cas d'occupation (§30.3) ;
- type DNS-SD session distinct `_multicam-session._tcp.` (§30.3) ; PIN jamais dans le TXT ;
- modèle **multi-Master à autorité équivalente** : chaque Master doit simultanément **héberger** son serveur WebSocket **et** jouer le rôle de **client** WebSocket vers les autres Masters (§30.5, §30.9) ;
- J04 ne doit pas introduire de plugin Cordova dédié aux sessions (§30.2) ;
- le serveur J03 `HealthServer` (HTTP `/health`) n'est pas un serveur de session (§30.2).

J04 suspendu pendant toute la qualification.

---

## 2. Candidats identifiés

### 2.1 C1 — `cordova-plugin-websocket-server` (becvert) — référence historique

- Dépôt amont : `https://github.com/becvert/cordova-plugin-websocket-server`
- Package npm : `cordova-plugin-websocket-server` — **dernière version 1.6.0** (publish npm 2020-04-19 ; dernière modification npm 2022-06-14 ; dernier commit GitHub 2020-04-19)
- Auteur : Sylvain Bréjeon. 84 étoiles, 19 issues ouvertes. Licence **MIT**.
- Android : plugin Java qui étend `org.java_websocket.server.WebSocketServer` (**Java-WebSocket** TooTallNate), épinglé `org.java-websocket:Java-WebSocket:1.4.0`, déclaré via `src/android/websocket-server.gradle` contenant :
  ```
  repositories { jcenter() }
  dependencies { implementation 'org.java-websocket:Java-WebSocket:1.4.0' }
  ```
  → **dépendance à `jcenter()`, dépôt supprimé/défunt** : blocage build probable en 2026 dans un Gradle moderne. Un patch minimal (remplacer `jcenter()` par `mavenCentral()`, l'artefact 1.4.0 existe bien sur Maven Central) est possible — l'équipe MultiCam a déjà l'habitude de patcher des plugins (`pixelcopy-patch`).
- Permissions Android : `INTERNET`, `ACCESS_WIFI_STATE` (ciblées via `AndroidManifest.xml`).
- API JS : `cordova.plugins.wsserver` → `start(port, opts, success, failure)`, `stop()`, `send(conn, msg)`, `close(conn, code, reason)`, `getInterfaces()`.
  - `start(port=0…)` : port 0 = port libre ; **bind `0.0.0.0`** (toutes interfaces).
  - événements dans `opts` : `onOpen(conn)`, `onMessage(conn, msg)`, `onClose(conn, code, reason, wasClean)`, `onFailure(addr, port, reason)` ; options `origins`, `protocols`, `tcpNoDelay`.
  - identifiant connexion : `conn.uuid` (généré côté natif, stable entre événements) ; `remoteAddr`, `httpFields`, `resource`.
- Plusieurs clients simultanés : oui (tables `uuid → WebSocket`).
- Binaire : oui, bidirectionnel — réception : message binaire → Base64 `is_binary:true` → `ArrayBuffer` côté JS (décode via `atob`) ; envoi : `TypedArray/ArrayBuffer` → Base64 → frame binaire (opcode 2).
- **Broadcast : NON fourni** en natif ; la couche JS du plugin conserve une map interne `connections[uuid]`, un composite côté application est donc trivial (itérer + `send`).
- Push/Pong/keepalive : gérés par la lib Java-WebSocket (`connectionLostTimeout`, défaut 60 s, ping automatique) — **non exposé/paramétrable** côté JS.
- Cycle de vie : « pas un service d'arrière-plan » — le serveur s'arrête quand la view Cordova est détruite/terminée (documenté README). `stop()` explicite. Pas d'option foreground.
- Issue ouverte pertinente **#79** (2021-11, toujours ouverte, mise à jour 2025-05) : « Not serving/connecting on Android 9 » — le serveur démarre (`onStart` appelé) mais reste injoignable, même depuis le même téléphone. Cause non résolue en amont → **test physique obligatoire**.
- Issue ouverte **#71** (2020) : « Android Webview can't open connection to ws://localhost » — la WebView ne peut pas ouvrir de WebSocket non sécurisé (`ws://`) → même-device client WS bloqué (politique cleartext, cf. §7).

### 2.2 C2 — `cordova-websocket-server` (raghu2x) — fork fraîchement maintenu de C1

- Dépôt : `https://github.com/raghu2x/cordova-websocket-server` (fork direct, créé 2026-03-31, derniers commits 2026-04-01)
- Package npm : `cordova-websocket-server` — **1.1.0** publié 2026-04-01 (0 dépendance npm, MIT)
- Auteur : Raghvendra Yadav (projet très jeune : 0 étoile, 0 issue, pas de CI de build).
- Android : code natif **identique à C1** (package renommé `net.becvert.cordova` → `cordova.wsserver`), mais le fichier gradle corrige les deux blocages :
  ```
  repositories { mavenCentral() }
  dependencies { implementation 'org.java-websocket:Java-WebSocket:1.6.0' }
  ```
  (`Java-WebSocket 1.6.0` = dernière version de la lib, MIT, release 2024-12-15, dépôt actif en 2026.)
- API JS : identique à C1 (`cordova.plugins.wsserver`).
- iOS : implémentation pure Swift `Network.framework` (hors périmètre Android).

→ Equivalent « fork/update » de C1, conforme aux consignes du README du POC (« ne pas reprendre l'implémentation J04 abandonnée » — il ne s'agit pas ici de cela).

### 2.3 C3 — `cordova-plugin-boogie-webserver` (boogie) — actif, HTTP + WebSocket

- Dépôt : `https://github.com/boogie/cordova-plugin-boogie-webserver` (créé 2026-07-18, dernier push **2026-09-04**)
- **Non publié sur npm** (registry → 404) : installation depuis le Git uniquement (`cordova plugin add https://github.com/boogie/cordova-plugin-boogie-webserver.git`).
- Version **1.5.0** (plugin.xml / package.json / `describe()`). Licence **MIT**. Auteur : András Bártházi (orga « boogie », hu.barthazi). `engines` : `cordova >= 9.0.0`.
- Origine : fork de `benkesmith-local-webserver` (ragcsalo) — l'historique git est conservé. **Le serveur WebSocket (NanoWSD) a été ajouté dans CE fork** ; l'original est HTTP-only.
- Android : **NanoHTTPD 2.3.1** (`org.nanohttpd:nanohttpd`) + **`org.nanohttpd:nanohttpd-websocket:2.3.1`** (NanoWSD), tirés de **Maven Central** (aucun jcenter). Nanos : libs pures Java « un fichier », très utilisées (≈7,2 k étoiles) mais **non maintenues** (2.3.1 : 2016/2018, dépôt sans release depuis ~2023, 201 issues ouvertes ; stable en pratique).
- **C'est d'abord un serveur HTTP** : `start()` démarre toujours NanoHTTPD (+ handler `onRequest`/`sendResponse`, routeur Express-like, service de fichiers statiques, endpoint santé `/__boogie/ping`, mDNS `_http._tcp`, hostname `.local`). Le WebSocket n'est activé que si `websocket:true`, sur un **port séparé `wsPort`** (défaut `port + 1`).
- WS natif (actions : `start`, `stop`, `isRunning`, `onWebSocketEvent`, `wsSend`, `wsBroadcast`, `wsClients`, `wsClose`, `describe`, `exec`) :
  - `onWebSocket({ open(client), message(client, data, {binary}), close(client, code, reason), error(msg) })`
  - `client` : `{ clientId, path, query, remoteAddress, send, close }`, identité stable entre événements (objet partagé côté JS).
  - envoi : `wsSend(clientId, data)` (objet → JSON.stringify), `wsBroadcast(data)` (résout le nombre de clients atteints), `wsClose(clientId, code, reason)` ; listing `wsClients()`.
  - réception binaire : Base64 + `binary:true`. **Envoi binaire : NON supporté** (uniquement chaîne/JSON → frame texte). Alternative MultiCam : frames texte encodées en Base64 pour les snapshots.
  - **keepalive natif : ping WS toutes les 3 s** (`WS_PING_INTERVAL_MS = 3000`) — pas de heartbeat applicatif obligatoire côté native.
- Option `foreground` : **service foreground Android `dataSync`** (persistent la notification), pour survivre à la mise en arrière-plan (Android 12+ gèle les processus cachés). Permissions ajoutées : `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`, `POST_NOTIFICATIONS`, `CHANGE_WIFI_MULTICAST_STATE`, + déclaration `<service>`. Restrictions : Android 12+ refuse un foreground service lancé depuis l'arrière-plan ; Android 13+ besoin de la permission runtime notification.
- Réseau/découverte : mDNS `_http._tcp` (NsdManager) + répondant `.local` maison. **À laisser désactivé** pour MultiCam (découverte = plugin NSD J04/J03, type `_multicam-session._tcp.`).
- Cycle de vie : `onReset` (navigation/reload WebView) **arrête le serveur** — en pratique : app SPA mono-page, ou relancer `start()` à chaque page. `onDestroy` arrête aussi.

### 2.4 C4 — `cordova-plugin-wsserver` (limaagabriel) — inadapté

- Dépôt : `https://github.com/limaagabriel/cordova-plugin-wsserver` (créé et dernière activité **2018-04**, 0 étoile, **pas de licence**).
- Android : handler maison basé sur `org.java-websocket:Java-WebSocket:1.3.8` (déclaration `framework` à l'ancienne, époque jcenter/Gradle 3.x).
- API : `start/stop/onConnection/onDisconnection/onMessage/onError/broadcast(message)/send(client.id, message)`. **Binaire non supporté** (bin → `ByteBuffer.toString()`, perte de données). Texte seulement.
- Verdict : **inutilisable** (mort depuis 8 ans, déjà hérité, pas de licence, binaire corrompu, format plugin pré-Cordova-9).

### 2.5 Références contextuelles (hors candidats directs)

| Référence | Rôle | Pourquoi ce n'est pas un candidat |
|---|---|---|
| `knowledgecode/cordova-plugin-websocket` (WebSocket-for-Android, ~2013-2016) | **client** WebSocket (polyfill Jetty) pour anciennes WebView | C'est un CLIENT, pas un serveur. Hors sujet (la WebView moderne a `new WebSocket()`). |
| `cjmamo/Java-WebSocket` (~2012) | ancêtre PhoneGap de Java-WebSocket (ServerSocketChannel) | Dépassé par `TooTallNate/Java-WebSocket`, actif. |
| `TooTallNate/Java-WebSocket` | lib serveur+client RFC6455 (pure Java), v1.6.0 MIT, actif | C'est la lib interne de C1/C2 ; nécessiterait un petit wrapper plugin = hors périmètre Phase 1. |
| `NanoHttpd/nanohttpd` + `nanohttpd-websocket` (NanoWSD) | libs serveur HTTP/WS pures Java, 2.3.1 | Lib interne de C3 ; wrapper plugin nécessaire = hors périmètre Phase 1. |
| `nstudio/nativescript-web-server` | serveur WS natif Android complet (broadcast, ping/pong, statut, AsyncTasks) | Plugin **NativeScript**, pas Cordova ; non réutilisable sans rempaquetage. |
| `fengzhizi715/AndroidServer` (Kotlin+Netty), Ktor-Netty | serveurs HTTP/TCP/WS embarqués pour Android | Bibliothèques, pas plugins Cordova ; wrapper maison nécessaire. |
| `ragcsalo/benkesmith-local-webserver`, `ragcsalo/cordova-plugin-webserver`, `bykof/cordova-plugin-webserver` | serveurs HTTP embarqués Cordova (requestId/respond) | HTTP-only (source de C3 pour la partie HTTP). Pas de WebSocket server. |

---

## 3. Tableau comparatif factuel (au 21/09/2026)

| Critère | C1 becvert `cordova-plugin-websocket-server` | C2 raghu2x `cordova-websocket-server` | C3 boogie `cordova-plugin-boogie-webserver` |
|---|---|---|---|
| Dernière version | 1.6.0 | 1.1.0 | 1.5.0 |
| Dernière maintenance significative | 2020-04-19 (code) ; 2022-06-14 (métadonnée npm) | **2026-04-01** (fork fraîchement créé) | **2026-09-04** (push) |
| Dépôt amont | becvert/cordova-plugin-websocket-server (84★) | raghu2x/cordova-websocket-server (0★, 0 issue) | boogie/cordova-plugin-boogie-webserver (0★) |
| Package npm | `cordova-plugin-websocket-server@1.6.0` | `cordova-websocket-server@1.1.0` | **absent** (install Git) |
| License | MIT | MIT | MIT |
| Android | oui (Java-WebSocket 1.4.0) | oui (Java-WebSocket **1.6.0**) | oui (NanoHTTPD 2.3.1 + NanoWSD 2.3.1) |
| iOS | oui (PocketSocket) | oui (Swift Network.framework) | oui (GCDWebServer + PocketSocket) — hors périmètre |
| Android moderne (minSdk 24 / Gradle 8 / AGP 8) | ⚠️ **jcenter()** → risque d'échec de résolution ; patch requis | ✅ mavenCentral ; à prouver (pas de CI) | ✅ mavenCentral (NanoHTTPD 2018 non maintenu) |
| min/target SDK imposés | non | non | non (ajoute perms/`<service>` foreground — mineur) |
| Vrai serveur WebSocket entrant | ✅ | ✅ | ✅ (via NanoWSD) |
| Bind LAN 0.0.0.0 | ✅ | ✅ | ✅ (NanoHTTPD wildcard) |
| `start(port)` / port 0 libre | ✅ (port 0 = libre, fallback = boucle JS) | idem | ✅ (rejette si port pris) |
| `stop()` | ✅ | ✅ | ✅ idempotent |
| `onOpen(client)` | ✅ `conn.uuid`, remoteAddr, httpFields, resource | idem | ✅ clientId, path, query, remoteAddress |
| `onMessage(client, payload)` | ✅ text + `ArrayBuffer` binaire | idem | ✅ text ; binaire reçu = Base64+flag |
| `onClose(client)` | ✅ (code, reason, wasClean) | idem | ✅ (code, reason) |
| `send(clientId, payload)` | ✅ text/binaire | idem | ✅ texte/JSON (binaire sortant ❌) |
| `broadcast(payload)` | ❌ natif (composite JS possible) | idem | ✅ natif (`wsBroadcast`) |
| Plusieurs clients simultanés | ✅ | ✅ | ✅ |
| Identifiants de connexion | uuid (stable) | uuid | clientId uuid (stable, objet partagé) |
| Binaire entrant | ✅ | ✅ | ✅ (Base64) |
| Binaire sortant | ✅ | ✅ | ❌ |
| Ping/pong / keepalive | ping auto 60 s (lib, non réglable) | idem | **ping natif 3 s** |
| Cycle de vie | lié à la WebView ; pas de background | idem | idem + **option foreground service** |
| Restart/rebind | issue #82 (reuseAddr) | idem | géré (arrêt propre) |
| Couplage HTTP | ❌ (pur WebSocket) | ❌ | ✅ **couplé HTTP** (2 ports, routeur, statique, mDNS…) |
| Couplage à du métier MultiCam | non (générique) | non | non (générique) |

---

## 4. Références sources

- npm : `https://registry.npmjs.org/cordova-plugin-websocket-server` (time=…, dist-tags latest=1.6.0), `…/cordova-websocket-server` (dist-tags latest=1.1.0)
- GitHub : `becvert/cordova-plugin-websocket-server` (plugin.xml, `src/android/WebSocketServerImpl.java`, `src/android/websocket-server.gradle`, CHANGELOG.md) ; `raghu2x/cordova-websocket-server` (mêmes fichiers, branche `main`) ; `boogie/cordova-plugin-boogie-webserver` (plugin.xml, `src/android/WebserverPlugin.java`, `www/webserver.js`, docs/api-design.md, README.md)
- Maven Central : `org.java-websocket:Java-WebSocket` (1.4.0…1.6.0 présents ; latest 1.6.0), `org.nanohttpd:nanohttpd`/`nanohttpd-websocket` (latest 2.3.1)
- GitHub Releases : `TooTallNate/Java-WebSocket` v1.6.0 (2024-12-15)
- cordova-android 15.0.0 announcement: minSdk 24, targetSdk 36, Gradle 8.14.2, AGP 8.10.1, JDK 17 (`https://cordova.apache.org/announcements/2026/03/06/cordova-android-15.0.0.html`)
- Issues becvert : #57 (buildToolsVersion), #71 (ws:// WebView blocked), #77 (reste ouvert après fermeture app), #79 (Android 9 injoignable), #82 (reuseAddr)

Vérifications effectuées : contenu réel des deux fichiers Java Android de C1 et de la copie de C2 (diff : seul le package change), `websocket-server.gradle` et `plugin.xml` de C1/C2, source Java + JS bridge de C3, registry npm, Maven Search, GitHub API.

---

## 5. Évaluation maintenance / compatibilité

**C1 (becvert)** — mature mais en dormance depuis avril 2020.
- Compatibilité Cordova : format moderne du plugin (clobber + `gradleReference`), conçu pour Cordova ≥3 ; compilé historiquement en AGP 3.x. Le point bloquant moderne est **`repositories { jcenter() }`**.
- Les issues #79 (injoignable sur certains Android, ex. 9), #71 (WebView `ws://` bloqué), #82 (restart/reuse), #77 (vie après fermeture) restent **ouvertes** — aucune correction en amont.
- Verdict : **réutilisable techniquement, mais pas « as-is »** en 2026 → **fork/update** (C2 en est exactement un, ou patch local du fichier gradle, pratique déjà usitée dans ce projet via `pixelcopy-patch`).

**C2 (raghu2x)** — code de C1 + les deux seuls correctifs réellement nécessaires (mavenCentral, Java-WebSocket 1.6.0).
- Compatibilité : lib détachée, pur Java, compatible minSdk 24 / targetSdk 36 / Gradle 8 ; compile non démontrée publiquement (pas de CI, produit seul).
- Verdict : **fork/update de C1, à qualifier physiquement** ; risque = validation communautaire quasi nulle et zéro preuve de build AGP 8 (à lever en Phase 3).

**C3 (boogie)** — actif (septembre 2026), Promise API propre, service foreground, keepalive 3 s, broadcast natif.
- Compatibilité : `engines cordova >= 9`, Maven Central ; Nanos vieillissantes mais stables/prévues.
- Verdict : **réutilisable tel quel** côté WebSocket, mais **couplage HTTP** (2 ports) et **absence d'envoi binaire** → friction d'architecture à arbitrer (§6-§7).

**C4** — **inutilisable** (§2.4).

---

## 6. Comparaison API / capacités vs frontière requise

| Capacité requise (générique) | C1 | C2 | C3 | Commentaire |
|---|---|---|---|---|
| `start(port)` | ✅ | ✅ | ⚠️ (démarre aussi HTTP ; `websocket:true` + `wsPort`) | C1/C2 : port 0 = libre ; C3 : rejette si pris |
| `stop()` | ✅ | ✅ | ✅ | C3 idempotent (503 aux requêtes pendantes) |
| `onOpen(client)` | ✅ | ✅ | ✅ | |
| `onMessage(client, payload)` | ✅ | ✅ | ✅ | binaire : C1/C2 ArrayBuffer ; C3 Base64+flag |
| `onClose(client)` | ✅ | ✅ | ✅ | |
| `send(clientId, payload)` | ✅ | ✅ | ⚠️ texte/JSON only | snapshots JPEG → Base64 texte (faisable) |
| `broadcast(payload)` | ❌→JS | ❌→JS | ✅ natif | composite JS trivial pour C1/C2 |
| pas de concept métier multiCam dans le natif | ✅ | ✅ | ✅ | tous génériques |
| maître unique : filtrage par uuid/clientId côté application | ✅ | ✅ | ✅ | |

En synthèse : **C1/C2 et C3 satisfont tous la frontière d'architecture** (natif générique). C1/C2 sont le plus proches du besoin « pur serveur WS » ; C3 apporte du confort natif (broadcast, keepalive, foreground) au prix du couplage HTTP.

---

## 7. Question architecturale : héberger ET être client WebSocket

Conclusion **documentaire** : oui, sur le même device, sans conflit Android, un même processus Cordova peut :

1. **héberger** le serveur WebSocket natif (bind `0.0.0.0:<port>`, socket en écoute → trafic *entrant*) ;
2. **jouer le rôle de client** via la WebView standard `new WebSocket("ws://<ip>:<port>")` (socket *sortant*, connexion TCP indépendante).

Raisons factuelles :

- Sous Android, rien n'interdit à un processus d'écouter (datagramme/flux entrant) et de se connecter simultanément (flux sortant) : sockets totalement indépendants de l'OS. Les téléphones civils Desktop/Android font « client + serveur » en permanence.
- La WebView Android (Chromium System WebView, présente depuis Android 4.4+) expose la WebSocket API **client** conforme RFC 6455 — c'est la base même de la décision §30.5.
- Le serveur **entrant** n'est pas soumis à la politique « cleartext » : celle-ci ne s'applique qu'aux piles réseau *sortantes* de l'app (HTTPClient/OkHttp/WebView). La poignée de main WS entrante est du TCP brut accepté par un `ServerSocket` côté natif.
- Piège documenté (issue becvert #71, et comportement Android 9+) : la WebView **client** ne peut pas ouvrir `ws://` si l'application n'autorise pas le trafic en clair. Pour une cible `targetSdk ≥ 28`, il faut activer `android:usesCleartextTraffic="true"` (ou une `NetworkSecurityConfig` ciblant le LAN) dans `config.xml`. C'est un réglage **d'application**, indépendant du plugin choisi, et requis de toute façon par l'architecture « ws:// sur LAN de confiance » (cf. §30.6 ; le PIN utilisé en clair est déjà une limitation documentée).
- Le même device n'a pas besoin de se connecter à **lui-même** (chaque Master est sur un téléphone distinct), donc pas de cas « loopback même-app » à qualifier en priorité — mais l'issue #71 montre qu'il faudra quand même prouver le client ws:// sur appareil réel.

→ **A valider physiquement en Phase 3** : coexistence sur un même phone, connectivité croisée bidirectionnelle entre 2 devices, et latence/throughput des frames (snapshots).

---

## 8. Risques identifiés

| # | Risque | Où | Impact | Mitigation |
|---|---|---|---|---|
| R1 | `jcenter()` défunt → échec de résolution de Java-WebSocket au build | C1 | Bloquant build (2026) | utiliser C2 (mavenCentral) ou patch gradle local (premier build du lab), ou `gradle.force` repo |
| R2 | Serveur démarre mais `injoignable` sur certains Android (issue #79) | C1/C2 | Bloquerait le POC physique | Physique : vérifier connectivité externe (autre device), pas seulement port local |
| R3 | WebView client `ws://` bloquée (cleartext, issue #71) | tous | Client WebSocket impossible sans réglage | activer `usesCleartextTraffic`/NSC dans l'app ; physique |
| R4 | Pas de broadcast natif C1/C2 | C1/C2 | broadcast = composite JS | trivial (itérer `connections`) |
| R5 | Aucune preuve de build AGP 8 / java-websocket 1.6 pour C2 | C2 | erreur compile possible | qualifier en Phase 3 (compile + run) |
| R6 | Couplage HTTP (2 ports, routeur, statique, mDNS, foreground) inutilisé | C3 | surface native et permissions plus larges ; conflit potentiel port/fallback §30.3 | architecture : wsPort explicite (=45102) et HTTP sur port secondaire ; ou rejeter C3 |
| R7 | Envoi binaire sortant absent (snapshots JPEG) | C3 | besoin de frames texte Base64 (~+33 %) | acceptable sur LAN ; validé en POC |
| R8 | Cycle de vie : serveur lié à la WebView (C1/C2) ; `onReset` arrête le serveur (C3) | tous | session interrompue après reload/navigation | app SPA + relaunch `start()` ; décision §30.7 (le cycle réseau ne doit pas dépendre de l'écran) |
| R9 | Pas de persistance en arrière-plan (Android 12+ gèle les processus cachés) sans foreground service | C1/C2 | Master « session en cours » injoignable en arrière-plan | app reste au premier plan en tournage (insomnia) ; option foreground de C3 si besoin futur |
| R10 | Maintien de vie : ping 60 s (C1/C2) vs 3 s (C3) | C1/C2 | détection de mort de peer plus lente | le heartbeat applicatif MultiCam (§30.4) domine le ping WS ; à régler en POC |
| R11 | Limites de taille de frame (snapshots) et latence | tous | message > limite éventuelle, jitter | à mesurer en POC (pertinent : ~50-150 Ko JPEG) |
| R12 | Fichier gradle C1 : `implementation` vs anciens AGP (issue #57) | C1 | erreur historique Gradle < 3.3 | non pertinent en 2026 (AGP 8) ; verrouillé par la Q R1 |

---

## 9. Recommandations pour le POC physique (Phase 2/3)

Recommandé (revue humaine requise) :

1. **Candidat principal : C2 (`cordova-websocket-server` 1.1.0, raghu2x)** — le seul plugin « pur serveur WebSocket » immédiatement buildable en 2026 (mavenCentral + Java-WebSocket 1.6.0), API clef-en-main répondant à toute la frontière générique (dont binaire entrant/sortant), licences MIT, sans couplage HTTP. Faible maturité → exactement ce qu'un POC physique doit prouver (build AGP 8, runtime Android 13, connectivité externe, issues #79/#71).
2. **Candidat de comparaison : C3 (`cordova-plugin-boogie-webserver` 1.5.0, install Git)** — pour juger du confort natif (broadcast, keepalive 3 s, foreground service) et décider si le couplage HTTP + absence d'envoi binaire sont acceptables. Utile aussi comme « plan B » actif si C2 échoue au build.
3. C1 : ne pas tester en l'état (jcenter) — sa valeur est d'être la base de C2.

Préconisations de Configuration pour la Phase 3 (à entériner à la revue) :
- port de session 45102 + fallback (boucle JS `start` → succès ou erreur → port suivant), conforme §30.3 ;
- `android:usesCleartextTraffic="true"` **au niveau application** (requis pour le client WebSocket `ws://`), cf. §7 ;
- ne pas utiliser l'advertise mDNS de C3 (découverte = NSD J04/J03, `_multicam-session._tcp.`) ;
- app SPA pour éviter le stop serveur sur reload (R8).

---

## 10. Verdict par candidat

| Candidat | Verdict |
|---|---|
| C1 becvert | **fork/update requis** (jcenter) ; ne pas utiliser as-is |
| C2 raghu2x | **à qualifier en POC** (use-as-is espéré, fork d'emblée si issue au build) |
| C3 boogie | **réutilisable tel quel** côté WS, si couplage HTTP accepté (sinon écarter) |
| C4 limaagabriel | **inutilisable** |