# 15 — Historique / reprise de session

Statut : **VALIDÉ — 17 septembre 2026**

Référence UI : `ui/15-session-history/index.html`

## Rôle de l'écran

L'historique est uniquement un pont vers une Session existante. Il ne crée pas de niveau fonctionnel supplémentaire entre l'historique et l'écran Session.

Flux :

`Historique → Session (03) → liste des Takes → Take (09)`

## Liste des sessions

Chaque session de l'historique affiche :

- nom de la session ;
- dernière activité ;
- nombre de Takes.

Toute la carte de session est cliquable et ouvre l'écran Session 03 correspondant.

## Reprise d'une session

La reprise d'une ancienne session conserve :

- la même session ;
- son PIN Master d'origine ;
- les devices précédemment membres ;
- leurs rôles précédents comme configuration de départ.

L'écran 03 détermine ensuite l'état courant des devices. Un device anciennement membre mais actuellement absent est simplement affiché comme déconnecté, selon la mécanique de déconnexion déjà définie.

## Takes

La liste des Takes n'est pas dupliquée dans l'écran 15. Elle appartient à l'écran Session 03.

Dans 03 :

- les Takes sont affichés du plus récent au plus ancien ;
- un Take terminé, en transfert ou en erreur reste consultable ;
- un Take existant ouvre l'écran 09 ;
- un nouveau Take peut être préparé depuis la Session.

## Accueil

L'accueil doit exposer directement les 4 sessions les plus récentes sous forme de cartes/boutons rapides. Pour ces raccourcis, le nom de session suffit. L'historique 15 reste la vue dédiée à l'ensemble des sessions.

## Hors périmètre

- pas de détail intermédiaire propre à l'historique ;
- pas de duplication de la liste des Takes dans 15 ;
- pas de nouvelle logique de connexion des Captures/Storage : leur présence est évaluée une fois la Session ouverte.
