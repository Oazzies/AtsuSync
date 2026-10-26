<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink, RouterView } from 'vue-router';
import { api, connected, useServerEvents } from './api/client';

const pending = ref(0);
const activeJobs = ref(0);
const dryRun = ref<boolean | null>(null);
const toasts = ref<{ id: number; text: string }[]>([]);
let toastId = 0;

function toast(text: string) {
  const id = ++toastId;
  toasts.value.push({ id, text });
  setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), 8000);
}

async function refreshCounts() {
  const [links, jobs, settings] = await Promise.all([api.links(), api.uploads(), api.settings()]).catch(() => [[], [], null] as const);
  pending.value = links.reduce((n, l) => n + l.pendingCount, 0);
  activeJobs.value = jobs.filter((j) => !['done', 'failed', 'cancelled'].includes(j.state)).length;
  dryRun.value = settings?.dryRun ?? null;
}

useServerEvents((e) => {
  if (e.type === 'new_chapters') {
    toast(`New on ${e.seriesTitle}: ${e.labels.join(', ')}`);
    if (Notification.permission === 'granted') new Notification(`AtsuSync: ${e.seriesTitle}`, { body: e.labels.join(', ') });
  }
  if (e.type === 'job' && e.job.state === 'failed') toast(`Upload failed: ${e.job.seriesTitle} ${e.job.chapterLabel}`);
  void refreshCounts();
});

onMounted(() => {
  void refreshCounts();
  if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
});
</script>

<template>
  <div class="shell">
    <nav>
      <div class="brand">AtsuSync</div>
      <RouterLink to="/">Requests</RouterLink>
      <RouterLink to="/tracked">Tracked <span v-if="pending" class="badge accent">{{ pending }}</span></RouterLink>
      <RouterLink to="/uploads">Uploads <span v-if="activeJobs" class="badge info">{{ activeJobs }}</span></RouterLink>
      <RouterLink to="/sources">Sources</RouterLink>
      <RouterLink to="/settings">Settings</RouterLink>
      <div class="spacer" />
      <div class="status small">
        <span v-if="dryRun" class="badge warn" title="Uploads are simulated. Turn off in Settings.">Dry run</span>
        <span class="dot" :class="{ on: connected }" :title="connected ? 'Live updates connected' : 'Disconnected'" />
      </div>
    </nav>
    <main>
      <RouterView @changed="refreshCounts" />
    </main>
    <div class="toasts">
      <div v-for="t in toasts" :key="t.id" class="toast">{{ t.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.shell { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
nav {
  display: flex; gap: 4px; align-items: center; padding: 10px 20px; border-bottom: 1px solid var(--line);
  background: var(--panel); position: sticky; top: 0; z-index: 10; flex-wrap: wrap;
}
.brand { font-weight: 700; letter-spacing: 0.08em; margin-right: 16px; color: var(--accent); }
nav a { text-decoration: none; color: var(--muted); padding: 6px 10px; border-radius: 8px; display: inline-flex; gap: 6px; align-items: center; }
nav a:hover { color: var(--fg); }
nav a.router-link-exact-active, nav a.router-link-active:not([href='/']) { color: var(--fg); background: var(--panel-2); }
.status { display: flex; gap: 10px; align-items: center; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--err); }
.dot.on { background: var(--ok); }
main { padding: 20px; max-width: 1280px; width: 100%; margin: 0 auto; }
.toasts { position: fixed; right: 16px; bottom: 16px; display: grid; gap: 8px; z-index: 20; }
.toast { background: var(--panel-2); border: 1px solid var(--accent); border-radius: 8px; padding: 10px 14px; max-width: 360px; }
</style>
