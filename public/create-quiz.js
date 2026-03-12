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

function setMessage(msg, isError = false) {
  const el = $("message");
  el.textContent = msg;
  el.style.color = isError ? "#b91c1c" : "#334155";
}

function syncFormByType() {
  const type = $("quizType").value;
  const choicesWrap = $("choicesWrap");
  const correctWrap = $("correctAnswerWrap");

  choicesWrap.style.display = type === "multiple_choice" ? "block" : "none";
  correctWrap.style.display = "block";

  if (type === "true_false") {
    correctWrap.innerHTML = `<label>正解</label><select id="correctAnswer"><option value="○">○</option><option value="×">×</option></select>`;
  } else {
    correctWrap.innerHTML = `<label>正解</label><input id="correctAnswer" maxlength="200" />`;
  }
}

async function loadNotes() {
  const rows = await api("/api/my-notes");
  const select = $("noteId");
  for (const n of rows) {
    const op = document.createElement("option");
    op.value = n.id;
    op.textContent = `${n.title} (${n.lecture_date || "日付未設定"})`;
    select.appendChild(op);
  }
}

function collectPayload() {
  const type = $("quizType").value;
  const payload = {
    title: $("title").value,
    note_id: $("noteId").value || null,
    quiz_type: type,
    question_text: $("questionText").value,
    correct_answer: $("correctAnswer").value,
    explanation: $("explanation").value,
    visibility: $("visibility").value,
  };

  if (type === "multiple_choice") {
    payload.choice_1 = $("choice1").value;
    payload.choice_2 = $("choice2").value;
    payload.choice_3 = $("choice3").value;
    payload.choice_4 = $("choice4").value;
  }

  return payload;
}

async function saveQuiz() {
  const btn = $("btnSave");
  btn.disabled = true;
  try {
    const payload = collectPayload();
    if (!payload.note_id) {
      throw new Error("ノートを選択してください");
    }
    const editId = new URLSearchParams(location.search).get("edit_id");
    const result = await api(editId ? `/api/quizzes/${editId}` : "/api/quizzes", {
      method: editId ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    setMessage(editId ? `更新しました（ID: ${result.id || editId}）` : `保存しました（ID: ${result.id}）`);
  } catch (e) {
    console.error("saveQuiz failed", e);
    setMessage(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function loadEditQuiz(editId) {
  const result = await api(`/api/quizzes/${editId}`);
  const q = result.data;
  $("title").value = q.title || "";
  $("noteId").value = q.note_id || "";
  $("quizType").value = q.quiz_type;
  syncFormByType();
  $("questionText").value = q.question_text || "";
  $("correctAnswer").value = q.correct_answer || "";
  $("explanation").value = q.explanation || "";
  $("visibility").value = q.visibility || "private";
  if (q.quiz_type === "multiple_choice") {
    $("choice1").value = q.choice_1 || "";
    $("choice2").value = q.choice_2 || "";
    $("choice3").value = q.choice_3 || "";
    $("choice4").value = q.choice_4 || "";
  }
}

async function generateDistractors() {
  const type = $("quizType").value;
  if (type !== "multiple_choice") return;

  const questionText = $("questionText").value.trim();
  const correctAnswer = $("correctAnswer").value.trim();
  if (!questionText || !correctAnswer) {
    setMessage("問題文と正解を入力してからAI生成してください", true);
    return;
  }

  const btn = $("btnGenerateDistractors");
  btn.disabled = true;
  btn.textContent = "生成中…";
  try {
    const result = await api("/api/quizzes/generate-distractors", {
      method: "POST",
      body: JSON.stringify({ questionText, correctAnswer }),
    });
    const [d1, d2, d3] = result.data.distractors;
    $("choice1").value = $("choice1").value || correctAnswer;
    $("choice2").value = d1;
    $("choice3").value = d2;
    $("choice4").value = d3;
    setMessage("不正解の候補を入力しました。必要に応じて編集してください。");
  } catch (e) {
    setMessage(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "不正解の選択肢をAI生成";
  }
}

(async () => {
  try {
    const params = new URLSearchParams(location.search);
    const noteId = params.get("note_id");
    const editId = params.get("edit_id");

    await api("/api/me");
    await loadNotes();
    if (noteId) $("noteId").value = noteId;
    syncFormByType();
    if (editId) {
      await loadEditQuiz(editId);
      $("btnSave").textContent = "更新";
    }
    setMessage("入力して保存してください。");
  } catch (e) {
    setMessage(`初期化に失敗しました: ${e.message}`, true);
  }

  $("quizType").addEventListener("change", syncFormByType);
  $("btnSave").addEventListener("click", saveQuiz);
  $("btnGenerateDistractors").addEventListener("click", generateDistractors);
})();
