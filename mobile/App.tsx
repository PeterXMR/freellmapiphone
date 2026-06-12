// App root: DB bootstrap + TanStack Query provider + bottom-tab navigation
// between the three screens (Chat / Keys / Settings).
//
// The streaming-fetch install and DB init both happen through the bridge:
//   - importing the bridge runs `import './fetch'` (installs expo/fetch globally);
//   - db.init() runs the upstream migrations against expo-sqlite once on mount.

import 'react-native-gesture-handler';
import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { db } from './src/core/bridge';
import ChatScreen from './src/screens/ChatScreen';
import KeysScreen from './src/screens/KeysScreen';
import SettingsScreen from './src/screens/SettingsScreen';

const Tab = createBottomTabNavigator();
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

export default function App() {
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
        <StatusBar style="auto" />
      </View>
    );
  }

  if (!ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <StatusBar style="auto" />
      </View>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <NavigationContainer>
        <Tab.Navigator screenOptions={{ headerTitleAlign: 'center' }}>
          <Tab.Screen name="Chat" component={ChatScreen} />
          <Tab.Screen name="Keys" component={KeysScreen} />
          <Tab.Screen name="Settings" component={SettingsScreen} />
        </Tab.Navigator>
      </NavigationContainer>
      <StatusBar style="auto" />
    </QueryClientProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#ffffff' },
  errTitle: { fontSize: 16, fontWeight: '700', color: '#dc2626', marginBottom: 8 },
  errBody: { fontSize: 13, color: '#6b7280', textAlign: 'center' },
});
