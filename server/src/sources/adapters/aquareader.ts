import { createMadaraAdapter } from '../madara.ts';

export const aquareader = createMadaraAdapter({
  id: 'aquareader',
  name: 'Aqua Manga',
  baseUrl: 'https://aquareader.org',
  kind: 'aggregator',
  ajaxChapters: true,
  hosts: ['aquareader.org'],
});
