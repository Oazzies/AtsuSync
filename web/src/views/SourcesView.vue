<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import type { SourceInfo } from '@atsusync/shared';
import { api } from '../api/client';

const sources = ref<SourceInfo[]>([]);
const query = ref('');
const results = reactive<Record<string, string>>({});

async function load() {
  sources.value = await api.sources();
}

async function toggle(s: SourceInfo) {
  sources.value = await api.setSourceEnabled(s.id, !s.enabled);
}

async function test(s: SourceInfo) {
  results[s.id] = 'Testing…';
  try {
    const r = await api.testSource(s.id, query.value || 'love');
    results[s.id] = r.ok
      ? `OK in ${r.ms} ms — ${r.hits.map((h) => h.title).join(', ')}`
      : `Search returned nothing (${r.ms} ms) — the site layout may have changed.`;
  } catch (e) {
    results[s.id] = `Error: ${(e as Error).message}`;
  }
}

onMounted(load);
</script>

<template>
  <div class="stack">
    <div>
      <h1>Sources</h1>
      <div class="muted small">
        Supported scanlation sites. Add a new one by copying <code>server/src/sources/adapters/_template.ts</code> and registering it in
        <code>registry.ts</code>.
      </div>
    </div>
    <div class="panel row">
      <input v-model="query" placeholder="Test search query (default: love)" />
    </div>
    <div class="panel" style="padding: 0">
      <table>
        <thead><tr><th>Site</th><th>Enabled</th><th>Health check</th><th></th></tr></thead>
        <tbody>
          <tr v-for="s in sources" :key="s.id">
            <td>
              <strong>{{ s.name }}</strong>
              <div class="small"><a :href="s.baseUrl" target="_blank" rel="noopener" class="muted">{{ s.baseUrl }}</a></div>
            </td>
            <td><input type="checkbox" :checked="s.enabled" @change="toggle(s)" /></td>
            <td class="small">{{ results[s.id] ?? '' }}</td>
            <td><button @click="test(s)">Test</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
