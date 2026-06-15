// Semantic color tokens for the app's two themes.
//
// Every screen consumes these tokens (via useTheme().colors) instead of raw hex,
// so switching light/dark is a single palette swap. The `light` palette is the
// app's original hardcoded colors verbatim; `dark` is their counterpart tuned for
// contrast on a near-black background.

export interface Palette {
  /** Screen background. */
  bg: string;
  /** Cards / chips / assistant bubble — one step off the background. */
  surface: string;
  /** A subtler raised surface (e.g. the About card). */
  surfaceAlt: string;
  /** Hairlines and card borders. */
  border: string;
  /** Stronger borders (text inputs). */
  borderStrong: string;
  /** Primary body text. */
  text: string;
  /** Emphasis text on muted surfaces (empty-state heading, chip label). */
  textStrong: string;
  /** Secondary text (section titles, hints, metadata). */
  textMuted: string;
  /** Faint text (placeholders, disabled hints). */
  textFaint: string;
  /** Brand / action color (buttons, user bubble, selected chip). */
  primary: string;
  /** Primary in its disabled state. */
  primaryDisabled: string;
  /** Text/icon drawn on top of `primary`. */
  onPrimary: string;
  /** Healthy / success status. */
  success: string;
  /** Rate-limited / warning status. */
  warning: string;
  /** Error text, destructive actions, error status. */
  danger: string;
  /** Error surface (error bubble, error banner background). */
  dangerBg: string;
}

export const light: Palette = {
  bg: '#ffffff',
  surface: '#f3f4f6',
  surfaceAlt: '#f9fafb',
  border: '#e5e7eb',
  borderStrong: '#d1d5db',
  text: '#111827',
  textStrong: '#374151',
  textMuted: '#6b7280',
  textFaint: '#9ca3af',
  primary: '#2563eb',
  primaryDisabled: '#93c5fd',
  onPrimary: '#ffffff',
  success: '#16a34a',
  warning: '#f59e0b',
  danger: '#dc2626',
  dangerBg: '#fee2e2',
};

export const dark: Palette = {
  bg: '#0b0f17',
  surface: '#1f2530',
  surfaceAlt: '#161b24',
  border: '#2a313d',
  borderStrong: '#3a4250',
  text: '#f3f4f6',
  textStrong: '#e5e7eb',
  textMuted: '#9aa4b2',
  textFaint: '#6b7280',
  primary: '#3b82f6',
  primaryDisabled: '#1e3a5f',
  onPrimary: '#ffffff',
  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#f87171',
  dangerBg: '#3b1d1d',
};

export type ColorScheme = 'light' | 'dark';

export const palettes: Record<ColorScheme, Palette> = { light, dark };
