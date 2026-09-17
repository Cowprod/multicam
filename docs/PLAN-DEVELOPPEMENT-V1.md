# MultiCam — Plan de développement V1

**État : prêt à exécuter**  
**Date : 17 septembre 2026**

Ce document définit l'ordre de développement de la V1, les livrables attendus à chaque jalon et les preuves que l'agent de codage doit produire avant de passer au jalon suivant.

Le principe est simple : **aucun jalon n'est considéré comme terminé sur la seule déclaration de l'agent**. Chaque étape doit être installée et testée sur les devices Android physiques disponibles, puis accompagnée de preuves reproductibles.

---

# Règles générales pour l'agent de codage

L'agent est autorisé à utiliser librement `adb` sur tous les devices Android connectés à la machine de développement, sans demander de confirmation à chaque action.

Il peut notamment :

- lister les devices ;
- installer/remplacer l'APK ;
- lancer/arrêter l'application ;
- forcer un `stop` ;
- prendre des captures d'écran ;
- récupérer `logcat` ;
- récupérer les fichiers de test accessibles ;
- provoquer une déconnexion/reconnexion applicative ou réseau lorsque cela est possible depuis ADB ;
- répéter automatiquement les mêmes opérations sur plusieurs devices.

À partir de J03, tout jalon réseau doit être testé sur **au moins deux devices physiques**, et si trois devices ou plus sont disponibles, les utiliser dès que le scénario le permet.

L'agent ne doit pas passer au jalon suivant tant que les critères d'acceptation du jalon courant ne sont pas remplis.

Il peut préparer du code en avance si nécessaire, mais le jalon suivant ne doit pas masquer une brique précédente non validée.

---

# Format de preuve obligatoire

Chaque jalon produit un dossier :

```text
tests/e2e/validation/JXX-nom-du-jalon/
```

avec au minimum :

```text
VALIDATION.md
adb-devices.txt
screenshots/
logs/
artifacts/
```

`VALIDATION.md` doit contenir :

- date et heure du test ;
- commit Git testé ;
- liste des devices avec serial, constructeur, modèle, version Android et SDK ;
- scénario exécuté ;
- commandes principales utilisées ;
- résultat attendu ;
- résultat réel ;
- écarts éventuels ;
- verdict : `PASS` ou `FAIL` ;
- liens relatifs vers screenshots, logs et fichiers de preuve.

Les preuves doivent combiner :

- **preuve opérateur** : screenshot de l'UI réelle ;
- **preuve technique** : log structuré, dump JSON, fichier produit, checksum ou autre artefact mesurable.

Une capture seule n'est pas suffisante pour valider une mécanique réseau, une synchronisation ou un transfert.

---

# Infrastructure e2e attendue dès J01

Créer au minimum :

```text
tests/e2e/
├── devices.sh
├── install-all.sh
├── screenshot-all.sh
├── logs-all.sh
├── collect-files.sh
└── validation/
```

Les scripts doivent fonctionner sur tous les devices renvoyés par :

```sh
adb devices
```

Exemple de capture attendue :

```sh
adb -s "$SERIAL" exec-out screencap -p > "$OUT/$SERIAL.png"
```

Exemple de log :

```sh
adb -s "$SERIAL" logcat -d > "$OUT/$SERIAL-logcat.txt"
```

Les scripts doivent ignorer proprement les devices `offline` ou `unauthorized` et le signaler dans le rapport.

---

# Journalisation structurée obligatoire

Les événements distribués importants doivent être journalisés dans un format exploitable automatiquement.

Exemples :

```text
START_REQUEST session=... take=... target=2026-09-17T13:42:18.500Z
START_LOCAL session=... take=... actual=2026-09-17T13:42:18.527Z
CLOCK_SYNC peer=... offset=-12ms rtt=21ms
STOP_REQUEST session=... take=... target=...
STOP_LOCAL session=... take=... actual=...
ARM_RESULT device=... status=READY
TRANSFER_PROGRESS take=... source=... storage=... bytes=... total=...
TRANSFER_HASH take=... sourceSha256=... storageSha256=...
```

Le format exact peut être JSONL si cela simplifie l'analyse, mais il doit être stable, lisible et parsable.

---

# J01 — Socle application Cordova réel

## Objectif

Créer l'application réelle dans `app/` et obtenir un build reproductible installable sur tous les devices disponibles.

## Attendu

- projet Cordova Android réel dans `app/` ;
- structure JS/CSS claire ;
- séparation minimum entre UI, état local, services natifs et réseau ;
- reprise des briques du POC déjà qualifiées au lieu de les réécrire sans justification ;
- intégration propre du mécanisme PixelCopy validé ;
- script de build/install multi-device ;
- premiers scripts `tests/e2e/` ;
- écran d'accueil fonctionnel proche de la maquette 01 même si les fonctions réseau ne sont pas encore actives.

## Critères d'acceptation

- build sans erreur ;
- installation réussie sur tous les devices autorisés ;
- lancement sans crash ;
- même commit exécuté sur plusieurs devices ;
- l'écran 01 est visible et cohérent sur au moins deux tailles/formats d'écran ;
- le code source contient une structure exploitable pour les jalons suivants ;
- aucune dépendance technique critique n'est cachée dans le lab au lieu d'être intégrée à `app/`.

## Preuves minimales

- `adb-devices.txt` ;
- version Cordova/Android/Node utilisée ;
- liste des plugins ;
- capture écran 01 sur au moins deux devices ;
- log de démarrage de chaque device ;
- chemin de l'APK produit ;
- commit Git testé.

---

# J02 — Identité persistante + Paramètres device 14

## Objectif

Implémenter l'identité locale et l'écran Paramètres réel.

## Attendu

- `deviceId` persistant ;
- nom du device modifiable ;
- skills supportées distinctes des skills activées ;
- activation/désactivation locale des skills ;
- permissions caméra, micro, localisation, notifications, stockage ;
- informations device réelles ;
- emplacement de stockage par défaut ;
- intégration SAF déjà qualifiée pour changement d'emplacement ;
- persistance après kill/restart.

## Critères d'acceptation

- modifier le nom, tuer l'app, la relancer : le nom reste ;
- le `deviceId` ne change pas après restart ;
- les skills activées sont persistées ;
- les permissions reflètent l'état Android réel ;
- l'écran 14 correspond à la maquette fonctionnelle validée.

## Preuves minimales

- screenshots avant/après modification ;
- dump JSON de la configuration persistée ;
- preuve du même `deviceId` avant/après restart ;
- screenshot des permissions et infos device ;
- log du test SAF sur stockage principal.

---

# J03 — Découverte LAN / mDNS

## Objectif

Faire s'annoncer et se découvrir plusieurs devices automatiquement sur le LAN.

## Attendu

Chaque device annonce au minimum :

- `deviceId` ;
- nom ;
- skills supportées ;
- skills activées ;
- endpoint de communication utile au jalon suivant.

Le Master voit les autres devices disponibles sans saisie d'adresse IP.

## Critères d'acceptation

- au moins 2 devices se découvrent ;
- si 3+ disponibles, démontrer une vue avec plusieurs peers ;
- aucune identité basée sur IP ;
- disparition visible après arrêt d'un device ;
- retour automatique après relance ;
- pas de doublon après reconnexion.

## Preuves minimales

- screenshot du Master avec peers détectés ;
- logs mDNS contenant les `deviceId` ;
- arrêt d'un device puis screenshot/log de disparition ;
- relance puis preuve de réapparition ;
- dump de la table de peers.

---

# J04 — Sessions + second Master

## Objectif

Créer une session réelle, rejoindre la session avec un autre Controller/Master et persister son identité.

## Attendu

- création session ;
- `sessionId` persistant ;
- nom ;
- PIN Master 4 chiffres ;
- second Master rejoignant via l'écran 02 ;
- même état de session sur les Masters ;
- reprise après kill/restart.

## Critères d'acceptation

- les deux Masters affichent le même nom, PIN et `sessionId` ;
- un restart n'en crée pas une nouvelle ;
- la session réapparaît dans les sessions récentes ;
- l'écran 03 devient la vue principale réelle de session.

## Preuves minimales

- screenshots des deux Masters ;
- dumps JSON de session comparables ;
- logs de création/rejoin ;
- restart d'un Master puis reprise de la même session.

---

# J05 — Membres + rôles de session

## Objectif

Ajouter des devices Capture/Storage à une session et gérer leurs `sessionRoles`.

## Attendu

- ajout initié par Master ;
- seuls les rôles correspondant aux skills activées/annoncées peuvent être attribués ;
- propagation en temps réel aux autres Masters ;
- persistance des membres et rôles ;
- device absent = membre conservé mais déconnecté.

## Critères d'acceptation

- Master A ajoute/modifie un device ;
- Master B reçoit la modification sans refresh manuel ;
- un rôle non annoncé ne peut pas être forcé ;
- reconnecter un ancien membre ne crée pas un nouveau membre.

## Preuves minimales

- screenshots Master A / Master B ;
- dump de session sur les deux Masters ;
- logs WebSocket/event ;
- scénario déconnexion/reconnexion d'un membre.

---

# J06 — Préparation Take 05

## Objectif

Implémenter la création d'un Take et ses réglages.

## Attendu

- sélection Captures/Storage ;
- réglages globaux ;
- defaults du premier Take ;
- héritage du Take précédent ;
- overrides par Capture ;
- fallbacks selon capacités ;
- JSON de Take persistant et versionné si nécessaire.

## Critères d'acceptation

- Take 001 créé avec defaults attendus ;
- Take 002 reprend sélections/réglages/overrides ;
- les devices incompatibles montrent un warning au lieu de bloquer arbitrairement ;
- le JSON reflète exactement l'UI.

## Preuves minimales

- screenshots Take 001 / Take 002 ;
- JSON complets des deux Takes ;
- exemple d'override ;
- exemple de fallback réel ou simulé via capacités déclarées de test.

---

# J07 — ARM distribué + synchronisation horloge

## Objectif

Valider les préconditions sur chaque device sélectionné et estimer les offsets d'horloge.

## Attendu

- ARM automatique ;
- états READY / WARNING / ERROR ;
- timeout 5 s ;
- vérifications locales Capture/Storage ;
- échange horodaté permettant estimation RTT/offset ;
- récupération automatique quand un device revient ;
- plusieurs Masters convergent vers le même état.

## Critères d'acceptation

- au moins une Capture READY ou WARNING permet de poursuivre ;
- une Capture ERROR n'empêche pas les autres ;
- un Storage indisponible ne bloque pas le REC ;
- offset/RTT sont journalisés ;
- faire disparaître/revenir un device modifie l'ARM automatiquement.

## Preuves minimales

- screenshot ARM multi-device ;
- logs structurés `CLOCK_SYNC` ;
- tableau calculé des offsets/RTT ;
- scénario panne/récupération avec screenshots avant/après.

---

# J08 — Countdown + START synchronisé

## Objectif

Déclencher un enregistrement simultané via un instant cible commun.

## Attendu

- `targetStart` absolu ;
- propagation aux Captures ;
- countdown visuel ;
- START local au plus près de l'instant cible corrigé ;
- annulation globale par Master ;
- conservation du top si tous les Masters disparaissent après programmation.

## Critères d'acceptation

- plusieurs Captures démarrent le même Take ;
- l'écart entre Captures est calculé automatiquement ;
- objectif pratique V1 : environ ±50 ms lorsque le matériel et Android le permettent ;
- toute dérive supérieure est explicitement mesurée et documentée, pas masquée.

## Preuves minimales

- logs `START_REQUEST`, `START_LOCAL`, `CLOCK_SYNC` de chaque device ;
- script calculant min/max/écart inter-device ;
- screenshots countdown ;
- scénario annulation ;
- scénario Master disparu après programmation si réalisable.

---

# J09 — REC multicam + previews Master

## Objectif

Faire réellement enregistrer plusieurs Captures et afficher leur preview périodique côté Master.

## Attendu

- vidéo locale réelle sur chaque Capture ;
- timer ;
- PixelCopy ~1 fps ;
- JPEG transmis au Master ;
- mosaïque stable ;
- batterie/espace/état ;
- dernière image figée lors d'une déconnexion ;
- reprise de preview à la reconnexion.

## Critères d'acceptation

- 2+ Captures enregistrent réellement ;
- fichiers vidéo présents ;
- previews reçues régulièrement sans bloquer REC ;
- une déconnexion ne fait pas bouger arbitrairement la grille ;
- reconnexion = reprise automatique.

## Preuves minimales

- screenshot mosaïque ;
- logs PixelCopy/transmission ;
- liste des fichiers vidéo par device ;
- taille/durée des vidéos ;
- scénario déconnexion/reconnexion avec screenshots.

---

# J10 — STOP synchronisé

## Objectif

Arrêter proprement toutes les Captures d'un Take.

## Attendu

- STOP global ;
- timestamp demandé et timestamp appliqué ;
- finalisation vidéo locale ;
- STOP local d'urgence lorsqu'aucun Master n'est connecté ;
- une Capture stoppée localement ne redémarre pas dans le même Take.

## Critères d'acceptation

- fichiers vidéo lisibles après STOP ;
- écarts de STOP mesurés ;
- STOP local n'arrête pas les autres Captures ;
- aucun fichier corrompu silencieusement.

## Preuves minimales

- logs `STOP_REQUEST` / `STOP_LOCAL` ;
- calcul d'écart inter-device ;
- vérification de durée/lecture des médias ;
- screenshot post-STOP.

---

# J11 — Transfert / Storage / réplication

## Objectif

Transférer les médias vers un ou plusieurs Storage après STOP, avec vérification et reprise.

## Attendu

- arborescence Session / Take ;
- transfert HTTP reprenable ;
- progression par source/destination ;
- plusieurs Storage si disponibles ;
- SHA-256 source/destination ;
- reprise après coupure ;
- pas de transfert média sur un device en RECORDING ;
- suppression locale seulement après réplication validée si option active.

## Critères d'acceptation

- checksum identique source/destination ;
- couper le réseau pendant transfert puis reprendre sans recommencer arbitrairement de zéro ;
- progression visible dans l'écran 09 et la vue Storage ;
- erreur destination = bouton Réessayer ;
- plusieurs destinations restent indépendantes.

## Preuves minimales

- SHA-256 source/destination ;
- logs progression/reprise ;
- screenshots avant coupure/après reprise/terminé ;
- arborescence réelle du Storage ;
- preuve de suppression locale uniquement après validation si activée.

---

# J12 — Historique + persistance complète

## Objectif

Prouver que Session/Take restent cohérents après arrêt/restart et sont accessibles via l'historique.

## Attendu

- quatre sessions récentes sur 01 ;
- historique 15 ;
- reprise même `sessionId`/PIN/membres/rôles ;
- Takes accessibles depuis 03 ;
- Take passé ouvre 09 ;
- nouveaux Takes ajoutables à une session reprise.

## Critères d'acceptation

- force-stop de l'app puis reprise ;
- si possible reboot device ;
- aucun doublon de session ;
- anciens membres absents restent affichés déconnectés ;
- état des Takes cohérent avant/après.

## Preuves minimales

- dumps JSON avant/après ;
- screenshots accueil/historique/session/Take ;
- logs de restauration ;
- scénario restart d'au moins deux devices.

---

# J13 — Scénarios de panne

## Objectif

Tester explicitement les cas de défaillance V1.

## Scénarios minimum

- Master perdu ;
- Capture perdue ;
- Capture reconnectée ;
- Storage perdu ;
- Storage sans espace ou erreur d'écriture simulée ;
- Wi-Fi coupé ;
- application Capture tuée ;
- application Storage tuée ;
- transfert interrompu ;
- redémarrage d'une ancienne session.

## Critères d'acceptation

- pas de crash silencieux ;
- état utilisateur compréhensible ;
- reprise automatique quand prévue ;
- aucune suppression de média non vérifié ;
- aucune duplication incohérente de device/session/Take.

## Preuves minimales

Un sous-dossier par scénario avec :

- état initial ;
- action de panne ;
- résultat attendu ;
- résultat réel ;
- screenshot ;
- logs ;
- verdict.

---

# J14 — Endurance / campagne V1

## Objectif

Valider le comportement global sur une durée représentative avant de considérer la V1 exploitable.

## Attendu

- plusieurs Takes successifs ;
- plusieurs Captures ;
- au moins un Storage ;
- REC longs ;
- previews ~1 fps ;
- transferts d'anciens Takes pendant préparation des suivants ;
- déconnexions/reconnexions ponctuelles ;
- suivi espace disque ;
- contrôle des fichiers et JSON produits.

## Critères d'acceptation

- aucun crash bloquant ;
- aucun Take perdu silencieusement ;
- aucun média supprimé avant validation ;
- état final cohérent sur les Masters et Storage ;
- checksum correct des médias répliqués ;
- métriques d'erreurs documentées.

## Preuves minimales

- rapport de campagne ;
- durée totale ;
- nombre de Takes ;
- devices utilisés ;
- incidents ;
- logs consolidés ;
- inventaire des médias ;
- checksums ;
- screenshots finaux.

---

# Règle de passage entre jalons

Un jalon n'est clos que si :

1. le code correspondant est commité ;
2. les critères d'acceptation sont vérifiés sur devices physiques ;
3. le dossier de preuve est présent ;
4. `VALIDATION.md` conclut `PASS` ;
5. les écarts connus sont documentés.

Un `FAIL` bloque le passage au jalon suivant, sauf décision explicite de reporter le point avec justification inscrite dans le dépôt.

---

# Références fonctionnelles

L'agent doit utiliser comme références de vérité :

- `ui/PLAN-DE-VOL.md` ;
- les README de chaque écran `ui/XX-*` ;
- `docs/SKILLS-AND-ROLES.md` ;
- `docs/QUALIFICATION-TECHNIQUE-V1.md` ;
- ce document `docs/PLAN-DEVELOPPEMENT-V1.md`.

En cas de contradiction entre une implémentation et une spécification validée, l'agent ne doit pas improviser : il doit signaler le conflit et attendre une décision.
