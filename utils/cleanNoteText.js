const MAX_CHARS = 12000;
const NOISE_PATTERNS = [
  /^保存しました!?$/,
  /^読み込み中\.{0,3}$/,
  /^クイズを生成(しました|しています)\.{0,3}$/,
  /^公開(ノート)?$/,
  /^非公開$/,
  /^更新$/,
  /^削除$/,
  /^戻る$/,
];

function cleanNoteText(noteText) {
  const raw = String(noteText || "");

  const noHtml = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  const lines = noHtml
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !NOISE_PATTERNS.some((p) => p.test(line)));

  const compact = [];
  for (const line of lines) {
    const isHeading = /^#{1,6}\s+/.test(line);
    const isBullet = /^(?:[-*・]|\d+\.)\s+/.test(line);
    if (isHeading || isBullet) {
      compact.push(line);
      continue;
    }
    compact.push(line.replace(/\s*([。！？])\s*/g, "$1 "));
  }

  const joined = compact.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  if (joined.length <= MAX_CHARS) {
    return { cleanedText: joined, wasTruncated: false };
  }

  // 単純切り捨てではなく、段落単位で収める
  const paragraphs = joined.split(/\n{2,}/);
  let total = 0;
  const picked = [];
  for (const p of paragraphs) {
    if (total + p.length > MAX_CHARS) break;
    picked.push(p);
    total += p.length + 2;
  }

  return {
    cleanedText: picked.join("\n\n").trim(),
    wasTruncated: true,
  };
}

module.exports = {
  cleanNoteText,
  MAX_CHARS,
};
