# Reconstruction de la conversation --- Projet MultiCam / Streaming

**Date : 6 septembre 2026**

> **Nature du document :** je ne dispose pas d'un export technique
> mot-à-mot de tous les anciens messages. Cette reconstruction rassemble
> les éléments encore présents dans le contexte du projet et la longue
> série de décisions issue des \~100 questions. Les formulations
> ci-dessous sont donc souvent des **reconstructions**, mais les
> décisions techniques sont conservées aussi précisément que possible.

## 1. Objectif

Créer une application Cordova Android de capture vidéo multi-appareils,
destinée à enregistrer simultanément plusieurs angles. Le parc de test
comprend environ **15 tablettes Xiaomi/Redmi identiques**. Android est
prioritaire pour le POC/V1. Le système doit fonctionner **100 % sur le
LAN, sans Internet et sans backend obligatoire**.

Préférence : plugins Cordova existants avant développement natif.

## 2. Matériel Xiaomi identifié

Modèle : **24075RP89G --- Redmi Pad SE 8.7 Wi-Fi**.

-   arrière 8 MP ;
-   avant 5 MP ;
-   720p30 / 1080p30 officiellement ;
-   MediaTek Helio G85 ;
-   encodage matériel H.264/H.265 au niveau SoC ;
-   Wi-Fi 5 2,4/5 GHz, environ 433 Mbit/s annoncé ;
-   microSD disponible.

## 3. Reconstruction des décisions issues des \~100 questions

### Rôles

Trois capacités : **Controller/Master**, **Capture**, **Storage**. Un
appareil peut cumuler plusieurs capacités. Exemples admis : Raspberry +
SATA `storage-only`, PC `controller-only` ou `controller+storage`,
tablette `capture` ou `controller+capture`. Les `capabilities` sont
distinctes des `roles` actifs.

### Plusieurs Masters

Plusieurs Controllers/Masters simultanés. Synchronisation de leur
état/UI en temps réel via WebSocket. Pas de Master unique obligatoire.

### Disparition des Controllers

La Capture continue à enregistrer si tous les Controllers disparaissent.
Tant qu'un Controller valide est présent, les commandes locales
START/STOP sont désactivées. Si tous disparaissent pendant un Take, STOP
local d'urgence devient disponible. Un nouveau Controller peut reprendre
la main et reconstruire l'état.

### Take Owner

Le Controller qui lance le Take devient **Take Owner**. Son seul
privilège spécial : pendant `STOP_PENDING`, il peut forcer l'arrêt
immédiat. Tout Controller peut demander STOP ou annuler STOP_PENDING. Si
le Take Owner disparaît, le Take continue.

### Réseau

Architecture **peer-to-peer LAN**, sans serveur/backend obligatoire.
**mDNS/Bonjour** comme découverte principale, QR/code session en
secours. Après connexion : HELLO avec `deviceId`, nom, capabilities,
version app. L'IP n'est jamais l'identité.

### deviceId / nom / tags

`deviceId` = UUID unique, persistant et normalement immuable. `name`
humain éditable, prérempli au premier lancement avec le nom Android si
possible. Tags multiples par session : `gauche`, `guitare`,
`plan serré`, etc. Tags importables depuis une autre session.
Modifications descriptives/configuratives verrouillées pendant Take
actif.

### Métadonnées matériel

Collecte automatique : constructeur, modèle, Android, version app, etc.
Pas de saisie manuelle.

### Session / Take

Une Session contient plusieurs Takes. Un Take est une période
synchronisée START→STOP. Avant chaque Take, le Master sélectionne les
Captures. Sélection précédente proposée par défaut mais modifiable.

### Ajout/retrait Capture pendant Take

Autorisé. Ajout : `ARMING -> READY/WARNING/ERROR -> RECORDING`. Chaque
ajout possède son `startedOffsetMs`. Retirer une Capture arrête son REC
mais elle reste liée au Take pour hash/transfert/suppression. Réajout =
nouveau clip.

### Pas de PAUSE

START/STOP uniquement. Une interruption/reprise crée un nouveau clip.
Une Capture peut donc produire plusieurs clips dans un Take.

### Perte Wi-Fi

Une Capture continue localement. À la reconnexion, elle annonce état,
takeId, timestamp de départ, etc. Si aucun Controller ne revient avant
la fin, STOP local possible.

### ARM

`SELECTED -> ARMING -> READY/WARNING/ERROR`. ARM prépare/vérifie caméra,
encodeur, permissions, stockage et configuration. Une erreur d'une
Capture **ne bloque jamais le START global**. L'échec et sa raison sont
journalisés. WARNING non bloquant.

### Configuration avant/durant REC

Paramètres librement modifiables avant ARM. ARM est la validation
finale. Pendant REC, configuration figée en V1.

### START

Deux modes : immédiat ou programmé avec countdown configurable.
Countdown hérité du Take précédent.

### Synchronisation START

Mesure Controller↔Capture par ping/pong type NTP, puis envoi d'un
instant absolu futur corrigé pour chaque Capture. Le POC doit mesurer
l'écart réel obtenu. Pas de cible arbitraire en ms avant mesure. Audio
commun utilisable ensuite pour synchro fine.

### Countdown

Visible Controllers + Captures sélectionnées si overlay HTML possible.
Pas de beep/vibration par défaut.

### STOP

`STOP_PENDING`, environ 10 s à ce stade. Tous les Controllers voient le
compte à rebours et peuvent annuler. Take Owner peut force-stop. À
expiration, arrêt des Captures actives. Initiateur/action journalisés.

### Crash/reboot Capture

Recovery automatique. Si état local indique participation à un Take
actif : récupération, reconnexion, resync, ARM, nouveau clip, reprise
REC. Même sans Controller joignable après reboot, préférence donnée à
**sur-enregistrer plutôt que perdre des images**.

### État recovery local

Persister `sessionId`, `takeId`, participation, config, clips,
timestamps, état. Mise à jour sur événements significatifs
(ARM/START/nouveau clip/STOP/erreur), pas en continu. STOP marque
terminé.

### MP4 après crash

Réparation sophistiquée d'un MP4 non finalisé : pas prioritaire V1.

### Lifecycle Take

Au minimum `RECORDING -> STOPPED -> COMPLETE`. STOPPED = REC terminé,
hash/transferts possibles. COMPLETE = traitements/transferts attendus
terminés.

### Nouveau Take avant COMPLETE

Autorisé. Si une Capture recommence REC, ses hash/transferts sont mis en
pause puis reprennent après.

### Files de transfert

FIFO : Takes les plus anciens puis clips chronologiques.

### Take suivant

Duplique la configuration opérationnelle : Captures, Storages,
résolution, qualité, caméra, audio, orientation, GPS, preview,
countdown, transfert/suppression, overrides. Modifiable avant START.

### Numérotation

`Take 001`, `Take 002`... Label humain optionnel. ID/numéro technique
immuable.

## 4. Vidéo

Modèle : **config globale Take -\> override appareil -\> capacité/état
réel**.

-   Codec : pas configurable V1 ; stocker codec réel si détectable.
-   FPS : pas configurable V1 ; stocker FPS réel si détectable.
-   Résolutions : HD 1280×720, Full HD 1920×1080, 4K 3840×2160 ; Full HD
    par défaut.
-   Qualité : Éco / Normal / Haute ; Haute par défaut ; mapping
    `quality` à mesurer.
-   Caméra : avant/arrière, global + override ; arrière par défaut.
-   Orientation : Paysage/Portrait ; Paysage par défaut ; verrouillée
    pendant REC.
-   Zoom/focus/exposition/WB : automatiques en V1.

## 5. Audio

ON/OFF uniquement, global + override, **ON par défaut**. Pas de choix
entrée, codec, rate, bitrate ou gain. Android/plugin choisit l'entrée.
Audio utile pour synchro postproduction.

## 6. Stockage

Capture et Storage remontent espace libre. Afficher si possible **durée
d'enregistrement restante estimée**. Choix destination interne/microSD,
global + override.

Volume choisi absent avant START : fallback vers volume utilisable +
WARNING. Volume défaillant pendant REC : pas de hot-switch ; seule la
Capture concernée s'arrête/erreur.

Avant saturation : alerte Masters et arrêt propre de la Capture
concernée. Seuil simplifié évoqué : \~1 Go, à considérer provisoire.

Un fichier par clip en V1 ; pas de segmentation volontaire.

## 7. Transferts

Transfert automatique activé par défaut au premier Take puis hérité.
Clip transférable dès fermeture.

**Règle stricte : un appareil en RECORDING ne participe à aucun
transfert média en émission ou réception.** Commandes, télémétrie, GPS
et preview JPEG restent autorisés.

WebSocket = contrôle/progression ; HTTP = gros fichiers reprenables par
offset/chunks.

Concurrence configurable par Storage (ex. Raspberry 2, PC 6, tablette
1--2). FIFO.

**Réplication complète** : chaque Storage sélectionné reçoit tous les
médias. Avant transfert, vérifier que chaque Storage peut contenir
l'ensemble.

Intégrité : taille + SHA-256. Hash calculé après clip, lorsque
l'appareil ne REC pas. Storage recalcule et compare.

Suppression locale automatique **activée par défaut**, mais uniquement
après copies vérifiées sur **tous les Storage attendus**. Sans Storage :
ni transfert ni suppression, WARNING.

Pas de suppression automatique sur Storage.

Storage disparu : transfert pending, reprise au retour, original
conservé. Après STOP, un Master peut retirer un Storage attendu pour
débloquer completion/suppression ; action journalisée.

Storage ajoutable/retirable pendant Take. À STOP, liste destinations
figée. **Pas d'ajout Storage après STOP.** Retrait après STOP possible.
Pas de Storage→Storage en V1.

## 8. Gestion distante médias

Master peut inventorier et supprimer à distance fichiers, plusieurs
fichiers, Take entier ou tout. Confirmation obligatoire. Afficher état
de réplication avant suppression. Pas d'historique local sophistiqué V1.

## 9. Preview distante

JPEG basse résolution par WebSocket, environ **1 image/s/appareil par
défaut**, y compris pendant REC. Exception explicite à la règle « pas de
transfert média pendant REC ».

Si charge : réduire d'abord poids/résolution/fréquence. Fréquences
candidates 0,2 / 0,5 / 1 / 2 fps. Profils faible/normal/élevé. Boost
3--5 fps reporté V2+.

## 10. Batterie/télémétrie

Niveau batterie + éclair si charge. Événements Android si possible.
Température batterie informative si disponible. RSSI Wi-Fi informatif.
**Aucune adaptation automatique de qualité selon Wi-Fi en V1.**

## 11. GPS

Chaque appareil géolocalisable peut remonter/stocker sa position.
Controller-only peut servir de tracking station.
`watchPosition`/callbacks préférés au polling.

Profils : Off / Eco / Normal / Précis. **Normal par défaut.**

Chaque point : latitude, longitude, accuracy, altitude, speed, bearing
si disponibles + `offsetMs`. JSON source de vérité ; GPX exportable plus
tard.

## 12. Permissions / lifecycle

État permissions local + remonté Masters. ARM vérifie caméra, micro,
localisation, stockage. Permission absente = WARNING/ERROR selon impact,
sans bloquer les autres.

`cordova-plugin-insomnia` déjà validé par l'utilisateur. Pendant REC :
empêcher veille/verrouillage autant que possible, réduire luminosité
puis restaurer, bloquer sortie volontaire autant que possible,
verrouiller orientation. Hors REC : best effort, pas de foreground
service complexe uniquement pour découvrabilité V1.

## 13. Métadonnées sans DB

**Pas de base de données pendant capture.** JSON/manifests comme source
de vérité.

`session.json` : identité/config session, appareils connus, PIN pendant
ouverture.

`take.json` : config, participants, Storages attendus, clips,
événements, GPS, transferts, timestamps/offsets, SHA-256.

Écritures atomiques souhaitées. Storage conserve manifests originaux +
manifest agrégé.

Temps : `take.startedAt` UTC absolu ; clips/GPS/events en `offsetMs`.

## 14. Journal

Événements : connect/disconnect, changement Controller,
ARM/READY/WARNING/ERROR, START/STOP, erreur caméra, perte/reconnexion
réseau, transfert, suppression, profils, Storage add/remove, etc.
Actor/source `deviceId`/controller/capture/system.

## 15. PIN / sécurité session

Capture-only découverte mais ne s'ajoute jamais seule à un Take. Seul
Master sélectionne. Devenir Controller/Master nécessite PIN.

PIN aléatoire **4 chiffres**, stocké dans `session.json` pendant session
ouverte. Fermeture : PIN retiré. Réouverture : nouveau PIN.

Conflits multi-Masters : **last-write-wins** V1, actions journalisées et
état résultant diffusé. Pas de locking complexe.

## 16. Auto-rejoin

Au lancement, tentative de rejoindre dernière session si ouverte.
Capture-only rejoin session ≠ auto-join Take. Session fermée : retour
découverte/création. Réseau absent : OFFLINE puis recherche au retour.
Recovery Take actif reste prioritaire.

## 17. Nommage fichiers

Technique et déterministe, indépendant des noms humains :

``` text
SESSION_20260905_001/
  TAKE_003/
    <deviceId>/
      clip_001.mp4
```

Noms/tags humains dans manifests.

## 18. Question 123 / stratégie POC

La dernière question explicitement conservée était approximativement :

> Valider d'abord avec 3 Xiaomi : découverte LAN, Master + Captures,
> ARM, START synchronisé, 1080p/qualité haute/audio, preview JPEG
> pendant REC, STOP, mesure synchro, durée suffisante pour
> stabilité/chauffe, JSON/SHA-256 ; puis passer à 15 appareils.

Réponse utilisateur : **avant cela, tester tous les plugins souhaités et
leurs incompatibilités**.

Cela crée la **Phase 0 --- qualification Cordova mono-device**.

## 19. Phase 0 --- plugins

Plugins/briques : Camera Preview, Insomnia, batterie, GPS, permissions,
diagnostic, File, orientation, luminosité, ZeroConf/mDNS, SocialSharing
pour export.

Méthode : isolément -\> combinaisons -\> ensemble -\> seulement ensuite
multicam.

## 20. Plugin Lab initial

À partir du `www` d'une ancienne app contenant déjà des tests de droits
: détection plugins, permissions, batterie, Insomnia, GPS, diagnostic,
Camera Preview, snapshot, REC, File, orientation, luminosité, mDNS, test
combiné, journal.

Samsung de test : **SM-A226B, Android 13, SDK 33, Cordova 15.1.0**.

Validés : permissions, batterie, Insomnia, GPS, diagnostic, File,
orientation, luminosité, mDNS.

REC initial : `REC start KO Illegal access`.

## 21. Export diagnostic

Ajout demandé pour éviter copier/coller l'UI : TXT + JSON + partage
Android. Contenu : appareil, plugins, permissions, états, résultats,
journal.

## 22. Diagnostic caméra v0.3

Ajout avant/arrière, 1080p/720p/480p, qualités 100/85/50, types
callbacks, STOP nettoyage.

Snapshot réellement OK : callback = **tableau contenant le Base64
JPEG**.

REC toujours `Illegal access`. STOP après échec : `MediaRecorder.stop()`
sur null. Conclusion : MediaRecorder pas initialisé.

## 23. Master officiel camera-preview

Inspection du master GitHub : sur Android 13+, le code REC vérifie
CAMERA, RECORD_AUDIO, READ_MEDIA_IMAGES et READ_MEDIA_VIDEO, alors que
le `plugin.xml` ne déclarait pas correctement les deux permissions média
modernes.

## 24. Camera Lab v0.4

UI débarrassée de GPS/batterie/Insomnia/mDNS/etc. pour focus REC. Plugin
installé depuis **master GitHub officiel**. Ajout explicite :

``` xml
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
```

Résultat Samsung :

-   CAMERA OK ;
-   RECORD_AUDIO OK ;
-   READ_MEDIA_IMAGES OK ;
-   READ_MEDIA_VIDEO OK ;
-   1920×1080 qualité 100 : **REC OK** ;
-   1280×720 qualité 85 : **REC OK** ;
-   640×480 qualité 50 : **REC OK** ;
-   STOP OK, chemin MP4 retourné.

Décision : utiliser le **master GitHub** + permissions Android 13
corrigées.

## 25. Preview pendant REC / v0.5

Test suivant : `Preview -> REC -> snapshot ~1 Hz pendant 30 s -> STOP`.

À la demande utilisateur : rendre fond/cards semi-transparents car la
preview native se trouve sous la WebView et les cards opaques la
masquaient.

v0.5 : UI transparente/semi-transparente + test 30 s + compteurs +
export.

## 26. Continuation retrouvée dans l'autre conversation

Éléments récupérés de la continuation ultérieure :

-   Camera Preview validée ;
-   snapshots avant/après REC validés et différents ;
-   JPEG observés en 720×1080 ;
-   enregistrement vidéo observé en 1280×720 ;
-   **30 appels `takeSnapshot()` pendant un REC de 30 s sur Samsung
    SM-A226B/Android 13 n'ont produit ni callback success ni callback
    error.**

Donc `takeSnapshot()` fonctionne hors REC mais semble rester sans
callback pendant l'enregistrement sur ce device/plugin.

### Piste PixelCopy

Une version ultérieure dite **v0.9 PixelCopy** devait tester une capture
directe de la Surface de preview pendant REC.

État retrouvé :

-   PixelCopy n'avait pas réellement été testé car
    `capturePreviewSurface()` était absente de l'APK installé ;
-   patch appliqué dans `plugins/` ;
-   rebuild Cordova d'abord bloqué par CLI/modules ;
-   puis module npm `xcode` manquant ;
-   `npm install xcode --save-dev` a ensuite réussi.

## 27. État actuel consolidé

### Validé

Architecture MultiCam, LAN sans backend, rôles, multi-Masters, Take
Owner, Sessions/Takes, ARM/START/STOP, recovery, stockage, transferts,
SHA-256, suppression, GPS, télémétrie, JSON, PIN, auto-rejoin, Camera
Preview, permissions, REC Android, résolutions, snapshot hors REC, File,
Insomnia, batterie, GPS, mDNS, luminosité/orientation.

### Priorité restante

**Obtenir une preview JPEG pendant REC.**

`takeSnapshot()` ne rappelle apparemment ni success ni error pendant REC
sur le Samsung de test.

Piste en cours : **PixelCopy / capture directe de la Surface native**,
éventuellement via adaptation du plugin.

## 28. Ordre de reprise conseillé par l'état du projet

1.  Reprendre le Camera Lab au point PixelCopy.
2.  Vérifier que la modification native est réellement embarquée dans
    l'APK.
3.  Tester capture preview pendant REC sans `takeSnapshot()`.
4.  Mesurer l'impact sur le REC.
5.  Une fois validé, refaire un test combiné des plugins déjà qualifiés.
6.  POC **3 Xiaomi** : mDNS, Controller, ARM, START synchronisé, 1080p,
    preview, STOP, mesure synchro.
7.  Puis test **15 appareils**.

------------------------------------------------------------------------

## Note sur les « 100 questions »

Le contexte encore disponible ne contient pas le verbatim des questions
1 à 122. Il conserve en revanche de manière détaillée **les décisions
qui en résultaient**, restituées ci-dessus. La dernière question
explicitement identifiable est la **Question 123**, sur la stratégie 3
appareils puis 15, avant que la Phase 0 de qualification des plugins
soit ajoutée.

Ce document est donc destiné à servir de **pont entre les deux
conversations** sans perdre le cahier des charges construit pendant
cette longue phase de questions.
