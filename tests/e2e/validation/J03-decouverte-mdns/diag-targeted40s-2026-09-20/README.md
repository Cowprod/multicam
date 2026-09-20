# Diagnostic Wi-Fi ciblé 40 s — D1 coupure (2026-09-20, relance live)

- Clocks : D1/D2/D3 == host (CEST), corrélation exacte (timestamp host/device identiques).
- APK testé : `app-debug.apk` sha256 `6b65ecc199983434b0a275bde066b129f3736f0c9e189b6182bd7d912ffd56b2` (v0.1.0, 3 devices installés `-r`, propre).
- Baseline : D1 = `61cc29567d91` (deviceId `d275fd07-…`, IP .57, Nord A), D2 = `61d54bba7d91` (deviceId `33311bd0-…`, .76, Nord B), D3 = `c0d8514d7d87` (deviceId `7fbf88be-…`, .192, Nord C). Skills pleines partout, apps lancées, convergence `peers=2` vérifiée sur les 3 avant coupure.
- Timeline (host, enregistrée dans `host-timeline.txt`) :
  - T1 `18:20:29.94` svc wifi disable D1.
  - `18:20:30` D1 : `releaseMulticastLock NsdService`, PEER_LOST Nord C puis Nord B (table D1 → peers=0), `NET_CHANGED networkType=none ipv4=?`, `MDNS_ERROR discoverException listener already in use` (+ DISCOVERY_STOP/START retry, REANNOUNCE OK). Discovery refresh ~25 s maintenu.
  - Pendant la coupure (18:20:29 → 18:21:12, ~43 s ≠ TTL NSD ~120 s), D2 et D3 continuent d'émettre `SERVICE_FOUND Nord A` + `MDNS_RESOLVE d275fd07 result=OK host=192.168.92.57` (cycles 18:20:40 et 18:21:05) : **résolution servie par le cache NSD local, sans serviceLost**.
  - T3 `18:21:12.95` svc wifi enable D1.
  - Retour D1 : `NET_CHANGED networkType=wifi ipv4=192.168.92.57` (18:21:15.38), re-découverte `SERVICE_FOUND Nord B/C` + `RESOLVE` + `PEER_FOUND` → `MDNS_PEER_TABLE found peers=2` (2 rows, 1 entrée/deviceId, zero auto-vue), `ADVERTISE_READY registeredName=Nord A` (18:21:16.20 puis 18:21:17.85, re-annonce native en deux temps).
  - Côté D2/D3 : nouveaux `RESOLVE d275fd07 result=OK host=192.168.92.57` post-retour à 18:21:15.8 / 18:21:15.99 puis cycles 18:21:30/31. Hôte identique avant/après coupure.
- Extrait d'événements par device : `*-events.txt` (MDNS_/HEALTH_/NET_CHANGED/CONFIG_/APP_BOOT/HOME_RENDER + WifiService/NsdService). Stream complet : `*-stream.log`.

## Conclusions (fiabilité live confirmée)

1. **Coupure sub-TTL (~43 s) : pas de serviceLost chez les pairs.** D2/D3 conservent leur peer Nord A et peuvent ré-émettre SERVICE_FOUND + RESOLVE=OK **depuis le cache NSD local pendant la coupure** (le peer n'est pas joignable physiquement). ⇒ **La résolution mDNS n'est PAS un signal de disponibilité réseau.** Pour J04, l'état `connected/disconnected` d'un Master dans la session devra être tranché par une vérification bout-en-bout réelle du endpoint session (HTTP), pas par NSD/cache.
2. D1 coupé : `NET_CHANGED none`, purge locale de sa table (serviceLost local) ; retour : `NET_CHANGED wifi`, re-découverte `found peers=2` fraîche, zero auto-vue, une entrée par deviceId, aucun doublon.
3. Ré-annonce native en deux temps : `ADVERTISE_READY Nord A` re-émis après retour (2× dans la fenêtre), malgré les erreurs `listener already in use` retryées proprement par le code (DISCOVERY_STOP/START + REANNOUNCE OK). Aucune régression par rapport aux conclusions de campagne 2.
4. Hôte de résolution stable avant/après (192.168.92.57) et identité 100 % deviceId (DID inchangés, unicité conservée).
5. Bruit plateforme MIUI sans impact (warnings SAR/WifiService, `no client mapping` NsdService).

Rien à corriger dans le produit : comportement conforme au « Comportement NSD documenté » de campagne 2 (S10/S10b + diag-wifi40s).