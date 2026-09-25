/* MultiCam — résolution centralisée du nom humain d'un device pour l'UI
 * (modal membre, listes LAN, confirmations). Évite toute convention
 * concurrente de nommage entre layers :
 *   1. `name`            → nom annoncé par la découverte LAN (J03) ;
 *   2. `deviceName`      → nom persisté dans le modèle de session (J04/J05) ;
 *   3. `deviceId` (UUID) → dernier recours, jamais vide.
 *
 * Testable en Node (UMD-lite, module.exports) et dans le navigateur
 * (window.MultiCamNames). */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MultiCamNames = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function deviceHumanName(row) {
    if (!row) return "";
    if (row.name) return row.name;
    if (row.deviceName) return row.deviceName;
    return row.deviceId || "";
  }

  return { deviceHumanName: deviceHumanName };
});