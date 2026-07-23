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
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function normalizeForAnswer(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .normalize("NFKC");
}

function getChoiceList(qz) {
  const direct = [qz.choice_1, qz.choice_2, qz.choice_3, qz.choice_4]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  return direct;
}

function renderAnswerUI(qz) {
  if (qz.quiz_type === "multiple_choice") {
    const choices = getChoiceList(qz);
    if (choices.length < 2) {
      return `<input type="text" class="quiz-answer-text" data-answer-input="1" placeholder="回答を入力" />`;
    }
    return `
      <div class="quiz-answer-inputs">
        ${choices.map((choice) => `
          <label class="quiz-choice-option">
            <input type="radio" name="review-answer" value="${esc(choice)}" />
            <span>${esc(choice)}</span>
          </label>
        `).join("")}
      </div>
    `;
  }
  if (qz.quiz_type === "true_false") {
    return `
      <div class="quiz-answer-inputs">
        <label class="quiz-choice-option"><input type="radio" name="review-answer" value="○" /><span>○</span></label>
        <label class="quiz-choice-option"><input type="radio" name="review-answer" value="×" /><span>×</span></label>
      </div>
    `;
  }
  return `<input type="text" class="quiz-answer-text" data-answer-input="1" placeholder="${qz.quiz_type === "fill_blank" ? "空欄に入る語句を入力" : "回答を入力"}" />`;
}

const session = {
  items: [],
  index: 0,
  quizzes: [],
  quizIndex: 0,
  note: null,
};

function renderDone() {
  $("reviewProgress").textContent = "";
  $("sessionArea").innerHTML = `
    <div class="card">
      <h2>お疲れさまでした！</h2>
      <div class="small">今回の復習はすべて完了しました。</div>
      <div class="row" style="margin-top:12px;">
        <a class="button-link" href="/mypage.html">マイページへ戻る</a>
      </div>
    </div>
  `;
}

function renderEmpty() {
  $("reviewProgress").textContent = "";
  $("sessionArea").innerHTML = `
    <div class="card">
      <div class="small">今のところ復習が必要なノートはありません。</div>
      <div class="row" style="margin-top:12px;">
        <a class="button-link" href="/mypage.html">マイページへ戻る</a>
      </div>
    </div>
  `;
}

async function markCurrentDoneAndAdvance() {
  const item = session.items[session.index];
  try {
    await api(`/api/reviews/${item.note_id}/done`, { method: "POST" });
  } catch (e) {
    alert("復習完了の記録に失敗しました: " + e.message);
    return;
  }
  session.index += 1;
  session.quizzes = [];
  session.quizIndex = 0;
  session.note = null;
  await renderCurrent();
}

function skipCurrent() {
  session.index += 1;
  session.quizzes = [];
  session.quizIndex = 0;
  session.note = null;
  renderCurrent();
}

function renderFinishNoteControls() {
  return `
    <div class="row" style="margin-top:14px;">
      <button id="btnFinishNote" type="button">この内容を復習完了 → 次へ</button>
      <button id="btnSkipNote" type="button">あとで復習する（スキップ）</button>
    </div>
  `;
}

function wireFinishNoteControls() {
  $("btnFinishNote")?.addEventListener("click", markCurrentDoneAndAdvance);
  $("btnSkipNote")?.addEventListener("click", skipCurrent);
}

function renderQuizStep() {
  const qz = session.quizzes[session.quizIndex];
  const area = $("quizArea");
  if (!area) return;

  if (!qz) {
    area.innerHTML = `<div class="small">この内容に紐づくクイズはありません。</div>${renderFinishNoteControls()}`;
    wireFinishNoteControls();
    return;
  }

  area.innerHTML = `
    <div class="quiz-answer-area">
      <div class="small" style="margin-bottom:6px;">問題 ${session.quizIndex + 1} / ${session.quizzes.length}（${esc(qz.type)}）</div>
      <div style="margin-bottom:10px;"><strong>${esc(qz.question)}</strong></div>
      <div id="quizAnswerInputs">${renderAnswerUI({ ...qz, quiz_type: qz.type })}</div>
      <div class="row" style="margin-top:10px;">
        <button id="btnSubmitAnswer" type="button">回答を送信</button>
      </div>
      <div class="quiz-answer-result small" id="quizResult"></div>
      <div class="row" id="quizNextRow" style="margin-top:10px;" hidden>
        <button id="btnNextQuiz" type="button">次の問題へ</button>
      </div>
    </div>
  `;

  $("btnSubmitAnswer").addEventListener("click", () => onSubmitQuizAnswer(qz));
}

async function onSubmitQuizAnswer(qz) {
  let userAnswer = "";
  if (qz.type === "multiple_choice" || qz.type === "true_false") {
    const checked = document.querySelector('input[name="review-answer"]:checked');
    if (!checked) {
      alert("回答を選択してください");
      return;
    }
    userAnswer = checked.value;
  } else {
    const input = document.querySelector('[data-answer-input="1"]');
    userAnswer = input ? input.value : "";
    if (!userAnswer.trim()) {
      alert("回答を入力してください");
      return;
    }
  }

  const resultEl = $("quizResult");
  const submitBtn = $("btnSubmitAnswer");
  const nextRow = $("quizNextRow");

  if (qz.type === "written") {
    submitBtn.disabled = true;
    resultEl.classList.remove("is-correct", "is-wrong");
    resultEl.innerHTML = "<div>AIが採点中です…</div>";
    try {
      const result = await api(`/api/quizzes/${qz.id}/grade`, {
        method: "POST",
        body: JSON.stringify({ answer: userAnswer }),
      });
      resultEl.classList.toggle("is-correct", result.correct);
      resultEl.classList.toggle("is-wrong", !result.correct);
      resultEl.innerHTML = `
        <div><strong>${result.correct ? "✅ 正解（AI判定）" : "❌ 不正解（AI判定）"}</strong></div>
        <div>模範解答: ${esc(result.correctAnswer)}</div>
        ${result.feedback ? `<div>AIの講評: ${esc(result.feedback)}</div>` : ""}
      `;
    } catch (e) {
      const isCorrect = normalizeForAnswer(userAnswer) === normalizeForAnswer(qz.answer);
      resultEl.classList.toggle("is-correct", isCorrect);
      resultEl.classList.toggle("is-wrong", !isCorrect);
      resultEl.innerHTML = `
        <div class="small">AI採点に失敗したため簡易判定を表示します（${esc(e.message)}）</div>
        <div><strong>${isCorrect ? "✅ 正解" : "❌ 不正解"}</strong></div>
        <div>正解: ${esc(qz.answer)}</div>
      `;
    }
    submitBtn.disabled = true;
  } else {
    const isCorrect = normalizeForAnswer(userAnswer) === normalizeForAnswer(qz.answer);
    resultEl.classList.toggle("is-correct", isCorrect);
    resultEl.classList.toggle("is-wrong", !isCorrect);
    resultEl.innerHTML = `
      <div><strong>${isCorrect ? "✅ 正解" : "❌ 不正解"}</strong></div>
      <div>正解: ${esc(qz.answer)}</div>
    `;
    submitBtn.disabled = true;
  }

  nextRow.hidden = false;
  $("btnNextQuiz").onclick = () => {
    session.quizIndex += 1;
    if (session.quizIndex >= session.quizzes.length) {
      $("quizArea").innerHTML = renderFinishNoteControls();
      wireFinishNoteControls();
    } else {
      renderQuizStep();
    }
  };
}

function toggleBody() {
  $("noteBody").classList.toggle("is-hidden");
  const btn = $("btnToggleBody");
  btn.textContent = $("noteBody").classList.contains("is-hidden") ? "本文を表示" : "本文を隠す";
}

async function renderCurrent() {
  if (session.index >= session.items.length) {
    renderDone();
    return;
  }

  $("reviewProgress").textContent = `${session.index + 1} / ${session.items.length} 件目`;
  const item = session.items[session.index];

  $("sessionArea").innerHTML = `<div class="small">読み込み中…</div>`;

  try {
    const [note, quizzes] = await Promise.all([
      api(`/api/notes/${item.note_id}`),
      api(`/api/notes/${item.note_id}/quizzes`),
    ]);
    session.note = note;
    session.quizzes = quizzes || [];
    session.quizIndex = 0;

    const html = marked.parse(note.body_md || "");
    const safe = DOMPurify.sanitize(html);

    $("sessionArea").innerHTML = `
      <div class="card">
        <h2>${esc(note.title || "(無題)")}</h2>
        <div class="small">${esc(note.course_name || "")} ${esc(note.lecture_no || "")} ${esc(note.lecture_date || "")}</div>
        <div class="row" style="margin-top:10px;">
          <button id="btnToggleBody" type="button">本文を表示</button>
        </div>
        <div id="noteBody" class="md is-hidden" style="margin-top:10px;">${safe}</div>
      </div>
      <div class="card">
        <h2>思い出しクイズ</h2>
        <div id="quizArea"></div>
      </div>
    `;
    $("btnToggleBody").addEventListener("click", toggleBody);
    renderQuizStep();
  } catch (e) {
    $("sessionArea").innerHTML = `<div class="card">読み込みに失敗しました: ${esc(e.message)}</div>`;
  }
}

async function init() {
  const me = await api("/api/me");
  if (!me.loggedIn) {
    location.href = "/login.html";
    return;
  }

  const data = await api("/api/reviews/due");
  session.items = data.items || [];
  session.index = 0;

  if (!session.items.length) {
    renderEmpty();
    return;
  }
  await renderCurrent();
}

init();
