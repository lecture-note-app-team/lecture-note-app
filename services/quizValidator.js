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
    question: String(q.question || "").trim(),
    choices: Array.isArray(q.choices) ? q.choices.map((c) => String(c || "").trim()) : [],
    answerIndex: Number(q.answerIndex),
    reason: String(q.reason || "").trim(),
    sourceQuote: String(q.sourceQuote || "").trim(),
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
    if (q.choices.length !== 4 || q.choices.some((c) => !c)) {
      reasons.push({ question: q.question, reason: "invalid_choices" });
      continue;
    }
    if (!Number.isInteger(q.answerIndex) || q.answerIndex < 0 || q.answerIndex > 3) {
      reasons.push({ question: q.question, reason: "invalid_answer_index" });
      continue;
    }

    const normalizedChoices = q.choices.map(normalizeText);
    if (new Set(normalizedChoices).size !== 4) {
      reasons.push({ question: q.question, reason: "duplicate_choices" });
      continue;
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
