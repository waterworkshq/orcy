import React from 'react';
import { DetailCard } from '../ui/DetailCard.js';
import { MarkdownContent } from '../ui/MarkdownContent.js';
import { RichTextViewer, isHtmlContent } from '../ui/RichTextEditor.js';
import { FileText } from 'lucide-react';

interface TaskDescriptionProps {
  description: string;
}

export function TaskDescription({ description }: TaskDescriptionProps) {
  if (!description) return null;

  return (
    <DetailCard icon={FileText} title="Description" className="mb-4">
      {isHtmlContent(description) ? (
        <RichTextViewer content={description} className="text-sm text-muted-foreground" />
      ) : (
        <MarkdownContent content={description} className="text-sm text-muted-foreground" />
      )}
    </DetailCard>
  );
}
