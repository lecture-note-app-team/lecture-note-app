const { cleanNoteText } = require("../utils/cleanNoteText");
const { buildExtractPointsPrompt, buildQuizPrompt } = require("./quizPromptBuilder");
const { parseAndValidateQuizResponse, filterLowQualityQuizzes } = require("./quizValidator");

const DEFAULT_MODEL = process.env.OPENAI_QUIZ_MODEL || "gpt-4.1-mini";

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
  const choices = [quiz.choice_1, quiz.choice_2, quiz.choice_3, quiz.choice_4];
  const answerIndex = choices.findIndex((choice) => choice === quiz.correct_answer);
  if (answerIndex < 0) return quiz;

  const correctChoice = choices[answerIndex];
  const wrongChoices = choices.filter((_, index) => index !== answerIndex);
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
    choice_1: alignedChoices[0],
    choice_2: alignedChoices[1],
    choice_3: alignedChoices[2],
    choice_4: alignedChoices[3],
    correct_answer: alignedChoices[targetAnswerIndex],
  };
}

function rebalanceQuizAnswerPositions(quizzes, random = Math.random) {
  const targetIndices = buildBalancedAnswerIndices(quizzes.length, random);
  return quizzes.map((quiz, index) => alignQuizAnswerIndex(quiz, targetIndices[index], random));
}

function summarizeAnswerPositionDistribution(quizzes) {
  const counts = [0, 0, 0, 0];
  for (const quiz of quizzes) {
    const choices = [quiz.choice_1, quiz.choice_2, quiz.choice_3, quiz.choice_4];
    const answerIndex = choices.findIndex((choice) => choice === quiz.correct_answer);
    if (answerIndex >= 0 && answerIndex < 4) {
      counts[answerIndex] += 1;
    }
  }
  return {
    "1": counts[0],
    "2": counts[1],
    "3": counts[2],
    "4": counts[3],
  };
}

function formatQuizForStorage(quiz) {
  return {
    type: quiz.quiz_type,
    question: quiz.question,
    answer: quiz.correct_answer,
    choice_1: quiz.choice_1 || null,
    choice_2: quiz.choice_2 || null,
    choice_3: quiz.choice_3 || null,
    choice_4: quiz.choice_4 || null,
    source_line: quiz.sourceQuote || null,
  };
}

// 本文の分量に応じて、抽出する要点の上限を決める（1回の生成で本文全体を網羅するため）
// 短いノートではこれまで通り最低10問、長いノートではその分だけ増やす（上限30問）。
const MIN_POINTS = 10;
const MAX_POINTS = 30;
const CHARS_PER_POINT = 200;

function computeMaxPoints(cleanedText) {
  const estimated = Math.ceil(String(cleanedText || "").length / CHARS_PER_POINT);
  return Math.max(MIN_POINTS, Math.min(MAX_POINTS, estimated));
}

async function extractQuizPoints(openai, cleanedText, maxPoints = MIN_POINTS) {
  const prompt = buildExtractPointsPrompt({ cleanedText, maxPoints });
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
    .slice(0, maxPoints);
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

// 1回のAI呼び出しで要求する問題数の上限（品質・JSON出力の安定性のため分割する）
const BATCH_SIZE = 12;

async function regenerateMissingQuizzesIfNeeded(openai, params) {
  const { targetCount, cleanedText } = params;
  let accepted = [];
  let allReasons = [];
  let excluded = [];

  // targetCountが多いほど分割回数が増えるため、必要な分だけ試行回数を確保する
  // （品質フィルタで弾かれた分の埋め合わせも見込んで+2）
  const maxAttempts = Math.min(8, Math.ceil(targetCount / BATCH_SIZE) + 2);

  for (let attempt = 0; attempt < maxAttempts && accepted.length < targetCount; attempt++) {
    const batch = await generateQuizBatch(openai, {
      ...params,
      count: Math.min(BATCH_SIZE, targetCount - accepted.length),
      existingTopics: excluded,
    });

    const { accepted: revalidated, reasons } = filterLowQualityQuizzes(accepted.concat(batch), cleanedText);
    accepted = revalidated;
    allReasons = allReasons.concat(reasons);
    excluded = accepted.map((q) => q.topic).filter(Boolean);
  }

  return { accepted, reasons: allReasons };
}

async function generateQuizzesWithQualityPipeline({ openai, note, targetCount = null, logger = console }) {
  const rawText = String(note?.body_raw || "");
  const { cleanedText, wasTruncated } = cleanNoteText(rawText);
  const maxPoints = computeMaxPoints(cleanedText);

  logger.info("quiz_pipeline:start", {
    noteId: note?.id,
    rawLength: rawText.length,
    cleanedLength: cleanedText.length,
    wasTruncated,
    targetCount,
    maxPoints,
  });

  const points = await extractQuizPoints(openai, cleanedText, maxPoints);
  logger.info("quiz_pipeline:points", { count: points.length });

  // targetCount未指定時は、抽出できた要点の数に合わせて自動決定する
  // （＝本文の内容量に応じて1回の生成で網羅できる問題数を作る）
  if (!targetCount) {
    targetCount = Math.max(points.length, 3);
  }

  const { accepted, reasons } = await regenerateMissingQuizzesIfNeeded(openai, {
    cleanedText,
    points,
    difficulty: "normal",
    targetCount,
    requestedQuizType: note?.requested_quiz_type || "auto",
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
  const mcqQuizzes = selectedQuizzes.filter((quiz) => quiz.quiz_type === "multiple_choice");
  const balancedMcqQuizzes = rebalanceQuizAnswerPositions(mcqQuizzes);
  let mcqIndex = 0;
  const balancedQuizzes = selectedQuizzes.map((quiz) => {
    if (quiz.quiz_type !== "multiple_choice") return quiz;
    const replaced = balancedMcqQuizzes[mcqIndex];
    mcqIndex += 1;
    return replaced || quiz;
  });
  logger.info("quiz_pipeline:answer_position_distribution", {
    count: mcqQuizzes.length,
    distribution: summarizeAnswerPositionDistribution(balancedMcqQuizzes),
  });

  return balancedQuizzes.map(formatQuizForStorage);
}

module.exports = {
  generateQuizzesWithQualityPipeline,
  buildBalancedAnswerIndices,
  rebalanceQuizAnswerPositions,
  summarizeAnswerPositionDistribution,
};
