Scénario 09 complémentaire - Transfert interrompu
- REC+STOP réalisés, transfert vers C déclenché (TRANSFER_ANNOUNCE_TRIGGER attendu). 
- Interruption C pendant transfert (kill). État partiel persistant archivé. 
- Redémarrage C → reprise observée côté logique (état cohérent). 
- Progression mesurée avant/après interruption (valeurs init documentées). 
- Preuves: dumps avant/during/after, screenshot.
Verdict: PARTIAL (transfert réel démarré; progression/SHA-256 source==destination après reprise effective documentés autant que possible compte tenu du timing)
