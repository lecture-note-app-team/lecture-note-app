function $(id) { return document.getElementById(id); }

let allRows = [];
let currentSortOrder = "newest";
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

function quizTypeLabel(type) {
  if (type === "multiple_choice" || type === "mcq") return "4択";
  if (type === "written") return "記述";
  if (type === "true_false") return "○×";
  if (type === "fill_blank") return "穴埋め";
  return type || "不明";
}


function parseSortTimestamp(qz) {
  const source = qz.updated_at || qz.created_at || qz.saved_at || "";
  const t = Date.parse(source);
  return Number.isNaN(t) ? 0 : t;
}

function shuffleRows(rows) {
  const cloned = rows.slice();
  for (let i = cloned.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [cloned[i], cloned[j]] = [cloned[j], cloned[i]];
  }
  return cloned;
}

function sortRows(rows, sortOrder) {
  const cloned = rows.slice();
  if (sortOrder === "oldest") {
    return cloned.sort((a, b) => parseSortTimestamp(a) - parseSortTimestamp(b));
  }
  if (sortOrder === "shuffle") {
    return shuffleRows(cloned);
  }
  return cloned.sort((a, b) => parseSortTimestamp(b) - parseSortTimestamp(a));
}

function updateSortUI() {
  const reshuffleBtn = $("btnReshuffle");
  if (!reshuffleBtn) return;
  reshuffleBtn.disabled = currentSortOrder !== "shuffle";
}

function normalizeForSearch(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKC");
}

function normalizeForAnswer(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .normalize("NFKC");
}

function buildSearchTarget(qz) {
  const choices = [qz.choice_1, qz.choice_2, qz.choice_3, qz.choice_4].filter(Boolean).join(" ");
  const tags = Array.isArray(qz.tags)
    ? qz.tags.join(" ")
    : (typeof qz.tags === "string" ? qz.tags : "");
  return normalizeForSearch([
    qz.title,
    qz.question_text,
    choices,
    qz.explanation,
    tags,
  ].join(" "));
}

function getChoiceList(qz) {
  const normalizeChoices = (list) => list
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  const direct = normalizeChoices([
    qz.choice_1,
    qz.choice_2,
    qz.choice_3,
    qz.choice_4,
    qz.option_1,
    qz.option_2,
    qz.option_3,
    qz.option_4,
  ]);
  if (direct.length >= 2) return direct;

  const parseArray = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return normalizeChoices(value);
    try {
      const parsed = JSON.parse(String(value));
      return Array.isArray(parsed) ? normalizeChoices(parsed) : [];
    } catch {
      return [];
    }
  };

  const fromArrayFields = parseArray(qz.choices).length
    ? parseArray(qz.choices)
    : parseArray(qz.options);
  if (fromArrayFields.length >= 2) return fromArrayFields;

  const lines = String(qz.question_text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const fromQuestion = [];
  for (const line of lines) {
    const m = line.match(/^(?:[1-4][\.)．、]|[①-④]|[Ａ-ＤA-D][\.)．、:：]|[a-d][\.)．、:：])\s*(.+)$/u);
    if (m?.[1]) fromQuestion.push(m[1].trim());
    if (fromQuestion.length === 4) break;
  }
  return fromQuestion.length >= 2 ? fromQuestion : [];
}


function renderAnswerUI(qz) {
  if (qz.quiz_type === "multiple_choice" || qz.quiz_type === "mcq") {
    const choices = getChoiceList(qz);
    if (choices.length < 2) {
      return `
        <div class="small">選択肢データが取得できないため、記述式で回答してください。</div>
        <input type="text" class="quiz-answer-text" data-answer-input="${qz.id}" placeholder="回答を入力" />
      `;
    }
    return `
      <div class="quiz-answer-inputs">
        ${choices.map((choice, idx) => `
          <label class="quiz-choice-option">
            <input type="radio" name="answer-${qz.id}" value="${esc(choice)}" ${idx === 0 ? "" : ""} />
            <span>${esc(choice)}</span>
          </label>
        `).join("")}
      </div>
    `;
  }

  if (qz.quiz_type === "written" || qz.quiz_type === "fill_blank") {
    return `<input type="text" class="quiz-answer-text" data-answer-input="${qz.id}" placeholder="${qz.quiz_type === "fill_blank" ? "空欄に入る語句を入力" : "回答を入力"}" />`;
  }

  if (qz.quiz_type === "true_false") {
    return `
      <div class="quiz-answer-inputs">
        <label class="quiz-choice-option"><input type="radio" name="answer-${qz.id}" value="○" /><span>○</span></label>
        <label class="quiz-choice-option"><input type="radio" name="answer-${qz.id}" value="×" /><span>×</span></label>
      </div>
    `;
  }

  return `<input type="text" class="quiz-answer-text" data-answer-input="${qz.id}" placeholder="回答を入力" />`;
}

function render(rows, options = {}) {
  const hasKeyword = Boolean(options.keyword);
  $("message").textContent = `${rows.length}件`;

  if (!rows.length) {
    $("quizList").innerHTML = hasKeyword
      ? "<div class='small'>該当するクイズが見つかりません</div>"
      : "<div class='small'>クイズはまだありません。</div>";
    return;
  }

  $("quizList").innerHTML = rows.map((qz, idx) => `
    <div class="card" data-quiz-card="${qz.id}">
      <div><strong>${esc(qz.title)}</strong> / ${esc(quizTypeLabel(qz.quiz_type))}</div>
      <div class="small">${esc(qz.question_text).slice(0, 120)}</div>
      <div class="small">作成日: ${esc(qz.created_at)}</div>
      <div class="row" style="margin-top:8px;">
        <button data-answer-toggle="${qz.id}">回答する</button>
        <button data-edit="${qz.id}">編集</button>
        <button data-delete="${qz.id}">削除</button>
      </div>
      <div class="quiz-answer-area" data-answer-area="${qz.id}" hidden>
        <div class="small" style="margin:10px 0 6px;">問題: ${esc(qz.question_text)}</div>
        ${renderAnswerUI(qz)}
        <div class="row" style="margin-top:10px;">
          <button data-answer-submit="${qz.id}">回答を送信</button>
          <button data-answer-close="${qz.id}">閉じる</button>
        </div>
        <div class="quiz-answer-result small" data-answer-result="${qz.id}"></div>
        <div class="row" style="margin-top:8px;">
          <button data-next-quiz="${idx}" hidden>次の問題へ</button>
        </div>
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

  document.querySelectorAll("button[data-answer-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.answerToggle;
      const area = document.querySelector(`[data-answer-area="${id}"]`);
      if (!area) return;
      const willOpen = area.hidden;
      document.querySelectorAll("[data-answer-area]").forEach((el) => { el.hidden = true; });
      area.hidden = !willOpen;
      btn.textContent = willOpen ? "回答中" : "回答する";
      if (willOpen) {
        const input = area.querySelector("input[type='text'], input[type='radio']");
        if (input) input.focus();
      }
      document.querySelectorAll("button[data-answer-toggle]").forEach((otherBtn) => {
        if (otherBtn !== btn) otherBtn.textContent = "回答する";
      });
    });
  });

  document.querySelectorAll("button[data-answer-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.answerClose;
      const area = document.querySelector(`[data-answer-area="${id}"]`);
      const toggleBtn = document.querySelector(`button[data-answer-toggle="${id}"]`);
      if (area) area.hidden = true;
      if (toggleBtn) toggleBtn.textContent = "回答する";
    });
  });

  document.querySelectorAll("button[data-answer-submit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.answerSubmit;
      const qz = rows.find((item) => String(item.id) === String(id));
      if (!qz) return;

      let userAnswer = "";
      if (qz.quiz_type === "multiple_choice" || qz.quiz_type === "mcq" || qz.quiz_type === "true_false") {
        const checked = document.querySelector(`input[name="answer-${id}"]:checked`);
        if (checked) {
          userAnswer = checked.value;
        } else {
          const input = document.querySelector(`[data-answer-input="${id}"]`);
          const fallbackInputValue = input ? input.value : "";
          if (!fallbackInputValue.trim()) {
            alert((qz.quiz_type === "multiple_choice" || qz.quiz_type === "mcq") ? "回答を選択または入力してください" : "回答を選択してください");
            return;
          }
          userAnswer = fallbackInputValue;
        }
      } else {
        const input = document.querySelector(`[data-answer-input="${id}"]`);
        userAnswer = input ? input.value : "";
        if (!userAnswer.trim()) {
          alert("回答を入力してください");
          return;
        }
      }

      const isCorrect = normalizeForAnswer(userAnswer) === normalizeForAnswer(qz.correct_answer);
      const resultEl = document.querySelector(`[data-answer-result="${id}"]`);
      const nextBtn = document.querySelector(`button[data-next-quiz][data-next-quiz="${rows.findIndex((item) => String(item.id) === String(id))}"]`);
      if (resultEl) {
        resultEl.classList.toggle("is-correct", isCorrect);
        resultEl.classList.toggle("is-wrong", !isCorrect);
        resultEl.innerHTML = `
          <div><strong>${isCorrect ? "✅ 正解" : "❌ 不正解"}</strong></div>
          <div>あなたの回答: ${esc(userAnswer)}</div>
          <div>正解: ${esc(qz.correct_answer)}</div>
          ${qz.explanation ? `<div>解説: ${esc(qz.explanation)}</div>` : ""}
        `;
      }

      if (nextBtn) {
        nextBtn.hidden = false;
        nextBtn.onclick = () => {
          const nextRow = rows[Number(nextBtn.dataset.nextQuiz) + 1];
          if (!nextRow) {
            nextBtn.textContent = "最後の問題です";
            nextBtn.disabled = true;
            return;
          }
          const targetBtn = document.querySelector(`button[data-answer-toggle="${nextRow.id}"]`);
          if (targetBtn) {
            targetBtn.click();
            targetBtn.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        };
      }
    });
  });
}

function applyFilters() {
  const keyword = normalizeForSearch($("keyword").value.trim());
  const filteredRows = keyword
    ? allRows.filter((qz) => buildSearchTarget(qz).includes(keyword))
    : allRows;
  const sortedRows = sortRows(filteredRows, currentSortOrder);

  updateSortUI();
  render(sortedRows, { keyword });
}

async function load() {
  const type = $("filterType").value;
  const q = type ? `?quiz_type=${encodeURIComponent(type)}` : "";
  const result = await api(`/api/quizzes/mine${q}`);
  allRows = result.data.quizzes || [];
  applyFilters();
}

(async () => {
  $("btnReload").addEventListener("click", load);
  $("filterType").addEventListener("change", load);
  $("sortOrder").addEventListener("change", () => {
    currentSortOrder = $("sortOrder").value || "newest";
    applyFilters();
  });
  $("btnReshuffle").addEventListener("click", () => {
    if (currentSortOrder !== "shuffle") return;
    applyFilters();
  });
  $("keyword").addEventListener("input", applyFilters);
  $("btnClearKeyword").addEventListener("click", () => {
    $("keyword").value = "";
    applyFilters();
    $("keyword").focus();
  });
  $("sortOrder").value = currentSortOrder;
  updateSortUI();
  await load();
})();
