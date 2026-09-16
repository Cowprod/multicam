# 09 — Take arrêté / traitements

**Statut : ✅ VALIDÉ**

Référence UI :

- `index.html` — vue Master après STOP du Take.

---

## Objectif

Après confirmation du STOP global, le Master arrive directement sur cet écran.

Cet écran suit la finalisation du Take et les réplications vers les Storage attendus, sans bloquer la préparation du Take suivant.

L'interface doit rester compréhensible par des utilisateurs non techniques : privilégier états simples, icônes et barres de progression. Les détails techniques comme SHA-256 restent hors de la vue principale.

---

## 1. En-tête

Afficher :

- session ;
- Take ;
- état du Take ;
- durée enregistrée.

Exemples d'état :

- `Transferts en cours` ;
- `Terminé` ;
- `Erreur` si au moins une réplication reste en erreur.

Il n'y a **pas de barre de progression globale du Take**.

---

## 2. Une carte par Capture

Chaque Capture du Take est représentée par une carte indépendante.

Afficher au minimum :

- nom de la Capture ;
- état simple : `Préparation`, `Transfert`, `En attente`, `Terminé`, `Erreur` ;
- les destinations Storage attendues directement dans la carte.

Ne pas imposer d'ouverture d'accordéon pour voir les transferts en cours.

---

## 3. Une progression par Storage

Pour chaque Storage attendu, afficher une ligne dédiée avec :

- nom du Storage ;
- barre de progression ;
- pourcentage ;
- volume transféré / volume total dès que connu.

Exemple :

`1,8 / 2,6 Go · 69 %`

Si une Capture doit être répliquée vers deux Storage, afficher **deux barres distinctes**.

Une réplication terminée reste visible à `100 % / Terminé` tant que le Take est consulté.

---

## 4. Capture hors ligne

Si une Capture est indisponible avant d'avoir fini ses transferts :

- conserver sa carte ;
- afficher `En attente de Cam XX` ;
- garder les Storage attendus visibles avec leurs barres en attente.

Une reconnexion doit permettre la reprise normale des traitements/transferts.

---

## 5. Erreur et reprise

En cas d'échec d'une réplication vers un Storage :

- afficher la ligne concernée en `Erreur` ;
- conserver sa progression connue ;
- afficher un bouton `Réessayer` sur cette ligne uniquement.

Le bouton relance la réplication concernée.

Il n'est pas prévu en V1 de retirer un Storage attendu pour contourner définitivement une erreur. Cette possibilité pourra être étudiée plus tard.

---

## 6. Passage automatique à Terminé

Avec Storage sélectionnés :

- le Take passe automatiquement à `Terminé` lorsque toutes les réplications attendues sont terminées et vérifiées.

Sans Storage sélectionné :

- les fichiers restent sur les Captures ;
- le Take peut passer à `Terminé` dès que les médias locaux ont été correctement finalisés.

La suppression locale éventuelle après réplication reste **invisible dans cette UI**.

---

## 7. Take suivant

Le bouton `Préparer le Take suivant` reste fixe en bas de l'écran.

Il est disponible même si :

- des transferts sont encore en cours ;
- une Capture est hors ligne ;
- une réplication est en erreur.

Le lancement d'un nouveau Take ne dépend donc pas du passage du Take précédent à `Terminé`.

Le bouton renvoie vers la préparation du prochain Take (`05-take-preparation`).

---

## 8. Consultation des Takes passés

Depuis la vue Session, l'utilisateur doit pouvoir revenir sur les Takes passés.

Règles :

- tri du plus récent au plus ancien ;
- possibilité de rouvrir cet écran de suivi ;
- consultation possible aussi bien pour un Take terminé que pour un Take encore en transfert ou en erreur.

Cette règle doit être reflétée dans la vue Session lors de sa prochaine révision.

---

## Invariants d'implémentation

- pas de jargon technique dans la vue principale ;
- pas de progression globale du Take ;
- une carte par Capture ;
- une barre de progression par Storage attendu ;
- afficher volume + pourcentage quand la taille finale est connue ;
- une erreur de réplication n'empêche pas de préparer le Take suivant ;
- `Réessayer` agit uniquement sur la destination en erreur ;
- les transferts continuent en arrière-plan indépendamment de la navigation Master ;
- la progression doit être synchronisée avec les états réels remontés par les Captures/Storage ;
- un Take ne passe à `Terminé` que lorsque toutes ses conditions de finalisation validées sont satisfaites.
