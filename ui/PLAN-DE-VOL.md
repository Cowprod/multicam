# MultiCam — Plan de vol UI V1

**Dernière mise à jour : 17 septembre 2026**

Ce document sert de point de reprise après interruption. Chaque écran validé doit avoir :

- `index.html` : maquette visuelle de référence ;
- `README.md` : spécification UI + technique pour les agents de codage.

---

# État actuel

## Écrans validés

- **01 — Accueil / Découverte des sessions : ✅ VALIDÉ** — `ui/01-session-discovery/`
- **02 — Création / accès Master à une session : ✅ VALIDÉ** — `ui/02-master-session/`
- **03 — Session / Vue Master : ✅ VALIDÉ** — `ui/03-master-session/`
- **05 — Préparation / Réglages du Take : ✅ VALIDÉ** — `ui/05-take-preparation/`
- **06 — ARM / Contrôle de préparation : ✅ VALIDÉ** — `ui/06-arm/`
- **07 — Countdown / START synchronisé : ✅ VALIDÉ** — `ui/07-countdown/`
- **08 — Live / Recording : ✅ VALIDÉ** — `ui/08-live-recording/`
- **09 — Take arrêté / traitements : ✅ VALIDÉ** — `ui/09-take-stopped/`
- **14 — Paramètres du device : ✅ VALIDÉ** — `ui/14-device-settings/`
- **15 — Historique / Reprise de session : ✅ VALIDÉ** — `ui/15-session-history/`

## Écrans volontairement absents de la V1

- 10 : retiré, la vue Storage persistante couvre le suivi des transferts ;
- 11 : reporté après V1, pas de gestion distante des médias ;
- 12 : retiré, une Capture hors Take reste simplement en attente ;
- 13 : retiré, la vue Storage persistante de l'écran 07 suffit ;
- 16 : retiré de la V1, pas de QR/code ; découverte LAN par mDNS.

## Qualification technique

La campagne de qualification préalable à l'implémentation est terminée. Les résultats détaillés sont dans `docs/QUALIFICATION-TECHNIQUE-V1.md`.

Points principaux :

- PixelCopy pendant enregistrement : **validé**, run 300 s, 300/300 captures, 0 erreur, 0 callback perdu ;
- SAF : **validé sur stockage principal** avec création/écriture/suppression réelle ; microSD réelle à revalider ultérieurement ;
- partage du diagnostic : **validé** via feuille de partage Android.

Le lab reste disponible dans `tests/plugin-lab/` pour les qualifications ponctuelles de nouveaux devices.

## Prochaine étape immédiate

**Conception UI figée + qualification technique initiale terminée.**

La prochaine phase est l'implémentation de l'application V1. Elle doit être conduite par jalons vérifiables sur plusieurs devices physiques, avec pour chaque jalon des critères d'acceptation et des preuves reproductibles produites par l'agent de codage.

Les spécifications détaillées de chaque écran restent celles des README placés dans les dossiers `ui/XX-*`. Les décisions transverses de rôles/skills restent dans `docs/SKILLS-AND-ROLES.md` et les qualifications techniques dans `docs/QUALIFICATION-TECHNIQUE-V1.md`.
