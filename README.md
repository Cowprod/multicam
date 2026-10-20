# MultiCam

Projet de captation vidéo multi-device Android/Cordova sur réseau local.

## Structure

- `ui/` — maquettes HTML validées et spécifications UI/techniques associées.
- `app/` — application Cordova principale et code métier.
- `docs/` — architecture, protocoles et cahier des charges technique.
- `tests/` — labs, POC et procédures de qualification.

Les écrans UI validés sont stockés sous `ui/<num>-<nom>/` avec un `index.html` et un `README.md`.

## Avancement

J15 (reprise automatique des transferts) : **validation physique PASS** sur A/B/C, 30 critères PASS et intégrité SHA-256 confirmée sur 7 Takes. La prochaine phase privilégie le **fonctionnel**, avec périmètre J16 à arbitrer avant développement.

Voir [le suivi du projet](docs/SUIVI-PROJET.md) et [les preuves J15](tests/e2e/validation/J15/RESULTS-J15-PHYSICAL.md).
