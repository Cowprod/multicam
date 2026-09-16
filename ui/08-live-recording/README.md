# 08 — Live / Recording

**Statut : ✅ VALIDÉ**

Références UI :

- `index.html` — vue **Master** pendant REC ;
- `capture.html` — vue **Capture** pendant REC ;
- la vue **Storage** ne change pas d'écran : elle réutilise `../07-countdown/storage.html` et fait évoluer l'état du Take vers `REC`.

> Les vidéos utilisées dans les maquettes sont uniquement des médias de démonstration. En production, les previews distantes de la mosaïque Master sont des JPEG périodiques (~1 fps), pas des flux vidéo continus.

---

## 1. Vue Master pendant REC

### En-tête

Afficher :

- session + Take ;
- état `REC` ;
- un **timer global unique** pour le Take.

Ne pas afficher de timer individuel dans chaque vignette.

### Mosaïque des Captures

La mosaïque est permanente pendant le REC et s'adapte au nombre de Captures afin d'utiliser au mieux l'écran.

Exemples attendus :

- 1 Capture : grande vignette ;
- 2 Captures : 2 colonnes ;
- 4 Captures : 2×2 sur mobile / adaptation écran large ;
- davantage : grille adaptative.

Les positions des Captures restent **stables pendant tout le Take**, y compris lors d'une déconnexion/reconnexion.

Chaque vignette affiche au minimum :

- nom du device ;
- état `REC`, `WARNING`, `ERROR`, `Déconnecté` ou `STOPPED` ;
- batterie ;
- espace local libre.

### Device local

Si le device affichant la vue Master est également une Capture participante :

- sa vignette est identifiée uniquement par un **contour coloré** ;
- ne pas ajouter de badge textuel du type `ce device` ;
- le fond général de la vue Master utilise la **preview locale de cette Capture**, assombrie derrière l'UI.

Le contour coloré identifie le **device local**, pas son état technique.

Si le Master n'est pas lui-même Capture, aucune vignette n'a ce contour local.

### Previews

En production :

- previews distantes = JPEG périodiques via le canal de contrôle, environ 1 image/s par défaut ;
- aucun flux vidéo continu n'est requis pour la mosaïque ;
- la preview locale peut utiliser directement le rendu caméra local.

### WARNING / ERROR

Un incident Capture pendant REC reste localisé à sa vignette :

- icône / état visible dans la vignette concernée ;
- **pas d'alerte globale** qui masque ou interrompt la mosaïque.

### Déconnexion

Lorsqu'une Capture se déconnecte pendant REC :

- conserver sa position dans la mosaïque ;
- conserver la **dernière preview reçue** ;
- figer cette image ;
- l'afficher en niveaux de gris / assombrie ;
- afficher l'état `Déconnecté`.

La déconnexion réseau ne signifie pas automatiquement que l'enregistrement local est arrêté.

À la reconnexion :

- la vignette revient automatiquement en couleur ;
- les previews reprennent ;
- aucune action opérateur n'est demandée.

Une Capture ayant effectué un STOP local d'urgence reste également à sa place avec la dernière image figée et l'état `STOPPED`.

---

## 2. Modal d'une Capture

Un appui sur une vignette ouvre une grande modal, environ **80–90 % du viewport**, sans passer en plein écran natif.

La modal contient :

- preview de la Capture ;
- nom du device ;
- uniquement les fonctions actives/demandées pour ce Take ;
- vidéo ;
- audio si actif ;
- GPS si actif ;
- batterie ;
- stockage local ;
- réseau.

Utiliser des icônes autant que possible.

En cas de WARNING / ERROR / déconnexion :

- l'icône concernée porte la couleur d'incident ;
- le détail de l'incident est affiché **dans cette même modal** ;
- ne pas ouvrir une seconde modal.

---

## 3. Storage dans la vue Master

Sous la mosaïque, afficher uniquement les Storage sélectionnés pour le Take courant.

Pour chaque Storage :

- nom ;
- état ;
- espace libre ;
- type réseau (`Wi-Fi` / `Ethernet`).

Ne pas afficher ici la progression des transferts d'anciens Takes.

La vue Storage dédiée reste celle déjà validée dans `07-countdown/storage.html`, qui peut suivre plusieurs sessions/Takes simultanément.

---

## 4. STOP global

Le bouton `STOP` reste fixe en bas de la vue Master.

Flux validé :

```text
STOP
→ confirmation Annuler / Confirmer STOP
→ arrêt synchronisé immédiat
→ Master vers écran Take arrêté / traitements
→ Captures vers STOPPED
```

Il n'existe plus de phase `STOP_PENDING` ni de compte à rebours visible de fin.

Techniquement, l'arrêt peut être planifié sur un instant commun très proche afin de synchroniser les Captures, mais cela ne doit pas devenir un compte à rebours opérateur.

Si une Capture ne répond pas au STOP :

- les autres s'arrêtent normalement ;
- la Capture non confirmée reste signalée comme incident jusqu'à confirmation d'arrêt ou reconnexion.

La notion historique de `Take Owner` avec privilège de `force stop` n'est plus utilisée pour ce flux.

---

## 5. Vue Capture pendant REC

La vue Capture est locale uniquement.

Afficher :

- preview caméra locale plein écran ;
- session ;
- Take ;
- nom local ;
- gros indicateur `REC` ;
- timer du Take ;
- états locaux uniquement : Capture, Audio, GPS, stockage local, batterie, réseau.

Une Capture ne doit pas voir la mosaïque ni l'état des autres devices.

---

## 6. Perte de tous les Masters pendant REC

Tant qu'au moins un Master est connecté :

- aucun bouton STOP local n'est visible sur une Capture.

Si tous les Masters disparaissent :

- l'enregistrement local continue ;
- afficher `Aucun Master connecté` ;
- afficher un bouton `STOP local d'urgence` ;
- demander confirmation `Annuler / Confirmer STOP`.

Ce STOP :

- arrête uniquement la Capture locale ;
- n'arrête pas les autres Captures ;
- rend cette Capture `STOPPED` pour ce Take ;
- interdit son redémarrage dans le même Take.

Lorsqu'un Master revient :

- masquer automatiquement le STOP local d'urgence ;
- le contrôle global reprend.

Pour la maquette seulement, `capture.html?nomaster=1` simule cet état.

---

## 7. Transferts pendant REC

Règle V1 : **aucun transfert média entrant ou sortant sur un device actuellement en RECORDING**.

Motif : éviter de concurrencer l'écriture vidéo avec lecture disque, hash, réseau et réplication.

Pendant REC restent autorisés :

- contrôle WebSocket ;
- télémétrie ;
- GPS ;
- previews périodiques.

Les transferts média en cours sont :

- mis en pause automatiquement quand ce device entre en RECORDING ;
- repris automatiquement après STOP.

Un Storage-only qui n'enregistre pas peut continuer à transférer d'autres Takes.

---

## 8. Après STOP côté Capture

Après l'arrêt du Take, la Capture passe en état `STOPPED`.

Si des Storage sont attendus, afficher ensuite une liste compacte **par Storage** avec l'état de réplication propre à chacun :

- `En attente` ;
- `Transfert xx %` ;
- `Vérification` ;
- `Répliqué` ;
- `Erreur`.

Ne pas réduire cela à un simple résumé global si plusieurs Storage sont attendus.

L'UI détaillée de cet état post-REC est traitée dans l'écran suivant `Take arrêté / traitements`.

---

## Invariants pour l'implémentation

- le timer REC est dérivé de l'instant de START synchronisé du Take, pas d'un compteur indépendant par écran ;
- les positions de mosaïque ne changent pas sur simple perte/reprise réseau ;
- `Déconnecté` décrit la connectivité, pas nécessairement l'état réel du recorder local ;
- le contour local ne doit jamais être détourné pour encoder READY/WARNING/ERROR ;
- aucun transfert média sur un device en RECORDING ;
- pas de `STOP_PENDING` ;
- le STOP local d'urgence n'existe qu'en absence totale de Master ;
- les maquettes utilisent des `<video>` uniquement pour simuler visuellement les previews ; l'implémentation distante attendue reste la preview JPEG périodique.
