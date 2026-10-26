export type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONES: Record<Tone, string> = {
  primary: 'border-primary/40 bg-primary/10 text-primary',
  success: 'border-success/40 bg-success/10 text-success',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  danger: 'border-destructive/40 bg-destructive/10 text-destructive',
  info: 'border-info/40 bg-info/10 text-info',
  neutral: 'text-muted-foreground',
};

/** Classes for a soft, colored outline badge. */
export const tone = (t: Tone) => TONES[t];
