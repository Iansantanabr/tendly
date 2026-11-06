<script setup lang="ts">
/**
 * The fork's primitives side by side, at /design: a check that the design
 * system holds (replica/design/components.md). Not in any menu; developer page,
 * so its labels are not translated.
 */
import { ref } from "vue";
import PageShell from "../PageShell.vue";
import Icon from "../Icon.vue";
import AppTile from "./AppTile.vue";

const emit = defineEmits<{ back: [] }>();
const on = ref(true);
const colours = ["amber", "green", "blue", "violet", "rose", "slate", "teal", "orange"];
const inks = [["--ink", "Text"], ["--ink-soft", "Text soft"], ["--muted", "Muted, 4.5:1"], ["--faint", "Faint, icons and placeholders only"]];
</script>

<template>
  <PageShell title="Design system" subtitle="Primitives of the fork, on the Tendly tokens. Toggle the theme in Preferences to check dark." @back="emit('back')">
    <div class="ds">
      <section>
        <h2>Text</h2>
        <p v-for="[token, label] in inks" :key="token" :style="{ color: `var(${token})` }">{{ label }} <code>{{ token }}</code></p>
      </section>
      <section>
        <h2>Buttons</h2>
        <div class="row">
          <button type="button" class="primary-button">Primary</button>
          <button type="button" class="secondary-button">Secondary</button>
          <button type="button" class="small-button primary"><Icon name="globe" :size="13" />Small primary</button>
          <button type="button" class="small-button">Small</button>
          <button type="button" class="small-button danger">Danger</button>
          <button type="button" class="icon-button" aria-label="Refresh"><Icon name="refresh" :size="15" /></button>
          <button type="button" class="primary-button" disabled>Disabled</button>
        </div>
      </section>
      <section>
        <h2>Fields</h2>
        <div class="row">
          <label class="field"><span>Name</span><input placeholder="Placeholder in --faint"></label>
          <label class="field"><span>Choice</span><select><option>First</option><option>Second</option></select></label>
          <label class="switch-row"><input v-model="on" type="checkbox" role="switch" class="ds-switch" aria-label="Enabled">{{ on ? "On" : "Off" }}</label>
        </div>
      </section>
      <section>
        <h2>Status pills</h2>
        <div class="row">
          <span class="pill ok">Connected</span>
          <span class="pill warn">Needs authorization</span>
          <span class="pill danger">Failed</span>
          <span class="pill neutral">Unknown</span>
          <span class="nav-badge"><span class="count-badge">12</span><span class="count-badge unread-badge">3</span></span>
        </div>
      </section>
      <section>
        <h2>Chips</h2>
        <div class="row">
          <button type="button" class="chip suggested">+ roteiro.html</button>
          <button type="button" class="chip added">relatorio.md <span aria-label="Remove">×</span></button>
        </div>
      </section>
      <section>
        <h2>App tiles</h2>
        <div class="row">
          <span v-for="c in colours" :key="c" class="tile-sample"><AppTile :name="c" :color="c" :size="40" /><small>{{ c }}</small></span>
        </div>
      </section>
      <section>
        <h2>Notices</h2>
        <p class="inline-notice">An inline notice for information.</p>
        <p class="inline-error" role="alert">An inline error, read by screen readers.</p>
      </section>
    </div>
  </PageShell>
</template>

<style scoped>
.ds { max-width: 820px; display: grid; gap: 22px; }
.ds section { display: grid; gap: 10px; padding: 16px; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); }
.ds h2 { margin: 0; font-size: var(--text-md); color: var(--ink-soft); }
.ds p { margin: 0; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.field { display: grid; gap: 4px; font-size: var(--text-sm); color: var(--ink-soft); }
.field input, .field select { font: inherit; font-size: var(--input-text); color: var(--ink); background: var(--surface); border: 1px solid var(--line-input); border-radius: var(--radius-sm); padding: 7px 10px; }
.field input::placeholder { color: var(--faint); }
.switch-row { display: inline-flex; align-items: center; gap: 8px; font-size: var(--text-sm); }
.ds-switch { appearance: none; position: relative; width: 38px; height: 22px; border-radius: var(--radius-full); background: var(--line-input); cursor: pointer; }
.ds-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--surface); box-shadow: var(--shadow-sm); transition: transform var(--duration-fast) var(--ease-out); }
.ds-switch:checked { background: var(--accent); }
.ds-switch:checked::after { transform: translateX(16px); }
.pill { display: inline-flex; padding: 2px 9px; border-radius: var(--radius-full); font-size: var(--text-xs); font-weight: 600; }
.pill.ok { color: var(--ok-ink); background: var(--ok-soft); }
.pill.warn { color: var(--warn-ink); background: var(--warn-soft); }
.pill.danger { color: var(--danger-ink); background: var(--danger-soft); }
.pill.neutral { color: var(--muted); background: var(--fill); }
.nav-badge { display: inline-flex; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: var(--radius-full); font: inherit; font-size: var(--text-xs); color: var(--ink-soft); cursor: pointer; }
.chip.suggested { background: none; border: 1px dashed var(--line-input); }
.chip.added { background: var(--fill); border: 1px solid transparent; color: var(--ink); }
.tile-sample { display: grid; justify-items: center; gap: 4px; font-size: var(--text-xs); color: var(--muted); }
</style>
