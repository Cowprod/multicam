# VALIDATION.md — J04 Sessions + second Master

- Jalon : `docs/PLAN-DEVELOPPEMENT-V1.md` → J04
- État : **PASS technique — en attente revue humaine**
- Date : 2026-09-22
- Branche : `fix/j04-websocket`
- Décisions appliquées : `MULTICAM_DECISIONS_REFERENCE.md` §28 (transport WebSocket LAN), §30 (sessions, PIN immuable, fermeture, masters égaux)
- Devices physiques : B (`61d54bba7d91`, Cam 07, 192.168.92.76) et C (`c0d8514d7d87`, Cam 07, 192.168.92.192). Device A exclu par décision utilisateur (install Android bloquée par `INSTALL_FAILED_USER_RESTRICTED`, HyperOS « Install via USB » désactivé).

## Artefact validé

- APK : `testia/openCode/multicam/tests/e2e/validation/J04-sessions/artifacts/multicam-j04.apk`
- SHA-256 : `2e91bf1bc58036f0766de8c296dc6e75b33783b4dec4bf8d38650dca3ac9f107`
- Installé sur B et C via `pm install -r -t`.

## Scénarios exécutés (campaign 4, `tests/e2e/j04-campaign.sh clean`)

| # | Scénario | Cible critère plan | Résultat | Preuves |
|---|---|---|---|---|
| J04-01 | Création de session sur B : `sessionId` persistant, nom, PIN 4 chiffres, serveur WS 45102, annonce DNS-SD | création session / PIN | **PASS** | `dumps/J04-01-B-created.json`, `shots/J04-01-B-*`, `logs/J04-01-B.log` |
| J04-02 | Découverte LAN par C : 1 annonceur, host/port/TXT corrects | second Master via écran 02 | **PASS** | `dumps/J04-02-C-lan.json`, `shots/J04-02-C-home-lan.png`, `logs/J04-02-C.log` |
| J04-03 | C rejoint avec le PIN réel → convergence **2 Masters distincts** (mêmes nom, PIN, sessionId, masters par `deviceId`) sur les deux écrans | même état de session / écran 03 vue principale | **PASS** | `dumps/J04-03-B-converged.json`, `dumps/J04-03-C-joined.json`, `shots/J04-03-B-session-2masters.png`, `shots/J04-03-C-session-screen.png`, `logs/J04-03-*.log` |
| J04-04 | Renommage depuis C → propagé sur B + TXT DNS-SD actualisé (2 Masters, nom renommé) | même état / propagation temps réel | **PASS** | `dumps/J04-04-B-name.json`, `dumps/J04-04-C-name.json`, `dumps/J04-04-B-lan-txt.json`, `shots/J04-04-B-renamed.png` |
| J04-05 | PIN erroné sur C → rejet `pin_mismatch`, message « PIN incorrect », session **inchangée** sur B | décision 30.8 | **PASS** | `dumps/J04-05-C-reject.json`, `dumps/J04-05-B-unchanged.json`, `shots/J04-05-C-*`, `logs/J04-05-C.log` |
| J04-06 | Fermeture depuis C → propagation sur B (état `closed`), **LAN vidé** des deux côtés | fermeture / décisions 30.9-30.11 | **PASS** | `dumps/J04-06-*.json`, `dumps/J04-06-B-lan-after-close.json`, `shots/J04-06-B-closed-screen.png`, `logs/J04-06-B.log` |
| J04-07 | Re-jonction d'une session fermée → rejet `session_closed`, « Session indisponible », retour accueil, **store vide** | reprise cohérente | **PASS** | `dumps/J04-07-C-closed-reject.json`, `logs/J04-07-C.log` |
| J04-08 | Kill + restart de B (Master rejoint) → **même** session (dedans `9EGCAUWJ`, renommée, 2 Masters) | restart n'en crée pas une nouvelle / sessions récentes | **PASS** | `dumps/J04-08-B-restart.json`, `shots/J04-08-B-restart-home.png`, `logs/J04-08-B.log` |
| J04-09 | Purge DNS-SD de l'annonce fermée hors fenêtre stale 150 s | décision 30.11 (nettoyage) | **PASS** | `dumps/J04-09-B-lan-purged.json`, `logs/J04-09-B.log` |
| — | Tests unitaires module de fusion (`tests/plugin-lab/session/merge-model.test.js`) | — | **7/7 PASS** | `tests/plugin-lab/session/` |

## Critères d'acceptation du plan

| Critère | Verdict |
|---|---|
| Les deux Masters affichent le même nom, PIN et `sessionId` | ✅ J04-03 (dumps identiques, masters triés par `deviceId`) |
| Un restart n'en crée pas une nouvelle | ✅ J04-08 (count=1, même sid) |
| La session réapparaît dans les sessions récentes | ✅ J04-08 (session listée au boot) |
| L'écran 03 devient la vue principale réelle de session | ✅ J04-03 (panel-session + `MultiCamSessionScreen`) |

## Scénarios différés — décision utilisateur explicite (PAS affaiblis)

Device A non installable → scénarios 3 Masters repoussés :
- déterminisme à 3 Masters (fusion/renommage/fermeture avec trios) ;
- rejet d'un 3ᵉ joiner concurrent ;
- délestage / retour d'un pair en plein REC (lightning cut).

Ils restent **PASS attendus, non testés** ; aucun critère du plan J04 ne dépend du 3ᵉ device (le plan ne requiert que 2 Masters).

## Bugs réels détectés et corrigés (évidence honnête)

1. **Cache store périmé après `remove()`** (découvert campagne 3, `storedCount:1` après rejet) : dans la branche Cordova, `remove()` faisait `return getEntry(...)` AVANT la purge cache → `cache[sid]` restait servi par `list()/get()` alors que le fichier avait été supprimé. Corrigé dans `session-store.js` (purge commune toutes branches + `SESSION_STORE_REMOVE`/`_MISSING` tracés). Campagne 4 : `storedCount:0` sur rejet (J04-05 et J04-07).
2. **Boucle de convergence sync-echo** (campagnes 1-2) : différences cosmétiques `updatedAtMs` → `merge-changed` → advertise + reSync ping-pong. Corrigé via `semanticEqual()` noop dans `handleSync` (`MERGE_NOOP`).
3. **Instances DNS-SD dupliquées** (`- SID`, `(2)`, `(3)`) : lors des restarts non `clean`, chaque `advertise` recréait une instance. Corrigé via `advertisedKey` dédup dans `advertiseOne` (`SESSION_ADVERTISE_SKIP`), `advertiseOpenSessions` routé via `advertiseOne`, `unadvertise` purge la clé.
4. **Throttle reSync** : `reSyncSession` 1500 ms (`RE_SYNC_THROTTLED`) pour stopper les allers-retours intempestifs.
5. **Mapping NACK** : `session_closed`/`unknown_session` affichés « Session indisponible » (au lieu de « PIN incorrect »).

## Limitation environnementale connue (non produit)

Après `pm clear`/force-stop, le résolveur DNS-SD système peut encore répondre jusqu'à l'expiration du TTL (~120 s) pour les annonces du run précédent (observé sur `dumps/J04-04-B-lan-txt.json` : 1 résidu `2VGQQDNU` du run précédent à `lastSeen` rafraîchi, vidé au plus tard à J04-06 « LAN après fermeture = [] » et J04-09 « [] »). Le sweeper stale (`STALE_MS=150000`, période `SWEEP_MS=30000`) est le filet de sécurité ; `serviceLost` n'est que rarement délivré.

## Architecture livrée (résumé)

- Serveur WebSocket embarqué **générique** (`app/local-plugins/cordova-websocket-server/`) : aucune logique MultiCam, seul diff = compat Java-WebSocket 1.6.0 (patch minimal qualifié en POC) + `plugin.xml` android-only.
- Clients `new WebSocket` standard ; origine `http://localhost`, transport `ws://` LAN, port 45102 (fallback JS).
- Logique MultiCam 100 % dans `app/www/js/`: `net/session-ws.js` (protocole v1, ping/heartbeat, sync/merge, join), `net/session-discovery.js` (DNS-SD), `state/session-model.js` (merge), `state/session-store.js` (fichiers JSON, cache), `ui/session-create.js`, `ui/session.js`, `ui/settings.js`.
- SPA mono-document (`index.html`) : les écrans 01/02/03/settings sont des panneaux (`panel-home/create/join/session/settings`), routeur `MultiCamNav`. L'action native `status` est **interdite** ; l'état serveur est lu côté app (`serverRunning`, `effectivePort`, connexions, heartbeat).
- DNS-SD : `_multicam-session._tcp.` TXT `sid,name,did,ver,sver` (PAS de PIN dans le TXT).

## Lancer la campagne

```bash
adb devices                          # B et C branchés
bash tests/e2e/j04-campaign.sh clean
```

Résultat attendu : 9 PASS techniques, `TERMINÉ`.