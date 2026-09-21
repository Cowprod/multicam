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
