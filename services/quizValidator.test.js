const assert = require("assert");
const { parseAndValidateQuizResponse, filterLowQualityQuizzes } = require("./quizValidator");

const noteText = "日本の首都は東京である。地球は丸い天体である。オームの法則は電圧と電流と抵抗の関係を示す。";

(function testNonMultipleChoiceDoesNotRequireAnswerIndex() {
  const raw = JSON.stringify({
    quizzes: [
      {
        topic: "首都",
        quiz_type: "written",
        question: "日本の首都はどこですか？",
        correct_answer: "東京",
        sourceQuote: "日本の首都は東京である",
      },
      {
        topic: "形",
        quiz_type: "true_false",
        question: "地球は丸い。この記述は正しいか、○か×で答えよ。",
        correct_answer: "○",
        sourceQuote: "地球は丸い天体である",
        answerIndex: 9,
      },
      {
        topic: "法則",
        quiz_type: "fill_blank",
        question: "オームの法則は電圧と（　　　）と抵抗の関係を示す。",
        correct_answer: "電流",
        sourceQuote: "オームの法則は電圧と電流と抵抗の関係を示す",
        answerIndex: -1,
      },
    ],
  });

  const parsed = parseAndValidateQuizResponse(raw);
  const result = filterLowQualityQuizzes(parsed, noteText);

  assert.strictEqual(result.accepted.length, 3);
  assert.strictEqual(result.reasons.length, 0);
})();

(function testMultipleChoiceValidatesAnswerIndexWhenProvided() {
  const raw = JSON.stringify({
    quizzes: [
      {
        topic: "首都",
        quiz_type: "multiple_choice",
        question: "日本の首都はどれですか。",
        correct_answer: "東京",
        choice_1: "大阪",
        choice_2: "名古屋",
        choice_3: "東京",
        choice_4: "福岡",
        sourceQuote: "日本の首都は東京である",
        answerIndex: 1,
      },
    ],
  });

  const parsed = parseAndValidateQuizResponse(raw);
  const result = filterLowQualityQuizzes(parsed, noteText);

  assert.strictEqual(result.accepted.length, 0);
  assert.strictEqual(result.reasons[0].reason, "answer_index_mismatch");
})();

console.log("quizValidator tests passed");
