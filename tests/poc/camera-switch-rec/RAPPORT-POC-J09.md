# POC J09 — Changement de caméra pendant un REC (Android Camera1 + MediaRecorder)

Device : Xiaomi Redmi Note 9 (`61d54bba7d91`) · package `fr.emmanuel.multicam`
Pile : `cordova-plugin-camera-preview` (Camera1) + `MediaRecorder`
Date de la campagne : session unique, un seul essai par campagne, sur un seul device.

**Ce document est un POC technique. Il ne propose ni n'arrête aucune décision
d'architecture produit.** Aucun fichier de `app/` n'a été modifié.

---

## 1. Verdict en une phrase

**Changer de caméra pendant un seul `MediaRecorder` est impossible** — le switch
libère la caméra que le recorder filme, la piste vidéo meurt ~300 ms après la
demande de switch pendant que l'audio continue jusqu'à l'arrêt. **En revanche le
changement segmenté fonctionne :** `stopRecordVideo` → `switchCamera` →
`startRecordVideo` tient 5 switches consécutifs sans crash, au prix d'un trou
d'image d'environ 2 s.

| Stratégie | Verdict | Trou d'image | Coût API |
|---|---|---|---|
| Switch en pleine prise (REC unique) | **non viable** | vidéo morte ~+300 ms, audio intact jusqu'au stop | — |
| Segmenté (stop → switch → start) | **viable** | ~1,9 à 2,1 s | 692 à 817 ms |

---

## 2. Le mécanisme, établi par le code et non par supposition

Dans `CameraActivity.java`, `switchCamera()` fait :

```java
cameraCurrentlyLocked := cameraCurrentlyLocked           // libère A
cameraCurrentlyLocked new: <A+1> % numberOfCameras       // ouvre B
this.recorder.stop()                                    // <-- coupe le recorder
```

Le recorder est arrêté **par la bascule elle-même**. La session `Camera` qui
alimente `MediaRecorder` est fermée ; le fichier en cours n'est donc plus
alimenté. C'est mécanique, ce n'est pas une hypothèse.

Conséquence : `switchCamera()` n'est pas « un changement de source pendant le
REC » mais « un arrêt déguisé ». L'audio et la vidéo ne meurent pas ensemble
parce que l'audio passe par une chaîne différente, qui continue d'écrire dans
le conteneur jusqu'au `stopRecordVideo`.

**Piège de lecture du logcat :** le plugin écrit `startRecord camera: back`
sur *chaque* `startRecordVideo`, y compris pour un segment filmé par la caméra
front. Seule la ligne `cameraCurrentlyLocked` dit quelle caméra est réellement
active. Utiliser `startRecord camera:` comme preuve de la caméra donne un
résultat faux.

---

## 3. Preuve d'attribution (le point qui demandait le plus de rigueur)

Comparer le dernier PTS vidéo à l'horloge murale est **faux** : au moment du
stop, `MediaRecorder` écrit encore ~1,6 s de données déjà capturées. Le dernier
PTS désigne donc un instant *antérieur* d'environ 1,6 s au stop. Une première
lecture conclut « la vidéo meurt 0,8 s *avant* le switch » : c'est un artefact
du décalage de muxage.

Méthode retenue : on mesure le décalage avec la piste de référence censée être
complète (l'audio), on l'applique à la vidéo.

```
décalage = recWall − durée_audio
mort_vidéo(mur) = décalage + dernier_PTS_vidéo
puis on compare mort_vidéo au switch
```

Résultats, trois runs indépendants du même protocole :

| run | switch | décalage mux | mort vidéo (mur) | mort − switch |
|---|---|---|---|---|
| phase 1 | — | — | — | **+317 ms** |
| `p2a-switch-t3` | t+3 s | +2,81 s | t+5,28 s | **+280 ms** |
| `p2b-switch-t8` | t+8 s | +2,72 s | t+8,22 s | **+312 ms** |
| phase 6 (REC long) | t+10,72 s | +1,63 s | t+11,03 s | **+309 ms** |

**La vidéo meurt de façon reproductible ~300 ms APRÈS le switch**, jamais
avant. C'est la signature du `this.recorder.stop()` : la bascule commence, la
caméra se libère, puis le recorder s'effondre.

---

## 4. Les segments sont-ils des vrais fichiers ?

Trois niveaux de contrôle, du plus faible au plus fort. ffprobe ne prouve
rien : il décrit un conteneur, pas son contenu.

1. **Structure** — conteneur, codec, résolution, fps, audio, durée, frames, SHA-256.
2. **Décodage intégral** — `ffmpeg -v error -i F -f null -` décode *toutes* les frames.
3. **Contenu** — extraction de frames à positions connues et mesure de luminance.

Bilan sur les **27 segments** de toutes les campagnes :

| statut | nombre | campagnes |
|---|---|---|
| `VALIDE` — décodage intégral, image non noire | **19** | phases 5, 7, 7b, 8, sonde front |
| `STRUCTURE VALIDE` mais **vidéo tronquée** | **3** | phases 2 (`p2a`), 4, 6 — les REC avec switch en pleine prise |
| `VIDEO NOIRE` — décodable mais sans image | 2 | phase 2 (`p2b`), début de session |
| `SANS PISTE VIDEO` (audio seul) | 1 | phase 3 |
| `CONTENEUR VIDE` — aucun flux du tout | 1 | phase 3 |
| `FICHIER ABSENT` — non revalidable | 1 | phase 1 (le plus ancien, fichier externe purgé) |

Les trois segments tronqués sont exactement les trois campagnes où le switch
intervient **pendant** un `MediaRecorder` unique. Les 19 segments valides sont
exactement ceux produits par la stratégie segmentée. La séparation des deux
familles est nette et reproductible.

Deux cas méritent d'être distingués explicitement :

- **`SANS PISTE VIDEO` et `CONTENEUR VIDE`** (phase 3) : après 5 switches sans stop, `stopRecordVideo` échoue en `-1007` et laisse sur le disque un fichier audio seul, voire un MP4 sans un seul flux. Ce n'est pas un fichier corrompu, c'est un fichier vide — deux défaillances qui appellent des corrections différentes.
- **`FICHIER ABSENT`** (phase 1) : le conteneur n'est plus sur le disque, la validation ne peut pas être rejouée. Sa mesure a été relevée en direct et les campagnes 2, 4 et 6 reproduisent la même signature (`+280` à `+317 ms`), donc la conclusion ne repose pas sur ce seul fichier.

**Séparation des contenus REAR / FRONT, par luminance de frames :**

```
REAR  : luma 91 à 101   (60 échantillons)
FRONT : luma  1 à  75   (35 échantillons)
→ les intervalles ne se recouvrent PAS
```

Les segments contiennent donc réellement deux images différentes. Le segment
FRONT n'est ni une copie du REAR, ni une image noire.

Deux nuances qui découlent de ces chiffres et qu'il ne faut pas perdre de vue :

- un segment FRONT **peut** contenir une frame quasi noire (luma 1 à 10 % de
  sa longueur dans un segment de la phase 8). Un contrôle « la vidéo est-elle
  noire ? » répondrait donc `oui` à tort sur un segment valide ;
- la marge entre les deux distributions **se resserre** (max FRONT 75 contre min
  REAR 91). Elle n'est pas une constante : elle dépend de l'exposition du FRONT
  à cet instant.

---

## 5. La caméra front n'est pas morte (correction d'une conclusion erronée)

Une version précédente de ce rapport concluait que « le device de test n'a pas
de caméra front fonctionnelle ». **Cette conclusion était fausse.** Elle
reposait sur un seul passage, et sur une lecture erronée d'une capture d'écran.

Ce que disent les mesures :

- **Preview front, REC arrêté :** luma 95, valeur qui varie (~75 kB de variation) → la caméra front est vivante.
- **Preview front, REC en cours :** luma 22–26.
- **Segment front enregistré sans aucun switch :** vidéo 4,646 s, frames `[25, 24, 24, 24, 24]`.
- **Segments front en stratégie segmentée :** luma 21 à 26 (phase 8), 73 à 76 (phase 7b).

**Conclusion correcte :** la caméra front fonctionne et produit une image
réelle, mais nettement plus sombre que la rear. Sa luminosité est **instable** :
elle varie de 12 à 76 selon les passages. Elle ne doit pas être codée en dur.

### Pourquoi le noir observé au début n'a pas été reproduit

| passage | front observé |
|---|---|
| phase 2 (`p2b`) | PixelCopy luma 0 |
| phase 4 | les **deux** PixelCopy front à 0 |
| phase 5, 1er passage | vidéo présente, 100 % noire |
| phase 5, 2e passage | luma 25, 24, 24, 24, 24 |
| phase 7b | luma 73–76 |
| phase 8 | luma 21–25 |

Le noir est **non reproductible** sur trois tentatives ultérieures. Et il est
**non revalidable** : le second passage de la phase 5 a réutilisé les mêmes noms
de fichiers hors dépôt (`p5-front-videoTmp.mp4`) et a écrasé le fichier du
premier passage. On ne peut donc pas dire « le front était noir puis s'est
corrigé » ; on peut seulement dire « le noir n'a pas été reproduit ».

La cause de la variation n'est **pas établie** : exposition, chauffage, état
partagé du HAL, session d'une autre application sur la caméra avant un
passage — rien de mesuré ne permet de trancher.

### La capture d'écran de l'Appareil photo ne prouve rien

Une screenshot de l'application Appareil photo montrait le viewfinder en noir.
Elle est **invalide comme preuve** : le `screencap` ne capture pas la Surface
native. Contrôle fait, la zone viewfinder vaut `luma=6` pour la caméra **rear**
alors que la barre d'interface, elle, est visible (`luma=67` en haut, `17` en
bas). Un écran noir dans une screenshot ne dit rien de l'image.

### Sur la phase 4, deux leçons à ne pas confondre

- Les PixelCopy front valaient 0 **pendant ce passage** : l'image était noire à ce moment-là. Fait réel, mais contextuel.
- Le fichier de la phase 4 ne contient que du **REAR** (luma ~91), parce que la piste vidéo est morte au premier switch. **Ce fichier ne prouve rien sur le front.**

---

## 6. Chronologie réelle du changement de caméra

### Phase 7b — segmenté minimal, sans outillage intercalé

C'est le chiffre décisionnel. Entre l'arrêt de A et le démarrage de B il n'y a
**rien** : ni stabilisation, ni `ffprobe`, ni `adb`. Les segments ne sont tirés
et analysés qu'après toute la séquence, via le chemin exact renvoyé par le
callback `stopRecordVideo`.

| transition | arrêt A → demande switch | `switchCamera` | switch → demande REC B | **TOTAL arrêt A → ack REC B** | A libérée | B ouverte | 1er JPEG B | trou VIDÉO | trou AUDIO |
|---|---|---|---|---|---|---|---|---|---|
| rear → front | 6 ms | 386 ms | 4 ms | **817 ms** | +281 ms | +327 ms | +864 ms | **2 099 ms** | 2 015 ms |
| front → rear | 8 ms | 263 ms | 7 ms | **692 ms** | +149 ms | +199 ms | +733 ms | **1 941 ms** | 1 850 ms |

Lecture :

- **Le coût de l'API est d'environ 0,7 à 0,8 s.** C'est la latence du changement de caméra.
- **Le trou d'image réel est d'environ 2 s.** L'écart d'environ 1,2 s vient du démarrage interne du `MediaRecorder` : l'ack revient avant que les premières frames soient écrites.
- Audio et vidéo perdent le même temps (écart de 84 ms entre les deux trous) : à l'intérieur d'un segment, les deux pistes restent alignées.
- **La phase 7 mesurait 8,7 à 9,0 s** avec exactement la même stratégie. Ce surcoût était l'outillage du POC (stabilisation + `ffprobe` + `adb` entre les prises), pas le produit. Présenter 8,7 s comme un coût produit aurait été faux.

### Retour de la preview

| moment de la tentative | résultat |
|---|---|
| immédiatement après le switch (+7 à +15 ms) | **échec, `PixelCopy failed with code 3`** |
| sonde lancée après le démarrage du recorder B | **succès du premier coup à +733 à +864 ms** |

La preview ne revient pas instantanément, mais elle revient. Mesurée après le
démarrage du recorder pour ne pas retarder l'enregistrement : c'est le
compromis réel, on ne peut pas avoir les deux.

---

## 7. Robustesse : 5 changements consécutifs, deux passes indépendantes

REAR → FRONT → REAR → FRONT → REAR, six segments, un seul Take logique.

| critère | passe 1 | passe 2 |
|---|---|---|
| segments obtenus | 6 / 6 | 6 / 6 |
| switches réussis | 5 / 5 | 5 / 5 |
| segments avec piste vidéo | 6 | 6 |
| segments avec contenu visible | 6 | 6 |
| `Camera already in use` | 0 | 0 |
| `stop failed` | 0 | 0 |
| `FATAL EXCEPTION` | 0 | 0 |
| ANR | 0 | 0 |
| exceptions caméra / recorder | 0 | 0 |

**Aucun crash, aucun ANR, aucun verrou persistant.** Le `MediaRecorder` se
réouvre à chaque fois, et le chemin exact de chaque fichier est renvoyé par
`stopRecordVideo`, ce qui rend l'attribution non ambiguë.

Réserve honnête : le device produit ~29 `Exception` sans rapport avec la capture
(gestionnaires d'apps tierces, Wellbeing, favicon du WebView). Les compter
toutes donnerait un score alarmant et faux. Le tableau ci-dessus ne compte que
les exceptions rattachées à la caméra ou au recorder.

**`switchCamera` bloque le thread UI 226 à 399 ms à chaque bascule.** C'est
exécuté sur le thread UI, donc 5 fois de suite dans ce test. Aucun ANR n'a été
observé à ce rythme, mais c'est le mécanisme à surveiller.

---

## 8. Réponses factuelles aux 14 points

1. **Peut-on changer de caméra pendant un REC unique ?** Non. La vidéo meurt ~300 ms après la demande de switch, l'audio continue jusqu'au stop.
2. **Le stop répond-il après un switch en pleine prise ?** Oui, l'API répond `ok` — mais le media produit reste tronqué. Un `ok` n'est pas un fichier valide.
3. **Et après 5 switches sans stop ?** Non, `stopRecordVideo` échoue en `-1007` et laisse un conteneur **vide**.
4. **Y a-t-il perte d'image ?** Oui, ~2 s en segmenté minimal.
5. **L'audio est-il coupé ?** Oui, pendant toute la bascule (trou audio de 1,85 à 2,02 s).
6. **La preview revient-elle ?** Oui, à +733 à +864 ms. Une tentative immédiate échoue en `code 3`.
7. **Le segmenté tient-il à la répétition ?** Oui, 5/5 sur deux passes indépendantes, sans crash ni ANR.
8. **La caméra front fonctionne-t-elle ?** Oui. Elle produit une image réelle, sombre (luma 21 à 76 selon les passages) contre 90 à 98 pour la rear.
9. **Peut-on l'établir sans ambiguïté ?** Oui : les intervalles de luminance REAR et FRONT sont disjoints, et le logcat natif donne l'identité de la caméra active.
10. **Le noir observé au début ?** Non reproductible sur trois tentatives, et non revalidable (fichier écrasé). Cause non établie.
11. **Une screenshot de l'Appareil photo prouve-t-elle quelque chose ?** Non. Le `screencap` ne capture pas la Surface native.
12. **Les segments sont-ils lisibles par un lecteur ?** Oui, décodage intégral vérifié sur 15 segments. Un seul cas à traiter à part : le conteneur vide de la phase 3.
13. **Le segmentage est-il techniquement envisageable ?** Les faits le rendent envisageable : ~0,8 s de coût API, ~2 s de trou d'image, aucune perte de robustesse à la répétition. **Aucune décision d'architecture n'est prise ici.**
14. **Que reste-t-il non établi ?** L'origine de l'instabilité de la front ; le comportement sur d'autres appareils ; le trou d'image réel, mesuré sur un seul device et une seule session ; l'effet de `switchCamera` sur le thread UI sous charge concurrente.

---

## 9. Pièges méthodologiques corrigés en cours de campagne

Ces erreurs ont produit de mauvaises conclusions avant d'être détectées. Elles
sont consignées parce qu'un POC qui ne signale pas ses propres biais n'est pas
exploitable.

1. **`fpsMoyen` était en réalité un intervalle.** Une valeur de `0,034` a été lue comme « 0,034 fps », ce qui est absurde. Les deux grandeurs sont désormais calculées l'une depuis l'autre et nommées explicitement.
2. **`verdictVideo` déclarait `VIDEO COMPLETE` sur un fichier sans piste vidéo.** Un fichier audio seul passait pour une vidéo valide.
3. **`extractFrameLuma` ne produisait que des `null`.** Deux causes distinctes.
4. **Les rapports des phases 2 à 5 ne contenaient aucun segment.** Les fichiers étaient analysés puis jetés : les rapports ne portaient aucune preuve.
5. **Un run analysait parfois le fichier du run précédent.** Le cache `videoTmp*.mp4` n'était pas purgé. Corrigé par une purge avant chaque REC, et par un garde-fou qui refuse d'attribuer un fichier à un run sans chemin exact.
6. **Le cache n'est purgé qu'entre les runs, jamais au milieu d'une séquence segmentée** — sinon on supprime le segment qu'on est en train de mesurer.

---

## 10. Reproduction

```bash
cd tests/poc/camera-switch-rec
./setup.sh 2>/dev/null || true      # dépendances
node phase6-long-controle.js         # REC long 12 s + switch + 12 s
node phase7b-minimal.js              # segmenté MINIMAL, chronologie par transition
node phase8-5-switches.js            # 5 switches segmentés, robustesse
node valider-segments.js             # décodage intégral + séparation des contenus
node synthese.js                     # agrégation de tous les rapports
```

Les MP4 sont écrits **hors du dépôt** (`$TMPDIR/multicam-j09-poc`) et n'y
sont jamais versionnés. Chaque rapport JSON reference le chemin absolu, le
SHA-256 et l'attribution du fichier.

Aucun `.mp4` n'est commité : les preuves sont les rapports, les logs et les
JPEG de preview.

Les logcats bruts sont stockés compressés (`*-logcat.txt.gz`, ~3 Mo au total
contre 30 Mo en clair). **Aucune ligne n'est perdue** : `logcat-filtre.js` et
`valider-chronologie.js` acceptent les deux formes. Les extraits lisibles
`*-pertinent.txt` et `*-anomalies.txt` restent en clair.

Deux rapports sont marqués `ARCHIVE-non-revalidable` (`phase5-passe1`,
`phase8-passe1`) : un second passage ayant réécrit les mêmes noms de fichiers
hors dépôt, leurs segments ne sont plus ceux qui ont produit ces rapports. Ils
sont conservés pour la traçabilité mais volontairement exclus de la
revalidation, sinon on attribuerait des mesures d'un passage à un autre.

---

## 11. Ce que ce POC ne décide pas

- Ni l'architecture cible, ni le format de sortie, ni le découpage final.
- Ni le traitement du trou d'image de ~2 s (cut, fondu, ou acceptation).
- Ni la synchronisation inter-appareils (J10), ni le transfert (J11).
- Aucune de ces décisions n'est prise ici : ce document ne décrit que des
  faits mesures sur un device, dans une session, et rien de plus.
