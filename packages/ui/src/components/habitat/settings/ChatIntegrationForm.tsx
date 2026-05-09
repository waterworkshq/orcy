import React, { useReducer, useEffect } from 'react';
import { Button } from '../../ui/Button.js';
import type { ChatIntegration } from '../../../types/index.js';

const CHAT_EVENTS = [
  { value: 'task_created', label: 'Task Created' },
  { value: 'task_claimed', label: 'Task Claimed' },
  { value: 'task_submitted', label: 'Task Submitted' },
  { value: 'task_approved', label: 'Task Approved' },
  { value: 'task_rejected', label: 'Task Rejected' },
  { value: 'task_overdue', label: 'Task Overdue' },
];

interface ChatFormState {
  provider: 'slack' | 'discord';
  webhookUrl: string;
  channelId: string;
  botToken: string;
  events: string[];
}

type ChatFormAction =
  | { type: 'SET_PROVIDER'; provider: 'slack' | 'discord' }
  | { type: 'SET_WEBHOOK_URL'; webhookUrl: string }
  | { type: 'SET_CHANNEL_ID'; channelId: string }
  | { type: 'SET_BOT_TOKEN'; botToken: string }
  | { type: 'TOGGLE_EVENT'; event: string }
  | { type: 'SET_ALL_EVENTS'; events: string[] }
  | { type: 'LOAD_INTEGRATION'; integration: ChatIntegration };

const defaultState: ChatFormState = {
  provider: 'slack',
  webhookUrl: '',
  channelId: '',
  botToken: '',
  events: CHAT_EVENTS.map(e => e.value),
};

function chatFormReducer(state: ChatFormState, action: ChatFormAction): ChatFormState {
  switch (action.type) {
    case 'SET_PROVIDER':
      return { ...state, provider: action.provider };
    case 'SET_WEBHOOK_URL':
      return { ...state, webhookUrl: action.webhookUrl };
    case 'SET_CHANNEL_ID':
      return { ...state, channelId: action.channelId };
    case 'SET_BOT_TOKEN':
      return { ...state, botToken: action.botToken };
    case 'TOGGLE_EVENT':
      return {
        ...state,
        events: state.events.includes(action.event)
          ? state.events.filter(ev => ev !== action.event)
          : [...state.events, action.event],
      };
    case 'SET_ALL_EVENTS':
      return { ...state, events: action.events };
    case 'LOAD_INTEGRATION':
      return {
        provider: action.integration.provider,
        webhookUrl: action.integration.webhookUrl,
        channelId: action.integration.channelId ?? '',
        botToken: '',
        events: action.integration.events,
      };
    default:
      return state;
  }
}

interface ChatIntegrationFormProps {
  existing?: ChatIntegration | null;
  saving: boolean;
  onSave: (data: {
    provider: 'slack' | 'discord';
    webhookUrl: string;
    channelId: string;
    botToken: string;
    events: string[];
  }) => void;
  onCancel: () => void;
}

export function ChatIntegrationForm({ existing, saving, onSave, onCancel }: ChatIntegrationFormProps) {
  const [state, dispatch] = useReducer(chatFormReducer, defaultState);

  useEffect(() => {
    if (existing) {
      dispatch({ type: 'LOAD_INTEGRATION', integration: existing });
    }
  }, [existing]);

  return (
    <div className="space-y-3 border rounded-lg p-4">
      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="chat-provider">Provider</label>
        <select
          id="chat-provider"
          value={state.provider}
          onChange={(e) => dispatch({ type: 'SET_PROVIDER', provider: e.target.value as 'slack' | 'discord' })}
          disabled={!!existing}
          className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="slack">Slack</option>
          <option value="discord">Discord</option>
        </select>
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="chat-webhook">Webhook URL</label>
        <input
          id="chat-webhook"
          type="url"
          value={state.webhookUrl}
          onChange={(e) => dispatch({ type: 'SET_WEBHOOK_URL', webhookUrl: e.target.value })}
          placeholder="https://hooks.slack.com/services/..."
          className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="chat-channel">Channel ID (optional)</label>
        <input
          id="chat-channel"
          type="text"
          value={state.channelId}
          onChange={(e) => dispatch({ type: 'SET_CHANNEL_ID', channelId: e.target.value })}
          placeholder="C0123456789"
          className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="chat-token">Bot Token (optional)</label>
        <input
          id="chat-token"
          type="password"
          value={state.botToken}
          onChange={(e) => dispatch({ type: 'SET_BOT_TOKEN', botToken: e.target.value })}
          placeholder="xoxb-..."
          className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>
      <div>
        <p className="mb-2 text-sm font-medium">Events</p>
        <div className="space-y-2">
          {CHAT_EVENTS.map((event) => (
            <label key={event.value} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={state.events.includes(event.value)}
                onChange={() => dispatch({ type: 'TOGGLE_EVENT', event: event.value })}
                className="h-4 w-4 rounded border-input text-primary focus:ring-primary"
              />
              <span className="text-sm">{event.label}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="flex gap-2 pt-2">
        <Button size="sm" onClick={() => onSave(state)} loading={saving}>
          {existing ? 'Update' : 'Create'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

export { CHAT_EVENTS };
export type { ChatFormState, ChatFormAction, ChatFormAction as ChatFormActionType };
