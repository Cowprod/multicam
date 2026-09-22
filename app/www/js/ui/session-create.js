/* MultiCam — écran 02 (Création / accès Master) en panneau monodocument.
 * Conforme maquette validée ui/02-master-session/.
 * - Création : nom obligatoire, PIN généré automatiquement, entrée directe (écran 03)
 *   sans écran intermédiaire ni bouton de confirmation.
 * - Rejoindre : une case par chiffre, saisie numérique, pas auto au 4e chiffre,
 *   validation automatique ; PIN incorrect → retour après erreur + re-focus.
 * - Le PIN n'est pas un identifiant persistant hors de la session ; il est stocké
 *   localement dans la copie de session (jamais sur le wire dans sharedView).
 * - J04 SPA : show(cfg, params) est invoqué par le routeur MultiCamNav ; le cycle
 *   de vie réseau appartient au service (session-ws), pas à cet écran (30.7).
 * Journalisation parsable : SCREEN02_*. */

(function (global) {
  "use strict";

  function byId(id) { return document.getElementById(id); }

  function showToast(msg) {
    var t = byId("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  var bound = false;

  /* ---------- création ---------- */

  function setupCreate(cfg) {
    byId("createArea").style.display = "";
    byId("joinArea").style.display = "none";
    var input = byId("sessionName");
    input.value = "";
    byId("pinStatus").textContent = "";
    input.focus();
  }

  function bindCreate(cfg) {
    if (bound) return;
    bound = true;
    var inFlight = false;
    byId("createButton").addEventListener("click", function () {
      if (inFlight) return;
      var name = byId("sessionName").value.trim();
      if (!name) {
        showToast("Nom de la session obligatoire");
        return;
      }
      inFlight = true;
      setBusy(true, "Création de la session…");
      global.MultiCamSessionWs.ensureServer().then(function () {
        return global.MultiCamSessionWs.createSession(name, {
          deviceName: cfg.deviceName
        });
      }).then(function (s) {
        console.log("SESSION created sessionId=" + s.sessionId + " name=" + s.name + " state=" + s.state);
        return global.MultiCamSessionWs.advertiseOpenSessions().then(function () {
          global.MultiCamNav.show("session", { sid: s.sessionId, fresh: 1 });
          inFlight = false;
          setBusy(false, "");
        });
      }).catch(function (err) {
        setBusy(false, "");
        inFlight = false;
        console.log("SCREEN02_CREATE_ERROR err=" + String((err && err.message) || err));
        showToast("Création impossible");
      });
    });
  }

  /* ---------- rejoindre ---------- */

  function setupJoin(cfg, p) {
    byId("createArea").style.display = "none";
    byId("joinArea").style.display = "";
    byId("joinSessionName").textContent = p.name || "Session";
    console.log("SCREEN02_JOIN_MODE sessionId=" + (p.sid || "") + " name=" + (p.name || "")
      + " endpoint=" + (p.host ? p.host + ":" + p.port : "(manquant)")
      + " controller=" + (cfg.enabledSkills.indexOf("controller") >= 0 ? "1" : "0"));

    var boxes = [];
    for (var i = 0; i < 4; i++) boxes.push(byId("pin" + i));
    var value = function () {
      var s = "";
      boxes.forEach(function (b) { s += b.value; });
      return s;
    };
    var clear = function () {
      boxes.forEach(function (b) { b.value = ""; });
    };
    var focusFirst = function () { boxes[0].focus(); boxes[0].select(); };

    clear();
    byId("pinStatus").textContent = "";
    byId("pinStatus").style.color = "";
    boxes.forEach(function (b) { b.disabled = false; });

    focusFirst();
  }

  function setupSubmit(cfg) {
    if (setupSubmit._bound) return;
    setupSubmit._bound = true;

    var boxes = [];
    for (var i = 0; i < 4; i++) boxes.push(byId("pin" + i));
    var value = function () {
      var s = "";
      boxes.forEach(function (b) { s += b.value; });
      return s;
    };
    var clear = function () {
      boxes.forEach(function (b) { b.value = ""; });
    };
    var focusFirst = function () { boxes[0].focus(); boxes[0].select(); };

    var lock = false;
    var submitLocked = false;

    boxes.forEach(function (b, idx) {
      b.addEventListener("input", function () {
        var v = b.value.replace(/[^0-9]/g, "");
        b.value = v.slice(0, 1);
        if (v.length === 0) return;
        if (idx < 3 && b.value) boxes[idx + 1].focus();
        if (value().length === 4 && !lock && !submitLocked) submitJoin();
      });
      b.addEventListener("keydown", function (e) {
        if (e.key === "Backspace" && !b.value && idx > 0) boxes[idx - 1].focus();
      });
    });

    function setLocked(v) {
      lock = v;
      boxes.forEach(function (b) { b.disabled = v; });
    }

    function submitJoin() {
      submitLocked = true;
      setLocked(true);
      byId("pinStatus").textContent = "Vérification…";
      byId("pinStatus").style.color = "";
      var params = global.MultiCamSessionCreate._joinTarget || {};
      var beganAt = Date.now();
      global.MultiCamSessionWs.ensureServer().then(function () {
        return global.MultiCamSessionWs.joinSession({
          sessionId: params.sid,
          name: params.name,
          host: params.host,
          port: parseInt(params.port, 10)
        }, value());
      }).then(function () {
        return waitOutcome(params.sid, 10000);
      }).then(function (outcome) {
        submitLocked = false;
        setLocked(false);
        if (outcome && outcome.ok) {
          var elapsed = Date.now() - beganAt;
          console.log("SCREEN02_JOIN_OK sessionId=" + params.sid + " rtt=" + elapsed + "ms");
          global.MultiCamNav.show("session", { sid: params.sid, fresh: 1 });
          return;
        }
        onRejected(params.sid, outcome ? outcome.reason : "timeout");
      }).catch(function (err) {
        submitLocked = false;
        setLocked(false);
        onRejected(params.sid, String((err && err.message) || err));
      });
    }

    function onRejected(sid, reason) {
      setLocked(false);
      clear();
      var unavailable = reason === "timeout" || reason.indexOf("connect_failed") === 0
        || reason === "session_closed" || reason === "unknown_session";
      byId("pinStatus").textContent = unavailable ? "Session indisponible" : "PIN incorrect";
      byId("pinStatus").style.color = "#e4655f";
      console.log("SCREEN02_JOIN_NACK sessionId=" + sid + " reason=" + reason);
      /* La session n'a pas été modifiée côté LAN ; suppression de la copie locale
       * provisoire pour ne pas laisser d'état inconsistent (décision 30.8). */
      if (global.MultiCamSessionStore && global.MultiCamSessionStore.remove) {
        global.MultiCamSessionStore.remove(sid);
      }
      if (unavailable) {
        showToast("Session indisponible");
        setTimeout(function () { global.MultiCamNav.show("home"); }, 1200);
      } else {
        focusFirst();
      }
    }

    function waitOutcome(sid, timeoutMs) {
      var deadline = Date.now() + timeoutMs;
      return new Promise(function (resolve) {
        var tick = function () {
          var o = global.MultiCamSessionWs.takeJoinOutcome(sid);
          if (o && o.ok !== null) { resolve(o); return; }
          if (Date.now() > deadline) {
            global.MultiCamSessionWs.takeJoinOutcome(sid);
            resolve({ ok: false, reason: "timeout" });
            return;
          }
          setTimeout(tick, 120);
        };
        tick();
      });
    }
  }

  function setBusy(flag, text) {
    var b = byId("createButton");
    b.disabled = flag;
    if (flag) {
      b.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-2"></i>' + text;
    } else {
      b.innerHTML = '<i class="fa-solid fa-plus me-2"></i>Créer';
    }
  }

  function show(cfg, params) {
    byId("deviceNameCreate").textContent = cfg.deviceName;
    byId("deviceNameJoin").textContent = cfg.deviceName;
    bindCreate(cfg);
    setupSubmit(cfg);
    global.MultiCamSessionCreate._joinTarget = params || {};
    if (params && params.mode === "join") {
      setupJoin(cfg, params);
    } else {
      setupCreate(cfg);
    }
  }

  global.MultiCamSessionCreate = {
    show: show
  };
})(window);