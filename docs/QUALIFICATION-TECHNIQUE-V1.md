# MultiCam — Qualification technique V1

**État : qualification technique initiale terminée — 17 septembre 2026**

Ce document consigne les résultats du lab Cordova Android situé dans `tests/plugin-lab/` et les points techniques considérés comme suffisamment qualifiés pour démarrer l'implémentation de l'application V1.

## Device de référence utilisé pour les derniers tests

- Samsung SM-A226B ;
- Android 13 ;
- SDK 33.

Les résultats ci-dessous valident la faisabilité sur ce device de test. Ils ne dispensent pas des tests multi-device et des tests d'endurance qui feront partie du plan de développement V1.

## PixelCopy pendant REC

Objectif : obtenir une image de preview périodique pendant qu'un enregistrement vidéo est actif, afin d'alimenter la mosaïque Master avec environ une image par seconde sans maintenir un flux vidéo continu.

### Résultat court

Run 60 s :

- vidéo : OK ;
- captures attendues : ~60 ;
- captures OK : 59 ;
- erreurs : 0 ;
- callbacks perdus : 0 ;
- latence moyenne : 85 ms ;
- latence max : 246 ms.

Le 59/60 est compatible avec l'arrêt du test au voisinage exact du dernier tick ; aucun échec PixelCopy ni callback perdu n'a été observé.

### Résultat endurance

Run 300 s :

- vidéo : OK ;
- captures attendues : 300 ;
- captures OK : 300 ;
- taux : 100 % ;
- erreurs : 0 ;
- callbacks perdus : 0 ;
- latence moyenne : 88 ms ;
- latence max : 266 ms.

### Conclusion

**VALIDÉ pour la V1 sur le device de référence.**

Le mécanisme retenu repose sur un patch du plugin `cordova-plugin-camera-preview` ajoutant une action native `capturePreviewSurface` basée sur Android `PixelCopy`.

Le lab vérifie avant compilation que l'action native et la méthode associée sont bien présentes dans les sources Android effectivement compilées.

## Storage Access Framework / choix du dossier

Objectif : permettre à Android de sélectionner un emplacement de stockage persistant via SAF, puis vérifier un accès réel en écriture.

Test réalisé :

- sélection d'un dossier via le sélecteur Android ;
- permission persistante ;
- création d'un fichier ;
- écriture ;
- fermeture ;
- suppression du fichier de test.

Résultats observés sur `primary:DCIM` :

- écriture : OK ;
- suppression : OK ;
- latence observée : environ 97 à 163 ms selon les essais.

### Conclusion

**VALIDÉ sur stockage principal Android.**

La sélection et l'écriture sur une **microSD réelle restent à revalider** lorsqu'une carte sera disponible. Ce point n'est pas considéré comme bloquant pour démarrer la V1.

## Export / partage du diagnostic

L'appel direct `shareViaEmail()` du plugin SocialSharing provoquait un crash sur le device de test.

Le lab utilise désormais la feuille de partage Android via `shareWithOptions`, ce qui permet de transmettre le journal technique à l'application de messagerie choisie par l'opérateur.

### Conclusion

**VALIDÉ.**

## Briques déjà qualifiées dans le POC précédent

Le POC Cordova antérieur avait déjà servi à valider les briques suivantes avant la conception UI :

- caméra et preview ;
- enregistrement vidéo local ;
- snapshots ponctuels pendant REC ;
- batterie ;
- GPS ;
- permissions Android ;
- stockage Android accessible ;
- keep-awake ;
- orientation ;
- Zeroconf / mDNS.

Ces briques doivent être réutilisées ou adaptées dans l'application V1 plutôt que réinventées sans raison.

## Points reportés à l'implémentation et aux tests multi-device

Les éléments suivants ne sont pas des POC isolés à refaire avant le développement ; ils doivent être validés progressivement dans l'application réelle :

- WebSocket entre devices ;
- identité persistante des devices ;
- découverte et disparition mDNS ;
- reconnexion ;
- synchronisation d'horloge entre plusieurs devices ;
- ARM distribué ;
- START / STOP synchronisés ;
- previews JPEG multi-Capture ;
- transfert HTTP reprenable ;
- SHA-256 et réplication ;
- reprise après coupure réseau ;
- persistance Session / Take ;
- comportement avec plusieurs Captures et plusieurs Storage ;
- tests d'endurance sur plusieurs modèles Android ;
- microSD réelle via SAF.

## Lab de référence

Le projet de qualification reste conservé dans :

```text
tests/plugin-lab/
```

Il doit rester disponible pour reproduire un test technique isolé lorsqu'un nouveau modèle de device ou une nouvelle version Android pose question.
