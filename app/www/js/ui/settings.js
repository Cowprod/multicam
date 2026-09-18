/* MultiCam — UI écran 14 (Paramètres du device), maquette validée ui/14-device-settings.
 * Contrôles réels uniquement :
 * - identité persistante (nom) via MultiCamConfig ;
 * - skills supportées/activées (switch locaux persistés) ;
 * - stockage courant + espace libre (StatFs natif, immesurable pour SAF → état
 *   explicite) + test réel d'écriture (probe interne ou SAF qualifié) ;
 * - permissions Android réelles (cordova.plugins.diagnostic), fallback réglages ;
 * - informations appareil réelles (device, batterie, réseau/IP, version) ;
 * - actions diagnostic Android. */

(function (global) {
  "use strict";

  function byId(id) { return document.getElementById(id); }

  var PERMISSIONS = [
    { key: "camera", label: "Caméra", icon: "fa-camera", perm: "CAMERA" },
    { key: "mic", label: "Micro", icon: "fa-microphone", perm: "RECORD_AUDIO" },
    { key: "location", label: "Localisation", icon: "fa-location-dot", perm: "ACCESS_FINE_LOCATION", gps: true },
    { key: "notifications", label: "Notifications", icon: "fa-bell", perm: "POST_NOTIFICATIONS", api: 33 }
  ];

  function hasDiagnostic() {
    return !!(global.cordova && global.cordova.plugins && global.cordova.plugins.diagnostic);
  }

  function showToast(msg) {
    var t = byId("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }

  function fmtBytes(n) {
    if (typeof n !== "number") return "—";
    if (n > 1e9) return (n / 1e9).toFixed(1) + " Go";
    if (n > 1e6) return (n / 1e6).toFixed(0) + " Mo";
    return n + " octets";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function skillRow(cfg, skill) {
    var meta = global.MultiCamConfig.skillMeta[skill] || { icon: "fa-question", label: skill };
    var enabled = cfg.enabledSkills.indexOf(skill) >= 0;
    var subtitle = skill === "capture" ? "Enregistrement caméra local"
      : skill === "storage" ? "Réception et conservation des médias"
      : "Pilotage des sessions et Takes";
    return '<div class="rowline"><i class="fa-solid ' + meta.icon + ' fs-5 text-info"></i>'
      + '<div class="flex-grow-1"><div class="fw-semibold">' + meta.label + "</div>"
      + '<div class="small muted">' + subtitle + "</div></div>"
      + '<div class="form-check form-switch m-0"><input class="form-check-input" type="checkbox"'
      + ' id="skill-' + skill + '" data-skill="' + skill + '"' + (enabled ? " checked" : "") + "></div></div>";
  }

  function renderSkills(cfg) {
    byId("skills").innerHTML = cfg.supportedSkills.map(function (s) { return skillRow(cfg, s); }).join("");
    cfg.supportedSkills.forEach(function (s) {
      var el = byId("skill-" + s);
      if (el) el.addEventListener("change", function () {
        var skill = el.getAttribute("data-skill");
        var checked = el.checked;
        global.MultiCamConfig.setSkill(skill, checked).then(function () {
          showToast(skill + (checked ? " activée" : " désactivée"));
          console.log("MDNS_REANNOUNCE_TRIGGER reason=skill_change skill=" + skill + " enabled=" + (checked ? 1 : 0));
          global.MultiCamNet.reannounce && global.MultiCamNet.reannounce();
        }).catch(function (err) {
          el.checked = !checked; // rejeté (skill non supportée) : on ne modifie pas l'état.
          showToast("Skill non supportée : " + skill);
        });
      });
    });
  }

  function isGranted(status) {
    var S = global.cordova.plugins.diagnostic.permissionStatus;
    return status === S.GRANTED || status === S.GRANTED_WHEN_IN_USE;
  }

  function statusBadge(status, error) {
    var ok = isGranted(status);
    return ok
      ? '<i class="fa-solid fa-circle-check permission-ok fs-5"></i>'
      : (error ? '<i class="fa-solid fa-circle-exclamation permission-ko fs-5"></i>'
        : '<i class="fa-solid fa-circle-xmark permission-warn fs-5"></i>');
  }

  function statusText(status) {
    var S = global.cordova.plugins.diagnostic.permissionStatus;
    if (status === S.GRANTED || status === S.GRANTED_WHEN_IN_USE) return "Autorisation accordée";
    if (status === S.DENIED_ONCE) return "Autorisation refusée";
    if (status === S.DENIED_ALWAYS) return "Refusée (ne plus redemander)";
    if (status === S.NOT_REQUESTED) return "Non demandée";
    return "État inconnu (" + status + ")";
  }

  function permRowStale(p) {
    var row = document.getElementById("perm-" + p.key);
    if (row) row.innerHTML = '<div class="rowline"><i class="fa-solid ' + p.icon + ' fs-5 permission-warn"></i>'
      + '<div class="flex-grow-1"><div class="fw-semibold">' + p.label + '</div><div class="small muted">Vérification…</div></div></div>';
  }

  function permRowEmpty() {
    return '<div class="rowline"><i class="fa-solid fa-circle-info fs-5 muted"></i><div class="flex-grow-1"><div class="small muted">Autorisations indisponibles dans cet environnement.</div></div></div>';
  }

  function buildPermRow(p, status, extra) {
    var D = global.cordova.plugins.diagnostic;
    var perm = D.permission[p.perm];
    var row = document.getElementById("perm-" + p.key);
    if (!row) return;
    var subtitle = statusText(status) + (extra ? " · " + extra : "");
    var action = "";
    if (isGranted(status)) {
      action = statusBadge(status);
    } else if (status === D.permissionStatus.DENIED_ALWAYS) {
      action = '<button class="btn btn-sm btn-warning btn-action" data-perm="' + p.key + '" data-action="settings">Réglages</button>';
    } else {
      action = '<button class="btn btn-sm btn-warning btn-action" data-perm="' + p.key + '" data-action="request">Autoriser</button>';
    }
    row.innerHTML = '<div class="rowline"><i class="fa-solid ' + p.icon + ' fs-5 ' + (isGranted(status) ? "permission-ok" : "permission-warn") + '"></i>'
      + '<div class="flex-grow-1"><div class="fw-semibold">' + p.label + '</div><div class="small muted permission-state">' + esc(subtitle) + "</div></div>" + action + "</div>";
  }

  function refreshPermissions(cfg) {
    if (!hasDiagnostic()) {
      byId("permissions").innerHTML = permRowEmpty();
      return;
    }
    var D = global.cordova.plugins.diagnostic;
    byId("permissions").innerHTML = PERMISSIONS.map(function (p) {
      return '<div class="rowline" id="perm-' + p.key + '"><div class="flex-grow-1"><div class="fw-semibold">' + p.label + "</div></div></div>";
    }).join("") + '<div class="rowline" id="perm-storage"></div>';

    var queries = PERMISSIONS.map(function (p) {
      return new Promise(function (resolve) {
        if (p.api && (global.MultiCamDevice.getInfo() ? global.MultiCamDevice.getInfo().sdkNumber : 0) < p.api) {
          document.getElementById("perm-" + p.key).innerHTML
            = '<div class="rowline"><i class="fa-solid ' + p.icon + ' fs-5 muted"></i><div class="flex-grow-1"><div class="fw-semibold">' + p.label + '</div><div class="small muted permission-state">Non applicable (Android &lt; ' + p.api + ")</div></div></div>";
          resolve();
          return;
        }
        D.getPermissionAuthorizationStatus(function (status) {
          if (p.gps) {
            D.isLocationEnabled(function (gps) {
              buildPermRow(p, status, "GPS système : " + (gps ? "activé" : "désactivé"));
              console.log("PERM_" + p.key.toUpperCase() + " state=" + status + " gps=" + (gps ? "1" : "0"));
              resolve();
            }, function () { buildPermRow(p, status); resolve(); });
          } else {
            buildPermRow(p, status);
            console.log("PERM_" + p.key.toUpperCase() + " state=" + status);
            resolve();
          }
        }, function (e) {
          console.log("PERM_" + p.key.toUpperCase() + " error=" + e);
          permRowStale(p);
          resolve();
        }, D.permission[p.perm]);
      });
    });

    Promise.all(queries).then(function () {
      refreshStorageAccess();
    });
  }

  function refreshStorageAccess() {
    var row = document.getElementById("perm-storage");
    if (!row) return;
    if (!global.cordova) {
      row.innerHTML = '<div class="rowline"><i class="fa-solid fa-folder fs-5 muted"></i><div class="flex-grow-1"><div class="fw-semibold">Accès stockage</div><div class="small muted permission-state">Indisponible hors Cordova.</div></div></div>';
      return;
    }
    runWriteTest().then(function () { renderStorageAccess(row, true); }, function () { renderStorageAccess(row, false); });
  }

  function renderStorageAccess(row, ok) {
    row.innerHTML = '<div class="rowline"><i class="fa-solid fa-folder fs-5 ' + (ok ? "permission-ok" : "permission-warn") + '"></i>'
      + '<div class="flex-grow-1"><div class="fw-semibold">Accès stockage</div>'
      + '<div class="small muted permission-state">' + (ok ? "Dossier courant accessible en écriture" : "Écriture échouée sur le dossier courant") + "</div></div>"
      + (ok ? '<i class="fa-solid fa-circle-check permission-ok fs-5"></i>' : '<i class="fa-solid fa-circle-xmark permission-warn fs-5"></i>');
    var note = byId("storageWriteTest");
    if (note) note.innerHTML = ok
      ? '<i class="fa-solid fa-circle-check permission-ok me-1"></i>Test d\'écriture réel : OK'
      : '<i class="fa-solid fa-circle-xmark permission-warn me-1"></i>Test d\'écriture réel : échec';
  }

  function runWriteTest() {
    var cfg = global.MultiCamConfig.get();
    var promise;
    if (cfg.storage.mode === "saf" && cfg.storage.treeUri) {
      promise = global.MultiCamSafApi.testWrite(cfg.storage.treeUri).then(function (r) {
        console.log("STORAGE_WRITE mode=saf ok=1 bytes=" + r.bytes + " deleteOk=" + (r.deleteOk ? "1" : "0") + " elapsedMs=" + r.elapsedMs + " uri=" + r.uri);
      });
    } else if (cfg.storage.mode === "internal") {
      promise = global.MultiCamStorage.writeProbe().then(function (r) {
        console.log("STORAGE_WRITE mode=internal ok=1 bytes=" + r.bytes + " path=" + r.path);
      });
    } else {
      promise = Promise.reject(new Error("no_storage"));
    }
    return promise.catch(function (e) {
      console.log("STORAGE_WRITE mode=" + cfg.storage.mode + " ok=0 error=" + e);
      throw e;
    });
  }

  function renderStorage(cfg) {
    byId("storagePath").textContent = global.MultiCamStorage.displayPath(cfg);
    var reset = byId("btnResetStorage");
    reset.style.display = cfg.storage.mode === "saf" ? "" : "none";

    if (cfg.storage.mode === "saf") {
      byId("storageFree").innerHTML = '<i class="fa-solid fa-hard-drive me-1"></i>Espace libre : non mesurable pour un dossier SAF';
    } else {
      byId("storageFree").innerHTML = '<i class="fa-solid fa-hard-drive me-1"></i>Espace libre : …';
      var path = global.MultiCamStorage.systemPath(global.MultiCamStorage.defaultPath());
      global.MultiCamNative.freeSpace(path).then(function (r) {
        byId("storageFree").innerHTML = '<i class="fa-solid fa-hard-drive me-1"></i>' + fmtBytes(r.availableBytes) + " disponibles";
      }).catch(function () {
        byId("storageFree").innerHTML = '<i class="fa-solid fa-hard-drive me-1"></i>Espace libre : indisponible';
      });
    }
    refreshStorageAccess();
  }

  function selectSafeDir() {
    global.MultiCamSafApi.chooseDirectory().then(function (r) {
      console.log("SAF_SELECTED uri=" + r.uri + " write=" + (r.write ? "1" : "0") + " read=" + (r.read ? "1" : "0"));
      return global.MultiCamSafApi.getTreeName(r.uri).then(function (n) {
        console.log("SAF_TREE_NAME uri=" + r.uri + " name=" + (n.name ? n.name : "?"));
        return global.MultiCamConfig.setStorage("saf", r.uri, n.name || null).then(function (cfg) {
          showToast("Dossier : " + (cfg.storage.displayName || "SAF"));
          renderStorage(cfg);
          byId("btnTestWrite").disabled = false;
        });
      });
    }).catch(function (e) {
      console.log("SAF_SELECTED error=" + e);
      showToast("Sélection annulée ou échec");
    });
  }

  function renderDeviceInfo() {
    var grid = byId("deviceInfo");
    var cfg = global.MultiCamConfig.get();
    var info = global.MultiCamDevice.getInfo() || {};
    var rows = [];
    rows.push(["Constructeur / modèle", [info.manufacturer, info.model].filter(Boolean).join(" ") || "—"]);
    rows.push(["Système", (info.version ? "Android " + info.version : "—") + (info.sdkVersion ? " · SDK " + info.sdkVersion : "")]);
    rows.push(["ID device (protocole)", cfg.deviceId || "—"]);
    rows.push(["Version Cordova", info.cordovaVersion || "—"]);
    rows.push(["Version app", info.appVersion || "—"]);
    rows.push(["Réseau", (global.MultiCamDevice.networkType() || "—")]);
    rows.push(["Adresse IP", "…"]);
    rows.push(["Batterie", "…"]);
    grid.innerHTML = rows.map(function (r) { return "<div>" + r[0] + "</div><div>" + esc(r[1]) + "</div>"; }).join("");

    if (global.MultiCamNative) {
      global.MultiCamNative.ipv4().then(function (r) {
        var vals = grid.querySelectorAll("div:nth-child(even)");
        if (r.ipv4) { vals[6].textContent = r.ipv4; }
        if (r.networkType) { vals[5].textContent = r.networkType; }
      }).catch(function () {});
    }

    global.MultiCamDevice.batteryStatus(function (b) {
      var vals = grid.querySelectorAll("div:nth-child(even)");
      if (vals[7]) {
        vals[7].innerHTML = '<i class="fa-solid fa-battery-three-quarters me-1"></i>' + Math.round(b.level) + " % · " + (b.isPlugged ? "en charge" : "sur batterie");
      }
    });
  }

  function renderMdnsInfo() {
    var grid = byId("mdnsInfo");
    if (!grid) return;
    var st = global.MultiCamNet.status ? global.MultiCamNet.status() : { enabled: false };
    var net = global.MultiCamDevice ? global.MultiCamDevice.networkType() : null;
    var rows = [];
    rows.push(["Service (DNS-SD)", st.serviceType || "—"]);
    rows.push(["Annonce/état", (st.running && st.advertising) ? "Active" : (st.running ? "Démarrage…" : "Inactive")]);
    rows.push(["Nom annoncé (NSD)", st.registeredName ? esc(st.registeredName) : "—"]);
    rows.push(["Chemin NSD (API)", (st.nsdPath ? st.nsdPath : "—") + (st.sdk ? " · SDK " + st.sdk : "")]);
    rows.push(["Port service santé", st.healthPort ? String(st.healthPort) : "—"]);
    rows.push(["IP locale", st.ipv4 ? esc(st.ipv4) : "…"]);
    rows.push(["Type réseau", (net || "—")]);
    rows.push(["Périphériques détectés", String(st.peers || 0)]);
    grid.innerHTML = rows.map(function (r) { return "<div>" + r[0] + "</div><div>" + r[1] + "</div>"; }).join("");
  }

  function bind(cfg) {
    byId("deviceNameInput").value = cfg.deviceName;
    byId("headerName").textContent = cfg.deviceName;

    byId("saveName").addEventListener("click", function () {
      var input = byId("deviceNameInput");
      global.MultiCamConfig.setDeviceName(input.value).then(function () {
        byId("headerName").textContent = input.value.trim();
        var btn = byId("saveName");
        btn.classList.remove("btn-primary"); btn.classList.add("btn-success");
        btn.innerHTML = '<i class="fa-solid fa-check me-1"></i>Enregistré';
        setTimeout(function () {
          btn.classList.remove("btn-success"); btn.classList.add("btn-primary");
          btn.innerHTML = '<i class="fa-solid fa-check me-1"></i>Enregistrer';
        }, 900);
        showToast("Nom enregistré");
        console.log("MDNS_REANNOUNCE_TRIGGER reason=name_change name=" + input.value.trim());
        global.MultiCamNet.reannounce && global.MultiCamNet.reannounce();
      }).catch(function (err) {
        showToast(String(err && err.message ? err.message : err));
      });
    });

    byId("btnChangeDir").addEventListener("click", selectSafeDir);

    byId("btnTestWrite").addEventListener("click", function () {
      byId("btnTestWrite").disabled = true;
      runWriteTest().then(function () {
        showToast("Test d'écriture OK");
        refreshStorageAccess();
        byId("btnTestWrite").disabled = false;
      }).catch(function (e) {
        showToast("Écriture KO : " + e);
        refreshStorageAccess();
        byId("btnTestWrite").disabled = false;
      });
    });

    byId("btnResetStorage").addEventListener("click", function (ev) {
      ev.preventDefault();
      global.MultiCamConfig.resetStorage().then(function (c) {
        console.log("STORAGE_BACK default=1");
        showToast("Stockage par défaut restauré");
        renderStorage(c);
      });
    });

    byId("permissions").addEventListener("click", function (ev) {
      var b = ev.target.closest("button[data-perm]");
      if (!b || !hasDiagnostic()) return;
      var p = PERMISSIONS.filter(function (x) { return x.key === b.getAttribute("data-perm"); })[0];
      if (!p) return;
      var D = global.cordova.plugins.diagnostic;
      if (b.getAttribute("data-action") === "settings") {
        D.switchToSettings(function () { console.log("PERM_" + p.key.toUpperCase() + " switch_to_settings=1"); }, function (e) { console.log("PERM_" + p.key.toUpperCase() + " switch_to_settings error=" + e); });
        return;
      }
      D.requestRuntimePermission(function (status) {
        console.log("PERM_" + p.key.toUpperCase() + " request_result=" + status);
        refreshPermissions(cfg);
      }, function (e) {
        console.log("PERM_" + p.key.toUpperCase() + " request_error=" + e);
        permRowStale(p);
      }, D.permission[p.perm]);
    });

if (hasDiagnostic()) {
      byId("btnOpenLocation").addEventListener("click", function () {
        global.cordova.plugins.diagnostic.switchToLocationSettings(function () {
          console.log("DIAG open_location_settings=1");
        }, function (e) { console.log("DIAG open_app_settings error=" + e); });
      });
      byId("btnOpenAppSettings").addEventListener("click", function () {
        global.cordova.plugins.diagnostic.switchToSettings(function () {
          console.log("DIAG open_app_settings=1");
        }, function (e) { console.log("DIAG open_app_settings error=" + e); });
      });
    } else {
      byId("btnOpenLocation").disabled = true;
      byId("btnOpenAppSettings").disabled = true;
    }

    var netRef = byId("btnRefreshNet");
    if (netRef) {
      netRef.addEventListener("click", function () {
        renderMdnsInfo();
        showToast("Réseau actualisé");
      });
    }
  }

  function init() {
    global.MultiCamConfig.load().then(function (cfg) {
      console.log("SETTINGS_OPEN deviceId=" + cfg.deviceId + " deviceName=" + cfg.deviceName
        + " enabledSkills=[" + cfg.enabledSkills.join(",") + "] storage=" + cfg.storage.mode);
      byId("btnTestWrite").disabled = false;
      renderSkills(cfg);
      renderStorage(cfg);
      renderDeviceInfo();
      refreshPermissions(cfg);
      bind(cfg);
      if (global.MultiCamNet && global.MultiCamNet.start) {
        global.MultiCamNet.start().then(function () {
          renderMdnsInfo();
          console.log("SETTINGS_NET ready=1 mdns=" + (global.MultiCamNet.status().running ? "1" : "0"));
        });
      } else {
        renderMdnsInfo();
      }
    }).catch(function (e) {
      console.log("SETTINGS_ERROR " + e);
    });
  }

  if (global.cordova) {
    document.addEventListener("deviceready", init, false);
  } else {
    init();
  }
})(window);