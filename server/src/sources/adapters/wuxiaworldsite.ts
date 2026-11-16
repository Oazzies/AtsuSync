import { createMadaraAdapter } from '../madara.ts';

export const wuxiaworldsite = createMadaraAdapter({
  id: 'wuxiaworldsite',
  name: 'Wuxiaworld.site',
  baseUrl: 'https://wuxiaworld.site',
  kind: 'aggregator',
  medium: 'novel',
  hosts: ['wuxiaworld.site'],
});
