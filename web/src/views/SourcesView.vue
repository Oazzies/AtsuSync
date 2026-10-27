<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ExternalLink, Stethoscope } from 'lucide-vue-next';
import type { SourceInfo, SourceKind } from '@atsusync/shared';
import { api } from '@/api/client';
import PageHeader from '@/components/PageHeader.vue';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

const sources = ref<SourceInfo[]>([]);
const query = ref('');
const results = reactive<Record<string, { ok: boolean; text: string }>>({});

const GROUPS: { kind: SourceKind; title: string; description: string }[] = [
  { kind: 'scanlation', title: 'Scanlation groups', description: "The group's own site. Best quality and the right credit." },
  {
    kind: 'aggregator',
    title: 'Aggregators',
    description: "Re-host other groups' releases. Use when the group has no site of its own.",
  },
  {
    kind: 'official',
    title: 'Official platforms',
    description: "The publisher's own site, free chapters only (paid ones are skipped). Not searchable: link a series by pasting its URL.",
  },
];
const byKind = computed(() => Object.fromEntries(GROUPS.map((g) => [g.kind, sources.value.filter((s) => s.kind === g.kind)])));

async function load() {
  sources.value = await api.sources();
}

async function toggle(s: SourceInfo, enabled: boolean) {
  sources.value = await api.setSourceEnabled(s.id, enabled);
}

async function test(s: SourceInfo) {
  results[s.id] = { ok: true, text: 'Testing…' };
  try {
    const r = await api.testSource(s.id, query.value || 'love');
    results[s.id] = r.ok
      ? { ok: true, text: `OK in ${r.ms} ms: ${r.hits.map((h) => h.title).join(', ')}` }
      : { ok: false, text: `Nothing found (${r.ms} ms). The site layout may have changed.` };
  } catch (e) {
    results[s.id] = { ok: false, text: (e as Error).message };
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="Sources"
      description="Sites AtsuSync can read. It identifies itself as AtsuSync, follows each site's robots.txt and rate limits, and stops at bot challenges."
    >
      <Input v-model="query" placeholder="Health-check query (default: love)" class="w-64" />
    </PageHeader>

    <Card v-for="g in GROUPS" :key="g.kind">
      <CardHeader>
        <CardTitle>{{ g.title }}</CardTitle>
        <CardDescription>{{ g.description }}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <p v-if="!byKind[g.kind]?.length" class="text-sm text-muted-foreground">None yet.</p>
        <div v-for="s in byKind[g.kind]" :key="s.id" class="flex flex-wrap items-center gap-3 rounded-md border p-3">
          <Switch :model-value="s.enabled" @update:model-value="(v) => toggle(s, !!v)" />
          <div class="min-w-0 flex-1">
            <div class="font-medium">{{ s.name }}</div>
            <a :href="s.baseUrl" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
              {{ s.baseUrl }} <ExternalLink class="size-3" />
            </a>
            <p v-if="results[s.id]" class="mt-1 text-xs" :class="results[s.id]!.ok ? 'text-muted-foreground' : 'text-destructive'">
              {{ results[s.id]!.text }}
            </p>
          </div>
          <Button v-if="s.searchable" variant="outline" size="sm" @click="test(s)"><Stethoscope class="size-4" /> Test</Button>
        </div>
      </CardContent>
    </Card>

    <p class="text-xs text-muted-foreground">
      Add a site by copying <code>server/src/sources/adapters/_template.ts</code>, setting its <code>kind</code>, and registering it in
      <code>registry.ts</code>.
    </p>
  </div>
</template>
