# MultiCam — Skills, capabilities et rôles

Ce document est une référence d’architecture pour les agents de codage.

## 1. Principe

Il faut distinguer trois notions différentes :

1. **Capability / skill supportée par le code** : ce que cette implémentation de l’application sait réellement faire.
2. **Skill activée localement** : ce que l’utilisateur autorise ce device à annoncer et à fournir sur le LAN.
3. **Rôle actif dans une session** : ce qu’un Master attribue effectivement au device dans une session donnée.

Ces trois niveaux ne doivent pas être fusionnés dans le code ni dans le modèle de données.

## 2. Skills V1

Les skills fonctionnelles V1 sont :

- `controller` : peut agir comme Controller/Master ;
- `capture` : peut capturer/enregistrer de la vidéo ;
- `storage` : peut recevoir et conserver les médias répliqués.

Un même device peut supporter plusieurs skills.

## 3. Skills définies par l’implémentation

Les skills disponibles ne sont pas choisies arbitrairement par l’utilisateur : elles sont d’abord définies par le code de l’application / de la plateforme.

Exemples :

### Application Android MultiCam

La version Android V1 doit supporter les trois skills :

```text
controller
capture
storage
```

L’utilisateur peut ensuite désactiver localement une ou plusieurs de ces skills si le device ne doit pas les proposer.

### Client Raspberry Pi

Une implémentation Raspberry Pi peut, par exemple, ne supporter que :

```text
storage
```

Dans ce cas :

- l’UI/configuration ne doit jamais proposer `capture` ou `controller` comme activables ;
- le device n’annonce que les skills réellement supportées par son code ;
- un Master ne peut jamais lui attribuer un rôle que son implémentation ne supporte pas.

D’autres clients pourront avoir d’autres combinaisons selon leur code.

## 4. Modèle recommandé

Le modèle doit permettre de distinguer au minimum :

```json
{
  "supportedSkills": ["controller", "capture", "storage"],
  "enabledSkills": ["controller", "capture"],
  "sessionRoles": ["capture"]
}
```

Exemple Raspberry storage-only :

```json
{
  "supportedSkills": ["storage"],
  "enabledSkills": ["storage"],
  "sessionRoles": ["storage"]
}
```

Les noms exacts des propriétés pourront évoluer, mais cette séparation conceptuelle doit être conservée.

## 5. Règles d’activation locale

- Une skill ne peut être activée que si elle appartient à `supportedSkills`.
- Désactiver une skill empêche le device de l’annoncer comme disponible sur le LAN.
- Un Master ne peut attribuer que des rôles correspondant à une skill supportée **et activée** par le device.
- Les skills activées sont une préférence persistante du device, indépendante des sessions.
- Les rôles de session sont propres à une session et peuvent changer d’une session à l’autre.

## 6. Découverte réseau

Lors de l’annonce mDNS / HELLO, le device doit exposer au minimum :

- identité persistante (`deviceId`) ;
- nom humain ;
- version de l’application ;
- plateforme / type de client ;
- `supportedSkills` ;
- `enabledSkills`.

Le Master peut ainsi savoir ce qu’il est possible d’attribuer sans deviner les capacités du client.

## 7. Conséquence UI

Dans les paramètres du device :

- afficher toutes les skills supportées par cette implémentation ;
- permettre ON/OFF uniquement sur celles-ci ;
- ne jamais afficher une skill non supportée comme simplement désactivée : elle est inexistante pour cette implémentation.

Sur l’accueil :

- afficher les skills actuellement activées, de façon synthétique.

Dans la session côté Master :

- permettre l’attribution de rôles uniquement parmi les skills annoncées comme activées par le device.

## 8. Règle pour les agents

Ne jamais déduire les skills uniquement du type matériel (`Android`, `Raspberry`, `PC`).

C’est **l’implémentation logicielle** qui déclare explicitement ses `supportedSkills`.

Le matériel peut influencer ce que l’implémentation sait fournir, mais la source de vérité exposée au reste du système reste la liste déclarée par le client.
