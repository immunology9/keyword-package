const { stringify } = require('csv-stringify/sync');

// ──────────────────────────────────────────
// 컬럼명 정규화 맵
// ──────────────────────────────────────────
const COLUMN_MAP = {
  '순위': 'rank',
  '키워드': 'keyword',
  '대표 카테고리': 'category',
  '키워드 분류': 'keywordType',
  '검색수': 'searchTotal',
  'PC 검색수': 'searchPC',
  '모바일 검색수': 'searchMobile',
  '상품수': 'productCount',
  '경쟁강도': 'competition',
  'PC 광고단가': 'adBidPC',
  '모바일 광고단가': 'adBidMobile',
  'PC 광고클릭률': 'adCTRPC',
  '모바일 광고클릭률': 'adCTRMobile',
  '평균 광고클릭수': 'adClickAvg',
  '광고 클릭 경쟁률': 'adClickCompetition',
  '클릭대비 광고비': 'adCostPerClick',
};

// ──────────────────────────────────────────
// 키워드 유형 파싱 ("쇼핑성 84%" → {type, score})
// ──────────────────────────────────────────
function parseKeywordType(raw) {
  if (!raw) return { type: null, score: null };
  const match = String(raw).match(/^(\S+)\s+(\d+)%$/);
  if (match) return { type: match[1], score: parseInt(match[2], 10) };
  return { type: raw, score: null };
}

// ──────────────────────────────────────────
// 경쟁강도 파싱 ("아주좋음 1.77" 또는 숫자만 → {grade, value})
// ──────────────────────────────────────────
function parseCompetition(raw) {
  if (raw === null || raw === undefined) return { grade: null, value: null };
  const str = String(raw);
  const match = str.match(/^(아주좋음|좋음|보통|나쁨|아주나쁨)\s+([\d.]+)$/);
  if (match) return { grade: match[1], value: parseFloat(match[2]) };
  const num = parseFloat(str);
  return { grade: null, value: isNaN(num) ? null : num };
}

// ──────────────────────────────────────────
// 숫자 변환
// ──────────────────────────────────────────
function toNum(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = parseFloat(String(val).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

// ──────────────────────────────────────────
// 단일 행 정제
// ──────────────────────────────────────────
function parseRow(rawRow) {
  const row = {};

  for (const [kor, eng] of Object.entries(COLUMN_MAP)) {
    const val = rawRow[kor];
    if (val === undefined) continue;

    if (eng === 'keywordType') {
      const { type, score } = parseKeywordType(val);
      row.keywordType = type;
      row.keywordTypeScore = score;
    } else if (eng === 'competition') {
      const { grade, value } = parseCompetition(val);
      row.competition = value;
      row.competitionGrade = grade;
    } else if (['rank', 'searchTotal', 'searchPC', 'searchMobile',
                 'productCount', 'adBidPC', 'adBidMobile',
                 'adClickAvg', 'adClickCompetition', 'adCostPerClick',
                 'adCTRPC', 'adCTRMobile'].includes(eng)) {
      row[eng] = toNum(val);
    } else {
      row[eng] = val || null;
    }
  }

  return row;
}

// ──────────────────────────────────────────
// 전체 결과 정제
// ──────────────────────────────────────────
function parseResult(scrapeResult) {
  const parsedData = (scrapeResult.data || []).map(parseRow);
  return {
    ...scrapeResult,
    data: parsedData,
  };
}

// ──────────────────────────────────────────
// JSON → CSV 변환
// ──────────────────────────────────────────
function toCSV(result) {
  const { data, categoryId, categoryName, period, collectedAt } = result;
  if (!data || data.length === 0) return '';

  const headers = [
    'rank', 'keyword', 'category',
    'keywordType', 'keywordTypeScore',
    'searchTotal', 'searchPC', 'searchMobile',
    'productCount', 'competition', 'competitionGrade',
    'adBidPC', 'adBidMobile',
    'adCTRPC', 'adCTRMobile',
    'adClickAvg', 'adClickCompetition', 'adCostPerClick',
  ];

  const rows = data.map((row) => headers.map((h) => row[h] ?? ''));

  return stringify([headers, ...rows]);
}

module.exports = { parseResult, toCSV };
