// Settings screen — appearance (theme) + default behaviors. The theme selector
// is live: it writes the mode through useTheme().setMode, which persists to the
// `settings` table and re-renders the whole app with the new palette. Other
// settings (routing strategy, proxy, default model) are persisted in the
// `settings` table via the reused router; wiring those controls is deferred
// (YAGNI for v1, per MOBILE-PLAN.md).

import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, Switch, ScrollView, Pressable } from 'react-native';

import { useTheme, type ThemeMode } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';

const THEME_OPTIONS: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: 'System' },
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
];

export default function SettingsScreen() {
  const { colors, mode, setMode } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [streamByDefault, setStreamByDefault] = useState(true);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Appearance</Text>
      <Text style={styles.fieldLabel}>Theme</Text>
      <View style={styles.segment}>
        {THEME_OPTIONS.map(opt => {
          const active = mode === opt.mode;
          return (
            <Pressable
              key={opt.mode}
              onPress={() => setMode(opt.mode)}
              style={[styles.segmentItem, active && styles.segmentItemActive]}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{opt.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.fieldHint}>“System” follows your phone’s light/dark setting.</Text>

      <Text style={[styles.sectionTitle, styles.spacer]}>Defaults</Text>
      <Row label="Stream responses" hint="Default chat to streaming" styles={styles}>
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

function Row({
  label,
  hint,
  styles,
  children,
}: {
  label: string;
  hint?: string;
  styles: ReturnType<typeof makeStyles>;
  children: React.ReactNode;
}) {
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

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 16 },
    sectionTitle: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 8,
    },
    spacer: { marginTop: 28 },
    fieldLabel: { fontSize: 15, color: colors.text, marginBottom: 8 },
    fieldHint: { fontSize: 12, color: colors.textFaint, marginTop: 8 },
    segment: {
      flexDirection: 'row',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      overflow: 'hidden',
    },
    segmentItem: {
      flex: 1,
      paddingVertical: 10,
      alignItems: 'center',
      backgroundColor: colors.surface,
    },
    segmentItemActive: { backgroundColor: colors.primary },
    segmentText: { fontSize: 14, color: colors.textStrong, fontWeight: '500' },
    segmentTextActive: { color: colors.onPrimary, fontWeight: '700' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    rowText: { flex: 1, paddingRight: 12 },
    rowLabel: { fontSize: 15, color: colors.text },
    rowHint: { fontSize: 12, color: colors.textFaint, marginTop: 2 },
    aboutCard: { backgroundColor: colors.surfaceAlt, borderRadius: 12, padding: 14 },
    aboutText: { fontSize: 13, color: colors.textMuted, lineHeight: 19 },
  });
}
