class ApiError extends Error {
  constructor(message, status = 0, data = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}

  if (!res.ok) {
    const message = data.detail || data.message || text || "API error";
    throw new ApiError(message, res.status, data);
  }
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

function setButtonLoading(btn, loading, loadingText = "処理中…") {
  if (!btn) return;
  if (loading) {
    btn.dataset.originalText = btn.textContent;
    btn.textContent = loadingText;
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.originalText || btn.textContent;
    btn.disabled = false;
  }
}

function formatErrorMessage(err) {
  if (!(err instanceof ApiError)) return `エラー: ${err.message || "不明なエラー"}`;

  if (err.status === 401) return "ログインが必要です。ログイン後にお試しください。";
  if (err.status === 402) return "有料プラン契約が必要です。Proプランに登録してください。";
  if (err.status === 403) return "Pro限定または権限不足のため実行できません。";
  if (err.status === 429) return "今月の利用上限に達しました。来月まで待つかプランをご確認ください。";

  return err.message || "API呼び出しに失敗しました";
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

function updateActionMessage(targetEl, type, message, html = false) {
  if (!targetEl) return;
  targetEl.className = `note-action-message ${type}`;
  if (html) targetEl.innerHTML = message;
  else targetEl.textContent = message;
}

async function handleGenerateQuiz(noteId, messageEl, triggerBtn) {
  setButtonLoading(triggerBtn, true, "生成中…");
  updateActionMessage(messageEl, "info", "クイズを生成しています…");

  try {
    const result = await api(`/api/notes/${noteId}/generate-quiz`, { method: "POST" });
    let message = `クイズを ${Number(result.generatedCount || 0)} 件生成しました。`;

    try {
      const quizzes = await api(`/api/notes/${noteId}/quizzes`);
      if (Array.isArray(quizzes)) message += `（合計 ${quizzes.length} 件）`;
    } catch {}

    updateActionMessage(messageEl, "success", message);
    await loadBillingInfo();
  } catch (err) {
    updateActionMessage(messageEl, "error", formatErrorMessage(err));
  } finally {
    setButtonLoading(triggerBtn, false);
  }
}

async function handleAiSummary(noteId, messageEl, triggerBtn) {
  setButtonLoading(triggerBtn, true, "要約中…");
  updateActionMessage(messageEl, "info", "AI要約を作成しています…");

  try {
    const result = await api(`/api/notes/${noteId}/ai-summary`, { method: "POST" });
    const summary = escapeHtml(result.summary || "（要約結果なし）");
    updateActionMessage(messageEl, "success", `<div><b>要約結果</b></div><div style="margin-top:4px;">${summary}</div>`, true);
    await loadBillingInfo();
  } catch (err) {
    updateActionMessage(messageEl, "error", formatErrorMessage(err));
  } finally {
    setButtonLoading(triggerBtn, false);
  }
}

async function handleExportPdf(noteId, messageEl, triggerBtn) {
  setButtonLoading(triggerBtn, true, "出力中…");
  updateActionMessage(messageEl, "info", "PDFを出力しています…");

  try {
    const result = await api(`/api/notes/${noteId}/export-pdf`, { method: "POST" });
    const msg = escapeHtml(result.message || "PDF出力リクエストが完了しました");
    const url = result.downloadUrl ? `<a href="${escapeHtml(result.downloadUrl)}" target="_blank" rel="noopener">ダウンロードリンク</a>` : "";
    updateActionMessage(messageEl, "success", `<div>${msg}</div>${url ? `<div style="margin-top:4px;">${url}</div>` : ""}`, true);
  } catch (err) {
    updateActionMessage(messageEl, "error", formatErrorMessage(err));
  } finally {
    setButtonLoading(triggerBtn, false);
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
      const comm = n.community_id ? ` <span style="font-size:12px; color:#666;">🏠コミュID:${n.community_id}</span>` : "";

      div.innerHTML = `
        <div style="display:flex; gap:10px; align-items:baseline; flex-wrap:wrap;">
          <strong>${escapeHtml(n.title)}</strong>
          <span style="font-size:12px; color:#666;">${tag}</span>
          ${comm}
        </div>
        <div>${escapeHtml(n.course_name)} / ${escapeHtml(n.lecture_no)} / ${n.lecture_date}${author}</div>
        <div class="small" style="margin-top:6px;">追加機能: クイズ生成（無料枠あり） / AI要約（無料枠あり） / PDF出力（Pro）</div>
        <div class="row" style="margin-top:8px;">
          <button class="btnOpen">開く</button>
          <button class="btnToggle">${toggleButtonText(n.visibility)}</button>
          <button class="btnDelete">削除</button>
          <button class="btnGenerateQuiz">クイズ生成</button>
          <button class="btnAiSummary">AI要約</button>
          <button class="btnExportPdf">PDF出力</button>
        </div>
        <div class="note-action-message" style="margin-top:8px;"></div>
      `;

      const msgEl = div.querySelector(".note-action-message");
      const btnGenerate = div.querySelector(".btnGenerateQuiz");
      const btnSummary = div.querySelector(".btnAiSummary");
      const btnPdf = div.querySelector(".btnExportPdf");

      div.querySelector(".btnOpen").addEventListener("click", () => {
        location.href = "/note_detail.html?id=" + n.id;
      });

      div.querySelector(".btnToggle").addEventListener("click", () => {
        changeVisibility(n.id, n.visibility, n.title);
      });

      div.querySelector(".btnDelete").addEventListener("click", () => {
        deleteNote(n.id, n.title);
      });

      btnGenerate.addEventListener("click", () => handleGenerateQuiz(n.id, msgEl, btnGenerate));
      btnSummary.addEventListener("click", () => handleAiSummary(n.id, msgEl, btnSummary));
      btnPdf.addEventListener("click", () => handleExportPdf(n.id, msgEl, btnPdf));

      listEl.appendChild(div);
    }
  } catch (e) {
    listEl.innerHTML = `取得失敗: ${escapeHtml(e.message)}<br><a href="/login.html">ログイン</a>`;
  }
}

function planLabel(planCode) {
  return planCode === "pro" ? "Pro" : "Free";
}

function subscriptionLabel(subscription, isActiveSubscription, planCode) {
  if (!subscription) return planCode === "pro" ? "契約情報確認中" : "未契約";
  if (subscription.cancel_at_period_end) return "解約予定（期間終了まで利用可）";
  if (isActiveSubscription) return "有効";
  return subscription.subscription_status || "無効";
}

function renderFeatureList(features = {}) {
  const el = $("billingFeatures");
  if (!el) return;

  const rows = [
    `ノート上限: ${features.max_notes === -1 ? "無制限" : Number(features.max_notes || 0) + "件"}`,
    `AI要約: 月 ${Number(features.ai_summary_monthly_limit || 0)} 回`,
    `クイズ生成: 月 ${Number(features.quiz_generation_monthly_limit || 0)} 回`,
    `PDF出力: ${features.can_export_pdf ? "利用可（Pro）" : "利用不可（Pro限定）"}`,
  ];

  el.innerHTML = rows.map((r) => `<li>${escapeHtml(r)}</li>`).join("");
}

function renderBilling(data) {
  const planCode = data?.planCode || "free";
  const features = data?.features || {};
  const usage = data?.usage || {};
  const isPro = planCode === "pro";

  $("billingPlan").textContent = planLabel(planCode);
  $("billingStatus").textContent = subscriptionLabel(data?.subscription, data?.isActiveSubscription, planCode);
  $("billingAiUsage").textContent = `${Number(usage.ai_summary || 0)} / ${features.ai_summary_monthly_limit ?? "-"}`;
  $("billingQuizUsage").textContent = `${Number(usage.quiz_generation || 0)} / ${features.quiz_generation_monthly_limit ?? "-"}`;

  const msg = $("billingMessage");
  msg.className = `small ${isPro ? "billing-ok" : "billing-free"}`;
  msg.textContent = isPro
    ? "現在Proプランです。Pro限定機能（PDF出力など）を利用できます。"
    : "現在Freeプランです。PDF出力などはPro登録後に利用できます。";

  renderFeatureList(features);

  const btnSubscribe = $("btnSubscribePro");
  const btnCancel = $("btnCancelSubscription");
  if (btnSubscribe) {
    btnSubscribe.disabled = isPro;
    btnSubscribe.textContent = isPro ? "契約中（Pro）" : "Proプランに登録";
    btnSubscribe.classList.toggle("btn-pro-active", !isPro);
  }
  if (btnCancel) {
    const canCancel = isPro && data?.isActiveSubscription;
    btnCancel.disabled = !canCancel;
    btnCancel.title = canCancel ? "解約を予約します" : "有効なPro契約時に利用できます";
  }
}

async function loadBillingInfo() {
  const msg = $("billingMessage");
  if (msg) {
    msg.className = "small";
    msg.textContent = "課金情報を読み込み中…";
  }

  try {
    const data = await api("/api/billing/me");
    renderBilling(data);
  } catch (err) {
    if ([401, 403].includes(err.status)) {
      msg.textContent = "課金情報の表示にはログインが必要です。";
      return;
    }

    msg.className = "small note-action-message error";
    msg.textContent = `課金情報の取得に失敗しました: ${formatErrorMessage(err)}`;
  }
}

async function redirectToReturnedUrl(path, button, loadingText) {
  setButtonLoading(button, true, loadingText);
  try {
    const data = await api(path, { method: "POST" });
    if (!data.url) throw new Error("遷移先URLが取得できませんでした");
    location.href = data.url;
  } catch (err) {
    alert(formatErrorMessage(err));
    setButtonLoading(button, false);
  }
}

async function handleCancelSubscription(button) {
  const ok = confirm("本当に解約しますか？\n期間終了まではPro機能を使えます。");
  if (!ok) return;

  setButtonLoading(button, true, "解約処理中…");
  try {
    await api("/api/billing/cancel", { method: "POST" });
    alert("解約を受け付けました。期間終了時に停止されます。");
    await loadBillingInfo();
  } catch (err) {
    alert(formatErrorMessage(err));
  } finally {
    setButtonLoading(button, false);
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
        location.href = "/note_detail.html?id=" + n.id + "&from=" + encodeURIComponent("/mypage.html");
      });

      el.appendChild(div);
    }
  } catch (e) {
    el.innerHTML = `取得失敗: ${escapeHtml(e.message)}`;
  }
}

async function loadCommunitiesOnMyPage() {
  const ul = $("communitiesList");
  if (!ul) return;

  ul.innerHTML = "<li>読み込み中…</li>";

  try {
    const me = await api("/api/me");
    if (!me.loggedIn) {
      ul.innerHTML = "<li>ログインしてください。</li>";
      return;
    }

    const list = await api("/api/communities/mine");

    if (!list || list.length === 0) {
      ul.innerHTML = "<li>（参加中コミュニティはありません）</li>";
      return;
    }

    ul.innerHTML = "";
    for (const c of list) {
      const li = document.createElement("li");
      const isAdmin = c.role === "admin";
      const roleLabel = isAdmin ? "管理者" : "メンバー";

      li.innerHTML = `
        ID: <b>${c.id}</b> / ${escapeHtml(c.name || "")}
        <span style="margin-left:6px; font-size:12px; color:#666;">👥 ${Number(c.member_count || 0)}人</span>
        <span style="display:inline-block; padding:2px 8px; border-radius:999px; background:#eee; font-size:12px; margin-left:6px;">${roleLabel}</span>
        ${isAdmin
          ? `<button data-delete-comm="${c.id}" style="margin-left:8px;">削除（解散）</button>`
          : `<button data-leave-comm="${c.id}" style="margin-left:8px;">退会</button>`}
      `;

      ul.appendChild(li);
    }

    ul.querySelectorAll('button[data-delete-comm]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.getAttribute("data-delete-comm"));
        if (!id) return;

        const ok = confirm(
          `コミュニティ(ID:${id})を削除します。\n※コミュ内ノートも全削除されます（元に戻せません）。\n\n本当に削除しますか？`
        );
        if (!ok) return;

        try {
          setButtonLoading(btn, true, "削除中…");
          await api(`/api/communities/${id}`, { method: "DELETE" });
          alert("削除しました");
          await loadCommunitiesOnMyPage();
        } catch (e) {
          alert("削除失敗: " + e.message);
          setButtonLoading(btn, false);
        }
      });
    });

    ul.querySelectorAll('button[data-leave-comm]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.getAttribute("data-leave-comm"));
        if (!id) return;

        const ok = confirm(`コミュニティ(ID:${id})から退会しますか？`);
        if (!ok) return;

        try {
          setButtonLoading(btn, true, "退会中…");
          await api(`/api/communities/${id}/leave`, { method: "POST" });
          alert("退会しました");
          await loadCommunitiesOnMyPage();
        } catch (e) {
          alert("退会失敗: " + e.message);
          setButtonLoading(btn, false);
        }
      });
    });
  } catch (e) {
    ul.innerHTML = `<li>取得失敗: ${escapeHtml(e.message)}</li>`;
  }
}

async function loadJoinRequestApprovals() {
  const box = document.getElementById("joinRequestApprovals");
  if (!box) return;

  box.innerHTML = `<div class="muted">読み込み中...</div>`;

  try {
    const myComms = await api("/api/communities/mine");

    if (!Array.isArray(myComms) || myComms.length === 0) {
      box.innerHTML = `<div class="muted">所属コミュニティがありません</div>`;
      return;
    }

    const groups = [];
    for (const c of myComms) {
      try {
        const data = await api(`/api/communities/${c.id}/join-requests`);
        const reqs = data.requests || [];
        if (reqs.length) groups.push({ community: c, requests: reqs });
      } catch {}
    }

    if (!groups.length) {
      box.innerHTML = `<div class="muted">承認待ちの申請はありません</div>`;
      return;
    }

    box.innerHTML = groups.map((g) => `
      <div class="card" style="margin-top:10px;">
        <div class="title" style="margin-bottom:8px;">${escapeHtml(g.community.name)}</div>
        ${g.requests.map((r) => `
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
    await loadJoinRequestApprovals();
  } catch (err) {
    alert(err.message || "操作に失敗しました");
    btn.disabled = false;
  }
});

async function initMyPage() {
  const me = await loadMe();
  if (!me) return;

  $("btnLogout")?.addEventListener("click", logout);
  $("btnDeleteAccount")?.addEventListener("click", () => deleteAccount(me.username));

  $("btnReloadCommunities")?.addEventListener("click", loadCommunitiesOnMyPage);
  $("btnReloadBilling")?.addEventListener("click", loadBillingInfo);
  $("btnSubscribePro")?.addEventListener("click", (e) => {
    redirectToReturnedUrl("/api/billing/create-checkout-session", e.currentTarget, "遷移中…");
  });
  $("btnOpenPortal")?.addEventListener("click", (e) => {
    redirectToReturnedUrl("/api/billing/portal", e.currentTarget, "遷移中…");
  });
  $("btnCancelSubscription")?.addEventListener("click", (e) => {
    handleCancelSubscription(e.currentTarget);
  });

  await Promise.all([
    loadBillingInfo(),
    loadMyNotes(),
    loadCommunityNotes(),
    loadCommunitiesOnMyPage(),
    loadJoinRequestApprovals(),
  ]);
}

document.addEventListener("DOMContentLoaded", initMyPage);
