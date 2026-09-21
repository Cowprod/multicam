# POC — PRODUCTION-INTEGRATION.md — Décisions de qualification pour l'intégration MultiCam

> Statut : **document proposé à la revue humaine** — 21 septembre 2026.
> Ce document est **uniquement une analyse et des recommandations** : aucune implémentation ne doit en découler avant validation.
> Provenance : qualification POC C2 (`VALIDATION.md`) + Partie A (repli de port) + Partie B (origine/WebSocket client).
> Convention : document rédigé en français (documentation projet), noms techniques en anglais.

---

## 0. Objet et périmètre

Deux questions architecturales restaient ouvertes en sortie de qualification C2 :

- **Partie A** — le redémarrage **immédiat** du serveur WebSocket natif (rebind même port après stop / force-stop) échoue rarement (`EADDRINUSE`, TCP `TIME_WAIT` — voir `VALIDATION.md` §9.1) ; une solution JS sans patch natif a été qualifiée.
- **Partie B** — quelle **origine WebView** et quelle **combinaison de sécurité** doivent être retenues pour le **client** WebSocket standard en production (l'origine par défaut `https://localhost` rejette `ws://` LAN).

Ce document consolide les résultats et propose une trajectoire d'intégration. **Aucun code n'est fourni ni modifié ici.**

Rappel : les `app/platforms/android/…` sont des fichiers **générés**. Les préférences cleartext / `MIXED_CONTENT_ALWAYS_ALLOW` constatées à cet endroit pendant la Partie B1 sont absentes des fichiers versionnés (`app/config.xml`, `app/local-plugins/cordova-plugin-multicam-platform/…`) ; un `cordova prepare` les effacerait. **Aucune décision ne doit s'appuyer sur des fichiers générés.**

---

## 1. Partie A — redémarrage immédiat par repli de port (verdict : suffisant, sans patch natif)

Résumé de qualification (`VALIDATION.md` §12, preuves `evidence/c2/fb/`) :

| Scénario | Verdict | Fait marquant |
|---|---|---|
| A1 — stop serveur normal + rebind (client raccordé) | PASS | rebind base 45102 en 15–51 ms ; clients re-OPEN |
| A1' — 2 clients raccordés, rebind plain | PASS | rebind base OK (le défaut run6 est rare/non déterministe) |
| A2 — force-stop + relance (auto-démarrage au boot) | PASS | rebind base en 37 ms depuis le fallback |
| A3 — 6 cycles force-stop/relance | PASS | toujours 45102 ; la fenêtre de repli n'est jamais consommée |
| Repli forcé — base occupée par un tiers | PASS | bascule sur base+1 en ~31 ms ; retour sur la base dès qu'elle est libérée |

**Conclusion :** un repli de port **côté JS** rend le redémarrage immédiat déterministe sans toucher au plugin ni à Java-WebSocket (`setReuseAddr` non requis pour la qualification POC).

**Conséquences production :**

1. Le serveur Java-WebSocket doit être démarré à travers le même mécanisme de scrutation `base..base+window` **côté application** (logique JS, dans `transport`/serveur), en **réutilisant l'échec de `start()` comme signal** (l'événement `onFailure` n'est pas fiable — `VALIDATION.md` §9.2).
2. **Le port effectif doit être publié** (mDNS/`PortService`) — jamais supposer que 45102 est fixe après un repli.
3. Base recommandée : 45102, fenêtre explorée au démarrage pour couvrir l'absence de `SO_REUSEADDR`/`SO_REUSEPORT` sur l'écoute.
4. Le repli couvre aussi le cas rare C2-08/09 (`TIME_WAIT` transitoire) : pas de changement natif requis.

---

## 2. Partie B — origine WebView / client WebSocket (options)

### 2.1 Rappel du contexte

- Cordova Android sert la page par défaut sur **`https://localhost`** (schéma par défaut, sans `scheme`/`hostname` dans `app/config.xml` — vérifié).
- Le client WebSocket **standard** de la WebView veut se connecter en **`ws://<IP LAN>`** à un serveur C2/JWS sur le device distant.
- Un WebSocket **`ws://`** initié depuis une origine **https** est refusé (mixed content) ; `wss://` exige du TLS côté serveur **et** de la confiance de certificat côté WebView.
- La **CSP** de production actuelle n'a pas de `connect-src` explicite : elle bloque déjà `ws:`/`http:` (le blocage CSP fut la cause du run3 du POC ; fixé dans le POC par `connect-src 'self' ws: wss:`).

### 2.2 Options étudiées (Partie B2 — recherche, pas d'expérience physique sauf mention)

#### Option 1 — rester en `https://localhost` + `ws://` LAN brut (CSP `connect-src ws:`)

**INVOABLE.** Le constructeur `new WebSocket('ws://192.168.92.x')` depuis `https://localhost` lève une `SecurityError` (« An insecure WebSocket connection may not be initiated from a page loaded over HTTPS »). Prouvé physiquement au run4 du POC (`evidence/c2/run/base-C2-run4.log`). Comportement requis par la spécification WebSocket (les énumérations WebSocket doivent être « permitted » — origine https → refus d'un endpoint non chiffré).

#### Option 2 — `https://localhost` + cleartext + `MIXED_CONTENT_ALWAYS_ALLOW`

**INVOABLE.** La préférence WebView `MIXED_CONTENT_ALWAYS_ALLOW` ne couvre **que le mixed content « subresource »** (fetch/img/script/…). Le mixed content **WebSocket** est une **vérification séparée** dans Chromium : `websocket_common.cc` → `web_socket_channel_impl.cc` → `MixedContentChecker::IsWebSocketsAllowed`, indépendante du mode de mixed content de la WebView. Sources :

- spécification WebSocket (W3C) : le constructeur rejette les endpoints non sécurisés depuis une origine sécurisée — pas de contournement par réglage navigateur.
- Chromium, issue 40091652 « Do not allow mixed-content WebSockets » (décision de politique) ; `MixedContentChecker::ShouldBlock…`/`IsWebSocketsAllowed` dans `content/browser/renderer_host/mixed_content_checker.cc` (chargé à HEAD, 2026 — les fonctions relatives au WebSocket ne lisent aucun `allow mixed content`).
- Seul changement WebSocket/mixed-content récent : Chromium issue 468027766 + CL 7472421 (fix « Local Network Access » — janv. 2026) : il contourne le mixed content `ws://` **uniquement quand la requête est un « LNA request » autorisé par l'utilisateur via le flux de permission de Chrome desktop**. Ce flux n'existe **pas** dans Android WebView (Cordova) ; de plus le correctif ne fonctionnait pas encore en Chrome Canary 146 (févr. 2026, commentaire #4 de l'issue).

→ Aucun réglage WebView ne rend `ws://` LAN admissible depuis `https://localhost`.

#### Option 3 — `wss://` vers le serveur Java-WebSocket (TLS côté serveur)

**Techniquement faisable, déconseillée pour V1.**

- Côté serveur : Java-WebSocket 1.6.0 accepte une `SSLSocketFactory` ; un keystore auto-signé devrait être généré côté serveur (clés + rotation, dans un composant dédié).
- Côté WebView/certificat : un certificat **auto-signé** est rejeté par la WebView (l'implémentation `onReceivedSslError` par défaut de Cordova bloque). Contournements : installer le CA sur chaque device (hors déploiement LAN, pas faisable), ou détourner le flux SSL (hors standard, fragile), ou fournir un certificat auto-signé « de confiance » via Network Security Config (souffre du même reproche).
- Coût : nouveau composant TLS serveur (génération/rotation de clés), gestion de confiance client, delta de déploiement important pour un réseau LAN privé dont le trafic (contrôle + JPEG ~1 fps) est déjà en clair sur TCP.
- Gardé en réserve comme **durcissement possible post-V1** (si l'analyse de menace évolue : réseau non fiable, interception hors LAN, etc.).

#### Option 4 — servir la page en **`http://localhost`** + `ws://` LAN brut — **RECOMMANDÉE pour V1**

**Prouvée physiquement** : c'est l'origine du POC C2 (`config.xml` → `scheme=http`, `hostname=localhost`). Toute la suite C2-01→C2-12 et la Partie A (repli de port) ont été validées avec ce réglage ; zéro impact sur l'infrastructure WebSocket entrante.

- Le POC sert ainsi la page dans une origine **non-sécurisée** (« not a secure context ») : le client WebView n'est alors **plus soumis au mixed content** pour `ws://` LAN.
- Impact « secure context » : les API éligibles (crypto.subtle, geolocation, Clipboard API, …) sont indisponibles. **Vérifié en Partie B1** : le JS production actuel n'utilise aucune de ces API — impact nul à ce stade.
- Prérequis à déclarer (quand l'intégration sera décidée) : `scheme=http` + `hostname=localhost` dans `app/config.xml` (fichiers **versionnés**), CSP `connect-src 'self' ws: wss:`, et flag cleartext sur `<application>` (le tout = ce que le hook/delta du POC fait déjà — aucun changement de plugin, aucun changement du C2 qualifié).

### 2.3 Tableau récapitulatif

| Option | Origine | Transport client | Verdict | Effort | Pour/contre |
|---|---|---|---|---|---|
| 1 | https://localhost | ws:// LAN | ❌ rejeté au ctor | — | comportement navigateur, non contournable |
| 2 | https://localhost | ws:// LAN + ALWAYS_ALLOW | ❌ ne couvre pas WebSockets | — | vérification séparée (IsWebSocketsAllowed) |
| 3 | https://localhost | wss:// LAN (TLS) | ⚠️ faisable, non retenu V1 | élevé | plus sûr, mais keystore + confiance de certificat sur la flotte + hors LAN fiable |
| **4** | **http://localhost** | **ws:// LAN brut** | ✅ **prouvé (POC + Partie A)** | **faible** | conforme au POC ; pas d'API secure-context utilisée ; le plus simple | 

### 2.4 Décision à rendre (revue humaine)

1. **Valider l'option 4 (http://localhost)** pour V1 — la recommandation de ce document.
2. Sinon **option 3 (wss://)** = dossier séparé (TLS serveur + distribution de confiance), hors périmètre V1.

---

## 3. B3 — expérience physique discriminant

**Non exécuté, non nécessaire.** Les options 1 et 2 sont tranchées par la recherche (spécification + source Chromium + issues 40091652/468027766) **et** par la preuve physique du run4 (échec ctor). L'option 3 est tranchée par lecture de l'implémentation (Java-WebSocket `SSLSocketFactory` + politique SSL par défaut de Cordova). Aucun scénario n'aurait apporté d'information supplémentaire ; une manipulation supplémentaire sur l'app POC aurait été redondante.

---

## 4. Éléments à intégrer lors de l'intégration (listes, sans implémentation)

Quand la revue humaine aura statué, l'intégration dans `app/` devra au minimum :

1. **Souscription** : `transport.js` (ou équivalent) développe le serveur avec la scrutation de repli de port (base 45102, fenêtre) et **publication du port effectif** (mDNS/`PortService`).
2. **Origine** : `app/config.xml` → `scheme=http`, `hostname=localhost` (+ justification en commentaire, comme le fait le POC).
3. **CSP** : confirmer diriger `connect-src 'self' ws: wss:` (et, si besoin, les destinations du futur mDNS/HTTP).
4. **Cleartext** : le flag `<application android:usesCleartextTraffic>` doit être appliqué **via les fichiers versionnés** (préférence Cordova native ou hook versionné), jamais laissé à un fichier généré.
5. **Relecture** : aucun bout de la logique POC Partie A ne doit être repris tel quel si l'approche production diffère (le POC est une qualification, pas une base de code).

---

## 5. Sources

- Spécification : « The WebSocket API » W3C — exigences de connexion / sécurité des endpoints.
- Chromium : `content/browser/renderer_host/mixed_content_checker.cc` (HEAD, lu le 21/09/2026) ; issues 40091652 (politique mixed-content WS) et 468027766 + CL 7472421 (janv. 2026, bypass LNA — Chrome desktop, pas WebView).
- POC : `evidence/c2/run/base-C2-run4.log` (échec ctor), `VALIDATION.md` §5/§9.3/§12, `c2-test/config.xml:21-30`.
- Partie B1 (drift versionné vs généré) : relève documentaire effectuée le 21/09/2026 — fichiers générés non versionnés (`app/platforms/android/…`) vs versionnés (`app/config.xml`, `app/local-plugins/…`).