<script setup lang="ts">
/** Publish one file at /p/{slug}: who sees it and when it updates. */
defineProps<{ workspaceId: string; path: string }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div class="publish-dialog" />
</template>
