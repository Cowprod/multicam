# Validation matérielle MultiCam — 29 octobre 2026

P0 validé sur les trois Redmi Capture. P1 validé en fonctionnement nominal vers la Samsung R83Y106V1HF. Les limites observées après coupure réseau sont précisées ci-dessous.

## Cause et corrections

Le workspace serveur était propre, détaché sur 0bb9faa. Les sources Java dans plugins/ et platforms/ étaient upstream, sans les patchs versionnés, et l'APK installé ne contenait pas les méthodes getCameraState/cameraStateJson (inspection DEX). La compilation ordinaire ne passait pas par setup-android.sh, seul chemin appliquant jusque-là les patchs.

- `getCameraState: Invalid action` : le shim JS appelait une action absente du dispatcher Java embarqué.
- `startRecordVideo: Illegal access` : le dispatcher upstream exigeait CAMERA, RECORD_AUDIO, READ_MEDIA_IMAGES et READ_MEDIA_VIDEO. Les deux dernières permissions n'étaient pas déclarées dans le manifeste installé. Le refus retournait explicitement PluginResult.Status.ILLEGAL_ACCESS_EXCEPTION avant MediaRecorder ; ce message ne provenait pas d'une exception Camera/MediaRecorder. CAMERA et RECORD_AUDIO étaient accordées. La direction vide était une conséquence de la lecture native impossible ; startRecord utilise la caméra déjà ouverte.
- Après restauration des patchs, le test distribué a révélé `PROFILE_UNKNOWN null` : Android org.json convertissait le null JSON en chaîne via optString. Les deux chemins natifs, immédiat et après permissions, utilisent maintenant isNull avant getString.
- Le hook after_prepare réapplique les patchs caméra, recopie le Java compilé et synchronise les deux wrappers JS avec leur enveloppe cordova.define. Il synchronise aussi les sources Java SAF/transfert locales. Un second build ordinaire a produit le même APK signé que le build testé sur Samsung.
- STOP copie d'abord la vidéo finalisée dans files/recordings, puis la publie dans le dossier SAF choisi. Sans dossier SAF, publication MediaStore dans DCIM/MultiCam. Aucune dépendance réseau pour cette finalisation. Les erreurs de copie/export sont journalisées et retournées avec le chemin de récupération conservé.
- Le transfert SAF renvoyait `saf_unverified` au lieu d'un SHA-256. Il relit désormais le document enregistré et vérifie taille et empreinte après fermeture de l'écriture.

## Déploiement

Installations ADB avec remplacement, même signature debug que l'application existante ; aucune désinstallation ni remise à zéro. Le Mac et le compte SSH avaient d'autres clés debug : la clé du service devmcp a été copiée par l'utilisateur pour signer les mises à jour.

Les cinq appareils ont été mis à jour. Les trois Captures ont ensuite reçu le correctif de null natif et la Samsung le correctif de SHA-256 SAF. Le Master utilise le premier build corrigé (il n'enregistre ni ne reçoit de vidéo dans cette configuration).

Les rôles de session étaient corrects, mais les cinq configurations globales activaient encore capture, storage et controller. Le boot transfert choisissait donc master sur tous les appareils. Les compétences actives ont été alignées sur l'installation dédiée : Master=controller, les trois Captures=capture, Samsung=storage. Les dossiers choisis sont conservés. Aucun contournement par un Storage sur Capture.

Workspace de compilation : /home/eimbernon/multicam-p0-20261029 sur touchdeck. Workspace devmcp original laissé intact (inaccessible en écriture au compte SSH).

## Preuves physiques

Premiers essais natifs individuels : profil explicite 720P, 12 s d'attente après ACK natif, trois MP4 H.264/AAC de 11,392 / 11,431625 / 11,421811 s, tous décodés intégralement sans erreur.

Take 5 de la session Timer / ZWASE4WD : ARM réel, REC par le service du Master, compte à rebours de 5 s, trois ACK STARTED, STOP coordonné et trois chemins de fichiers confirmés. Les appels ont utilisé le WebView de l'application physique via ADB/CDP et les services de production, sans simulation.

| Capture | Dossier public local | Octets | Durée MP4 | Vidéo |
|---|---|---:|---:|---|
| 61d54bba7d91 | /sdcard/DCIM/Camera | 30669312 | 12,352 s | H.264 1920×1080 + AAC |
| 62614ac67d91 | /sdcard/DCIM/Camera | 30646271 | 12,330667 s | H.264 1920×1080 + AAC |
| c0d8514d7d87 | /sdcard/DCIM | 30501217 | 12,266667 s | H.264 1920×1080 + AAC |

`files.json` contient chaque chemin complet sur Capture et Samsung, les tailles, les SHA-256 comparés par ADB et les résultats ffprobe. Les fichiers reçus sur Samsung ont été récupérés et entièrement décodés par ffmpeg (code de sortie 0 ; avertissements de DTS répétés du muxer null sur ces prises FHD, sans erreur de décodage). Le SHA de chaque copie reçue est identique à celui du MP4 public local.

Réception Samsung : /sdcard/DCIM/Camera/MultiCam/ZWASE4WD/5/<deviceIdCapture>/<nomMP4>. Trois transferts done / 100 %, total 91816800 octets. La synthèse persistée du Take 5 indique TERMINATED / 100 %. `master-take5.png` montre les trois barres terminées. Les sources publiques sont restées présentes ; suppression après réplication désactivée pour les Takes de qualification.

Take 6 : coupure réelle du Wi-Fi sur Master et Samsung après démarrage, puis contrôle natif de chaque Capture : recording=true. STOP local sur chacune, recording=false ensuite, et trois nouveaux MP4 publics de 23214335 / 28302917 / 33337475 octets. `offline.json` conserve les réponses natives et chemins. Wi-Fi réactivé sur les deux appareils ; aucune application redémarrée pendant REC.

## Tests et reproductibilité

- 555 tests JavaScript réussis, aucun échec (552 existants + 3 régressions sauvegarde).
- Compilation Android réussie après préparation initiale et plusieurs builds ordinaires : patchs idempotents, Java et wrappers présents.
- Certificat de signature SHA-256 : 5809a5d9439b29ab17a19e18658240a45f6d863d740d91974aa9b07430c84cac.
- APK de livraison SHA-256 : 402be1512911efe00911eb5533dd5e772b9c83fb074436022fc07692a4454c88.
- Aucun fichier utilisateur supprimé, aucune donnée applicative vidée, aucun appareil réinitialisé.

## Limites restantes

- La réannonce automatique après un STOP effectué hors connexion n'a pas repris les transferts du Take 6 : ses vidéos restent localement accessibles. P1 est validé pour le cycle nominal connecté du Take 5, pas pour cette reprise.
- L'historique du Take 5 perd deux confirmations STOP dans son résumé persisté, malgré les trois STOP reçus dans l'état vivant et les trois fichiers vérifiés. L'interface affiche donc une alerte d'absence de confirmation pour Cam 03/Cam 01, mais trois réplications terminées.
- Le Take sélectionné HD a encore utilisé le profil automatique et produit du 1080p. La propagation du profil du Take vers START reste à corriger ; le profil explicite 720P fonctionne dans les essais natifs.
- ARM affiche des avertissements d'espace libre inconnu et d'horloge. Les écarts STOP constatés sur le Take 5 sont d'environ 401–463 ms ; cette intervention ne qualifie pas une synchronisation image par image.
- Un redémarrage rapproché du Master a temporairement déplacé son port WebSocket de 45102 à 45103 (port encore occupé), empêchant certains pairs de le retrouver via l'ancien endpoint. Un redémarrage ultérieur, sans REC actif, a rétabli 45102 et les cinq connexions.

Aucune intervention utilisateur n'est nécessaire pour enregistrer localement. Les points ci-dessus ne sont pas présentés comme corrigés.
