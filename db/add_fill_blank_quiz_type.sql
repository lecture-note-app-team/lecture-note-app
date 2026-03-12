-- 穴埋め問題タイプを追加
-- MySQL 8.x を想定

-- user_quizzes の quiz_type が ENUM の場合
ALTER TABLE user_quizzes
  MODIFY COLUMN quiz_type ENUM('multiple_choice','written','true_false','fill_blank') NOT NULL;

-- note_quizzes の type が ENUM の場合のみ実行してください（VARCHARなら不要）
-- ALTER TABLE note_quizzes
--   MODIFY COLUMN type ENUM('qa','term','tf','multiple_choice','written','true_false','fill_blank') NOT NULL;
