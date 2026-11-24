CREATE TABLE IF NOT EXISTS app_documents (
  collection TEXT NOT NULL,
  document_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, document_id)
);

CREATE INDEX IF NOT EXISTS app_documents_collection_updated_idx
  ON app_documents(collection, updated_at);
