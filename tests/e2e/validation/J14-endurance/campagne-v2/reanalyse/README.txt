RE-ANALYSE POST-CAMPAGNE — session CCQM6BFH "Regie J14D-210338"
===============================================================

Contexte
--------
Le verdict produit EN FIN DE CAMPAGNE (../dumps/verdict.txt) était inexploitable :
  - `stateOf` parsait mal le JSON double-encodé des transferts (`err` partout -> DONE ECHEC) ;
  - T3-D et T5-B apparaissaient "MANQUANT sur C" parce que le `find` excluait les
    fichiers 0 octet ;
  - le jugement échouait sur des tailles divergentes (artefact stat/sha pendant finalisation).
Le `delete-order.txt` de campagne était lui aussi incomplet (par Take, sans Source, et
ne traitait pas les HASH invalides `storageSha256=—`, ni les buffers logcat qui tournent).

Preuves de campagne CONSERVÉES telles quelles (non écrasées) :
  ../dumps/verdict.txt        (verdict de campagne, biaisé)
  ../dumps/delete-order.txt   (ordre HASH->DELETE de campagne, incomplet)

Cette re-analyse ne relance AUCUN transfert et ne modifie AUCUN média : elle relit
uniquement des preuves déjà capturées (inventaires, SHA, états transfert, logcat).

Mode
----
Exécution du harnais CORRIGÉ en mode re-analyse :
  J14D_MODE="reanalyse-post-campagne" bash ../../../../j14d-integrity.sh <OUT> CCQM6BFH <CSER> <BDID> <DDID>
avec OUT = ce répertoire. En-tête du verdict : mode=reanalyse-post-campagne.

Entrées (dumps/ de ce répertoire)
---------------------------------
  TN-T1..T6.txt                 médias de référence par Take
  local-sha-T*-B/D.txt          SHA source. Pour les 8 sources ENCORE PRÉSENTES le SHA a été
                                re-rempli depuis l'inventaire LIVE (live/sha-B.txt, live/sha-D.txt,
                                fichiers stables). Pour les 4 sources SUPPRIMÉES (B T1/T4/T6,
                                D T6) l'inventaire au STOP est conservé (SHA fiable, cf. note).
  sha-c0d8514d7d87.txt          inventaire LIVE complet de la destination C (0 octet inclus)
  tr-A-T*.json, tr-C-T*.json    états transfert LIVE côté Master (A) et Storage (C)
  logcat-<ser>-phase61.log      copie FILTRÉE (`grep TRANSFER_`) des logcat post-campagne
                                (A/B/D) — sert à l'ordre HASH->DELETE
  media-<ser>-phase61.txt       liste des fichiers réellement présents sur B et D (preuve
                                de présence des sources)
  logs -> ../logs               lien symbolique vers les snapshots logcat de campagne (330 Mo,
                                non committés)

Note sur l'artefact stat/sha (local_inventory)
----------------------------------------------
L'inventaire source était exécuté juste après l'arrêt du REC, pendant la finalisation du
muxer : `stat` et `sha256sum` pouvaient lire un fichier encore en cours d'écriture.
Conséquences observées :
  - `bytes` source figé trop tôt pour T2-B, T3-B, T4-D, T5-B, T6-B (d'où les notes
    "tailles divergentes ... arbitrage par SHA") ;
  - pour T5-B, le SHA lui-même a été calculé sur un fichier partiel (716feafb / 520 Mo)
    alors que le fichier final vaut f7f56d78 / 2264233103 octets. La vérité LIVE a donc
    été substituée ; le verdict d'échec T5-B est inchangé (destination = 0 octet).

Résultats
---------
  verdict.txt        verdict corrigé : T1 PASS, T2 FAIL, T3 FAIL, T4 PASS, T5 FAIL, T6 PASS
                     -> VERDICT GLOBAL INTEGRITE : FAIL (complétude 8/12)
  delete-order.txt   ordre HASH->DELETE corrigé par Take×Source, avec colonne
                     source_presente. Révèle 4 anomalies de suppression confirmées
                     (B take2, B take3, D take1, D take4 : 0 fichier supprimé alors que
                     la source est toujours présente) et T4-D ECHEC_SUPPRESSION_INCOMPLETE.
