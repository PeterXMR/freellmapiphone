// App root: theme provider + DB bootstrap + TanStack Query provider + bottom-tab
// navigation between the three screens (Chat / Keys / Settings).
//
// The streaming-fetch install and DB init both happen through the bridge:
//   - importing the bridge runs `import './fetch'` (installs expo/fetch globally);
//   - db.init() runs the upstream migrations against expo-sqlite once on mount.
//
// ThemeProvider wraps everything (including the loading/error states) so the
// whole app — nav chrome, tab bar, status bar — flips with the active palette.

import 'react-native-gesture-handler';
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  NavigationContainer,
  DefaultTheme,
  DarkTheme,
  type Theme,
} from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { db } from './src/core/bridge';
import { ThemeProvider, useTheme } from './src/theme/ThemeProvider';
import type { ColorScheme, Palette } from './src/theme/palette';
import ChatScreen from './src/screens/ChatScreen';
import KeysScreen from './src/screens/KeysScreen';
import SettingsScreen from './src/screens/SettingsScreen';

const Tab = createBottomTabNavigator();
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

// Map our palette onto React Navigation's theme contract so the header, tab bar,
// and screen backgrounds all derive from one source.
function navigationTheme(colors: Palette, scheme: ColorScheme): Theme {
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  return {
    ...base,
    dark: scheme === 'dark',
    colors: {
      ...base.colors,
      primary: colors.primary,
      background: colors.bg,
      card: colors.bg,
      text: colors.text,
      border: colors.border,
      notification: colors.danger,
    },
  };
}

function AppInner() {
  const { colors, scheme } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const navTheme = useMemo(() => navigationTheme(colors, scheme), [colors, scheme]);
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    try {
      db.init(); // idempotent — runs upstream migrations on expo-sqlite once.
      setReady(true);
    } catch (err: unknown) {
      setInitError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  if (initError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errTitle}>Database failed to initialize</Text>
        <Text style={styles.errBody}>{initError}</Text>
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      </View>
    );
  }

  if (!ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      </View>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <NavigationContainer theme={navTheme}>
        <Tab.Navigator
          screenOptions={{
            headerTitleAlign: 'center',
            tabBarActiveTintColor: colors.primary,
            tabBarInactiveTintColor: colors.textFaint,
            // Labels-only tab bar: hide the icon slot so React Navigation does NOT
            // render its default "missing icon" placeholder (the box-with-X), and
            // the label centers vertically.
            tabBarIconStyle: { display: 'none' },
            tabBarLabelStyle: { fontSize: 13 },
          }}
        >
          <Tab.Screen name="Chat" component={ChatScreen} />
          <Tab.Screen name="Keys" component={KeysScreen} />
          <Tab.Screen name="Settings" component={SettingsScreen} />
        </Tab.Navigator>
      </NavigationContainer>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
    </QueryClientProvider>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: colors.bg },
    errTitle: { fontSize: 16, fontWeight: '700', color: colors.danger, marginBottom: 8 },
    errBody: { fontSize: 13, color: colors.textMuted, textAlign: 'center' },
  });
}
