# Diagnostic Wi-Fi 40 s — D1 coupure (2026-09-20)

- Clocks: D1/D2/D3 == host (CEST), correlation exacte.
- Baseline : config D1=deviceName "XxxxxYyy" (advertisé registeredName=XxxxxYyy),
  D2=Nord B, D3=Nord C. D2/D3 tables peers=2 incl. D1.
- T1 00:57:59 svc wifi disable D1 ; T2 00:58:42 ("Wifi is disabled") ;
  T3 00:58:42 svc wifi enable ; T4 00:59:22 force-stop apps (fin de capture).
- D1 a perdu sa propre visibilité réseau (NET_CHANGED none à 00:57:59, wifi .57 à 00:58:45).
