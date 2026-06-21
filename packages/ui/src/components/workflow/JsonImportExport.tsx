import React, { useState, useEffect } from "react";
import { Button } from "../ui/Button.js";
import { notify } from "../../lib/toast.js";
import type { WorkflowTemplateDefinition } from "../../types/index.js";

/** Props for the {@link JsonImportExport} component. */
interface JsonImportExportProps {
  value: WorkflowTemplateDefinition;
  onImport: (next: WorkflowTemplateDefinition) => void;
}

const textareaClass =
  "mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary";

/** Provides a textarea for raw JSON editing of the workflow definition, with import and export actions. */
export function JsonImportExport({ value, onImport }: JsonImportExportProps) {
  const [text, setText] = useState("");

  useEffect(() => {
    setText(JSON.stringify(value, null, 2));
  }, [value]);

  function handleExport() {
    setText(JSON.stringify(value, null, 2));
  }

  function handleImport() {
    try {
      const parsed = JSON.parse(text) as WorkflowTemplateDefinition;
      if (!Array.isArray(parsed.gates)) {
        throw new Error('Invalid workflow: "gates" must be an array');
      }
      onImport(parsed);
      notify.success("Workflow imported from JSON");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid JSON";
      notify.error(`Import failed: ${message}`);
    }
  }

  return (
    <div data-testid="json-import-export" className="space-y-2">
      <textarea
        data-testid="json-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={12}
        placeholder='{"gates":[],"joinSpecs":{},"variables":[]}'
        className={textareaClass}
      />
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={handleExport} data-testid="json-export">
          Export (Form → JSON)
        </Button>
        <Button variant="default" size="sm" onClick={handleImport} data-testid="json-import">
          Import (JSON → Form)
        </Button>
      </div>
    </div>
  );
}
