<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api, fmtAgo, useAsync, useServerEvents } from '@/api/client';
import KindBadge from '@/components/KindBadge.vue';
import PageHeader from '@/components/PageHeader.vue';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const router = useRouter();
const { data, error, loading, run } = useAsync(api.links);
const withNew = computed(() => (data.value ?? []).filter((l) => l.pendingCount > 0));
const rest = computed(() => (data.value ?? []).filter((l) => l.pendingCount === 0));
const fmtInterval = (m: number) => (m < 60 ? `${m}m` : `${m / 60}h`);

useServerEvents((e) => {
  if (e.type === 'new_chapters' || e.type === 'job') void run();
});
onMounted(run);
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="Tracked series" description="Linked sources are re-checked on their interval. New chapters wait here until you download or skip them." />
    <div v-if="error" class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{{ error }}</div>
    <Skeleton v-if="loading && !data" class="h-40 w-full" />
    <Card v-else-if="data && !data.length">
      <CardContent class="py-10 text-center text-sm text-muted-foreground">Nothing linked yet. Open a request and link a source.</CardContent>
    </Card>

    <Card v-if="withNew.length" class="border-primary/40">
      <CardHeader><CardTitle>New chapters waiting</CardTitle></CardHeader>
      <CardContent class="px-0">
        <Table>
          <TableBody>
            <TableRow v-for="l in withNew" :key="l.id" class="cursor-pointer" @click="router.push(`/links/${l.id}`)">
              <TableCell class="pl-6">
                <div class="font-medium">{{ l.seriesTitle }}</div>
                <div class="text-xs text-muted-foreground">{{ l.requestTitle }}</div>
              </TableCell>
              <TableCell>{{ l.sourceName }} <KindBadge :kind="l.sourceKind" class="ml-1" /></TableCell>
              <TableCell><Badge>{{ l.pendingCount }} new</Badge></TableCell>
              <TableCell class="pr-6 text-right text-xs text-muted-foreground">{{ fmtAgo(l.lastCheckedAt) }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <Card v-if="rest.length" class="py-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="pl-6">Series</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Chapters</TableHead>
            <TableHead>Watching</TableHead>
            <TableHead class="pr-6 text-right">Checked</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="l in rest" :key="l.id" class="cursor-pointer" @click="router.push(`/links/${l.id}`)">
            <TableCell class="pl-6">
              <div class="font-medium">{{ l.seriesTitle }}</div>
              <div class="text-xs text-muted-foreground">{{ l.requestTitle }}</div>
            </TableCell>
            <TableCell>{{ l.sourceName }} <KindBadge :kind="l.sourceKind" class="ml-1" /></TableCell>
            <TableCell>{{ l.chapterCount }}</TableCell>
            <TableCell class="text-sm">
              <span v-if="l.watch">every {{ fmtInterval(l.checkIntervalMin) }}</span>
              <span v-else class="text-muted-foreground">paused</span>
            </TableCell>
            <TableCell class="pr-6 text-right text-xs">
              <span class="text-muted-foreground">{{ fmtAgo(l.lastCheckedAt) }}</span>
              <div v-if="l.lastError" class="text-destructive">{{ l.lastError }}</div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </Card>
  </div>
</template>
