// Settings screen — minimal placeholder for theme / default behaviors. Real
// settings (routing strategy, proxy, default model) are persisted in the
// `settings` table via the upstream getSetting/setSetting helpers; wiring those
// controls is deferred (YAGNI for v1, per MOBILE-PLAN.md).

import React, { useState } from 'react';
import { View, Text, StyleSheet, Switch, ScrollView } from 'react-native';

export default function SettingsScreen() {
  const [darkMode, setDarkMode] = useState(false);
  const [streamByDefault, setStreamByDefault] = useState(true);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Appearance</Text>
      <Row label="Dark mode" hint="Placeholder — theming not yet wired">
        <Switch value={darkMode} onValueChange={setDarkMode} />
      </Row>

      <Text style={[styles.sectionTitle, styles.spacer]}>Defaults</Text>
      <Row label="Stream responses" hint="Default chat to streaming">
        <Switch value={streamByDefault} onValueChange={setStreamByDefault} />
      </Row>

      <Text style={[styles.sectionTitle, styles.spacer]}>About</Text>
      <View style={styles.aboutCard}>
        <Text style={styles.aboutText}>
          Chat is powered by your stacked free-tier API keys, routed on-device via the
          reused freellmapi router. Keys live in the Android Keystore and never leave
          your phone.
        </Text>
      </View>
    </ScrollView>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  content: { padding: 16 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  spacer: { marginTop: 28 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  rowText: { flex: 1, paddingRight: 12 },
  rowLabel: { fontSize: 15, color: '#111827' },
  rowHint: { fontSize: 12, color: '#9ca3af', marginTop: 2 },
  aboutCard: { backgroundColor: '#f9fafb', borderRadius: 12, padding: 14 },
  aboutText: { fontSize: 13, color: '#6b7280', lineHeight: 19 },
});
