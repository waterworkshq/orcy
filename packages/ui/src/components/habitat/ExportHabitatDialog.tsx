import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/Dialog.js';
import { Button } from '../ui/Button.js';
import type { HabitatExport } from '../../types/index.js';
import { api } from '../../api/index.js';
import { notify } from '../../lib/toast.js';

interface ExportHabitatDialogProps {
  habitatId: string;
  boardName: string;
  open: boolean;
  onClose: () => void;
}

export function ExportHabitatDialog({ habitatId, boardName, open, onClose }: ExportHabitatDialogProps) {
  const [includeColumns, setIncludeColumns] = useState(true);
  const [includeTasks, setIncludeTasks] = useState(true);
  const [includeComments, setIncludeComments] = useState(true);
  const [includeTemplates, setIncludeTemplates] = useState(true);
  const [includeWebhooks, setIncludeWebhooks] = useState(true);
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    const includes = [
      includeColumns && 'columns',
      includeTasks && 'tasks',
      includeComments && 'comments',
      includeTemplates && 'templates',
      includeWebhooks && 'webhooks',
    ].filter(Boolean).join(',');

    setExporting(true);
    try {
      const data = await api.habitats.export(habitatId, { include: includes });
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${boardName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_export_${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      notify.success('Habitat exported successfully');
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
        <DialogTitle>Export Habitat</DialogTitle>
      </DialogHeader>
      <DialogContent>
        <p className="text-sm text-muted-foreground mb-4">
          Export "{boardName}" as a JSON file. Choose what to include:
        </p>
        <div className="space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={includeColumns}
              onChange={(e) => setIncludeColumns(e.target.checked)}
              className="rounded border-input"
            />
            <span className="text-sm">Columns (with WIP limits, chain, and order)</span>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={includeTasks}
              onChange={(e) => setIncludeTasks(e.target.checked)}
              className="rounded border-input"
            />
            <span className="text-sm">Missions (with tasks, dependencies, and status)</span>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={includeComments}
              onChange={(e) => setIncludeComments(e.target.checked)}
              className="rounded border-input"
            />
            <span className="text-sm">Comments</span>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={includeTemplates}
              onChange={(e) => setIncludeTemplates(e.target.checked)}
              className="rounded border-input"
            />
            <span className="text-sm">Habitat-specific templates</span>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={includeWebhooks}
              onChange={(e) => setIncludeWebhooks(e.target.checked)}
              className="rounded border-input"
            />
            <span className="text-sm">Webhook configurations (secrets will be omitted)</span>
          </label>
        </div>
        <div className="mt-4 p-3 bg-muted rounded text-xs text-muted-foreground">
          <strong>Note:</strong> Agent API keys, webhook secrets, and audit logs are never exported.
        </div>
      </DialogContent>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={exporting}>
          Cancel
        </Button>
        <Button onClick={handleExport} loading={exporting}>
          Download JSON
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
