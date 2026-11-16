<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(
  defineProps<{
    kind: 'error' | 'ok' | 'warn';
    message: string;
    dismissible?: boolean;
    variant?: 'toast' | 'inline';
    prefix?: 'as' | 'sp';
  }>(),
  {
    dismissible: false,
    variant: 'inline',
    prefix: 'as',
  },
);

const emit = defineEmits<{ dismiss: [] }>();

const rootClass = computed(() => [
  `${props.prefix}-alert`,
  props.kind,
  props.variant === 'toast' ? `${props.prefix}-alert-toast` : `${props.prefix}-alert-inline`,
]);
</script>

<template>
  <div :class="rootClass" :role="kind === 'error' ? 'alert' : 'status'">
    <span :class="`${prefix}-alert-msg`">{{ message }}</span>
    <button
      v-if="dismissible"
      type="button"
      :class="`${prefix}-alert-close`"
      title="Dismiss"
      aria-label="Dismiss"
      @click="emit('dismiss')"
    >
      <Icon name="x" />
    </button>
  </div>
</template>
