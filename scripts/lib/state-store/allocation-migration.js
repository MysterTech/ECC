'use strict';

const ALLOCATION_SCHEMA_SQL = `
CREATE TABLE allocation_policies (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE allocation_revisions (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL,
  revision INTEGER NOT NULL, phase TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(session_id, task_id, revision), FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE TABLE allocation_frontiers (
  id TEXT PRIMARY KEY REFERENCES allocation_revisions(id), data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE allocation_attempts (
  id TEXT PRIMARY KEY, revision_key TEXT NOT NULL REFERENCES allocation_revisions(id),
  ordinal INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(revision_key, ordinal)
);
CREATE TABLE allocation_operations (
  id TEXT PRIMARY KEY, revision_key TEXT NOT NULL REFERENCES allocation_revisions(id),
  attempt_id TEXT NOT NULL REFERENCES allocation_attempts(id), data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE allocation_checkpoints (
  id TEXT PRIMARY KEY, revision_key TEXT NOT NULL REFERENCES allocation_revisions(id),
  attempt_id TEXT NOT NULL REFERENCES allocation_attempts(id), data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE allocation_recoveries (
  id TEXT PRIMARY KEY, revision_key TEXT NOT NULL REFERENCES allocation_revisions(id), data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE allocation_transitions (
  id TEXT PRIMARY KEY, revision_key TEXT NOT NULL REFERENCES allocation_revisions(id),
  parent_attempt_id TEXT NOT NULL UNIQUE REFERENCES allocation_attempts(id),
  successor_attempt_id TEXT NOT NULL UNIQUE REFERENCES allocation_attempts(id), data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE allocation_availability (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE allocation_capsules (
  id TEXT PRIMARY KEY, revision_key TEXT NOT NULL REFERENCES allocation_revisions(id),
  journal_version INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(revision_key, journal_version)
);
CREATE TABLE allocation_progress (
  id TEXT PRIMARY KEY, revision_key TEXT NOT NULL REFERENCES allocation_revisions(id),
  journal_version INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(revision_key, journal_version)
);
CREATE TABLE allocation_workspace_manifests (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE allocation_ids (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL, payload_digest TEXT NOT NULL,
  receipt TEXT CHECK(receipt IS NULL OR json_valid(receipt)), finalized INTEGER NOT NULL DEFAULT 0, owner_id TEXT
);
CREATE TABLE allocation_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, revision_key TEXT, data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE INDEX idx_allocation_operations_revision ON allocation_operations(revision_key);
CREATE INDEX idx_allocation_attempts_revision ON allocation_attempts(revision_key);
`;

module.exports = { ALLOCATION_SCHEMA_SQL };
