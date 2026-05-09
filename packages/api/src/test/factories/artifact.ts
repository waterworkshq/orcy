import type { Artifact } from '../../models/index.js';

export function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    type: 'file',
    url: 'https://example.com/file.txt',
    description: 'Test artifact',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Artifact;
}
