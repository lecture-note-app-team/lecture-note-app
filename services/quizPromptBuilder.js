function buildExtractPointsPrompt({ cleanedText, maxPoints = 18 }) {
  return [
    "次の講義ノートから、復習問題にすべき要点だけを抽出してください。",
    "必ず本文に明記されている内容のみを使い、推測・一般知識で補完しないこと。",
    "JSONのみで返し、各pointにsource_quote（本文からの短い引用）を必ず含めること。",
    `最大${maxPoints}件。優先順: 定義 / 因果 / 比較 / 手順 / 列挙 / 重要固有名詞。`,
    "",
    "【本文】",
    cleanedText,
  ].join("\n");
}

function resolveQuizTypeGuide(requestedQuizType) {
  const normalized = String(requestedQuizType || "auto");
  if (normalized === "multiple_choice") {
    return "選択形式: multiple_choice（4択）のみで作成すること。";
  }
  if (normalized === "written") {
    return "選択形式: written（一問一答）のみで作成すること。";
  }
  if (normalized === "true_false") {
    return "選択形式: true_false（○×）のみで作成すること。";
  }
  if (normalized === "fill_blank") {
    return "選択形式: fill_blank（穴埋め）のみで作成すること。";
  }
  return "選択形式: auto（おまかせ）。各問題ごとに multiple_choice / written / true_false / fill_blank の最適な1形式を選ぶこと。";
}

function buildQuizPrompt({ cleanedText, points, count, difficulty = "normal", existingTopics = [], requestedQuizType = "auto" }) {
  const typeGuide = resolveQuizTypeGuide(requestedQuizType);
  return [
    "講義ノートから復習クイズを作成してください。JSONのみを返答してください。",
    "制約:",
    "- 本文に書かれた内容のみ使用。推測・補完・外部知識は禁止。",
    "- 問題文は単独で意味が通る自然な日本語にする。",
    "- 正答は必ず1つ。",
    "- 問題ごとに quiz_type を必ず指定する。",
    typeGuide,
    "- multiple_choice のときは選択肢を4件必ず入れ、correct_answer は4択のうち1つと一致させる。",
    "- true_false のとき correct_answer は必ず「○」か「×」。",
    "- written のときは簡潔な一問一答にする。",
    "- fill_blank のとき question には空欄（___ または （　　　））を含める。",
    "- 同一論点の重複を避ける。",
    `- 難易度: ${difficulty}`,
    existingTopics.length ? `- 次の論点は再出題禁止: ${existingTopics.join(" / ")}` : "",
    "",
    "出力JSON形式:",
    '{"quizzes":[{"topic":"...","quiz_type":"multiple_choice|written|true_false|fill_blank","question":"...","correct_answer":"...","choice_1":"...","choice_2":"...","choice_3":"...","choice_4":"...","reason":"本文根拠","sourceQuote":"本文引用"}]}',
    `件数: ${count}`,
    "",
    "【要点候補】",
    JSON.stringify(points || [], null, 2),
    "",
    "【本文】",
    cleanedText,
  ].filter(Boolean).join("\n");
}

module.exports = {
  buildExtractPointsPrompt,
  buildQuizPrompt,
};
