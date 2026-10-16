# INCIDENT J14-B03 — (proposition, à valider)

- Statut: proposition; non corrigé
- Observations: SHA mismatch B→C (source 2fce5c8b... vs storage 354df18d...), même taille
- Collision destination: destFor sans deviceId → B et D visent MultiCam/D98ETUUG/1/videoTmp.mp4; seul le fichier de D présent sur C
- Code concerné: transfer-boot.js destFor (l.121-128), transfer-service.js resumeOffset/download, transfert-model
- Recommandation: documenter uniquement, ne pas corriger dans cette mission; confirmer convention de nommage et stratégie reprise
