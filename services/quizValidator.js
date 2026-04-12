function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[「」『』（）()【】\[\]・,，.。:：;；!?！？]/g, "");
}

function parseJSONSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const m = String(raw || "").match(/\{[\s\S]*\}/);
    if (!m) throw new Error("AI応答をJSONとして解釈できませんでした");
    return JSON.parse(m[0]);
  }
}

function parseAndValidateQuizResponse(raw) {
  const parsed = parseJSONSafe(raw);
  const quizzes = Array.isArray(parsed?.quizzes) ? parsed.quizzes : [];
  return quizzes.map((q) => ({
    topic: String(q.topic || "").trim(),
    quiz_type: String(q.quiz_type || q.type || "").trim(),
    question: String(q.question || "").trim(),
    correct_answer: String(q.correct_answer || q.answer || "").trim(),
    choice_1: String(q.choice_1 || "").trim(),
    choice_2: String(q.choice_2 || "").trim(),
    choice_3: String(q.choice_3 || "").trim(),
    choice_4: String(q.choice_4 || "").trim(),
    reason: String(q.reason || "").trim(),
    sourceQuote: String(q.sourceQuote || "").trim(),
    answerIndex: q.answerIndex == null && q.answer_index == null
      ? null
      : Number(q.answerIndex ?? q.answer_index),
  }));
}

function filterLowQualityQuizzes(quizzes, noteText) {
  const reasons = [];
  const accepted = [];
  const seen = new Set();
  const noteNormalized = normalizeText(noteText);

  for (const q of quizzes) {
    const qKey = normalizeText(q.question);
    if (!q.question || q.question.length < 12) {
      reasons.push({ question: q.question, reason: "question_too_short" });
      continue;
    }

    if (!["multiple_choice", "written", "true_false", "fill_blank"].includes(q.quiz_type)) {
      reasons.push({ question: q.question, reason: "invalid_quiz_type" });
      continue;
    }

    if (!q.correct_answer) {
      reasons.push({ question: q.question, reason: "missing_correct_answer" });
      continue;
    }

    if (q.quiz_type === "multiple_choice") {
      const choices = [q.choice_1, q.choice_2, q.choice_3, q.choice_4].map((c) => String(c || "").trim());
      if (choices.some((c) => !c)) {
        reasons.push({ question: q.question, reason: "invalid_choices" });
        continue;
      }
      if (new Set(choices.map(normalizeText)).size !== 4) {
        reasons.push({ question: q.question, reason: "duplicate_choices" });
        continue;
      }
      if (!choices.includes(q.correct_answer)) {
        reasons.push({ question: q.question, reason: "correct_not_in_choices" });
        continue;
      }

      if (q.answerIndex != null) {
        if (!Number.isInteger(q.answerIndex) || q.answerIndex < 0 || q.answerIndex > 3) {
          reasons.push({ question: q.question, reason: "invalid_answer_index" });
          continue;
        }
        if (choices[q.answerIndex] !== q.correct_answer) {
          reasons.push({ question: q.question, reason: "answer_index_mismatch" });
          continue;
        }
      }
    }

    if (q.quiz_type === "true_false" && !["○", "×"].includes(q.correct_answer)) {
      reasons.push({ question: q.question, reason: "invalid_true_false_answer" });
      continue;
    }

    if (q.quiz_type === "fill_blank") {
      const hasBlankMarker =
        /_{3,}/.test(q.question) ||
        /（[　\s]+）/.test(q.question) ||
        /\([　\s]+\)/.test(q.question);
      if (!hasBlankMarker) {
        reasons.push({ question: q.question, reason: "fill_blank_without_blank_marker" });
        continue;
      }
    }

    if (seen.has(qKey)) {
      reasons.push({ question: q.question, reason: "duplicate_question" });
      continue;
    }

    const sourceNorm = normalizeText(q.sourceQuote);
    if (sourceNorm.length < 6 || !noteNormalized.includes(sourceNorm)) {
      reasons.push({ question: q.question, reason: "weak_source_grounding" });
      continue;
    }

    if (/[�]/.test(q.question) || /(?:ですです|ますます|。。)/.test(q.question)) {
      reasons.push({ question: q.question, reason: "unnatural_japanese" });
      continue;
    }

    seen.add(qKey);
    accepted.push(q);
  }

  return { accepted, reasons };
}

module.exports = {
  parseAndValidateQuizResponse,
  filterLowQualityQuizzes,
};
