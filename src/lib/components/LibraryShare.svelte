<script>
  import Icon from "@iconify/svelte";
  import { fade, fly, scale } from "svelte/transition";
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import SearchSort from "./SearchSort.svelte";
  import {
    libraryEnabled,
    libraryConnected,
    globalSongs,
    onlinePeers,
    downloadProgress,
    libraryError,
    connectLibrary,
    disconnectLibrary,
    toggleLibrary,
    requestSong,
    shareAll,
    toggleShareAll,
    sharedSongs,
    setSharedSongs,
    initLibrary,
    refreshSongs,
    developerMode,
    toggleDeveloperMode,
    discoveryServerUrl,
    setDiscoveryServer,
    startServer,
    stopServer,
    isHostingServer,
    shareNotification,
  } from "../stores/library.js";
  import { midiFiles } from "../stores/player.js";

  let searchQuery = "";
  let librarySortBy = "name-asc";
  let showSharePicker = false;
  let shareSearchQuery = "";

  const librarySortOptions = [
    { id: "name-asc", label: "A-Z", icon: "mdi:sort-alphabetical-ascending" },
    { id: "name-desc", label: "Z-A", icon: "mdi:sort-alphabetical-descending" },
    { id: "bpm-desc", label: "BPM ↓", icon: "mdi:music-note" },
    { id: "bpm-asc", label: "BPM ↑", icon: "mdi:music-note-outline" },
  ];
  let showDevSettings = false;
  let serverUrlInput = "";
  let serverPort = 3456;
  let showDownloadModal = false;
  let downloadingSong = null;

  // Share picker state
  let shareFilterMode = "all"; // "all", "selected", "unselected"
  let shareSortBy = "name-asc"; // matches SearchSort format
  let shareLetterFilter = ""; // "", "A", "B", etc. or "#" for numbers/symbols

  const shareSortOptions = [
    { id: "name-asc", label: "A-Z", icon: "mdi:sort-alphabetical-ascending" },
    { id: "name-desc", label: "Z-A", icon: "mdi:sort-alphabetical-descending" },
    { id: "bpm-desc", label: "BPM ↓", icon: "mdi:music-note" },
    { id: "bpm-asc", label: "BPM ↑", icon: "mdi:music-note-outline" },
  ];

  // Computed shared songs count
  $: sharedCount = $shareAll ? $midiFiles.length : $sharedSongs.length;

  // Generate alphabet for quick jump
  const alphabet = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")];

  // Filtered and sorted songs for share picker
  $: sharePickerSongs = (() => {
    let songs = [...$midiFiles];

    // Filter by search query
    if (shareSearchQuery) {
      const q = shareSearchQuery.toLowerCase();
      songs = songs.filter(f => f.name.toLowerCase().includes(q));
    }

    // Filter by letter
    if (shareLetterFilter) {
      if (shareLetterFilter === "#") {
        songs = songs.filter(f => !/^[a-zA-Z]/.test(f.name));
      } else {
        songs = songs.filter(f => f.name.toUpperCase().startsWith(shareLetterFilter));
      }
    }

    // Filter by selection status
    if (shareFilterMode === "selected") {
      songs = songs.filter(f => $sharedSongs.includes(f.path));
    } else if (shareFilterMode === "unselected") {
      songs = songs.filter(f => !$sharedSongs.includes(f.path));
    }

    // Sort
    switch (shareSortBy) {
      case "name-asc":
        songs.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "name-desc":
        songs.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case "bpm-desc":
        songs.sort((a, b) => (b.bpm || 0) - (a.bpm || 0));
        break;
      case "bpm-asc":
        songs.sort((a, b) => (a.bpm || 0) - (b.bpm || 0));
        break;
    }

    return songs;
  })();

  // Count songs starting with each letter (for badge display)
  $: letterCounts = (() => {
    const counts = { "#": 0 };
    alphabet.slice(1).forEach(l => counts[l] = 0);
    $midiFiles.forEach(f => {
      const first = f.name.charAt(0).toUpperCase();
      if (/[A-Z]/.test(first)) {
        counts[first]++;
      } else {
        counts["#"]++;
      }
    });
    return counts;
  })();

  // Filter and sort global songs
  $: filteredSongs = (() => {
    let songs = searchQuery
      ? $globalSongs.filter(song => song.name?.toLowerCase().includes(searchQuery.toLowerCase()))
      : [...$globalSongs];

    // Sort
    switch (librarySortBy) {
      case "name-asc":
        songs.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        break;
      case "name-desc":
        songs.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
        break;
      case "bpm-desc":
        songs.sort((a, b) => (b.bpm || 0) - (a.bpm || 0));
        break;
      case "bpm-asc":
        songs.sort((a, b) => (a.bpm || 0) - (b.bpm || 0));
        break;
    }

    return songs;
  })();

  function toggleSongShare(path) {
    const current = $sharedSongs;
    if (current.includes(path)) {
      setSharedSongs(current.filter(p => p !== path));
    } else {
      setSharedSongs([...current, path]);
    }
  }

  function selectAllSongs() {
    setSharedSongs($midiFiles.map(f => f.path));
  }

  function deselectAllSongs() {
    setSharedSongs([]);
  }

  // Select only currently visible/filtered songs
  function selectVisibleSongs() {
    const visiblePaths = new Set(sharePickerSongs.map(f => f.path));
    const currentSelected = new Set($sharedSongs);
    visiblePaths.forEach(p => currentSelected.add(p));
    setSharedSongs([...currentSelected]);
  }

  // Deselect only currently visible/filtered songs
  function deselectVisibleSongs() {
    const visiblePaths = new Set(sharePickerSongs.map(f => f.path));
    setSharedSongs($sharedSongs.filter(p => !visiblePaths.has(p)));
  }

  // Reset share picker filters
  function resetShareFilters() {
    shareSearchQuery = "";
    shareLetterFilter = "";
    shareFilterMode = "all";
    shareSortBy = "name-asc";
  }

  // Scroll mask
  let scrollContainer;
  let showTopMask = false;
  let showBottomMask = false;

  function handleScroll(e) {
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    showTopMask = scrollTop > 10;
    showBottomMask = scrollTop + clientHeight < scrollHeight - 10;
  }

  onMount(() => {
    initLibrary();
    serverUrlInput = $discoveryServerUrl;
    setTimeout(() => {
      if (scrollContainer) {
        const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
        showBottomMask = scrollHeight > clientHeight;
      }
    }, 100);
  });

  // Reactive set of owned song hashes (updates when midiFiles changes)
  $: ownedHashes = new Set($midiFiles.map(f => f.hash));

  function openDownloadModal(song) {
    downloadingSong = song;
    showDownloadModal = true;
  }

  async function confirmDownload() {
    if (!downloadingSong) return;
    showDownloadModal = false;
    await requestSong(downloadingSong.peerId, downloadingSong.hash, downloadingSong.name);
    downloadingSong = null;
  }

  function formatDuration(seconds) {
    if (!seconds) return "--:--";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  function saveServerUrl() {
    setDiscoveryServer(serverUrlInput);
  }

  async function handleStartServer() {
    await startServer(serverPort);
  }

  async function handleStopServer() {
    await stopServer();
  }
</script>

<div class="h-full flex flex-col min-h-0 -mx-1 relative">
  <div
    bind:this={scrollContainer}
    onscroll={handleScroll}
    class="flex-1 overflow-y-auto scrollbar-thin min-h-0 px-1 {$downloadProgress || $libraryError ? 'pb-16' : 'pb-2'} {showTopMask && showBottomMask ? 'scroll-mask-both' : showTopMask ? 'scroll-mask-top' : showBottomMask ? 'scroll-mask-bottom' : ''}"
  >
    <!-- Header -->
    <div class="mb-4">
      <div class="flex items-center gap-3 mb-2">
        <div class="w-12 h-12 rounded-lg bg-white/10 flex items-center justify-center">
          <Icon icon="mdi:earth" class="w-6 h-6 text-[#1db954]" />
        </div>
        <div class="flex-1">
          <h2 class="text-xl font-bold">{$t("share.songLibrary")}</h2>
          <p class="text-xs text-white/60">
            {#if $libraryConnected}
              {$onlinePeers} {$onlinePeers !== 1 ? $t("share.peersOnlinePlural") : $t("share.peersOnline")} &bull; {$globalSongs.length} {$t("library.songs")}
            {:else}
              {$t("share.browseShare")}
            {/if}
          </p>
        </div>
        <!-- Toggle -->
        <button
          class="w-10 h-5 rounded-full transition-colors {$libraryEnabled ? 'bg-[#1db954]' : 'bg-white/20'}"
          onclick={toggleLibrary}
          title={$libraryEnabled ? $t("share.disableSharing") : $t("share.enableSharing")}
        >
          <div class="w-4 h-4 rounded-full bg-white transition-transform {$libraryEnabled ? 'translate-x-5' : 'translate-x-0.5'}"></div>
        </button>
      </div>
    </div>

    {#if !$libraryEnabled}
      <!-- Disabled State -->
      <div class="flex flex-col items-center justify-center py-12 text-center" in:fade>
        <div class="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
          <Icon icon="mdi:share-off" class="w-8 h-8 text-white/30" />
        </div>
        <p class="text-white/60 mb-2">{$t("share.sharingDisabled")}</p>
        <p class="text-xs text-white/40 mb-4">{$t("share.enableToShare")}</p>
        <button
          class="px-4 py-2 rounded-lg bg-[#1db954] hover:bg-[#1ed760] text-white font-medium text-sm transition-colors"
          onclick={toggleLibrary}
        >
          {$t("share.enableSharing")}
        </button>
      </div>
    {:else if !$libraryConnected}
      <!-- Connecting State -->
      <div class="space-y-4" in:fade>
        <!-- Developer Settings (available while connecting) -->
        <div class="p-3 rounded-lg bg-white/5">
          <button
            class="w-full flex items-center justify-between text-xs text-white/70 hover:text-white transition-colors"
            onclick={() => showDevSettings = !showDevSettings}
          >
            <span class="flex items-center gap-2">
              <Icon icon="mdi:developer-board" class="w-3.5 h-3.5" />
              {$t("share.devSettings")}
            </span>
            <Icon icon={showDevSettings ? "mdi:chevron-up" : "mdi:chevron-down"} class="w-4 h-4" />
          </button>

          {#if showDevSettings}
            <div class="mt-3 pt-3 border-t border-white/10 space-y-3" transition:fade={{ duration: 150 }}>
              <!-- Discovery Server URL -->
              <div class="space-y-1">
                <label class="text-xs text-white/50" for="share-discovery-url-connecting">{$t("share.discoveryUrl")}</label>
                <div class="flex gap-2">
                  <input
                    id="share-discovery-url-connecting"
                    type="text"
                    bind:value={serverUrlInput}
                    placeholder="https://discovery.example.com"
                    class="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-[#1db954]"
                  />
                  <button
                    class="px-3 py-1.5 rounded-lg bg-[#1db954] hover:bg-[#1ed760] text-white text-xs font-medium transition-colors"
                    onclick={saveServerUrl}
                  >
                    {$t("share.save")}
                  </button>
                  <button
                    class="px-2 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white/70 hover:text-white text-xs transition-colors"
                    onclick={() => { serverUrlInput = 'https://discovery.chuaii.me'; saveServerUrl(); }}
                    title={$t("settings.storage.resetToDefault")}
                  >
                    <Icon icon="mdi:refresh" class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <!-- Host Server -->
              <div class="space-y-1">
                <label class="text-xs text-white/50" for="share-host-port-connecting">{$t("share.hostServer")}</label>
                <div class="flex gap-2 items-center">
                  <input
                    id="share-host-port-connecting"
                    type="number"
                    bind:value={serverPort}
                    placeholder="3456"
                    class="w-20 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-[#1db954]"
                  />
                  {#if $isHostingServer}
                    <button
                      class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors bg-red-500/20 text-red-400 hover:bg-red-500/30"
                      onclick={handleStopServer}
                    >
                      {$t("share.stopServer")}
                    </button>
                  {:else}
                    <button
                      class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors bg-white/10 hover:bg-white/20 text-white"
                      onclick={handleStartServer}
                    >
                      {$t("share.startServer")}
                    </button>
                  {/if}
                </div>
                <p class="text-xs text-white/40">{$t("share.runOnMachine")}</p>
              </div>
            </div>
          {/if}
        </div>

        <!-- Connecting spinner -->
        <div class="flex flex-col items-center justify-center py-8 text-center">
          <Icon icon="mdi:loading" class="w-12 h-12 text-[#1db954] animate-spin mb-4" />
          <p class="text-white/60">{$t("share.connecting")}</p>
        </div>

        <!-- Error Display -->
        {#if $libraryError}
          <div class="p-3 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center gap-2" transition:fade>
            <Icon icon="mdi:alert-circle" class="w-4 h-4 text-red-400" />
            <p class="text-xs text-red-400 flex-1">{$libraryError}</p>
            <button
              class="text-xs text-red-400 hover:text-red-300"
              onclick={() => libraryError.set(null)}
            >
              {$t("share.dismiss")}
            </button>
          </div>
        {/if}
      </div>
    {:else}
      <!-- Connected State -->
      <div class="space-y-4" in:fade>
        <!-- Connection Info -->
        <div class="p-3 rounded-lg bg-white/5 space-y-2">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <div class="w-2 h-2 rounded-full bg-[#1db954] animate-pulse"></div>
              <span class="text-xs text-white/70">{$t("share.connected")}</span>
              <span class="text-xs text-white/40">•</span>
              <span class="text-xs text-[#1db954]">{$t("share.sharing")} {sharedCount} {sharedCount !== 1 ? $t("library.songs") : $t("library.song")}</span>
            </div>
            <button
              class="text-xs text-white/50 hover:text-white transition-colors flex items-center gap-1"
              onclick={refreshSongs}
              title={$t("share.refreshSongs")}
            >
              <Icon icon="mdi:refresh" class="w-3 h-3" />
              {$t("share.refresh")}
            </button>
            {#if import.meta.env.DEV}
              <!-- DEV: Test notification button -->
              <button
                class="text-xs text-orange-400/70 hover:text-orange-400 transition-colors flex items-center gap-1"
                onclick={() => shareNotification.set({ songName: "Test Song.mid", peerName: "TestUser123", timestamp: Date.now() })}
                title="[DEV] Test share notification"
              >
                <Icon icon="mdi:bell-ring" class="w-3 h-3" />
                Test
              </button>
            {/if}
          </div>

          <!-- Sharing Options -->
          <div class="pt-2 border-t border-white/10 space-y-2">
            <!-- Share All Toggle -->
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <Icon icon="mdi:share-variant" class="w-3.5 h-3.5 text-white/50" />
                <span class="text-xs text-white/70">{$t("share.shareAll")}</span>
              </div>
              <button
                class="w-8 h-4 rounded-full transition-colors {$shareAll ? 'bg-[#1db954]' : 'bg-white/20'}"
                onclick={toggleShareAll}
                aria-label={$t("share.shareAll")}
              >
                <div class="w-3 h-3 rounded-full bg-white transition-transform {$shareAll ? 'translate-x-4' : 'translate-x-0.5'}"></div>
              </button>
            </div>

            <!-- Select Songs Button (when not sharing all) -->
            {#if !$shareAll}
              <button
                class="w-full py-1.5 px-3 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-white/70 hover:text-white transition-colors flex items-center justify-between"
                onclick={() => showSharePicker = true}
              >
                <span class="flex items-center gap-2">
                  <Icon icon="mdi:playlist-check" class="w-3.5 h-3.5" />
                  {$t("share.selectToShare")}
                </span>
                <span class="text-white/50">{sharedCount} {$t("share.selected")}</span>
              </button>
            {/if}
          </div>
        </div>

        <!-- Developer Settings -->
        <div class="p-3 rounded-lg bg-white/5">
          <button
            class="w-full flex items-center justify-between text-xs text-white/70 hover:text-white transition-colors"
            onclick={() => showDevSettings = !showDevSettings}
          >
            <span class="flex items-center gap-2">
              <Icon icon="mdi:developer-board" class="w-3.5 h-3.5" />
              {$t("share.devSettings")}
            </span>
            <Icon icon={showDevSettings ? "mdi:chevron-up" : "mdi:chevron-down"} class="w-4 h-4" />
          </button>

          {#if showDevSettings}
            <div class="mt-3 pt-3 border-t border-white/10 space-y-3" transition:fade={{ duration: 150 }}>
              <!-- Discovery Server URL -->
              <div class="space-y-1">
                <label class="text-xs text-white/50" for="share-discovery-url-connected">{$t("share.discoveryUrl")}</label>
                <div class="flex gap-2">
                  <input
                    id="share-discovery-url-connected"
                    type="text"
                    bind:value={serverUrlInput}
                    placeholder="https://discovery.example.com"
                    class="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-[#1db954]"
                  />
                  <button
                    class="px-3 py-1.5 rounded-lg bg-[#1db954] hover:bg-[#1ed760] text-white text-xs font-medium transition-colors"
                    onclick={saveServerUrl}
                  >
                    {$t("share.save")}
                  </button>
                  <button
                    class="px-2 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white/70 hover:text-white text-xs transition-colors"
                    onclick={() => { serverUrlInput = 'https://discovery.chuaii.me'; saveServerUrl(); }}
                    title={$t("settings.storage.resetToDefault")}
                  >
                    <Icon icon="mdi:refresh" class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <!-- Host Server -->
              <div class="space-y-1">
                <label class="text-xs text-white/50" for="share-host-port-connected">{$t("share.hostServer")}</label>
                <div class="flex gap-2 items-center">
                  <input
                    id="share-host-port-connected"
                    type="number"
                    bind:value={serverPort}
                    placeholder="3456"
                    class="w-20 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-[#1db954]"
                  />
                  {#if $isHostingServer}
                    <button
                      class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors bg-red-500/20 text-red-400 hover:bg-red-500/30"
                      onclick={handleStopServer}
                    >
                      {$t("share.stopServer")}
                    </button>
                  {:else}
                    <button
                      class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors bg-white/10 hover:bg-white/20 text-white"
                      onclick={handleStartServer}
                    >
                      {$t("share.startServer")}
                    </button>
                  {/if}
                </div>
                <p class="text-xs text-white/40">{$t("share.runOnMachine")}</p>
              </div>
            </div>
          {/if}
        </div>

        <!-- Search & Sort -->
        {#if $globalSongs.length > 0}
          <SearchSort
            bind:searchQuery={searchQuery}
            bind:sortBy={librarySortBy}
            placeholder={$t("share.searchAvailableSongs", { values: { count: $globalSongs.length } })}
            sortOptions={librarySortOptions}
          />
        {/if}

        <!-- Song List -->
        {#if filteredSongs.length > 0}
          <div class="space-y-1.5">
            {#each filteredSongs as song, i (song.hash + song.peerId + i)}
              {@const hasIt = ownedHashes.has(song.hash)}
              {@const isDownloading = $downloadProgress?.songName === song.name}
              <button
                class="w-full flex items-center gap-3 p-2.5 rounded-xl transition-all text-left
                  {hasIt
                    ? 'bg-[#1db954]/5 border border-[#1db954]/20 cursor-default'
                    : isDownloading
                      ? 'bg-[#1db954]/10 border border-[#1db954]/30'
                      : 'bg-white/5 border border-transparent hover:bg-white/10 hover:border-white/10 active:scale-[0.98]'
                  }"
                onclick={() => !hasIt && !isDownloading && openDownloadModal(song)}
                disabled={hasIt || isDownloading}
                in:fly={{ y: 10, duration: 150, delay: i * 20 }}
              >
                <!-- Song Icon with Status -->
                <div class="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 relative
                  {hasIt ? 'bg-[#1db954]/20' : isDownloading ? 'bg-[#1db954]/20' : 'bg-white/10'}">
                  {#if hasIt}
                    <Icon icon="mdi:check-circle" class="w-5 h-5 text-[#1db954]" />
                  {:else if isDownloading}
                    <Icon icon="mdi:loading" class="w-5 h-5 text-[#1db954] animate-spin" />
                  {:else}
                    <Icon icon="mdi:music-note" class="w-5 h-5 text-white/50" />
                  {/if}
                </div>

                <!-- Song Info -->
                <div class="flex-1 min-w-0">
                  <p class="text-sm font-medium truncate {hasIt ? 'text-[#1db954]' : 'text-white'}">
                    {song.name}
                  </p>
                  <div class="flex items-center gap-2 text-xs text-white/40">
                    <span class="flex items-center gap-1">
                      <Icon icon="mdi:account" class="w-3 h-3" />
                      {song.peerName}
                    </span>
                    <span>•</span>
                    <span>{song.bpm || '?'} BPM</span>
                    <span>•</span>
                    <span>{formatDuration(song.duration)}</span>
                  </div>
                </div>

                <!-- Action Area -->
                <div class="flex-shrink-0 flex items-center">
                  {#if hasIt}
                    <span class="text-xs text-[#1db954] font-medium px-2 py-1 rounded-full bg-[#1db954]/10">
                      {$t("share.owned")}
                    </span>
                  {:else if isDownloading}
                    <div class="flex items-center gap-2 px-2 py-1 rounded-full bg-[#1db954]/10">
                      <span class="text-xs text-[#1db954] font-medium">{$downloadProgress.progress}%</span>
                    </div>
                  {:else}
                    <div class="flex items-center gap-1 px-3 py-1.5 rounded-full bg-[#1db954] text-white text-xs font-medium">
                      <Icon icon="mdi:download" class="w-4 h-4" />
                      <span>{$t("share.get")}</span>
                    </div>
                  {/if}
                </div>
              </button>
            {/each}
          </div>
        {:else if $globalSongs.length === 0}
          <div class="p-4 rounded-lg bg-white/5 text-center">
            <Icon icon="mdi:music-note-off" class="w-8 h-8 text-white/30 mx-auto mb-2" />
            <p class="text-xs text-white/50">{$t("share.noSongsFromOthers")}</p>
            <p class="text-xs text-white/40 mt-1">{$t("share.yourSongsVisible", { values: { count: sharedCount } })}</p>
          </div>
        {:else}
          <div class="p-4 rounded-lg bg-white/5 text-center">
            <Icon icon="mdi:magnify" class="w-8 h-8 text-white/30 mx-auto mb-2" />
            <p class="text-xs text-white/50">{$t("share.noSongsMatch")} "{searchQuery}"</p>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Floating Bottom Bar for Download Progress & Errors -->
  {#if $downloadProgress || $libraryError}
    <div
      class="absolute bottom-0 left-0 right-0 px-1 pb-2 bg-gradient-to-t from-[#121212] via-[#121212]/95 to-transparent pt-6"
      transition:fly={{ y: 20, duration: 200 }}
    >
      <div class="space-y-2">
        <!-- Download Progress -->
        {#if $downloadProgress}
          <div class="p-3 rounded-lg bg-[#1db954]/10 border border-[#1db954]/30 flex items-center gap-3 backdrop-blur-sm" transition:fade>
            <Icon icon="mdi:loading" class="w-5 h-5 text-[#1db954] animate-spin flex-shrink-0" />
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-white truncate">{$downloadProgress.songName}</p>
              <p class="text-xs text-[#1db954]">{$downloadProgress.status}</p>
            </div>
            <div class="w-12 text-right">
              <span class="text-xs text-[#1db954] font-medium">{$downloadProgress.progress}%</span>
            </div>
          </div>
        {/if}

        <!-- Error Display -->
        {#if $libraryError}
          <div class="p-3 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center gap-2 backdrop-blur-sm" transition:fade>
            <Icon icon="mdi:alert-circle" class="w-4 h-4 text-red-400 flex-shrink-0" />
            <p class="text-xs text-red-400 flex-1">{$libraryError}</p>
            <button
              class="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-red-500/10 transition-colors"
              onclick={() => libraryError.set(null)}
            >
              {$t("share.dismiss")}
            </button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<!-- Share Picker Modal - Full Screen with padding -->
{#if showSharePicker}
  <div class="fixed inset-0 z-50 p-2 overflow-hidden rounded-md" transition:fade={{ duration: 150 }}>
    <div class="absolute inset-0 bg-black/80 rounded-md"></div>
    <div
      class="relative w-full h-full bg-[#181818] rounded-lg flex flex-col overflow-hidden shadow-2xl"
      style="transform-origin: center center;"
      in:scale={{ duration: 200, start: 0.95, opacity: 0 }}
      out:scale={{ duration: 150, start: 0.95, opacity: 0 }}
    >
    <!-- Top Bar -->
    <div class="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-[#181818]">
      <div class="flex items-center gap-4">
        <button
          class="p-2 rounded-lg hover:bg-white/10 text-white/60 hover:text-white transition-colors"
          onclick={() => { showSharePicker = false; resetShareFilters(); }}
        >
          <Icon icon="mdi:arrow-left" class="w-5 h-5" />
        </button>
        <div>
          <h2 class="text-lg font-bold">{$t("share.selectSongsToShare")}</h2>
          <p class="text-xs text-white/50">
            <span class="text-[#1db954] font-semibold">{$sharedSongs.length.toLocaleString()}</span> {$t("share.ofSelected", { values: { total: $midiFiles.length.toLocaleString() } })}
            {#if sharePickerSongs.length !== $midiFiles.length}
              <span class="text-white/30 ml-2">• {$t("share.showing", { values: { count: sharePickerSongs.length.toLocaleString() } })}</span>
            {/if}
          </p>
        </div>
      </div>

      <!-- Done Button -->
      <button
        class="px-5 py-2 rounded-full bg-[#1db954] hover:bg-[#1ed760] text-white font-semibold text-sm transition-colors flex items-center gap-2"
        onclick={() => { showSharePicker = false; resetShareFilters(); }}
      >
        <Icon icon="mdi:check" class="w-4 h-4" />
        {$t("share.done")}
      </button>
    </div>

    <!-- Main Content -->
    <div class="flex-1 flex min-h-0">
      <!-- Left Sidebar - Alphabet -->
      <div class="w-12 bg-[#181818] border-r border-white/5 flex flex-col py-2 overflow-y-auto scrollbar-none">
        <button
          class="w-full py-1.5 text-[10px] font-bold transition-all {shareLetterFilter === '' ? 'text-[#1db954] bg-[#1db954]/10' : 'text-white/40 hover:text-white hover:bg-white/5'}"
          onclick={() => shareLetterFilter = ''}
        >
          ALL
        </button>
        {#each alphabet as letter}
          {@const count = letterCounts[letter] || 0}
          <button
            class="w-full py-1 text-[11px] font-medium transition-all
              {shareLetterFilter === letter ? 'text-[#1db954] bg-[#1db954]/10' : count > 0 ? 'text-white/40 hover:text-white hover:bg-white/5' : 'text-white/15'}"
            onclick={() => count > 0 && (shareLetterFilter = letter)}
            disabled={count === 0}
            title="{count} songs"
          >
            {letter}
          </button>
        {/each}
      </div>

      <!-- Main Area -->
      <div class="flex-1 flex flex-col min-w-0">
        <!-- Toolbar -->
        <div class="px-4 py-3 border-b border-white/5 space-y-3">
          <!-- Search + Sort Row -->
          <SearchSort
            bind:searchQuery={shareSearchQuery}
            bind:sortBy={shareSortBy}
            placeholder={$t("library.searchPlaceholder")}
            sortOptions={shareSortOptions}
          />

          <!-- Filter Tabs + Actions Row -->
          <div class="flex items-center gap-2">
            <!-- Filter Tabs -->
            <div class="flex gap-1 p-1 bg-white/5 rounded-lg">
              <button
                class="px-3 py-1.5 rounded-md text-xs font-medium transition-all {shareFilterMode === 'all' ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white'}"
                onclick={() => shareFilterMode = 'all'}
              >
                {$t("band.all")}
              </button>
              <button
                class="px-3 py-1.5 rounded-md text-xs font-medium transition-all {shareFilterMode === 'selected' ? 'bg-[#1db954]/30 text-[#1db954]' : 'text-white/50 hover:text-white'}"
                onclick={() => shareFilterMode = 'selected'}
              >
                {$t("share.selected")} ({$sharedSongs.length})
              </button>
              <button
                class="px-3 py-1.5 rounded-md text-xs font-medium transition-all {shareFilterMode === 'unselected' ? 'bg-orange-500/30 text-orange-400' : 'text-white/50 hover:text-white'}"
                onclick={() => shareFilterMode = 'unselected'}
              >
                {$t("share.unselected")}
              </button>
            </div>

            <div class="flex-1"></div>

            <!-- Batch Actions -->
            <button
              class="px-3 py-1.5 rounded-lg bg-[#1db954]/10 hover:bg-[#1db954]/20 text-xs text-[#1db954] font-medium transition-colors flex items-center gap-1.5"
              onclick={selectVisibleSongs}
            >
              <Icon icon="mdi:check-all" class="w-4 h-4" />
              {$t("share.selectShown")}
            </button>
            <button
              class="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-white/60 hover:text-white font-medium transition-colors flex items-center gap-1.5"
              onclick={deselectVisibleSongs}
            >
              <Icon icon="mdi:close" class="w-4 h-4" />
              {$t("share.deselectShown")}
            </button>
            <button
              class="px-3 py-1.5 rounded-lg bg-[#1db954]/10 hover:bg-[#1db954]/20 text-xs text-[#1db954] font-medium transition-colors"
              onclick={selectAllSongs}
            >
              {$t("band.all")} {$midiFiles.length.toLocaleString()}
            </button>
            <button
              class="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-white/60 hover:text-white font-medium transition-colors"
              onclick={deselectAllSongs}
            >
              {$t("share.none")}
            </button>
            {#if shareSearchQuery || shareLetterFilter || shareFilterMode !== 'all'}
              <button
                class="px-3 py-1.5 rounded-lg bg-orange-500/10 hover:bg-orange-500/20 text-xs text-orange-400 font-medium transition-colors flex items-center gap-1"
                onclick={resetShareFilters}
              >
                <Icon icon="mdi:filter-off" class="w-4 h-4" />
                {$t("band.clear")}
              </button>
            {/if}
          </div>
        </div>

        <!-- Song Grid -->
        <div class="flex-1 overflow-y-auto p-4 scrollbar-thin">
          {#if sharePickerSongs.length === 0}
            <div class="flex flex-col items-center justify-center h-full text-white/40">
              <Icon icon="mdi:music-note-off" class="w-16 h-16 mb-4 opacity-50" />
              <p class="text-lg font-medium mb-1">{$t("share.noSongsFound")}</p>
              <p class="text-sm text-white/30 mb-4">{$t("share.tryAdjusting")}</p>
              <button
                class="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm text-white transition-colors"
                onclick={resetShareFilters}
              >
                {$t("share.clearFilters")}
              </button>
            </div>
          {:else}
            <div class="grid grid-cols-3 gap-2">
              {#each sharePickerSongs as file (file.path)}
                {@const isSelected = $sharedSongs.includes(file.path)}
                <button
                  class="flex items-center gap-3 p-3 rounded-lg transition-all text-left
                    {isSelected
                      ? 'bg-[#1db954]/20 ring-1 ring-[#1db954]/50'
                      : 'bg-white/5 hover:bg-white/10'
                    }"
                  onclick={() => toggleSongShare(file.path)}
                >
                  <div class="w-5 h-5 rounded flex items-center justify-center flex-shrink-0
                    {isSelected ? 'bg-[#1db954]' : 'bg-white/10 ring-1 ring-white/20'}">
                    {#if isSelected}
                      <Icon icon="mdi:check" class="w-3.5 h-3.5 text-white" />
                    {/if}
                  </div>
                  <div class="flex-1 min-w-0">
                    <p class="text-sm font-medium truncate {isSelected ? 'text-[#1db954]' : 'text-white'}">{file.name}</p>
                    <p class="text-xs text-white/40">{file.bpm || '?'} BPM</p>
                  </div>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    </div>
    </div>
  </div>
{/if}

<!-- Download Confirmation Modal -->
{#if showDownloadModal && downloadingSong}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center"
    transition:fade={{ duration: 150 }}
  >
    <button
      class="absolute inset-0 bg-black/60 backdrop-blur-sm"
      onclick={() => { showDownloadModal = false; downloadingSong = null; }}
      aria-label={$t("common.close")}
    ></button>

    <div
      class="relative bg-[#282828] rounded-2xl shadow-2xl w-[380px] max-w-[90vw] overflow-hidden"
      transition:fly={{ y: 20, duration: 200 }}
    >
      <!-- Song Preview Card -->
      <div class="p-5">
        <div class="flex items-start gap-4">
          <div class="w-14 h-14 rounded-xl bg-gradient-to-br from-[#1db954]/30 to-[#1db954]/10 flex items-center justify-center flex-shrink-0">
            <Icon icon="mdi:music-note" class="w-7 h-7 text-[#1db954]" />
          </div>
          <div class="flex-1 min-w-0">
            <h3 class="text-base font-bold truncate mb-1">{downloadingSong.name}</h3>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/50">
              <span class="flex items-center gap-1">
                <Icon icon="mdi:account" class="w-3.5 h-3.5" />
                {downloadingSong.peerName}
              </span>
              {#if downloadingSong.bpm}
                <span>{downloadingSong.bpm} BPM</span>
              {/if}
              {#if downloadingSong.duration}
                <span>{formatDuration(downloadingSong.duration)}</span>
              {/if}
            </div>
          </div>
        </div>

        <!-- Security Note -->
        <div class="mt-4 p-3 rounded-lg bg-white/5 flex items-start gap-2">
          <Icon icon="mdi:shield-check" class="w-4 h-4 text-[#1db954] flex-shrink-0 mt-0.5" />
          <p class="text-xs text-white/50">
            {$t("share.securityNote")}
          </p>
        </div>
      </div>

      <!-- Actions -->
      <div class="flex gap-2 p-4 pt-0">
        <button
          class="flex-1 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-white font-medium text-sm transition-colors"
          onclick={() => { showDownloadModal = false; downloadingSong = null; }}
        >
          {$t("share.cancel")}
        </button>
        <button
          class="flex-1 py-2.5 rounded-xl bg-[#1db954] hover:bg-[#1ed760] text-white font-medium text-sm transition-colors flex items-center justify-center gap-2"
          onclick={confirmDownload}
        >
          <Icon icon="mdi:download" class="w-4 h-4" />
          {$t("share.download")}
        </button>
      </div>
    </div>
  </div>
{/if}
