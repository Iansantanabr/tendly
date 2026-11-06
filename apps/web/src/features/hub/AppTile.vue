<script setup lang="ts">
import { computed } from "vue";
import { appColor, appLetter } from "./app-tile";

/** An app's coloured letter tile, sized in CSS pixels. */
const props = withDefaults(defineProps<{ name: string; letter?: string | null; color?: string | null; size?: number }>(), { size: 28 });
const tone = computed(() => appColor(props.color));
const style = computed(() => ({ "--tile-ink": `var(--app-${tone.value})`, "--tile-soft": `var(--app-${tone.value}-soft)`, width: `${props.size}px`, height: `${props.size}px`, fontSize: `${Math.max(10, Math.round(props.size * 0.5))}px` }));
</script>
<template>
  <span class="app-tile" :style="style" :data-app-color="tone" aria-hidden="true">{{ appLetter(letter, name) }}</span>
</template>
<style scoped>
.app-tile { display: inline-grid; place-items: center; flex: none; border-radius: var(--radius-sm); background: var(--tile-soft); color: var(--tile-ink); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tile-ink) 18%, transparent); font-family: var(--font-body); font-weight: 700; line-height: 1; user-select: none; }
</style>
