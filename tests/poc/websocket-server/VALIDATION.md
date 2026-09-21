# POC — Qualification physique C2 (`cordova-websocket-server@1.1.0`)

> Statut : **BLOQUÉ au build — C2 ne compile pas sans modification du plugin.**
> Conforme au « stop condition » : aucun APK, aucun test physique, aucun patch/fork de plugin, pas de bascule C3.
> Date : 21 septembre 2026. Décision finale en attente de revue humaine.

---

## 1. Objet

Prouver physiquement que C2 (`raghu2x/cordova-websocket-server@1.1.0`) peut fournir l'infrastructure WebSocket générique requise par MultiCam (serveur entrant natif + client WebView standard) sur les devices Android du projet.

Application de test isolée : `tests/poc/websocket-server/c2-test/`. Aucune logique métier MultiCam.

## 2. Résultat global

| Vérification | Résultat |
|---|---|
| Build Android sans modification du plugin | **FAIL** (erreur de compilation, cf. §4) |
| Installation sur devices physiques | **NOT TESTED** |
| C2-01 → C2-12 | **NOT TESTED** |
| Frames 50/100/150 Ko | **NOT TESTED** |
| Client WebView standard | **NOT TESTED** |

Aucun PASS n'est inféré malgré l'entretien « en état » du C2 (cf. §6 a pu être préparé ; rien n'a été prouvé sur device).

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

## 4. Erreur de build exacte

Fichier : `platforms/android/app/src/main/java/cordova/wsserver/WebSocketServerPlugin.java`, ligne 55.

```java
@Override
public void onDestroy() {
    super.onDestroy();
    if (wsserver != null) {
        try {
            wsserver.stop();
        } catch (IOException e) {          // ← ligne 55 : erreur
            Log.e(TAG, e.getMessage(), e);
        } catch (InterruptedException e) {
            Log.e(TAG, e.getMessage(), e);
        } finally {
            wsserver = null;
        }
    }
}
```

Message du compilateur (`:app:compileDebugJavaWithJavac`) :

```
WebSocketServerPlugin.java:55: error: exception IOException is never thrown in body of corresponding try statement
       } catch (IOException e) {
```

**Cause racine démontrée :** en Java-WebSocket **1.6.0**, `org.java_websocket.server.WebSocketServer.stop()` ne déclare plus `throws IOException` (vérifié par `javap` sur le jar résolu) :

```
public void stop(int) throws java.lang.InterruptedException;
public void stop(int, java.lang.String) throws java.lang.InterruptedException;
public void stop() throws java.lang.InterruptedException;
```

Le code du plugin (hérité de becvert, inchangé dans ce fork) a été écrit pour Java-WebSocket ≤ 1.4/1.5.x où `stop()` déclarait `throws IOException, InterruptedException`. Le fork `raghu2x` a monté la dépendance à 1.6.0 sans adapter ce `catch`, ce qui est un **catch mort** refusé par javac.

Notes au build (non bloquantes, pour témoignage) : « uses or overrides a deprecated API », « unchecked or unsafe operations ».

Log complet : `evidence/c2/build/build-failure-C2.log`.

## 5. Stop conditions / décisions

- ❌ **Ne pas patcher/forker le plugin** sans revue humaine (conforme consigne).
- ❌ **Ne pas basculer sur C3** sans revue humaine.
- ❌ Pas de reprise de `rescue/j04-plugin-aborted`.
- ✅ J04 reste suspendu ; son statut n'est PAS passé à PASS.
- ❌ Aucun APK produit → **pas de SHA-256 APK à rapporter**.

## 6. Travail préparé mais non testé (à réutiliser en Phase 3 après décision)

L'application `c2-test` est complète côté JS/UI et prête pour les tests physiques :

- serveur C2 : `start(port)` avec port 0 libre, `stop()`, `send(conn, msg)`, callbacks onOpen/onMessage/onClose/onFailure, `getInterfaces()` ;
- client : **uniquement** `new WebSocket("ws://<ip>:<port>")` (WebView standard) ;
- messages JSON de test avec intégrité `len` + `crc32` (texte et binaire) ;
- broadcast = simple composition JS (itération des connexions + `send()`) ;
- sélection de client pour envoi individuel ; taille de payload 50/100/150 Ko ; heartbeat 2 s ;
- **Cleartext** : `config.xml` ajoute `<edit-config>` → `android:usesCleartextTraffic="true"` sur `<application>` (minimum approprié pour le client WebView `ws://` en cible SDK 36 ; pas de TLS/WSS au POC). Configuration posée, mais non validée sur device (aucun test physique).

## 7. Inventaire devices (référence pour la phase physique suivante)

| Rôle | Serial | Modèle | Android | IP wlan0 (LAN « CL07 ») |
|---|---|---|---|---|
| A | `61cc29567d91` | Xiaomi 24075RP89G (Redmi Note 13) | 16 (SDK 36) | 192.168.92.57 |
| B | `61d54bba7d91` | Xiaomi 24075RP89G (Redmi Note 13) | 16 (SDK 36) | 192.168.92.76 |
| C | `c0d8514d7d87` | Xiaomi 24075RP89G (Redmi Note 13) | 16 (SDK 36) | 192.168.92.192 |

IP DHCP, à re-vérifier avant essais.

## 8. Preuves et chemins

- `tests/poc/websocket-server/c2-test/` — projet isolé (config.xml, www/, package.json épinglé) ;
- `tests/poc/websocket-server/evidence/c2/build/build-failure-C2.log` — log de build complet.