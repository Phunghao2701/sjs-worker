CREATE TABLE IF NOT EXISTS scimago_documents (
  collection TEXT NOT NULL CHECK (collection IN ('ranking_metrics','journal_rankings','scimago_import_jobs','scimago_import_batches')),
  document_id TEXT NOT NULL,
  journal_id TEXT,
  metric_id TEXT,
  year INTEGER,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (collection, document_id)
);
CREATE INDEX IF NOT EXISTS idx_scimago_documents_journal ON scimago_documents(collection, journal_id);
CREATE INDEX IF NOT EXISTS idx_scimago_documents_year ON scimago_documents(collection, year);
