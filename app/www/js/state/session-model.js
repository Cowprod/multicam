/* MultiCam — modele minimal de session J04 (pur, sans transport, sans UI).
 * Module "UMD-lite" : utilisable dans l'app (window.MultiCamSessionModel) ET
 * chargeable en Node pour tester la convergence de maniere deterministe
 * (tests/e2e/validation/J04-sessions/merge-model.test.js).
 *
 * Decisions figees (MULTICAM_DECISIONS_REFERENCE section 30.9 + mission J04) :
 *  - state : closed > open (closed est terminal ; une copie open hors-ligne ne
 *    ressuscite jamais une session fermee) ;
 *  - PIN : immuable pour la vie de la session ; un desaccord n'est JAMAIS resolu
 *    en changeant silencieusement le PIN — log de conflit, PIN local conserve ;
 *  - nom : "latest modification wins" via (nameUpdatedMs, puis deviceId avec une
 *    rege de departage deterministe pour les horodatages egaux) ;
 *  - masters : fusion par deviceId, jamais de doublon lie a l'IP/host/endpoint ;
 *    la connectivite est un metadonnee transitoire, jamais l'identite.
 *
 * Le PIN ne figure JAMAIS dans les vues partagees reseau (sharedView) ni dans DNS-SD. */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(root);
  } else {
    root.MultiCamSessionModel = factory(root);
  }
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var SCHEMA_VERSION = 1;
  var PROTOCOL_VERSION = 1;

  /* Alphabet 32 sans ambiguite (pas de 0/O/1/I) : 8 chars = 40 bits, largement
   * suffisant pour un identifiant LAN a courte portee. */
  var SID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

  function randomBytes(n) {
    var b = new Uint8Array(n);
    if (root.crypto && root.crypto.getRandomValues) {
      root.crypto.getRandomValues(b);
    } else {
      for (var i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
    }
    return b;
  }

  function genSessionId() {
    var b = randomBytes(8);
    var out = "";
    for (var i = 0; i < 8; i++) out += SID_ALPHABET[b[i] % SID_ALPHABET.length];
    return out;
  }

  function genPin() {
    var b = randomBytes(2);
    var r = (b[0] << 8 | b[1]) & 0x7fff;
    return String(1000 + (r % 9000));
  }

  function nowMs() {
    return Date.now();
  }

  /* ---------- sanitize / creation ---------- */

  function cleanMaster(m) {
    if (!m || typeof m !== "object") return null;
    return {
      deviceId: typeof m.deviceId === "string" && m.deviceId ? m.deviceId : null,
      deviceName: typeof m.deviceName === "string" ? m.deviceName : "",
      endpoint: typeof m.endpoint === "string" ? m.endpoint : "",
      joinedAtMs: typeof m.joinedAtMs === "number" && m.joinedAtMs > 0 ? m.joinedAtMs : nowMs()
    };
  }

  function sanitizeSession(raw) {
    var s = (raw && typeof raw === "object") ? raw : {};
    var now = nowMs();
    var masters = [];
    if (Array.isArray(s.masters)) {
      s.masters.forEach(function (m, idx) {
        var c = cleanMaster(m);
        if (!c || !c.deviceId) return;
        if (idx === 0 && !c.deviceName && c.deviceId === s.self) c.deviceName = s.selfName || "";
        masters.push(c);
      });
    }
    var keyed = {};
    masters.forEach(function (m) { if (!keyed[m.deviceId]) keyed[m.deviceId] = m; });
    var day = new Date(s.createdAtMs || now);
    return {
      schemaVersion: SCHEMA_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: typeof s.sessionId === "string" && s.sessionId ? s.sessionId : genSessionId(),
      name: typeof s.name === "string" && s.name.trim() ? s.name.trim() : "Session " + day.toLocaleDateString("fr-CA"),
      nameUpdatedMs: typeof s.nameUpdatedMs === "number" && s.nameUpdatedMs > 0 ? s.nameUpdatedMs : (s.createdAtMs || now),
      nameByDeviceId: typeof s.nameByDeviceId === "string" && s.nameByDeviceId ? s.nameByDeviceId : (s.self || ""),
      pin: typeof s.pin === "string" && /^\d{4}$/.test(s.pin) ? s.pin : genPin(),
      state: s.state === "closed" ? "closed" : "open",
      stateUpdatedMs: typeof s.stateUpdatedMs === "number" && s.stateUpdatedMs > 0 ? s.stateUpdatedMs : (s.createdAtMs || now),
      stateByDeviceId: typeof s.stateByDeviceId === "string" && s.stateByDeviceId ? s.stateByDeviceId : (s.self || ""),
      createdAtMs: typeof s.createdAtMs === "number" && s.createdAtMs > 0 ? s.createdAtMs : now,
      updatedAtMs: typeof s.updatedAtMs === "number" && s.updatedAtMs > 0 ? s.updatedAtMs : now,
      masters: Object.keys(keyed).map(function (id) { return keyed[id]; })
    };
  }

  function createSession(name, self) {
    var now = nowMs();
    var s = sanitizeSession({
      schemaVersion: SCHEMA_VERSION,
      sessionId: genSessionId(),
      name: name,
      nameUpdatedMs: now,
      nameByDeviceId: self.deviceId,
      pin: genPin(),
      state: "open",
      stateUpdatedMs: now,
      stateByDeviceId: self.deviceId,
      createdAtMs: now,
      updatedAtMs: now,
      masters: [self]
    });
    return s;
  }

  function cloneSession(s) {
    return sanitizeSession(JSON.parse(JSON.stringify({
      sessionId: s.sessionId, name: s.name, nameUpdatedMs: s.nameUpdatedMs,
      nameByDeviceId: s.nameByDeviceId, pin: s.pin, state: s.state,
      stateUpdatedMs: s.stateUpdatedMs, stateByDeviceId: s.stateByDeviceId,
      createdAtMs: s.createdAtMs, updatedAtMs: s.updatedAtMs, masters: s.masters || []
    })));
  }

  function isClosed(s) { return s.state === "closed"; }
  function isOpen(s) { return s.state === "open"; }

  /* ---------- vue partagee reseau ---------- */

  /* Le PIN est toujours exclu des snapshots transferes (shared view).
   * join() renvoie la vue sans PIN ; le joint device garde le PIN saisi localement. */
  function sharedView(s) {
    return {
      schemaVersion: s.schemaVersion,
      protocolVersion: s.protocolVersion,
      sessionId: s.sessionId,
      name: s.name,
      nameUpdatedMs: s.nameUpdatedMs,
      nameByDeviceId: s.nameByDeviceId,
      state: s.state,
      stateUpdatedMs: s.stateUpdatedMs,
      stateByDeviceId: s.stateByDeviceId,
      createdAtMs: s.createdAtMs,
      updatedAtMs: s.updatedAtMs,
      masters: (s.masters || []).map(function (m) { return { deviceId: m.deviceId, deviceName: m.deviceName, endpoint: m.endpoint, joinedAtMs: m.joinedAtMs }; })
    };
  }

  /* ---------- convergence J04 ---------- */

  /* Comparateur deterministe de "cle de modification" pour le nom :
   * (nameUpdatedMs, nameByDeviceId). Le plus grand gagne ; egalite stricte de
   * (ms, deviceId) → comparaison de chaînes de nom pour rester deterministe.
   * Renvoie 1 si a gagne, -1 si b gagne, 0 si egal. */
  function logKeyCompare(aMs, aDid, bMs, bDid) {
    if (aMs !== bMs) return aMs > bMs ? 1 : -1;
    if (aDid !== bDid) return aDid > bDid ? 1 : -1;
    return 0;
  }

  /* Fusionne un snapshot distant dans la session locale, selon les regles 30.9.
   * Renvoie { session, events:[...], changed:bool } — ne mute pas l'entree locale
   * (out est une copie) ; l'appelant persiste si changed. */
  function mergeSessions(local, remote) {
    var out = cloneSession(local);
    var events = [];
    if (!remote || typeof remote !== "object") {
      return { session: out, events: events, changed: false };
    }

    /* 1. state : closed > open. */
    if (remote.state === "closed" && out.state !== "closed") {
      var rcs = typeof remote.stateUpdatedMs === "number" && remote.stateUpdatedMs > 0 ? remote.stateUpdatedMs : nowMs();
      out.state = "closed";
      out.stateUpdatedMs = rcs;
      out.stateByDeviceId = remote.stateByDeviceId || "peer";
      events.push({ type: "close", field: "state", from: "open", to: "closed", byDeviceId: remote.stateByDeviceId || "" });
    } else if (remote.state === "open" && out.state === "closed") {
      /* closed gagne ABSOLUMENT : une copie open hors-ligne ne ressuscite pas. */
      events.push({ type: "conflict", field: "state", from: "peer_open", to: "local_closed" });
    } else if (remote.state === "closed" && out.state === "closed") {
      var lcs = out.stateUpdatedMs || 0;
      var rcs2 = typeof remote.stateUpdatedMs === "number" ? remote.stateUpdatedMs : 0;
      if (rcs2 > lcs) {
        out.stateUpdatedMs = rcs2;
        out.stateByDeviceId = remote.stateByDeviceId || out.stateByDeviceId;
      }
    }
    /* etat.open initial : on garde l'ouvert local (pas de downgrade vers open). */

    /* 2. PIN : immuable. Desaccord = corruption → log de conflit, PIN local garde. */
    if (remote.pin) {
      if (out.pin && remote.pin !== out.pin) {
        events.push({ type: "conflict", field: "pin", detail: "immutable_pin_mismatch_keep_local" });
      } else if (!out.pin) {
        out.pin = remote.pin;
      }
    }

    /* 3. nom : latest modification wins + sort deterministe. */
    var rms = typeof remote.nameUpdatedMs === "number" ? remote.nameUpdatedMs : 0;
    var rdid = remote.nameByDeviceId || "";
    var cmp = logKeyCompare(rms, rdid, out.nameUpdatedMs || 0, out.nameByDeviceId || "");
    if (cmp > 0) {
      var oldName = out.name;
      out.name = remote.name;
      out.nameUpdatedMs = rms;
      out.nameByDeviceId = rdid;
      events.push({ type: "rename", from: oldName, to: remote.name, byDeviceId: rdid });
    } else if (cmp === 0 && remote.name !== out.name) {
      /* meme cle de modification, valeurs differentes : sort deterministe par nom. */
      if (remote.name > out.name) {
        out.name = remote.name;
        events.push({ type: "conflict", field: "name", detail: "tie_break_by_name_string", to: remote.name });
      }
    }

    /* 4. masters : fusion par deviceId (identite = deviceId, jamais IP/hostname). */
    var byId = {};
    (out.masters || []).forEach(function (m) { byId[m.deviceId] = m; });
    (remote.masters || []).forEach(function (m) {
      var id = m.deviceId;
      if (!id) return;
      if (!byId[id]) {
        byId[id] = cleanMaster(m);
        if (byId[id]) events.push({ type: "masterAdded", deviceId: id });
      } else {
        var cur = byId[id];
        if (m.deviceName && !cur.deviceName) cur.deviceName = m.deviceName;
        if (m.endpoint && !cur.endpoint) cur.endpoint = m.endpoint;
        if (!m.endpoint && cur.endpoint) { /* garde endpoint persiste (retombe TXT cote JS) */ }
        if ((m.joinedAtMs || 0) > 0 && (cur.joinedAtMs || 0) > 0 && m.joinedAtMs < cur.joinedAtMs) cur.joinedAtMs = m.joinedAtMs;
      }
    });
    out.masters = Object.keys(byId).map(function (id) { return byId[id]; });

    /* 5. updatedAtMs : max (utilise pour le tri "recentes"). */
    out.updatedAtMs = Math.max(out.updatedAtMs || 0, remote.updatedAtMs || 0, nowMs());

    var changed = JSON.stringify(sanitizeSession(out)) !== JSON.stringify(local);
    return { session: out, events: events, changed: changed };
  }

  /* Ajoute/rafraichit (par deviceId) un Master connu dans la session (ce device ou
   * un endpoint decouvert via DNS-SD). Utilise pour rafraichir un endpoint courant. */
  function upsertMaster(session, m) {
    var out = cloneSession(session);
    var byId = {};
    out.masters.forEach(function (x) { byId[x.deviceId] = x; });
    var prev = byId[m.deviceId];
    if (!prev) {
      byId[m.deviceId] = cleanMaster(m);
    } else {
      if (m.deviceName) prev.deviceName = m.deviceName;
      if (m.endpoint) prev.endpoint = m.endpoint;
      if (!prev.joinedAtMs) prev.joinedAtMs = m.joinedAtMs || nowMs();
    }
    out.masters = Object.keys(byId).map(function (id) { return byId[id]; });
    out.updatedAtMs = nowMs();
    return { session: out, changed: JSON.stringify(sanitizeSession(out)) !== JSON.stringify(session) };
  }

  /* Departage deterministe de nom si egalite (expose pour les tests). */
  function nameWinner(a, b) {
    var cmp = logKeyCompare(a.nameUpdatedMs || 0, a.nameByDeviceId || "", b.nameUpdatedMs || 0, b.nameByDeviceId || "");
    if (cmp > 0) return a;
    if (cmp < 0) return b;
    return a.name >= b.name ? a : b;
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    genSessionId: genSessionId,
    genPin: genPin,
    nowMs: nowMs,
    sanitizeSession: sanitizeSession,
    createSession: createSession,
    cloneSession: cloneSession,
    isClosed: isClosed,
    isOpen: isOpen,
    sharedView: sharedView,
    mergeSessions: mergeSessions,
    upsertMaster: upsertMaster,
    nameWinner: nameWinner,
    logKeyCompare: logKeyCompare
  };
});