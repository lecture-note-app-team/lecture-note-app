# 変更内容まとめ（2026-07）

## 1. 導入手順

1. `migration_2026_07.sql` をRailwayのMySQLに対して実行してください（バックアップ推奨）。
2. `server.js` を丸ごと置き換えてください。
3. `public/` 配下の以下ファイルを追加・置き換えてください。
   - 追加: `mindmap.html`, `mindmap.js`, `reviews.js`
   - 置き換え: `index.html`, `mypage.html`, `note_detail.html`, `style.css`
4. `services/quizGenerator.js` は変更していません（元のままでOK）。
5. 環境変数は追加不要です（既存の `OPENAI_QUIZ_MODEL` / `OPENAI_OCR_MODEL` をそのまま使います。未設定なら `gpt-4.1-mini`）。

## 2. 実装した4つの機能

### (1) AI接続の整理
- モデル指定を `AI_MODELS`（quiz / ocr / mindmap）に一元化。すべて `gpt-4.1-mini`（安価なモデル）を既定値に統一。
- 未使用だった旧関数 `generateQuizzesWithAI`（二重実装で使われていなかった）を削除。
- OpenAIのままにした理由・料金の考え方はチャットで説明した通りです（個人利用なら月に大きな額にはなりません）。

### (2) 自動クイズ作成を1回きりに制限
- `notes` テーブルに `ai_quiz_generated_at` を追加。
- `/api/notes/:id/generate-quiz`（`/quizzes/generate` も同じ）で、すでに生成済みなら `409` を返して再生成をブロック。
- `note_detail.html` は生成済みなら「AIでクイズ生成」ボタンを自動で無効化し、実行日時を表示します。
- 手動でのクイズ追加（クイズ作成ページ）は今まで通り何度でも可能です。

### (3) マインドマップ（自動生成＋手動編集）
- 新テーブル `note_mindmaps`（ノートごとに1件、JSON保存）。
- API:
  - `POST /api/notes/:id/mindmap/generate` … 本文からAIがツリー構造を生成し、座標付きレイアウトに変換して保存
  - `GET /api/notes/:id/mindmap` … 取得
  - `PUT /api/notes/:id/mindmap` … 手動編集後の保存（ノード追加・削除・移動・ラベル編集）
- 新ページ `mindmap.html` / `mindmap.js`：ノードはドラッグで移動、クリックで選択して追加・削除・ラベル編集ができます。
- `note_detail.html` にマインドマップへのリンクを追加しました。

### (4) 復習通知（サイト内バッジ）
- 新テーブル `note_review_schedules`：間隔反復方式（1日→3日→7日→14日→30日）でリマインド日を管理。
- ノート保存時に自動で初回リマインド（1日後）を登録。
- API:
  - `GET /api/reviews/due` … 復習が必要なノート一覧
  - `POST /api/reviews/:noteId/done` … 「復習した」を記録し、次回リマインドを再計算
- `reviews.js` を `index.html` / `mypage.html` / `note_detail.html` に追加。ログイン中は画面右上にバッジが表示され、件数と一覧を確認できます（サイトを開いていないときの通知はしません＝ご要望通り）。

## 3. 未対応・注意点

- マインドマップの手動編集はシンプルな実装です（ドラッグ移動・ラベル編集・追加削除のみ）。線の太さや色分けなどの装飾は未対応です。
- 復習通知は「サイトを開いたときにバッジで分かる」方式のみです。プッシュ通知やメールには対応していません。
- 「1回きり」制限は生成ボタン単位です。もし将来「Proプランなら再生成可」のような差別化をしたい場合は `requireUsageLimit` と同様の分岐を `ai_quiz_generated_at` チェックの前に追加してください。
