import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ExternalIssueBadge } from './ExternalIssueBadge.js';

describe('ExternalIssueBadge', () => {
  it('renders nothing when links array is empty', () => {
    const { container } = render(<ExternalIssueBadge links={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders a GitHub issue link with key', () => {
    render(
      <ExternalIssueBadge
        links={[{
          id: 'link-1',
          connectionId: 'conn-1',
          habitatId: 'hab-1',
          missionId: 'mis-1',
          provider: 'github',
          externalId: '12345',
          externalKey: 'acme/repo#42',
          externalUrl: 'https://github.com/acme/repo/issues/42',
          externalStatus: 'open',
          externalUpdatedAt: null,
          providerLabels: ['bug'],
          lastSyncedAt: null,
          syncStatus: 'synced',
          syncWarning: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }]}
      />
    );

    expect(screen.getByText(/GitHub acme\/repo#42/)).toBeInTheDocument();
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://github.com/acme/repo/issues/42');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('shows warning icon when syncWarning is present', () => {
    render(
      <ExternalIssueBadge
        links={[{
          id: 'link-2',
          connectionId: 'conn-1',
          habitatId: 'hab-1',
          missionId: 'mis-1',
          provider: 'github',
          externalId: '12345',
          externalKey: 'acme/repo#42',
          externalUrl: 'https://github.com/acme/repo/issues/42',
          externalStatus: 'closed',
          externalUpdatedAt: null,
          providerLabels: [],
          lastSyncedAt: null,
          syncStatus: 'warning',
          syncWarning: 'External issue closed while tasks active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }]}
      />
    );

    expect(screen.getByText(/closed/)).toBeInTheDocument();
  });

  it('renders multiple links', () => {
    render(
      <ExternalIssueBadge
        links={[
          {
            id: 'link-a',
            connectionId: 'conn-1',
            habitatId: 'hab-1',
            missionId: 'mis-1',
            provider: 'github',
            externalId: '1',
            externalKey: 'a/b#1',
            externalUrl: 'https://github.com/a/b/issues/1',
            externalStatus: 'open',
            externalUpdatedAt: null,
            providerLabels: [],
            lastSyncedAt: null,
            syncStatus: 'synced',
            syncWarning: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          {
            id: 'link-b',
            connectionId: 'conn-2',
            habitatId: 'hab-1',
            missionId: 'mis-1',
            provider: 'github',
            externalId: '2',
            externalKey: 'c/d#2',
            externalUrl: 'https://github.com/c/d/issues/2',
            externalStatus: 'open',
            externalUpdatedAt: null,
            providerLabels: [],
            lastSyncedAt: null,
            syncStatus: 'synced',
            syncWarning: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ]}
      />
    );

    expect(screen.getByText(/a\/b#1/)).toBeInTheDocument();
    expect(screen.getByText(/c\/d#2/)).toBeInTheDocument();
  });
});
