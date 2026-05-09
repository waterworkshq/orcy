import React from 'react';
import { DetailCard } from '../ui/DetailCard.js';
import { Link2 } from 'lucide-react';
import type { Artifact } from '../../types/index.js';

interface TaskArtifactsProps {
  artifacts: Artifact[];
  labels?: string[];
}

export function TaskArtifacts({ artifacts, labels }: TaskArtifactsProps) {
  if (artifacts.length === 0 && (!labels || labels.length === 0)) return null;

  return (
    <>
      {labels && labels.length > 0 && (
        <div className="mb-4">
          <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Labels</h4>
          <div className="flex flex-wrap gap-1">
            {labels.map((label) => (
              <span key={label} className="rounded bg-accent px-2 py-0.5 text-xs">
                {label}
              </span>
            ))}
          </div>
        </div>
      )}

      {artifacts.length > 0 && (
        <DetailCard icon={Link2} title="Artifacts" className="mb-4">
          <div className="space-y-2">
            {artifacts.map((artifact, i) => (
              <a
                key={i}
                href={artifact.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-blue-600 hover:underline dark:text-blue-400"
              >
                <span className="rounded bg-secondary px-1.5 py-0.5 text-xs">{artifact.type}</span>
                {artifact.description || artifact.url}
              </a>
            ))}
          </div>
        </DetailCard>
      )}
    </>
  );
}
