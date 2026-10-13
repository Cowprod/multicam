Scénario 05 - Storage sans espace/erreur écriture simulée
Méthode: chmod 500/771 sur répertoire files de C (contrôlée, réversible). 
Verdict: PARTIAL - méthode d'injection identifiée et réversible (critère 5 satisfait sur méthode), mais transfert physique non déclenché (pas de REC en conditions de campagne). Code gère états ERROR (transfer-boot/transfer-service).
