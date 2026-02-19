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
 * .env:
 * DB_HOST=...
 * DB_USER=...
 * DB_PASSWORD=...
 * DB_NAME=...
 * DB_PORT=3306
 * SESSION_SECRET=...
 * OPENAI_API_KEY=sk-...
 */

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const path = require("path");
const mysql = require("mysql2/promise");
const session = require("express-session");
const bcrypt = require("bcrypt");

const OpenAI = require("openai");

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing");
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

const app = express();

// ---------- Middlewares ----------
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev_secret_change_me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false, // 本番HTTPSなら true（proxy下なら trust proxy も検討）
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7日
      sameSite: "lax",
    },
  })
);

app.use(express.static(path.join(__dirname, "public")));

// ---------- DB Pool ----------
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT || 3306),
  waitForConnections: true,
  connectionLimit: 10,
});

// ---------- Helpers ----------
function requireLogin(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ message: "login required" });
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
    .replace(/[^a-z0-9\-_ぁ-んァ-ン一-龥]/g, "") // 日本語も残す
    .slice(0, 80);
}

/**
 * community所属チェック（B方式）
 */
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

/**
 * 講義ノート用の簡易整形（AIなしMVP）
 */
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
    if (l.includes("⭐️") || l.toLowerCase().startsWith("important:")) important.push(l);
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

## 重要ポイント
${important.length ? important.map((x) => `- ${x}`).join("\n") : "- （なし）"}

## 本文
${main.map((x) => `- ${x}`).join("\n")}

## 用語集
${terms.length ? terms.map((x) => `- ${x}`).join("\n") : "- （なし）"}

## 疑問・確認したいこと
${questions.length ? questions.map((x) => `- ${x}`).join("\n") : "- （なし）"}

## TODO・課題
${todos.length ? todos.map((x) => `- ${x}`).join("\n") : "- （なし）"}

## まとめ
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
    // UNIQUE衝突など → 再取得
    const [rows2] = await pool.query("SELECT id FROM universities WHERE name = ?", [uniName]);
    if (rows2.length) return rows2[0].id;
    throw e;
  }
}

/**
 * ノート取得（共通）
 */
async function getNoteById(noteId) {
  const [rows] = await pool.query("SELECT * FROM notes WHERE id = ?", [noteId]);
  return rows.length ? rows[0] : null;
}

/**
 * ノート閲覧権限チェック
 * - community_id がある → ログイン必須 + 所属必須
 * - community_id がない → visibility private は本人のみ
 */
async function canViewNote(req, note) {
  if (!note) return { ok: false, status: 404, message: "not found" };

  if (note.community_id) {
    if (!req.session?.userId) return { ok: false, status: 401, message: "login required" };
    const belongs = await userBelongsToCommunity(req.session.userId, note.community_id);
    if (!belongs) return { ok: false, status: 403, message: "forbidden" };
    return { ok: true };
  }

  if (note.visibility === "private") {
    if (!req.session?.userId) return { ok: false, status: 401, message: "login required" };
    if (note.user_id !== req.session.userId) return { ok: false, status: 403, message: "forbidden" };
  }

  return { ok: true };
}

/**
 * ノート編集権限（クイズ生成など）
 * - 作者のみ
 */
function canEditNote(req, note) {
  if (!req.session?.userId) return { ok: false, status: 401, message: "login required" };
  if (!note) return { ok: false, status: 404, message: "not found" };
  if (note.user_id !== req.session.userId) return { ok: false, status: 403, message: "forbidden" };
  return { ok: true };
}

/**
 * クイズ生成（ルール版）：本文から抽出（AIなしMVP）
 */
function generateQuizzesFromBodyRaw(body_raw) {
  const lines = String(body_raw || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const out = [];
  const seen = new Set();

  const pushUnique = (q) => {
    const key = `${q.type}::${q.question}`.slice(0, 300);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(q);
  };

  for (const line of lines) {
    // 用語:
    if (line.startsWith("用語:")) {
      const content = line.replace(/^用語:\s*/, "").trim();
      const m = content.match(/^(.+?)\s*(=|＝|:|：)\s*(.+)$/);
      if (m) {
        const term = m[1].trim();
        const def = m[3].trim();
        if (term && def) {
          pushUnique({ type: "term", question: `「${term}」とは？`, answer: def, source_line: line });
        }
      } else if (content) {
        pushUnique({
          type: "term",
          question: `「${content}」とは？`,
          answer: "（本文を見て答えを追記）",
          source_line: line,
        });
      }
      continue;
    }

    // 疑問:
    if (line.startsWith("？") || line.startsWith("?") || line.endsWith("?") || line.endsWith("？")) {
      const q = line.replace(/^[？?]\s*/, "").trim();
      if (q) pushUnique({ type: "question", question: q, answer: "", source_line: line });
      continue;
    }

    // 重要（⭐️）
    if (line.includes("⭐️") || line.toLowerCase().startsWith("important:")) {
      const cleaned = line.replace("⭐️", "").replace(/^important:\s*/i, "").trim();
      if (cleaned) {
        pushUnique({
          type: "tf",
          question: `【○×】${cleaned}（正しい/誤り？）`,
          answer: "正しい",
          source_line: line,
        });
      }
      continue;
    }

    // A= B / A：B を拾う
    const m2 = line.match(/^(.+?)\s*(=|＝|:|：)\s*(.+)$/);
    if (m2) {
      const left = m2[1].trim();
      const right = m2[3].trim();
      if (left && right && left.length <= 30) {
        pushUnique({ type: "term", question: `「${left}」とは？`, answer: right, source_line: line });
      }
    }
  }

  return out.slice(0, 30);
}

/**
 * クイズ生成（AI版）：説明文でも作れる
 */
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
    // ```json ... ``` など救済
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

// ---------- Pages ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- Health ----------
app.get("/api/health", wrap(async (req, res) => {
  const [r] = await pool.query("SELECT 1 AS ok");
  res.json({ ok: true, db: r?.[0]?.ok === 1 });
}));

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
    res.json({ id: result.insertId, username });
  } catch (e) {
    res.status(400).json({ message: "username already used" });
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
  res.json({ id: rows[0].id, username });
}));

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

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

// 自分の参加コミュ一覧
app.get("/api/communities/mine", requireLogin, wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT c.id, c.name, uc.role, uc.joined_at
       FROM user_communities uc
       JOIN communities c ON c.id = uc.community_id
      WHERE uc.user_id = ?
      ORDER BY uc.joined_at DESC`,
    [req.session.userId]
  );
  res.json(rows);
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
      `SELECT id, university_id, author_name, course_name, lecture_no, lecture_date, title, created_at
         FROM notes
        WHERE university_id = ? AND visibility = 'public' AND community_id IS NULL AND course_name LIKE ?
        ORDER BY lecture_date DESC, id DESC`,
      [univId, `%${course}%`]
    );
  } else {
    [rows] = await pool.query(
      `SELECT id, university_id, author_name, course_name, lecture_no, lecture_date, title, created_at
         FROM notes
        WHERE university_id = ? AND visibility = 'public' AND community_id IS NULL
        ORDER BY lecture_date DESC, id DESC`,
      [univId]
    );
  }

  res.json(rows);
}));

// 自分が所属しているコミュニティ内のノート一覧（ログイン必須）
app.get("/api/community-notes", requireLogin, wrap(async (req, res) => {
  const userId = req.session.userId;

  // 自分が所属しているコミュID一覧
  const [crows] = await pool.query(
    `SELECT community_id FROM user_communities WHERE user_id = ?`,
    [userId]
  );
  if (!crows.length) return res.json([]);

  const ids = crows.map(r => r.community_id);

  // そのコミュ内ノートを取得（誰が書いたものでも）
  // ※ notes に community_id が入っている前提
  const [rows] = await pool.query(
    `SELECT
        n.id, n.community_id, n.user_id, n.visibility,
        n.author_name, n.course_name, n.lecture_no, n.lecture_date, n.title, n.created_at,
        c.name AS community_name
     FROM notes n
     JOIN communities c ON c.id = n.community_id
     WHERE n.community_id IN (?)
     ORDER BY n.lecture_date DESC, n.id DESC`,
    [ids]
  );

  res.json(rows);
}));

// 詳細：閲覧権限に従う（community or private）
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
  } = req.body;

  const communityId = community_id ? Number(community_id) : null;

  if (communityId && !String(university_name || "").trim()) {
    university_name = "（コミュ）";
  }

  // 必須チェック（コミュ投稿なら大学名は補完されるのでOK）
  if (!university_name || !course_name || !lecture_no || !lecture_date || !title || !body_raw) {
    return res.status(400).json({ message: "missing fields" });
  }

  if (communityId) {
    const belongs = await userBelongsToCommunity(user_id, communityId);
    if (!belongs) return res.status(403).json({ message: "not a community member" });
  }

  const university_id = await getOrCreateUniversityId(university_name);
  const body_md = buildMarkdown({ course_name, lecture_no, lecture_date, title, body_raw });
  const vis = normalizeVisibility(visibility);

  const [result] = await pool.query(
    `INSERT INTO notes (user_id, community_id, university_id, author_name, course_name, lecture_no, lecture_date, title, body_raw, body_md, visibility)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ]
  );

  res.status(201).json({ id: result.insertId });
}));

// マイページ：自分のノート一覧（public/private両方、ログイン必須）
app.get("/api/my-notes", requireLogin, wrap(async (req, res) => {
  const userId = req.session.userId;

  const [rows] = await pool.query(
    `SELECT id, community_id, visibility, university_id, author_name, course_name, lecture_no, lecture_date, title, created_at
       FROM notes
      WHERE user_id = ?
      ORDER BY lecture_date DESC, id DESC`,
    [userId]
  );

  res.json(rows);
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

  const [rows] = await pool.query(
    `SELECT id, type, question, answer, source_line, created_at, updated_at
       FROM note_quizzes
      WHERE note_id = ?
      ORDER BY id ASC`,
    [noteId]
  );

  res.json(rows);
}));

// クイズ生成（作者のみ）
// engine: "rule" | "ai"
app.post("/api/notes/:id/quizzes/generate", requireLogin, wrap(async (req, res) => {
  const noteId = Number(req.params.id);
  const mode = String(req.body?.mode || "replace");     // replace | append
  const engine = String(req.body?.engine || "rule");   // rule | ai

  const note = await getNoteById(noteId);
  const edit = canEditNote(req, note);
  if (!edit.ok) return res.status(edit.status).json({ message: edit.message });

  let quizzes = [];
  if (engine === "ai") {
    quizzes = await generateQuizzesWithAI({
      title: note.title,
      course_name: note.course_name,
      body_raw: note.body_raw,
    });
  } else {
    quizzes = generateQuizzesFromBodyRaw(note.body_raw);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (mode === "replace") {
      await conn.query("DELETE FROM note_quizzes WHERE note_id = ?", [noteId]);
    }

    for (const q of quizzes) {
      await conn.query(
        `INSERT INTO note_quizzes (note_id, user_id, type, question, answer, source_line)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [noteId, req.session.userId, q.type, q.question, q.answer ?? "", q.source_line ?? null]
      );
    }

    await conn.commit();
    res.json({ ok: true, inserted: quizzes.length, mode, engine });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}));

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
app.delete("/api/quizzes/:quizId", requireLogin, wrap(async (req, res) => {
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
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
