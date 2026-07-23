/**
 * 復習通知（サイト内バッジ）
 * 使い方: 各ページのbody内に <div id="reviewWidget"></div> を置いて
 *         <script src="./reviews.js?v=1"></script> を読み込むだけ。
 * 未ログイン時は何も表示しません。
 */
(function () {
  async function apiReviews(path, options) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!res.ok) throw new Error(data.message || text || "API error");
    return data;
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function ensureContainer() {
    let el = document.getElementById("reviewWidget");
    if (!el) {
      el = document.createElement("div");
      el.id = "reviewWidget";
      document.body.appendChild(el);
    }
    return el;
  }

  function render(container, items) {
    const count = items.length;
    container.innerHTML = `
      <button id="reviewBadgeBtn" class="review-badge-btn" aria-expanded="false">
        🔔 復習通知
        ${count > 0 ? `<span class="review-badge-count">${count}</span>` : ""}
      </button>
      <div id="reviewPanel" class="review-panel" hidden>
        ${count === 0
          ? `<div class="small">今のところ復習が必要なノートはありません。</div>`
          : `
            <div style="margin-bottom:8px;">
              <a href="/review.html" class="button-link">▶ 復習を始める（${count}件）</a>
            </div>
          ` + items.map((it) => `
              <div class="review-item" data-review-note="${it.note_id}">
                <div>
                  <div><strong>${esc(it.title || "(無題)")}</strong></div>
                  <div class="small">${esc(it.course_name || "")} ${esc(it.lecture_no || "")}</div>
                </div>
                <div class="review-item-actions">
                  <a href="/note_detail.html?id=${encodeURIComponent(it.note_id)}">開く</a>
                  <button data-review-done="${it.note_id}" type="button">復習した</button>
                </div>
              </div>
            `).join("")
        }
      </div>
    `;

    const btn = container.querySelector("#reviewBadgeBtn");
    const panel = container.querySelector("#reviewPanel");
    btn.addEventListener("click", () => {
      const willOpen = panel.hidden;
      panel.hidden = !willOpen;
      btn.setAttribute("aria-expanded", String(willOpen));

      // 通知の許可リクエストはユーザー操作（クリック）内で行う
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        Notification.requestPermission();
      }
    });

    container.querySelectorAll("button[data-review-done]").forEach((doneBtn) => {
      doneBtn.addEventListener("click", async () => {
        const noteId = doneBtn.dataset.reviewDone;
        doneBtn.disabled = true;
        try {
          await apiReviews(`/api/reviews/${noteId}/done`, { method: "POST" });
          await load();
        } catch (e) {
          alert("更新に失敗しました: " + e.message);
          doneBtn.disabled = false;
        }
      });
    });
  }

  // 通知の連打を防ぐため、最低でもこの間隔（ミリ秒）を空けてから再通知する
  const NOTIFY_MIN_INTERVAL_MS = 60 * 60 * 1000; // 1時間

  function maybeNotify(items) {
    if (!items.length) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return; // 許可は復習バッジのクリック時にリクエストする

    const lastAt = Number(localStorage.getItem("reviewNotifyLastAt") || 0);
    if (Date.now() - lastAt < NOTIFY_MIN_INTERVAL_MS) return;
    localStorage.setItem("reviewNotifyLastAt", String(Date.now()));

    const n = new Notification("🔔 復習の時間です", {
      body: `復習が必要なノートが${items.length}件あります。タップして復習を始めましょう。`,
      tag: "lecture-note-review",
    });
    n.onclick = () => {
      window.focus();
      location.href = "/review.html";
    };
  }

  async function load() {
    try {
      const me = await apiReviews("/api/me");
      const container = ensureContainer();
      if (!me.loggedIn) {
        container.innerHTML = "";
        return;
      }
      const data = await apiReviews("/api/reviews/due");
      const items = data.items || [];
      render(container, items);
      maybeNotify(items);
    } catch (e) {
      // 静かに失敗（通知は補助機能のため画面を壊さない）
      console.warn("review widget load failed:", e.message);
    }
  }

  document.addEventListener("DOMContentLoaded", load);
})();
