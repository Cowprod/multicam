# J17-A — Résultats (accès aux vidéos archivées sur les Storages)

## Objectif
Permettre au Master de savoir quelles vidéos originales existent encore sur les Storages sélectionnés pour un Take arrêté, et par quel chemin HTTP les lire en flux (progressif + seek par Range), sans pré-téléchargement complet, sans transcodage/proxy. Prépare J17-B (lecteur) sans l'implémenter.

## État
FAIT — code ajouté, tests unitaires J17-A ajoutés et validés, suite complète verte.

## Implémenté
### Modèle pur (app/www/js/state/media-catalogue-model.js) — nouveau
- takeStopped : faits sur summary.stopStates par Capture (J16-A), repli J12, ou statut terminal.
- sanitizeRel : refuse chemin absolu, remontée, schéma, antislash.
- mediaUrl : route confinée /<sessionId>/<takeNumber>/<sourceDeviceId>/<rel> avec token, refus si invalide.
- buildView : disponibilité par couple Capture→Storage et par fichier listé. transferState TERMINATED ne prouve rien. Sélection déterministe par take.storages. Hors ligne conserve historique. Erreur listing → storage_error. Absence token → storage_error. selectCopy pour bascule.
- Raisons : take_not_stopped, replication_unknown, replication_error, replication_not_done, storage_offline, storage_pending, storage_unknown, storage_unsupported, storage_error, file_missing, file_empty, file_size_mismatch.

### Service Storage (app/www/js/state/transfer-service.js)
- storageCatalogue : Storage uniquement, Take arrêté, mode SAF → saf_unsupported explicite. Listing disque réel via listDir. Dossier absent = source vide. Autre erreur = listing_failed. Grant HTTP via ensureTakeGrant sur serveur partagé. Réponse sans chemin absolu.
- ensureTakeGrant ajouté.

### Assemblage (app/www/js/state/transfer-boot.js)
- Kinds additifs media_catalogue_request/reply routés avant J15.
- Storage : vérifie Master de session + sélection pour ce Take.
- Master : requestCatalogue vers chaque Storage sélectionné (même requestId), refus si Take non arrêté. catalogueFor agrège avec connectedPeers, historique conservé hors ligne. Réponses périmées ignorées.
- Exposé requestCatalogue, catalogueFor. Injection paths.listDir, storageMode, catalogueModel.

### Réseau/natif/UI
- session-ws.js : routage avec reply.
- MultiCamTransfer.java/.js + transfer.js : action read-only list.
- index.html : chargement media-catalogue-model.js.

## Tests
- app/tests/j17-media-catalogue.test.js : 22 tests.
- cd app && node tests/run.js → 552 passed, 0 failed.

## Vérification physique
- Devices A Master 61cc29567d91 / B Capture 61d54bba7d91 / C Storage c0d8514d7d87. Session 899GJ2SM Take 1 TERMINATED, réplication done, fichier présent sur C (/sdcard/Android/data/fr.emmanuel.multicam/files/MultiCam/899GJ2SM/1/...). Logique couverte par tests.

## Limites connues
- SAF non servable → saf_unsupported explicite.
- J17-B hors périmètre (lecteur/time-sync/transcodage).
- Ajout natif list : rebuild/reinstall requis pour validation device avec nouveau natif.
- Hors ligne conserve derniers catalogues connus.

## Prérequis J17-B
- UI utilisant transferBoot.catalogueFor/requestCatalogue.
- Lecteur HTTP progressif Range/206, bascule via selectCopy, token Take, confinement strict.
- Ne pas se fier à summary.transferState seul.
