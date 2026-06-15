// Theme context: resolves the user's mode preference + the OS color scheme into
// the active palette, and exposes a setter that persists the override.
//
//   mode    — what the user picked: 'system' | 'light' | 'dark' (persisted in the
//             `settings` table under THEME_KEY).
//   scheme  — the RESOLVED scheme actually in effect ('light' | 'dark'): the OS
//             scheme when mode === 'system', otherwise the forced mode.
//   colors  — the palette for `scheme`.
//
// Consumers use useTheme(); screens turn `colors` into a memoized StyleSheet via
// a makeStyles(colors) factory.

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';

import { palettes, type ColorScheme, type Palette } from './palette';
import { getSetting, setSetting } from '../core/settings';

export type ThemeMode = 'system' | 'light' | 'dark';

const THEME_KEY = 'theme_preference';

function readStoredMode(): ThemeMode {
  const stored = getSetting(THEME_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

interface ThemeContextValue {
  mode: ThemeMode;
  scheme: ColorScheme;
  colors: Palette;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    setSetting(THEME_KEY, next);
  }, []);

  const scheme: ColorScheme = mode === 'system' ? (systemScheme ?? 'light') : mode;
  const colors = palettes[scheme];

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, scheme, colors, setMode }),
    [mode, scheme, colors, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>');
  return ctx;
}
