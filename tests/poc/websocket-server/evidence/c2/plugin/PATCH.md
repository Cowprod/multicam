# Patch minimal de compatibilité C2 — Java-WebSocket 1.6.0

> Date : 21 septembre 2026 — autorisé par revue humaine (`fc1ec3d docs(poc): allow minimal C2 compatibility patch`).
> Périmètre : POC uniquement. Aucune intégration MultiCam, aucun changement d'API, aucune fonctionnalité ajoutée.

## Candidat

- **C2** : `cordova-websocket-server@1.1.0` (`raghu2x/cordova-websocket-server`).
- Source amont préservée : `evidence/c2/plugin/upstream/` (extraction exacte du tarball npm `cordova-websocket-server-1.1.0.tgz`, sha-256 identiques au contenu de `node_modules/`).
- Patch : `evidence/c2/plugin/C2-1.6.0-compat.patch`.
- Copie patchée installée par le POC : `c2-test/local-plugins/cordova-websocket-server/`.

## Défaut corrigé

Le fork C2 a monté la dépendance à Java-WebSocket **1.6.0** (`mavenCentral()` + `org.java-websocket:Java-WebSocket:1.6.0`) sans adapter le code source hérité de becvert.

En Java-WebSocket 1.6.0, `org.java_websocket.server.WebSocketServer.stop()` ne déclare plus `throws IOException` (vérifié par `javap`) :

```
public void stop() throws java.lang.InterruptedException;
```

Le code contient deux `catch (IOException)` devenus morts autour d'appels à `stop()`, refusés par javac (`exception IOException is never thrown in body of corresponding try statement`) :

1. `WebSocketServerPlugin.java` — `onDestroy()` : `catch (IOException e)` autour de `wsserver.stop()`. (Erreur constatée au premier build.)
2. `WebSocketServerImpl.java` — `onError()` : même `catch (IOException e)` autour de `this.stop()`. Même défaut, même correctif ; javac n'a affiché qu'une erreur (recovery Flow) mais le même échec de compilation aurait bloqué le build après correction de la première.

## Contenu du patch

Deux suppressions uniquement, la clause `catch (IOException e) { ... }` autour de `stop()` dans chacun des deux fichiers. Aucune autre modification.

| Fichier | Ligne (amont) | Modification |
|---|---|---|
| `src/android/WebSocketServerPlugin.java` | 55 | suppression `catch (IOException e)` |
| `src/android/WebSocketServerImpl.java` | 246 | suppression `catch (IOException e)` |

L'import `java.io.IOException` devient inutilisé dans les deux fichiers (aucune erreur javac pour un import inutilisé ; conservé pour rester minimal et lisible en diff).

## API et fonctionnalités

Intactes :

- JS : `cordova.plugins.wsserver.start(port, options, success, failure)`, `stop()`, `send(conn, msg)` (texte/binaire), `close(conn, code, reason)`, `getInterfaces()` ;
- événements : `onOpen(conn)`, `onMessage(conn, msg)`, `onClose(conn, code, reason, wasClean)`, `onFailure(addr, port, reason)` ;
- pas de broadcast natif ; couplage métier MultiCam : aucun.

## STOP condition respectée

Correctif appliqué = celui identifié à l'issue de la qualification (adaptation du `catch (IOException)` à Java-WebSocket 1.6.0), dans ses **deux** occurrences. Il ne s'agit pas de l'accumulation de patchs de compatibilité distincts. Si une autre incompatibilité substantielle apparaît, le build est arrêté et la revue humaine re-sollicitée.