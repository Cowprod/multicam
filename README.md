# MultiCam

Projet de captation vidéo multi-device Android/Cordova sur réseau local.

## Structure

- `ui/` — maquettes HTML validées et spécifications UI/techniques associées.
- `app/` — application Cordova principale et code métier.
- `docs/` — architecture, protocoles et cahier des charges technique.
- `tests/` — labs, POC et procédures de qualification.

Les écrans UI validés sont stockés sous `ui/<num>-<nom>/` avec un `index.html` et un `README.md`.

## Avancement

J15 (reprise automatique des transferts) : **validation physique PASS** sur A/B/C, 30 critères PASS et intégrité SHA-256 confirmée sur 7 Takes.

J16 a été arbitré : **seul le lot A est autorisé**. **J16-A (consultation des Takes passés — mode archivé de l'écran 09, depuis la session 03 et l'historique 15) est implémenté et validé physiquement** : 500 tests PASS / 0 FAIL, campagne sur 3 appareils Android réels 13/13 critères PASS. Les lots B→E (diagnostic exportable, GPS/GPX + orientation/wake-lock, SAF, hygiène) ne sont pas commencés.

Voir [le suivi du projet](docs/SUIVI-PROJET.md), [le rapport J16-A](docs/J16-A-RESULTS.md), [les preuves physiques J16-A](tests/e2e/validation/J16-A/RESULTS-J16-A-PHYSICAL.md) et [les preuves J15](tests/e2e/validation/J15/RESULTS-J15-PHYSICAL.md).
