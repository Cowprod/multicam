J12 diag4 - divergence Takes (A PREPARATION vs B/C TERMINATED)
Cause: appel newTake avec session incomplète (avant fix défensif diag1) -> corruption état take 1 sur A uniquement. Avec fix défensif en place (reload depuis store si incomplet), newTake correct préserve take 1 et ajoute take 2; convergence cohérente sur A/B/C.
Avant/après archivés. Pas de défaut applicatif sous-jacent détecté (règle non-régression take TERMINATED préservée lors de fusion - dépend de timestamps; comportement testé OK).
