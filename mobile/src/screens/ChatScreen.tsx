// Chat screen — the app's main surface. A message list + an input box. On send,
// it streams tokens from the in-process bridge (streamComplete), which routes
// through the reused upstream router + provider fallback.

import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import type { ChatMessage } from '../../../shared/types';
import { streamComplete, type RoutedVia } from '../core/bridge';

interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  routedVia?: RoutedVia;
  error?: boolean;
}

function toChatMessages(history: UiMessage[]): ChatMessage[] {
  return history
    .filter(m => m.text.length > 0 && !m.error)
    .map(m => ({ role: m.role, content: m.text }));
}

export default function ChatScreen() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<UiMessage>>(null);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: UiMessage = { id: `u-${Date.now()}`, role: 'user', text };
    const assistantId = `a-${Date.now()}`;
    const assistantMsg: UiMessage = { id: assistantId, role: 'assistant', text: '' };

    // Build the outbound history BEFORE appending the empty assistant turn.
    const outbound = toChatMessages([...messages, userMsg]);

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInput('');
    setSending(true);
    scrollToEnd();

    const patch = (fn: (m: UiMessage) => UiMessage) =>
      setMessages(prev => prev.map(m => (m.id === assistantId ? fn(m) : m)));

    try {
      for await (const ev of streamComplete(outbound, { model: 'auto' })) {
        if (ev.routedVia) {
          patch(m => ({ ...m, routedVia: ev.routedVia }));
        }
        if (ev.delta) {
          patch(m => ({ ...m, text: m.text + ev.delta }));
          scrollToEnd();
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      patch(m => ({
        ...m,
        error: true,
        text: m.text.length > 0 ? m.text : `Error: ${msg}`,
      }));
    } finally {
      setSending(false);
      scrollToEnd();
    }
  }, [input, sending, messages, scrollToEnd]);

  const renderItem = useCallback(({ item }: { item: UiMessage }) => {
    const isUser = item.role === 'user';
    return (
      <View style={[styles.bubbleRow, isUser ? styles.rowUser : styles.rowAssistant]}>
        <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble, item.error && styles.errorBubble]}>
          {item.text.length === 0 ? (
            <ActivityIndicator size="small" />
          ) : (
            <Text style={[styles.bubbleText, isUser && styles.userText]}>{item.text}</Text>
          )}
          {item.routedVia && (
            <Text style={styles.meta}>
              {item.routedVia.displayName}
              {item.routedVia.attempts > 0 ? `  ·  fell back ${item.routedVia.attempts}×` : ''}
            </Text>
          )}
        </View>
      </View>
    );
  }, []);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={m => m.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>Start a conversation.</Text>
            <Text style={styles.emptySub}>Routed automatically across your stacked free tiers.</Text>
          </View>
        }
      />
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Message"
          placeholderTextColor="#9ca3af"
          multiline
          editable={!sending}
          onSubmitEditing={send}
        />
        <Pressable
          style={[styles.sendBtn, (sending || input.trim().length === 0) && styles.sendBtnDisabled]}
          onPress={send}
          disabled={sending || input.trim().length === 0}
        >
          <Text style={styles.sendText}>{sending ? '…' : 'Send'}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  list: { padding: 12, flexGrow: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyText: { fontSize: 16, fontWeight: '600', color: '#374151' },
  emptySub: { fontSize: 13, color: '#9ca3af', marginTop: 6, textAlign: 'center', paddingHorizontal: 24 },
  bubbleRow: { marginVertical: 4, flexDirection: 'row' },
  rowUser: { justifyContent: 'flex-end' },
  rowAssistant: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '82%', borderRadius: 16, paddingVertical: 8, paddingHorizontal: 12 },
  userBubble: { backgroundColor: '#2563eb', borderBottomRightRadius: 4 },
  assistantBubble: { backgroundColor: '#f3f4f6', borderBottomLeftRadius: 4 },
  errorBubble: { backgroundColor: '#fee2e2' },
  bubbleText: { fontSize: 15, color: '#111827', lineHeight: 21 },
  userText: { color: '#ffffff' },
  meta: { fontSize: 11, color: '#6b7280', marginTop: 6 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e5e7eb',
    backgroundColor: '#ffffff',
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 40,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 15,
    color: '#111827',
  },
  sendBtn: {
    marginLeft: 8,
    backgroundColor: '#2563eb',
    borderRadius: 20,
    paddingHorizontal: 18,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: '#93c5fd' },
  sendText: { color: '#ffffff', fontWeight: '600', fontSize: 15 },
});
