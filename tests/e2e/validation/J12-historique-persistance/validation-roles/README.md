# Validation persistance membres + sessionRoles

Session: 73A43D4Y (Roles *)
Devices: A=61cc29567d91, B=61d54bba7d91, C=c0d8514d7d87

Opérations:
- Création session A (Master), join B,C via UI join.
- Attribution rôles via MultiCamSessionWs.addMember (API applicative) : B -> capture, C -> storage. Nécessite enabledSkills conformes (B capture, C storage).
- Vérification AVANT redémarrage: membres B/C présents avec sessionRoles ['capture']/['storage'] sur A/B/C.
- Force-stop + redémarrage A,B,C.
- Vérification APRÈS redémarrage: sessionId/PIN identiques, membres + sessionRoles conservés sur A/B/C.
- B arrêté (force-stop), écran 03 A montre B comme déconnecté, rôle Capture affiché (capture archivée). B redémarré.

Résultat: PASS
Preuves:
- before_*/{A,B,C}_73A43D4Y.json : membres avec sessionRoles présents
- after_*/{A,B,C}_73A43D4Y.json : membres avec sessionRoles conservés après redémarrage
- screen_a_b_disconnected.png : vue A montrant B déconnecté
