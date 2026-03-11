function $(id) { return document.getElementById(id); }

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!res.ok) throw new Error(data.message || data.detail || text || "API error");
  return data;
}

function esc(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

async function load() {
  const type = $("filterType").value;
  const q = type ? `?quiz_type=${encodeURIComponent(type)}` : "";
  const result = await api(`/api/quizzes/mine${q}`);
  const rows = result.data.quizzes;
  $("message").textContent = `${rows.length}件`;

  if (!rows.length) {
    $("quizList").innerHTML = "<div class='small'>クイズはまだありません。</div>";
    return;
  }

  $("quizList").innerHTML = rows.map((qz) => `
    <div class="card">
      <div><strong>${esc(qz.title)}</strong> / ${esc(qz.quiz_type)}</div>
      <div class="small">${esc(qz.question_text).slice(0, 120)}</div>
      <div class="small">作成日: ${esc(qz.created_at)}</div>
      <div class="row" style="margin-top:8px;">
        <button data-edit="${qz.id}">編集</button>
        <button data-delete="${qz.id}">削除</button>
      </div>
    </div>
  `).join("");

  document.querySelectorAll("button[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("削除しますか？")) return;
      try {
        await api(`/api/quizzes/${btn.dataset.delete}`, { method: "DELETE" });
        await load();
      } catch (e) {
        $("message").textContent = e.message;
      }
    });
  });

  document.querySelectorAll("button[data-edit]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const quiz = await api(`/api/quizzes/${btn.dataset.edit}`);
      location.href = `/create-quiz.html?edit_id=${quiz.data.id}`;
    });
  });
}

(async () => {
  $("btnReload").addEventListener("click", load);
  $("filterType").addEventListener("change", load);
  await load();
})();
