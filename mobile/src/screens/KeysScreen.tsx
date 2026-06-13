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
// Imported by RELATIVE path so Metro resolves them via watchFolders. The Metro
// custom resolver (mobile/metro.config.js) then redirects the upstream modules'
// OWN internal imports of `../db/index.js` and `../lib/crypto.js` to the mobile
// adapters — so getDb/encrypt/decrypt/maskKey below come from the keystore- and
// expo-sqlite-backed shims, not Node crypto / better-sqlite3.
import { getDb } from '../../../server/src/db/index';
import { encrypt, decrypt, maskKey } from '../../../server/src/lib/crypto';
import { getAllProviders } from '../../../server/src/providers/index';

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
  const qc = useQueryClient();
  const providers = useMemo(listProviders, []);
  const [selected, setSelected] = useState<ProviderPlatform>(providers[0]?.platform ?? 'groq');
  const [keyInput, setKeyInput] = useState('');

  const keysQuery = useQuery({ queryKey: KEYS_QUERY, queryFn: listKeys });

  const addKey = useMutation({
    mutationFn: async ({ platform, key }: { platform: ProviderPlatform; key: string }) => {
      const db = getDb();
      // keystore-backed encrypt → reference triple; plaintext never hits SQLite.
      const { encrypted, iv, authTag } = encrypt(key);
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
      getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS_QUERY }),
  });

  const onAdd = () => {
    const key = keyInput.trim();
    if (!key) return;
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
          placeholder={`${providerName(selected)} API key`}
          placeholderTextColor="#9ca3af"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <Pressable
          style={[styles.addBtn, (addKey.isPending || keyInput.trim().length === 0) && styles.addBtnDisabled]}
          onPress={onAdd}
          disabled={addKey.isPending || keyInput.trim().length === 0}
        >
          <Text style={styles.addBtnText}>{addKey.isPending ? '…' : 'Add'}</Text>
        </Pressable>
      </View>

      <Text style={[styles.sectionTitle, styles.spacer]}>Your keys</Text>

      {keysQuery.isLoading ? (
        <ActivityIndicator style={{ marginTop: 24 }} />
      ) : keysQuery.isError ? (
        <Text style={styles.errorText}>
          Failed to load keys: {(keysQuery.error as Error)?.message}
        </Text>
      ) : (keysQuery.data?.length ?? 0) === 0 ? (
        <Text style={styles.emptyText}>No keys yet. Add one above to start routing.</Text>
      ) : (
        keysQuery.data!.map(row => (
          <View key={row.id} style={styles.keyCard}>
            <View style={styles.keyCardMain}>
              <Text style={styles.keyPlatform}>{providerName(row.platform)}</Text>
              <Text style={styles.keyMasked}>{masked(row)}</Text>
              <View style={styles.statusRow}>
                <View style={[styles.statusDot, statusStyle(row.status)]} />
                <Text style={styles.statusText}>{row.status}</Text>
              </View>
            </View>
            <View style={styles.keyCardActions}>
              <Switch
                value={row.enabled === 1}
                onValueChange={v => toggleKey.mutate({ id: row.id, enabled: v })}
              />
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

function statusStyle(status: string) {
  switch (status) {
    case 'healthy':
      return { backgroundColor: '#16a34a' };
    case 'rate_limited':
      return { backgroundColor: '#f59e0b' };
    case 'invalid':
    case 'error':
      return { backgroundColor: '#dc2626' };
    default:
      return { backgroundColor: '#9ca3af' };
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  content: { padding: 16 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 },
  spacer: { marginTop: 28 },
  providerGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12, marginBottom: 12 },
  chip: {
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: '#f3f4f6',
    margin: 4,
  },
  chipSelected: { backgroundColor: '#2563eb' },
  chipText: { fontSize: 13, color: '#374151' },
  chipTextSelected: { color: '#ffffff', fontWeight: '600' },
  addRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 44,
    fontSize: 15,
    color: '#111827',
  },
  addBtn: {
    marginLeft: 8,
    backgroundColor: '#2563eb',
    borderRadius: 10,
    paddingHorizontal: 18,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnDisabled: { backgroundColor: '#93c5fd' },
  addBtnText: { color: '#ffffff', fontWeight: '600', fontSize: 15 },
  emptyText: { color: '#9ca3af', marginTop: 16, fontSize: 14 },
  errorText: { color: '#dc2626', marginTop: 16, fontSize: 14 },
  keyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    padding: 14,
    marginTop: 10,
  },
  keyCardMain: { flex: 1 },
  keyPlatform: { fontSize: 15, fontWeight: '600', color: '#111827' },
  keyMasked: { fontSize: 13, color: '#6b7280', marginTop: 2, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  statusText: { fontSize: 12, color: '#6b7280' },
  keyCardActions: { alignItems: 'center', marginLeft: 12 },
  deleteText: { color: '#dc2626', fontSize: 12, marginTop: 10 },
});
