async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!res.ok) throw new Error(data.detail || data.message || text || "API error");
  return data;
}

function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function visibilityLabel(v) {
  return v === "private" ? "🔒 非公開" : "🌐 公開";
}

function nextVisibility(v) {
  return v === "private" ? "public" : "private";
}

function toggleButtonText(v) {
  return v === "private" ? "公開にする" : "非公開にする";
}

async function loadMe() {
  const meEl = $("me");
  try {
    const me = await api("/api/me");
    if (!me.loggedIn) {
      meEl.innerHTML = `未ログインです。<a href="/login.html">ログイン</a>してください。`;
      return null;
    }
    meEl.textContent = `ログイン中：${me.username}`;
    return me;
  } catch (e) {
    meEl.textContent = "取得失敗: " + e.message;
    return null;
  }
}

async function logout() {
  try {
    await api("/api/logout", { method: "POST" });
    alert("ログアウトしました");
    location.href = "/login.html";
  } catch (e) {
    alert("ログアウト失敗: " + e.message);
  }
}

async function deleteNote(noteId, title) {
  const ok = confirm(`この投稿を削除しますか？\n\n「${title}」\n\n※取り消せません`);
  if (!ok) return;

  try {
    await api("/api/notes/" + noteId, { method: "DELETE" });
    alert("削除しました");
    await loadMyNotes();
  } catch (e) {
    alert("削除失敗: " + e.message);
  }
}

async function changeVisibility(noteId, currentVisibility, title) {
  const next = nextVisibility(currentVisibility);
  const msg = next === "private"
    ? `このノートを「非公開」にしますか？\n\n「${title}」\n\n・公開一覧から消えます\n・本人だけが見れます`
    : `このノートを「公開」にしますか？\n\n「${title}」\n\n・公開一覧に表示されます`;

  const ok = confirm(msg);
  if (!ok) return;

  try {
    await api("/api/notes/" + noteId + "/visibility", {
      method: "PATCH",
      body: JSON.stringify({ visibility: next }),
    });
    await loadMyNotes();
  } catch (e) {
    alert("変更失敗: " + e.message);
  }
}

async function deleteAccount(username) {
  const ok1 = confirm(
    `退会しますか？\n\nユーザー：${username}\n\n※自分の投稿もすべて削除され、取り消せません`
  );
  if (!ok1) return;

  const ok2 = confirm("最終確認：本当にアカウント削除しますか？");
  if (!ok2) return;

  try {
    await api("/api/account", { method: "DELETE" });
    alert("アカウントを削除しました");
    location.href = "/login.html";
  } catch (e) {
    alert("退会失敗: " + e.message);
  }
}

async function loadMyNotes() {
  const listEl = $("myList");
  listEl.innerHTML = "読み込み中…";

  try {
    const rows = await api("/api/my-notes");

    if (!Array.isArray(rows) || rows.length === 0) {
      listEl.textContent = "（まだ投稿がありません）";
      return;
    }

    listEl.innerHTML = "";

    for (const n of rows) {
      const div = document.createElement("div");
      div.className = "card";

      const tag = visibilityLabel(n.visibility);
      const author = n.author_name ? ` / 投稿名：${escapeHtml(n.author_name)}` : "";

      // community_id があるノートは「コミュ限定」っぽい表示にする（任意）
      const comm = n.community_id ? ` <span style="font-size:12px; color:#666;">🏠コミュID:${n.community_id}</span>` : "";

      div.innerHTML = `
        <div style="display:flex; gap:10px; align-items:baseline; flex-wrap:wrap;">
          <strong>${escapeHtml(n.title)}</strong>
          <span style="font-size:12px; color:#666;">${tag}</span>
          ${comm}
        </div>
        <div>${escapeHtml(n.course_name)} / ${escapeHtml(n.lecture_no)} / ${n.lecture_date}${author}</div>
        <div class="row" style="margin-top:8px;">
          <button class="btnOpen">開く</button>
          <button class="btnToggle">${toggleButtonText(n.visibility)}</button>
          <button class="btnDelete">削除</button>
        </div>
      `;

      div.querySelector(".btnOpen").addEventListener("click", () => {
        // ★ここが修正点：note_detail.html に飛ばす
        location.href = "/note_detail.html?id=" + n.id;
      });

      div.querySelector(".btnToggle").addEventListener("click", () => {
        changeVisibility(n.id, n.visibility, n.title);
      });

      div.querySelector(".btnDelete").addEventListener("click", () => {
        deleteNote(n.id, n.title);
      });

      listEl.appendChild(div);
    }
  } catch (e) {
    listEl.innerHTML = `取得失敗: ${escapeHtml(e.message)}<br><a href="/login.html">ログイン</a>`;
  }
}

async function loadCommunityNotes() {
  const el = document.getElementById("communityList");
  if (!el) return;

  el.textContent = "読み込み中…";

  try {
    const rows = await api("/api/community-notes");

    if (!Array.isArray(rows) || rows.length === 0) {
      el.textContent = "（参加中コミュのノートはまだありません）";
      return;
    }

    el.innerHTML = "";

    for (const n of rows) {
      const div = document.createElement("div");
      div.className = "card";

      const author = n.author_name ? ` / 投稿：${escapeHtml(n.author_name)}` : "";
      const cname = n.community_name ? `🏷 ${escapeHtml(n.community_name)}` : `🏷 community:${n.community_id}`;

      div.innerHTML = `
        <div style="display:flex; gap:10px; align-items:baseline; flex-wrap:wrap;">
          <strong>${escapeHtml(n.title)}</strong>
          <span style="font-size:12px; color:#666;">${cname}</span>
        </div>
        <div>${escapeHtml(n.course_name)} / ${escapeHtml(n.lecture_no)} / ${n.lecture_date}${author}</div>
        <div class="row" style="margin-top:8px;">
          <button class="btnOpen">開く</button>
        </div>
      `;

      div.querySelector(".btnOpen").addEventListener("click", () => {
        // note_detail.html を使ってるならこっちに
        location.href = "/note_detail.html?id=" + n.id + "&from=" + encodeURIComponent("/mypage.html");
      });

      el.appendChild(div);
    }
  } catch (e) {
    el.innerHTML = `取得失敗: ${escapeHtml(e.message)}`;
  }
}

(async () => {
  const me = await loadMe();
  if (!me) return;

  $("btnLogout")?.addEventListener("click", logout);
  $("btnDeleteAccount")?.addEventListener("click", () => deleteAccount(me.username));

  await loadMyNotes();
  await loadCommunityNotes(); // ★追加
})();
