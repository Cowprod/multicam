# Reprise des transferts après changement de réseau — 30/10/2026

Correction déployée sur les cinq tablettes, sans désinstallation ni effacement des données. Les originaux privés et publics Alf sont conservés. La suppression automatique a été désactivée pour cette prise, conformément à la demande de différer le nettoyage.

## Corrections

- Les pairs déjà membres d'une session ouverte sont retrouvés par leur deviceId ; l'hôte résolu par mDNS et le port WebSocket annoncé actualisent leurs connexions. Les identités, rôles et sessions fermées restent respectés.
- Chaque source garde son propre endpoint et token ; la reprise ne réutilise plus le dernier serveur reçu pour toutes les captures.
- La réception SAF reprend à la longueur réellement présente et positionne le descripteur avant écriture, après validation du Content-Range. Les checksums sont calculés sur la destination relue.
- Le journal du stockage est restauré avant l'application d'une nouvelle offre. Une paire sans manifeste ne remplace plus les tailles et progressions déjà connues par zéro.
- Les annonces des captures sélectionnées peuvent déclencher directement le stockage, sans master.
- Les captures réannoncent les prises arrêtées. Un index local conserve leurs chemins indépendamment des résumés synchronisés. Pour les anciennes prises, une migration limitée utilise le nom du staging existant et la taille attendue ; les associations ambiguës sont refusées.
- Les originaux privés peuvent être servis directement par une liste exacte de fichiers autorisés par prise, sans nouvelle copie de staging. Les fichiers voisins ne sont pas exposés.
- Un checksum destination différent déclenche une seule récupération contrôlée ; les états terminaux valides ne sont pas retéléchargés à chaque annonce.

## Preuves physiques et limites

La Samsung a reçu un fichier de contrôle de 8 Mio. Le serveur a interrompu le premier flux après 262144 octets. La seconde requête porte `Range: bytes=262144-` malgré un offset logique volontairement différent. Le SHA-256 de la destination correspond au fichier initial. Les fichiers de contrôle ont ensuite été supprimés.

La vidéo réelle Cam01 (13585698412 octets) a repris depuis 2019179528 octets sur le Wi-Fi maison, puis terminé et passé le contrôle SHA-256, alors que le master était arrêté. Aucune récupération manuelle des vidéos n'a été effectuée.

L'ancien résumé partagé Alf avait perdu les chemins d'arrêt Cam02/Cam03, puis certaines tailles. Une réparation ponctuelle de leurs index locaux a donc réassocié les originaux connus après recalcul intégral et comparaison de leurs SHA-256 avec les manifestes d'hier. Il s'agit d'une réparation de métadonnées, sans copie des vidéos hors des tablettes.

Le dernier instantané est pris après mise à jour finale et restauration du journal : Cam01 à 100% est en revalidation ; Cam02/Cam03 sont encore en attente pendant la réannonce des sources. Leur réception complète n'est pas déclarée validée. À la demande de l'utilisateur, aucun suivi jusqu'à la fin n'est maintenu.

Tests JavaScript : 570 réussis, aucun échec. Builds Android réussis. Les tests d'interruption SAF et la réception Cam01 sont physiques ; une nouvelle campagne complète avec changement de routeur pendant les trois téléchargements reste à réaliser.
