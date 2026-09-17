/* Safer Android log sharing for Qualification Lab v0.10.1 */
(function () {
  "use strict";

  document.addEventListener("deviceready", function () {
    setTimeout(function () {
      var oldButton = document.getElementById("mailButton");
      if (!oldButton || !oldButton.parentNode) return;

      /* Remove the shareViaEmail listener registered by index.js. */
      var button = oldButton.cloneNode(true);
      oldButton.parentNode.replaceChild(button, oldButton);

      button.addEventListener("click", function () {
        var logNode = document.getElementById("technicalLog");
        var deviceNode = document.getElementById("deviceLine");
        var statusNode = document.getElementById("statusText");
        var resultNode = document.getElementById("resultBody");

        var body = [
          "MultiCam Qualification Lab v0.10.1",
          "",
          "Device: " + (deviceNode ? deviceNode.textContent : ""),
          "Etat: " + (statusNode ? statusNode.textContent : ""),
          "",
          "Resultat:",
          resultNode ? resultNode.innerText : "",
          "",
          "Log technique:",
          logNode ? logNode.textContent : ""
        ].join("\n");

        if (window.plugins && window.plugins.socialsharing && window.plugins.socialsharing.shareWithOptions) {
          window.plugins.socialsharing.shareWithOptions(
            {
              message: body,
              subject: "MultiCam qualification log"
            },
            function () {},
            function (err) {
              console.error("Partage log KO", err);
              window.alert("Impossible d'ouvrir le partage du log.");
            }
          );
        } else {
          window.alert("Plugin de partage indisponible.");
        }
      });
    }, 0);
  }, false);
}());
