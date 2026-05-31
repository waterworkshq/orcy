-- S18: Add code evidence provenance tables and additive columns for v0.16 Provenance

-- habitat_code_repositories: one row per habitat, canonical repository identity
CREATE TABLE IF NOT EXISTS habitat_code_repositories (
  id TEXT PRIMARY KEY NOT NULL,
  habitat_id TEXT UNIQUE NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_base_url TEXT,
  external_id TEXT,
  repo_slug TEXT,
  display_name TEXT,
  local_path TEXT,
  verification_state TEXT NOT NULL DEFAULT 'unverified',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_habitat_code_repo_habitat ON habitat_code_repositories(habitat_id);
CREATE INDEX IF NOT EXISTS idx_habitat_code_repo_provider_slug ON habitat_code_repositories(provider, repo_slug);

-- code_branches: lightweight branch evidence
CREATE TABLE IF NOT EXISTS code_branches (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT REFERENCES habitat_code_repositories(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  repo_slug TEXT,
  name TEXT NOT NULL,
  base_branch TEXT,
  head_sha TEXT,
  url TEXT,
  created_from_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  verification_state TEXT NOT NULL DEFAULT 'unverified',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_code_branches_repo_name ON code_branches(repository_id, name);
CREATE INDEX IF NOT EXISTS idx_code_branches_task ON code_branches(created_from_task_id);

-- code_commits: reusable commit evidence
CREATE TABLE IF NOT EXISTS code_commits (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT REFERENCES habitat_code_repositories(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  repo_slug TEXT,
  sha TEXT NOT NULL,
  branch_id TEXT REFERENCES code_branches(id) ON DELETE SET NULL,
  message TEXT,
  author_name TEXT,
  author_email TEXT,
  authored_at TEXT,
  url TEXT,
  verification_state TEXT NOT NULL DEFAULT 'unverified',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_code_commits_repo_sha ON code_commits(repository_id, sha);
CREATE INDEX IF NOT EXISTS idx_code_commits_sha ON code_commits(sha);
CREATE INDEX IF NOT EXISTS idx_code_commits_branch ON code_commits(branch_id);

-- code_changed_files: durable changed-file snapshots
CREATE TABLE IF NOT EXISTS code_changed_files (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT REFERENCES habitat_code_repositories(id) ON DELETE SET NULL,
  commit_id TEXT REFERENCES code_commits(id) ON DELETE SET NULL,
  pull_request_id TEXT REFERENCES pull_requests(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  repo_slug TEXT,
  path TEXT NOT NULL,
  previous_path TEXT,
  change_type TEXT NOT NULL,
  additions INTEGER,
  deletions INTEGER,
  source TEXT NOT NULL,
  captured_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_code_changed_files_repo_path ON code_changed_files(repository_id, path);
CREATE INDEX IF NOT EXISTS idx_code_changed_files_commit ON code_changed_files(commit_id);
CREATE INDEX IF NOT EXISTS idx_code_changed_files_pr ON code_changed_files(pull_request_id);

-- code_reviews: first-class review evidence
CREATE TABLE IF NOT EXISTS code_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  pull_request_id TEXT REFERENCES pull_requests(id) ON DELETE SET NULL,
  repository_id TEXT REFERENCES habitat_code_repositories(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  repo_slug TEXT,
  review_url TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending',
  reviewer_name TEXT,
  reviewer_id TEXT,
  submitted_at TEXT,
  verification_state TEXT NOT NULL DEFAULT 'unverified',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_code_reviews_pr ON code_reviews(pull_request_id);
CREATE INDEX IF NOT EXISTS idx_code_reviews_repo_status ON code_reviews(repository_id, review_status);

-- code_evidence_links: canonical relationship between work item and evidence
CREATE TABLE IF NOT EXISTS code_evidence_links (
  id TEXT PRIMARY KEY NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  evidence_id TEXT,
  external_url TEXT,
  normalized_external_url TEXT,
  title TEXT,
  description TEXT,
  link_source TEXT NOT NULL,
  link_sources TEXT NOT NULL DEFAULT '[]',
  linked_by_type TEXT NOT NULL,
  linked_by_id TEXT NOT NULL,
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  verification_state TEXT NOT NULL DEFAULT 'unverified',
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'active',
  corrected_by_type TEXT,
  corrected_by_id TEXT,
  corrected_at TEXT,
  correction_reason TEXT,
  replacement_link_id TEXT,
  allow_external_repository INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_evidence_links_target_status ON code_evidence_links(target_type, target_id, status);
CREATE INDEX IF NOT EXISTS idx_evidence_links_evidence ON code_evidence_links(evidence_type, evidence_id);

-- code_evidence_completeness: not-applicable overrides only
CREATE TABLE IF NOT EXISTS code_evidence_completeness (
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reason_code TEXT,
  reason_note TEXT,
  marked_by_type TEXT NOT NULL,
  marked_by_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (target_type, target_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_completeness_target ON code_evidence_completeness(target_type, target_id);

-- code_evidence_gaps: lifecycle records for known evidence gaps
CREATE TABLE IF NOT EXISTS code_evidence_gaps (
  id TEXT PRIMARY KEY NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason_note TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  reported_by_type TEXT NOT NULL,
  reported_by_id TEXT NOT NULL,
  reported_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_by_type TEXT,
  resolved_by_id TEXT,
  resolved_at TEXT,
  resolution_reason TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_evidence_gaps_target_status ON code_evidence_gaps(target_type, target_id, status);
CREATE INDEX IF NOT EXISTS idx_evidence_gaps_reason_status ON code_evidence_gaps(reason_code, status);

-- Additive columns on pull_requests
ALTER TABLE pull_requests ADD COLUMN repository_id TEXT REFERENCES habitat_code_repositories(id) ON DELETE SET NULL;
ALTER TABLE pull_requests ADD COLUMN branch_id TEXT REFERENCES code_branches(id) ON DELETE SET NULL;
ALTER TABLE pull_requests ADD COLUMN verification_state TEXT;
ALTER TABLE pull_requests ADD COLUMN metadata TEXT;

-- Additive columns on pipeline_events
ALTER TABLE pipeline_events ADD COLUMN repository_id TEXT REFERENCES habitat_code_repositories(id) ON DELETE SET NULL;
ALTER TABLE pipeline_events ADD COLUMN commit_id TEXT REFERENCES code_commits(id) ON DELETE SET NULL;
ALTER TABLE pipeline_events ADD COLUMN branch_evidence_id TEXT REFERENCES code_branches(id) ON DELETE SET NULL;
ALTER TABLE pipeline_events ADD COLUMN verification_state TEXT;
ALTER TABLE pipeline_events ADD COLUMN metadata TEXT;
ALTER TABLE pipeline_events ADD COLUMN updated_at TEXT DEFAULT (datetime('now'));