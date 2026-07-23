-- ============================================================
-- 講義ノートメーカー ローカル用 初期スキーマ（テストデータから開始）
-- 使い方:
--   mysql -u root -p lecture_note_app < init_local_schema.sql
-- その後に migration_2026_07.sql を実行してください。
-- ============================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS universities (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  stripe_customer_id VARCHAR(255) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS communities (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(150) NOT NULL UNIQUE,
  join_code_hash VARCHAR(255) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_communities (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  community_id INT NOT NULL,
  role ENUM('admin', 'member') NOT NULL DEFAULT 'member',
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_user_community (user_id, community_id),
  CONSTRAINT fk_uc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_uc_community FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS community_join_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  community_id INT NOT NULL,
  user_id INT NOT NULL,
  message VARCHAR(500) NULL,
  status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_jr_community FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
  CONSTRAINT fk_jr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  community_id INT NULL,
  university_id INT NOT NULL,
  author_name VARCHAR(100) NULL,
  course_name VARCHAR(200) NOT NULL,
  lecture_no VARCHAR(50) NOT NULL,
  lecture_date DATE NOT NULL,
  title VARCHAR(200) NOT NULL,
  body_raw MEDIUMTEXT NOT NULL,
  body_md MEDIUMTEXT NOT NULL,
  visibility ENUM('public', 'private') NOT NULL DEFAULT 'private',
  source_type ENUM('text', 'image') NOT NULL DEFAULT 'text',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_notes_university FOREIGN KEY (university_id) REFERENCES universities(id),
  CONSTRAINT fk_notes_community FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS note_quizzes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  note_id INT NOT NULL,
  type VARCHAR(30) NOT NULL,
  question VARCHAR(500) NOT NULL,
  answer VARCHAR(500) NULL,
  choice_1 VARCHAR(100) NULL,
  choice_2 VARCHAR(100) NULL,
  choice_3 VARCHAR(100) NULL,
  choice_4 VARCHAR(100) NULL,
  source_line VARCHAR(300) NULL,
  visibility ENUM('private', 'community') NOT NULL DEFAULT 'private',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_nq_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_nq_note FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS subscriptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  stripe_customer_id VARCHAR(255) NULL,
  stripe_subscription_id VARCHAR(255) NULL,
  plan_code VARCHAR(30) NOT NULL DEFAULT 'free',
  subscription_status VARCHAR(30) NULL,
  current_period_end DATETIME NULL,
  cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_sub_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS usage_counters (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  feature_code VARCHAR(60) NOT NULL,
  period_month VARCHAR(7) NOT NULL,
  used_count INT NOT NULL DEFAULT 0,
  UNIQUE KEY uniq_usage (user_id, feature_code, period_month),
  CONSTRAINT fk_usage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Stripeを使わないローカル運用でも参照だけされるため一応作成（未使用でもOK）
CREATE TABLE IF NOT EXISTS payment_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL UNIQUE,
  event_type VARCHAR(100) NOT NULL,
  payload JSON NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- sessions テーブルは express-mysql-session が自動作成するので、ここでは不要です。
