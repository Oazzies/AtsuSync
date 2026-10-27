<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink, RouterView } from 'vue-router';
import { toast } from 'vue-sonner';
import { Bell, Globe, Inbox, Settings } from 'lucide-vue-next';
import { Toaster } from '@/components/ui/sonner';
import { Badge } from '@/components/ui/badge';
import { api, connected, useServerEvents } from '@/api/client';

const pending = ref(0);
const user = ref<string | null>(null);

const nav = [
  { to: '/', label: 'Requests', icon: Inbox, count: () => 0 },
  { to: '/tracked', label: 'Tracked', icon: Bell, count: () => pending.value },
  { to: '/sources', label: 'Sources', icon: Globe, count: () => 0 },
  { to: '/settings', label: 'Settings', icon: Settings, count: () => 0 },
];

async function refreshCounts() {
  const [links, settings] = await Promise.all([api.links(), api.settings()]).catch(() => [[], null] as const);
  pending.value = links.reduce((n, l) => n + l.pendingCount, 0);
  user.value = settings?.atsuUser ?? null;
}

useServerEvents((e) => {
  if (e.type === 'new_chapters') {
    toast(`New on ${e.seriesTitle}`, { description: e.labels.join(', ') });
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(`AtsuSync: ${e.seriesTitle}`, { body: e.labels.join(', ') });
    }
  }
  if (e.type === 'chapters_unlocked') {
    toast(`Now free on ${e.seriesTitle}`, { description: e.labels.join(', ') });
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(`AtsuSync: ${e.seriesTitle}`, { body: `Now free: ${e.labels.join(', ')}` });
    }
  }
  if (e.type === 'job' && e.job.state === 'failed') toast.error(`Download failed: ${e.job.seriesTitle} ${e.job.chapterLabel}`, { description: e.job.error ?? undefined });
  if (e.type === 'job' && e.job.state === 'done') toast.success(`Ready: ${e.job.seriesTitle} ${e.job.chapterLabel}`, { description: 'Save it from the series page.' });
  void refreshCounts();
});

onMounted(() => {
  void refreshCounts();
  if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
});
</script>

<template>
  <div class="flex min-h-svh">
    <aside class="sticky top-0 hidden h-svh w-56 shrink-0 flex-col border-r bg-card/40 p-3 md:flex">
      <div class="mb-6 flex items-center gap-2 px-2 pt-1">
        <div class="grid size-7 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground">A</div>
        <span class="font-semibold tracking-tight">AtsuSync</span>
      </div>
      <nav class="flex flex-col gap-0.5">
        <RouterLink
          v-for="n in nav"
          :key="n.to"
          :to="n.to"
          class="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          :exact-active-class="n.to === '/' ? 'bg-accent text-foreground' : ''"
          :active-class="n.to === '/' ? '' : 'bg-accent text-foreground'"
        >
          <component :is="n.icon" class="size-4" />
          <span class="flex-1">{{ n.label }}</span>
          <Badge v-if="n.count()" class="h-5 px-1.5">{{ n.count() }}</Badge>
        </RouterLink>
      </nav>
      <div class="mt-auto space-y-2 px-2 text-xs text-muted-foreground">
        <div class="flex items-center gap-2">
          <span class="size-2 rounded-full" :class="connected ? 'bg-success' : 'bg-destructive'" />
          {{ user ? `Atsu: ${user}` : 'Atsu: not logged in' }}
        </div>
      </div>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <!-- Compact top nav on small screens -->
      <nav class="flex gap-1 overflow-x-auto border-b p-2 md:hidden">
        <RouterLink v-for="n in nav" :key="n.to" :to="n.to" class="rounded-md px-3 py-1.5 text-sm text-muted-foreground" active-class="bg-accent text-foreground">
          {{ n.label }}
        </RouterLink>
      </nav>
      <main class="mx-auto w-full max-w-6xl flex-1 p-4 md:p-8">
        <RouterView @changed="refreshCounts" />
      </main>
    </div>
    <Toaster rich-colors position="bottom-right" />
  </div>
</template>
