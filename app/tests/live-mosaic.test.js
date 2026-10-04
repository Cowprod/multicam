/* MultiCam — J09-05 : modèle mémoire des previews reçues + mosaïque Master.
 *
 * CE QUE CES TESTS FIGENT (et qu'aucune UI ne doit pouvoir déstabiliser) :
 *
 *   1. UN SLOT PAR CAPTURE DU TAKE, pas par preview reçue. Le slot existe parce
 *      que le device PARTICIPE au Take ; il s'affiche donc AVANT toute image,
 *      avec un placeholder. Une Capture qui n'a jamais envoyé de frame est
 *      visible : c'est ce qui distingue une mosaïque d'un mur d'images.
 *   2. L'ORDRE EST FIGÉ par le plan de START (participants[]), qui est la seule
 *      vérité du Take. Il ne dépend NI de la dernière frame, NI de la
 *      connectivité, NI du nom, NI de l'état technique. Une reconnexion ne
 *      déplace donc JAMAIS une vignette.
 *   3. DÉCONNECTÉ ≠ STOPPED. La perte WS éteint l'indicateur de connectivité et
 *      grise l'image, mais ne dit rien de l'enregistreur local : le slot et sa
 *      dernière image subsistent.
 *   4. AUCUN MELANGE : une frame d'une autre session, d'un autre Take ou d'une
 *      Capture hors Take est IGNORÉE et COMPTÉE. Le pire défaut d'une mosaïque
 *      n'est pas une vignette absente, c'est la mauvaise image dans la vignette.
 *   5. AUCUN LOOPBACK : le Master local ne reçoit pas sa propre preview par le
 *      WS (garanti côté transport, J09-04) ; sa vignette est identifiée par le
 *      seul contour local, jamais par un badge textuel.
 *
 * COUVERTURE :
 *   M1.  1 Capture                        -> 1 slot
 *   M2.  2 Captures                       -> 2 slots dans l'ordre du Take
 *   M3.  aucune frame reçue              -> slot présent, placeholder
 *   M4.  frame reçue pour B               -> seule la vignette B change
 *   M5.  frame suivante pour B            -> image remplacée, pas de nouveau slot
 *   M6.  B se déconnecte                  -> index inchangé, image conservée, Déconnecté
 *   M7.  B se reconnecte                  -> même slot, nouvelle image
 *   M8.  frames A et B dans n'importe quel ordre -> ordre visuel inchangé
 *   M9.  frame d'une Capture hors Take    -> ignorée
 *   M10. frame d'une autre session/Take   -> ignorée
 *   M11. Capture STOPPED localement      -> slot conservé, image figée, STOPPED
 *   M12. Master local aussi Capture       -> slot local, aucun badge « ce device »
 *   M13. Take suivant                     -> slots reconstruits, rien du Take précédent
 *   M14. participant découvert plus tard -> ajouté en FIN, indices existants intacts
 *   M15. participant retiré du plan       -> le slot reste (ordre figé)
 *   M16. la mosaïque ne trie jamais       -> ordre stable sous rafales de frames
 */

"use strict";

function register(h) {
  const { describe, it, createEnv, load, loadAll, fakeDom } = h;

  /* Assertion de valeur : le message nomme l'écart, sinon un échec de test
   * n'explique pas CE QUI a divergé. */
  function eq(actual, want, msg) {
    if (actual !== want) {
      throw new Error((msg || "valeur inattendue")
        + " — attendu " + JSON.stringify(want) + ", obtenu " + JSON.stringify(actual));
    }
  }

  const SID = "SIDAAAAA";
  const SID2 = "SIDBBBBB";
  const LOCAL = "dddddddd-0000-0000-0000-000000000001";   /* Master + Capture */
  const A = "aaaaaaaa-0000-0000-0000-00000000000a";      /* Capture A */
  const B = "bbbbbbbb-0000-0000-0000-00000000000b";      /* Capture B */
  const C = "cccccccc-0000-0000-0000-00000000000c";      /* Capture C, hors Take */
  const STO = "ssssssss-0000-0000-0000-0000000000ff";     /* Storage-only */

  /* ---------- environnement : modèle + écran, sans DOM ---------- */

  function env(participants, opts) {
    const o = opts || {};
    const e = createEnv({ fakeClock: !!o.fakeClock });
    loadAll(e, ["state/preview-inbox.js", "state/live-model.js", "ui/live.js"]);
    const model = e.window.MultiCamLiveModel;
    const screen = e.window.MultiCamLiveScreen;
    model.bind({
      localDid: o.localDid || LOCAL,
      getParticipants: function (sid) {
        return sid === SID ? participants : [];
      }
    });
    model.setTake(SID, o.take === undefined ? 7 : o.take);
    model.syncParticipants();
    return { e, model, screen };
  }

  /* Liste de participants du plan : des deviceId nus, ou un objet pour un
   * rôle particulier (`{deviceId: STO, role: "storage"}`). */
  function parts() {
    return Array.prototype.slice.call(arguments).map(function (d) {
      if (typeof d === "string") return { deviceId: d, deviceName: d, role: "capture" };
      return Object.assign({ role: "capture", deviceName: d.deviceId }, d);
    });
  }

  /* Une frame « reçue », au format de preview-inbox (J09-04). */
  function frame(did, seq, over) {
    return Object.assign({
      sessionId: SID, takeNumber: 7, deviceId: did,
      startPlanId: "J0905#7#1#1", seq: seq,
      capturedAt: 1000 + seq * 1000, receivedAt: 1000 + seq * 1000,
      mime: "image/jpeg", width: 1339, height: 752,
      bytes: 1000 + seq, jpegBase64: "SEVMTA" + seq
    }, over || {});
  }

  function ids(m) {
    return m.view().slots.map(function (s) { return s.deviceId; });
  }

  function slotOf(m, did) {
    return m.view().slots.filter(function (s) { return s.deviceId === did; })[0] || null;
  }

  function indexOf(m, did) {
    return ids(m).indexOf(did);
  }

  /* ---------- M1 / M2 : un slot par Capture du Take ---------- */

  describe("J09-05 mosaïque — slots = Captures du Take", () => {
    it("M1. Take avec 1 Capture -> exactement 1 slot", () => {
      const { model: m } = env(parts(A));
      const v = m.view();
      if (v.slots.length !== 1) throw new Error("attendu 1 slot, obtenu " + v.slots.length);
      if (v.slots[0].deviceId !== A) throw new Error("mauvais device: " + v.slots[0].deviceId);
      if (v.sessionId !== SID || v.takeNumber !== 7) throw new Error("Take non exposé");
    });

    it("M2. Take avec 2 Captures -> 2 slots DANS L'ORDRE DU TAKE", () => {
      const { model: m } = env(parts(A, B));
      const v = m.view();
      if (v.slots.length !== 2) throw new Error("attendu 2 slots, obtenu " + v.slots.length);
      if (v.slots[0].deviceId !== A || v.slots[1].deviceId !== B) {
        throw new Error("ordre non figé: " + ids(m).join(","));
      }
      /* Le Storage ne participe PAS à la mosaïque : il ne crée aucun slot. */
      const { model: m2 } = env(parts(A, { deviceId: STO, role: "storage" }));
      if (m2.view().slots.length !== 1) throw new Error("un Storage ne doit pas créer de vignette");
    });
  });

  /* ---------- M3 / M4 / M5 : placeholder puis remplacement ---------- */

  describe("J09-05 mosaïque — placeholder et remplacement", () => {
    it("M3. aucune frame reçue -> le slot existe avec placeholder", () => {
      const { model: m, screen } = env(parts(A, B));
      const s = slotOf(m, A);
      if (!s) throw new Error("slot absent sans frame");
      if (s.lastFrame !== null) throw new Error("lastFrame doit valoir null");
      if (s.lastFrameSeq !== 0) throw new Error("lastFrameSeq doit valoir 0");
      if (s.deviceName !== A) throw new Error("nom de device absent du slot");
      const tiles = screen.tiles(m.view());
      const ta = tiles.filter(function (t) { return t.deviceId === A; })[0];
      if (!ta) throw new Error("pas de vignette pour A");
      if (!ta.placeholder) throw new Error("placeholder attendu quand aucune image n'est reçue");
      if (ta.imgSrc !== null) throw new Error("aucune image ne doit être inventée");
    });

    it("M4. frame reçue pour B -> SEULE la vignette B change", () => {
      const { model: m, screen } = env(parts(A, B));
      m.onPreviewFrame(frame(B, 1));
      const after = m.view();
      const a = slotOf(m, A);
      if (a.lastFrame !== null) throw new Error("A ne doit pas recevoir l'image de B");
      if (slotOf(m, B).lastFrame === null) throw new Error("B n'a pas reçu sa frame");
      if (after.slots.length !== 2) throw new Error("le nombre de slots ne doit pas changer");
      const ta = screen.tiles(after).filter(function (t) { return t.deviceId === A; })[0];
      if (!ta.placeholder) throw new Error("A doit rester en placeholder");
      if (ta.imgSrc !== null) throw new Error("aucune image ne doit etre inventee pour A");
    });

    it("M5. frame suivante pour B -> image REMPLACÉE, pas de vignette ajoutée", () => {
      const { model: m } = env(parts(A, B));
      m.onPreviewFrame(frame(B, 1));
      m.onPreviewFrame(frame(B, 2));
      const v = m.view();
      if (v.slots.length !== 2) throw new Error("une nouvelle frame ne doit pas créer un slot");
      const b = slotOf(m, B);
      if (b.lastFrameSeq !== 2) throw new Error("seq non avancée: " + b.lastFrameSeq);
      if (b.lastFrame.jpegBase64 !== "SEVMTA2") throw new Error("image non remplacée");
      if (!b.lastFrameAt) throw new Error("lastFrameAt non renseigné");
    });
  });

  /* ---------- M6 / M7 / M8 : déconnexion, reconnexion, ordre ---------- */

  describe("J09-05 mosaïque — déconnexion / reconnexion", () => {
    it("M6. B se déconnecte -> index inchangé, image conservée, état Déconnecté", () => {
      const { model: m, screen } = env(parts(A, B));
      m.onPreviewFrame(frame(B, 5));
      const idxBefore = indexOf(m, B);
      m.setLiveness(B, false);
      const v = m.view();
      const b = slotOf(m, B);
      if (indexOf(m, B) !== idxBefore) throw new Error("la vignette a BOUGÉ");
      if (v.slots.length !== 2) throw new Error("un slot ne doit JAMAIS disparaître");
      if (!b.lastFrame) throw new Error("la dernière image doit être conservée");
      if (b.lastFrameSeq !== 5) throw new Error("la seq doit être figée");
      if (b.connected !== false) throw new Error("connected=false attendu");
      /* Déconnecté overrides STOPPED : la connectivité n'est pas l'enregistreur. */
      const tile = screen.tiles(v).filter(function (t) { return t.deviceId === B; })[0];
      if (tile.state !== "DECONNECTED") throw new Error("état attendu DECONNECTED, obtenu " + tile.state);
      if (!tile.dimmed) throw new Error("la vignette doit être assombrie");
      if (tile.imgSrc === null) throw new Error("l'image figée doit rester affichée");
    });

    it("M7. B se reconnecte -> MÊME slot, nouvelle image, sans action opérateur", () => {
      const { model: m, screen } = env(parts(A, B));
      m.onPreviewFrame(frame(B, 5));
      const idxBefore = indexOf(m, B);
      m.setLiveness(B, false);
      m.setLiveness(B, true);
      m.onPreviewFrame(frame(B, 6));
      const v = m.view();
      if (indexOf(m, B) !== idxBefore) throw new Error("la vignette a BOUGÉ à la reconnexion");
      const b = slotOf(m, B);
      if (b.lastFrameSeq !== 6) throw new Error("la nouvelle image doit remplacer l'ancienne");
      if (b.connected !== true) throw new Error("connected=true attendu");
      const tile = screen.tiles(v).filter(function (t) { return t.deviceId === B; })[0];
      if (tile.state !== "REC") throw new Error("état attendu REC, obtenu " + tile.state);
      if (tile.dimmed) throw new Error("la vignette ne doit plus être assombrie");
    });

    it("M8. frames A et B dans n'importe quel ordre -> ordre visuel INCHANGÉ", () => {
      const { model: m } = env(parts(A, B));
      const ordre0 = ids(m);
      [B, A, B, A, A, B].forEach(function (did, i) { m.onPreviewFrame(frame(did, i + 1)); });
      if (ids(m).join(",") !== ordre0.join(",")) throw new Error("ordre visuel modifié");
    });

    it("M15. une Capture retirée du plan en cours de Take garde sa vignette", () => {
      let list = parts(A, B);
      const { model: m, e } = env(list);
      /* Le plan change (B écarté) mais le Take, lui, continue. */
      list = parts(A);
      m.syncParticipants(list);
      const v = m.view();
      if (v.slots.length !== 2) throw new Error("un slot ne doit pas disparaître en cours de Take");
      if (ids(m).join(",") !== [A, B].join(",")) throw new Error("ordre figé rompu");
    });

    it("M14. un participant découvert plus tard est AJOUTÉ en fin, sans décaler", () => {
      let list = parts(A);
      const { model: m, e } = env(list);
      const before = ids(m);
      list = parts(A, B, C);
      m.syncParticipants(list);
      const v = m.view();
      if (v.slots.length !== 3) throw new Error("3 slots attendus");
      if (v.slots[0].deviceId !== before[0]) throw new Error("le premier slot a bougé");
      if (v.slots[1].deviceId !== B || v.slots[2].deviceId !== C) {
        throw new Error("ajout non respecté: " + ids(m).join(","));
      }
    });
  });

  /* ---------- M9 / M10 / M13 : aucun mélange ---------- */

  describe("J09-05 mosaïque — cloisonnement session / Take", () => {
    it("M9. frame d'une Capture HORS TAKE -> ignorée et comptée", () => {
      const { model: m } = env(parts(A, B));
      m.onPreviewFrame(frame(C, 1));
      const v = m.view();
      if (v.slots.length !== 2) throw new Error("un slot a été créé pour une Capture hors Take");
      if (v.stats.framesIgnored !== 1) throw new Error("la frame aurait dû être ignorée+comptée");
    });

    it("M10. frame d'une AUTRE session ou d'un AUTRE Take -> ignorée", () => {
      const { model: m } = env(parts(A));
      m.onPreviewFrame(frame(A, 1, { sessionId: SID2 }));
      m.onPreviewFrame(frame(A, 2, { takeNumber: 99 }));
      const v = m.view();
      if (v.slots[0].lastFrame !== null) throw new Error("image d'une autre session/Take appliquée");
      if (v.stats.framesIgnored !== 2) throw new Error("2 frames à ignorer, comptées " + v.stats.framesIgnored);
      if (v.stats.framesApplied !== 0) throw new Error("aucune frame ne devait être appliquée");
    });

    it("M13. Take suivant -> slots reconstruits, aucun reliquat du Take précédent", () => {
      const { model: m } = env(parts(A, B));
      m.onPreviewFrame(frame(A, 1));
      m.setTake(SID, 8);
      m.syncParticipants();
      const v = m.view();
      if (v.takeNumber !== 8) throw new Error("Take non basculé");
      if (v.slots.length !== 2) throw new Error("2 slots attendus sur le nouveau Take");
      if (v.slots[0].lastFrame !== null) throw new Error("image du Take précédent conservée");
      if (v.stats.framesIgnored !== 0) throw new Error("compteurs non remis à zéro");
    });
  });

  /* ---------- M11 / M12 : STOPPED et device local ---------- */

  describe("J09-05 mosaïque — STOPPED et Master local", () => {
    it("M11. Capture STOPPED localement -> slot conservé, image FIGÉE, état STOPPED", () => {
      const { model: m, screen } = env(parts(A, B));
      m.onPreviewFrame(frame(B, 3));
      m.setStatus(B, "STOPPED");
      const v = m.view();
      const b = slotOf(m, B);
      if (v.slots.length !== 2) throw new Error("STOPPED ne doit pas retirer la vignette");
      if (!b.lastFrame) throw new Error("la dernière image doit rester");
      if (b.lastFrameSeq !== 3) throw new Error("l'image doit être FIGÉE");
      if (b.status !== "STOPPED") throw new Error("status non enregistré");
      const tile = screen.tiles(v).filter(function (t) { return t.deviceId === B; })[0];
      if (tile.state !== "STOPPED") throw new Error("état attendu STOPPED, obtenu " + tile.state);
      if (tile.dimmed) throw new Error("STOPPED n'est pas une déconnexion : pas de gris de hors-ligne");
    });

    it("M12. Master local aussi Capture -> slot marqué local, AUCUN badge « ce device »", () => {
      const { model: m, screen } = env(parts(LOCAL, A), { localDid: LOCAL });
      const v = m.view();
      const s = slotOf(m, LOCAL);
      if (!s) throw new Error("le device local doit avoir sa vignette");
      if (s.isLocal !== true) throw new Error("isLocal non marqué");
      const tiles = screen.tiles(v);
      const t = tiles.filter(function (x) { return x.deviceId === LOCAL; })[0];
      if (!t) throw new Error("pas de vignette locale");
      if (!t.isLocal) throw new Error("le contour local doit être porté par la vignette");
      /* Le contrat est double : aucun badge textuel, et AUCUNE image réseau
       * pour le device local (pas de loopback). */
      const texts = tiles.map(function (x) { return x.badges.join(" "); }).join("|");
      if (/ce device|m yourself|local/i.test(texts)) throw new Error("badge textuel interdit: " + texts);
      if (t.imgSrc !== null) throw new Error("le device local ne doit pas recevoir sa preview par le WS");
      if (!t.nativePreview) throw new Error("la vignette locale doit declarer la preview native");
    });
  });

  /* ---------- M16 : aucune logique de tri dynamique ---------- */

  describe("J09-05 mosaïque — l'ordre ne bouge jamais", () => {
    it("M16. rafales + pannes + noms différents -> ordre strictement stable", () => {
      const list = [
        { deviceId: A, deviceName: "Cam Zzz" },
        { deviceId: B, deviceName: "Cam Aaa" },
        { deviceId: C, deviceName: "Cam Mmm" }
      ];
      const { model: m, e } = env(list);
      const ordre0 = ids(m);
      /* Le nom est redefini « au fil de l'eau », comme le fait un renommage. */
      m.syncParticipants([
        { deviceId: A, deviceName: "Renomme 1" },
        { deviceId: B, deviceName: "Renomme 2" },
        { deviceId: C, deviceName: "Renomme 3" }
      ]);
      for (let i = 0; i < 12; i++) {
        const did = [C, A, B][i % 3];
        m.onPreviewFrame(frame(did, i + 1));
        if (i % 4 === 0) m.setLiveness(did, false);
        if (i % 4 === 2) m.setLiveness(did, true);
        if (i % 5 === 0) m.setStatus(did, "STOPPED");
      }
      if (ids(m).join(",") !== ordre0.join(",")) throw new Error("ordre instable: " + ids(m).join(","));
      /* Un renommage peut suivre le plan : ce qui est FIGE, c'est la position.
       * Le libellé n'a jamais été une clé de tri (cf. §ordre figé). */
      const names = m.view().slots.map(function (s) { return s.deviceName; });
      if (names[0] !== "Renomme 1") throw new Error("le libelle devrait suivre le plan: " + names[0]);
      if (ids(m).join(",") !== ordre0.join(",")) throw new Error("le renommage a deplace la vignette");
    });
  });

  /* ---------- M17..M19 : le RENDU DOM (couche de projection) ---------- */

  /* Les tests ci-dessus travaillent sur le modèle et la couche pure. Le rendu
   * DOM, lui, n'avait JAMAIS été exécuté en test : c'est pourtant là que le
   * smoke physique a trouvé un défaut bloquant (`grid.children.indexOf is not
   * a function` — `children` est une HTMLCollection, elle n'a pas `indexOf`).
   * Conséquence sur les devices : le rendu s'interrompait à la DEUXIÈME vignette
   * (mosaïque 2+ Captures) et l'en-tête (compteur, Take, timer) n'était jamais
   * écrit — les valeurs HTML par défaut restaient affichées.
   *
   * Le faux DOM ci-dessous reproduit donc le contrat du WebView : `children`
   * est une collection ARRAY-LIKE SANS `indexOf`, et `querySelector` ne sait
   * que lire les sélecteurs de classe utilisés par l'écran. */

  const DOM_IDS = ["liveGrid", "liveSession", "liveTake", "liveTimer", "liveCount", "livePhase", "liveEmpty"];

  /* Les tests DOM assertent sur les NOMS affichés : on donne donc des noms
   * lisibles, distincts de l'ordre, pour prouver que l'ordre ne vient pas d'un
   * tri par libellé. */
  function named(did, name) {
    return { deviceId: did, deviceName: name, role: "capture" };
  }

  function envDom(participants, opts) {
    const o = opts || {};
    const e = createEnv({});
    loadAll(e, ["state/preview-inbox.js", "state/live-model.js", "ui/live.js"]);
    const dom = fakeDom(DOM_IDS);
    e.document = dom;
    e.window.document = dom;
    const model = e.window.MultiCamLiveModel;
    const screen = e.window.MultiCamLiveScreen;
    model.bind({
      localDid: o.localDid || LOCAL,
      getParticipants: function (sid) { return sid === SID ? participants : []; }
    });
    model.setTake(SID, o.take === undefined ? 7 : o.take);
    model.syncParticipants();
    return { e, model, screen, dom };
  }

  function nomsTiles(grid) {
    return Array.prototype.slice.call(grid.children).map(function (t) {
      const n = t.querySelector(".tile-name");
      return n ? n.textContent : "?";
    });
  }

  /* J09-08c : le segment publié par une Capture doit atteindre la supervision
   * Master's SANS être republié ni réinterprété par l'écran. Un champ perdu
   * entre l'inbox et la vue serait un Master's affichant un segment sans son
   * état — donc une segmentation qu'il ne peut pas nommer. */
  describe("J09-08c mosaïque — l'état du segment publié traverse jusqu'à l'écran", () => {
    function envSupervision(participants, loadCamera) {
      const e = createEnv({});
      const files = ["state/preview-inbox.js", "state/live-model.js", "ui/live.js"];
      if (loadCamera !== false) {
        files.push("state/camera-switch-model.js", "state/camera-state-inbox.js");
      }
      loadAll(e, files);
      const model = e.window.MultiCamLiveModel;
      model.bind({
        localDid: LOCAL,
        getParticipants: function (sid) { return sid === SID ? participants : []; }
      });
      model.setTake(SID, 7);
      model.syncParticipants();
      return { e, model };
    }

    it("C1. la supervision Master's lit le segment, son état et l'enregistrement", () => {
      const parts = [{ deviceId: A, deviceName: A, role: "capture" }];
      const { e, model } = envSupervision(parts);
      const inbox = e.window.MultiCamCameraStateInbox;

      /* Un `camera_state` de Capture, tel que le transport le délivre. */
      if (!inbox.record({
        sessionId: SID, deviceId: A, from: A,
        availableCameras: ["REAR", "FRONT"],
        activeCamera: "FRONT", requestedCamera: "FRONT",
        segmentIndex: 2, segmentState: "recording", recording: true,
        phase: "REC", atMs: 1000, updatedAtMs: 1000
      })) throw new Error("camera_state refuse a tort");

      const slot = model.view().slots.filter((s) => s.deviceId === A)[0];
      if (!slot || !slot.camera) throw new Error("la supervision ignore l'etat recu");
      eq(slot.camera.source, "supervision", "l'etat vient bien de la Capture distante");
      eq(slot.camera.activeCamera, "FRONT");
      eq(slot.camera.segmentIndex, 2, "le segment EN COURS est designe par son index");
      eq(slot.camera.segmentState, "recording", "et son etat reel l'accompagne");
      eq(slot.camera.recording, true, "le Master's voit que la Capture filme");
    });

    it("C2. apres le STOP : segmentIndex 0 et plus d'enregistrement suppose", () => {
      const parts = [{ deviceId: A, deviceName: A, role: "capture" }];
      const { e, model } = envSupervision(parts);
      const inbox = e.window.MultiCamCameraStateInbox;

      inbox.record({
        sessionId: SID, deviceId: A, from: A, availableCameras: ["REAR"],
        activeCamera: "REAR", segmentIndex: 1, segmentState: "recording",
        recording: true, atMs: 1000, updatedAtMs: 1000
      });
      inbox.record({
        sessionId: SID, deviceId: A, from: A, availableCameras: ["REAR"],
        activeCamera: "REAR", segmentIndex: 0, segmentState: "",
        recording: false, atMs: 2000, updatedAtMs: 2000
      });

      const c = model.view().slots.filter((s) => s.deviceId === A)[0].camera;
      eq(c.segmentIndex, 0, "le STOP est visible : plus aucun segment en cours");
      eq(c.segmentState, "", "et il ne reste pas un etat fantome");
      eq(c.recording, false,
        "un Master's ne doit pas croire qu'un enregistrement existe encore");
    });
  });

  describe("J09-05 mosaïque — rendu DOM (projection du modèle)", () => {
    it("M17. 2 Captures -> DEUX vignettes rendues, dans l'ordre, en-tête écrit", () => {
      const { model: m, screen, dom } = envDom([named(A, "Cam A"), named(B, "Cam B")], {});
      m.onPreviewFrame(frame(A, 1));
      m.onPreviewFrame(frame(B, 1));
      const v = screen.render(m.view());
      const grid = dom.byId.liveGrid;
      if (grid.children.length !== 2) {
        throw new Error("2 vignettes attendues dans le DOM, obtenu " + grid.children.length);
      }
      if (nomsTiles(grid).join(",") !== "Cam A,Cam B") {
        throw new Error("ordre DOM incorrect: " + nomsTiles(grid).join(","));
      }
      /* L'en-tête est écrit par le MÊME rendu : une mosaïque qui n'affiche ni
       * le nombre de Captures ni le Take n'a pas rendu jusqu'au bout. */
      if (dom.byId.liveCount.textContent !== "2 Captures") {
        throw new Error("compteur non écrit: " + dom.byId.liveCount.textContent);
      }
      if (dom.byId.liveTake.textContent !== "Take 007") {
        throw new Error("Take non écrit: " + dom.byId.liveTake.textContent);
      }
      if (grid.className !== v.gridClass) throw new Error("classe de grille non appliquée");
      /* Le placeholder du B sans image… ici les deux ont une image : pas de
       * `is-placeholder`, et un `src` par vignette. */
      const media = Array.prototype.slice.call(grid.children).map(function (t) {
        return t.querySelector(".tile-media");
      });
      if (media.some(function (m) { return m.classList.contains("is-placeholder"); })) {
        throw new Error("placeholder present alors que les deux Captures ont une image");
      }
    });

    it("M18. re-rendu idempotent : memes vignettes, meme ordre, src non reassigne", () => {
      const { model: m, screen, dom } = envDom([named(A, "Cam A"), named(B, "Cam B")], {});
      m.onPreviewFrame(frame(A, 1));
      m.onPreviewFrame(frame(B, 1));
      screen.render(m.view());
      const grid = dom.byId.liveGrid;
      const imgs = Array.prototype.slice.call(grid.children).map(function (t) { return t.querySelector("img"); });
      const src0 = imgs.map(function (i) { return i.getAttribute("src"); });
      const nodes0 = Array.prototype.slice.call(grid.children);
      screen.render(m.view());
      screen.render(m.view());
      if (grid.children.length !== 2) throw new Error("le re-rendu a duplique des vignettes");
      if (nomsTiles(grid).join(",") !== "Cam A,Cam B") throw new Error("ordre bouge au re-rendu");
      const nodes1 = Array.prototype.slice.call(grid.children);
      if (nodes0[0] !== nodes1[0] || nodes0[1] !== nodes1[1]) {
        throw new Error("les noeuds DOM doivent etre conserves d'un rendu a l'autre");
      }
      const src1 = nodes1.map(function (t) { return t.querySelector("img").getAttribute("src"); });
      if (src0.join("|") !== src1.join("|")) throw new Error("src reecrit sans changement de frame");
    });

    it("M19. vignette locale rendue SANS src et avec le contour .local", () => {
      const { model: m, screen, dom } = envDom([named(A, "Cam A"), named(LOCAL, "Regie-Cam")], { localDid: LOCAL });
      m.onPreviewFrame(frame(A, 1));
      screen.render(m.view());
      const grid = dom.byId.liveGrid;
      const tiles = Array.prototype.slice.call(grid.children);
      if (tiles.length !== 2) throw new Error("2 vignettes attendues, obtenu " + tiles.length);
      const local = tiles.filter(function (t) { return t.classList.contains("local"); })[0];
      if (!local) throw new Error("aucune vignette ne porte le contour .local");
      const img = local.querySelector("img");
      if (img.getAttribute("src")) throw new Error("la vignette locale ne doit pas porter de src");
      const media = local.querySelector(".tile-media");
      if (!media.classList.contains("is-native")) {
        throw new Error("la vignette locale doit declarer la preview native");
      }
      if (media.classList.contains("is-placeholder")) {
        throw new Error("la vignette locale n'est pas un placeholder : elle est transparente");
      }
    });

    it("M20. changement de Take -> aucune vignette du Take precedent dans le DOM", () => {
      const { model: m, screen, dom } = envDom([named(A, "Cam A")], {});
      m.onPreviewFrame(frame(A, 1));
      screen.render(m.view());
      const grid = dom.byId.liveGrid;
      if (grid.children.length !== 1) throw new Error("une vignette attendue avant le Take 2");
      m.setTake(SID, 8);
      m.syncParticipants([{ deviceId: B, deviceName: "Cam B", role: "capture" }]);
      screen.render(m.view());
      if (grid.children.length !== 1) {
        throw new Error("reliquat du Take 1 : " + grid.children.length + " vignettes");
      }
      if (nomsTiles(grid)[0] !== "Cam B") {
        throw new Error("la vignette du Take 2 n'est pas rendue: " + nomsTiles(grid)[0]);
      }
    });
  });
}

module.exports = { register };
