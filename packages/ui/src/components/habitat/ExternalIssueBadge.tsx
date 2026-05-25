import React from 'react';
import { ExternalLink, AlertTriangle } from 'lucide-react';
import type { ExternalIssueLink } from '../../types/index.js';

interface ExternalIssueBadgeProps {
  links: ExternalIssueLink[];
}

function providerLabel(provider: string): string {
  switch (provider) {
    case 'github': return 'GitHub';
    case 'jira': return 'Jira';
    case 'linear': return 'Linear';
    default: return provider;
  }
}

export function ExternalIssueBadge({ links }: ExternalIssueBadgeProps) {
  if (links.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {links.map((link) => (
        <a
          key={link.id}
          href={link.externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium bg-accent text-accent-foreground hover:opacity-80 transition-opacity"
        >
          <ExternalLink className="h-3 w-3" />
          <span>{providerLabel(link.provider)} {link.externalKey}</span>
          {link.syncWarning && (
            <AlertTriangle className="h-3 w-3 text-yellow-500" />
          )}
          {link.externalStatus === 'closed' && (
            <span className="text-muted-foreground line-through ml-0.5">closed</span>
          )}
        </a>
      ))}
    </div>
  );
}
