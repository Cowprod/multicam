# MultiCam — audit statique STOP → transfert (19/11/2026)

## Portée et verdict
Audit **lecture seule** du code sur `feat/home-discovery-previews` (révision de départ `74f6b9fd`). Aucun build, déploiement, modification de code applicatif ni test physique. Les durées réelles et les débits **ne sont pas mesurés** : aucune cause unique de lenteur n'est prouvée.

## Chaîne effective retrouvée dans le code
1. `app/www/js/state/start-service.js` (vers L410) appelle `camera().stopRecording()` et récupère le chemin finalisé.
2. `app/www/js/native/camera-record.js` (L485–538) appelle `stopRecordVideo`. Après son callback, une exportation locale `MultiCamSaf.saveVideo` peut être déclenchée **asynchronement** : elle ne bloque pas l'ACK STOP, mais peut consommer des ressources I/O pendant la suite. La preview est conservée.
3. `app/www/js/state/transfer-boot.js` (L704–724) déclenche `captureAnnounce` lorsque `localStoppedTake` est vrai. `stageSegments` (L243–274) réutilise directement certains chemins privés ou `content://`; sinon il peut copier le fichier vers l'arbre HTTP. **Ne pas conclure que chaque vidéo est copiée** : cela dépend du chemin source.
4. `app/www/js/state/transfer-service.js` (L134–188) calcule le SHA-256 de chaque segment, démarre/enregistre le serveur HTTP, puis annonce `media_ready`. L'annonce n'est pas envoyée avant la fin de ces opérations. Aucun chronométrage détaillé par étape n'est établi ici.
5. Le Master offre les fichiers aux Storages sélectionnés ; le Storage effectue le GET HTTP reprenable (`Range`), puis vérifie l'intégrité.
6. `app/www/js/state/transfer-service.js` (L445–483) traite les fichiers d'une **même offre/source séquentiellement**, avec un verrou anti-double pour cette source. Cela ne prouve pas que toutes les Captures sont sérialisées entre elles.
7. `app/local-plugins/cordova-plugin-multicam-transfer/src/android/MultiCamTransfer.java` (L290–480) lit en blocs de **64 KiB**, notifie la progression toutes les ~250 ms, écrit via SAF ou fichier ordinaire, puis **relit intégralement le fichier enregistré** pour calculer son SHA-256. Cette relecture garantit l'intégrité mais représente une passe I/O supplémentaire potentiellement coûteuse sur SSD USB/SAF.
8. Les reprises peuvent relire et re-hasher le fichier destination via `statDest` avant réutilisation (`transfer-service.js` L572–602 et `MultiCamTransfer.java` L267–284). Ce contrôle est conditionnel et n'est pas systématique sur un transfert neuf.

## Constat critique sur « Préparation »
`app/www/js/ui/storage-view-model.js` (L145–176) dérive le badge « Préparation » quand il n'y a ni REC/COUNTDOWN, ni erreur, ni tous les fichiers reçus, ni activité de transfert connue. **Ce libellé ne correspond pas à une opération technique unique**. Il peut englober attente de publication de la Capture, absence de manifest/offer, indisponibilité de l'état ou véritable préparation. La longueur du badge « Préparation » ne mesure donc pas directement la durée de finalisation MP4 ou du SHA.

## Risques et hypothèses à tester (non prouvés)
- H1 : temps de finalisation natif `stopRecordVideo` important.
- H2 : copie de staging dans certains chemins, ou exportation SAF locale concurrente, augmentant les I/O.
- H3 : calcul SHA-256 côté Capture avant `media_ready` retardant l'offre.
- H4 : écriture SAF sur Samsung/SSD USB et relecture intégrale pour SHA limitant le débit apparent.
- H5 : débit Wi-Fi, congestion et concurrence des Captures ; débit réseau utile inconnu.
- H6 : attentes réseau, reprises et backoff (connect timeout 15 s, read timeout 30 s) rallongeant la durée.
Aucune de ces hypothèses n'est une conclusion sans logs horodatés et mesures.

## Autres constats fonctionnels
- `transfer-boot.js` (L138–164) construit encore `MultiCam/<sessionId>/Take_###/Cam_##.mp4`. **Non conforme** aux décisions récentes : nom humain de session, nom Capture, normalisation, collisions. Ne pas corriger pendant cet audit.
- `storage-view-model.js` (L210+) affiche `Take ###` : la question du nom personnalisable des Takes n'est pas résolue ici.
- `transfer-boot.js` (L166–180) documente un seul segment par Capture/Take dans le flux actuel : pas de besoin démontré de fichiers multiples.

## Instrumentation recommandée avant optimisation
Pour chaque `sessionId/takeNumber/deviceId/source/storage`, tracer des timestamps monotones et durées :
- STOP demandé, STOP reçu, début/fin `stopRecordVideo`, ACK STOP ;
- début/fin exportation SAF (si active), début/fin staging (et octets copiés) ;
- début/fin SHA source, serveur prêt, `media_ready` émis/reçu, offer émise/reçue ;
- premier octet GET, octets transférés, durée réseau, débit moyen et débit glissant ;
- fin écriture/flush, début/fin SHA destination, comparaison et ACK final ;
- attentes, retries, offsets de reprise, codes HTTP, erreurs, état du support SAF.
Distinguer **temps écoulé**, **temps de transfert réseau**, **temps de lecture/écriture** et **temps de vérification**. Ne pas journaliser les tokens d'accès HTTP.

## Plan d'essai physique minimal (à exécuter ultérieurement)
1. Baseline : même Wi-Fi, Samsung + SSD USB, 1 Capture, un Take court, métriques de chaque étape.
2. Même configuration avec plusieurs Captures ; comparer la concurrence, les débits par flux et le débit cumulé.
3. Si possible, comparer une destination interne et le SSD USB **sans changer la sémantique des fichiers ni supprimer les originaux** ; distinguer le coût SAF de celui du Wi-Fi.
4. Tester reprise après coupure et SHA final ; confirmer que l'optimisation ne fragilise pas la réplication.
Ne pas lancer de builds répétés ni déclarer PASS sans preuve physique.

## Recommandation
Priorité 1 : corriger l'observabilité des phases et mesurer le pipeline. Priorité 2 : optimiser seulement le goulet réellement mesuré. Préserver SHA-256, reprise HTTP Range, anti-écrasement et suppression source uniquement après réplication vérifiée.
