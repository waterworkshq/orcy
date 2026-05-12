import React, { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogContent,
  DialogFooter,
} from '../ui/Dialog.js';
import { Button } from '../ui/Button.js';
import {
  Search,
  ShieldAlert,
  Handshake,
  TriangleAlert,
  HelpCircle,
  MessageCircle,
  Command,
  Info,
  ArrowRightLeft,
  Loader2,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../../api/index.js';
import type { SignalType, PostPulseInput } from '../../types/index.js';

const SIGNAL_OPTIONS: Array<{ type: SignalType; label: string; icon: LucideIcon; color: string }> = [
  { type: 'finding', label: 'Finding', icon: Search, color: 'var(--primary)' },
  { type: 'blocker', label: 'Blocker', icon: ShieldAlert, color: 'var(--error)' },
  { type: 'offer', label: 'Offer', icon: Handshake, color: 'var(--tertiary)' },
  { type: 'warning', label: 'Warning', icon: TriangleAlert, color: 'hsl(40,90%,55%)' },
  { type: 'question', label: 'Question', icon: HelpCircle, color: 'var(--secondary)' },
  { type: 'answer', label: 'Answer', icon: MessageCircle, color: 'var(--secondary)' },
  { type: 'directive', label: 'Directive', icon: Command, color: 'hsl(280,70%,60%)' },
  { type: 'context', label: 'Context', icon: Info, color: 'var(--on-surface-variant)' },
  { type: 'handoff', label: 'Handoff', icon: ArrowRightLeft, color: 'hsl(200,70%,60%)' },
];

const MAX_SUBJECT = 80;

interface PulseComposeDialogProps {
  missionId: string;
  open: boolean;
  onClose: () => void;
}

export function PulseComposeDialog({ missionId, open, onClose }: PulseComposeDialogProps) {
  const queryClient = useQueryClient();
  const [signalType, setSignalType] = useState<SignalType>('finding');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => {
    if (open) {
      setSignalType('finding');
      setSubject('');
      setBody('');
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: (input: PostPulseInput) => api.pulse.post(missionId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pulses', missionId] });
      onClose();
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim()) return;
    mutation.mutate({
      signalType,
      subject: subject.trim(),
      body: body.trim() || undefined,
    });
  }

  const selectedOption = SIGNAL_OPTIONS.find((o) => o.type === signalType)!;
  const SelectedIcon = selectedOption.icon;

  return (
    <Dialog open={open} onClose={onClose}>
      <div
        className="rounded-lg border border-[var(--outline-variant)] bg-[var(--surface)]/90 p-6 shadow-xl"
        style={{ backdropFilter: 'blur(12px)' }}
      >
        <DialogHeader>
          <DialogTitle className="text-[var(--on-surface)]">Post Signal</DialogTitle>
          <DialogDescription className="text-[var(--on-surface-variant)]">
            Send a signal to the mission pulse board
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <DialogContent className="space-y-4">
            <div>
              <label className="block text-[11px] font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider mb-1.5">
                Signal Type
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {SIGNAL_OPTIONS.map(({ type, label, icon: Icon, color }) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setSignalType(type)}
                    className={`flex items-center gap-1.5 px-2 py-1.5 rounded text-[11px] font-medium transition-all ${
                      signalType === type
                        ? 'ring-1'
                        : 'bg-[var(--surface-container)] text-[var(--on-surface-variant)] hover:bg-[var(--surface-container-high)]'
                    }`}
                    style={signalType === type ? {
                      backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
                      color: color,
                      borderColor: color,
                    } : undefined}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-[11px] font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider">
                  Subject
                </label>
                <span className={`text-[10px] ${subject.length > MAX_SUBJECT ? 'text-[var(--error)]' : 'text-[var(--on-surface-variant)]'}`}>
                  {subject.length}/{MAX_SUBJECT}
                </span>
              </div>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value.slice(0, MAX_SUBJECT))}
                placeholder="Signal subject..."
                maxLength={MAX_SUBJECT}
                className="w-full bg-[var(--surface-container)] border border-[var(--outline-variant)] rounded-lg px-3 py-2 text-sm text-[var(--on-surface)] placeholder:text-[var(--on-surface-variant)] focus:ring-1 focus:ring-[var(--primary)] focus:border-[var(--primary)]"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider mb-1.5">
                Body
              </label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Describe the signal..."
                rows={4}
                className="w-full bg-[var(--surface-container)] border border-[var(--outline-variant)] rounded-lg px-3 py-2 text-sm text-[var(--on-surface)] placeholder:text-[var(--on-surface-variant)] focus:ring-1 focus:ring-[var(--primary)] focus:border-[var(--primary)] resize-none"
              />
            </div>
          </DialogContent>

          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!subject.trim() || mutation.isPending}
            >
              {mutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Posting...
                </>
              ) : (
                <>
                  <SelectedIcon className="h-4 w-4 mr-2" />
                  Post {selectedOption.label}
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </div>
    </Dialog>
  );
}
