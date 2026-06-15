// Keys screen — list providers, add an API key, enable/disable, show the masked
// key + status.
//
// Adding a key mirrors the server's POST /api/keys flow (server/src/routes/keys.ts):
//   const { encrypted, iv, authTag } = encrypt(plainKey);   // keystore-backed on device
//   INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) ...
// On device, `encrypt` is the crypto-shim (Metro aliases ../lib/crypto.js to it):
// it stashes the secret in the Android Keystore and returns a REFERENCE triple,
// so plaintext keys never touch SQLite.

import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import type { Platform as ProviderPlatform } from '../../../shared/types';
// Mobile code imports the mobile adapters DIRECTLY. The Metro redirect in
// mobile/metro.config.js is scoped to imports originating inside upstream
// server/src files; it exists so upstream modules' internal `../db/index.js` /
// `../lib/crypto.js` imports resolve to these same shims without editing
// upstream source. Either path yields the same module instance.
import { getDb } from '../adapters/sqlite/db-shim';
import { encrypt, decrypt, maskKey, forgetSecret } from '../adapters/keystore/crypto-shim';
import { getAllProviders } from '../../../server/src/providers/index';
// Reuse the upstream health service: checkKeyHealth decrypts the key (crypto-shim),
// calls provider.validateKey() over global fetch (expo/fetch), and writes status +
// last_checked_at back to api_keys through the sqlite facade — matching the web
// dashboard's POST /api/health/check/:id.
import { checkKeyHealth } from '../../../server/src/services/health';
import { useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';

interface KeyRow {
  id: number;
  platform: string;
  label: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
}

interface ProviderInfo {
  platform: ProviderPlatform;
  name: string;
  keyless: boolean;
}

const KEYS_QUERY = ['api_keys'];

function listProviders(): ProviderInfo[] {
  return getAllProviders()
    .filter(p => p.platform !== 'custom')
    .map(p => ({ platform: p.platform, name: p.name, keyless: p.keyless }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listKeys(): KeyRow[] {
  const db = getDb();
  return db
    .prepare(
      'SELECT id, platform, label, encrypted_key, iv, auth_tag, status, enabled FROM api_keys ORDER BY created_at DESC',
    )
    .all() as KeyRow[];
}

export default function KeysScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();
  const providers = useMemo(listProviders, []);
  const [selected, setSelected] = useState<ProviderPlatform>(providers[0]?.platform ?? 'groq');
  const [keyInput, setKeyInput] = useState('');

  const keysQuery = useQuery({ queryKey: KEYS_QUERY, queryFn: listKeys });

  const addKey = useMutation({
    mutationFn: async ({ platform, key }: { platform: ProviderPlatform; key: string }) => {
      const db = getDb();
      const isKeyless = providers.find(p => p.platform === platform)?.keyless === true;
      // Keyless providers (Kilo anon, Pollinations, …) store a sentinel so
      // routing sees the platform as configured; the provider omits the auth
      // header on outgoing calls. Mirrors server/src/routes/keys.ts POST /.
      const keyToStore = isKeyless ? (key || 'no-key') : key;

      // A keyless provider needs only one sentinel row — re-enable an existing
      // one instead of piling up duplicates each time the user taps "Add".
      if (isKeyless) {
        const existing = db
          .prepare('SELECT id FROM api_keys WHERE platform = ? LIMIT 1')
          .get(platform) as { id: number } | undefined;
        if (existing) {
          db.prepare("UPDATE api_keys SET enabled = 1, status = 'unknown' WHERE id = ?").run(existing.id);
          return;
        }
      }

      // keystore-backed encrypt → reference triple; plaintext never hits SQLite.
      const { encrypted, iv, authTag } = encrypt(keyToStore);
      db.prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
         VALUES (?, '', ?, ?, ?, 'unknown', 1)`,
      ).run(platform, encrypted, iv, authTag);
    },
    onSuccess: () => {
      setKeyInput('');
      qc.invalidateQueries({ queryKey: KEYS_QUERY });
    },
    onError: (err: unknown) => {
      Alert.alert('Could not add key', err instanceof Error ? err.message : String(err));
    },
  });

  const toggleKey = useMutation({
    mutationFn: async ({ id, enabled }: { id: number; enabled: boolean }) => {
      getDb().prepare('UPDATE api_keys SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS_QUERY }),
  });

  const deleteKey = useMutation({
    mutationFn: async (id: number) => {
      const db = getDb();
      // The row's encrypted_key holds the Keystore REFERENCE — resolve it
      // before the row (the only holder of the ref) disappears, then evict the
      // secret so it doesn't linger in the Android Keystore as an orphan.
      const row = db
        .prepare('SELECT encrypted_key FROM api_keys WHERE id = ?')
        .get(id) as { encrypted_key: string } | undefined;
      db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
      if (row?.encrypted_key) forgetSecret(row.encrypted_key);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS_QUERY }),
  });

  // Test a key: runs the upstream health check (validateKey) in-process, which
  // updates status + last_checked_at; refresh the list so the dot/label reflect it.
  const checkKey = useMutation({
    mutationFn: (id: number) => checkKeyHealth(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS_QUERY }),
    onError: (err: unknown) => {
      Alert.alert('Could not test key', err instanceof Error ? err.message : String(err));
    },
  });

  const selectedIsKeyless = providers.find(p => p.platform === selected)?.keyless === true;

  const onAdd = () => {
    const key = keyInput.trim();
    if (!key && !selectedIsKeyless) return;
    addKey.mutate({ platform: selected, key });
  };

  const masked = (row: KeyRow): string => {
    try {
      // decrypt resolves the keystore reference back to the secret, then masks.
      return maskKey(decrypt(row.encrypted_key, row.iv, row.auth_tag));
    } catch {
      return '••••  (unreadable)';
    }
  };

  const providerName = (platform: string) =>
    providers.find(p => p.platform === platform)?.name ?? platform;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Add a key</Text>

      <View style={styles.providerGrid}>
        {providers.map(p => (
          <Pressable
            key={p.platform}
            onPress={() => setSelected(p.platform)}
            style={[styles.chip, selected === p.platform && styles.chipSelected]}
          >
            <Text style={[styles.chipText, selected === p.platform && styles.chipTextSelected]}>
              {p.name}
              {p.keyless ? '  (keyless)' : ''}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.addRow}>
        <TextInput
          style={styles.input}
          value={keyInput}
          onChangeText={setKeyInput}
          placeholder={
            selectedIsKeyless
              ? `${providerName(selected)} — no key needed, just tap Add`
              : `${providerName(selected)} API key`
          }
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <Pressable
          style={[
            styles.addBtn,
            (addKey.isPending || (!selectedIsKeyless && keyInput.trim().length === 0)) && styles.addBtnDisabled,
          ]}
          onPress={onAdd}
          disabled={addKey.isPending || (!selectedIsKeyless && keyInput.trim().length === 0)}
        >
          <Text style={styles.addBtnText}>{addKey.isPending ? '…' : 'Add'}</Text>
        </Pressable>
      </View>

      <Text style={[styles.sectionTitle, styles.spacer]}>Your keys</Text>

      {keysQuery.isLoading ? (
        <ActivityIndicator style={{ marginTop: 24 }} color={colors.textMuted} />
      ) : keysQuery.isError ? (
        <Text style={styles.errorText}>
          Failed to load keys: {(keysQuery.error as Error)?.message}
        </Text>
      ) : (keysQuery.data?.length ?? 0) === 0 ? (
        <Text style={styles.emptyText}>No keys yet. Add one above to start routing.</Text>
      ) : (
        keysQuery.data!.map(row => (
          <View key={row.id} style={styles.keyCard}>
            <View>
              <Text style={styles.keyPlatform}>{providerName(row.platform)}</Text>
              <Text style={styles.keyMasked}>{masked(row)}</Text>
              <View style={styles.statusRow}>
                <View style={[styles.statusDot, { backgroundColor: statusColor(row.status, colors) }]} />
                <Text style={styles.statusText}>{row.status}</Text>
              </View>
            </View>
            <View style={styles.keyCardActions}>
              <Switch
                value={row.enabled === 1}
                onValueChange={v => toggleKey.mutate({ id: row.id, enabled: v })}
              />
              <Pressable
                onPress={() => checkKey.mutate(row.id)}
                disabled={checkKey.isPending && checkKey.variables === row.id}
                hitSlop={8}
              >
                {checkKey.isPending && checkKey.variables === row.id ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Text style={styles.testText}>Test</Text>
                )}
              </Pressable>
              <Pressable onPress={() => deleteKey.mutate(row.id)} hitSlop={8}>
                <Text style={styles.deleteText}>Delete</Text>
              </Pressable>
            </View>
          </View>
        ))
      )}
    </ScrollView>
  );
}

function statusColor(status: string, colors: Palette): string {
  switch (status) {
    case 'healthy':
      return colors.success;
    case 'rate_limited':
      return colors.warning;
    case 'invalid':
    case 'error':
      return colors.danger;
    default:
      return colors.textFaint;
  }
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 16 },
    sectionTitle: { fontSize: 13, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
    spacer: { marginTop: 28 },
    providerGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12, marginBottom: 12 },
    chip: {
      paddingVertical: 7,
      paddingHorizontal: 12,
      borderRadius: 16,
      backgroundColor: colors.surface,
      margin: 4,
    },
    chipSelected: { backgroundColor: colors.primary },
    chipText: { fontSize: 13, color: colors.textStrong },
    chipTextSelected: { color: colors.onPrimary, fontWeight: '600' },
    addRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
    input: {
      flex: 1,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: 10,
      paddingHorizontal: 12,
      height: 44,
      fontSize: 15,
      color: colors.text,
    },
    addBtn: {
      marginLeft: 8,
      backgroundColor: colors.primary,
      borderRadius: 10,
      paddingHorizontal: 18,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    addBtnDisabled: { backgroundColor: colors.primaryDisabled },
    addBtnText: { color: colors.onPrimary, fontWeight: '600', fontSize: 15 },
    emptyText: { color: colors.textFaint, marginTop: 16, fontSize: 14 },
    errorText: { color: colors.danger, marginTop: 16, fontSize: 14 },
    keyCard: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      padding: 14,
      marginTop: 10,
    },
    keyPlatform: { fontSize: 15, fontWeight: '600', color: colors.text },
    keyMasked: { fontSize: 13, color: colors.textMuted, marginTop: 2, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
    statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
    statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
    statusText: { fontSize: 12, color: colors.textMuted },
    // Switch → Test → Delete in one horizontal row below the key info, spaced out
    // with a divider above so each control is an easy, separate tap target.
    keyCardActions: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 14,
      paddingTop: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      gap: 28,
    },
    testText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
    deleteText: { color: colors.danger, fontSize: 15, fontWeight: '600' },
  });
}
