-- user-created quizzes schema
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

-- add feature codes for usage_counters (no schema change needed, just inserted by app at runtime)
