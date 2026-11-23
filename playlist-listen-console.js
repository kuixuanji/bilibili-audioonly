(() => {
  const stores = document.querySelector("#app")?.__vue_app__
    ?.config.globalProperties.$pinia?._s;
  const state = stores?.get("usePlayerStore");

  function readPlayerStatus() {
    const abTest = stores?.get("AbTestStore");
    return {
      pcListenEnabled: abTest?.isListenVideoEnabled,
      bizType: state.bizType,
      isPlayLocal: state.isPlayLocal,
      isListenSupported: state.isListenSupported,
    };
  }

  if (state && !state.bizType) return readPlayerStatus();

  const playlist = stores?.get("useMediaListStore");
  const player = window.biliPlayer;
  if (!state || typeof playlist?.changeMediaPage !== "function"
      || typeof playlist.changeP !== "function" || !player?.isInitialized?.()
      || typeof player.setRichPipMode !== "function"
      || typeof player.setRichPipEntryEnabled !== "function"
      || typeof player.on !== "function" || typeof player.off !== "function") {
    throw new Error("请在已经开始播放的播单窗口运行，例如稍后再看。");
  }

  window.stopPlaylistListen?.();
  const { bizType, bizId } = state;
  const setMode = player.setRichPipMode;
  const setEntryEnabled = player.setRichPipEntryEnabled;
  const changeP = playlist.changeP;
  const container = player.getElements?.()?.container;
  const panelSelector = ".bpx-player-rich-pip-audio-active";
  const buttonSelector = 'button[data-action="audio-prev"], button[data-action="audio-next"]';
  const playbackModeSelector = `${panelSelector} [data-action="audio-loop"]`;
  const showEndPanelEvent = "Player_Show_EndPanel";
  const listenEntryEvent = "Player_RichPip_Entry";
  const loadedMetadataEvent = "Player_LoadedMetadata";
  let wantsListenMode = false;
  let savedVideoQuality;
  let pendingVideoQuality;
  let restoringVideoQuality = false;
  let randomOrder = [];
  let updateTimer;
  let compactButtonStyle;

  function samePlaylist() {
    return window.biliPlayer === player && state.bizType === bizType && state.bizId === bizId;
  }
 
  function keepListenMode(mode) {
    return setMode.call(this, mode === "video" && wantsListenMode && samePlaylist() ? "listen" : mode);
  }

  function keepListenEntryEnabled(enabled) {
    return setEntryEnabled.call(this, samePlaylist() || enabled);
  }

  function videoQuality() {
    const quality = player.getQuality?.();
    const real = Number(quality?.realQ);
    const selected = Number(quality?.nowQ);
    if (Number.isFinite(real) && real > 0) return real;
    return Number.isFinite(selected) && selected > 0 ? selected : undefined;
  }

  function onListenEntry(event) {
    const { action, isEnter } = event?.detail ?? {};
    if (action !== "click" || !samePlaylist() || state.isChanging || state.dataLoading
        || restoringVideoQuality) return;

    if (isEnter) {
      savedVideoQuality = pendingVideoQuality?.quality ?? videoQuality();
      pendingVideoQuality = undefined;
      wantsListenMode = true;
      setMode.call(player, "listen");
      return;
    }

    wantsListenMode = false;
    pendingVideoQuality = savedVideoQuality ? {
      quality: savedVideoQuality,
      cid: player.getManifest?.()?.cid,
      oldMedia: player.mediaElement?.(),
      startedAt: performance.now(),
      metadataReady: false,
    } : undefined;
    savedVideoQuality = undefined;
    setMode.call(player, "video");
  }

  function onLoadedMetadata() {
    if (pendingVideoQuality) pendingVideoQuality.metadataReady = true;
  }

  async function applyVideoQuality(quality) {
    const kernel = player.__core?.();
    const tracks = kernel?.getQualityList?.("video");
    if (Array.isArray(tracks) && typeof kernel.setQualityFor === "function") {
      if (!tracks.some(track => Number(track.id) === quality)) return;

      // Only change the active DASH stream. Keep the player's Auto preference intact.
      const dash = kernel.getCorePlayer?.();
      const wasAuto = dash?.getAutoSwitchQualityFor?.("video") === true;
      if (wasAuto) dash.setAutoSwitchQualityFor("video", false);
      try {
        await kernel.setQualityFor("video", quality, 10);
      } finally {
        if (wasAuto && player.__core?.() === kernel) dash.setAutoSwitchQualityFor("video", true);
      }
    } else if (player.getSupportedQualityList?.()?.some(qn => Number(qn) === quality)
        && Number(player.getQuality?.()?.nowQ) !== quality) {
      await player.requestQuality?.(quality);
    }
  }

  function restoreVideoQuality() {
    const pending = pendingVideoQuality;
    if (!pending) return;

    const elapsed = performance.now() - pending.startedAt;
    if (player.getManifest?.()?.cid !== pending.cid || elapsed > 15000) {
      pendingVideoQuality = undefined;
      return;
    }

    // The native player replaces the video element on seamless restore, or reloads its metadata.
    const media = player.mediaElement?.();
    if (state.isChanging || state.dataLoading || !media?.videoHeight || media.readyState < 2
        || (media === pending.oldMedia && !pending.metadataReady && elapsed < 11000)) return;

    pendingVideoQuality = undefined;
    if (Number(player.getQuality?.()?.realQ) === pending.quality) return;

    restoringVideoQuality = true;
    applyVideoQuality(pending.quality)
      .catch(error => console.warn("恢复进入听视频前的清晰度失败", error))
      .finally(() => { restoringVideoQuality = false; });
  }

  function showCompactReturnButton() {
    if (!container) return;
    container.setAttribute("data-playlist-listen-controls", "");
    compactButtonStyle = document.createElement("style");
    const actions = "[data-playlist-listen-controls] .bpx-player-rich-pip-audio-active .bpx-player-rich-pip-audio-top-actions[hidden]";
    compactButtonStyle.textContent = `
      ${actions} { display: flex !important; }
      ${actions} > :not(.bpx-player-listen-entry) { display: none !important; }
    `;
    document.head.appendChild(compactButtonStyle);
  }

  function playbackMode() {
    if (!samePlaylist()) return undefined;
    return document.querySelector(playbackModeSelector)?.dataset.richPipAudioPlaybackMode;
  }

  function playableGroups() {
    return (playlist.videoList ?? []).filter(group => !group.disabled && group.itemList?.length);
  }

  function adjacentItems(wrap = false) {
    if (state.isChanging || state.dataLoading) return {};

    const entries = playableGroups()
      .flatMap(group => group.itemList.map(item => ({ group, item })));
    const current = playlist.currentVideoInfo;
    const index = entries.findIndex(({ item }) => item === current);
    if (index === -1) return {};

    const canWrap = wrap && entries.length > 1
      && !(playlist.mediaListLen > playlist.videoList.length);
    const wrapsNext = canWrap && index === entries.length - 1;
    return {
      "audio-prev": entries[index - 1] ?? (canWrap ? entries.at(-1) : undefined),
      "audio-next": wrapsNext ? entries[0] : entries[index + 1],
      wrapsNext,
    };
  }

  function randomSelection() {
    if (state.isChanging || state.dataLoading) return null;

    const groups = playableGroups();
    if (groups.length < 2) return null;
    const currentGroup = groups.find(group => group.itemList.includes(playlist.currentVideoInfo));
    return currentGroup ? { groups, currentGroup } : null;
  }

  function selectItem(target, autoNext = false) {
    state.delayOutInfo = { spmid: "main.play-detail.playlist.all.click", autoNext };
    playlist.changeMediaPage({ ...target, bizType });
  }

  function playRandomItem(offset, autoNext = false) {
    const selection = randomSelection();
    if (!selection) return;

    const { groups, currentGroup } = selection;
    const previousGroups = new Set(randomOrder);
    if (randomOrder.length !== groups.length || groups.some(group => !previousGroups.has(group))) {
      randomOrder = groups.slice();
      for (let index = randomOrder.length - 1; index > 0; index--) {
        const other = Math.floor(Math.random() * (index + 1));
        [randomOrder[index], randomOrder[other]] = [randomOrder[other], randomOrder[index]];
      }
    }

    const index = randomOrder.indexOf(currentGroup);
    const group = randomOrder[(index + offset + randomOrder.length) % randomOrder.length];
    selectItem({ group, item: group.itemList[0] }, autoNext);
  }

  function suppressPlaylistRecommendation() {
    const mode = playbackMode();
    if (mode === "random" || (mode === "handoff" && (state.isChanging || adjacentItems(true).wrapsNext))) {
      state.autoPlayRecommend = false;
    }
  }

  function changePInListenMode(detail) {
    const mode = playbackMode();
    if ((mode !== "random" && mode !== "handoff")
        || !(detail?.offset > 0) || !(detail.auto || detail.listLoop)) {
      return changeP.call(this, detail);
    }

    if (state.isChanging) return true;
    const adjacent = mode === "handoff" ? adjacentItems(true) : null;
    if (adjacent && !adjacent.wrapsNext) return changeP.call(this, detail);

    state.autoPlayRecommend = false;
    if (detail.cid == null || Number(detail.cid) === Number(playlist.currentVideoInfo?.cid)) {
      const autoNext = Boolean(detail.showEnd);
      if (adjacent) selectItem(adjacent["audio-next"], autoNext);
      else playRandomItem(1, autoNext);
    }
    return true;
  }

  function updateButtons() {
    if (!samePlaylist()) {
      stop();
      if (!state.bizType) console.log(readPlayerStatus());
      return;
    }

    const panel = document.querySelector(panelSelector);
    if (!panel) {
      restoreVideoQuality();
      return;
    }
    const mode = playbackMode();
    const random = mode === "random";
    if (!random) randomOrder = [];
    const adjacent = random ? null : adjacentItems(mode === "handoff");
    const randomDisabled = random && !randomSelection();
    for (const button of panel.querySelectorAll(buttonSelector)) {
      const disabled = random ? randomDisabled : !adjacent[button.dataset.action];
      if (button.disabled !== disabled) button.disabled = disabled;
    }
  }

  function onArrowClick(event) {
    const button = event.target.closest?.(buttonSelector);
    if (!samePlaylist() || !button?.closest(panelSelector)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const action = button.dataset.action;
    const mode = playbackMode();
    if (mode === "random") {
      playRandomItem(action === "audio-next" ? 1 : -1);
    } else {
      const target = adjacentItems(mode === "handoff")[action];
      if (!target) return;
      selectItem(target);
    }
    updateButtons();
  }

  function stop() {
    clearInterval(updateTimer);
    pendingVideoQuality = undefined;
    window.removeEventListener("click", onArrowClick, true);
    player.off(showEndPanelEvent, suppressPlaylistRecommendation);
    player.off(listenEntryEvent, onListenEntry);
    player.off(loadedMetadataEvent, onLoadedMetadata);
    if (player.setRichPipMode === keepListenMode) player.setRichPipMode = setMode;
    if (player.setRichPipEntryEnabled === keepListenEntryEnabled) player.setRichPipEntryEnabled = setEntryEnabled;
    if (playlist.changeP === changePInListenMode) playlist.changeP = changeP;
    if (window.stopPlaylistListen === stop) delete window.stopPlaylistListen;
    container?.removeAttribute("data-playlist-listen-controls");
    compactButtonStyle?.remove();
    if (window.biliPlayer === player) {
      setMode.call(player, "video");
      setEntryEnabled.call(player, Boolean(state.isListenSupported && !state.isMini));
    }
  }

  if (!Reflect.set(player, "setRichPipMode", keepListenMode)
      || player.setRichPipMode !== keepListenMode) {
    throw new Error("当前播放器的模式方法不可替换。");
  }

  try {
    if (!Reflect.set(playlist, "changeP", changePInListenMode)
        || playlist.changeP !== changePInListenMode) {
      throw new Error("当前播单的换集方法不可替换。");
    }
    if (!Reflect.set(player, "setRichPipEntryEnabled", keepListenEntryEnabled)
        || player.setRichPipEntryEnabled !== keepListenEntryEnabled) {
      throw new Error("当前播放器的听视频入口不可替换。");
    }
    showCompactReturnButton();
    setMode.call(player, "video");
    setEntryEnabled.call(player, true);
    window.stopPlaylistListen = stop;
    player.on(showEndPanelEvent, suppressPlaylistRecommendation);
    player.on(listenEntryEvent, onListenEntry);
    player.on(loadedMetadataEvent, onLoadedMetadata);
    window.addEventListener("click", onArrowClick, true);
    updateTimer = setInterval(updateButtons, 250);
    updateButtons();
  } catch (error) {
    stop();
    throw error;
  }

  return { bizType, listening: Boolean(document.querySelector(panelSelector)) };
})();
