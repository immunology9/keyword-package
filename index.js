const express  = require('express');
const path     = require('path');
const { scrape }                            = require('./scraper');
const { parseResult, toCSV }               = require('./parser');
const { getChildren, getRootCategories, getCacheStats } = require('./category-sync');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ── 인증 ─────────────────────────────────────
function auth(req, res, next) {
  const key = process.env.SCRAPER_API_KEY;
  if (!key) return next();
  if ((req.headers['x-api-key'] || req.query.apiKey) !== key)
    return res.status(401).json({ error: '인증 실패' });
  next();
}

// ── 동시 수집 제한 ────────────────────────────
let scraping = false;

// ── GET /health ───────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', scraping, cache: getCacheStats(), time: new Date().toISOString() });
});

// ── GET /categories ───────────────────────────
// 1차 카테고리 즉시 반환 (하드코딩, 0ms)
app.get('/categories', auth, (req, res) => {
  res.json({ data: getRootCategories() });
});

// ── GET /categories/children?id={catId} ───────
// 온디맨드: 캐시 있으면 즉시, 없으면 Playwright(2~4초)
app.get('/categories/children', auth, async (req, res) => {
  const { id } = req.query;
  try {
    const children = await getChildren(id);
    res.json({ data: children, cached: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /scrape ──────────────────────────────
app.post('/scrape', auth, async (req, res) => {
  if (scraping) return res.status(429).json({ error: '이미 수집 중입니다.' });
  const { categoryId, period = '30d', filters = {}, format = 'json' } = req.body;
  if (!categoryId) return res.status(400).json({ error: 'categoryId 필수' });

  scraping = true;
  const t0 = Date.now();
  try {
    const raw    = await scrape({ categoryId, period, filters });
    const result = parseResult(raw);
    result.elapsedMs = Date.now() - t0;

    if (format === 'csv') {
      const csv = toCSV(result);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="keywords_${categoryId}_${Date.now()}.csv"`);
      return res.send('\uFEFF' + csv);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    scraping = false;
  }
});

// ── GET /scrape ───────────────────────────────
app.get('/scrape', auth, async (req, res) => {
  if (scraping) return res.status(429).json({ error: '이미 수집 중입니다.' });
  const { categoryId, period = '30d', format = 'json', keywordType, excludeBrand, gender } = req.query;
  if (!categoryId) return res.status(400).json({ error: 'categoryId 필수' });

  const filters = {};
  if (keywordType)            filters.keywordType  = keywordType;
  if (excludeBrand === 'true') filters.excludeBrand = true;
  if (gender)                 filters.gender       = gender;

  scraping = true;
  const t0 = Date.now();
  try {
    const raw    = await scrape({ categoryId, period, filters });
    const result = parseResult(raw);
    result.elapsedMs = Date.now() - t0;

    if (format === 'csv') {
      const csv = toCSV(result);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="keywords_${categoryId}.csv"`);
      return res.send('\uFEFF' + csv);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    scraping = false;
  }
});

// ── 시작 ──────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] 포트 ${PORT} 실행 중`);
  console.log('[Server] GET  /categories           → 1차 즉시 반환');
  console.log('[Server] GET  /categories/children?id=1 → 온디맨드 2차+');
  console.log('[Server] POST /scrape               → 키워드 수집');
  console.log('[Server] GET  /health               → 상태 확인');
});
