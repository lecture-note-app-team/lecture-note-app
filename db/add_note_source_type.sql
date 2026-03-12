ALTER TABLE notes
  ADD COLUMN source_type ENUM('text', 'image') NOT NULL DEFAULT 'text' AFTER visibility;
