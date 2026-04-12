/**
 * server.js（全文貼り替え版）
 * - Auth（register/login/logout/me）
 * - Communities（作成/参加/自分の参加一覧）
 * - Notes（公開一覧/詳細/preview/投稿/マイノート一覧/削除/公開切替）
 * - Quizzes（一覧/生成：rule or ai/編集/削除）
 *
 * 前提DB:
 * - notes に community_id カラムがある（ALTER済み）
 * - note_quizzes テーブルがある
 * - universities / users / communities / user_communities / notes がある
 *
 * Railway Variables:
 * DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_PORT
 * SESSION_SECRET
 * OPENAI_API_KEY
 * NODE_ENV=production
 */

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT_EXCEPTION:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED_REJECTION:", reason);
});

console.log("BOOT: server.js loaded");
console.log("BOOT: NODE_ENV=", process.env.NODE_ENV);
console.log("BOOT: PORT=", process.env.PORT);

// ローカルだけdotenv（Railway本番はVariablesを使う）
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const path = require("path");
const mysqlPromise = require("mysql2/promise"); // ← アプリ用（今まで通り）
const mysql2 = require("mysql2");               // ← セッションStore用（追加）
const session = require("express-session");
const MySQLStore = require("express-mysql-session")(session);
const bcrypt = require("bcrypt");
const OpenAI = require("openai");
const { generateQuizzesWithQualityPipeline } = require("./services/quizGenerator");

// ---------- OpenAI ----------
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing");
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

const app = express();

const StripeLib = process.env.STRIPE_SECRET_KEY ? require("stripe") : null;
const stripe = StripeLib ? new StripeLib(process.env.STRIPE_SECRET_KEY) : null;
const jstDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function toJstDateKey(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return jstDateFormatter.format(date);
}

function attachJstDateKey(rows, sourceField = "created_at", targetField = "created_date_jst") {
  return rows.map((row) => ({
    ...row,
    [targetField]: toJstDateKey(row[sourceField]),
  }));
}

function normalizeSortOrder(rawValue) {
  return String(rawValue || "").toLowerCase() === "asc" ? "ASC" : "DESC";
}

function parseDateFilter(rawDate) {
  const value = String(rawDate || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function parseMonthFilter(rawMonth) {
  const value = String(rawMonth || "").trim();
  return /^\d{4}-\d{2}$/.test(value) ? value : "";
}

// Railwayなどプロキシ配下
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// ---------- Middlewares ----------
app.use(express.json({
  limit: "10mb",
  verify: (req, res, buf) => {
    if (req.originalUrl === "/api/billing/webhook") {
      req.rawBody = buf;
    }
  },
}));
app.use(express.urlencoded({ extended: true }));

// ---------- Session Store ----------
const sessionDb = mysql2.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const sessionStore = new MySQLStore(
  {
    clearExpired: true,
    checkExpirationInterval: 1000 * 60 * 15,
    expiration: 1000 * 60 * 60 * 24 * 7,
    createDatabaseTable: true,
    schema: {
      tableName: "sessions",
      columnNames: {
        session_id: "session_id",
        expires: "expires",
        data: "data",
      },
    },
  },
  sessionDb
);

app.use(
  session({
    name: "sid",
    secret: process.env.SESSION_SECRET || "dev_secret_change_me",
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // Railway本番はtrue
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7日
    },
  })
);


// リクエストログ（必要なら消してOK）
app.use((req, res, next) => {
  console.log("REQ:", req.method, req.path);
  next();
});

// 静的配信
app.use(express.static(path.join(__dirname, "public")));

// ---------- DB Pool ----------
const pool = mysqlPromise.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT || 3306),
  waitForConnections: true,
  connectionLimit: 10,
});

const OCR_ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const OCR_ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const OCR_MAX_FILE_SIZE_BYTES = 6 * 1024 * 1024;

// --------権限チェック関数-------(admin/memberが承認OK)
async function userRoleInCommunity(userId, communityId) {
  const [rows] = await pool.query(
    `SELECT role
       FROM user_communities
      WHERE user_id = ? AND community_id = ?
      LIMIT 1`,
    [userId, communityId]
  );
  return rows.length ? rows[0].role : null; // 'admin' | 'member' | null
}

// ---------- Helpers ----------
function requireLogin(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ message: "ログインしてください" });
  }
  next();
}

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function normalizeVisibility(v) {
  return v === "private" ? "private" : "public";
}

function slugifyJP(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_ぁ-んァ-ン一-龥]/g, "")
    .slice(0, 80);
}

async function userBelongsToCommunity(userId, communityId) {
  const [rows] = await pool.query(
    `SELECT 1
       FROM user_communities
      WHERE user_id = ? AND community_id = ?
      LIMIT 1`,
    [userId, communityId]
  );
  return rows.length > 0;
}

function buildMarkdown({ course_name, lecture_no, lecture_date, title, body_raw }) {
  const lines = String(body_raw || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const important = [];
  const questions = [];
  const terms = [];
  const todos = [];
  const main = [];

  for (const l of lines) {
    if (l.includes("★") || l.toLowerCase().startsWith("important:")) important.push(l);
    if (l.includes("？") || l.endsWith("?") || l.endsWith("？")) questions.push(l);
    if (l.startsWith("用語:")) terms.push(l.replace(/^用語:\s*/, ""));
    if (l.toUpperCase().startsWith("TODO:")) todos.push(l.replace(/^TODO:\s*/i, ""));
    main.push(l);
  }

  return `
# ${title}

- 授業名：${course_name}
- 回：${lecture_no}
- 日付：${lecture_date}

## 重要ポイント：★
${important.length ? important.map((x) => `- ${x}`).join("\n") : "- （なし）"}

## 本文
${main.map((x) => `- ${x}`).join("\n")}

## 用語集：用語
${terms.length ? terms.map((x) => `- ${x}`).join("\n") : "- （なし）"}

## 疑問・確認したいこと：？
${questions.length ? questions.map((x) => `- ${x}`).join("\n") : "- （なし）"}

## TODO・課題：課題
${todos.length ? todos.map((x) => `- ${x}`).join("\n") : "- （なし）"}

## まとめ：まとめ
- （あとで追記）
`.trim();
}

async function getOrCreateUniversityId(name) {
  const uniName = String(name || "").trim();
  if (!uniName) throw new Error("university_name is required");

  const [rows] = await pool.query("SELECT id FROM universities WHERE name = ?", [uniName]);
  if (rows.length) return rows[0].id;

  try {
    const [result] = await pool.query("INSERT INTO universities (name) VALUES (?)", [uniName]);
    return result.insertId;
  } catch (e) {
    const [rows2] = await pool.query("SELECT id FROM universities WHERE name = ?", [uniName]);
    if (rows2.length) return rows2[0].id;
    throw e;
  }
}

async function getNoteById(noteId) {
  const [rows] = await pool.query("SELECT * FROM notes WHERE id = ?", [noteId]);
  return rows.length ? rows[0] : null;
}

async function canViewNote(req, note) {
  if (!note) return { ok: false, status: 404, message: "not found" };

  if (note.community_id) {
    if (!req.session?.userId) return { ok: false, status: 401, message: "ログインしてください" };
    const belongs = await userBelongsToCommunity(req.session.userId, note.community_id);
    if (!belongs) return { ok: false, status: 403, message: "forbidden" };
    return { ok: true };
  }

  if (note.visibility === "private") {
    if (!req.session?.userId) return { ok: false, status: 401, message: "ログインしてください" };
    if (note.user_id !== req.session.userId) return { ok: false, status: 403, message: "forbidden" };
  }

  return { ok: true };
}

function canEditNote(req, note) {
  if (!req.session?.userId) return { ok: false, status: 401, message: "ログインしてください" };
  if (!note) return { ok: false, status: 404, message: "not found" };
  if (note.user_id !== req.session.userId) return { ok: false, status: 403, message: "forbidden" };
  return { ok: true };
}

function validateUserQuizPayload(payload = {}) {
  const parseChoiceArray = (raw) => {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    try {
      const parsed = JSON.parse(String(raw));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const normalizeChoiceValue = (...candidates) => {
    for (const candidate of candidates) {
      if (candidate == null) continue;
      const value = String(candidate).trim();
      if (value) return value;
    }
    return null;
  };
  const incomingChoices = parseChoiceArray(payload.choices).length
    ? parseChoiceArray(payload.choices)
    : parseChoiceArray(payload.options);

  const titleRaw = String(payload.title || "").trim();
  const questionText = String(payload.question_text || payload.questionText || "").trim();
  const quizType = String(payload.quiz_type || payload.quizType || "").trim();
  const correctAnswer = String(payload.correct_answer || payload.correctAnswer || "").trim();
  const explanation = payload.explanation == null ? null : String(payload.explanation).trim();
  const visibility = String(payload.visibility || "private").trim() === "community" ? "community" : "private";
  const noteId = payload.note_id == null || payload.note_id === "" ? null : Number(payload.note_id);

  const normalized = {
    title: titleRaw || "無題のクイズ",
    note_id: Number.isFinite(noteId) && noteId > 0 ? noteId : null,
    question_text: questionText,
    quiz_type: quizType,
    correct_answer: correctAnswer,
    explanation,
    visibility,
    choice_1: normalizeChoiceValue(payload.choice_1, payload.option_1, incomingChoices[0]),
    choice_2: normalizeChoiceValue(payload.choice_2, payload.option_2, incomingChoices[1]),
    choice_3: normalizeChoiceValue(payload.choice_3, payload.option_3, incomingChoices[2]),
    choice_4: normalizeChoiceValue(payload.choice_4, payload.option_4, incomingChoices[3]),
  };

  const errors = [];
  if (!normalized.question_text) errors.push("問題文は必須です");
  if (!normalized.note_id) errors.push("note_id は必須です");
  if (!normalized.quiz_type) errors.push("クイズ形式は必須です");
  if (!normalized.correct_answer) errors.push("正解は必須です");

  if (normalized.title.length > 100) errors.push("タイトルは100文字以内で入力してください");
  if (normalized.question_text.length > 500) errors.push("問題文は500文字以内で入力してください");
  if (normalized.correct_answer.length > 200) errors.push("正解は200文字以内で入力してください");
  if (normalized.explanation && normalized.explanation.length > 1000) {
    errors.push("解説は1000文字以内で入力してください");
  }

  if (!["multiple_choice", "written", "true_false", "fill_blank"].includes(normalized.quiz_type)) {
    errors.push("quiz_type は multiple_choice / written / true_false / fill_blank のいずれかを指定してください");
  }

  if (normalized.quiz_type === "multiple_choice") {
    const choices = [normalized.choice_1, normalized.choice_2, normalized.choice_3, normalized.choice_4].map((c) => String(c || "").trim());
    if (choices.some((c) => !c)) errors.push("4択問題では選択肢4件が必要です");
    if (choices.some((c) => c.length > 100)) errors.push("選択肢は各100文字以内で入力してください");

    const unique = new Set(choices);
    if (unique.size !== choices.length) errors.push("選択肢同士の重複は禁止です");
    if (!choices.includes(normalized.correct_answer)) {
      errors.push("4択問題の正解は4つの選択肢のいずれかと一致している必要があります");
    }
  }

  if (normalized.quiz_type === "true_false" && !["○", "×"].includes(normalized.correct_answer)) {
    errors.push("○×問題の正解は「○」または「×」のみです");
  }

  if (normalized.quiz_type === "fill_blank") {
    const hasBlankMarker =
      /_{3,}/.test(normalized.question_text) ||
      /（[　\s]+）/.test(normalized.question_text) ||
      /\([　\s]+\)/.test(normalized.question_text);

    if (!hasBlankMarker) {
      errors.push("穴埋め問題では、問題文に空欄（例：（　　　）や ___）を含めてください");
    }
  }

  if (normalized.quiz_type !== "multiple_choice") {
    normalized.choice_1 = null;
    normalized.choice_2 = null;
    normalized.choice_3 = null;
    normalized.choice_4 = null;
  }

  return { normalized, errors };
}

let noteQuizColumnsCache = null;

async function getNoteQuizColumns() {
  if (noteQuizColumnsCache) return noteQuizColumnsCache;
  const [rows] = await pool.query("SHOW COLUMNS FROM note_quizzes");
  noteQuizColumnsCache = new Set(rows.map((row) => String(row.Field || "").toLowerCase()));
  return noteQuizColumnsCache;
}

function parseJsonArraySafe(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((v) => String(v || "").trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v) => String(v || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function extractChoicesFromQuestionText(questionText) {
  const lines = String(questionText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed = [];
  for (const line of lines) {
    const match = line.match(/^(?:[1-4][\.)．、]|[①-④]|[Ａ-ＤA-D][\.)．、:：]|[a-d][\.)．、:：])\s*(.+)$/u);
    if (match?.[1]) parsed.push(match[1].trim());
    if (parsed.length === 4) break;
  }
  return parsed;
}

function normalizeQuizChoices(row = {}) {
  const directChoices = [row.choice_1, row.choice_2, row.choice_3, row.choice_4, row.option_1, row.option_2, row.option_3, row.option_4]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  if (directChoices.length) {
    return {
      ...row,
      choice_1: directChoices[0] || null,
      choice_2: directChoices[1] || null,
      choice_3: directChoices[2] || null,
      choice_4: directChoices[3] || null,
      options: JSON.stringify(directChoices),
      choices: JSON.stringify(directChoices),
    };
  }

  const jsonChoices = parseJsonArraySafe(row.choices).length
    ? parseJsonArraySafe(row.choices)
    : parseJsonArraySafe(row.options);
  const fallbackChoices = jsonChoices.length ? jsonChoices : extractChoicesFromQuestionText(row.question_text);

  return {
    ...row,
    choice_1: fallbackChoices[0] || null,
    choice_2: fallbackChoices[1] || null,
    choice_3: fallbackChoices[2] || null,
    choice_4: fallbackChoices[3] || null,
    options: fallbackChoices.length ? JSON.stringify(fallbackChoices) : row.options,
    choices: fallbackChoices.length ? JSON.stringify(fallbackChoices) : row.choices,
  };
}

async function buildNoteQuizSelectChoiceFragments() {
  const columns = await getNoteQuizColumns();
  return {
    choice1: columns.has("choice_1") ? "choice_1" : "NULL AS choice_1",
    choice2: columns.has("choice_2") ? "choice_2" : "NULL AS choice_2",
    choice3: columns.has("choice_3") ? "choice_3" : "NULL AS choice_3",
    choice4: columns.has("choice_4") ? "choice_4" : "NULL AS choice_4",
    choices: columns.has("choices") ? "choices" : "NULL AS choices",
    options: columns.has("options") ? "options" : "NULL AS options",
  };
}

async function generateQuizzesWithAI({ title, course_name, body_raw }) {
  const openai = getOpenAIClient();
  const body = String(body_raw || "").slice(0, 8000);

  const system = `
あなたは講義ノートから復習用クイズを作る教材作成者です。
返答は必ず「JSONのみ」。余計な文章は禁止。
`.trim();

  const user = `
次の本文から復習用クイズを作ってください。

【出力形式（厳守）】
{
  "quizzes": [
    { "type": "term|qa|tf", "question": "…", "answer": "…", "source_line": "…" }
  ]
}

【ルール】
- quizzesは5〜15問
- term: 用語の定義確認
- qa: 理解を問う質問（答えも付ける）
- tf: ○×（answerは「正しい」か「誤り」）
- question/answer は日本語で簡潔に
- source_line は本文の該当箇所を短く引用（なければ null）
- 絶対にJSON以外を出力しない

【ノート情報】
タイトル: ${title || ""}
授業名: ${course_name || ""}

【本文】
${body}
`.trim();

  const resp = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.4,
  });

  const text = resp.choices?.[0]?.message?.content || "";

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("AIの返答がJSONとして解析できませんでした");
    parsed = JSON.parse(m[0]);
  }

  const quizzes = Array.isArray(parsed?.quizzes) ? parsed.quizzes : [];

  return quizzes
    .filter((q) => q && typeof q.question === "string" && q.question.trim())
    .slice(0, 15)
    .map((q) => ({
      type: String(q.type || "qa").slice(0, 20),
      question: String(q.question || "").trim().slice(0, 300),
      answer: q.answer == null ? "" : String(q.answer).trim().slice(0, 500),
      source_line: q.source_line == null ? null : String(q.source_line).trim().slice(0, 200),
    }));
}

async function generateQuizzesForNote(note, options = {}) {
  const openai = getOpenAIClient();
  const noteWithQuizType = {
    ...note,
    requested_quiz_type: options.quizType || "auto",
  };

  return generateQuizzesWithQualityPipeline({
    openai,
    note: noteWithQuizType,
    targetCount: options.limit || 10,
    logger: console,
  });
}

async function getPlanContextForUser(userId) {
  const subscription = await getUserSubscription(userId);
  const planCode = resolvePlanCode(subscription);
  const features = PLAN_FEATURES[planCode] || PLAN_FEATURES.free;
  return { subscription, planCode, features };
}

async function ensureNoteSaveAvailable(userId) {
  const plan = await getPlanContextForUser(userId);
  const maxNotes = Number(plan.features?.max_notes ?? -1);
  if (maxNotes < 0) return { ok: true, ...plan };

  const [rows] = await pool.query(
    `SELECT COUNT(*) AS note_count
       FROM notes
      WHERE user_id = ?`,
    [userId]
  );
  const currentCount = Number(rows?.[0]?.note_count || 0);
  if (currentCount >= maxNotes) {
    return {
      ok: false,
      ...plan,
      currentCount,
      maxNotes,
      message: "無料プランではノート保存は30件までです。有料プランで無制限になります。",
    };
  }
  return { ok: true, ...plan, currentCount, maxNotes };
}

async function extractTextFromImageWithOpenAI({ base64Image, mimetype }) {
  if (!base64Image || !mimetype) {
    throw new Error("IMAGE_FILE_REQUIRED");
  }

  const openai = getOpenAIClient();
  const dataUri = `data:${mimetype};base64,${base64Image}`;

  const prompt = [
    "あなたはOCRエンジンです。与えられたノート画像から読める文字だけを抽出してください。",
    "出力はプレーンテキストのみ。説明・補足・Markdown記法は不要です。",
    "読めない箇所は無理に補完せず、省略してください。",
  ].join("\n");

  const resp = await openai.responses.create({
    model: process.env.OPENAI_OCR_MODEL || "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: dataUri },
        ],
      },
    ],
  });

  const text = String(resp.output_text || "").trim();
  if (!text) {
    const err = new Error("OCR_EMPTY_RESULT");
    err.statusCode = 422;
    throw err;
  }
  return text;
}

// 自分の参加コミュ一覧（コミュ名 + メンバー数つき）
app.get("/api/communities/mine", requireLogin, wrap(async (req, res) => {
  const userId = req.session.userId;

  const [rows] = await pool.query(
    `SELECT
        c.id,
        c.name AS name,
        uc.role,
        uc.joined_at,
        (SELECT COUNT(*) FROM user_communities uc2 WHERE uc2.community_id = c.id) AS member_count
     FROM user_communities uc
     JOIN communities c ON c.id = uc.community_id
     WHERE uc.user_id = ?
     ORDER BY uc.joined_at DESC`,
    [userId]
  );

  res.json(rows);
}));


// ---------- Routes: Health & Top ----------
app.get("/health", (req, res) => res.status(200).send("ok"));

app.get("/api/health", wrap(async (req, res) => {
  const [r] = await pool.query("SELECT 1 AS ok");
  res.json({ ok: true, db: r?.[0]?.ok === 1 });
}));

// "/" は index.html を返す（無ければ ok）
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"), (err) => {
    if (err) return res.status(200).send("ok");
  });
});

// ---------- Auth APIs ----------
app.get("/api/me", (req, res) => {
  if (!req.session?.userId) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, id: req.session.userId, username: req.session.username });
});

app.post("/api/register", wrap(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!username || password.length < 6) {
    return res.status(400).json({ message: "invalid username/password" });
  }

  const hash = await bcrypt.hash(password, 10);

  try {
    const [result] = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES (?, ?)",
      [username, hash]
    );

    req.session.userId = result.insertId;
    req.session.username = username;

    return res.json({ userId: result.insertId, username });
  } catch (e) {
    // username UNIQUE 想定
    return res.status(400).json({ message: "username already used" });
  }
}));

app.post("/api/login", wrap(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  const [rows] = await pool.query(
    "SELECT id, password_hash FROM users WHERE username = ?",
    [username]
  );
  if (!rows.length) return res.status(401).json({ message: "invalid credentials" });

  const ok = await bcrypt.compare(password, rows[0].password_hash);
  if (!ok) return res.status(401).json({ message: "invalid credentials" });

  req.session.userId = rows[0].id;
  req.session.username = username;
  res.json({ userId: rows[0].id, username });
}));

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---- 以下、Communities / Notes / Quizzes は「あなたの今のコード」をこの下にそのまま続けてOK ----
// ここから下は、あなたが貼ってくれた既存のままで大丈夫。
// （app.get("/") を追加しないことだけ注意）

// ---------- Communities APIs (B方式) ----------
// ...（ここ以降は今のコードをそのまま貼る）...

// 参加申請一覧（pending）: そのコミュの member/admin が見れる
app.get("/api/communities/:id/join-requests", requireLogin, wrap(async (req, res) => {
  const communityId = Number(req.params.id);
  const userId = req.session.userId;

  if (!communityId) return res.status(400).json({ message: "invalid community id" });

  const role = await userRoleInCommunity(userId, communityId);
  if (!role) return res.status(403).json({ message: "members only" });

  const [rows] = await pool.query(
    `SELECT r.id, r.user_id, u.username, r.message, r.created_at
       FROM community_join_requests r
       JOIN users u ON u.id = r.user_id
      WHERE r.community_id = ? AND r.status = 'pending'
      ORDER BY r.created_at ASC`,
    [communityId]
  );

  res.json({ requests: rows });
}));

app.post("/api/join-requests/:requestId/decide", requireLogin, wrap(async (req, res) => {
  const requestId = Number(req.params.requestId);
  const action = String(req.body?.action || ""); // 'approve' | 'reject'
  const deciderId = req.session.userId;

  if (!requestId) return res.status(400).json({ message: "invalid request id" });
  if (!["approve", "reject"].includes(action)) {
    return res.status(400).json({ message: "invalid action" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rrows] = await conn.query(
      `SELECT id, community_id, user_id, status
         FROM community_join_requests
        WHERE id = ?
        FOR UPDATE`,
      [requestId]
    );
    if (!rrows.length) return res.status(404).json({ message: "not found" });

    const reqRow = rrows[0];
    if (reqRow.status !== "pending") return res.status(400).json({ message: "already decided" });

    const [urole] = await conn.query(
      `SELECT role
         FROM user_communities
        WHERE user_id = ? AND community_id = ?
        LIMIT 1`,
      [deciderId, reqRow.community_id]
    );
    if (!urole.length) return res.status(403).json({ message: "members only" });

    if (action === "approve") {
      await conn.query(
        `INSERT IGNORE INTO user_communities (user_id, community_id, role)
         VALUES (?, ?, 'member')`,
        [reqRow.user_id, reqRow.community_id]
      );

      await conn.query(
        `UPDATE community_join_requests
            SET status='approved', decided_at=NOW(), decided_by=?
          WHERE id=?`,
        [deciderId, requestId]
      );
    } else {
      await conn.query(
        `UPDATE community_join_requests
            SET status='rejected', decided_at=NOW(), decided_by=?
          WHERE id=?`,
        [deciderId, requestId]
      );
    }

    await conn.commit();
    res.json({ ok: true, action });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}));

// ---------- Communities APIs (B方式) ----------

// コミュ作成（作成者をadminで参加させる）
app.post("/api/communities", requireLogin, wrap(async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const join_code = String(req.body?.join_code || "");

  if (!name || !join_code) return res.status(400).json({ message: "missing fields" });
  if (name.length > 100) return res.status(400).json({ message: "name too long" });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const joinHash = await bcrypt.hash(join_code, 10);
    const slug = slugifyJP(name) + "-" + Date.now();

    const [r1] = await conn.query(
      "INSERT INTO communities (name, slug, join_code_hash) VALUES (?, ?, ?)",
      [name, slug, joinHash]
    );

    const communityId = r1.insertId;

    await conn.query(
      "INSERT INTO user_communities (user_id, community_id, role) VALUES (?, ?, 'admin')",
      [req.session.userId, communityId]
    );

    await conn.commit();
    res.status(201).json({ id: communityId, name });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}));

// 参加（community_id + join_code）
app.post("/api/communities/join", requireLogin, wrap(async (req, res) => {
  const communityId = Number(req.body?.community_id);
  const join_code = String(req.body?.join_code || "");

  if (!communityId || !join_code) return res.status(400).json({ message: "missing fields" });

  const [rows] = await pool.query(
    "SELECT id, name, join_code_hash FROM communities WHERE id = ? LIMIT 1",
    [communityId]
  );
  if (!rows.length) return res.status(404).json({ message: "community not found" });

  const c = rows[0];
  const ok = await bcrypt.compare(join_code, c.join_code_hash);
  if (!ok) return res.status(403).json({ message: "invalid join code" });

  await pool.query(
    "INSERT IGNORE INTO user_communities (user_id, community_id, role) VALUES (?, ?, 'member')",
    [req.session.userId, c.id]
  );

  res.json({ ok: true, id: c.id, name: c.name });
}));


// コミュ削除（解散）: 管理者のみ
app.delete("/api/communities/:id", requireLogin, wrap(async (req, res) => {
  const communityId = Number(req.params.id);
  const userId = req.session.userId;

  if (!communityId) return res.status(400).json({ message: "invalid community id" });

  // 自分がそのコミュの admin か確認
  const [rows] = await pool.query(
    `SELECT role
       FROM user_communities
      WHERE user_id = ? AND community_id = ?
      LIMIT 1`,
    [userId, communityId]
  );

  if (!rows.length) return res.status(403).json({ message: "not a member" });
  if (rows[0].role !== "admin") return res.status(403).json({ message: "admin only" });

  // communities を削除（user_communitiesはCASCADE, notes.community_idはSET NULL）
  const [r] = await pool.query("DELETE FROM communities WHERE id = ? LIMIT 1", [communityId]);
  if (r.affectedRows === 0) return res.status(404).json({ message: "community not found" });

  res.json({ ok: true, deleted: communityId });
}));

// ---------- Notes APIs ----------

// 公開一覧（誰でも閲覧OK）: 大学名必須、授業名(course)は任意、publicのみ表示
// コミュ内ノートは漏れ防止で一覧から除外（community_id IS NULL）
app.get("/api/notes", wrap(async (req, res) => {
  const university_name = String(req.query.university_name || "").trim();
  const course = String(req.query.course || "").trim();

  if (!university_name) return res.json([]);

  const [urows] = await pool.query("SELECT id FROM universities WHERE name = ?", [university_name]);
  if (!urows.length) return res.json([]);

  const univId = urows[0].id;

  let rows;
  if (course) {
    [rows] = await pool.query(
      `SELECT id, source_type, university_id, author_name, course_name, lecture_no, lecture_date, title, created_at
         FROM notes
        WHERE university_id = ? AND visibility = 'public' AND community_id IS NULL AND course_name LIKE ?
        ORDER BY lecture_date DESC, id DESC`,
      [univId, `%${course}%`]
    );
  } else {
    [rows] = await pool.query(
      `SELECT id, source_type, university_id, author_name, course_name, lecture_no, lecture_date, title, created_at
         FROM notes
        WHERE university_id = ? AND visibility = 'public' AND community_id IS NULL
        ORDER BY lecture_date DESC, id DESC`,
      [univId]
    );
  }

  res.json(attachJstDateKey(rows));
}));

// 自分が所属しているコミュニティ内のノート一覧（ログイン必須）
app.get("/api/community-notes", requireLogin, wrap(async (req, res) => {
  const userId = req.session.userId;
  const date = parseDateFilter(req.query.date);
  const search = String(req.query.search || "").trim();
  const sortOrder = normalizeSortOrder(req.query.sort);

  // 自分が所属しているコミュID一覧
  const [crows] = await pool.query(
    `SELECT community_id FROM user_communities WHERE user_id = ?`,
    [userId]
  );
  if (!crows.length) return res.json([]);

  const ids = crows.map(r => r.community_id);

  // そのコミュ内ノートを取得（誰が書いたものでも）
  // ※ notes に community_id が入っている前提
  let sql = `SELECT
        n.id, n.community_id, n.user_id, n.visibility, n.source_type,
        n.author_name, n.course_name, n.lecture_no, n.lecture_date, n.title, n.body_raw, n.created_at,
        c.name AS community_name
     FROM notes n
     JOIN communities c ON c.id = n.community_id
     WHERE n.community_id IN (?)
       AND (COALESCE(n.visibility, 'private') <> 'private' OR n.user_id = ?)`;
  const params = [ids, userId];
  if (date) {
    sql += " AND DATE(CONVERT_TZ(n.created_at, '+00:00', '+09:00')) = ?";
    params.push(date);
  }
  if (search) {
    sql += " AND (n.title LIKE ? OR n.body_raw LIKE ? OR n.course_name LIKE ?)";
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ` ORDER BY n.created_at ${sortOrder}, n.id ${sortOrder}`;

  const [rows] = await pool.query(sql, params);

  res.json(attachJstDateKey(rows));
}));

app.get("/api/community-notes/calendar-summary", requireLogin, wrap(async (req, res) => {
  const userId = req.session.userId;
  const month = parseMonthFilter(req.query.month);
  if (!month) return res.status(400).json({ message: "month(YYYY-MM) is required" });

  const [crows] = await pool.query(
    `SELECT community_id FROM user_communities WHERE user_id = ?`,
    [userId]
  );
  if (!crows.length) return res.json({ month, days: [] });
  const ids = crows.map(r => r.community_id);

  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(CONVERT_TZ(n.created_at, '+00:00', '+09:00'), '%Y-%m-%d') AS date,
            COUNT(*) AS count
       FROM notes n
      WHERE n.community_id IN (?)
        AND (COALESCE(n.visibility, 'private') <> 'private' OR n.user_id = ?)
        AND DATE_FORMAT(CONVERT_TZ(n.created_at, '+00:00', '+09:00'), '%Y-%m') = ?
      GROUP BY date
      ORDER BY date ASC`,
    [ids, userId, month]
  );
  res.json({ month, days: rows });
}));

// 詳細：閲覧権限に従う（community or private）

app.get("/api/community-quizzes", requireLogin, wrap(async (req, res) => {
  const userId = req.session.userId;
  const date = parseDateFilter(req.query.date);
  const search = String(req.query.search || "").trim();
  const sortOrder = normalizeSortOrder(req.query.sort);
  const choiceSelect = await buildNoteQuizSelectChoiceFragments();

  const [crows] = await pool.query(
    `SELECT community_id FROM user_communities WHERE user_id = ?`,
    [userId]
  );
  if (!crows.length) return res.json([]);
  const ids = crows.map((r) => r.community_id);

  let sql = `SELECT nq.id,
                    nq.note_id,
                    CONCAT('ノートクイズ #', nq.id) AS title,
                    nq.question AS question_text,
                    nq.type AS quiz_type,
                    ${choiceSelect.choice1},
                    ${choiceSelect.choice2},
                    ${choiceSelect.choice3},
                    ${choiceSelect.choice4},
                    ${choiceSelect.choices},
                    ${choiceSelect.options},
                    nq.answer AS correct_answer,
                    nq.created_at,
                    nq.updated_at,
                    n.community_id,
                    c.name AS community_name
               FROM note_quizzes nq
               JOIN notes n ON n.id = nq.note_id
               JOIN communities c ON c.id = n.community_id
              WHERE n.community_id IN (?)
                AND (COALESCE(n.visibility, 'private') <> 'private' OR n.user_id = ?)`;
  const params = [ids, userId];

  if (date) {
    sql += " AND DATE(CONVERT_TZ(nq.created_at, '+00:00', '+09:00')) = ?";
    params.push(date);
  }
  if (search) {
    sql += " AND (nq.question LIKE ? OR nq.answer LIKE ?)";
    params.push(`%${search}%`, `%${search}%`);
  }
  sql += ` ORDER BY nq.created_at ${sortOrder}, nq.id ${sortOrder}`;

  const [rows] = await pool.query(sql, params);
  const normalizedRows = rows.map((row) => normalizeQuizChoices(row));
  res.json(normalizedRows);
}));

app.get("/api/community-quizzes/calendar-summary", requireLogin, wrap(async (req, res) => {
  const userId = req.session.userId;
  const month = parseMonthFilter(req.query.month);
  if (!month) return res.status(400).json({ message: "month(YYYY-MM) is required" });

  const [crows] = await pool.query(
    `SELECT community_id FROM user_communities WHERE user_id = ?`,
    [userId]
  );
  if (!crows.length) return res.json({ month, days: [] });
  const ids = crows.map((r) => r.community_id);

  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(CONVERT_TZ(nq.created_at, '+00:00', '+09:00'), '%Y-%m-%d') AS date,
            COUNT(*) AS count
       FROM note_quizzes nq
       JOIN notes n ON n.id = nq.note_id
      WHERE n.community_id IN (?)
        AND (COALESCE(n.visibility, 'private') <> 'private' OR n.user_id = ?)
        AND DATE_FORMAT(CONVERT_TZ(nq.created_at, '+00:00', '+09:00'), '%Y-%m') = ?
      GROUP BY date
      ORDER BY date ASC`,
    [ids, userId, month]
  );

  res.json({ month, days: rows });
}));

app.get("/api/notes/:id", wrap(async (req, res) => {
  const id = Number(req.params.id);

  const note = await getNoteById(id);
  if (!note) return res.status(404).json({ message: "not found" });

  const perm = await canViewNote(req, note);
  if (!perm.ok) return res.status(perm.status).json({ message: perm.message });

  res.json(note);
}));

// プレビュー（誰でもOK・保存しない）
app.post("/api/notes/preview", wrap(async (req, res) => {
  const { course_name, lecture_no, lecture_date, title, body_raw } = req.body;

  if (!course_name || !lecture_no || !lecture_date || !title || !body_raw) {
    return res.status(400).json({ message: "missing fields" });
  }

  const body_md = buildMarkdown({ course_name, lecture_no, lecture_date, title, body_raw });
  res.json({ body_md });
}));

app.post("/api/notes/extract-text", requireLogin, requireUsageLimit("ocr_extraction", "ocr_extraction_monthly_limit"), wrap(async (req, res) => {
  const { image_base64, mime_type, file_name, file_size } = req.body || {};
  const mimeType = String(mime_type || "").toLowerCase();
  const fileName = String(file_name || "");
  const ext = path.extname(fileName).toLowerCase();
  const fileSize = Number(file_size || 0);

  if (!image_base64 || !mimeType || !fileName || !fileSize) {
    return res.status(400).json({ message: "画像データが不足しています。", code: "IMAGE_FILE_REQUIRED" });
  }

  if (!OCR_ALLOWED_MIME_TYPES.has(mimeType) || !OCR_ALLOWED_EXTENSIONS.has(ext)) {
    return res.status(400).json({
      message: "対応していない画像形式です。jpg / jpeg / png / webp をアップロードしてください。",
      code: "UNSUPPORTED_IMAGE_TYPE",
    });
  }

  if (fileSize > OCR_MAX_FILE_SIZE_BYTES) {
    return res.status(400).json({
      message: `画像サイズが大きすぎます。最大${Math.floor(OCR_MAX_FILE_SIZE_BYTES / (1024 * 1024))}MBまでです。`,
      code: "FILE_TOO_LARGE",
    });
  }

  const extractedText = await extractTextFromImageWithOpenAI({ base64Image: String(image_base64), mimetype: mimeType });
  if (!extractedText || extractedText.length < 10) {
    return res.status(422).json({
      message: "画像から十分な文字を抽出できませんでした。鮮明な画像で再度お試しください。",
      code: "OCR_TEXT_TOO_SHORT",
    });
  }

  await incrementUsageCount(req.session.userId, "ocr_extraction", 1);

  res.json({
    text: extractedText,
    source_type: "image",
    usage: {
      featureCode: "ocr_extraction",
      usedAfter: (req.usageLimit?.used || 0) + 1,
      limit: req.usageLimit?.limit,
    },
  });
}));

// 保存（投稿）：ログイン必須
// community_id がある場合は所属必須。大学名が空なら「（コミュ）」で補完（DB要件対策）
app.post("/api/notes", requireLogin, wrap(async (req, res) => {
  const user_id = req.session.userId;

  let {
    university_name,
    author_name,
    course_name,
    lecture_no,
    lecture_date,
    title,
    body_raw,
    visibility,
    community_id,
    source_type,
  } = req.body;

  const communityId = community_id ? Number(community_id) : null;
  const sourceType = source_type === "image" ? "image" : "text";

  if (communityId && !String(university_name || "").trim()) {
    university_name = "（コミュ）";
  }

  if (!university_name || !course_name || !lecture_no || !lecture_date || !title || !body_raw) {
    return res.status(400).json({ message: "missing fields" });
  }

  if (communityId) {
    const belongs = await userBelongsToCommunity(user_id, communityId);
    if (!belongs) return res.status(403).json({ message: "not a community member" });
  }

  const noteLimit = await ensureNoteSaveAvailable(user_id);
  if (!noteLimit.ok) {
    return res.status(403).json({
      message: noteLimit.message,
      code: "NOTE_SAVE_LIMIT_EXCEEDED",
      limit: noteLimit.maxNotes,
      current: noteLimit.currentCount,
    });
  }

  const university_id = await getOrCreateUniversityId(university_name);
  const body_md = buildMarkdown({ course_name, lecture_no, lecture_date, title, body_raw });
  const vis = normalizeVisibility(visibility);

  const [result] = await pool.query(
    `INSERT INTO notes (user_id, community_id, university_id, author_name, course_name, lecture_no, lecture_date, title, body_raw, body_md, visibility, source_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user_id,
      communityId,
      university_id,
      author_name || null,
      course_name,
      lecture_no,
      lecture_date,
      title,
      body_raw,
      body_md,
      vis,
      sourceType,
    ]
  );

  res.status(201).json({ id: result.insertId, source_type: sourceType });
}));

// マイページ：自分のノート一覧（public/private両方、ログイン必須）
app.get("/api/my-notes", requireLogin, wrap(async (req, res) => {
  const userId = req.session.userId;
  const date = parseDateFilter(req.query.date);
  const search = String(req.query.search || "").trim();
  const sortOrder = normalizeSortOrder(req.query.sort);

  let sql = `SELECT id, community_id, visibility, source_type, university_id, author_name, course_name, lecture_no, lecture_date, title, created_at
       FROM notes
      WHERE user_id = ?`;
  const params = [userId];
  if (date) {
    sql += " AND DATE(CONVERT_TZ(created_at, '+00:00', '+09:00')) = ?";
    params.push(date);
  }
  if (search) {
    sql += " AND (title LIKE ? OR body_raw LIKE ? OR course_name LIKE ?)";
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ` ORDER BY created_at ${sortOrder}, id ${sortOrder}`;

  const [rows] = await pool.query(sql, params);

  res.json(attachJstDateKey(rows));
}));

app.get("/api/my-notes/calendar-summary", requireLogin, wrap(async (req, res) => {
  const userId = req.session.userId;
  const month = parseMonthFilter(req.query.month);
  if (!month) return res.status(400).json({ message: "month(YYYY-MM) is required" });

  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(CONVERT_TZ(created_at, '+00:00', '+09:00'), '%Y-%m-%d') AS date,
            COUNT(*) AS count
       FROM notes
      WHERE user_id = ?
        AND DATE_FORMAT(CONVERT_TZ(created_at, '+00:00', '+09:00'), '%Y-%m') = ?
      GROUP BY date
      ORDER BY date ASC`,
    [userId, month]
  );
  res.json({ month, days: rows });
}));

// 自分のノート削除（ログイン必須・本人のみ）
app.delete("/api/notes/:id", requireLogin, wrap(async (req, res) => {
  const userId = req.session.userId;
  const noteId = Number(req.params.id);

  const note = await getNoteById(noteId);
  if (!note) return res.status(404).json({ message: "not found" });

  if (note.user_id !== userId) return res.status(403).json({ message: "forbidden" });

  // note_quizzes は ON DELETE CASCADE の場合自動で消える（無くても notes削除はOK）
  await pool.query("DELETE FROM notes WHERE id = ?", [noteId]);
  res.json({ ok: true });
}));

// 公開/非公開の切り替え（ログイン必須・本人のみ）
// community_id があるノートは切り替え禁止（コミュ所属で守る）
app.patch("/api/notes/:id/visibility", requireLogin, wrap(async (req, res) => {
  const userId = req.session.userId;
  const noteId = Number(req.params.id);
  const visibility = req.body?.visibility;

  const vis = visibility === "private" ? "private" : "public";

  const note = await getNoteById(noteId);
  if (!note) return res.status(404).json({ message: "not found" });

  if (note.user_id !== userId) return res.status(403).json({ message: "forbidden" });

  if (note.community_id) {
    return res.status(400).json({ message: "community note visibility cannot be changed" });
  }

  await pool.query("UPDATE notes SET visibility = ? WHERE id = ?", [vis, noteId]);
  res.json({ ok: true, visibility: vis });
}));

// ---------- Quiz APIs ----------

// クイズ一覧（閲覧権限 = ノート閲覧権限と同じ）
app.get("/api/notes/:id/quizzes", wrap(async (req, res) => {
  const noteId = Number(req.params.id);
  const note = await getNoteById(noteId);

  const perm = await canViewNote(req, note);
  if (!perm.ok) return res.status(perm.status).json({ message: perm.message });

  const userId = req.session?.userId || null;
  const choiceSelect = await buildNoteQuizSelectChoiceFragments();
  const [rows] = await pool.query(
    `SELECT id,
            type,
            question,
            answer,
            source_line,
            ${choiceSelect.choice1},
            ${choiceSelect.choice2},
            ${choiceSelect.choice3},
            ${choiceSelect.choice4},
            ${choiceSelect.choices},
            ${choiceSelect.options},
            created_at,
            updated_at
       FROM note_quizzes
      WHERE note_id = ?
        AND (
          COALESCE(visibility, 'private') = 'community'
          OR user_id = ?
        )
      ORDER BY id ASC`,
    [noteId, userId]
  );

  res.json(rows.map(normalizeQuizChoices));
}));

app.get("/api/notes/:id/user-quizzes", requireLogin, wrap(async (req, res) => {
  const noteId = Number(req.params.id);
  const note = await getNoteById(noteId);
  const perm = canEditNote(req, note);
  if (!perm.ok) return res.status(perm.status).json({ message: perm.message });
  const choiceSelect = await buildNoteQuizSelectChoiceFragments();

  const [rows] = await pool.query(
    `SELECT id,
            CONCAT('ノートクイズ #', id) AS title,
            question AS question_text,
            type AS quiz_type,
            ${choiceSelect.choice1},
            ${choiceSelect.choice2},
            ${choiceSelect.choice3},
            ${choiceSelect.choice4},
            ${choiceSelect.choices},
            ${choiceSelect.options},
            answer AS correct_answer,
            created_at
       FROM note_quizzes
      WHERE note_id = ? AND user_id = ?
      ORDER BY created_at DESC, id DESC`,
    [noteId, req.session.userId]
  );

  res.json({ success: true, data: { quizzes: rows.map(normalizeQuizChoices) } });
}));

// ============================
// 強化版 ルールクイズ生成
// generateQuizzesFromBodyRaw(body_raw) を置き換え用
// ============================

function generateQuizzesFromBodyRaw(bodyRaw, options = {}) {
  const opts = {
    limit: 20,              // 生成上限
    minScore: 3,            // 採用最低スコア
    allowTrueFalse: true,   // 正誤問題を混ぜる
    ...options,
  };

  const lines = String(bodyRaw || "").split(/\r?\n/);
  const normalized = normalizeLines(lines);

  // 文候補を作る（見出し・箇条書き・文章）
  const units = toUnits(normalized); // { text, heading, lineNo }

  // 候補抽出
  let candidates = [];
  for (const u of units) {
    const extracted = extractFromUnit(u);
    candidates.push(...extracted);
  }

  // 品質フィルタ + スコアリング
  candidates = candidates
    .map(c => ({ ...c, score: scoreCandidate(c) }))
    .filter(c => c.score >= opts.minScore)
    .filter(c => isGoodCandidate(c));

  // 重複排除（質問の正規化で）
  candidates = dedupeCandidates(candidates);

  // スコア順に上位を採用
  candidates.sort((a, b) => b.score - a.score);

  // 正誤問題を適度に混ぜる（偏り防止）
  let picked = pickWithVariety(candidates, opts.limit, opts.allowTrueFalse);

    // 0問だったら保険で1問作る（空ノート/短文でも落とさない）
  if (!picked.length) {
    const fallbackUnit = units.find(u => (u.text || "").trim().length >= 25) || units[0];
    if (fallbackUnit?.text) {
      const t = fallbackUnit.text.replace(/[。！？]$/, "");
      const mid = Math.floor(t.length * 0.45);
      picked = [{
        type: "fill",
        question: withHeading(fallbackUnit.heading, t.slice(0, mid) + "（　　　）"),
        answer: t.slice(mid),
        source_line: fallbackUnit.lineNo,
        meta: { kind: "fallback" },
      }];
    }
  }

  // DBに入れる形に整形
  return picked.map(c => ({
    type: c.type || "short",
    question: c.question,
    answer: c.answer ?? "",
    source_line: typeof c.source_line === "number" ? c.source_line : null,
  }));
}

// ---- 前処理: 行をきれいにする ----
function normalizeLines(lines) {
  const out = [];
  let inCode = false;

  for (let i = 0; i < lines.length; i++) {
    let s = lines[i] ?? "";

    // ``` code block
    if (/^\s*```/.test(s)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;

    // 余計なゼロ幅やタブ
    s = s.replace(/\u200B/g, "").replace(/\t/g, " ");

    // URLはノイズになりがち
    s = s.replace(/https?:\/\/\S+/g, "");

    // 行末だけ整える（空行判定は後段の toUnits で）
    s = s.trimEnd();

    out.push({ raw: s, lineNo: i + 1 });
  }

  return out;
}


// ---- ユニット化: 見出し/箇条書きを扱いやすくする ----
function toUnits(normLines) {
  const units = [];
  let currentHeading = "";

  // 箇条書きをまとめるためのバッファ
  let bulletBuf = [];
  let bulletStartLine = null;

  const flushBullets = () => {
    if (!bulletBuf.length) return;
    const text = bulletBuf.join(" / ").trim();
    if (text) {
      units.push({
        text,
        heading: currentHeading,
        lineNo: bulletStartLine,
      });
    }
    bulletBuf = [];
    bulletStartLine = null;
  };

  for (const item of normLines) {
    let s = (item.raw || "").trim();

    // 空行
    if (!s) {
      flushBullets();
      continue;
    }

    // 見出し
    const hm = s.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      flushBullets();
      currentHeading = cleanInline(hm[2]);
      continue;
    }

    // 箇条書き（- * ・ 1. など）
    const bm = s.match(/^(\-|\*|・|\d+\.)\s+(.+)$/);
    if (bm) {
      const body = cleanInline(bm[2]);
      if (!bulletBuf.length) bulletStartLine = item.lineNo;
      if (body) bulletBuf.push(body);
      continue;
    }

    flushBullets();

    // Markdown強調などを軽く除去して文に
    s = cleanInline(s);

    // 文章分割（。！？で分ける）
    const parts = splitSentences(s);
    for (const p of parts) {
      const t = p.trim();
      if (!t) continue;
      units.push({
        text: t,
        heading: currentHeading,
        lineNo: item.lineNo,
      });
    }
  }

  flushBullets();
  return units;
}

function cleanInline(s) {
  return String(s || "")
    .replace(/[*_~`]/g, "")          // markdown記号
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(s) {
  // 日本語中心：句点で切る。長い行は読点も補助で切る
  // ただし短すぎる断片は避けたいので後段でフィルタ
  const parts = s
    .replace(/。/g, "。|")
    .replace(/！/g, "！|")
    .replace(/？/g, "？|")
    .split("|");
  return parts;
}

// ---- 抽出: ユニットから問題候補を作る ----
function extractFromUnit(u) {
  const text = u.text;
  const heading = u.heading;
  const source_line = u.lineNo;

  const out = [];

  // 1) 定義系: XとはY / XはYのこと / XをYという
  // 例: 「相対速度とは、...である」
  {
    const m1 = text.match(/^(.{2,30}?)とは、?(.{6,120}?)(?:である|のこと|を指す|という)?[。！？]?$/);
    if (m1) {
      const term = trimJP(m1[1]);
      const def = trimJP(m1[2]);
      if (term && def) {
        out.push(makeCandidate({
          type: "fill",
          question: withHeading(heading, `「${term}」とは何か？`),
          answer: def,
          source_line,
          meta: { kind: "def" },
        }));
        out.push(makeCandidate({
          type: "fill",
          question: withHeading(heading, `${term}とは、（　　　）である`),
          answer: def,
          source_line,
          meta: { kind: "def_blank" },
        }));
      }
    }
  }

  // 2) 分類: XはAとBに分かれる / XにはA,Bがある
  {
    const m = text.match(/^(.{2,30}?)は、?(.{2,40}?)(?:と|、)(.{2,40}?)(?:に分かれる|に分類される|がある|が存在する)[。！？]?$/);
    if (m) {
      const subject = trimJP(m[1]);
      const a = trimJP(m[2]);
      const b = trimJP(m[3]);
      if (subject && a && b) {
        out.push(makeCandidate({
          type: "short",
          question: withHeading(heading, `${subject}は何と何に分かれる？`),
          answer: `${a} と ${b}`,
          source_line,
          meta: { kind: "class2" },
        }));
      }
    }
  }

  // 3) 列挙: 特徴はA/B/C, 〜にはA,B,C
  {
    const m = text.match(/^(.{2,30}?)(?:の特徴|の要素|のポイント|には|は)(?:、|:)?\s*(.{2,120})$/);
    if (m) {
      const subject = trimJP(m[1]);
      const rest = trimJP(m[2]);
      // 区切り推定
      const items = splitList(rest);
      if (subject && items.length >= 3) {
        const ans = items.slice(0, 5).join(" / ");
        out.push(makeCandidate({
          type: "short",
          question: withHeading(heading, `${subject}の（主な）ポイントを挙げよ`),
          answer: ans,
          source_line,
          meta: { kind: "list" },
        }));
      }
    }
  }

  // 4) 因果: AのためB / AによりB / AなのでB
  {
    const m = text.match(/^(.{4,80}?)(?:のため|により|なので|その結果|したがって)(.{4,80})$/);
    if (m) {
      const cause = trimJP(m[1]);
      const effect = trimJP(m[2]);
      if (cause && effect) {
        out.push(makeCandidate({
          type: "short",
          question: withHeading(heading, `次の因果関係を答えよ：${cause} → ？`),
          answer: effect.replace(/[。！？]$/, ""),
          source_line,
          meta: { kind: "cause" },
        }));
      }
    }
  }

  // 5) 手順: まず/次に/最後に が含まれる文（箇条書き連結が特に効く）
  if (/(まず|次に|その後|最後に)/.test(text)) {
    const steps = text.split(/(?:\/|、|,)/).map(t => trimJP(t)).filter(Boolean);
    if (steps.length >= 3) {
      out.push(makeCandidate({
        type: "short",
        question: withHeading(heading, `手順を順番に説明せよ`),
        answer: steps.slice(0, 6).join(" → "),
        source_line,
        meta: { kind: "steps" },
      }));
    }
  }

  // 6) 正誤（軽め）：定義文っぽいのだけから作る（出し過ぎないようスコアで制御）
  // 文章が「Xとは...」形式のときに、少し改変して誤文を作る（安全な範囲で）
  {
    const m = text.match(/^(.{2,30}?)とは、?(.{6,120}?)(?:である|のこと|を指す|という)?[。！？]?$/);
    if (m) {
      const term = trimJP(m[1]);
      const def = trimJP(m[2]);
      // defが短すぎる/長すぎると微妙
      if (term && def && def.length >= 8 && def.length <= 80) {
        const wrong = def.replace(/重要/g, "不要").replace(/増加/g, "減少").replace(/大/g, "小");
        if (wrong !== def) {
          out.push(makeCandidate({
            type: "tf",
            question: withHeading(heading, `正しい？誤り？：「${term}とは${wrong}である」`),
            answer: "誤り",
            source_line,
            meta: { kind: "tf" },
          }));
          out.push(makeCandidate({
            type: "tf",
            question: withHeading(heading, `正しい？誤り？：「${term}とは${def}である」`),
            answer: "正しい",
            source_line,
            meta: { kind: "tf" },
          }));
        }
      }
    }
  }
    // 7) 「A（B）」みたいな補足を穴埋めにする（講義ノートで多い）
  {
    const m = text.match(/^(.{4,80}?)（(.{2,40}?)）(.{0,60})$/);
    if (m) {
      const left = trimJP(m[1] + (m[3] || ""));
      const inside = trimJP(m[2]);
      if (left && inside && inside.length <= 30) {
        out.push(makeCandidate({
          type: "fill",
          question: withHeading(heading, left.replace(inside, "（　　　）")),
          answer: inside,
          source_line,
          meta: { kind: "paren_blank" },
        }));
      }
    }
  }

  // 8) 「英語: 日本語」や「A - B」も用語として拾う
  {
    const m = text.match(/^(.{2,40}?)\s*(?:-|—|–|:|：)\s*(.{2,80})$/);
    if (m) {
      const left = trimJP(m[1]);
      const right = trimJP(m[2]);
      if (left && right && left.length <= 30 && right.length <= 80) {
        out.push(makeCandidate({
          type: "term",
          question: withHeading(heading, `「${left}」とは？`),
          answer: right.replace(/[。！？]$/, ""),
          source_line,
          meta: { kind: "pair" },
        }));
      }
    }
  }

  // 9) 数値が入る文は「穴埋め」にすると強い（例: 100ms, 3層, 2種類）
  {
    const m = text.match(/(.{6,120}?)([0-9０-９]+(?:\.[0-9]+)?)(\s*(?:ms|s|秒|分|時間|日|年|%|％|個|件|回|層|種類|章|GB|MB|kB|Hz|kHz|MHz|GHz)?)(.{0,60})$/);
    if (m) {
      const num = m[2];
      const unit = (m[3] || "").trim();
      const qText = trimJP((m[1] + "（　　　）" + (m[4] || "")).replace(/[。！？]$/, ""));
      if (qText.length >= 15 && qText.length <= 140) {
        out.push(makeCandidate({
          type: "fill",
          question: withHeading(heading, qText),
          answer: `${num}${unit}`.trim(),
          source_line,
          meta: { kind: "num_blank" },
        }));
      }
    }
  }

  return out;
}

function makeCandidate(c) {
  return {
    type: c.type,
    question: String(c.question || "").trim(),
    answer: c.answer == null ? "" : String(c.answer).trim(),
    source_line: c.source_line,
    meta: c.meta || {},
  };
}

function withHeading(heading, q) {
  if (!heading) return q;
  // UIで邪魔ならここを消してOK
  return `【${heading}】${q}`;
}

function trimJP(s) {
  return String(s || "").replace(/^[\s　]+|[\s　]+$/g, "");
}

function splitList(s) {
  // 「、」「/」「・」などの列挙を分割
  return String(s || "")
    .replace(/[。！？]$/g, "")
    .split(/(?:\/|、|,|・|;|：|:)\s*/g)
    .map(t => trimJP(t))
    .filter(t => t && t.length <= 60);
}

// ---- スコアリングとフィルタ ----
function scoreCandidate(c) {
  let score = 0;

  const q = c.question || "";
  const a = c.answer || "";

  // 種類ごとの基礎点
  if (c.meta.kind === "def") score += 6;
  if (c.meta.kind === "def_blank") score += 5;
  if (c.meta.kind === "class2") score += 5;
  if (c.meta.kind === "list") score += 4;
  if (c.meta.kind === "cause") score += 4;
  if (c.meta.kind === "steps") score += 4;
  if (c.meta.kind === "tf") score += 2;

  // 長さボーナス（短すぎ/長すぎは減点）
  const qlen = q.length;
  const alen = a.length;
  score += lengthScore(qlen, 15, 90);
  score += lengthScore(alen, 6, 120);

  // 指示語だらけは減点
  if (/(これ|それ|あれ|この|その|あの)/.test(q)) score -= 2;
  if (/(これ|それ|あれ|この|その|あの)/.test(a)) score -= 1;

  // 数字/単位が入ってると学習価値高め
  if (/[0-9０-９]/.test(q) || /[0-9０-９]/.test(a)) score += 1;

  // 章情報がついてると文脈が良い
  if (/^【.+】/.test(q)) score += 1;

  return score;
}

function lengthScore(len, min, max) {
  if (len < min) return -2;
  if (len > max) return -1;
  return 1;
}

function isGoodCandidate(c) {
  const q = c.question || "";
  const a = c.answer || "";

  // 質問必須
  if (!q || q.length < 8) return false;

  // answerが空でも良いケースはあるが、基本はある方が良い
  if (c.type !== "tf" && (!a || a.length < 2)) return false;

  // あまりに一般的/抽象的な答えは捨てる
  if (/^(重要|大事|必要|不要|はい|いいえ)$/.test(a)) return false;

  // 句読点だけ、記号だけは捨てる
  if (/^[\W_]+$/.test(q) || /^[\W_]+$/.test(a)) return false;

  return true;
}

function dedupeCandidates(cands) {
  const seen = new Set();
  const out = [];

  for (const c of cands) {
    const key = normalizeKey(c.question);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function normalizeKey(s) {
  return String(s || "")
    .replace(/^【.+?】/g, "") // 見出しは重複判定から除外
    .replace(/\s+/g, "")
    .replace(/[「」『』（）()［］\[\]【】]/g, "")
    .slice(0, 120);
}

function pickWithVariety(cands, limit, allowTF) {
  if (!allowTF) return cands.slice(0, limit);

  const tf = [];
  const other = [];
  for (const c of cands) {
    if (c.type === "tf") tf.push(c);
    else other.push(c);
  }

  // TFは最大20%くらいに抑える
  const tfLimit = Math.max(0, Math.floor(limit * 0.2));
  const picked = [];

  picked.push(...other.slice(0, limit - tfLimit));
  picked.push(...tf.slice(0, tfLimit));

  // もし足りなければ補充
  if (picked.length < limit) {
    const remain = cands.filter(x => !picked.includes(x));
    picked.push(...remain.slice(0, limit - picked.length));
  }

  return picked.slice(0, limit);
}

// クイズ1件の編集（作者のみ）
app.patch("/api/quizzes/:quizId", requireLogin, wrap(async (req, res) => {
  const quizId = Number(req.params.quizId);
  const question = String(req.body?.question || "").trim();
  const answer = String(req.body?.answer ?? "").trim();
  const type = String(req.body?.type || "").trim();

  const [qrows] = await pool.query(
    `SELECT q.id, q.note_id, n.user_id AS note_user_id
       FROM note_quizzes q
       JOIN notes n ON n.id = q.note_id
      WHERE q.id = ?`,
    [quizId]
  );
  if (!qrows.length) return res.status(404).json({ message: "not found" });

  const ownerId = qrows[0].note_user_id;
  if (ownerId !== req.session.userId) return res.status(403).json({ message: "forbidden" });

  if (!question) return res.status(400).json({ message: "question required" });

  await pool.query(
    `UPDATE note_quizzes
        SET question = ?, answer = ?, type = COALESCE(NULLIF(?, ''), type)
      WHERE id = ?`,
    [question, answer, type, quizId]
  );

  res.json({ ok: true });
}));

// クイズ削除（作者のみ）
app.delete("/api/note-quizzes/:quizId", requireLogin, wrap(async (req, res) => {
  const quizId = Number(req.params.quizId);

  const [qrows] = await pool.query(
    `SELECT q.id, q.note_id, n.user_id AS note_user_id
       FROM note_quizzes q
       JOIN notes n ON n.id = q.note_id
      WHERE q.id = ?`,
    [quizId]
  );
  if (!qrows.length) return res.status(404).json({ message: "not found" });

  const ownerId = qrows[0].note_user_id;
  if (ownerId !== req.session.userId) return res.status(403).json({ message: "forbidden" });

  await pool.query("DELETE FROM note_quizzes WHERE id = ?", [quizId]);
  res.json({ ok: true });
}));

// 退会（アカウント削除）: 自分の投稿削除→コミュ所属削除→ユーザー削除→ログアウト
app.delete("/api/account", requireLogin, wrap(async (req, res) => {
  const userId = req.session.userId;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 自分の投稿削除（note_quizzes はFK ON DELETE CASCADEなら一緒に消える）
    await conn.query("DELETE FROM notes WHERE user_id = ?", [userId]);

    // 自分のコミュ所属削除
    await conn.query("DELETE FROM user_communities WHERE user_id = ?", [userId]);

    // ユーザー削除
    await conn.query("DELETE FROM users WHERE id = ?", [userId]);

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  req.session.destroy(() => res.json({ ok: true }));
}));

async function isCommunityAdmin(userId, communityId) {
  const [rows] = await pool.query(
    `SELECT 1
       FROM user_communities
      WHERE user_id = ? AND community_id = ? AND role='admin'
      LIMIT 1`,
    [userId, communityId]
  );
  return rows.length > 0;
}

app.delete("/api/communities/:id", requireLogin, wrap(async (req, res) => {
  const communityId = Number(req.params.id);
  if (!communityId) return res.status(400).json({ message: "invalid id" });

  const userId = req.session.userId;
  const admin = await isCommunityAdmin(userId, communityId);
  if (!admin) return res.status(403).json({ message: "admin only" });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // ① 先にコミュ内ノート削除（note_quizzes はCASCADEで消える）
    await conn.query(`DELETE FROM notes WHERE community_id = ?`, [communityId]);

    // ② user_communities は communities削除でCASCADEでも消えるが、先に消してもOK
    // await conn.query(`DELETE FROM user_communities WHERE community_id = ?`, [communityId]);

    // ③ コミュ本体削除（ここで user_communities はCASCADE）
    await conn.query(`DELETE FROM communities WHERE id = ?`, [communityId]);

    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}));

// コミュニティ検索（未ログインでも利用可）
app.get("/api/communities", wrap(async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ communities: [] });

  const like = `%${q}%`;
  const userId = req.session?.userId || null;
  const loggedIn = !!userId;

  const [rows] = await pool.query(
    `SELECT
        c.id, c.name, c.slug, c.created_at,
        CASE WHEN uc.user_id IS NULL THEN 0 ELSE 1 END AS is_member,
        CASE WHEN r.id IS NULL THEN 0 ELSE 1 END AS has_pending
     FROM communities c
     LEFT JOIN user_communities uc
       ON uc.community_id = c.id AND uc.user_id = ?
     LEFT JOIN community_join_requests r
       ON r.community_id = c.id AND r.user_id = ? AND r.status = 'pending'
     WHERE c.name LIKE ?
     ORDER BY c.name ASC
     LIMIT 50`,
    [userId, userId, like]
  );

  res.json({ communities: rows, loggedIn });
}));

//--------参加申請API--------
app.post("/api/communities/:id/join-requests", requireLogin, wrap(async (req, res) => {
  const communityId = Number(req.params.id);
  const userId = req.session.userId;
  const message = String(req.body?.message || "").trim().slice(0, 500);

  if (!communityId) return res.status(400).json({ message: "invalid community id" });

  // すでに所属してたらNG
  const role = await userRoleInCommunity(userId, communityId);
  if (role) return res.status(400).json({ message: "already a member" });

  // 申請作成（pending重複はUNIQUEで防ぐ）
  try {
    const [r] = await pool.query(
      `INSERT INTO community_join_requests (community_id, user_id, message, status)
       VALUES (?, ?, ?, 'pending')`,
      [communityId, userId, message || null]
    );
    res.status(201).json({ ok: true, request_id: r.insertId });
  } catch (e) {
    // たぶん pending重複
    return res.status(400).json({ message: "already requested" });
  }
}));

// コミュニティ退会（自分の所属を削除）
app.post("/api/communities/:id/leave", requireLogin, wrap(async (req, res) => {
  const communityId = Number(req.params.id);
  const userId = req.session.userId;

  if (!communityId) return res.status(400).json({ message: "invalid community id" });

  // まず所属してるか
  const [rows] = await pool.query(
    `SELECT role FROM user_communities
      WHERE user_id = ? AND community_id = ?
      LIMIT 1`,
    [userId, communityId]
  );
  if (!rows.length) return res.status(400).json({ message: "not a member" });

  // 退会
  await pool.query(
    `DELETE FROM user_communities
      WHERE user_id = ? AND community_id = ?
      LIMIT 1`,
    [userId, communityId]
  );

  res.json({ ok: true });
}));



// ---------- Billing / Subscription Helpers ----------
const PLAN_FREE = "free";
const PLAN_PRO = "pro";
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

const PLAN_FEATURES = {
  free: {
    max_notes: 30,
    ai_summary_monthly_limit: 20,
    quiz_generation_monthly_limit: 10,
    quiz_creation_monthly_limit: 10,
    quiz_distractor_generation_monthly_limit: 20,
    ocr_extraction_monthly_limit: 20,
    max_custom_quizzes: 30,
    can_export_pdf: false,
  },
  pro: {
    max_notes: -1,
    ai_summary_monthly_limit: 500,
    quiz_generation_monthly_limit: 300,
    quiz_creation_monthly_limit: -1,
    quiz_distractor_generation_monthly_limit: -1,
    ocr_extraction_monthly_limit: -1,
    max_custom_quizzes: 1000,
    can_export_pdf: true,
  },
};

function getCurrentPeriodMonth() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

async function getUserSubscription(userId) {
  const [rows] = await pool.query(
    `SELECT *
       FROM subscriptions
      WHERE user_id = ?
      LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

function isSubscriptionActive(sub) {
  if (!sub) return false;
  return ACTIVE_SUBSCRIPTION_STATUSES.has(String(sub.subscription_status || ""));
}

function resolvePlanCode(sub) {
  if (sub && isSubscriptionActive(sub) && sub.plan_code === PLAN_PRO) {
    return PLAN_PRO;
  }
  return PLAN_FREE;
}

async function getUsageCount(userId, featureCode, periodMonth = getCurrentPeriodMonth()) {
  const [rows] = await pool.query(
    `SELECT used_count
       FROM usage_counters
      WHERE user_id = ? AND feature_code = ? AND period_month = ?
      LIMIT 1`,
    [userId, featureCode, periodMonth]
  );
  return rows.length ? Number(rows[0].used_count) : 0;
}

async function incrementUsageCount(userId, featureCode, incrementBy = 1, periodMonth = getCurrentPeriodMonth()) {
  await pool.query(
    `INSERT INTO usage_counters (user_id, feature_code, period_month, used_count)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE used_count = used_count + VALUES(used_count)`,
    [userId, featureCode, periodMonth, incrementBy]
  );
}

async function getUserNotesCount(userId) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS note_count
       FROM notes
      WHERE user_id = ?`,
    [userId]
  );
  return Number(rows?.[0]?.note_count || 0);
}

async function ensureStripeCustomerForUser(userId) {
  const [rows] = await pool.query("SELECT id, username, stripe_customer_id FROM users WHERE id = ? LIMIT 1", [userId]);
  if (!rows.length) throw new Error("user not found");
  const user = rows[0];

  if (user.stripe_customer_id) return user.stripe_customer_id;
  if (!stripe) throw new Error("Stripe is not configured");

  const customer = await stripe.customers.create({
    metadata: { app_user_id: String(userId) },
    name: user.username,
  });

  await pool.query("UPDATE users SET stripe_customer_id = ? WHERE id = ?", [customer.id, userId]);
  return customer.id;
}

async function upsertSubscriptionFromStripe(subscription, customerId) {
  const [userRows] = await pool.query(
    "SELECT id FROM users WHERE stripe_customer_id = ? LIMIT 1",
    [customerId]
  );
  if (!userRows.length) {
    throw new Error(`Stripe customer ${customerId} is not linked to any user`);
  }

  const userId = userRows[0].id;
  const item = subscription.items?.data?.[0];
  const stripePriceId = item?.price?.id || null;
  const planCode = stripePriceId === process.env.STRIPE_PRICE_ID_PRO_MONTHLY ? PLAN_PRO : PLAN_FREE;

  await pool.query(
    `INSERT INTO subscriptions (
      user_id,
      stripe_customer_id,
      stripe_subscription_id,
      plan_code,
      subscription_status,
      current_period_end,
      cancel_at_period_end
    ) VALUES (?, ?, ?, ?, ?, FROM_UNIXTIME(?), ?)
    ON DUPLICATE KEY UPDATE
      stripe_customer_id = VALUES(stripe_customer_id),
      stripe_subscription_id = VALUES(stripe_subscription_id),
      plan_code = VALUES(plan_code),
      subscription_status = VALUES(subscription_status),
      current_period_end = VALUES(current_period_end),
      cancel_at_period_end = VALUES(cancel_at_period_end),
      updated_at = CURRENT_TIMESTAMP`,
    [
      userId,
      customerId,
      subscription.id,
      planCode,
      subscription.status,
      Number(subscription.current_period_end || 0),
      subscription.cancel_at_period_end ? 1 : 0,
    ]
  );
}

async function markSubscriptionCanceledByCustomerId(customerId) {
  await pool.query(
    `UPDATE subscriptions
        SET subscription_status = 'canceled',
            cancel_at_period_end = 0,
            updated_at = CURRENT_TIMESTAMP
      WHERE stripe_customer_id = ?`,
    [customerId]
  );
}

function requireActiveSubscription(req, res, next) {
  if (!req.billing?.isActiveSubscription) {
    return res.status(402).json({
      message: "有料プランの契約が必要です",
      code: "SUBSCRIPTION_REQUIRED",
    });
  }
  next();
}

function requirePro(req, res, next) {
  if (req.billing?.planCode !== PLAN_PRO) {
    return res.status(403).json({
      message: "Proプラン限定機能です",
      code: "PRO_REQUIRED",
    });
  }
  next();
}

async function attachBillingContext(req, res, next) {
  if (!req.session?.userId) return next();

  const sub = await getUserSubscription(req.session.userId);
  const planCode = resolvePlanCode(sub);

  req.billing = {
    subscription: sub,
    planCode,
    isActiveSubscription: isSubscriptionActive(sub),
    features: PLAN_FEATURES[planCode],
  };
  next();
}

function requireUsageLimit(featureCode, limitKey, limitExceededMessage = "この機能の月間利用上限に達しました") {
  return wrap(async (req, res, next) => {
    if (!req.session?.userId) {
      return res.status(401).json({ message: "ログインしてください" });
    }

    if (!req.billing) {
      const sub = await getUserSubscription(req.session.userId);
      const planCode = resolvePlanCode(sub);
      req.billing = {
        subscription: sub,
        planCode,
        isActiveSubscription: isSubscriptionActive(sub),
        features: PLAN_FEATURES[planCode],
      };
    }

    const limit = req.billing.features?.[limitKey];
    if (limit === -1 || limit == null) return next();

    const used = await getUsageCount(req.session.userId, featureCode);
    if (used >= limit) {
      return res.status(429).json({
        message: limitExceededMessage,
        code: "USAGE_LIMIT_EXCEEDED",
        featureCode,
        used,
        limit,
      });
    }

    req.usageLimit = { featureCode, limit, used };
    next();
  });
}

app.use(attachBillingContext);

// ---------- Billing APIs ----------
app.post("/api/billing/create-checkout-session", requireLogin, wrap(async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ message: "Stripe is not configured" });
  }
  if (!process.env.STRIPE_PRICE_ID_PRO_MONTHLY) {
    return res.status(500).json({ message: "STRIPE_PRICE_ID_PRO_MONTHLY is missing" });
  }

  const customerId = await ensureStripeCustomerForUser(req.session.userId);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    payment_method_types: ["card"],
    line_items: [{ price: process.env.STRIPE_PRICE_ID_PRO_MONTHLY, quantity: 1 }],
    success_url: `${process.env.APP_BASE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.APP_BASE_URL}/billing/cancel`,
    metadata: {
      app_user_id: String(req.session.userId),
    },
  });

  res.json({ url: session.url, sessionId: session.id });
}));

app.post("/api/billing/portal", requireLogin, wrap(async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ message: "Stripe is not configured" });
  }

  const customerId = await ensureStripeCustomerForUser(req.session.userId);
  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${process.env.APP_BASE_URL}/settings/billing`,
  });

  res.json({ url: portal.url });
}));

app.post("/api/billing/webhook", wrap(async (req, res) => {
  if (!stripe) {
    return res.status(500).send("Stripe is not configured");
  }

  const signature = req.headers["stripe-signature"];
  if (!signature || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send("Missing webhook signature or secret");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.query(
      "SELECT id FROM payment_events WHERE event_id = ? LIMIT 1",
      [event.id]
    );
    if (existing.length) {
      await conn.rollback();
      return res.status(200).json({ received: true, duplicate: true });
    }

    await conn.query(
      `INSERT INTO payment_events (event_id, event_type, payload)
       VALUES (?, ?, ?)`,
      [event.id, event.type, JSON.stringify(event)]
    );

    switch (event.type) {
      case "checkout.session.completed": {
        const checkoutSession = event.data.object;
        if (checkoutSession.mode === "subscription" && checkoutSession.subscription && checkoutSession.customer) {
          const subscription = await stripe.subscriptions.retrieve(checkoutSession.subscription);
          await upsertSubscriptionFromStripe(subscription, checkoutSession.customer);
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const subscription = event.data.object;
        await upsertSubscriptionFromStripe(subscription, subscription.customer);
        break;
      }
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        await markSubscriptionCanceledByCustomerId(subscription.customer);
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        if (invoice.customer) {
          await conn.query(
            `UPDATE subscriptions
                SET subscription_status = 'past_due',
                    updated_at = CURRENT_TIMESTAMP
              WHERE stripe_customer_id = ?`,
            [invoice.customer]
          );
        }
        break;
      }
      default:
        break;
    }

    await conn.commit();
    return res.status(200).json({ received: true });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

app.get("/api/billing/me", requireLogin, wrap(async (req, res) => {
  const subscription = await getUserSubscription(req.session.userId);
  const planCode = resolvePlanCode(subscription);
  const features = PLAN_FEATURES[planCode];
  const notesCount = await getUserNotesCount(req.session.userId);

  const usage = {
    ai_summary: await getUsageCount(req.session.userId, "ai_summary"),
    quiz_generation: await getUsageCount(req.session.userId, "quiz_generation"),
    quiz_creation: await getUsageCount(req.session.userId, "quiz_creation"),
    quiz_distractor_generation: await getUsageCount(req.session.userId, "quiz_distractor_generation"),
    ocr_extraction: await getUsageCount(req.session.userId, "ocr_extraction"),
  };

  res.json({
    planCode,
    isActiveSubscription: isSubscriptionActive(subscription),
    subscription,
    features,
    usage,
    notes_count: notesCount,
  });
}));

app.post("/api/billing/cancel", requireLogin, wrap(async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ message: "Stripe is not configured" });
  }

  const subscription = await getUserSubscription(req.session.userId);
  if (!subscription?.stripe_subscription_id) {
    return res.status(404).json({ message: "アクティブなサブスクリプションがありません" });
  }

  const canceled = await stripe.subscriptions.update(subscription.stripe_subscription_id, {
    cancel_at_period_end: true,
  });

  await upsertSubscriptionFromStripe(canceled, canceled.customer);

  res.json({
    ok: true,
    cancelAtPeriodEnd: canceled.cancel_at_period_end,
    currentPeriodEnd: canceled.current_period_end,
  });
}));

// ---------- Pro-gated Feature APIs (MVP sample) ----------
app.post("/api/notes/:id/export-pdf", requireLogin, requirePro, wrap(async (req, res) => {
  const noteId = Number(req.params.id);
  const note = await getNoteById(noteId);
  const perm = await canEditNote(req, note);
  if (!perm.ok) return res.status(perm.status).json({ message: perm.message });

  // MVPでは実PDF生成ではなくサンプルレスポンス。
  res.json({
    ok: true,
    noteId,
    message: "PDF生成ジョブを開始しました（MVPサンプル）",
    downloadUrl: `/api/notes/${noteId}/export-pdf/download/sample.pdf`,
  });
}));

app.post(
  "/api/notes/:id/ai-summary",
  requireLogin,
  requireUsageLimit("ai_summary", "ai_summary_monthly_limit"),
  wrap(async (req, res) => {
    const noteId = Number(req.params.id);
    const note = await getNoteById(noteId);
    const perm = canEditNote(req, note);
    if (!perm.ok) return res.status(perm.status).json({ message: perm.message });

    const summary = String(note.body_raw || "").split(/\r?\n/).filter(Boolean).slice(0, 5).join(" ");
    await incrementUsageCount(req.session.userId, "ai_summary", 1);

    res.json({
      ok: true,
      noteId,
      summary: summary || "（要約対象が不足しています）",
      usage: {
        featureCode: "ai_summary",
        usedAfter: (req.usageLimit?.used || 0) + 1,
        limit: req.usageLimit?.limit,
      },
    });
  })
);

const handleGenerateQuiz = [
  requireLogin,
  requireUsageLimit("quiz_generation", "quiz_generation_monthly_limit"),
  wrap(async (req, res) => {
    const noteId = Number(req.params.id);
    const userId = req.session?.userId || req.session?.user?.id || req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: "ログインが必要です" });
    }

    const note = await getNoteById(noteId);
    const perm = canEditNote(req, note);
    if (!perm.ok) {
      return res.status(perm.status).json({ message: perm.message });
    }

    const rawText = String(note?.body_raw || "").trim();
    if (rawText.length < 20) {
      return res.status(422).json({
        message: "ノート本文が短すぎるためクイズ生成できません。内容を追記してから再実行してください。",
        code: "NOTE_CONTENT_TOO_SHORT",
      });
    }

    const requestedQuizType = String(req.body?.quiz_type || req.body?.quizType || "auto").trim() || "auto";
    if (!["auto", "multiple_choice", "written", "true_false", "fill_blank"].includes(requestedQuizType)) {
      return res.status(400).json({
        message: "quiz_type は auto / multiple_choice / written / true_false / fill_blank のいずれかを指定してください。",
      });
    }

    let quizzes = [];
    try {
      quizzes = await generateQuizzesForNote(note, { limit: 10, quizType: requestedQuizType });
    } catch (err) {
      console.error("quiz_pipeline_failed", {
        noteId,
        userId,
        message: err.message,
        details: err.details || null,
      });
      return res.status(422).json({
        message: "クイズ生成品質が基準を満たしませんでした。ノート内容を見直して再実行してください。",
        detail: err.message,
      });
    }

    for (const q of quizzes) {
      await pool.query(
        `INSERT INTO note_quizzes (user_id, note_id, type, question, answer, choice_1, choice_2, choice_3, choice_4, source_line)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, noteId, q.type, q.question, q.answer, q.choice_1, q.choice_2, q.choice_3, q.choice_4, q.source_line]
      );
    }

    await incrementUsageCount(userId, "quiz_generation", 1);

    res.json({
      ok: true,
      generatedCount: quizzes.length,
      quiz_type: requestedQuizType,
      quizzes,
      usage: {
        featureCode: "quiz_generation",
        usedAfter: (req.usageLimit?.used || 0) + 1,
        limit: req.usageLimit?.limit,
      },
    });
  })
];

app.post("/api/notes/:id/generate-quiz", ...handleGenerateQuiz);
app.post("/api/notes/:id/quizzes/generate", ...handleGenerateQuiz);


app.post("/api/note-quizzes", requireLogin, wrap(async (req, res) => {
  const noteId = Number(req.body.note_id);
  const question = String(req.body.question || "").trim();
  const answer = String(req.body.answer || "").trim();
  const type = String(req.body.type || "qa").trim();

  if (!noteId || !question) {
    return res.status(400).json({ message: "note_id and question are required" });
  }

  const note = await getNoteById(noteId);
  const perm = canEditNote(req, note);
  if (!perm.ok) return res.status(perm.status).json({ message: perm.message });

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS cnt
       FROM note_quizzes q
       JOIN notes n ON n.id = q.note_id
      WHERE n.user_id = ?`,
    [req.session.userId]
  );

  const maxCustomQuizzes = req.billing?.features?.max_custom_quizzes ?? 30;
  const currentCount = Number(countRows[0]?.cnt || 0);
  if (maxCustomQuizzes !== -1 && currentCount >= maxCustomQuizzes) {
    return res.status(429).json({
      message: "作成可能なクイズ数の上限に達しました",
      code: "CUSTOM_QUIZ_LIMIT_EXCEEDED",
      limit: maxCustomQuizzes,
      used: currentCount,
    });
  }

const [result] = await pool.query(
  `INSERT INTO note_quizzes (user_id, note_id, type, question, answer, choice_1, choice_2, choice_3, choice_4)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    req.session.userId,
    noteId,
    type,
    question,
    answer,
    req.body.choice_1 || req.body.option_1 || null,
    req.body.choice_2 || req.body.option_2 || null,
    req.body.choice_3 || req.body.option_3 || null,
    req.body.choice_4 || req.body.option_4 || null,
  ]
);
  res.status(201).json({
    ok: true,
    quizId: result.insertId,
    remaining: maxCustomQuizzes === -1 ? null : Math.max(maxCustomQuizzes - (currentCount + 1), 0),
  });
}));

app.post(
  "/api/quizzes",
  requireLogin,
  requireUsageLimit("quiz_creation", "quiz_creation_monthly_limit", "無料プランではクイズ作成は月10回までです。有料プランで無制限になります。"),
  wrap(async (req, res) => {
    const userId = req.session.userId;
    const { normalized, errors } = validateUserQuizPayload(req.body || {});
    if (errors.length) return res.status(400).json({ message: errors[0], errors });

    if (normalized.note_id) {
      const note = await getNoteById(normalized.note_id);
      const perm = canEditNote(req, note);
      if (!perm.ok) return res.status(perm.status).json({ message: "指定したノートに紐づける権限がありません" });
    }

    let result;
    try {
      [result] = await pool.query(
        `INSERT INTO note_quizzes (user_id, note_id, type, question, answer, visibility, choice_1, choice_2, choice_3, choice_4)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          normalized.note_id,
          normalized.quiz_type,
          normalized.question_text,
          normalized.correct_answer,
          normalized.visibility,
          normalized.choice_1,
          normalized.choice_2,
          normalized.choice_3,
          normalized.choice_4,
        ]
      );
    } catch (error) {
      console.error("POST /api/quizzes failed", {
        userId,
        note_id: normalized.note_id,
        quiz_type: normalized.quiz_type,
        error,
      });
      throw error;
    }

    await incrementUsageCount(userId, "quiz_creation", 1);

    res.status(201).json({
      ok: true,
      id: result.insertId,
      usage: {
        featureCode: "quiz_creation",
        usedAfter: (req.usageLimit?.used || 0) + 1,
        limit: req.usageLimit?.limit,
      },
    });
  })
);

app.get("/api/quizzes/mine", requireLogin, wrap(async (req, res) => {
  const userId = req.session.userId;
  const noteId = req.query.note_id ? Number(req.query.note_id) : null;
  const quizType = String(req.query.quiz_type || "").trim();
  const date = parseDateFilter(req.query.date);
  const search = String(req.query.search || "").trim();
  const sortOrder = normalizeSortOrder(req.query.sort);
  const choiceSelect = await buildNoteQuizSelectChoiceFragments();

  let sql = `
    SELECT nq.id,
           nq.user_id,
           nq.note_id,
           CONCAT('ノートクイズ #', nq.id) AS title,
           nq.question AS question_text,
           nq.type AS quiz_type,
           ${choiceSelect.choice1},
           ${choiceSelect.choice2},
           ${choiceSelect.choice3},
           ${choiceSelect.choice4},
           ${choiceSelect.choices},
           ${choiceSelect.options},
           nq.answer AS correct_answer,
           NULL AS explanation,
           COALESCE(nq.visibility, 'private') AS visibility,
           nq.created_at,
           nq.updated_at,
           n.created_at AS note_created_at
      FROM note_quizzes nq
      LEFT JOIN notes n ON n.id = nq.note_id
     WHERE nq.user_id = ?`;
  const params = [userId];

  if (noteId) {
    sql += " AND nq.note_id = ?";
    params.push(noteId);
  }
  if (quizType) {
    sql += " AND nq.type = ?";
    params.push(quizType);
  }
  if (date) {
    sql += " AND DATE(CONVERT_TZ(nq.created_at, '+00:00', '+09:00')) = ?";
    params.push(date);
  }
  if (search) {
    sql += " AND (nq.question LIKE ? OR nq.answer LIKE ?)";
    params.push(`%${search}%`, `%${search}%`);
  }
  sql += ` ORDER BY nq.created_at ${sortOrder}, nq.id ${sortOrder}`;

  const [rows] = await pool.query(sql, params);
  const normalizedRows = rows.map((row) => {
    const normalized = normalizeQuizChoices(row);
    return {
      ...normalized,
      created_date_jst: toJstDateKey(normalized.created_at),
      note_created_date_jst: toJstDateKey(normalized.note_created_at),
    };
  });
  res.json({ success: true, data: { quizzes: normalizedRows } });
}));

app.get("/api/quizzes/mine/calendar-summary", requireLogin, wrap(async (req, res) => {
  const userId = req.session.userId;
  const month = parseMonthFilter(req.query.month);
  if (!month) return res.status(400).json({ message: "month(YYYY-MM) is required" });

  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(CONVERT_TZ(created_at, '+00:00', '+09:00'), '%Y-%m-%d') AS date,
            COUNT(*) AS count
       FROM note_quizzes
      WHERE user_id = ?
        AND DATE_FORMAT(CONVERT_TZ(created_at, '+00:00', '+09:00'), '%Y-%m') = ?
      GROUP BY date
      ORDER BY date ASC`,
    [userId, month]
  );

  res.json({ month, days: rows });
}));

app.get("/api/quizzes/:id", requireLogin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const choiceSelect = await buildNoteQuizSelectChoiceFragments();
  const [rows] = await pool.query(
    `SELECT id,
            user_id,
            note_id,
            CONCAT('ノートクイズ #', id) AS title,
            question AS question_text,
            type AS quiz_type,
            ${choiceSelect.choice1},
            ${choiceSelect.choice2},
            ${choiceSelect.choice3},
            ${choiceSelect.choice4},
            ${choiceSelect.choices},
            ${choiceSelect.options},
            answer AS correct_answer,
            NULL AS explanation,
            COALESCE(visibility, 'private') AS visibility,
            created_at,
            updated_at
       FROM note_quizzes
      WHERE id = ?
      LIMIT 1`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ message: "not found" });
  if (rows[0].user_id !== req.session.userId) return res.status(403).json({ message: "forbidden" });

  res.json({ success: true, data: normalizeQuizChoices(rows[0]) });
}));

app.put("/api/quizzes/:id", requireLogin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const [existingRows] = await pool.query("SELECT user_id FROM note_quizzes WHERE id = ? LIMIT 1", [id]);
  if (!existingRows.length) return res.status(404).json({ message: "not found" });
  if (existingRows[0].user_id !== req.session.userId) return res.status(403).json({ message: "forbidden" });

  const { normalized, errors } = validateUserQuizPayload(req.body || {});
  if (errors.length) return res.status(400).json({ message: errors[0], errors });

  if (normalized.note_id) {
    const note = await getNoteById(normalized.note_id);
    const perm = canEditNote(req, note);
    if (!perm.ok) return res.status(perm.status).json({ message: "指定したノートに紐づける権限がありません" });
  }

  try {
    await pool.query(
      `UPDATE note_quizzes
          SET note_id = ?, type = ?, question = ?, answer = ?, visibility = ?,
              choice_1 = ?, choice_2 = ?, choice_3 = ?, choice_4 = ?
        WHERE id = ?`,
      [
        normalized.note_id,
        normalized.quiz_type,
        normalized.question_text,
        normalized.correct_answer,
        normalized.visibility,
        normalized.choice_1,
        normalized.choice_2,
        normalized.choice_3,
        normalized.choice_4,
        id,
      ]
    );
  } catch (error) {
    console.error("PUT /api/quizzes/:id failed", {
      id,
      userId: req.session.userId,
      note_id: normalized.note_id,
      quiz_type: normalized.quiz_type,
      error,
    });
    throw error;
  }

  res.json({ ok: true, id });
}));

app.delete("/api/quizzes/:id", requireLogin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const [rows] = await pool.query("SELECT user_id FROM note_quizzes WHERE id = ? LIMIT 1", [id]);
  if (!rows.length) return res.status(404).json({ message: "not found" });
  if (rows[0].user_id !== req.session.userId) return res.status(403).json({ message: "forbidden" });

  await pool.query("DELETE FROM note_quizzes WHERE id = ?", [id]);
  return res.json({ ok: true, deleted: "note_quiz" });
}));

app.post(
  "/api/quizzes/generate-distractors",
  requireLogin,
  requireUsageLimit("quiz_distractor_generation", "quiz_distractor_generation_monthly_limit"),
  wrap(async (req, res) => {
    const questionText = String(req.body?.questionText || "").trim();
    const correctAnswer = String(req.body?.correctAnswer || "").trim();
    if (!questionText || !correctAnswer) {
      return res.status(400).json({ message: "questionText と correctAnswer は必須です" });
    }

    const openai = getOpenAIClient();
    const prompt = [
      "入力された問題文と正解をもとに、4択問題の不正解選択肢を3つ作成してください。",
      "条件:",
      "- 正解と似たカテゴリ・難易度・粒度にする",
      "- ただし正解そのものは含めない",
      "- 3つとも重複しない",
      "- 曖昧すぎる内容や『すべて正しい』のような不適切な選択肢は禁止",
      "- 出力はJSONのみ。形式は {\"distractors\":[\"...\",\"...\",\"...\"] }",
      `問題文: ${questionText}`,
      `正解: ${correctAnswer}`,
    ].join("\n");

    let distractors = [];
    try {
      const response = await openai.responses.create({ model: process.env.OPENAI_QUIZ_MODEL || "gpt-4.1-mini", input: prompt });
      const raw = response.output_text || "";
      const parsed = JSON.parse(raw);
      distractors = Array.isArray(parsed?.distractors) ? parsed.distractors : [];
    } catch (error) {
      console.error("generate_distractors_failed", error);
      return res.status(502).json({ message: "AIによる不正解候補の生成に失敗しました" });
    }

    const unique = [];
    const seen = new Set([correctAnswer]);
    for (const d of distractors) {
      const v = String(d || "").trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      unique.push(v);
    }

    if (unique.length < 3) {
      return res.status(422).json({ message: "不正解候補を十分に生成できませんでした。もう一度お試しください。" });
    }

    await incrementUsageCount(req.session.userId, "quiz_distractor_generation", 1);
    res.json({
      success: true,
      data: { distractors: unique.slice(0, 3) },
      usage: {
        featureCode: "quiz_distractor_generation",
        usedAfter: (req.usageLimit?.used || 0) + 1,
        limit: req.usageLimit?.limit,
      },
    });
  })
);

// ---------- Error Handler ----------
app.use((err, req, res, next) => {
  console.error(err);

  const isApi = String(req.path || "").startsWith("/api/");
  if (isApi) {
    return res.status(500).json({
      message: "server error",
      detail: err?.message || String(err),
    });
  }
  res.status(500).send("Server Error");
});

// ---------- Listen ----------
const PORT = Number(process.env.PORT || 3000);
console.log("BOOT: about to listen...");
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
