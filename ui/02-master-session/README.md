# MultiCam UI 02 — Création / accès Master

## Statut

**VALIDÉ — 15 septembre 2026**

`index.html` est la référence visuelle de cet écran. Ce README est la référence fonctionnelle et technique pour les agents de codage.

## Objectif

Cet écran couvre uniquement les opérations permettant à un device ayant le skill `controller` actif :

- de créer une nouvelle session ;
- de rejoindre une session existante comme Master.

Les devices utilisés uniquement comme `Capture` ou `Storage` ne passent pas par cet écran pour rejoindre une session : ils sont découverts sur le LAN puis ajoutés par un Master.

## Mode création

UI volontairement minimale :

- bouton Retour ;
- nom du device local ;
- champ `Nom de la session` ;
- bouton `Créer`.

### Règles

- le nom de session est obligatoire ;
- le device créateur devient automatiquement Master de la session ;
- un PIN Master aléatoire à 4 chiffres est généré automatiquement ;
- le PIN n'est pas demandé à l'utilisateur ;
- après création, l'application entre directement dans la session ;
- il n'y a pas d'écran intermédiaire ni de bouton `Entrer dans la session`.

Le PIN généré doit ensuite être visible dans la vue Master de la session (écran 03), afin de rester récupérable même si le Master créateur rencontre un problème.

## Mode rejoindre

Le parcours commence depuis le bouton `Rejoindre` d'une session détectée sur l'écran 01.

L'écran affiche uniquement :

- bouton Retour ;
- nom de la session choisie ;
- quatre cases de saisie du PIN.

### Saisie du PIN

- saisie numérique uniquement ;
- une case par chiffre ;
- passage automatique à la case suivante ;
- dès que les quatre chiffres sont saisis, validation automatique ;
- PIN correct : entrée immédiate dans la session, sans bouton de confirmation ;
- PIN incorrect : afficher brièvement `PIN incorrect`, vider les quatre cases puis replacer le focus sur la première.

Le PIN `4281` utilisé dans la maquette n'est qu'une valeur de démonstration.

## Retour

La règle de navigation générale est : **Retour = étape précédente du parcours**.

Dans le parcours actuel, l'écran 02 est appelé depuis l'écran 01, donc Retour y ramène. Cette règle ne doit pas être codée comme une hypothèse globale si le même écran est appelé plus tard depuis un autre contexte.

## PIN Master V1

- 4 chiffres ;
- généré automatiquement à la création ;
- conservé dans les données de la session ;
- affiché en permanence dans la vue Master V1 ;
- partagé pour permettre à un autre device Controller de rejoindre comme Master.

La sécurité attendue ici est celle d'une application LAN V1 ; ne pas ajouter de workflow d'identité ou de compte utilisateur non prévu par l'UI.

## Données minimales

### Création

Entrée :

```json
{
  "sessionName": "Interview Studio A",
  "creatorDeviceId": "uuid-cam07"
}
```

Résultat conceptuel :

```json
{
  "sessionId": "uuid-session",
  "name": "Interview Studio A",
  "masterPin": "4281",
  "status": "open"
}
```

Le PIN réel doit être généré aléatoirement, pas codé en dur.

### Rejoindre

Le device connaît déjà la session sélectionnée via la découverte LAN. La saisie du PIN sert à autoriser l'ajout du device comme Controller/Master de cette session.

## Réseau / synchronisation

L'implémentation finale doit :

- vérifier que la session détectée est toujours disponible avant de finaliser l'accès ;
- valider le PIN auprès de l'état de session faisant autorité sur le LAN ;
- rejoindre ensuite le mécanisme de synchronisation des Controllers/Masters de la session ;
- ne pas considérer le simple fait de connaître un PIN comme une identité persistante hors de cette session.

## Contraintes UI

- Bootstrap 5.x / Bootswatch Quartz ;
- Font Awesome ;
- jQuery autorisé ;
- priorité mobile/tablette Android ;
- aucune phrase pédagogique inutile dans l'interface opérateur ;
- la maquette utilise une vidéo de fond pour simuler la preview.

## Navigation

- création réussie → écran 03 ;
- PIN correct → écran 03 ;
- Retour → étape précédente, actuellement écran 01.

## Invariants pour l'agent de codage

- Ne pas demander le choix des rôles sur cet écran.
- Ne pas utiliser cet écran pour l'admission d'une Capture ou d'un Storage.
- Le skill `controller` doit déjà être activé localement pour que le parcours soit proposé depuis l'accueil.
- Nom de session obligatoire.
- PIN généré automatiquement.
- Validation du PIN automatiquement au quatrième chiffre.
- Aucun bouton `Valider` pour le PIN.
- Aucun écran intermédiaire après création.
