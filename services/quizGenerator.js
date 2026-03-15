const { cleanNoteText } = require("../utils/cleanNoteText");
const { buildExtractPointsPrompt, buildQuizPrompt } = require("./quizPromptBuilder");
const { parseAndValidateQuizResponse, filterLowQualityQuizzes } = require("./quizValidator");

const DEFAULT_MODEL = process.env.OPENAI_QUIZ_MODEL || "gpt-4.1-mini";
const SUPPORTED_QUIZ_TYPES = ["multiple_choice", "written", "true_false", "fill_blank"];

function shuffleInPlace(items, random = Math.random) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function buildBalancedAnswerIndices(count, random = Math.random) {
  const indices = [];
  for (let i = 0; i < count; i++) {
    indices.push(i % 4);
  }
  return shuffleInPlace(indices, random);
}

function alignQuizAnswerIndex(quiz, targetAnswerIndex, random = Math.random) {
  const correctChoice = quiz.choices[quiz.answerIndex];
  const wrongChoices = quiz.choices.filter((_, index) => index !== quiz.answerIndex);
  shuffleInPlace(wrongChoices, random);

  const alignedChoices = new Array(4);
  alignedChoices[targetAnswerIndex] = correctChoice;

  let wrongPtr = 0;
  for (let i = 0; i < alignedChoices.length; i++) {
    if (i === targetAnswerIndex) continue;
    alignedChoices[i] = wrongChoices[wrongPtr++];
  }

  return {
    ...quiz,
    choices: alignedChoices,
    answerIndex: targetAnswerIndex,
  };
}

function rebalanceQuizAnswerPositions(quizzes, random = Math.random) {
  const targetIndices = buildBalancedAnswerIndices(quizzes.length, random);
  return quizzes.map((quiz, index) => alignQuizAnswerIndex(quiz, targetIndices[index], random));
}

function summarizeAnswerPositionDistribution(quizzes) {
  const counts = [0, 0, 0, 0];
  for (const quiz of quizzes) {
    if (Number.isInteger(quiz.answerIndex) && quiz.answerIndex >= 0 && quiz.answerIndex < 4) {
      counts[quiz.answerIndex] += 1;
    }
  }
  return {
    "1": counts[0],
    "2": counts[1],
    "3": counts[2],
    "4": counts[3],
  };
}

function formatMultipleChoiceQuizForStorage(quiz) {
  return {
    type: "multiple_choice",
    question: String(quiz.question || "").trim(),
    answer: String(quiz.choices[quiz.answerIndex] || "").trim(),
    source_line: null,
    choice_1: String(quiz.choices[0] || "").trim() || null,
    choice_2: String(quiz.choices[1] || "").trim() || null,
    choice_3: String(quiz.choices[2] || "").trim() || null,
    choice_4: String(quiz.choices[3] || "").trim() || null,
  };
}

function extractJsonBlock(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text || "").match(/\{[\s\S]*\}/);
    if (!m) throw new Error("AIの返答がJSONとして解析できませんでした");
    return JSON.parse(m[0]);
  }
}

function normalizeGeneratedQuiz(raw, quizType) {
  const question = String(raw?.question || "").trim().slice(0, 500);
  const answer = String(raw?.answer || "").trim().slice(0, 200);
  const explanation = raw?.explanation == null ? null : String(raw.explanation).trim().slice(0, 1000);
  if (!question || !answer) return null;

  if (quizType === "multiple_choice") {
    const choices = [raw?.choice_1, raw?.choice_2, raw?.choice_3, raw?.choice_4]
      .map((v) => String(v || "").trim())
      .filter(Boolean)
      .slice(0, 4);
    if (choices.length !== 4) return null;
    if (!choices.includes(answer)) return null;
    if (new Set(choices).size !== 4) return null;

    return {
      type: quizType,
      question,
      answer,
      explanation,
      source_line: null,
      choice_1: choices[0],
      choice_2: choices[1],
      choice_3: choices[2],
      choice_4: choices[3],
    };
  }

  if (quizType === "true_false" && !["○", "×"].includes(answer)) {
    return null;
  }

  if (quizType === "fill_blank") {
    const hasBlankMarker = /_{3,}/.test(question) || /（[　\s]+）/.test(question) || /\([　\s]+\)/.test(question);
    if (!hasBlankMarker) return null;
  }

  return {
    type: quizType,
    question,
    answer,
    explanation,
    source_line: null,
    choice_1: null,
    choice_2: null,
    choice_3: null,
    choice_4: null,
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

  const selectedQuizzes = accepted.slice(0, targetCount);
  const balancedQuizzes = rebalanceQuizAnswerPositions(selectedQuizzes);
  logger.info("quiz_pipeline:answer_position_distribution", {
    count: balancedQuizzes.length,
    distribution: summarizeAnswerPositionDistribution(balancedQuizzes),
  });

  return balancedQuizzes.map(formatMultipleChoiceQuizForStorage);
}

async function generateTypedQuizzes({ openai, note, quizType, targetCount = 10 }) {
  if (!SUPPORTED_QUIZ_TYPES.includes(quizType)) {
    throw new Error(`unsupported quiz type: ${quizType}`);
  }

  if (quizType === "multiple_choice") {
    return generateQuizzesWithQualityPipeline({ openai, note, targetCount, logger: console });
  }

  const rawText = String(note?.body_raw || "");
  const { cleanedText } = cleanNoteText(rawText);
  const typeInstructionMap = {
    written: "一問一答（記述）形式で作成してください。解答は簡潔な語句・文にしてください。",
    true_false: "○×問題を作成してください。answer は必ず '○' または '×' にしてください。",
    fill_blank: "穴埋め問題を作成してください。question には必ず（　　　）または ___ の空欄を含めてください。",
  };

  const prompt = [
    "以下の講義ノートに基づき、指定形式のクイズをJSONで作成してください。",
    "- 推測を避け、本文の事実に基づくこと",
    "- 各問題は重複しないこと",
    "- 出力はJSONのみ",
    `- 問題数: ${targetCount}`,
    `- 形式: ${quizType}`,
    `- 追加要件: ${typeInstructionMap[quizType] || ""}`,
    "",
    "出力形式:",
    '{"quizzes":[{"question":"...","answer":"...","explanation":"..."}]}',
    "",
    "講義ノート本文:",
    cleanedText,
  ].join("\n");

  const resp = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "あなたは講義ノートの復習問題作成者です。JSONのみ返答してください。" },
      { role: "user", content: prompt },
    ],
  });

  const text = resp.choices?.[0]?.message?.content || "{}";
  const parsed = extractJsonBlock(text);
  const quizzes = Array.isArray(parsed?.quizzes) ? parsed.quizzes : [];

  return quizzes
    .map((q) => normalizeGeneratedQuiz(q, quizType))
    .filter(Boolean)
    .slice(0, targetCount);
}

module.exports = {
  generateQuizzesWithQualityPipeline,
  generateTypedQuizzes,
  SUPPORTED_QUIZ_TYPES,
  buildBalancedAnswerIndices,
  rebalanceQuizAnswerPositions,
  summarizeAnswerPositionDistribution,
};
