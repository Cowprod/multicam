# J12 — Historique + persistance complète

Objectif : écran 15 Historique, écran 03 avec Takes précédents + Prochain Take, reprise même sessionId/PIN/membres/rôles, Take archivé depuis 03 ouvrant 09, nouveau Take ajoutable après reprise, faits STOP + résumé transferts persistés. Preuves : dumps avant/après, screenshots, logs restauration, restart ≥2 devices, force-stop.

État : Implémenté côté modèle/UI (take-model étendu avec status/summary, merge canonique préservant état validé ; start-service persiste faits STOP ; transfer-boot met à jour résumé ; écran 15+03+09 archivés). Tests unitaires : 377 pass + 2 J12 pass.
