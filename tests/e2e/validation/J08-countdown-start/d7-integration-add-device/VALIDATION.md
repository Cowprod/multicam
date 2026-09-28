# D7 — Intégration effective d'un device ajouté depuis un Master (§31.2)

Correction du défaut constaté en revue humaine : « Ajouter un device » depuis un
Master ne créait qu'une entrée locale dans `session.masters`/`members` côté A puis
diffusait aux WS **déjà connectés** (`peers=0`). Le device distant restait dans
l'ignorance de la session et l'UI affichait « Déconnecté ».

Décision appliquée : `MULTICAM_DECISIONS_REFERENCE.md` §31.2.

## Devices

| Rôle | deviceId | Nom | IPv4 |
|---|---|---|---|
| A — Master | `d5f6b2a1-2387-4207-836d-90b0072a6cee` | Cam D1 | 192.168.92.57 |
| B — ajouté | `7d1d4179-c52e-4260-92d1-3220c33296fd` | Cam 07 | 192.168.92.76 |

B n'a reçu **aucune interaction** : ni tap, ni commande, ni rechargement. Seul son
logcat et une lecture d'état via devtools (lecture seule) servent de preuve.

APK : sha256 dans `apk-sha256.txt`.

## Scénario nominal (§31.2)

1. Sur A : création d'une session **neuve** `ZUQFCMDV` (PIN 6429).
2. Sur A, écran 03 : bouton `Ajouter` de la ligne B → modal `Ajouter un device`
   (rôles proposés : `capture`, `storage` — les skills annoncées par B).
3. Rôle `Capture` sélectionné, clic `Ajouter`.
4. Aucune action sur B.

Résultats (logs parsables, voir `logs/`) :

```
A  MEMBER_ADD_LOCAL  sessionId=ZUQFCMDV did=7d1d4179… roles=[capture]
A  SYNC_BROADCAST   sessionId=ZUQFCMDV tag=member_add peers=0 did=7d1d4179…
A  INVITE_SENT      sessionId=ZUQFCMDV did=7d1d4179… to=192.168.92.76:45102 roles=[capture]
A  INVITE_OK        sessionId=ZUQFCMDV from=7d1d4179… roles=[capture]

B  WS_CONN_OPEN            remote=192.168.92.57
B  INVITE_PIN_ADOPTED      sessionId=ZUQFCMDV from=d5f6b2a1…
B  SESSION_STORE_SAVE      sessionId=ZUQFCMDV storage=file state=open
B  INVITE_ACCEPTED         sessionId=ZUQFCMDV did=7d1d4179… by=d5f6b2a1… roles=[capture]
B  MASTER_ADDED            sessionId=ZUQFCMDV deviceId=d5f6b2a1… learned_from=d5f6b2a1…
```

`SYNC_BROADCAST … peers=0` est conservé : c'est bien l'ajout seul qui ne suffit
toujours pas — l'invitation directe sur l'endpoint découvert est ce qui intègre B.

## B intégré (état de B, `dumps/b-device-integre.json`)

| Exigence §31.2 | Constaté |
|---|---|
| B connaît la session | `sessionId=ZUQFCMDV`, `name`, `state=open`, PIN hérité du Master (`6429`) |
| B connaît son membership | `members = [7d1d4179… → [capture]]` |
| B connaît les rôles attribués | `sessionRoles=[capture]`, `enabledSkills` d'origine conservées |
| Vraie connexion WS de session | `connectedPeers = [d5f6b2a1…]` (côté B) et `[7d1d4179…]` (côté A) |
| « Connecté » = liveness WS | ligne UI A : `Cam 07 \| Connecté` |
| PIN jamais en DNS-SD | clé TXT device limitée à `wsep` (endpoint transport), aucun PIN |
| Aucune action sur B | B n'a reçu aucun tap ; il a intégré la session à l'invitation |

Point de conception : B est inscrit dans `session.masters` **du Master A** et
connaît l'endpoint de A, mais B lui-même n'est **pas** inscrit dans ses propres
`masters` — sinon `start-service.isMasterRole()` lui accorderait le rôle Master
(§34.1) alors qu'il a été ajouté en `Capture`.

## Perte de connexion (§31.2 : « tant que l'intégration n'est pas établie, l'UI ne doit pas prétendre que le device est connecté »)

`adb -s 61d54bba7d91 shell am force-stop` :

```
A  connectedPeers = []   clientConns = 0
A  UI : Cam 07 | Déconnecté | dot=off | roles=capture | master=0
A  B reste membre de la session (membership persistante, §31.1)
```

## Reconnexion sans intervention (§31.2 « aucune action physique supplémentaire »)

Relance de l'app B (toujours sans tap) — `logs/b-logcat-reconnexion.txt` :

```
B  SESSION_BOOT    stored=7 open=7 closed=0
B  WS_CLIENT_OPEN  endpoint=192.168.92.57:45102
A  UI : Cam 07 | Connecté — connectedPeers = [7d1d4179…]
```

B re-dial A au boot grâce à l'endpoint de Master mémorisé à l'invitation
(`reSyncSession`).

## Point d'architecture à formaliser

Le TXT device (`_multicam._tcp.`) ne portait que le port **health** `45101`
(constante `DEFAULT_PORT`), qui n'accepte pas de WebSocket : un device découvert
n'était donc pas dialable et l'invitation §31.2 était impossible.

Le TXT device publie désormais une clé supplémentaire :

- `wsep` = `ip:port` du serveur WebSocket de session du device (ex. `192.168.92.76:45102`).

Aucun secret (jamais de PIN), conforme à §30.3/§30.6. Le republi du TXT est
déclenché par le transport dès que son port effectif est connu
(`WS_EFFECTIVE_PORT` → `reannounce`). Contrôle négatif visible dans les logs :
`MDNS_RESOLVE deviceId=23c5cf6e… wsep=-` — Cam D4 tourne encore l'APK précédent
et reste donc non dialable, sans casser le reste.

Cette clé n'est décrite nulle part dans `MULTICAM_DECISIONS_REFERENCE.md` (§30.3
détaille le TXT **session**, pas le TXT device) : **à formaliser** dans §30.3
lors d'une prochaine décision, aucune décision n'ayant été improvisée ici.

## Tests automatisés

`tests/plugin-lab/session/invite-add.test.js` — 10 cas, réseau simulé
(WebSockets appariés + faux plugin `wsserver`), sans Android :

1. l'ajout d'un device découvert l'intègre (session + rôle) sans action locale ;
2. la reply identifie la connexion des deux côtés (`connectedPeers`) ;
3. PIN sur le WS, jamais dans le DNS-SD, jamais dans le `sharedView` ;
4. un rôle non annoncé (`storage` sur un device `capture`) est rejeté, rien n'est forcé ;
5. peer sans endpoint → aucun crash, `INVITE_SKIP reason=no_endpoint` ;
6. ré-ajout d'un device déjà connecté = no-op, pas de doublon ;
7. perte de la connexion WS → plus de peer connecté ;
8. B connaît l'endpoint du Master (re-dial au boot) ;
9. un device sans session locale intègre la session du Master ;
10. device injoignable : `addMember` résout quand même (l'écran 03 ne bloque pas).

Suites existantes : `session/*.test.js` et `ui/member-modal-name.test.js` au vert.
`ui/panels-check.test.js` : 1 échec **préexistant**, identique sur HEAD vierge
avant la correction (vérifié par `git stash`).

## Hors périmètre (non touché)

Aucun rôle controller, aucun preview, aucun J09, aucun refactor hors sujet.
