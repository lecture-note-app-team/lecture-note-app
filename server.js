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

// ---------- OpenAI ----------
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing");
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

const app = express();

// Railwayなどプロキシ配下
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// ---------- Middlewares ----------
app.use(express.json({ limit: "1mb" }));
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

function canEditNote(req, note) {
  if (!req.session?.userId) return { ok: false, status: 401, message: "login required" };
  if (!note) return { ok: false, status: 404, message: "not found" };
  if (note.user_id !== req.session.userId) return { ok: false, status: 403, message: "forbidden" };
  return { ok: true };
}

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

    if (line.startsWith("？") || line.startsWith("?") || line.endsWith("?") || line.endsWith("？")) {
      const q = line.replace(/^[？?]\s*/, "").trim();
      if (q) pushUnique({ type: "question", question: q, answer: "", source_line: line });
      continue;
    }

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
    s = s.replace(/https?:\/\/\S+/g, "").trimEnd();

    out.push({ raw: s, lineNo: i + 1 });
  } 
    　  // 7) 保険：何も取れなかった時に最低1問だけ作る（0件回避）
    if (out.length === 0) {
      const t = text.replace(/[。！？]$/, "");
      if (t.length >= 25 && t.length <= 120) {
        const mid = Math.floor(t.length * 0.45);
        out.push(makeCandidate({
          type: "fill",
          question: withHeading(heading, t.slice(0, mid) + "（　　　）"),
          answer: t.slice(mid),
          source_line,
          meta: { kind: "fallback" },
        }));
      }
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
console.log("BOOT: about to listen...");
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

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

