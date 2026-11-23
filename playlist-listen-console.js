(() => {
  const stores = document.querySelector("#app")?.__vue_app__
    ?.config.globalProperties.$pinia?._s;
  const state = stores?.get("usePlayerStore");
  const playlist = stores?.get("useMediaListStore");
  const player = window.biliPlayer;
  if (!state?.bizType || typeof playlist?.changeMediaPage !== "function"
      || typeof playlist.changeP !== "function" || !player?.isInitialized?.()
      || typeof player.setRichPipMode !== "function"
      || typeof player.on !== "function" || typeof player.off !== "function") {
    throw new Error("请在已经开始播放的播单窗口运行，例如稍后再看。");
  }

  window.stopPlaylistListen?.();
  const { bizType, bizId } = state;
  const setMode = player.setRichPipMode;
  const changeP = playlist.changeP;
  const panelSelector = ".bpx-player-rich-pip-audio-active";
  const buttonSelector = 'button[data-action="audio-prev"], button[data-action="audio-next"]';
  const playbackModeSelector = `${panelSelector} [data-action="audio-loop"]`;
  const showEndPanelEvent = "Player_Show_EndPanel";
  let randomOrder = [];
  let updateTimer;

  function samePlaylist() {
    return window.biliPlayer === player && state.bizType === bizType && state.bizId === bizId;
  }
 
  function keepListenMode(mode) {
    return setMode.call(this, mode === "video" && samePlaylist() ? "listen" : mode);
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
      return;
    }

    const panel = document.querySelector(panelSelector);
    if (!panel) return;
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
    window.removeEventListener("click", onArrowClick, true);
    player.off(showEndPanelEvent, suppressPlaylistRecommendation);
    if (player.setRichPipMode === keepListenMode) player.setRichPipMode = setMode;
    if (playlist.changeP === changePInListenMode) playlist.changeP = changeP;
    if (window.stopPlaylistListen === stop) delete window.stopPlaylistListen;
    if (window.biliPlayer === player) setMode.call(player, "video");
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
    setMode.call(player, "listen");
    window.stopPlaylistListen = stop;
    player.on(showEndPanelEvent, suppressPlaylistRecommendation);
    window.addEventListener("click", onArrowClick, true);
    updateTimer = setInterval(updateButtons, 250);
    updateButtons();
  } catch (error) {
    stop();
    throw error;
  }

  return { bizType, listening: Boolean(document.querySelector(panelSelector)) };
})();
