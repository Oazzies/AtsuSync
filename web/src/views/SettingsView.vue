<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { toast } from 'vue-sonner';
import { CircleCheck, CircleAlert } from '@/icons';
import type { SettingsView } from '@atsusync/shared';
import { api } from '@/api/client';
import PageHeader from '@/components/PageHeader.vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { tone } from '@/lib/tone';

const emit = defineEmits<{ changed: [] }>();
const s = ref<SettingsView | null>(null);
const cookie = ref('');
const saving = ref(false);

const INTERVALS = [15, 30, 60, 120, 360, 720, 1440];
const fmtInterval = (m: number) => (m < 60 ? `${m} min` : `${m / 60} h`);

async function load() {
  s.value = await api.settings();
}

async function save() {
  if (!s.value) return;
  saving.value = true;
  try {
    s.value = await api.saveSettings({
      defaultCheckIntervalMin: Number(s.value.defaultCheckIntervalMin),
      ...(cookie.value.trim() ? { atsuCookie: cookie.value.trim() } : {}),
    });
    cookie.value = '';
    await load();
    toast.success('Settings saved');
    emit('changed');
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    saving.value = false;
  }
}

async function clearCookie() {
  s.value = await api.saveSettings({ atsuCookie: '' });
  emit('changed');
}

onMounted(load);
</script>

<template>
  <div v-if="s" class="max-w-2xl space-y-6">
    <PageHeader title="Settings" />

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          Atsumaru session
          <Badge v-if="s.atsuUser" variant="outline" :class="tone('success')"><CircleCheck class="size-3" /> {{ s.atsuUser }}</Badge>
          <Badge v-else-if="s.atsuCookieSet" variant="outline" :class="tone('danger')"><CircleAlert class="size-3" /> Cookie rejected</Badge>
          <Badge v-else variant="outline" :class="tone('warning')">Not set</Badge>
        </CardTitle>
        <CardDescription>
          On atsu.moe press F12 → Network, refresh, click any <code>/api/</code> request and copy the whole <code>cookie</code> request
          header. It's stored only in the local database.
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-2">
        <Textarea v-model="cookie" rows="3" placeholder="Paste cookie header…" class="font-mono text-xs" />
        <Button v-if="s.atsuCookieSet" variant="ghost" size="sm" class="text-destructive" @click="clearCookie">Clear saved cookie</Button>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Defaults</CardTitle>
        <CardDescription>
          Chapters are downloaded as ZIPs (EPUBs for novels); you upload them yourself on atsu.moe. AtsuSync never submits anything for you.
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-5">
        <div class="space-y-1.5">
          <Label>Default check interval for new links</Label>
          <Select :model-value="String(s.defaultCheckIntervalMin)" @update:model-value="(v) => (s!.defaultCheckIntervalMin = Number(v))">
            <SelectTrigger class="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="m in INTERVALS" :key="m" :value="String(m)">{{ fmtInterval(m) }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardContent>
      <CardFooter>
        <Button :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save' }}</Button>
      </CardFooter>
    </Card>
  </div>
</template>
