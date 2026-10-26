<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { ArrowLeft, CheckCheck, Download, ExternalLink, Lock, RefreshCw, SkipForward, Trash2 } from 'lucide-vue-next';
import type { LinkChapter } from '@atsusync/shared';
import { api, fmtAgo, fmtRanges, useAsync, useServerEvents } from '@/api/client';
import KindBadge from '@/components/KindBadge.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { tone } from '@/lib/tone';

const props = defineProps<{ id: number }>();
const emit = defineEmits<{ changed: [] }>();
const router = useRouter();

const { data, error, loading, run } = useAsync(() => api.link(props.id));
const selected = ref(new Set<number>());
const busy = ref(false);
const filter = ref<'missing' | 'all'>('missing');

const INTERVALS = [15, 30, 60, 120, 360, 720, 1440];
const fmtInterval = (m: number) => (m < 60 ? `${m} min` : `${m / 60} h`);

const link = computed(() => data.value?.link);
const chapters = computed(() => {
  const all = [...(data.value?.chapters ?? [])].reverse();
  return filter.value === 'missing' ? all.filter((c) => !c.onAtsu && c.state !== 'uploaded' && c.state !== 'skipped') : all;
});
const downloadable = (c: LinkChapter) => !c.locked && !c.onAtsu && c.state !== 'queued' && c.state !== 'uploaded';
const allSelected = computed(() => chapters.value.some(downloadable) && chapters.value.filter(downloadable).every((c) => selected.value.has(c.id)));

// Pre-select new chapters Atsumaru doesn't have yet.
watch(data, (d) => {
  selected.value = new Set((d?.chapters ?? []).filter((c) => c.state === 'pending' && downloadable(c)).map((c) => c.id));
});

function toggle(id: number, on: boolean) {
  const s = new Set(selected.value);
  on ? s.add(id) : s.delete(id);
  selected.value = s;
}
function toggleAll(on: boolean) {
  selected.value = on ? new Set(chapters.value.filter(downloadable).map((c) => c.id)) : new Set();
}

async function act(fn: () => Promise<unknown>) {
  busy.value = true;
  try {
    await fn();
    await run();
    emit('changed');
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    busy.value = false;
  }
}

const download = () =>
  act(async () => {
    const jobs = await api.download([...selected.value]);
    toast.success(`Downloading ${jobs.length} chapter(s)`, {
      action: { label: 'View', onClick: () => void router.push('/downloads') },
    });
  });
const markUploaded = () =>
  act(async () => {
    await api.setChapterState([...selected.value], 'uploaded');
    toast('Marked as uploaded');
  });
const skip = () => act(async () => {
  await api.setChapterState([...selected.value], 'skipped');
  toast('Marked as skipped');
});
const checkNow = () => act(async () => {
  const r = await api.checkLink(props.id);
  toast(r.added ? `${r.added} new chapter(s) found` : 'No new chapters');
});
const setWatch = (watch: boolean) => act(() => api.updateLink(props.id, { watch }));
const setInterval_ = (v: unknown) => act(() => api.updateLink(props.id, { checkIntervalMin: Number(v) }));
async function remove() {
  if (!confirm('Remove this link and its chapter history?')) return;
  const requestId = link.value?.requestId;
  await api.deleteLink(props.id);
  emit('changed');
  await router.push(requestId ? `/requests/${requestId}` : '/tracked');
}

useServerEvents((e) => {
  const mine =
    (e.type === 'job' && e.job.linkId === props.id && ['done', 'failed', 'cancelled'].includes(e.job.state)) ||
    (e.type === 'new_chapters' && e.linkId === props.id);
  if (mine) void run();
});

onMounted(run);
</script>

<template>
  <div class="space-y-6">
    <Button
      v-if="link"
      variant="ghost"
      size="sm"
      class="-ml-2 text-muted-foreground"
      @click="router.push(`/requests/${link.requestId}`)"
    >
      <ArrowLeft class="size-4" /> {{ link.requestTitle }}
    </Button>
    <div v-if="error" class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{{ error }}</div>
    <Skeleton v-if="loading && !data" class="h-40 w-full" />

    <template v-if="link && data">
      <div class="flex flex-wrap items-start gap-4">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <h1 class="text-2xl font-semibold tracking-tight">{{ link.seriesTitle }}</h1>
            <KindBadge :kind="link.sourceKind" />
          </div>
          <p class="text-sm text-muted-foreground">
            {{ link.sourceName }} · checked {{ fmtAgo(link.lastCheckedAt) }}
            <span v-if="link.lastError" class="text-destructive"> · {{ link.lastError }}</span>
          </p>
        </div>
        <Button as="a" :href="link.seriesUrl" target="_blank" rel="noopener" variant="outline">
          Open on {{ link.sourceName }} <ExternalLink class="size-4" />
        </Button>
        <Button variant="outline" :disabled="busy" @click="checkNow"><RefreshCw class="size-4" /> Check now</Button>
        <Button variant="ghost" class="text-destructive" @click="remove"><Trash2 class="size-4" /> Unlink</Button>
      </div>

      <div class="grid gap-4 md:grid-cols-2">
        <Card class="py-4">
          <CardContent class="text-sm">
            <template v-if="data.atsu?.found">
              Atsumaru has <strong>{{ data.atsu.total }}</strong> chapters
              <span class="text-muted-foreground">({{ fmtRanges(data.atsu.ranges) || 'none' }})</span>;
              {{ link.sourceName }} has <strong>{{ data.chapters.length }}</strong>.
              <Badge v-if="data.atsu.waiting.length" variant="outline" :class="tone('warning')" class="ml-1">
                in review: {{ fmtRanges(data.atsu.waiting) }}
              </Badge>
            </template>
            <span v-else class="text-muted-foreground">
              {{ data.atsu?.error ?? 'Series not on Atsumaru yet' }}, so every chapter counts as missing.
            </span>
          </CardContent>
        </Card>
        <Card class="py-4">
          <CardContent class="flex flex-wrap items-center gap-3 text-sm">
            <Switch id="watch" :model-value="link.watch" @update:model-value="setWatch" />
            <Label for="watch" class="font-normal">Watch for new chapters every</Label>
            <Select :model-value="String(link.checkIntervalMin)" :disabled="!link.watch" @update:model-value="setInterval_">
              <SelectTrigger class="h-8 w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="m in INTERVALS" :key="m" :value="String(m)">{{ fmtInterval(m) }}</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      </div>

      <Card class="py-0">
        <div class="flex flex-wrap items-center gap-2 border-b p-3">
          <Tabs v-model="filter">
            <TabsList>
              <TabsTrigger value="missing">Missing on Atsumaru</TabsTrigger>
              <TabsTrigger value="all">All chapters</TabsTrigger>
            </TabsList>
          </Tabs>
          <div class="flex-1" />
          <span class="text-sm text-muted-foreground">{{ selected.size }} selected</span>
          <Button variant="outline" size="sm" :disabled="busy || !selected.size" @click="skip"><SkipForward class="size-4" /> Skip</Button>
          <Button variant="outline" size="sm" :disabled="busy || !selected.size" title="After you uploaded them on atsu.moe" @click="markUploaded">
            <CheckCheck class="size-4" /> Mark uploaded
          </Button>
          <Button size="sm" :disabled="busy || !selected.size" @click="download">
            <Download class="size-4" /> Download
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="w-10 pl-4"><Checkbox :model-value="allSelected" @update:model-value="(v) => toggleAll(!!v)" /></TableHead>
              <TableHead>Chapter</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Atsumaru</TableHead>
              <TableHead>First seen</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="c in chapters" :key="c.id" :data-state="selected.has(c.id) ? 'selected' : undefined">
              <TableCell class="pl-4">
                <Checkbox :model-value="selected.has(c.id)" :disabled="!downloadable(c)" @update:model-value="(v) => toggle(c.id, !!v)" />
              </TableCell>
              <TableCell class="font-medium">
                {{ c.label }}
                <Badge v-if="c.locked" variant="outline" :class="tone('warning')" class="ml-1" title="Paid or early access on the source">
                  <Lock class="size-3" /> Locked
                </Badge>
              </TableCell>
              <TableCell><StatusBadge :status="c.state" /></TableCell>
              <TableCell>
                <Badge v-if="c.onAtsu" variant="outline" :class="tone('success')">Has it</Badge>
                <span v-else class="text-xs text-muted-foreground">missing</span>
              </TableCell>
              <TableCell class="text-xs text-muted-foreground">{{ fmtAgo(c.firstSeenAt) }}</TableCell>
              <TableCell class="text-right">
                <Button as="a" :href="c.url" target="_blank" rel="noopener" variant="ghost" size="sm">Read <ExternalLink class="size-3" /></Button>
              </TableCell>
            </TableRow>
            <TableRow v-if="!chapters.length">
              <TableCell colspan="6" class="py-10 text-center text-sm text-muted-foreground">
                Nothing missing. Atsumaru is up to date with this source.
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>
    </template>
  </div>
</template>
