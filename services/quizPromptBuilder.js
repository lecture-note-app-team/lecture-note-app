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

function buildQuizPrompt({ cleanedText, points, count, difficulty = "normal", existingTopics = [] }) {
  return [
    "講義ノートから4択クイズを作成してください。JSONのみを返答してください。",
    "制約:",
    "- 本文に書かれた内容のみ使用。推測・補完・外部知識は禁止。",
    "- 問題文は単独で意味が通る自然な日本語にする。",
    "- 正答は必ず1つ。",
    "- 誤答はもっともらしいが本文と照合すると誤りと分かる内容にする。",
    "- 同一論点の重複を避ける。",
    `- 難易度: ${difficulty}`,
    existingTopics.length ? `- 次の論点は再出題禁止: ${existingTopics.join(" / ")}` : "",
    "",
    "出力JSON形式:",
    '{"quizzes":[{"topic":"...","question":"...","choices":["...","...","...","..."],"answerIndex":0,"reason":"本文根拠","sourceQuote":"本文引用"}]}',
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
