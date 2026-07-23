-- ============================================================
-- 講義ノートメーカー ローカル用 統合スキーマ（訂正版）
-- db フォルダにあった実際のマイグレーションファイル
--   billing_schema.sql / user_quizzes_schema.sql /
--   add_note_source_type.sql / add_fill_blank_quiz_type.sql
-- の内容を反映し、server.js の実クエリと突き合わせて作成しています。
--
-- 前回渡した init_local_schema_1.sql は使わないでください（型が食い違います）。
--
-- 使い方:
--   Get-Content init_local_schema_v2.sql | mysql -u root -p lecture_note_app
-- ============================================================

SET NAMES utf8mb4;

-- ---------- 基本テーブル ----------

CREATE TABLE IF NOT EXISTS universities (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_universities_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  stripe_customer_id VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_username (username),
  UNIQUE KEY uk_users_stripe_customer_id (stripe_customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS communities (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(150) NOT NULL,
  join_code_hash VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_communities_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_communities (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  community_id BIGINT UNSIGNED NOT NULL,
  role ENUM('admin', 'member') NOT NULL DEFAULT 'member',
  joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_community (user_id, community_id),
  CONSTRAINT fk_uc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_uc_community FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS community_join_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  community_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  message VARCHAR(500) NULL,
  status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_jr_community FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
  CONSTRAINT fk_jr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- source_type は本来 add_note_source_type.sql で後付けされていますが、
-- ここでは最初から列として含めています（同じ内容なので二重適用を避けるため）
CREATE TABLE IF NOT EXISTS notes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  community_id BIGINT UNSIGNED NULL,
  university_id BIGINT UNSIGNED NOT NULL,
  author_name VARCHAR(100) NULL,
  course_name VARCHAR(200) NOT NULL,
  lecture_no VARCHAR(50) NOT NULL,
  lecture_date DATE NOT NULL,
  title VARCHAR(200) NOT NULL,
  body_raw MEDIUMTEXT NOT NULL,
  body_md MEDIUMTEXT NOT NULL,
  visibility ENUM('public', 'private') NOT NULL DEFAULT 'private',
  source_type ENUM('text', 'image') NOT NULL DEFAULT 'text',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_notes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_notes_university FOREIGN KEY (university_id) REFERENCES universities(id),
  CONSTRAINT fk_notes_community FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- note_quizzes: server.js が実際にクエリしているテーブル（AIクイズ自動生成の保存先）
CREATE TABLE IF NOT EXISTS note_quizzes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  note_id BIGINT UNSIGNED NOT NULL,
  type VARCHAR(30) NOT NULL,
  question VARCHAR(500) NOT NULL,
  answer VARCHAR(500) NULL,
  choice_1 VARCHAR(100) NULL,
  choice_2 VARCHAR(100) NULL,
  choice_3 VARCHAR(100) NULL,
  choice_4 VARCHAR(100) NULL,
  source_line VARCHAR(300) NULL,
  visibility ENUM('private', 'community') NOT NULL DEFAULT 'private',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_nq_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_nq_note FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 課金（billing_schema.sql の内容そのまま） ----------

CREATE TABLE IF NOT EXISTS plans (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  plan_code VARCHAR(50) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  stripe_price_id VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_plans_plan_code (plan_code),
  UNIQUE KEY uk_plans_stripe_price_id (stripe_price_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  stripe_customer_id VARCHAR(255) NOT NULL,
  stripe_subscription_id VARCHAR(255) NOT NULL,
  plan_code VARCHAR(50) NOT NULL DEFAULT 'free',
  subscription_status VARCHAR(50) NOT NULL DEFAULT 'incomplete',
  current_period_end DATETIME NULL,
  cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_subscriptions_user_id (user_id),
  UNIQUE KEY uk_subscriptions_stripe_subscription_id (stripe_subscription_id),
  KEY idx_subscriptions_customer_id (stripe_customer_id),
  KEY idx_subscriptions_status (subscription_status),
  CONSTRAINT fk_subscriptions_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payment_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  payload JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_payment_events_event_id (event_id),
  KEY idx_payment_events_event_type (event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS usage_counters (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  feature_code VARCHAR(100) NOT NULL,
  period_month CHAR(7) NOT NULL COMMENT 'YYYY-MM (UTC)',
  used_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_usage_user_feature_period (user_id, feature_code, period_month),
  KEY idx_usage_feature_period (feature_code, period_month),
  CONSTRAINT fk_usage_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO plans (plan_code, display_name, stripe_price_id)
VALUES
  ('free', 'Free Plan', NULL),
  ('pro', 'Pro Monthly', 'replace_with_real_price_id')
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  is_active = 1;

-- ---------- user_quizzes（見つかったが server.js からは現状未参照。念のため作成） ----------
-- fill_blank は add_fill_blank_quiz_type.sql の内容を反映済み（最初からENUMに含む）
CREATE TABLE IF NOT EXISTS user_quizzes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  note_id BIGINT UNSIGNED NULL,
  title VARCHAR(100) NOT NULL,
  question_text VARCHAR(500) NOT NULL,
  quiz_type ENUM('multiple_choice','written','true_false','fill_blank') NOT NULL,
  choice_1 VARCHAR(100) NULL,
  choice_2 VARCHAR(100) NULL,
  choice_3 VARCHAR(100) NULL,
  choice_4 VARCHAR(100) NULL,
  correct_answer VARCHAR(200) NOT NULL,
  explanation VARCHAR(1000) NULL,
  visibility ENUM('private','community') NOT NULL DEFAULT 'private',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user_quizzes_user_id (user_id),
  KEY idx_user_quizzes_note_id (note_id),
  KEY idx_user_quizzes_type_created (quiz_type, created_at),
  CONSTRAINT fk_user_quizzes_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_quizzes_note_id FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- sessions テーブルは express-mysql-session が自動作成するので、ここでは不要です。
