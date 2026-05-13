import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/Dialog.js';
import { Button } from '../ui/Button.js';
import { api } from '../../api/index.js';
import { notify } from '../../lib/toast.js';
import { Download } from 'lucide-react';

interface AuditExportModalProps {
  boardId: string;
  open: boolean;
  onClose: () => void;
}

export function AuditExportModal({ boardId, open, onClose }: AuditExportModalProps) {
  const [format, setFormat] = useState<'csv' | 'json' | 'jsonl'>('csv');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [actions, setActions] = useState('');
  const [actorType, setActorType] = useState('');
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const params: Record<string, string> = { format };
      if (since) params.since = new Date(since).toISOString();
      if (until) params.until = new Date(until).toISOString();
      if (actions) params.actions = actions;
      if (actorType) params.actorType = actorType;

      const data = await api.audit.export(boardId, params);
      const blob = new Blob([data], { type: format === 'csv' ? 'text/csv' : 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-${boardId.slice(0, 8)}-${new Date().toISOString().split('T')[0]}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      notify.success('Audit log exported');
      onClose();
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader>
        <DialogTitle>Export Audit Log</DialogTitle>
      </DialogHeader>
      <DialogContent>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-[var(--on-surface)] mb-1">Format</label>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as 'csv' | 'json' | 'jsonl')}
              className="w-full bg-[var(--surface-container-high)] text-[var(--on-surface)] text-sm px-3 py-2 rounded border border-[var(--outline-variant)]"
            >
              <option value="csv">CSV (spreadsheets)</option>
              <option value="json">JSON (BI tools)</option>
              <option value="jsonl">JSONL (streaming)</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-[var(--on-surface)] mb-1">From</label>
              <input
                type="date"
                value={since}
                onChange={(e) => setSince(e.target.value)}
                className="w-full bg-[var(--surface-container-high)] text-[var(--on-surface)] text-sm px-3 py-2 rounded border border-[var(--outline-variant)]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-[var(--on-surface)] mb-1">To</label>
              <input
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                className="w-full bg-[var(--surface-container-high)] text-[var(--on-surface)] text-sm px-3 py-2 rounded border border-[var(--outline-variant)]"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[var(--on-surface)] mb-1">Actions (comma-separated)</label>
            <input
              type="text"
              value={actions}
              onChange={(e) => setActions(e.target.value)}
              placeholder="claimed, submitted, approved"
              className="w-full bg-[var(--surface-container-high)] text-[var(--on-surface)] text-sm px-3 py-2 rounded border border-[var(--outline-variant)] placeholder:text-[var(--on-surface-variant)]/60"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[var(--on-surface)] mb-1">Actor Type</label>
            <select
              value={actorType}
              onChange={(e) => setActorType(e.target.value)}
              className="w-full bg-[var(--surface-container-high)] text-[var(--on-surface)] text-sm px-3 py-2 rounded border border-[var(--outline-variant)]"
            >
              <option value="">All</option>
              <option value="human">Human</option>
              <option value="agent">Agent</option>
              <option value="system">System</option>
            </select>
          </div>
        </div>
      </DialogContent>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={exporting}>Cancel</Button>
        <Button variant="default" onClick={handleExport} disabled={exporting}>
          <Download className="h-3.5 w-3.5 mr-1.5" />
          {exporting ? 'Exporting...' : 'Export'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
