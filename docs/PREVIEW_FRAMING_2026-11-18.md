# MultiCam - jalon previews de cadrage (2026-11-18)

## But

Un Master doit voir jusqu'a quatre cadrages avant le premier REC et apres
STOP, sans declencher MediaRecorder et sans dupliquer la camera. L'affichage
pendant REC (ecran 08) et les transferts vers Storage restent inchanges.

## Implementation

- state/preview-framing-service.js : selectionne une session ouverte dont le
  device est membre et Capture du dernier Take. Reconciliation sur changement
  de session, disponibilite de la preview et transition de phase START.
  Demarre MultiCamPreviewSampler avec previewOnly=true et le vrai
  sessionId/takeNumber. Aucun appel a startRecording ou stopRecording.
- state/preview-sampler.js : conserve le mode REC historique, ajoute le mode
  explicite previewOnly lorsque la SurfaceView native est prete.
- ui/framing-previews.js : grille de cadrage des Captures selectionnees sur ARM
  et sur l'ecran apres STOP. Recupere les JPEG distants depuis PreviewInbox,
  apres le controle de role Master, et les JPEG de la Capture locale directement
  depuis le sampler (pas de self-loop WS).
- index.html et css/framing.css : grilles responsives 2x2, differenciees des
  controles REC et STOP.
- app/tests/preview-framing.test.js : tests de non-regression sur role Capture,
  session ouverte, avant REC, reprise apres STOP, foreground et absence de REC.

## Invariants

1. CameraPreview/SurfaceView est deja proprietaire de preview-service : la
   grille ne cree aucune nouvelle camera ni MediaRecorder.
2. Une seule boucle PixelCopy par Capture, cadence nominale 1 image/seconde,
   pas de copie MP4 pour le cadrage.
3. L'ancienne mosaïque live et la politique « latest frame wins » conservent
   leur responsabilite; aucune transmission aux autres roles qu'aux Masters.
4. En REC, start-service est seul proprietaire du sampler d'enregistrement.
5. Une session fermee ou un device qui n'est plus Capture du dernier Take
   interrompt les images du mode cadrage; une preview native inactive aussi.

## Validation

- Verifier npm test et cordova build android sur touchdeck, sur le SHA exact
  de l'implementation.
- Installer le nouvel APK sur quatre Xiaomi (et Master si distinct).
- Creer une session avec quatre Captures, ouvrir ARM, constater quatre cadrages
  actualises AVANT REC, dont la Capture locale si Master+Capture.
- Declencher REC, verifier les quatre images, le MP4 et le STOP coordonne.
- Apres STOP, constater la reprise des quatre cadrages, changer l'orientation
  d'une tablette et verifier une image actualisee.
- Creer le Take suivant et verifier l'absence d'image d'un Take precedent.
- Verifier absence de pertes de connexion, de doublons CameraPreview, et la
  conservation des transferts Storage.

Ne pas cocher « valide physiquement » sur la seule base d'un test Node,
d'un build reussi ou d'une installation APK. Tant que l'observation
visuelle ADB/operateur manque, priorite 1 = non validee et SAF = bloque.
Le projet Cowprod/multicam-storage-lab reste clos et n'est pas modifie.
