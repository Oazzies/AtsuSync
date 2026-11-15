export type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

// Solid, white-text tag colors, taken from atsu.moe's type/rating chips.
const TONES: Record<Tone, string> = {
  primary: 'bg-[#6f5fc4] text-white',
  success: 'bg-[#209928] text-white',
  warning: 'bg-[#805e03] text-white',
  danger: 'bg-[#9f0712] text-white',
  info: 'bg-[#038cfc] text-white',
  neutral: 'bg-[#47484a] text-foreground2',
};

/** Classes for an atsu.moe style solid tag. */
export const tone = (t: Tone) => TONES[t];

// Content-type chip colors, as shown on atsu.moe's cover cards.
const TYPE_TONES: Record<string, string> = {
  manhwa: 'bg-[#038cfc] text-white',
  manga: 'bg-[#7d5fd6] text-white',
  manhua: 'bg-[#d6541f] text-white',
  comic: 'bg-[#c0267a] text-white',
  novel: 'bg-[#0f8f7a] text-white',
};
export const typeTone = (name: string) => TYPE_TONES[name.toLowerCase()] ?? TONES.neutral;
