-- ============================================================
-- 講義ノートメーカー 追加機能マイグレーション (2026-07)
-- 実行前に必ずDBのバックアップを取ってください。
-- Railway の MySQL に対して、これをそのまま実行できます。
-- ============================================================

-- 1. 自動クイズ作成「1回きり」制限のため、ノートに生成済みフラグを追加
ALTER TABLE notes
  ADD COLUMN ai_quiz_generated_at DATETIME NULL
  COMMENT 'AIによるクイズ自動生成を実行した日時（1回きり制限用）';

-- 2. マインドマップ保存用テーブル（AI自動生成 + 手動編集の両方をここに保存）
CREATE TABLE IF NOT EXISTS note_mindmaps (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  note_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  data JSON NOT NULL,
  source ENUM('ai', 'manual') NOT NULL DEFAULT 'ai',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_note_mindmap (note_id),
  CONSTRAINT fk_mindmap_note FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. 復習通知（間隔反復方式）のスケジュール管理テーブル
CREATE TABLE IF NOT EXISTS note_review_schedules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  note_id BIGINT UNSIGNED NOT NULL,
  stage INT NOT NULL DEFAULT 0,
  next_review_at DATETIME NOT NULL,
  last_reviewed_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_user_note_review (user_id, note_id),
  CONSTRAINT fk_review_note FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_review_due ON note_review_schedules (user_id, next_review_at);
