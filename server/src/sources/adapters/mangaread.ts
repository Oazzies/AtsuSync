import { createMadaraAdapter } from '../madara.ts';

export const mangaread = createMadaraAdapter({
  id: 'mangaread',
  name: 'MangaRead',
  baseUrl: 'https://www.mangaread.org',
  kind: 'aggregator',
  hosts: ['mangaread.org'],
});
