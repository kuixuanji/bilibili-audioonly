(() => {
  const stores = document.querySelector("#app")?.__vue_app__
    ?.config.globalProperties.$pinia?._s;
  const state = stores?.get("usePlayerStore");

  function enableOrdinaryListen() {
    const abTest = stores?.get("AbTestStore");
    if (!abTest) throw new Error("请在已加载视频的播放窗口运行");

    const config = abTest.abTestConf;
    abTest.abTestConf = {
      ...config,
      pc_listen: { ...config?.pc_listen, value: "1" },
    };
    return abTest.isListenVideoEnabled;
  }

  if (state && !state.bizType) return enableOrdinaryListen();

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
  const qualityRequestedEvent = "Player_Quality_Requested";
  let wantsListenMode = false;
  let rememberedVideoQuality;
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
    const qn = Number.isFinite(real) && real > 0 ? real : selected;
    if (!Number.isFinite(qn) || qn <= 0) return undefined;

    const media = player.mediaElement?.();
    return { qn, width: media?.videoWidth, height: media?.videoHeight };
  }

  function preferredVideoQuality(saved, tracks) {
    const available = tracks.filter(track => {
      const qn = Number(track.id);
      return Number.isFinite(qn) && qn > 0;
    });
    const exact = available.find(track => Number(track.id) === saved.qn);
    const sameSize = exact ?? available.find(track => saved.width && saved.height
      && Number(track.width) === saved.width && Number(track.height) === saved.height);
    if (sameSize) return Number(sameSize.id);

    const pixels = track => Number(track.width) * Number(track.height);
    const hasDimensions = available.every(track => Number.isFinite(pixels(track)) && pixels(track) > 0);
    available.sort((first, second) => (hasDimensions ? pixels(second) - pixels(first) : 0)
      || Number(second.id) - Number(first.id));
    return available.length ? Number(available[0].id) : undefined;
  }

  function switchToVideo(saved) {
    const kernel = player.__core?.();
    const manifestTracks = kernel?.getMpd?.()?.video;
    const qn = saved && Array.isArray(manifestTracks) ? preferredVideoQuality(saved, manifestTracks) : undefined;
    const getQualityList = kernel?.getQualityList;
    if (!(qn > 0) || Number(player.getQuality?.()?.realQ) === qn
        || typeof getQualityList !== "function" || typeof kernel.getQualityFor !== "function") {
      return setMode.call(player, "video");
    }

    // Native recovery reads realQ from the old DASH kernel before creating the new video track.
    // After audio-only startup the old kernel can have a manifest but no active video bitrate list.
    function getRestoreQualityList(type) {
      const tracks = getQualityList.call(this, type);
      if (type !== "video") return tracks;
      const currentIndex = this.getQualityFor(type);
      const list = tracks?.slice() ?? [];
      list[currentIndex] = { ...list[currentIndex], id: qn };
      return list;
    }

    const descriptor = Object.getOwnPropertyDescriptor(kernel, "getQualityList");
    if (!Reflect.set(kernel, "getQualityList", getRestoreQualityList)) {
      return setMode.call(player, "video");
    }
    try {
      return setMode.call(player, "video");
    } finally {
      if (descriptor) Object.defineProperty(kernel, "getQualityList", descriptor);
      else delete kernel.getQualityList;
    }
  }

  function onListenEntry(event) {
    const { action, isEnter } = event?.detail ?? {};
    if (action !== "click" || !samePlaylist() || state.isChanging || state.dataLoading
        || restoringVideoQuality) return;

    if (isEnter) {
      rememberedVideoQuality ??= videoQuality();
      pendingVideoQuality = undefined;
      wantsListenMode = true;
      setMode.call(player, "listen");
      return;
    }

    wantsListenMode = false;
    pendingVideoQuality = rememberedVideoQuality ? {
      quality: rememberedVideoQuality,
      cid: player.getManifest?.()?.cid,
      oldMedia: player.mediaElement?.(),
      startedAt: performance.now(),
      metadataReady: false,
      retryAt: 0,
    } : undefined;
    switchToVideo(pendingVideoQuality?.quality);
  }

  function onLoadedMetadata() {
    if (pendingVideoQuality) pendingVideoQuality.metadataReady = true;
  }

  function onQualityRequested(event) {
    const { mediaType, isAutomatic } = event?.detail ?? {};
    if (mediaType === "video" && isAutomatic === false && samePlaylist() && !wantsListenMode
        && !restoringVideoQuality && !state.isChanging && !state.dataLoading) {
      rememberedVideoQuality = undefined;
      pendingVideoQuality = undefined;
    }
  }

  async function applyVideoQuality(quality, kernel) {
    if (kernel) {
      // Only change the active DASH stream. Keep the player's Auto preference intact.
      const dash = kernel.getCorePlayer?.();
      const wasAuto = dash?.getAutoSwitchQualityFor?.("video") === true;
      if (wasAuto) dash.setAutoSwitchQualityFor("video", false);
      try {
        await kernel.setQualityFor("video", quality, 10);
      } finally {
        if (wasAuto && player.__core?.() === kernel) dash.setAutoSwitchQualityFor("video", true);
      }
    } else if (Number(player.getQuality?.()?.nowQ) !== quality) {
      await player.requestQuality?.(quality);
    }
  }

  function finishVideoQualityRestore(pending, qn) {
    if (pendingVideoQuality !== pending) return;
    // Keep the original tier when this video needed a fallback.
    if (qn === pending.quality.qn) rememberedVideoQuality = undefined;
    pendingVideoQuality = undefined;
  }

  function restoreVideoQuality() {
    const pending = pendingVideoQuality;
    if (!pending || restoringVideoQuality) return;

    const now = performance.now();
    const elapsed = now - pending.startedAt;
    if (player.getManifest?.()?.cid !== pending.cid || elapsed > 20000) {
      pendingVideoQuality = undefined;
      if (pending.lastError && elapsed > 20000) {
        console.warn("恢复进入听视频前的清晰度失败", pending.lastError);
      }
      return;
    }

    // The native player replaces the video element on seamless restore, or reloads its metadata.
    const media = player.mediaElement?.();
    if (now < pending.retryAt || state.isChanging || state.dataLoading || !media?.videoHeight || media.readyState < 2
        || (media === pending.oldMedia && !pending.metadataReady && elapsed < 11000)) return;

    const kernel = player.__core?.();
    const dash = typeof kernel?.getQualityList === "function" && typeof kernel.setQualityFor === "function"
      ? kernel : undefined;
    const tracks = dash ? dash.getQualityList("video") : player.getSupportedQualityList?.()?.map(id => ({ id }));
    if (!tracks?.length) return;

    const qn = preferredVideoQuality(pending.quality, tracks);
    if (!(qn > 0) || Number(player.getQuality?.()?.realQ) === qn) {
      finishVideoQualityRestore(pending, qn);
      return;
    }

    restoringVideoQuality = true;
    applyVideoQuality(qn, dash)
      .then(() => finishVideoQualityRestore(pending, qn))
      .catch(error => {
        pending.lastError = error;
        pending.retryAt = performance.now() + 500;
      })
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
      if (!state.bizType) enableOrdinaryListen();
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
    player.off(qualityRequestedEvent, onQualityRequested);
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
    player.on(qualityRequestedEvent, onQualityRequested);
    window.addEventListener("click", onArrowClick, true);
    updateTimer = setInterval(updateButtons, 250);
    updateButtons();
  } catch (error) {
    stop();
    throw error;
  }

  return { bizType, listening: Boolean(document.querySelector(panelSelector)) };
})();
