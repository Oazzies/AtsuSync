<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { ExternalLink, RefreshCw, Search, Trash2 } from '@/icons';
import type { Link } from '@atsusync/shared';
import { api, fmtAgo, useAsync, useServerEvents } from '@/api/client';
import KindBadge from '@/components/KindBadge.vue';
import PageHeader from '@/components/PageHeader.vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { tone } from '@/lib/tone';

const emit = defineEmits<{ changed: [] }>();
const router = useRouter();
const { data, error, loading, run } = useAsync(api.links);

const view = ref<'all' | 'new' | 'missing' | 'not_on_atsu' | 'caught_up'>('all');
const q = ref('');
const sourceFilter = ref('all');
const watchFilter = ref<'all' | 'watching' | 'paused' | 'errors'>('all');
const sortBy = ref<'default' | 'missing' | 'title' | 'checked' | 'chapters'>('default');

const selected = ref(new Set<number>());
const checkingIds = ref(new Set<number>());
const busy = ref(false);
const refreshingAtsu = ref(false);
const checkingAll = ref(false);

const fmtInterval = (m: number) => (m < 60 ? `${m}m` : `${m / 60}h`);

const links = computed(() => data.value ?? []);
const sources = computed(() => [...new Set(links.value.map((l) => l.sourceName))].sort((a, b) => a.localeCompare(b)));

const counts = computed(() => {
  const all = links.value;
  return {
    all: all.length,
    new: all.filter((l) => l.pendingCount > 0).length,
    missing: all.filter((l) => l.missingCount > 0).length,
    notOnAtsu: all.filter((l) => !l.atsuMangaId && l.atsuTotal === null).length,
    caughtUp: all.filter((l) => l.missingCount === 0 && l.pendingCount === 0).length,
  };
});

const filtered = computed(() => {
  const needle = q.value.trim().toLowerCase();
  const list = links.value.filter((l) => {
    if (view.value === 'new' && l.pendingCount === 0) return false;
    if (view.value === 'missing' && l.missingCount === 0) return false;
    if (view.value === 'not_on_atsu' && (l.atsuMangaId || l.atsuTotal !== null)) return false;
    if (view.value === 'caught_up' && (l.missingCount > 0 || l.pendingCount > 0)) return false;
    if (sourceFilter.value !== 'all' && l.sourceName !== sourceFilter.value) return false;
    if (watchFilter.value === 'watching' && !l.watch) return false;
    if (watchFilter.value === 'paused' && l.watch) return false;
    if (watchFilter.value === 'errors' && !l.lastError) return false;
    if (needle) {
      const hay = `${l.seriesTitle} ${l.requestTitle} ${l.sourceName}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  return [...list].sort((a, b) => {
    if (sortBy.value === 'missing') return b.missingCount - a.missingCount || b.pendingCount - a.pendingCount || a.seriesTitle.localeCompare(b.seriesTitle);
    if (sortBy.value === 'title') return a.seriesTitle.localeCompare(b.seriesTitle);
    if (sortBy.value === 'checked') return (a.lastCheckedAt ?? 0) - (b.lastCheckedAt ?? 0);
    if (sortBy.value === 'chapters') return b.chapterCount - a.chapterCount;
    return b.pendingCount - a.pendingCount || b.missingCount - a.missingCount || (b.lastCheckedAt ?? 0) - (a.lastCheckedAt ?? 0);
  });
});

const allSelected = computed(() => filtered.value.length > 0 && filtered.value.every((l) => selected.value.has(l.id)));

function toggle(id: number, on: boolean) {
  const s = new Set(selected.value);
  on ? s.add(id) : s.delete(id);
  selected.value = s;
}

function toggleAll(on: boolean) {
  if (!on) {
    selected.value = new Set();
    return;
  }
  selected.value = new Set(filtered.value.map((l) => l.id));
}

async function refreshAtsu() {
  refreshingAtsu.value = true;
  try {
    const res = await api.refreshAtsuLinks();
    toast.success(`Refreshed Atsu coverage for ${res.updated} series`);
    await run();
    emit('changed');
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    refreshingAtsu.value = false;
  }
}

async function checkAll() {
  checkingAll.value = true;
  try {
    const res = await api.checkAllLinks();
    toast.success(`Checked ${res.checked} series${res.added ? `, ${res.added} new chapter(s)` : ''}`);
    await run();
    emit('changed');
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    checkingAll.value = false;
  }
}

async function checkOne(l: Link) {
  const s = new Set(checkingIds.value);
  s.add(l.id);
  checkingIds.value = s;
  try {
    const res = await api.checkLink(l.id);
    toast(res.added ? `${l.seriesTitle}: ${res.added} new chapter(s)` : `${l.seriesTitle}: no new chapters`);
    await run();
    emit('changed');
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    const next = new Set(checkingIds.value);
    next.delete(l.id);
    checkingIds.value = next;
  }
}

async function toggleWatch(l: Link, watch: boolean) {
  try {
    await api.updateLink(l.id, { watch });
    await run();
  } catch (e) {
    toast.error((e as Error).message);
  }
}

async function untrackOne(l: Link) {
  if (!confirm(`Untrack "${l.seriesTitle}" (${l.sourceName}) and remove its chapter history?`)) return;
  try {
    await api.deleteLink(l.id);
    const s = new Set(selected.value);
    s.delete(l.id);
    selected.value = s;
    toast.success(`Untracked ${l.seriesTitle}`);
    await run();
    emit('changed');
  } catch (e) {
    toast.error((e as Error).message);
  }
}

async function runBulk(action: 'watch' | 'pause' | 'untrack' | 'check') {
  const ids = [...selected.value];
  if (!ids.length) return;
  if (action === 'untrack' && !confirm(`Untrack ${ids.length} selected series and remove their chapter history?`)) return;
  busy.value = true;
  try {
    await api.bulkLinks(ids, action);
    if (action === 'untrack') {
      selected.value = new Set();
      toast.success(`Untracked ${ids.length} series`);
    } else if (action === 'watch') {
      toast.success(`Resumed watching ${ids.length} series`);
    } else if (action === 'pause') {
      toast.success(`Paused watching ${ids.length} series`);
    } else {
      toast.success(`Checked ${ids.length} series`);
    }
    await run();
    emit('changed');
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    busy.value = false;
  }
}

useServerEvents((e) => {
  if (e.type === 'new_chapters' || e.type === 'chapters_unlocked' || e.type === 'job') void run();
});
onMounted(run);
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="Tracked series"
      description="Linked sources are re-checked on their interval. Filter by Atsumaru coverage, manage watching, or untrack series."
    >
      <Button variant="outline" :disabled="refreshingAtsu || !links.length" @click="refreshAtsu">
        <RefreshCw class="size-4" :class="{ 'animate-spin': refreshingAtsu }" /> Refresh Atsu
      </Button>
      <Button variant="outline" :disabled="checkingAll || !links.length" @click="checkAll">
        <RefreshCw class="size-4" :class="{ 'animate-spin': checkingAll }" /> Check watched
      </Button>
    </PageHeader>

    <div v-if="links.length" class="flex flex-wrap items-center gap-3">
      <Tabs v-model="view">
        <TabsList>
          <TabsTrigger value="all">
            All <Badge variant="secondary" class="ml-1.5">{{ counts.all }}</Badge>
          </TabsTrigger>
          <TabsTrigger value="new">
            New <Badge v-if="counts.new" class="ml-1.5">{{ counts.new }}</Badge>
          </TabsTrigger>
          <TabsTrigger value="missing">
            Missing on Atsu <Badge v-if="counts.missing" variant="secondary" class="ml-1.5">{{ counts.missing }}</Badge>
          </TabsTrigger>
          <TabsTrigger value="not_on_atsu">
            Not on Atsu <Badge v-if="counts.notOnAtsu" variant="secondary" class="ml-1.5">{{ counts.notOnAtsu }}</Badge>
          </TabsTrigger>
          <TabsTrigger value="caught_up">
            Caught up <Badge v-if="counts.caughtUp" variant="secondary" class="ml-1.5">{{ counts.caughtUp }}</Badge>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div class="relative min-w-52 flex-1">
        <Search class="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="q" placeholder="Search series or source…" class="pl-8" />
      </div>

      <Select v-model="sourceFilter">
        <SelectTrigger class="w-40"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All sources</SelectItem>
          <SelectItem v-for="s in sources" :key="s" :value="s">{{ s }}</SelectItem>
        </SelectContent>
      </Select>

      <Select v-model="watchFilter">
        <SelectTrigger class="w-36"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          <SelectItem value="watching">Watching</SelectItem>
          <SelectItem value="paused">Paused</SelectItem>
          <SelectItem value="errors">Has errors</SelectItem>
        </SelectContent>
      </Select>

      <Select v-model="sortBy">
        <SelectTrigger class="w-44"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="default">Sort: Pending first</SelectItem>
          <SelectItem value="missing">Sort: Most missing</SelectItem>
          <SelectItem value="title">Sort: Title A–Z</SelectItem>
          <SelectItem value="chapters">Sort: Most chapters</SelectItem>
          <SelectItem value="checked">Sort: Oldest check</SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div
      v-if="selected.size"
      class="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-4 py-2.5 text-sm shadow-xs"
    >
      <span class="font-medium">{{ selected.size }} selected</span>
      <div class="ml-auto flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" :disabled="busy" @click="runBulk('check')">
          <RefreshCw class="size-3.5" /> Check now
        </Button>
        <Button size="sm" variant="outline" :disabled="busy" @click="runBulk('watch')">Watch</Button>
        <Button size="sm" variant="outline" :disabled="busy" @click="runBulk('pause')">Pause</Button>
        <Button size="sm" variant="destructive" :disabled="busy" @click="runBulk('untrack')">
          <Trash2 class="size-3.5" /> Untrack
        </Button>
        <Button size="sm" variant="ghost" :disabled="busy" @click="selected = new Set()">Clear</Button>
      </div>
    </div>

    <div v-if="error" class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{{ error }}</div>
    <Skeleton v-if="loading && !data" class="h-40 w-full" />
    <Card v-else-if="data && !data.length">
      <CardContent class="py-10 text-center text-sm text-muted-foreground">Nothing linked yet. Open a request and link a source.</CardContent>
    </Card>
    <Card v-else-if="data && !filtered.length">
      <CardContent class="py-10 text-center text-sm text-muted-foreground">No tracked series match the current filters.</CardContent>
    </Card>

    <Card v-else-if="filtered.length" class="overflow-x-auto py-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="w-10 pl-4">
              <Checkbox :model-value="allSelected" @update:model-value="toggleAll(!!$event)" />
            </TableHead>
            <TableHead>Series</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Coverage</TableHead>
            <TableHead>Watching</TableHead>
            <TableHead>Checked</TableHead>
            <TableHead class="pr-4 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow
            v-for="l in filtered"
            :key="l.id"
            class="cursor-pointer"
            :class="{ 'bg-primary/5': l.pendingCount > 0 }"
            @click="router.push(`/links/${l.id}`)"
          >
            <TableCell class="pl-4" @click.stop>
              <Checkbox :model-value="selected.has(l.id)" @update:model-value="toggle(l.id, !!$event)" />
            </TableCell>
            <TableCell class="max-w-md">
              <div class="flex items-center gap-3">
                <img v-if="l.cover" :src="l.cover" :alt="l.seriesTitle" class="h-12 w-9 shrink-0 rounded bg-muted object-cover" loading="lazy" referrerpolicy="no-referrer" />
                <div v-else class="flex h-12 w-9 shrink-0 items-center justify-center rounded bg-muted text-xs text-muted-foreground">—</div>
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5">
                    <span class="truncate font-medium">{{ l.seriesTitle }}</span>
                    <a
                      v-if="l.atsuMangaId"
                      :href="`https://atsu.moe/manga/${l.atsuMangaId}`"
                      target="_blank"
                      rel="noopener"
                      title="Open on Atsumaru"
                      class="shrink-0 text-muted-foreground hover:text-foreground"
                      @click.stop
                    >
                      <ExternalLink class="size-3.5" />
                    </a>
                  </div>
                  <div class="truncate text-xs text-muted-foreground">{{ l.requestTitle }}</div>
                </div>
              </div>
            </TableCell>
            <TableCell class="whitespace-nowrap">
              {{ l.sourceName }}
              <KindBadge :kind="l.sourceKind" class="ml-1" />
            </TableCell>
            <TableCell class="whitespace-nowrap">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="text-sm">{{ l.chapterCount }} ch</span>
                <Badge v-if="l.pendingCount > 0">{{ l.pendingCount }} new</Badge>
                <Badge v-if="l.missingCount > 0" variant="outline" :class="tone('warning')">
                  {{ l.missingCount }} missing
                </Badge>
                <Badge v-else-if="l.atsuTotal !== null" variant="outline" :class="tone('success')">
                  All on Atsu ({{ l.atsuTotal }})
                </Badge>
                <Badge v-else-if="!l.atsuMangaId" variant="outline" class="text-muted-foreground">
                  Not on Atsu
                </Badge>
              </div>
            </TableCell>
            <TableCell class="text-sm whitespace-nowrap" @click.stop>
              <div class="flex items-center gap-2">
                <Switch :model-value="l.watch" @update:model-value="(v) => toggleWatch(l, !!v)" />
                <span v-if="l.watch" class="text-muted-foreground">{{ fmtInterval(l.checkIntervalMin) }}</span>
                <span v-else class="text-muted-foreground">paused</span>
              </div>
            </TableCell>
            <TableCell class="text-xs whitespace-nowrap">
              <span class="text-muted-foreground">{{ fmtAgo(l.lastCheckedAt) }}</span>
              <div v-if="l.lastError" class="max-w-44 truncate text-destructive" :title="l.lastError">{{ l.lastError }}</div>
            </TableCell>
            <TableCell class="pr-4 text-right whitespace-nowrap" @click.stop>
              <div class="inline-flex items-center gap-1">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="Check now"
                  :disabled="checkingIds.has(l.id)"
                  @click="checkOne(l)"
                >
                  <RefreshCw class="size-4" :class="{ 'animate-spin': checkingIds.has(l.id) }" />
                </Button>
                <Button
                  as="a"
                  :href="l.seriesUrl"
                  target="_blank"
                  rel="noopener"
                  size="icon-sm"
                  variant="ghost"
                  title="Open on source"
                >
                  <ExternalLink class="size-4" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  class="text-destructive hover:text-destructive"
                  title="Untrack series"
                  @click="untrackOne(l)"
                >
                  <Trash2 class="size-4" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </Card>
  </div>
</template>
