# MultiCam — Cahier de décisions fonctionnelles et techniques

> **Document de mémoire de projet destiné à l’agent de codage**
>
> Ce fichier consolide les décisions prises au fil des échanges sur le projet MultiCam.
> Il doit être lu avec `AGENTS.md` et le projet de référence caméra.
>
> **Règle pour l’agent :** ne pas remplacer une décision ci-dessous par une supposition.
> Lorsqu’un point est marqué **À définir / À revalider**, il ne faut pas inventer la réponse.

---

## 1. Objet du projet

MultiCam est une application permettant d’utiliser **plusieurs téléphones comme caméras autonomes**.

Chaque téléphone filme et **enregistre sa propre vidéo localement en bonne qualité**.

Le système ne repose pas sur l’envoi permanent d’un flux vidéo HD vers une régie. Pendant l’enregistrement, chaque téléphone produit à intervalle régulier une **image de preview légère (snapshot)** qui peut être remontée vers la régie afin de contrôler visuellement les différentes caméras.

Schéma de principe :

```text
                         RÉGIE / CONTRÔLE
                    ┌──────────────────────┐
                    │ vues périodiques     │
                    │ état des caméras     │
                    │ commandes            │
                    └──────────┬───────────┘
                               │ réseau
             ┌─────────────────┼─────────────────┐
             │                 │                 │
             ▼                 ▼                 ▼
       TÉLÉPHONE A        TÉLÉPHONE B       TÉLÉPHONE C
       caméra locale      caméra locale     caméra locale
       REC local          REC local         REC local
       snapshots          snapshots         snapshots
```

La priorité est donc :

1. **fiabilité de l’enregistrement local** ;
2. contrôle de plusieurs téléphones ;
3. preview distante suffisamment fréquente pour vérifier cadrage/état ;
4. éviter un streaming vidéo lourd lorsqu’il n’est pas nécessaire.

---

## 2. Plateforme et technologie

### Application mobile

- Technologie : **Cordova**.
- Android est la plateforme actuellement testée et validée pour la caméra.
- L’application doit fonctionner sur de vrais téléphones utilisés comme caméras.

### Appareil de validation caméra

Le POC caméra a notamment été validé sur :

- Samsung SM-A226B ;
- Android 13 ;
- SDK 33.

Le build de référence utilise `cordova-android 15.1.0`.

---

## 3. Rôle d’un téléphone

Un téléphone est avant tout une **caméra autonome d’enregistrement**.

Il doit pouvoir :

- afficher la preview de sa caméra ;
- démarrer un enregistrement vidéo local ;
- continuer à enregistrer de manière fiable ;
- fournir périodiquement une image de contrôle pendant l’enregistrement ;
- remonter son état à la régie ;
- fournir les informations utiles telles que batterie et position GPS lorsque nécessaire ;
- rester actif malgré les mécanismes habituels de veille/verrouillage dans les limites permises par Android et les plugins retenus.

Le téléphone **ne doit pas dépendre d’un flux vidéo réseau permanent pour réaliser son enregistrement principal**.

---

## 4. Vidéo principale

### Décision

La vidéo est **enregistrée localement sur chaque téléphone**.

C’est le fichier vidéo local qui constitue la source de qualité.

Le réseau ne doit donc pas être considéré comme le support de transport du master vidéo pendant le tournage.

### Paramètres déjà testés

Le POC a validé notamment :

```text
1280 × 720
qualité : 85
caméra arrière
```

Des essais précédents ont également fonctionné en 1920 × 1080.

Ces valeurs sont des validations techniques du plugin, pas nécessairement les seuls réglages proposés dans l’application finale.

### Fichier produit

`startRecordVideo()` / `stopRecordVideo()` produit correctement un MP4 local.

---

## 5. Preview locale

La preview utilisée par `cordova-plugin-camera-preview` est une **vue Android native `SurfaceView`**.

Elle ne correspond pas à un `<video>` HTML contenu dans le DOM.

### Conséquence

L’interface Cordova peut être affichée **au-dessus** de la preview.

Configuration validée :

```js
CameraPreview.startCamera({
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight,
    camera: CameraPreview.CAMERA_DIRECTION.BACK,
    toBack: true,
    tapPhoto: false,
    tapFocus: false,
    previewDrag: false,
    storeToFile: false
});
```

Avec :

```text
toBack: true
```

la preview native est placée derrière la WebView.

La partie utile de la WebView doit donc être transparente lorsque la caméra doit rester visible.

---

## 6. Preview distante : rôle des snapshots

### Décision fondamentale

Les snapshots pris pendant l’enregistrement servent à fournir une **preview distante légère de chaque caméra à la régie**.

Ils permettent notamment de vérifier :

- que la caméra fonctionne ;
- ce qu’elle cadre ;
- son évolution pendant le tournage ;
- que le téléphone continue à fournir des images.

### Ce qu’ils ne sont pas

Les snapshots :

- ne sont pas le master vidéo ;
- ne remplacent pas le fichier vidéo enregistré localement ;
- ne sont pas destinés à constituer une archive photo ;
- ne sont pas un mécanisme d’analyse IA défini dans ce projet.

Leur conservation permanente n’est donc pas un besoin fonctionnel établi.

Dans le lab uniquement, ils sont conservés dans le JSON afin de pouvoir diagnostiquer et comparer les images.

---

## 7. Capture d’image pendant l’enregistrement

C’est un point technique qui a fait l’objet d’un POC spécifique.

### Méthode native du plugin : invalidée pendant REC

`CameraPreview.takeSnapshot()` fonctionne avant et après un enregistrement.

En revanche, sur l’appareil de référence, pendant `startRecordVideo()` :

```text
takeSnapshot()
```

ne déclenche **ni callback succès ni callback erreur**.

Ce comportement a été reproduit avec :

- de nombreux appels rapprochés ;
- puis trois appels isolés à +5 s, +15 s et +25 s.

La méthode est donc **à ne pas utiliser pour la preview distante pendant REC**.

### Cause technique identifiée

Le plugin Android repose sur l’ancienne API :

```java
android.hardware.Camera
```

`takeSnapshot()` passe par un `Camera.PreviewCallback`.

Pendant l’enregistrement, la caméra est déverrouillée et donnée à `MediaRecorder`.

Sur le Samsung de référence, ce chemin ne permet plus d’obtenir le callback preview attendu.

---

## 8. Solution validée : Android PixelCopy

Une méthode spécifique a été ajoutée au plugin :

```js
CameraPreview.capturePreviewSurface(
    { quality: 70 },
    success,
    error
);
```

### Principe

La méthode Android utilise :

```java
PixelCopy.request(...)
```

sur le `SurfaceView` natif qui affiche la preview.

Chemin :

```text
Camera
   │
   ├────> MediaRecorder ────> fichier MP4 local
   │
   └────> SurfaceView
               │
               ▼
           PixelCopy
               │
               ▼
             Bitmap
               │
               ▼
              JPEG
               │
               ▼
             Base64
               │
               ▼
             régie
```

PixelCopy ne demande donc pas une seconde photo au pipeline `Camera.PreviewCallback`.

Il copie l’image effectivement rendue dans la surface native.

### Validation

Test de 30 secondes :

```text
REC : OK
PixelCopy +5 s  : OK
PixelCopy +15 s : OK
PixelCopy +25 s : OK
REC stop : OK
```

Temps observés :

```text
127 ms
66 ms
65 ms
```

Les images ont été extraites du diagnostic et contrôlées visuellement.

**Décision : PixelCopy est la méthode de référence pour produire les images de preview pendant le REC sur Android.**

### Limite actuelle

La réussite de trois captures pendant 30 secondes est validée.

Une cadence continue, par exemple :

```text
1 snapshot / seconde
```

pendant une très longue durée n’a pas encore été qualifiée comme test d’endurance.

Elle peut être utilisée comme cible de conception, mais l’agent ne doit pas inscrire « endurance 1 Hz validée » tant que ce test n’a pas été réalisé.

---

## 9. Patch du plugin caméra

Le projet de référence contient :

```text
pixelcopy-patch/apply_pixelcopy_patch.py
```

Il ajoute `capturePreviewSurface()` à `cordova-plugin-camera-preview`.

Après une réinstallation du plugin ou une reconstruction complète de la plateforme Android :

```bash
python3 pixelcopy-patch/apply_pixelcopy_patch.py .
cordova prepare android
cordova build android
```

Vérification :

```bash
grep -R "capturePreviewSurface" platforms/android | head -20
```

La méthode doit apparaître :

- dans le Java du plugin ;
- dans `CameraPreview.js` ;
- puis dans les classes/dex générés après compilation.

### À terme

Le patch local est adapté au POC.

Pour un projet maintenable, il faudra probablement transformer cette modification en :

- fork maîtrisé du plugin ;
- ou plugin Cordova dédié.

Ne pas perdre la modification PixelCopy lors de cette évolution.

---

## 10. Batterie

La remontée de batterie fait partie des informations prévues pour les téléphones caméras.

Du code provenant d’une autre application existe déjà et doit pouvoir être réutilisé.

Le POC plugins a déjà confirmé la présence et le fonctionnement de la remontée batterie.

La batterie doit être considérée comme une information d’exploitation importante pour une caméra distante.

---

## 11. GPS / GPX

Le projet prévoit la récupération des informations GPS.

Du code provenant d’une autre application Cordova existe déjà pour :

- GPS ;
- GPX ;
- gestion associée.

Ce code pourra être réintégré plutôt que réinventé.

Le rôle précis du GPX dans le workflow final devra rester conforme aux décisions fonctionnelles du projet ; ne pas inventer un usage supplémentaire.

---

## 12. Permissions Android

Le projet doit gérer proprement les permissions nécessaires.

Du code d’une autre application existe déjà pour les demandes de permissions.

Les permissions caméra, stockage/média, localisation ou autres doivent être demandées selon les fonctionnalités réellement utilisées et selon la version Android.

Ne pas reconstruire une nouvelle stratégie de permissions sans regarder d’abord le code existant qui sera fourni.

---

## 13. Veille, verrouillage et maintien actif

Une caméra en cours de tournage doit rester opérationnelle.

Du code provenant d’une autre application existe déjà pour maintenir l’application active malgré la veille/verrouillage, avec les limites Android correspondantes.

Le projet de lab contient notamment `cordova-plugin-insomnia`.

**Principe fonctionnel : un enregistrement ne doit pas être interrompu simplement parce que l’écran voudrait passer en veille.**

L’intégration finale doit être testée sur une vraie durée de tournage.

---

## 14. Réseau

Le réseau sert au **pilotage et à la remontée d’état/preview**, pas au stockage du master vidéo.

Cela permet de limiter :

- la bande passante ;
- la sensibilité aux coupures ;
- la charge sur la régie ;
- la consommation liée à plusieurs streams vidéo permanents.

Le projet de lab contient notamment `cordova-plugin-zeroconf`, ce qui permet d’envisager la découverte locale, mais **le protocole final de découverte/communication n’est pas figé dans ce document**.

Ne pas inventer une architecture serveur ou un protocole réseau définitif si elle n’a pas été décidée dans le code/projet principal.

---

## 15. Résilience réseau

Conséquence directe de l’architecture :

```text
perte réseau ≠ perte automatique du master vidéo
```

Puisque le téléphone enregistre localement, une interruption de communication avec la régie ne doit pas, par conception, détruire l’enregistrement déjà en cours.

Le comportement précis des commandes lors d’une reconnexion reste à implémenter/tester proprement.

---

## 16. Synchronisation des caméras

Le système doit être conçu pour plusieurs téléphones.

Les commandes de tournage doivent donc être pensées comme des commandes pouvant concerner :

- une caméra ;
- plusieurs caméras ;
- toutes les caméras.

La précision temporelle nécessaire à la synchronisation finale n’est pas redéfinie ici.

**Ne pas supposer qu’un simple timestamp JavaScript constitue une synchronisation audiovisuelle parfaite.**

---

## 17. Interface du téléphone caméra

L’UI du lab actuel **n’est pas l’UI finale**.

Elle a été créée pour valider les plugins et le pipeline caméra.

### Direction validée

L’application caméra doit privilégier :

- la preview plein écran ;
- une UI superposée ;
- un état d’enregistrement parfaitement visible ;
- les informations d’exploitation utiles ;
- peu de commandes ambiguës.

### Retour d’expérience du lab

L’interface de diagnostic est devenue trop chargée lorsque chaque test disposait de son propre bouton.

Décision prise pendant le POC :

- retirer progressivement de l’UI les éléments déjà validés ;
- préférer **un bouton de test unique** pour le lab ;
- afficher un **décompte/temps restant** pendant un test afin que l’état soit sans ambiguïté ;
- afficher clairement la **version du lab en haut de l’écran** pour éviter de confondre deux APK/diagnostics.

Ces principes de clarté doivent être conservés dans l’UI finale : un utilisateur ne doit jamais se demander si la caméra enregistre ou quelle action il doit effectuer.

---

## 18. Interface de régie

La régie doit être pensée dès le départ pour **plusieurs téléphones**, et non comme l’agrandissement de l’écran d’une caméra unique.

Elle doit permettre de distinguer clairement :

```text
vue globale des caméras
caméra sélectionnée
état d’enregistrement
preview périodique
état technique du téléphone
```

Les snapshots PixelCopy sont précisément destinés à alimenter cette vue de contrôle sans nécessiter un flux vidéo HD permanent.

La conception visuelle détaillée de la régie est l’étape suivante du projet.

---

## 19. États des caméras

Les états exacts de l’UI finale doivent être cohérents avec le protocole réel.

À minima, l’agent doit pouvoir distinguer conceptuellement :

```text
caméra joignable / non joignable
prête / non prête
enregistrement actif / inactif
erreur
```

Les noms définitifs, couleurs et règles de transition sont à définir avec l’UI/protocole.

Ne pas figer arbitrairement une machine à états plus complexe sans validation.

---

## 20. Diagnostics

Le POC dispose d’un export JSON.

Cet export s’est révélé important pour :

- identifier l’appareil ;
- identifier les plugins ;
- suivre chaque étape du test ;
- conserver les callbacks et erreurs ;
- vérifier les snapshots ;
- comparer plusieurs versions du lab.

Le projet final doit conserver une capacité de diagnostic suffisamment exploitable pour dépanner un téléphone à distance.

Le format final peut évoluer, mais supprimer toute capacité de diagnostic serait une régression.

---

## 21. Version visible

Pendant les tests, plusieurs APK successifs ont produit des diagnostics similaires.

Décision :

**la version de l’application/lab doit être clairement visible dans l’interface de diagnostic.**

Cela évite de tester par erreur un ancien APK et de tirer de fausses conclusions.

Cette règle est particulièrement importante pendant la phase de développement et de déploiement terrain.

---

## 22. Ce qui est techniquement VALIDÉ

```text
[VALIDÉ] Cordova Android sur appareil réel
[VALIDÉ] preview caméra native
[VALIDÉ] preview plein écran derrière WebView
[VALIDÉ] UI HTML au-dessus de la preview
[VALIDÉ] enregistrement vidéo local
[VALIDÉ] 1280×720 / qualité 85
[VALIDÉ] essais vidéo 1920×1080
[VALIDÉ] snapshot avant REC
[VALIDÉ] snapshot après REC
[INVALIDÉ pour cet usage] takeSnapshot() pendant REC
[VALIDÉ] PixelCopy pendant REC
[VALIDÉ] 3 PixelCopy distincts pendant un REC de 30 s
[VALIDÉ] export JSON de diagnostic
[VALIDÉ] extraction/contrôle visuel des JPEG PixelCopy
[VALIDÉ] remontée batterie dans le lab plugins
```

---

## 23. Ce qui reste À TESTER / À FIGER

```text
[À TESTER] PixelCopy à cadence régulière (cible initiale : ~1 Hz)
[À TESTER] endurance sur une durée réaliste de tournage
[À TESTER] impact CPU / mémoire / chauffe / batterie de PixelCopy régulier
[À TESTER] comportement écran verrouillé / veille pendant un vrai tournage
[À TESTER] comportement en perte/reprise réseau
[À FIGER] protocole de communication régie ↔ caméras
[À FIGER] mécanisme de découverte des caméras
[À FIGER] transfert/récupération finale des fichiers vidéo
[À FIGER] règles précises de synchronisation
[À CONCEVOIR] UI finale du téléphone caméra
[À CONCEVOIR] UI de régie multi-caméras
```

Ces points ne doivent pas être transformés en décisions implicites par l’agent.

---

## 24. Anti-régressions / choses à ne pas refaire

### Ne pas revenir à `takeSnapshot()` pendant le REC

Le problème est reproduit et compris.

### Ne pas tenter de lire la preview avec du JavaScript DOM

La caméra est rendue dans un `SurfaceView` natif.

Ceci n’est donc pas une solution :

```js
canvas.drawImage(unDivQuiContientLaPreview)
```

Le div ne contient pas les pixels de la caméra.

### Ne pas remplacer PixelCopy par un stream vidéo sans décision fonctionnelle

Le choix de snapshots périodiques répond précisément à l’architecture d’enregistrement local + preview légère.

### Ne pas considérer le lab comme l’application finale

Le lab sert à isoler et valider les briques techniques.

### Ne pas supprimer les diagnostics trop tôt

Ils ont déjà permis d’identifier plusieurs faux diagnostics dus à des APK/patchs différents.

---

## 25. Plugins observés dans le lab

Lors de la recréation de la plateforme Android, les plugins suivants ont notamment été présents :

```text
cordova-plugin-add-swift-support
cordova-plugin-android-permissions
cordova-plugin-battery-status
cordova-plugin-brightness
cordova-plugin-camera-preview
cordova-plugin-device
cordova-plugin-file
cordova-plugin-geolocation
cordova-plugin-insomnia
cordova-plugin-screen-orientation
cordova-plugin-x-socialsharing
cordova-plugin-zeroconf
cordova.plugins.diagnostic
```

Cette liste décrit l’environnement du POC.

**Elle ne signifie pas que chaque plugin est obligatoire dans l’application finale.**

En particulier, `cordova-plugin-add-swift-support` est un ancien plugin lié à iOS qui a provoqué des problèmes de dépendances npm pendant un rebuild Android. Ce problème est indépendant du pipeline caméra/PixelCopy.

---

## 26. Philosophie d’implémentation pour l’agent

Le code produit doit séparer au minimum :

```text
UI
│
├── état fonctionnel de la caméra
│
├── commandes
│
└── affichage preview/états
     │
     ▼
service caméra Cordova
│
├── start preview
├── start/stop recording
├── PixelCopy snapshot
└── erreurs/état
     │
     ▼
transport régie
│
├── commandes
├── état
└── snapshots
```

Éviter que la logique caméra soit dispersée directement dans tous les handlers UI.

Le lab actuel peut servir de preuve d’API et d’exemple, mais pas de modèle architectural complet.

---

## 27. Principe directeur

En cas de doute lors d’une évolution, préserver d’abord ce contrat :

> **Chaque téléphone doit être capable de réaliser de manière fiable son enregistrement vidéo local, pendant que la régie peut surveiller et piloter plusieurs caméras avec un trafic réseau raisonnable.**

Tout choix technique qui fragilise l’enregistrement local uniquement pour améliorer la preview distante doit être considéré avec prudence.

---

## 28. Sources de vérité du projet

Pour l’agent de codage, l’ordre de priorité est :

1. ce fichier pour les décisions fonctionnelles consolidées ;
2. `AGENTS.md` pour les consignes techniques caméra ;
3. `docs/TECHNICAL_REFERENCE.md` pour PixelCopy et le plugin ;
4. `docs/VALIDATED_TESTS.md` pour les résultats effectivement testés ;
5. `docs/KNOWN_LIMITATIONS.md` pour éviter les extrapolations ;
6. le diagnostic JSON validé comme preuve brute ;
7. le code du lab comme exemple exécutable.

Si deux éléments semblent se contredire, **ne pas inventer une résolution** : signaler le conflit avant de modifier le comportement.

---

## 29. Note sur les décisions historiques non récupérées

Ce document rassemble les décisions MultiCam actuellement récupérables dans le contexte du projet et les validations réalisées pendant le POC caméra.

Il ne prétend pas inventer les réponses historiques qui ne sont plus accessibles textuellement.

Lorsqu’une ancienne décision n’apparaît pas ici et n’est pas présente dans les fichiers de référence, elle doit être considérée comme **non récupérée**, et non reconstruite par supposition.



---

## 30. J04 — Sessions + second Master : décisions d’architecture

**Date de consolidation : 20 septembre 2026**

Cette section fige les décisions prises avant l’implémentation du jalon J04.  
Les points explicitement marqués **À CONFIRMER** ne doivent pas être tranchés implicitement par l’agent.

### 30.1 Périmètre J04

J04 couvre uniquement :

- création d’une session réelle ;
- `sessionId` persistant ;
- nom de session ;
- PIN Master à 4 chiffres ;
- découverte d’une session sur le LAN ;
- second Controller/Master rejoignant la session via l’écran 02 ;
- persistance locale de l’identité de session ;
- synchronisation minimale entre Masters ;
- reprise après kill/restart ;
- écran 03 comme vue réelle de session.

Restent hors J04 :

- membres Capture/Storage et `sessionRoles` : J05 ;
- Takes : J06 et suivants ;
- ARM, synchronisation d’horloge, countdown, REC, preview, STOP, transferts : jalons ultérieurs.

### 30.2 Séparation des briques

Décision d’architecture retenue :

- J03 conserve `cordova-plugin-multicam-nsd` pour la découverte device et `/health` ;
- J04 **ne doit pas introduire de plugin Cordova dédié aux sessions** ;
- la communication de session doit suivre l’architecture **WebSocket** retenue lors de la conception ;
- ne pas transformer `HealthServer.java` en serveur de session.

### 30.3 Service réseau J04

Cible retenue :

- port de base session : **45102** ;
- fallback sur les ports suivants en cas d’occupation, selon le même principe que le serveur J03 ;
- type DNS-SD session distinct : **`_multicam-session._tcp.`** ;
- le PIN ne doit jamais apparaître dans le TXT DNS-SD.

Le TXT de session reste minimal et peut contenir les métadonnées nécessaires à la découverte, notamment :

- `sessionId` ;
- nom de session ;
- `masterDeviceId` / device annonceur ;
- port effectif ;
- version de protocole/application.

Ne pas y placer d’état volumineux ni de secret.

### 30.4 Découverte ≠ liveness

Le comportement Android observé et validé en J03 impose la règle suivante :

> Une résolution mDNS/DNS-SD réussie n’est pas une preuve suffisante de joignabilité.

En particulier, le cache NSD Android peut continuer à résoudre un peer pendant une coupure réseau sub-TTL.

Donc :

- mDNS/DNS-SD sert à **découvrir** une session ;
- la joignabilité réelle d’un Master/session est déterminée par la couche applicative WebSocket et son heartbeat ;
- l’UI ne doit jamais afficher “connecté” sur la seule base d’un resolve NSD ;
- disparition réseau et appartenance persistante à une session sont deux notions distinctes.

### 30.5 Transport J04

Pour J04 :

- transport applicatif de session : **WebSocket** ;
- J04 doit utiliser WebSocket dès maintenant pour le join, la synchronisation d’état, le heartbeat/liveness et les événements de session ;
- **pas de short-poll HTTP** pour remplacer cette architecture ;
- **pas de nouveau plugin Cordova de session** ;
- la logique fonctionnelle de session reste dans la couche JavaScript/application.

Le code doit conserver une séparation claire entre modèle de session, transport WebSocket et UI.

### 30.6 Identité et modèle minimal de session

Principes retenus :

- `sessionId` persistant ;
- généré aléatoirement avec une source cryptographique ;
- jamais dérivé de l’IP, du nom de device ou de l’adresse réseau ;
- format cible J04 : identifiant alphanumérique court (8 caractères proposé) ;
- nom de session défini à la création ;
- nom de session modifiable ensuite par n’importe quel Master ;
- en cas de modifications concurrentes, la valeur portant la modification la plus récente gagne à la resynchronisation ;
- PIN Master de 4 chiffres ;
- PIN utilisable en clair sur le LAN de confiance V1 ;
- cette absence de protection cryptographique doit être documentée comme limitation ;
- PIN jamais publié dans DNS-SD.

Le modèle J04 ne doit pas pré-créer de structures fonctionnelles de J05/J06 telles que `members`, `sessionRoles` ou `takes` si elles ne sont pas encore utilisées.

### 30.7 Cycle de vie d’une session

Décision fonctionnelle :

Une session est destinée à contenir plusieurs Takes au cours du temps, mais pour simplifier J04 on introduit un état explicite :

- `open` ;
- `closed`.

L’écran 03 comporte une action explicite **« Terminer la session »**.

Terminer une session :

- passe la session à `closed` ;
- arrête son annonce réseau ;
- refuse les nouveaux joins ;
- conserve son `sessionId`, son nom, son PIN et ses données persistées ;
- conserve la session dans les sessions récentes / historique ;
- ne supprime pas la session.

Important :

- naviguer de l’écran 03 vers l’écran 01 **ne termine pas** la session ;
- le cycle de vie réseau ne doit pas dépendre de l’écran actuellement affiché ;
- en J04, une session `closed` n’est pas réouvrable ;
- la possibilité de réouvrir ultérieurement une ancienne session sera ajoutée dans un jalon ultérieur.

### 30.8 Join et liveness

Le protocole exact sera détaillé pendant l’implémentation, mais J04 doit au minimum disposer d’un échange explicite de join via WebSocket, avec :

- `sessionId` ;
- PIN ;
- `deviceId` ;
- nom du device ;
- endpoint du Master rejoignant si nécessaire.

Le PIN erroné doit être rejeté sans modifier la session.

La présence d’un Master dans la session est persistante ; son état connecté/déconnecté est dérivé de la connexion WebSocket et de son heartbeat applicatif, pas du seul mDNS.

### 30.9 Décisions finales avant implémentation J04

Les décisions suivantes sont désormais figées :

1. **Comportement après restart**
   - après restart de l’application, retour à l’écran 01 ;
   - la session persistée réapparaît dans « Sessions récentes » ;
   - aucune ouverture automatique forcée de l’écran 03.

2. **Autorité des Masters**
   - dès qu’un Controller rejoint une session avec le bon PIN, il devient un **Master à autorité complète** ;
   - tous les Masters ont exactement les mêmes droits ;
   - aucune notion de propriétaire, Master principal, Master secondaire ou host privilégié ;
   - toute action disponible pour un Master est disponible pour tous les Masters.

3. **Fermeture de session**
   - n’importe quel Master peut utiliser « Terminer la session » ;
   - la fermeture concerne la session entière ;
   - il n’est pas nécessaire de conserver fonctionnellement « qui a fermé » la session ;
   - les Masters hors ligne doivent apprendre l’état `closed` à leur retour ;
   - `closed` est terminal pour J04 : une ancienne copie locale `open` ne peut pas réouvrir la session ;
   - lors d’un conflit `open` / `closed`, `closed` gagne toujours.

4. **Nom de session**
   - le nom de session peut être modifié après création ;
   - tous les Masters peuvent le modifier ;
   - en cas de modifications concurrentes hors ligne, la modification la plus récente gagne lors de la resynchronisation.

5. **PIN**
   - le PIN à 4 chiffres est immuable pendant toute la vie de la session ;
   - il ne peut pas être changé par un Master ;
   - il n’est jamais publié dans DNS-SD.

6. **Multi-Master J04**
   - J04 doit donc être conçu comme un véritable modèle multi-Master à autorité équivalente ;
   - chaque Master persiste une copie de l’état de session ;
   - la synchronisation doit converger après reconnexion ;
   - le modèle de conflit minimal J04 doit supporter au moins :
     - `closed` prioritaire sur `open` ;
     - nom : dernière modification la plus récente gagne ;
     - PIN immuable ;
     - liste des Masters fusionnée par `deviceId` sans doublon.

Ces décisions remplacent les options précédemment marquées « À CONFIRMER ».



### 30.10 Origine WebView et sécurité WebSocket V1

Décision V1 validée :

- l'application Cordova utilise **`http://localhost`** comme origine WebView ;
- les communications WebSocket LAN utilisent **`ws://`** ;
- ce choix est accepté pour la V1 dans le modèle de **LAN de confiance** ;
- `wss://` / TLS / distribution de certificats ne sont pas requis pour la V1 ;
- un durcissement TLS pourra être étudié ultérieurement si le modèle de menace évolue ;
- la CSP doit autoriser explicitement `ws:` ;
- le trafic cleartext Android requis doit être déclaré dans la configuration versionnée ;
- cette décision s'appuie sur le POC C2 validé physiquement sur 3 Android et sur `tests/poc/websocket-server/PRODUCTION-INTEGRATION.md`.

Le plugin WebSocket retenu pour la V1 reste une brique **générique** d'infrastructure ; aucune logique métier MultiCam ne doit y être ajoutée.
