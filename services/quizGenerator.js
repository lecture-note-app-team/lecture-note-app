const { cleanNoteText } = require("../utils/cleanNoteText");
const { buildExtractPointsPrompt, buildQuizPrompt } = require("./quizPromptBuilder");
const { parseAndValidateQuizResponse, filterLowQualityQuizzes } = require("./quizValidator");

const DEFAULT_MODEL = process.env.OPENAI_QUIZ_MODEL || "gpt-4.1-mini";

function formatQuizForStorage(quiz) {
  const choicesText = quiz.choices.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return {
    type: "mcq",
    question: `${quiz.question}\n${choicesText}`,
    answer: quiz.choices[quiz.answerIndex],
    source_line: null,
  };
}

async function extractQuizPoints(openai, cleanedText) {
  const prompt = buildExtractPointsPrompt({ cleanedText });
  const resp = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "あなたは講義ノート分析者です。JSONのみ返答してください。" },
      { role: "user", content: `${prompt}\n\n出力形式: {"points":[{"topic":"","fact":"","kind":"definition|causal|comparison|procedure|enumeration|entity","source_quote":""}]}` },
    ],
  });

  const text = resp.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(text);
  const points = Array.isArray(parsed.points) ? parsed.points : [];
  return points
    .map((p) => ({
      topic: String(p.topic || "").trim(),
      fact: String(p.fact || "").trim(),
      kind: String(p.kind || "").trim(),
      source_quote: String(p.source_quote || "").trim(),
    }))
    .filter((p) => p.topic && p.fact && p.source_quote)
    .slice(0, 18);
}

async function generateQuizBatch(openai, params) {
  const prompt = buildQuizPrompt(params);
  const resp = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "あなたは講義ノートの復習問題作成者です。JSONのみ返答。" },
      { role: "user", content: prompt },
    ],
  });

  const text = resp.choices?.[0]?.message?.content || "{}";
  return parseAndValidateQuizResponse(text);
}

async function regenerateMissingQuizzesIfNeeded(openai, params) {
  const { targetCount, cleanedText } = params;
  let accepted = [];
  let allReasons = [];
  let excluded = [];

  for (let attempt = 0; attempt < 3 && accepted.length < targetCount; attempt++) {
    const batch = await generateQuizBatch(openai, {
      ...params,
      count: targetCount - accepted.length,
      existingTopics: excluded,
    });

    const { accepted: revalidated, reasons } = filterLowQualityQuizzes(accepted.concat(batch), cleanedText);
    accepted = revalidated;
    allReasons = allReasons.concat(reasons);
    excluded = accepted.map((q) => q.topic).filter(Boolean);
  }

  return { accepted, reasons: allReasons };
}

async function generateQuizzesWithQualityPipeline({ openai, note, targetCount = 10, logger = console }) {
  const rawText = String(note?.body_raw || "");
  const { cleanedText, wasTruncated } = cleanNoteText(rawText);

  logger.info("quiz_pipeline:start", {
    noteId: note?.id,
    rawLength: rawText.length,
    cleanedLength: cleanedText.length,
    wasTruncated,
    targetCount,
  });

  const points = await extractQuizPoints(openai, cleanedText);
  logger.info("quiz_pipeline:points", { count: points.length });

  const { accepted, reasons } = await regenerateMissingQuizzesIfNeeded(openai, {
    cleanedText,
    points,
    difficulty: "normal",
    targetCount,
  });
  logger.info("quiz_pipeline:generated", { count: accepted.length + reasons.length });
  logger.info("quiz_pipeline:validated", {
    passed: accepted.length,
    dropped: reasons.length,
    dropReasons: reasons,
  });

  if (accepted.length < Math.max(3, Math.floor(targetCount * 0.5))) {
    const err = new Error("クイズ品質が基準を満たしませんでした。時間をおいて再試行してください。");
    err.details = { accepted: accepted.length, rejected: reasons.length };
    throw err;
  }

  return accepted.slice(0, targetCount).map(formatQuizForStorage);
}

module.exports = {
  generateQuizzesWithQualityPipeline,
};
