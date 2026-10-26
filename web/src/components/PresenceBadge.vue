<script setup lang="ts">
import type { AtsuPresence } from '@atsusync/shared';
import { CircleCheck, MessageSquareText, Search } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { tone } from '@/lib/tone';

defineProps<{ presence: AtsuPresence | null }>();
</script>

<template>
  <TooltipProvider v-if="presence && presence.verdict !== 'none'" :delay-duration="150">
    <Tooltip>
      <TooltipTrigger as-child>
        <Badge v-if="presence.verdict === 'on_atsu'" variant="outline" :class="tone('success')">
          <CircleCheck class="size-3" /> On Atsu
        </Badge>
        <Badge v-else-if="presence.verdict === 'claimed'" variant="outline" :class="tone('warning')">
          <MessageSquareText class="size-3" /> Claimed
        </Badge>
        <Badge v-else variant="outline" :class="tone('info')"><Search class="size-3" /> Maybe on Atsu</Badge>
      </TooltipTrigger>
      <TooltipContent class="max-w-xs">
        <p v-if="presence.match">
          {{ presence.match.title }} · {{ presence.match.chapterCount }} ch ·
          {{ Math.round(presence.match.score * 100) }}% match via {{ presence.match.via }}
        </p>
        <p v-for="c in presence.claims.slice(0, 2)" :key="c.commentId">{{ c.user }}: “{{ c.excerpt }}”</p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>
