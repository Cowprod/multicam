# cordova-plugin-multicam-httpd

Fork **Android-only** de [`cordova-httpd`](https://github.com/floatinghotpot/cordova-httpd)
0.9.2 (MIT) de Liming Xie, vendorié dans MultiCam pour servir les segments d'un
Take après STOP.

## Pourquoi vendorié

Le POC J11 a validé que `cordova-httpd` compile sur Cordova Android 15 et sert
correctement les fichiers avec reprise HTTP (`Accept-Ranges: bytes`,
`Range: bytes=N-` → `206 Partial Content`). Le plugin amont n'est plus maintenu
et n'expose aucune authentification : on le fige et on le durcit ici.

## Différences avec l'amont

- Plateformes iOS/OSX retirées (iOS hors périmètre).
- `NanoHTTPD.serve()` : **token d'accès obligatoire** dès qu'un token est
  configuré (`?token=…` ou en-tête `Authorization: Bearer …`), sinon `403`.
- Listing de dossier **désactivé** (seuls les fichiers nommés sont servis).
- Option `token` ajoutée à l'API JS `cordova.plugins.CorHttpd.startServer`.

## API

```js
cordova.plugins.CorHttpd.startServer({
  www_root: "/abs/path/to/take",  // dossier média servi
  port: 8080,
  localhost_only: false,
  token: "<secret>"
}, function (url) { /* http://<lan-ip>:8080 */ }, function (err) {});

cordova.plugins.CorHttpd.stopServer(function () {});
```

## Réserves connues

- NanoHTTPD amont répond en **HTTP/1.0** (pas de keep-alive/chunked) — suffisant
  pour des GET reprenables.
- L'ETag de la réponse pleine et celui de la réponse partielle peuvent différer
  (bug amont) : le client NE DOIT PAS s'appuyer sur `If-Range`, mais reprendre à
  l'offset local connu (`Range: bytes=<reçu>-`).

Sources Java de NanoHTTPD conservées et marquées par des commentaires `MultiCam:`.
