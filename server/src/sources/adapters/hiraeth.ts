import { createMadaraAdapter } from '../madara.ts';

export const hiraeth = createMadaraAdapter({
  id: 'hiraeth',
  name: 'Hiraeth Translation',
  baseUrl: 'https://hiraethtranslation.com',
  kind: 'scanlation',
  medium: 'novel',
  hosts: ['hiraethtranslation.com'],
});
