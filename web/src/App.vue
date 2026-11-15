<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink, RouterView } from 'vue-router';
import { toast } from 'vue-sonner';
import { Bell, Globe, Inbox, Settings } from '@/icons';
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
  <div class="min-h-svh pb-[var(--mobile-bar-h)] md:pb-0" style="--mobile-bar-h: 64px">
    <!-- Top bar, as on atsu.moe -->
    <nav class="sticky top-0 z-10 hidden h-(--nav-height) w-full bg-slate md:block">
      <div class="mx-auto flex h-full w-full max-w-(--wrapper) items-center gap-8 px-(--padding)">
        <RouterLink to="/" class="rounded-md text-2xl leading-none font-bold tracking-wide text-foreground2 uppercase">
          Atsu<span class="text-foreground">Sync</span>
        </RouterLink>
        <div class="flex items-center gap-1">
          <RouterLink
            v-for="n in nav"
            :key="n.to"
            :to="n.to"
            class="flex items-center gap-2 rounded-md px-3 py-2 text-foreground transition-colors hover:text-foreground2"
            :exact-active-class="n.to === '/' ? '!text-foreground2' : ''"
            :active-class="n.to === '/' ? '' : '!text-foreground2'"
          >
            <component :is="n.icon" class="size-4" />
            <span>{{ n.label }}</span>
            <Badge v-if="n.count()">{{ n.count() }}</Badge>
          </RouterLink>
        </div>
        <div class="ml-auto flex items-center gap-3 text-sm text-foreground3">
          <span class="size-2 rounded-full" :class="connected ? 'bg-success' : 'bg-destructive'" />
          <span>{{ user ? user : 'Not logged in' }}</span>
        </div>
      </div>
    </nav>

    <main class="mx-auto w-full max-w-(--wrapper) px-(--padding) py-6 md:py-8">
      <RouterView @changed="refreshCounts" />
    </main>

    <!-- Bottom bar on small screens -->
    <nav class="fixed inset-x-0 bottom-0 z-10 flex h-(--mobile-bar-h) items-center justify-around border-t border-hair bg-slate md:hidden">
      <RouterLink
        v-for="n in nav"
        :key="n.to"
        :to="n.to"
        class="relative flex flex-col items-center gap-1 px-3 py-1 text-[11px] text-foreground3"
        :exact-active-class="n.to === '/' ? '!text-foreground2' : ''"
        :active-class="n.to === '/' ? '' : '!text-foreground2'"
      >
        <component :is="n.icon" class="size-5" />
        {{ n.label }}
        <Badge v-if="n.count()" class="absolute -top-0.5 right-0">{{ n.count() }}</Badge>
      </RouterLink>
    </nav>
    <Toaster position="bottom-right" />
  </div>
</template>
