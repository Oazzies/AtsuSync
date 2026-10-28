<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { ExternalLink, MessageSquare, RefreshCw, Search } from 'lucide-vue-next';
import type { ContentRequest } from '@atsusync/shared';
import { api, fmtAgo, useAsync, useServerEvents } from '@/api/client';
import PageHeader from '@/components/PageHeader.vue';
import PresenceBadge from '@/components/PresenceBadge.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const router = useRouter();
const { data, error, loading, run } = useAsync(api.requests);
const syncing = ref(false);

const q = ref('');
const type = ref('all');
const kind = ref('all');
const showAll = ref(false);
const view = ref<'all' | 'done' | 'linked' | 'series'>('all');
const seriesUrl = ref('');
const adding = ref(false);

const TYPES = ['Manhwa', 'Manga', 'Manhua', 'Comic', 'Novel'];
const CLOSED = new Set(['added', 'cant_add', 'duplicate']);
const looksDone = (r: ContentRequest) => r.uploadable && (r.presence?.verdict === 'on_atsu' || r.presence?.verdict === 'claimed');

const doneCount = computed(() => (data.value ?? []).filter(looksDone).length);

const filtered = computed(() => {
  const needle = q.value.trim().toLowerCase();
  return (data.value ?? []).filter((r) => {
    if (view.value === 'done' && !looksDone(r)) return false;
    if (view.value === 'linked' && !r.linkCount) return false;
    if (view.value === 'series' ? !r.atsuMangaId : !!r.atsuMangaId && view.value !== 'linked') return false;
    // The default lists only posts that still have Atsumaru's "Upload this" button.
    if (view.value === 'all' && !showAll.value && !r.uploadable) return false;
    if (type.value !== 'all' && !r.tags.some((t) => t.name === type.value)) return false;
    if (kind.value !== 'all' && r.kind !== kind.value) return false;
    if (needle && !r.title.toLowerCase().includes(needle)) return false;
    return true;
  });
});

async function sync(full: boolean) {
  syncing.value = true;
  try {
    const r = await api.syncRequests(full);
    toast.success(`Synced: ${r.added} new, ${r.updated} updated`);
    await run();
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    syncing.value = false;
  }
}

async function addSeries() {
  if (!seriesUrl.value.trim()) return;
  adding.value = true;
  try {
    const r = await api.addSeries(seriesUrl.value.trim());
    seriesUrl.value = '';
    await router.push(`/requests/${encodeURIComponent(r.id)}`);
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    adding.value = false;
  }
}

const typeTags = (r: ContentRequest) => r.tags.filter((t) => TYPES.includes(t.name));

useServerEvents((e) => {
  if (e.type === 'requests_synced' && e.added > 0) void run();
});
onMounted(run);
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="Content requests" description="Synced from the Atsumaru forum. Open a request to find sources for it.">
      <Button variant="outline" :disabled="syncing" @click="sync(false)">
        <RefreshCw class="size-4" :class="{ 'animate-spin': syncing }" /> Sync new
      </Button>
      <Button variant="ghost" :disabled="syncing" title="Walk every page to pick up status changes on old requests" @click="sync(true)">
        Full sync
      </Button>
    </PageHeader>

    <div class="flex flex-wrap items-center gap-3">
      <Tabs v-model="view">
        <TabsList>
          <TabsTrigger value="all">Requests</TabsTrigger>
          <TabsTrigger value="done">
            Probably done <Badge v-if="doneCount" class="ml-1.5 h-5 px-1.5">{{ doneCount }}</Badge>
          </TabsTrigger>
          <TabsTrigger value="linked">Linked</TabsTrigger>
          <TabsTrigger value="series">Existing series</TabsTrigger>
        </TabsList>
      </Tabs>
      <div class="relative min-w-56 flex-1">
        <Search class="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="q" placeholder="Search titles…" class="pl-8" />
      </div>
      <Select v-model="type">
        <SelectTrigger class="w-36"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All types</SelectItem>
          <SelectItem v-for="t in TYPES" :key="t" :value="t">{{ t }}</SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="kind">
        <SelectTrigger class="w-44"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Series + sources</SelectItem>
          <SelectItem value="new_series">New series</SelectItem>
          <SelectItem value="new_source">New source</SelectItem>
        </SelectContent>
      </Select>
      <div v-if="view === 'all'" class="flex items-center gap-2">
        <Switch id="all" v-model="showAll" />
        <Label for="all" class="text-sm font-normal text-muted-foreground">Include posts without an upload button</Label>
      </div>
    </div>

    <div v-if="view === 'series'" class="space-y-2">
      <p class="text-sm text-muted-foreground">
        Series that are already on Atsumaru, with no content request. Paste its atsu.moe/manga/… link, link a source, and upload the missing chapters.
      </p>
      <div class="flex max-w-xl gap-2">
        <Input v-model="seriesUrl" placeholder="https://atsu.moe/manga/YwMX0" @keyup.enter="addSeries" />
        <Button :disabled="adding || !seriesUrl.trim()" @click="addSeries">{{ adding ? 'Adding…' : 'Add series' }}</Button>
      </div>
    </div>

    <p v-if="view === 'done'" class="text-sm text-muted-foreground">
      Requests with an upload button that look finished: the series already exists on Atsumaru with chapters, or a comment says someone added or is
      uploading it. Checked in the background, slowly, a few requests at a time.
    </p>

    <div v-if="error" class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{{ error }}</div>

    <Card class="overflow-hidden py-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Tracker</TableHead>
            <TableHead class="text-right">Posted</TableHead>
            <TableHead class="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          <template v-if="loading && !data">
            <TableRow v-for="i in 6" :key="i">
              <TableCell colspan="6"><Skeleton class="h-6 w-full" /></TableCell>
            </TableRow>
          </template>
          <TableRow
            v-for="r in filtered"
            :key="r.id"
            class="cursor-pointer"
            @click="router.push(`/requests/${encodeURIComponent(r.id)}`)"
          >
            <TableCell class="max-w-md">
              <div class="truncate font-medium">{{ r.title }}</div>
              <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span v-if="r.atsuMangaId">On Atsumaru ·</span>
                <span v-else-if="r.kind">{{ r.kind === 'new_source' ? 'New source' : 'New series' }} ·</span>
                <span v-if="r.authorName">{{ r.authorName }} ·</span>
                <MessageSquare class="size-3" /> {{ r.commentCount }}
                <Badge v-if="r.linkCount" variant="secondary" class="ml-1 h-4 px-1 text-[10px]">linked</Badge>
                <Badge v-if="!r.uploadable && !r.atsuMangaId" variant="outline" class="ml-1 h-4 px-1 text-[10px]" title="Atsumaru shows no Upload button on this post">no upload button</Badge>
              </div>
            </TableCell>
            <TableCell>
              <Badge v-for="t in typeTags(r)" :key="t.id" variant="secondary">{{ t.emoji }} {{ t.name }}</Badge>
            </TableCell>
            <TableCell>
              <div class="flex flex-wrap gap-1">
                <StatusBadge :status="r.status" />
                <PresenceBadge v-if="!CLOSED.has(r.status)" :presence="r.presence" />
              </div>
            </TableCell>
            <TableCell>
              <span v-if="r.mangabakaId" class="text-sm">MangaBaka</span>
              <span v-else-if="r.trackers.some((t) => t.kind !== 'other')" class="text-sm capitalize">
                {{ r.trackers.find((t) => t.kind !== 'other')!.kind }}
              </span>
              <span v-else class="text-xs text-muted-foreground">none</span>
            </TableCell>
            <TableCell class="text-right text-xs text-muted-foreground">{{ fmtAgo(r.createdAt) }}</TableCell>
            <TableCell>
              <Button as="a" :href="r.url" target="_blank" rel="noopener" variant="ghost" size="icon" class="size-8" @click.stop>
                <ExternalLink class="size-4" />
              </Button>
            </TableCell>
          </TableRow>
          <TableRow v-if="data && !filtered.length">
            <TableCell colspan="6" class="py-10 text-center text-sm text-muted-foreground">
              {{ data.length ? 'Nothing matches these filters.' : 'No requests yet. Press “Sync new”.' }}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </Card>
    <p class="text-xs text-muted-foreground">{{ filtered.length }} of {{ data?.length ?? 0 }} requests</p>
  </div>
</template>
