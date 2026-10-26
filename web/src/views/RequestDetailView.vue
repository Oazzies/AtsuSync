<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { ArrowLeft, ExternalLink, Link2, Loader2, MessageSquare, RefreshCw, Search } from 'lucide-vue-next';
import type { AtsuPresence, AtsuSeriesState, RequestComment, SourceKind, SourceMatch } from '@atsusync/shared';
import { api, fmtAgo, fmtRanges, useAsync } from '@/api/client';
import KindBadge from '@/components/KindBadge.vue';
import Markdown from '@/components/Markdown.vue';
import PresenceBadge from '@/components/PresenceBadge.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { tone } from '@/lib/tone';

const props = defineProps<{ id: string }>();
const emit = defineEmits<{ changed: [] }>();
const router = useRouter();

const { data, error, loading, run } = useAsync(() => api.request(props.id));
const atsu = ref<AtsuSeriesState | null>(null);
const comments = ref<RequestComment[] | null>(null);
const presence = ref<AtsuPresence | null>(null);
const checking = ref(false);
const finding = ref(false);
const searched = ref(false);
const pasteUrl = ref('');
const linking = ref<string | null>(null);
const kindFilter = ref<'all' | SourceKind>('all');

const req = computed(() => data.value?.request);
const matches = computed(() => (data.value?.matches ?? []).filter((m) => kindFilter.value === 'all' || m.sourceKind === kindFilter.value));
const linkedUrls = computed(() => new Set((data.value?.links ?? []).map((l) => l.seriesUrl)));
const altTitles = computed(() => (data.value?.mangabaka?.titles ?? []).filter((t) => t !== req.value?.title));

async function load() {
  await run();
  presence.value = req.value?.presence ?? null;
  void api.requestAtsu(props.id).then((a) => (atsu.value = a)).catch(() => null);
  void api.comments(props.id).then((c) => (comments.value = c)).catch(() => (comments.value = []));
}

async function recheck() {
  checking.value = true;
  try {
    presence.value = await api.checkPresence(props.id);
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    checking.value = false;
  }
}

async function findSources() {
  finding.value = true;
  try {
    const m = await api.findSources(props.id);
    if (data.value) data.value.matches = m;
    searched.value = true;
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    finding.value = false;
  }
}

async function addByUrl() {
  if (!pasteUrl.value.trim()) return;
  try {
    await api.addSource(props.id, pasteUrl.value.trim());
    pasteUrl.value = '';
    await run();
  } catch (e) {
    toast.error((e as Error).message);
  }
}

async function link(m: SourceMatch) {
  linking.value = m.seriesUrl;
  try {
    const l = await api.createLink(props.id, m.sourceId, m.seriesUrl);
    emit('changed');
    await router.push(`/links/${l.id}`);
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    linking.value = null;
  }
}

const scoreTone = (s: number) => tone(s >= 0.85 ? 'success' : s >= 0.6 ? 'warning' : 'danger');
const aheadOfAtsu = (m: SourceMatch) =>
  m.latestChapter != null && atsu.value?.found && atsu.value.latest != null ? Math.max(0, m.latestChapter - atsu.value.latest) : null;

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <Button variant="ghost" size="sm" class="-ml-2 text-muted-foreground" @click="router.push('/')">
      <ArrowLeft class="size-4" /> Requests
    </Button>
    <div v-if="error" class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{{ error }}</div>
    <Skeleton v-if="loading && !data" class="h-48 w-full" />

    <template v-if="req">
      <!-- Post -->
      <Card>
        <CardContent class="flex gap-5">
          <img v-if="data?.mangabaka?.cover" :src="data.mangabaka.cover" class="hidden h-40 w-28 shrink-0 rounded-md object-cover sm:block" />
          <div class="min-w-0 flex-1 space-y-3">
            <div class="flex flex-wrap items-center gap-2">
              <h1 class="text-2xl font-semibold tracking-tight">{{ req.title }}</h1>
              <StatusBadge :status="req.status" />
              <Badge v-for="t in req.tags" :key="t.id" variant="secondary">{{ t.emoji }} {{ t.name }}</Badge>
            </div>
            <p v-if="altTitles.length" class="text-xs text-muted-foreground">Also known as: {{ altTitles.join(' · ') }}</p>
            <Markdown :source="req.content" />
            <div class="flex flex-wrap gap-2 pt-1">
              <Button as="a" :href="req.url" target="_blank" rel="noopener" variant="outline" size="sm">
                <ExternalLink class="size-4" /> Open post
              </Button>
              <Button v-for="t in req.trackers" :key="t.url" as="a" :href="t.url" target="_blank" rel="noopener" variant="ghost" size="sm" class="capitalize">
                {{ t.kind }} <ExternalLink class="size-3" />
              </Button>
            </div>
            <p class="text-xs text-muted-foreground">Posted {{ fmtAgo(req.createdAt) }}<template v-if="req.authorName"> by {{ req.authorName }}</template></p>
          </div>
        </CardContent>
      </Card>

      <div class="grid gap-6 lg:grid-cols-2">
        <!-- Atsumaru state -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">On Atsumaru <PresenceBadge :presence="presence" /></CardTitle>
            <CardDescription>Already uploaded by someone, even if the request isn't marked Added yet?</CardDescription>
          </CardHeader>
          <CardContent class="space-y-3 text-sm">
            <Skeleton v-if="!atsu" class="h-5 w-2/3" />
            <div v-else-if="atsu.found" class="space-y-2">
              <div>
                <strong>{{ atsu.title ?? atsu.mangaId }}</strong> has <strong>{{ atsu.total }}</strong> chapters
                <span class="text-muted-foreground">({{ fmtRanges(atsu.ranges) || 'none' }})</span>
              </div>
              <Badge v-if="atsu.waiting.length" variant="outline" :class="tone('warning')">In review: {{ fmtRanges(atsu.waiting) }}</Badge>
              <div v-if="atsu.others.length" class="flex flex-wrap gap-1.5">
                <Badge v-for="o in atsu.others" :key="o.id" variant="secondary">{{ o.label }} · {{ o.chapters }} ch · latest {{ o.latest ?? '—' }}</Badge>
              </div>
            </div>
            <p v-else class="text-muted-foreground">{{ atsu.error ?? 'Not on Atsumaru yet. Uploading creates it from the MangaBaka entry.' }}</p>

            <div v-if="presence?.match && presence.match.via !== 'mangabaka'" class="rounded-md border p-3">
              <div class="text-xs text-muted-foreground">Closest Atsu series ({{ presence.match.via }})</div>
              <a :href="`https://atsu.moe/manga/${presence.match.mangaId}`" target="_blank" rel="noopener" class="font-medium hover:underline">
                {{ presence.match.title }}
              </a>
              <span v-if="presence.match.via === 'comment'" class="text-muted-foreground"> · linked in a comment</span>
              <span v-else class="text-muted-foreground"> · {{ presence.match.chapterCount }} ch · {{ Math.round(presence.match.score * 100) }}% title match</span>
            </div>
            <div class="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Checked {{ fmtAgo(presence?.checkedAt ?? null) }}</span>
              <Button variant="ghost" size="sm" :disabled="checking" @click="recheck">
                <RefreshCw class="size-3.5" :class="{ 'animate-spin': checking }" /> Check now
              </Button>
            </div>
          </CardContent>
        </Card>

        <!-- Comments -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2"><MessageSquare class="size-4" /> Comments</CardTitle>
            <CardDescription>Highlighted comments mention adding or uploading.</CardDescription>
          </CardHeader>
          <CardContent class="max-h-80 space-y-3 overflow-y-auto">
            <Skeleton v-if="!comments" class="h-12 w-full" />
            <p v-else-if="!comments.length" class="text-sm text-muted-foreground">No comments.</p>
            <div
              v-for="c in comments ?? []"
              :key="c.id"
              class="rounded-md border p-3"
              :class="[c.claim ? 'border-warning/50 bg-warning/5' : '', c.parentId ? 'ml-6' : '']"
            >
              <div class="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span class="font-medium text-foreground">{{ c.user }}</span> · {{ fmtAgo(c.createdAt) }}
                <Badge v-if="c.claim" variant="outline" :class="tone('warning')" class="h-4 px-1 text-[10px]">upload claim</Badge>
              </div>
              <Markdown :source="c.content" />
            </div>
          </CardContent>
        </Card>
      </div>

      <!-- Linked -->
      <Card v-if="data?.links.length">
        <CardHeader><CardTitle>Linked sources</CardTitle></CardHeader>
        <CardContent class="px-0">
          <Table>
            <TableBody>
              <TableRow v-for="l in data.links" :key="l.id" class="cursor-pointer" @click="router.push(`/links/${l.id}`)">
                <TableCell class="pl-6"><span class="font-medium">{{ l.sourceName }}</span> — {{ l.seriesTitle }}</TableCell>
                <TableCell><KindBadge :kind="l.sourceKind" /></TableCell>
                <TableCell>{{ l.chapterCount }} chapters</TableCell>
                <TableCell><Badge v-if="l.pendingCount">{{ l.pendingCount }} new</Badge></TableCell>
                <TableCell class="pr-6 text-right text-xs text-muted-foreground">checked {{ fmtAgo(l.lastCheckedAt) }}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <!-- Sources -->
      <Card>
        <CardHeader class="flex flex-row flex-wrap items-start gap-3">
          <div class="flex-1 space-y-1.5">
            <CardTitle>Sources</CardTitle>
            <CardDescription>
              Searches each enabled site once with the request title and its alt titles. Open the series to check quality before linking.
            </CardDescription>
          </div>
          <Button :disabled="finding" @click="findSources">
            <Loader2 v-if="finding" class="size-4 animate-spin" /><Search v-else class="size-4" />
            {{ finding ? 'Searching…' : (data?.matches.length ? 'Search again' : 'Find sources') }}
          </Button>
        </CardHeader>
        <CardContent class="space-y-4">
          <Tabs v-model="kindFilter">
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="scanlation">Scanlation</TabsTrigger>
              <TabsTrigger value="aggregator">Aggregator</TabsTrigger>
            </TabsList>
          </Tabs>

          <Table v-if="matches.length">
            <TableHeader>
              <TableRow>
                <TableHead class="w-14" />
                <TableHead>Site</TableHead>
                <TableHead>Series</TableHead>
                <TableHead>Match</TableHead>
                <TableHead>Chapters</TableHead>
                <TableHead class="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="m in matches" :key="m.sourceId + m.seriesUrl">
                <TableCell>
                  <img v-if="m.cover" :src="m.cover" class="h-14 w-10 rounded object-cover" loading="lazy" referrerpolicy="no-referrer" />
                </TableCell>
                <TableCell>
                  <div class="font-medium">{{ m.sourceName }}</div>
                  <KindBadge :kind="m.sourceKind" />
                </TableCell>
                <TableCell class="max-w-xs">
                  <div class="truncate">{{ m.title }}</div>
                  <div v-if="m.error" class="text-xs text-destructive">{{ m.error }}</div>
                </TableCell>
                <TableCell><Badge variant="outline" :class="scoreTone(m.score)">{{ Math.round(m.score * 100) }}%</Badge></TableCell>
                <TableCell>
                  {{ m.chapterCount ?? '—' }}
                  <span v-if="m.latestChapter != null" class="text-xs text-muted-foreground"> · latest {{ m.latestChapter }}</span>
                  <div v-if="aheadOfAtsu(m)" class="text-xs text-primary">+{{ aheadOfAtsu(m) }} ahead of Atsu</div>
                </TableCell>
                <TableCell>
                  <div class="flex justify-end gap-2">
                    <Button v-if="!m.seriesUrl.includes('#')" as="a" :href="m.seriesUrl" target="_blank" rel="noopener" variant="outline" size="sm">
                      Open <ExternalLink class="size-3" />
                    </Button>
                    <Badge v-if="linkedUrls.has(m.seriesUrl)" variant="outline" :class="tone('success')">Linked</Badge>
                    <Button v-else-if="!m.error" size="sm" :disabled="linking === m.seriesUrl" @click="link(m)">
                      <Link2 class="size-4" /> {{ linking === m.seriesUrl ? 'Linking…' : 'Link' }}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <p v-else-if="!finding" class="text-sm text-muted-foreground">
            {{ searched ? 'No matches on the enabled sites. Paste a series URL below if you know one.' : 'No lookups yet for this request.' }}
          </p>

          <div class="flex gap-2">
            <Input v-model="pasteUrl" placeholder="Or paste a series URL from a supported site…" @keyup.enter="addByUrl" />
            <Button variant="outline" @click="addByUrl">Add</Button>
          </div>
        </CardContent>
      </Card>
    </template>
  </div>
</template>
