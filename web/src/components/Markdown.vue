<script setup lang="ts">
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';

const props = defineProps<{ source: string }>();

// Raw HTML stays disabled: forum content is untrusted and markdown-it escapes it.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const defaultLink = md.renderer.rules.link_open ?? ((tokens, i, opts, _env, self) => self.renderToken(tokens, i, opts));
md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
  tokens[i]!.attrSet('target', '_blank');
  tokens[i]!.attrSet('rel', 'noopener noreferrer');
  return defaultLink(tokens, i, opts, env, self);
};

const html = computed(() => md.render(props.source ?? ''));
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- markdown-it output with html: false -->
  <div class="prose-atsu" v-html="html" />
</template>
