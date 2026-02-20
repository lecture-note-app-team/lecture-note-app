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


async function loadCommunitiesOnMyPage(){
  const ul = $("communitiesList");
  if (!ul) return; // UIを置いてないなら何もしない

  ul.innerHTML = "<li>読み込み中…</li>";

  try{
    const me = await api("/api/me");
    if (!me.loggedIn){
      ul.innerHTML = "<li>ログインしてください。</li>";
      return;
    }

    const list = await api("/api/communities/mine");

    if (!list || list.length === 0){
      ul.innerHTML = "<li>（参加中コミュニティはありません）</li>";
      return;
    }

    ul.innerHTML = "";
    for (const c of list){
      const li = document.createElement("li");

    const isAdmin = c.role === "admin";
    const roleLabel = isAdmin ? "管理者" : "メンバー";

    li.innerHTML = `
      ID: <b>${c.id}</b> / ${escapeHtml(c.name || "")}
      <span style="margin-left:6px; font-size:12px; color:#666;">
        👥 ${Number(c.member_count || 0)}人
      </span>
      <span style="display:inline-block; padding:2px 8px; border-radius:999px; background:#eee; font-size:12px; margin-left:6px;">
        ${roleLabel}
      </span>
      ${isAdmin ? `<button data-delete-comm="${c.id}" style="margin-left:8px;">削除（解散）</button>` : ""}
    `;

      ul.appendChild(li);
    }

    // 削除ボタンのイベント（まとめて）
    ul.querySelectorAll('button[data-delete-comm]').forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.getAttribute("data-delete-comm"));
        if (!id) return;

        const ok = confirm(
          `コミュニティ(ID:${id})を削除します。\n` +
          `※コミュ内ノートも全削除されます（元に戻せません）。\n\n本当に削除しますか？`
        );
        if (!ok) return;

        try{
          btn.disabled = true;
          btn.textContent = "削除中…";
          await api(`/api/communities/${id}`, { method: "DELETE" });
          alert("削除しました");
          await loadCommunitiesOnMyPage();
        } catch (e){
          alert("削除失敗: " + e.message);
          btn.disabled = false;
          btn.textContent = "削除（解散）";
        }
      });
    });

  } catch(e){
    ul.innerHTML = `<li>取得失敗: ${escapeHtml(e.message)}</li>`;
  }
}

// 退会ボタンのイベント
ul.querySelectorAll('button[data-leave-comm]').forEach(btn => {
  btn.addEventListener("click", async () => {
    const id = Number(btn.getAttribute("data-leave-comm"));
    if (!id) return;

    const ok = confirm(`コミュニティ(ID:${id})を退会しますか？\n※コミュ内ノートが見られなくなります`);
    if (!ok) return;

    try {
      btn.disabled = true;
      btn.textContent = "退会中…";
      await api(`/api/communities/${id}/leave`, { method: "POST" });
      alert("退会しました");
      await loadCommunitiesOnMyPage();
    } catch (e) {
      alert("退会失敗: " + e.message);
      btn.disabled = false;
      btn.textContent = "退会";
    }
  });
});

// 更新ボタン
if ($("btnReloadCommunities")){
  $("btnReloadCommunities").addEventListener("click", loadCommunitiesOnMyPage);
}

// ページ表示時に読み込み（DOMができてから）
document.addEventListener("DOMContentLoaded", () => {
  loadCommunitiesOnMyPage();
});

async function loadJoinRequestApprovals() {
  const box = document.getElementById("joinRequestApprovals");
  if (!box) return;

  box.innerHTML = `<div class="muted">読み込み中...</div>`;

  try {
    // 既存：自分の参加コミュ一覧（あなたのserver.jsにある）
    const myComms = await api("/api/communities/mine");

    if (!Array.isArray(myComms) || myComms.length === 0) {
      box.innerHTML = `<div class="muted">所属コミュニティがありません</div>`;
      return;
    }

    // 参加コミュごとのpending申請を取得
    const groups = [];
    for (const c of myComms) {
      try {
        const data = await api(`/api/communities/${c.id}/join-requests`);
        const reqs = data.requests || [];
        if (reqs.length) groups.push({ community: c, requests: reqs });
      } catch {
        // member/adminじゃないコミュはここで弾かれる（表示しない）
      }
    }

    if (!groups.length) {
      box.innerHTML = `<div class="muted">承認待ちの申請はありません</div>`;
      return;
    }

    box.innerHTML = groups.map(g => `
      <div class="card" style="margin-top:10px;">
        <div class="title" style="margin-bottom:8px;">${escapeHtml(g.community.name)}</div>
        ${g.requests.map(r => `
          <div class="item" style="display:flex; justify-content:space-between; gap:10px; align-items:center;">
            <div>
              <div><b>${escapeHtml(r.username)}</b></div>
              <div class="muted">${escapeHtml(r.message || "")}</div>
            </div>
            <div style="display:flex; gap:6px;">
              <button data-decide="approve" data-reqid="${r.id}">承認</button>
              <button data-decide="reject" data-reqid="${r.id}">却下</button>
            </div>
          </div>
        `).join("")}
      </div>
    `).join("");

  } catch (e) {
    box.innerHTML = `<div class="error">${escapeHtml(e.message || "読み込みに失敗")}</div>`;
  }
}

// 承認/却下（イベント委譲）
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-decide][data-reqid]");
  if (!btn) return;

  const action = btn.dataset.decide;
  const requestId = Number(btn.dataset.reqid);

  btn.disabled = true;
  try {
    await api(`/api/join-requests/${requestId}/decide`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    await loadJoinRequestApprovals(); // 再描画
  } catch (err) {
    alert(err.message || "操作に失敗しました");
    btn.disabled = false;
  }
});

// mypage.html を開いたら読み込む
document.addEventListener("DOMContentLoaded", () => {
  loadJoinRequestApprovals();
});

// ===== 非公開コミュニティ検索（参加申請つき）=====

async function searchCommunities() {
  const qEl = document.getElementById("communitySearchQ");
  const box = document.getElementById("communitySearchResult");
  if (!qEl || !box) return; // mypage以外で動いても落ちない

  const q = qEl.value.trim();
  if (!q) {
    box.innerHTML = `<div class="muted">検索ワードを入力してね</div>`;
    return;
  }

  box.innerHTML = `<div class="muted">検索中...</div>`;

  try {
    const data = await api(`/api/communities?q=${encodeURIComponent(q)}`);
    const list = data.communities || [];

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

// イベント紐付け（検索ボタン/Enter）
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("communitySearchBtn");
  const qEl = document.getElementById("communitySearchQ");
  if (btn) btn.addEventListener("click", searchCommunities);
  if (qEl) qEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchCommunities();
  });
});
