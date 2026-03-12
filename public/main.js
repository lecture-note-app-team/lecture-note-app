async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}

  if (!res.ok) {
    // ★ここが重要：server.js の { detail: "..." } を優先して表示
    const msg = data?.detail || data?.message || text || "API error";
    throw new Error(msg);
  }

  return data;
}

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function getForm() {
  return {
    community_id: $("community_id")?.value ? Number($("community_id").value) : null,
    university_name: $("university_name")?.value.trim() || "",
    author_name: $("author_name")?.value.trim() || "",
    course_name: $("course_name")?.value.trim() || "",
    lecture_no: $("lecture_no")?.value.trim() || "",
    lecture_date: $("lecture_date")?.value || "",
    title: $("title")?.value.trim() || "",
    body_raw: $("body_raw")?.value.trim() || "",
    visibility: $("visibility")?.value || "public",
    source_type: window.__noteSourceType || "text",
  };
}

function setImageStatus(message, kind = "info") {
  const el = $("image_status");
  if (!el) return;
  el.textContent = message || "";
  el.className = `small hint image-status ${kind}`;
}

function setPreview(text) {
  if ($("preview")) $("preview").textContent = text || "";
}

function validateForSave(data) {
  const missing = [];
  const isCommunity = !!data.community_id;

  if (!isCommunity) {
    if (!data.university_name) missing.push("大学名（公開先）");
  }

  if (!data.course_name) missing.push("授業名");
  if (!data.lecture_no) missing.push("回（第◯回）");
  if (!data.lecture_date) missing.push("日付");
  if (!data.title) missing.push("タイトル");
  if (!data.body_raw) missing.push("本文");

  if (missing.length) {
    alert("未入力があります：\n- " + missing.join("\n- "));
    return false;
  }
  return true;
}

// 一覧：大学名 + 授業名で絞り込み
async function refreshList() {
  const el = $("list");
  if (!el) return;

  const u = $("university_search")?.value.trim() || "";
  const course = $("course_search")?.value.trim() || "";
  el.innerHTML = "";

  if (!u) {
    el.textContent = "コミュニティ名を入れて検索してください。";
    return;
  }

  let url = "/api/notes?university_name=" + encodeURIComponent(u);
  if (course) url += "&course=" + encodeURIComponent(course);

  let list = [];
  try {
    list = await api(url);
  } catch (e) {
    el.innerHTML = `<div class="card"><strong>一覧取得に失敗</strong><br>${escapeHtml(e.message)}</div>`;
    return;
  }

  if (!Array.isArray(list) || list.length === 0) {
    el.textContent = course
      ? "（この大学・この授業名に一致するノートはありません）"
      : "（この大学のノートはまだありません）";
    return;
  }

  for (const n of list) {
    const div = document.createElement("div");
    div.className = "card";

    const author = n.author_name ? ` / 投稿：${escapeHtml(n.author_name)}` : "";
    const safeTitle = escapeHtml(n.title || "(no title)");

    const detailUrl = `/note_detail.html?id=${encodeURIComponent(n.id)}`;

    div.innerHTML = `
      <div><strong>${safeTitle}</strong></div>
      <div>${escapeHtml(n.course_name)} / ${escapeHtml(n.lecture_no)} / ${n.lecture_date}${author}</div>
      <div style="margin-top:8px; display:flex; gap:10px; flex-wrap:wrap;">
        <a href="${detailUrl}">詳細を開く</a>
      </div>
    `;
    el.appendChild(div);
  }
}

async function onExtractImageText() {
  const fileInput = $("note_image");
  const file = fileInput?.files?.[0];

  if (!file) {
    setImageStatus("画像ファイルを選択してください。", "warn");
    return;
  }

  setImageStatus("画像を解析中です...", "info");

  try {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || "");
        const b64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : "";
        resolve(b64);
      };
      reader.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
      reader.readAsDataURL(file);
    });

    const res = await fetch("/api/notes/extract-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_base64: base64,
        mime_type: file.type,
        file_name: file.name,
        file_size: file.size,
      }),
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}

    if (!res.ok) {
      const msg = data?.message || text || "画像からの文字抽出に失敗しました";
      throw new Error(msg);
    }

    const extracted = String(data?.text || "").trim();
    if (!extracted) {
      throw new Error("画像から文字を抽出できませんでした。鮮明な画像で再試行してください。");
    }

    if ($("body_raw")) $("body_raw").value = extracted;
    window.__noteSourceType = "image";
    setImageStatus("文字を抽出しました。必要に応じて本文を編集して保存してください。", "success");
  } catch (e) {
    window.__noteSourceType = "text";
    setImageStatus(e.message, "error");
  }
}

async function onPreview() {
  try {
    const data = getForm();

    const missing = [];
    if (!data.course_name) missing.push("授業名");
    if (!data.lecture_no) missing.push("回（第◯回）");
    if (!data.lecture_date) missing.push("日付");
    if (!data.title) missing.push("タイトル");
    if (!data.body_raw) missing.push("本文");
    if (missing.length) {
      alert("プレビューに必要な未入力があります：\n- " + missing.join("\n- "));
      return;
    }

    const r = await api("/api/notes/preview", {
      method: "POST",
      body: JSON.stringify(data),
    });

    setPreview(r.body_md);
  } catch (e) {
    alert("プレビュー失敗: " + e.message);
  }
}

async function tryGenerateQuiz(noteId) {
  // チェックがOFFなら何もしない
  const auto = $("auto_quiz");
  if (!auto || !auto.checked) return { skipped: true };

  try {
    const r = await api(`/api/notes/${noteId}/quizzes/generate`, {
      method: "POST",
      body: JSON.stringify({ mode: "replace" }),
    });
    return { ok: true, inserted: r.inserted ?? null };
  } catch (e) {
    // 保存自体は成功させたいので、ここは握りつぶしてメッセージだけ返す
    return { ok: false, error: e.message };
  }
}

async function onSave() {
  try {
    const data = getForm();
    if (!validateForSave(data)) return;

    const r = await api("/api/notes", {
      method: "POST",
      body: JSON.stringify(data),
    });

    // 保存成功
    let msg = `保存しました！\nノートID: ${r.id}`;

    // ★保存後にクイズ自動生成（作者のみ。未ログインなら /api/notes 自体が401なのでここには来ない）
    const quiz = await tryGenerateQuiz(r.id);
    if (quiz?.ok) {
      msg += `\nクイズ生成：OK（${quiz.inserted ?? "?"}件）`;
    } else if (quiz && quiz.ok === false) {
      msg += `\nクイズ生成：失敗（${quiz.error}）`;
    }

    alert(msg);

    // 公開投稿なら検索欄同期 & 一覧更新
    if (!data.community_id) {
      if ($("university_search")) $("university_search").value = data.university_name;
      await refreshList();
    }

    setPreview("");
  } catch (e) {
    alert("保存失敗: " + e.message);
  }
}

// 投稿フォームの大学名 → 検索欄に同期
function syncUniversityToSearch() {
  const v = $("university_name")?.value.trim() || "";
  if ($("university_search")) $("university_search").value = v;
}

window.__noteSourceType = "text";

// ---- 初期化 ----
$("btnExtractImageText")?.addEventListener("click", onExtractImageText);
$("btnPreview")?.addEventListener("click", onPreview);
$("btnSave")?.addEventListener("click", onSave);
$("btnSearch")?.addEventListener("click", refreshList);

$("university_search")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") refreshList();
});
$("course_search")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") refreshList();
});

$("body_raw")?.addEventListener("input", () => {
  if (!$("note_image")?.files?.length) {
    window.__noteSourceType = "text";
  }
});

$("university_name")?.addEventListener("input", syncUniversityToSearch);
$("university_name")?.addEventListener("change", refreshList);

if ($("list")) $("list").textContent = "コミュニティ名を入れて検索してください。";

// ===== コミュニティ検索（参加申請つき）=====
async function searchCommunities() {
  const qEl = document.getElementById("communitySearchQ");
  const box = document.getElementById("communitySearchResult");
  if (!qEl || !box) return; // index.html以外でも落ちない

  const q = qEl.value.trim();
  if (!q) {
    box.innerHTML = `<div class="muted">検索ワードを入力してね</div>`;
    return;
  }

  box.innerHTML = `<div class="muted">検索中...</div>`;

  try {
    const data = await api(`/api/communities?q=${encodeURIComponent(q)}`);
    const list = data.communities || [];
    const loggedIn = !!data.loggedIn;

    if (!list.length) {
      box.innerHTML = `<div class="muted">見つかりませんでした</div>`;
      return;
    }

    box.innerHTML = list.map(c => {
      const member = Number(c.is_member || 0) === 1;
      const pending = Number(c.has_pending || 0) === 1;

      let right = "";
      if (member) right = `<span class="muted">参加済み</span>`;
      else if (pending) right = `<span class="muted">申請済み</span>`;
      else if (!loggedIn) right = `<span class="muted">参加申請はログイン後に利用できます</span>`;
      else right = `<button data-req="${c.id}">参加申請</button>`;

      return `
        <div class="item" style="display:flex; justify-content:space-between; gap:10px; align-items:center;">
          <div class="title">${escapeHtml(c.name)}</div>
          <div>${right}</div>
        </div>
      `;
    }).join("");

    // 申請ボタン
    box.querySelectorAll("button[data-req]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const communityId = Number(btn.dataset.req);
        const message = prompt("参加申請メッセージ（任意）") || "";
        btn.disabled = true;

        try {
          await api(`/api/communities/${communityId}/join-requests`, {
            method: "POST",
            body: JSON.stringify({ message }),
          });
          btn.outerHTML = `<span class="muted">申請済み</span>`;
        } catch (e) {
          alert(e.message || "申請に失敗しました");
          btn.disabled = false;
        }
      });
    });

  } catch (e) {
    box.innerHTML = `<div class="error">${escapeHtml(e.message || "検索に失敗")}</div>`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("communitySearchBtn")?.addEventListener("click", searchCommunities);
  document.getElementById("communitySearchQ")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchCommunities();
  });


  // ★追加：mypage用（要素がある時だけ表示）
  renderMyCommunities();
});

// ===== マイページ：参加中コミュニティ表示 =====
async function renderMyCommunities() {
  const box = $("myCommunities");
  if (!box) return; // mypage.html以外では何もしない

  box.innerHTML = `<div class="muted">読み込み中...</div>`;

  try {
    const list = await api("/api/communities/mine"); // ← サーバーはOK確認済み
    if (!Array.isArray(list) || list.length === 0) {
      box.innerHTML = `<div class="muted">（参加中コミュニティはありません）</div>`;
      return;
    }

    box.innerHTML = list.map(c => `
      <div class="card" style="margin:10px 0;">
        <div><strong>${escapeHtml(c.name)}</strong></div>
        <div class="small">
          役割：${escapeHtml(c.role || "")}
          / メンバー数：${Number(c.member_count ?? 0)}
        </div>
      </div>
    `).join("");
  } catch (e) {
    box.innerHTML = `<div class="error">取得失敗：${escapeHtml(e.message)}</div>`;
  }
}
