# MultiCam — Avancement V1

Registre de suivi des jalons V1. Source d'état : `docs/PLAN-DEVELOPPEMENT-V1.md`.

| Jalon | Statut | Commit implémentation testé | Commit validation / doc | Preuves | Note |
|---|---|---|---|---|---|
| J01 — Socle application Cordova réel | ✅ PASS (accepté en revue humaine) | `ee59e8420bbb06908489f7a9e2ff5312f652d608` | `39c736c8c5092cb3ba1fd641744636358a8b1985` | `tests/e2e/validation/J01-socle-application/` | Défaut du menu hamburger découvert en revue humaine : menu s'ouvrant en bas d'écran, corrigé (ancrage haut-droit dans le header) et re-testé physiquement (3 configurations), test d'interaction explicite ajouté |
| J02 — Identité persistante + Paramètres device 14 | ✅ PASS (accepté en revue humaine) | `303538b` | `607a287` | `tests/e2e/validation/J02-identite-parametres/` | Identité persistante (UUID v4 stable, nom éditable), skills supportées/activées persistées avec état zéro supporté, écran réel 14 (stockage interne/SAF + probe, permissions réelles 4/4 accordées, infos device), hook debug rejette les skills non supportées sans modifier la config ; défaut `settings.html` (script SAF omis) corrigé pendant la validation et re-testé |
| J03 — Découverte LAN / mDNS | 🔎 Validé (attente revue humaine) | `42fcadb` | `7ba09f2` | `tests/e2e/validation/J03-decouverte-mdns/` | Découverte mDNS/DNS-SD réelle validée contre un pair publié du Mac (`dns-sd -P`) + client tiers (`dns-sd -L/-B`) : table de pairs keyée deviceId sans doublon, found/resolve/lost primaire, re-convergence 3 cycles + relances app, re-annonces renommage/skills, `enabled` omis quand vide, `/health` minimal corrélé, écran 01 reflétant l'état réel ; **Android↔Android PARTIAL** (second device bloqué à l'install USB, `INSTALL_FAILED_USER_RESTRICTED`) — défaut `settings.js` (accolade en trop) trouvé et corrigé pendant la validation |
| J04 — Sessions + second Master | ⏳ En attente | — | — | — | — |
| J05 — Membres + rôles de session | ⏳ En attente | — | — | — | `sessionRoles` hors scope J02 |
| J06 — Préparation Take 05 | ⏳ En attente | — | — | — | — |
| J07 — ARM distribué + sync horloge | ⏳ En attente | — | — | — | — |
| J08 — Countdown + START synchronisé | ⏳ En attente | — | — | — | — |
| J09 — REC multicam + previews Master | ⏳ En attente | — | — | — | — |
| J10 — STOP synchronisé | ⏳ En attente | — | — | — | — |
| J11 — Transfert / Storage / réplication | ⏳ En attente | — | — | — | — |
| J12 — Historique + persistance complète | ⏳ En attente | — | — | — | — |
| J13 — Scénarios de panne | ⏳ En attente | — | — | — | — |
| J14 — Endurance / campagne V1 | ⏳ En attente | — | — | — | — |

Conventions :
- **Commit implémentation testé** : SHA dont l'APK a réellement été construit et validé sur les devices physiques.
- **Commit validation / doc** : commit documentaire éventuel enregistrant ce SHA (distingué dans `VALIDATION.md`).
- Un jalon n'est clos que si : code commité, critères vérifiés sur devices physiques, dossier de preuve présent, `VALIDATION.md` = `PASS`, écarts documentés.