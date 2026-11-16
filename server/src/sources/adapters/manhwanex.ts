import { createMadaraAdapter } from '../madara.ts';

export const manhwanex = createMadaraAdapter({
  id: 'manhwanex',
  name: 'Manhwanex',
  baseUrl: 'https://manhwanex.com',
  kind: 'aggregator',
  ajaxChapters: true,
  ignoreRobots: true,
  hosts: ['manhwanex.com'],
});
