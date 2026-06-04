<script>
  import Icon from "@iconify/svelte";
  import { fade, fly } from "svelte/transition";

  export let searchQuery = "";
  export let sortBy = "name-asc";
  export let placeholder = "Search...";
  export let showSort = true;
  export let sortOptions = [
    { id: "name-asc", label: "A-Z", icon: "mdi:sort-alphabetical-ascending" },
    { id: "name-desc", label: "Z-A", icon: "mdi:sort-alphabetical-descending" },
    { id: "duration-asc", label: "Shortest", icon: "mdi:sort-numeric-ascending" },
    { id: "duration-desc", label: "Longest", icon: "mdi:sort-numeric-descending" },
  ];

  let showSortMenu = false;

  function handleWindowClick() {
    showSortMenu = false;
  }
</script>

<svelte:window onclick={handleWindowClick} />

<div class="flex gap-2">
  <div class="relative flex-1">
    <Icon
      icon="mdi:magnify"
      class="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 w-5 h-5"
    />
    <input
      type="text"
      {placeholder}
      bind:value={searchQuery}
      class="w-full bg-white/5 border border-white/10 rounded-full pl-10 pr-10 py-2.5 text-sm text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#1db954] focus:border-transparent focus:bg-white/10 transition-all"
    />
    {#if searchQuery}
      <button
        onclick={() => (searchQuery = "")}
        class="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white transition-colors"
        transition:fade={{ duration: 150 }}
        title="Clear search"
      >
        <Icon icon="mdi:close-circle" class="w-5 h-5" />
      </button>
    {/if}
  </div>

  {#if showSort}
    <div class="relative">
      <button
        class="h-full px-3 bg-white/5 border border-white/10 rounded-full flex items-center gap-1.5 text-white/60 hover:text-white hover:bg-white/10 transition-all"
        onclick={(e) => {
          e.stopPropagation();
          showSortMenu = !showSortMenu;
        }}
        title="Sort by"
      >
        <Icon icon={sortOptions.find(o => o.id === sortBy)?.icon || "mdi:sort"} class="w-4 h-4" />
        <span class="text-xs font-medium">{sortOptions.find(o => o.id === sortBy)?.label}</span>
      </button>

      {#if showSortMenu}
        <div
          class="absolute right-0 top-full mt-1 w-36 bg-[#282828] rounded-lg shadow-xl border border-white/10 py-1 z-50"
          transition:fly={{ y: -5, duration: 150 }}
          onclick={(e) => e.stopPropagation()}
          role="presentation"
        >
          {#each sortOptions as option}
            <button
              class="w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors {sortBy === option.id ? 'text-[#1db954] bg-white/5' : 'text-white/80 hover:bg-white/10'}"
              onclick={(e) => {
                e.stopPropagation();
                sortBy = option.id;
                showSortMenu = false;
              }}
            >
              <Icon icon={option.icon} class="w-4 h-4" />
              {option.label}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
