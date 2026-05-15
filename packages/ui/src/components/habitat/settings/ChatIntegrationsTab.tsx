import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChatIntegrationForm } from './ChatIntegrationForm.js';
import { ChatIntegrationList } from './ChatIntegrationList.js';
import { api } from '../../../api/index.js';
import { notify } from '../../../lib/toast.js';
import { useChatIntegrations } from '../../../lib/useHabitatData.js';
import { queryKeys } from '../../../lib/queryKeys.js';
import type { ChatIntegration } from '../../../types/index.js';

interface ChatIntegrationsTabProps {
  boardId: string;
}

export function ChatIntegrationsTab({ boardId }: ChatIntegrationsTabProps) {
  const { data: chatIntegrations = [], isLoading: chatLoading } = useChatIntegrations(boardId);
  const [chatSaving, setChatSaving] = useState(false);
  const [chatFormOpen, setChatFormOpen] = useState(false);
  const [chatEditIntegration, setChatEditIntegration] = useState<ChatIntegration | null>(null);
  const [chatTesting, setChatTesting] = useState<string | null>(null);

  const qc = useQueryClient();

  const invalidateIntegrations = () =>
    qc.invalidateQueries({ queryKey: queryKeys.chatIntegrations.list(boardId) });

  function openChatForm(existing?: ChatIntegration) {
    setChatEditIntegration(existing ?? null);
    setChatFormOpen(true);
  }

  function resetChatForm() {
    setChatEditIntegration(null);
    setChatFormOpen(false);
  }

  async function handleSaveChatIntegration(data: {
    provider: 'slack' | 'discord';
    webhookUrl: string;
    channelId: string;
    botToken: string;
    events: string[];
  }) {
    setChatSaving(true);
    try {
      if (chatEditIntegration) {
        await api.chatIntegrations.update(chatEditIntegration.id, {
          webhookUrl: data.webhookUrl,
          channelId: data.channelId || undefined,
          botToken: data.botToken || undefined,
          events: data.events,
        });
        notify.success('Integration updated');
      } else {
        await api.chatIntegrations.create(boardId, {
          provider: data.provider,
          webhookUrl: data.webhookUrl,
          channelId: data.channelId || undefined,
          botToken: data.botToken || undefined,
          events: data.events,
        });
        notify.success('Integration created');
      }
      resetChatForm();
      invalidateIntegrations();
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setChatSaving(false);
    }
  }

  async function handleDeleteChatIntegration(id: string) {
    try {
      await api.chatIntegrations.delete(id);
      notify.success('Integration deleted');
      invalidateIntegrations();
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  async function handleTestChatIntegration(id: string) {
    setChatTesting(id);
    try {
      const result = await api.chatIntegrations.test(id);
      if (result.success) {
        notify.success(`Test message sent (${result.latencyMs}ms)`);
      } else {
        notify.error(`Test failed (HTTP ${result.statusCode})`);
      }
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setChatTesting(null);
    }
  }

  async function handleToggleChatIntegration(integration: ChatIntegration) {
    try {
      await api.chatIntegrations.update(integration.id, {
        enabled: !integration.enabled,
      });
      invalidateIntegrations();
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      {chatFormOpen ? (
        <ChatIntegrationForm
          existing={chatEditIntegration}
          saving={chatSaving}
          onSave={handleSaveChatIntegration}
          onCancel={resetChatForm}
        />
      ) : (
        <ChatIntegrationList
          integrations={chatIntegrations}
          testing={chatTesting}
          onTest={handleTestChatIntegration}
          onEdit={(integration) => openChatForm(integration)}
          onDelete={handleDeleteChatIntegration}
          onToggle={handleToggleChatIntegration}
          onAdd={() => openChatForm()}
          loading={chatLoading}
        />
      )}
    </div>
  );
}
