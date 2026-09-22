/* MultiCam — modele pur de session (J04 + J05 : membres et sessionRoles).
 * Module "UMD-lite" : utilisable dans l'app (window.MultiCamSessionModel) ET
 * chargeable en Node pour tester la convergence de maniere deterministe
 * (tests/plugin-lab/session/merge-model.test.js, members-model.test.js).
 *
 * Decisions figees (MULTICAM_DECISIONS_REFERENCE section 30.9 + 31 + missions) :
 *  - state : closed > open (closed est terminal ; une copie open hors-ligne ne
 *    ressuscite jamais une session fermee) ;
 *  - PIN : immuable pour la vie de la session ; un desaccord n'est JAMAIS resolu
 *    en changeant silencieusement le PIN — log de conflit, PIN local conserve ;
 *  - nom : "latest modification wins" via (nameUpdatedMs, puis deviceId avec une
 *    rege de departage deterministe pour les horodatages egaux) ;
 *  - masters : fusion par deviceId, jamais de doublon lie a l'IP/host/endpoint ;
 *    la connectivite est un metadonnee transitoire, jamais l'identite.
 *  - membres (J05) : identite par deviceId (jamais IP) ; un membre a des
 *    sessionRoles valides uniquement si ses skills annoncées les couvrent ;
 *    ≥ 1 rôle requis pour rester membre ; le retrait est un tombstone horodaté
 *    fusionné en LMW — un membre ré-ajouté après retrait ne ressuscite pas un
 *    ancien rôle, et un device retiré reste en LAN dans les devices disponibles ;
 *  - roles : un rôle non annoncé (enabledSkills) ne peut JAMAIS être ajouté au
 *    modèle — la validation vit ici et dans le protocole, pas seulement dans l'UI.
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

  /* J05 — sessionRoles possibles en V1. "controller" est une skill globale d'un
   * device (config) ; il n'est PAS un rôle de session : un rôle de session est
   * only capture/storage (décision 31.2 : combinaison autorisée si annoncée). */
  var VALID_ROLES = ["capture", "storage"];

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

  /* ---------- J05 : membres + sessionRoles ---------- */

  /* Assainit un membre. Règle d'invariants (décision 31 + mission J05) :
   *  - identité = deviceId, jamais IP ;
   *  - un rôle est conservé UNIQUEMENT s'il est dans les skills annoncées
   *    (enabledSkills) ET dans VALID_ROLES — un rôle non annoncé est jeté
   *    au niveau du modèle, jamais propagé (test J05 « rôle non annoncé ») ;
   *  - si après assainissement il ne reste AUCUN rôle → membre invalide (le
   *    device ne peut pas rester membre : ≥1 rôle requis). */
  function cleanMember(m) {
    if (!m || typeof m !== "object") return null;
    var enabled = (Array.isArray(m.enabledSkills) ? m.enabledSkills : []).slice();
    var roles = (Array.isArray(m.sessionRoles) ? m.sessionRoles : []).filter(function (r) {
      return VALID_ROLES.indexOf(r) >= 0 && enabled.indexOf(r) >= 0;
    });
    /* Suppression des doublons (au cas où un auteur mal formé en enverrait). */
    roles = roles.filter(function (r, i) { return roles.indexOf(r) === i; });
    return {
      deviceId: typeof m.deviceId === "string" && m.deviceId ? m.deviceId : null,
      deviceName: typeof m.deviceName === "string" ? m.deviceName : "",
      enabledSkills: enabled,
      sessionRoles: roles,
      addedAtMs: typeof m.addedAtMs === "number" && m.addedAtMs > 0 ? m.addedAtMs : nowMs(),
      addedByDeviceId: typeof m.addedByDeviceId === "string" ? m.addedByDeviceId : "",
      roleUpdatedMs: typeof m.roleUpdatedMs === "number" && m.roleUpdatedMs > 0 ? m.roleUpdatedMs : (m.addedAtMs || nowMs()),
      roleByDeviceId: typeof m.roleByDeviceId === "string" ? m.roleByDeviceId : (m.addedByDeviceId || "")
    };
  }

  /* Valide la liste de rôles demandée pour un device (skills annoncées).
   * Renvoie { ok, roles, rejected } — les rôles rejetés (non annoncés / hors
   * VALID_ROLES / doublons) ne sont jamais appliqués. ok=false si AUCUN rôle
   * valide ne subsiste (décision 31.1 : ≥1 sessionRole pour rester membre). */
  function validateRoles(enabledSkills, requested) {
    var enabled = Array.isArray(enabledSkills) ? enabledSkills : [];
    var roles = [];
    var rejected = [];
    var seen = {};
    (Array.isArray(requested) ? requested : []).forEach(function (r) {
      if (VALID_ROLES.indexOf(r) < 0) { rejected.push(r); return; }
      if (enabled.indexOf(r) < 0) { rejected.push(r); return; }
      if (seen[r]) return; /* doublon */
      seen[r] = true;
      roles.push(r);
    });
    return { ok: roles.length > 0, roles: roles, rejected: rejected };
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

    /* J05 — membres : identité par deviceId, rôles assainis (un rôle non annoncé
     * est jeté), tombstone de retrait conservé. Un member sans deviceId ni rôle
     * valide est écarté. L'ordre est déterministe (tri par deviceId). */
    var members = [];
    var memberKeyed = {};
    if (Array.isArray(s.members)) {
      s.members.forEach(function (m) {
        var c = cleanMember(m);
        if (!c || !c.deviceId) return;
        if (c.sessionRoles.length === 0) return; /* ≥1 rôle requis pour rester membre */
        if (!memberKeyed[c.deviceId]) memberKeyed[c.deviceId] = c;
      });
    }
    members = Object.keys(memberKeyed).sort().map(function (id) { return memberKeyed[id]; });

    /* Tombstones de retrait (J05) : deviceId -> { removedAtMs } — ne jamais
     * ressusciter un membre retiré. Conservés tels quels. */
    var removedMembers = {};
    if (s.removedMembers && typeof s.removedMembers === "object") {
      Object.keys(s.removedMembers).forEach(function (did) {
        var t = s.removedMembers[did];
        if (!t || typeof t !== "object") return;
        removedMembers[did] = {
          removedAtMs: typeof t.removedAtMs === "number" && t.removedAtMs > 0 ? t.removedAtMs : now,
          removedByDeviceId: typeof t.removedByDeviceId === "string" ? t.removedByDeviceId : ""
        };
      });
    }
    /* Un membre portant un tombstone est déjà exclu au moment du clean ci-dessus
     * (le retrait supprime le membre + crée le tombstone atomiquement). */

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
      masters: Object.keys(keyed).map(function (id) { return keyed[id]; }),
      members: members,
      removedMembers: removedMembers
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

  function lastCompletedMs(s) {
    var max = s.updatedAtMs || 0;
    (s.members || []).forEach(function (m) { if ((m.roleUpdatedMs || 0) > max) max = m.roleUpdatedMs; });
    Object.keys(s.removedMembers || {}).forEach(function (id) {
      if ((s.removedMembers[id].removedAtMs || 0) > max) max = s.removedMembers[id].removedAtMs;
    });
    return max;
  }

  function cloneSession(s) {
    return sanitizeSession(JSON.parse(JSON.stringify({
      sessionId: s.sessionId, name: s.name, nameUpdatedMs: s.nameUpdatedMs,
      nameByDeviceId: s.nameByDeviceId, pin: s.pin, state: s.state,
      stateUpdatedMs: s.stateUpdatedMs, stateByDeviceId: s.stateByDeviceId,
      createdAtMs: s.createdAtMs, updatedAtMs: s.updatedAtMs, masters: s.masters || [],
      members: s.members || [],
      removedMembers: objectShallow(s.removedMembers)
    })));
  }

  function objectShallow(obj) {
    var out = {};
    Object.keys(obj || {}).forEach(function (k) { if (k !== "__proto__") out[k] = obj[k]; });
    return out;
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
      masters: (s.masters || []).map(function (m) { return { deviceId: m.deviceId, deviceName: m.deviceName, endpoint: m.endpoint, joinedAtMs: m.joinedAtMs }; }),
      members: (s.members || []).map(function (m) {
        return { deviceId: m.deviceId, deviceName: m.deviceName, enabledSkills: m.enabledSkills.slice(), sessionRoles: m.sessionRoles.slice(), addedAtMs: m.addedAtMs, addedByDeviceId: m.addedByDeviceId, roleUpdatedMs: m.roleUpdatedMs, roleByDeviceId: m.roleByDeviceId };
      }),
      removedMembers: (function () {
        var out = {};
        var rm = s.removedMembers || {};
        Object.keys(rm).forEach(function (id) { out[id] = rm[id]; });
        return out;
      })()
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

    /* 5. J05 — membres & rôles : fusion déterministe par deviceId.
     *    - identité deviceId (jamais IP) ;
     *    - chaque membre porte roleUpdatedMs + roleByDeviceId : LMW + départage
     *      déterministe (deviceId) pour les horodatages égaux ;
     *    - les rôles sont TOUJOURS re-validés contre les skills annoncées du
     *      membre (un rôle non annoncé est jeté au modèle, jamais propagé) ;
     *    - un membre existant localement et absent du remote reste (le remote
     *      peut être une copie plus ancienne ou filtrée) — le retrait est le
     *      seul signal de suppression : tombstone removedMembers (J05-31).
     *    - un membre avec 0 rôle valide après fusion (skills retirées) perd ses
     *      rôles et bascule en tombstone (≥1 rôle requis pour rester membre). */
    var mById = {};
    (out.members || []).forEach(function (m) { mById[m.deviceId] = m; });
    (remote.members || []).forEach(function (rm) {
      var rmClean = cleanMember(rm);
      if (!rmClean || !rmClean.deviceId) return;
      var id = rmClean.deviceId;
      /* Un membre retiré (tombstone) côté remote n'apparaît pas dans remote.members. */
      if (!mById[id]) {
        mById[id] = rmClean;
        events.push({ type: "memberAdded", deviceId: id });
      } else {
        var cur = mById[id];
        var win = memberWinner(cur, rmClean);
        if (win === rmClean && !memberEqual(cur, rmClean)) {
          mById[id] = rmClean;
          events.push({ type: "memberRolesChanged", deviceId: id, to: rmClean.sessionRoles.slice() });
        } else if (win === cur && !memberEqual(cur, rmClean)) {
          /* LMW local gagne : rien à appliquer, mais si le remote était plus
           * récent sur le nom on garde une info ; sinon conflit silencieux. */
          if (rmClean.deviceName && !cur.deviceName) cur.deviceName = rmClean.deviceName;
        }
      }
    });
    /* Détection de retrait : un membre local absent du remote.members ET absent
     * de remote.removedMembers est un membre connu localement que le remote ne
     * connaît pas (copie antérieure) → on le GARDE localement ; le retrait ne
     * vient JAMAIS de l'absence, uniquement du tombstone (décision 31). */
    /* Applique les tombstones de retrait distants : les membres visés perdent
     * leurs rôles et deviennent des tombstones. */
    var rmRemote = (remote.removedMembers && typeof remote.removedMembers === "object") ? remote.removedMembers : {};
    Object.keys(rmRemote).forEach(function (did) {
      var t = rmRemote[did];
      if (!t || typeof t !== "object") return;
      var member = mById[did];
      if (member) {
        var roleBy = t.removedByDeviceId || "";
        var removedAt = t.removedAtMs || 0;
        /* Le tombstone n'est valide que si plus récent que la dernière mise à
         * jour de rôle du membre local (LMW). Sinon : le membre est plus récent
         * que le retrait → le retrait ne s'applique pas (pas de résurrection
         * intempestive d'un retrait ancien sur une MAJ plus récente). */
        var memberKey = (member.roleUpdatedMs || 0);
        var tombKey = removedAt;
        var cmp = (memberKey > tombKey) ? 1 : (memberKey < tombKey ? -1 : 0);
        if (cmp >= 0) {
          if (cmp === 0 && (roleBy || "") > (member.roleByDeviceId || "") && member.roleByDeviceId) {
            /* tie-break déterministe */ cmp = -1;
          }
        }
        if (cmp < 0) {
          delete mById[did];
          if (!out.removedMembers) out.removedMembers = {};
          var existing = out.removedMembers[did];
          if (!existing || (removedAt || 0) >= (existing.removedAtMs || 0)) {
            out.removedMembers[did] = { removedAtMs: removedAt, removedByDeviceId: roleBy };
          }
          events.push({ type: "memberRemoved", deviceId: did });
        }
      } else {
        /* Membre déjà absent localement : on mémorise le tombstone si plus
         * récent que l'existant (anti-résurrection après re-merge). */
        if (!out.removedMembers) out.removedMembers = {};
        var ex = out.removedMembers[did];
        if (!ex || (removedAt || 0) > (ex.removedAtMs || 0)) {
          out.removedMembers[did] = { removedAtMs: removedAt, removedByDeviceId: roleBy };
        }
      }
    });
    /* Après fusion : pruning des membres sans rôle valide (skills retirées).
     * Un membre qui perd tous ses rôles-session ne peut plus rester membre
     * (≥1 sessionRole requis, décision 31.1). */
    var finalMembers = [];
    Object.keys(mById).sort().forEach(function (id) {
      var m = mById[id];
      var pruned = cleanMember(m);
      if (!pruned || pruned.sessionRoles.length === 0) {
        events.push({ type: "memberPruned", deviceId: id, reason: "no_valid_role" });
        return;
      }
      finalMembers.push(pruned);
    });
    out.members = finalMembers;
    /* Egalisation des tombstones : un membre présent dans le résultat fusionné
     * (avec ≥1 rôle valide) annule son tombstone local éventuel. Cas : ré-ajout
     * après retrait — le chemin addMember local lève le tombstone ; le chemin
     * convergence (pas de tombstone dans remote) doit faire pareil pour rester
     * déterministe entre Masters (J05-08). */
    if (out.removedMembers && typeof out.removedMembers === "object") {
      Object.keys(out.removedMembers).forEach(function (did) {
        var stillPresent = finalMembers.some(function (m) { return m.deviceId === did && (m.sessionRoles || []).length > 0; });
        if (stillPresent) {
          delete out.removedMembers[did];
          events.push({ type: "memberRestored", deviceId: did });
        }
      });
    }

    /* 6. updatedAtMs : max (utilise pour le tri "recentes"). */
    out.updatedAtMs = Math.max(out.updatedAtMs || 0, remote.updatedAtMs || 0, lastCompletedMs(out), nowMs());

    var changed = JSON.stringify(sanitizeSession(out)) !== JSON.stringify(local);
    return { session: out, events: events, changed: changed };
  }

  /* J05 — comparateur déterministe de "clé de modification" d'un membre :
   * (roleUpdatedMs, puis roleByDeviceId). Le plus grand gagne ; égalité stricte
   * de (ms, deviceId) → comparaison lexicographique des rôles pour rester
   * déterministe. Renvoie a ou b (le gagnant). */
  function memberWinner(a, b) {
    var aMs = a.roleUpdatedMs || 0, bMs = b.roleUpdatedMs || 0;
    if (aMs !== bMs) return aMs > bMs ? a : b;
    var aBy = a.roleByDeviceId || "", bBy = b.roleByDeviceId || "";
    if (aBy !== bBy) return aBy > bBy ? a : b;
    var aR = (a.sessionRoles || []).join(","), bR = (b.sessionRoles || []).join(",");
    if (aR !== bR) return aR > bR ? a : b;
    return a; /* identiques → a (stable) */
  }

  function memberEqual(a, b) {
    return a.deviceId === b.deviceId
      && a.deviceName === b.deviceName
      && (a.enabledSkills || []).join(",") === (b.enabledSkills || []).join(",")
      && (a.sessionRoles || []).join(",") === (b.sessionRoles || []).join(",")
      && a.addedAtMs === b.addedAtMs
      && a.addedByDeviceId === b.addedByDeviceId
      && a.roleUpdatedMs === b.roleUpdatedMs
      && a.roleByDeviceId === b.roleByDeviceId;
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

  /* ---------- J05 : opérations de gestion des membres (appelées par la couche
   * transport/UI). Chaque op mute une COPIE et renvoie { session, changed,
   * events } ; l'appelant persiste + broadcast. Identité toujours par deviceId. */

  /* Ajoute ou met à jour les rôles d'un device membre. Le device est identifié
   * par son deviceId ; si déjà membre de la session, on fusionne (jamais de
   * doublon — reconnexion d'un ancien membre = mise à jour du même membre).
   * Un rôle non annoncé est rejeté via validateRoles (retour { rejected }). */
  function addMember(session, member, requestedRoles, byDeviceId) {
    var out = cloneSession(session);
    var events = [];
    var now = nowMs();
    var v = validateRoles(member.enabledSkills, requestedRoles);
    if (!v.ok) {
      return {
        session: out, changed: false, ok: false,
        rejected: v.rejected, error: "no_valid_role_for_device"
      };
    }
    var id = member.deviceId;
    var existing = null;
    (out.members || []).forEach(function (m) { if (m.deviceId === id) existing = m; });
    var rec = cleanMember({
      deviceId: id,
      deviceName: member.deviceName || "",
      enabledSkills: member.enabledSkills || [],
      sessionRoles: v.roles,
      addedAtMs: existing ? existing.addedAtMs : now,
      addedByDeviceId: existing ? existing.addedByDeviceId : (byDeviceId || ""),
      roleUpdatedMs: now,
      roleByDeviceId: byDeviceId || ""
    });
    if (!existing) {
      out.members = (out.members || []).concat([rec]);
      events.push({ type: "memberAdded", deviceId: id });
      if (out.removedMembers && out.removedMembers[id]) {
        /* Retiré + ré-ajouté immédiatement : le tombstone est levé (le device
         * redevient membre) — décision 31.1 "peut être ré-ajouté immédiatement". */
        delete out.removedMembers[id];
        events.push({ type: "memberRestored", deviceId: id });
      }
    } else {
      var replaced = false;
      out.members = out.members.map(function (m) {
        if (m.deviceId !== id) return m;
        replaced = true;
        return rec;
      });
      if (replaced && !memberEqual(existing, rec)) {
        events.push({ type: "memberRolesChanged", deviceId: id, to: v.roles.slice() });
      }
    }
    out.updatedAtMs = now;
    var changed = JSON.stringify(sanitizeSession(out)) !== JSON.stringify(session);
    return { session: out, changed: changed, ok: true, events: events };
  }

  /* Met à jour les rôles d'un membre existant : purement LMW local (clone +
   * roleUpdatedMs). Retour { ok:false, error:"not_a_member" } si inconnu. */
  function updateMemberRoles(session, deviceId, requestedRoles, byDeviceId) {
    var out = cloneSession(session);
    var now = nowMs();
    var idx = -1;
    out.members = (out.members || []).map(function (m, i) {
      if (m.deviceId !== deviceId) return m;
      idx = i;
      return m;
    });
    if (idx < 0) return { session: out, changed: false, ok: false, error: "not_a_member" };
    var member = out.members[idx];
    var v = validateRoles(member.enabledSkills, requestedRoles);
    if (!v.ok) {
      return { session: out, changed: false, ok: false, rejected: v.rejected, error: "no_valid_role_for_device" };
    }
    var updated = cleanMember({
      deviceId: member.deviceId,
      deviceName: member.deviceName,
      enabledSkills: member.enabledSkills,
      sessionRoles: v.roles,
      addedAtMs: member.addedAtMs,
      addedByDeviceId: member.addedByDeviceId,
      roleUpdatedMs: now,
      roleByDeviceId: byDeviceId || ""
    });
    out.members[idx] = updated;
    out.updatedAtMs = now;
    var changed = JSON.stringify(sanitizeSession(out)) !== JSON.stringify(session);
    return {
      session: out, changed: changed, ok: true,
      events: [{ type: "memberRolesChanged", deviceId: deviceId, to: v.roles.slice() }]
    };
  }

  /* Retire un device membre de la session : suppression du membership ET des
   * sessionRoles, tombstone horodaté (anti-résurrection). Ne touche JAMAIS aux
   * enabledSkills globales du device (L'historique global est géré par la config
   * device, pas par la session). Le device reste détectable en LAN et peut être
   * ré-ajouté immédiatement (décision 31.1). */
  function removeMember(session, deviceId, byDeviceId) {
    var out = cloneSession(session);
    var now = nowMs();
    var found = false;
    out.members = (out.members || []).filter(function (m) {
      if (m.deviceId !== deviceId) return true;
      found = true;
      return false;
    });
    if (!found) return { session: out, changed: false, ok: false, error: "not_a_member" };
    if (!out.removedMembers) out.removedMembers = {};
    var existing = out.removedMembers[deviceId];
    if (!existing || now > (existing.removedAtMs || 0)) {
      out.removedMembers[deviceId] = { removedAtMs: now, removedByDeviceId: byDeviceId || "" };
    }
    out.updatedAtMs = now;
    var changed = JSON.stringify(sanitizeSession(out)) !== JSON.stringify(session);
    return { session: out, changed: changed, ok: true, events: [{ type: "memberRemoved", deviceId: deviceId }] };
  }

  /* NB: deleted member removal (out.members filter) + tombstone : un membre
   * retiré n'apparaît plus dans members ; le tombstone protège contre toute
   * copie périmée qui réintroduirait un rôle déjà retiré. */

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
    logKeyCompare: logKeyCompare,
    VALID_ROLES: VALID_ROLES,
    validateRoles: validateRoles,
    cleanMember: cleanMember,
    addMember: addMember,
    updateMemberRoles: updateMemberRoles,
    removeMember: removeMember,
    memberWinner: memberWinner,
    memberEqual: memberEqual,
    membersOf: function (s) { return (s ? s.members : []) || []; }
  };
});