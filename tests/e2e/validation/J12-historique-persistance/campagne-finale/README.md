# Campagne finale J12 - Vérifications physiques

Appareils: A=61cc29567d91, B=61d54bba7d91, C=c0d8514d7d87
Session test: C3EPPRCU (Final FIN-*)

## 1. ACCUEIL — ÉCRAN 01
- Affichage de 4 sessions récentes sur écran accueil (A) : PASS
- Preuve: captures/home_a.png, captures/home_after_restart.png
- Vérification: querySelectorAll('.session-card').length == 4

## 2. PERSISTANCE DES RÔLES
- Session créée A Master, B/C rejoints. Mémorisation sessionId/PIN/membres/masters vérifiée avant/après force-stop+redémarrage : PASS
- PIN/sessionId identiques après redémarrage (7776/C3EPPRCU) : PASS
- Dumps natifs avant/après archivés dans dumps/persist_*_{before,after}/

## 3. ABSENCE DE DOUBLONS
- Après reprise, session apparaît une seule fois sur accueil (A) : PASS
- Preuve: captures/home_after_restart.png

## 4. MEMBRE DÉCONNECTÉ
- B arrêté (force-stop). Vue A sur session : membre B déconnecté observable dans UI : PARTIAL/OK (capture archivée)
- Preuve: captures/session_a_b_disconnected.png
- B redémarré après vérification

Fichiers:
- captures/: home_a.png, home_after_restart.png, session_a_b_disconnected.png
- dumps/: persist_*_{before,after}/ avec A_C3EPPRCU.json, B_C3EPPRCU.json, C_C3EPPRCU.json
