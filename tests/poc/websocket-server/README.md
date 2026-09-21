# POC — Serveur WebSocket embarqué générique

## Objet

Qualifier une brique **générique** de serveur WebSocket embarqué pour l'application Cordova Android MultiCam.

Cette brique doit permettre à un device Android :

- d'écouter sur le LAN ;
- d'accepter plusieurs clients WebSocket ;
- d'envoyer un message à un client ;
- de diffuser un message à plusieurs clients ;
- de remonter les événements connexion / message / déconnexion ;
- de fonctionner sans serveur externe, PC, Raspberry Pi, Node.js ou cloud.

## Frontière d'architecture

Le composant natif éventuel doit rester strictement générique.

Il ne doit connaître aucun concept métier MultiCam :

- session ;
- Master ;
- PIN ;
- Take ;
- Capture ;
- Storage.

La logique métier et le protocole MultiCam restent côté JavaScript.

## Contexte

La WebView Cordova fournit déjà le client WebSocket JavaScript standard.

Le point à qualifier est la capacité **serveur WebSocket entrant** sur Android.

## Règles

- Ne pas reprendre l'implémentation J04 abandonnée comme base.
- Ne pas fusionner `rescue/j04-plugin-aborted`.
- Ne pas créer un plugin spécifique aux sessions.
- Examiner d'abord les solutions existantes.
- Ne pas développer de nouveau plugin tant qu'une revue humaine n'a pas conclu que les solutions existantes sont insuffisantes.
- J04 reste suspendu pendant cette qualification.

## Candidats minimum à étudier

- `cordova-plugin-websocket-server`
- `cordova-plugin-boogie-webserver`

D'autres candidats crédibles peuvent être ajoutés.

## Livrables attendus

Phase 1 :
- `RESEARCH.md` : comparaison sourcée des solutions existantes.

Phase 2 :
- sélection d'un candidat pour POC physique, après revue humaine.

Phase 3 :
- `VALIDATION.md` + preuves physiques sur Android.

Aucune phase ne doit être sautée silencieusement.


## Décision après qualification C2 — 21 septembre 2026

Le candidat C2 (`cordova-websocket-server@1.1.0`) échoue au build avec Java-WebSocket 1.6.0 à cause d'un défaut de compatibilité source identifié et borné : `WebSocketServer.stop()` ne déclare plus `IOException`, alors que le plugin conserve un `catch (IOException)`.

Décision de revue :

- C2 reste le candidat principal ;
- un **patch minimal de compatibilité** est autorisé dans le POC uniquement ;
- le patch doit se limiter à l'adaptation nécessaire à Java-WebSocket 1.6.0, sans ajout de fonctionnalité ;
- le code amont original et le diff du patch doivent être conservés comme preuve ;
- si d'autres erreurs substantielles apparaissent après ce correctif, l'agent doit s'arrêter pour nouvelle revue ;
- aucune intégration dans l'application MultiCam de production n'est autorisée à ce stade ;
- C3 ne doit pas être testé tant que C2 n'a pas été réévalué après ce patch minimal.
