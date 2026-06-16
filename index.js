const express = require('express');
const { scrape } = require('./scraper');
const { parseResult, toCSV } = require('./parser');
const path = require('path');
const {
  syncCategories,
  loadCategories,
  isCacheStale,
  getCategoriesWithAutoSync,
} = require('./category-sync');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────────
// API Key 인증
// ──────────────────────────────────────────
function authMiddleware(req, res, next) {
  const apiKey = process.env.SCRAPER_API_KEY;
  if (!apiKey) return next();
  const provided = req.headers['x-api-key'] || req.query.apiKey;
  if (provided !== apiKey) {
    return res.status(401).json({ error: '인증 실패: x-api-key 헤더를 확인하세요' });
  }
  next();
}

// ──────────────────────────────────────────
// 동시 요청 제한 (Playwright 메모리 보호)
// ──────────────────────────────────────────
let isRunning = false;

// ──────────────────────────────────────────
// GET /health — 헬스체크
// ──────────────────────────────────────────
app.get('/health', (req, res) => {
  const cache = loadCategories();
  res.json({
    status: 'ok',
    running: isRunning,
    categoryCacheAge: cache
      ? `${Math.round((Date.now() - new Date(cache.syncedAt)) / 86400000)}일`
      : '없음',
    totalCategories: cache?.totalCount || 0,
    time: new Date().toISOString(),
  });
});

// ──────────────────────────────────────────
// GET /categories — 카테고리 목록 조회
// ?sync=true  : 강제 재동기화
// ?flat=true  : 트리 대신 flat 목록
// ?level=3    : 특정 레벨만 필터
// ──────────────────────────────────────────
app.get('/categories', authMiddleware, async (req, res) => {
  if (isRunning) return res.status(429).json({ error: '다른 작업 실행 중' });

  const { sync, flat, level } = req.query;

  try {
    let data;

    if (sync === 'true') {
      // 강제 재동기화
      if (isRunning) return res.status(429).json({ error: '이미 동기화 중' });
      isRunning = true;
      try {
        data = await syncCategories();
      } finally {
        isRunning = false;
      }
    } else {
      // 캐시 만료 시 자동 동기화 (기본 7일)
      const maxAgeDays = parseInt(process.env.CATEGORY_CACHE_DAYS || '7', 10);
      if (isRunning) {
        // 동기화 중이면 현재 캐시라도 반환
        data = loadCategories();
        if (!data) return res.status(503).json({ error: '카테고리 데이터 없음, 잠시 후 재시도' });
      } else {
        isRunning = true;
        try {
          data = await getCategoriesWithAutoSync(maxAgeDays);
        } finally {
          isRunning = false;
        }
      }
    }

    // 응답 가공
    let result = flat === 'true' ? data.flat : data.tree;

    // level 필터 (flat 모드에서만)
    if (flat === 'true' && level) {
      const lvl = parseInt(level, 10);
      result = data.flat.filter(c => c.level === lvl);
    }

    return res.json({
      syncedAt: data.syncedAt,
      totalCount: data.totalCount,
      stale: isCacheStale(),
      data: result,
    });
  } catch (err) {
    console.error('[Categories] 오류:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────
// POST /scrape — 키워드 수집
// ──────────────────────────────────────────
app.post('/scrape', authMiddleware, async (req, res) => {
  if (isRunning) return res.status(429).json({ error: '이미 수집 중입니다.' });

  const { categoryId, period = '30d', filters = {}, format = 'json' } = req.body;
  if (!categoryId) return res.status(400).json({ error: 'categoryId 필수' });

  isRunning = true;
  const startTime = Date.now();

  try {
    // categoryId 유효성 검증 (캐시된 카테고리 목록과 대조)
    const cache = loadCategories();
    if (cache) {
      const valid = cache.flat.some(c => String(c.id) === String(categoryId));
      if (!valid) {
        return res.status(400).json({
          error: `유효하지 않은 categoryId: ${categoryId}`,
          hint: 'GET /categories?flat=true 로 유효한 ID 목록 확인',
        });
      }
    }

    const raw = await scrape({ categoryId, period, filters });
    const result = parseResult(raw);
    result.elapsedMs = Date.now() - startTime;

    // 카테고리 경로 추가 (있으면)
    if (cache) {
      const catInfo = cache.flat.find(c => String(c.id) === String(categoryId));
      if (catInfo) result.categoryPath = catInfo.path;
    }

    if (format === 'csv') {
      const csv = toCSV(result);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="itemscout_${categoryId}_${Date.now()}.csv"`);
      return res.send('\uFEFF' + csv);
    }

    return res.json(result);
  } catch (err) {
    console.error('[Scrape] 오류:', err.message);
    return res.status(500).json({ error: err.message });
  } finally {
    isRunning = false;
  }
});

// ──────────────────────────────────────────
// GET /scrape — GET 방식 단순 호출
// ──────────────────────────────────────────
app.get('/scrape', authMiddleware, async (req, res) => {
  if (isRunning) return res.status(429).json({ error: '이미 수집 중입니다.' });

  const { categoryId, period = '30d', format = 'json', keywordType, excludeBrand, gender } = req.query;
  if (!categoryId) return res.status(400).json({ error: 'categoryId 필수' });

  const filters = {};
  if (keywordType) filters.keywordType = keywordType;
  if (excludeBrand === 'true') filters.excludeBrand = true;
  if (gender) filters.gender = gender;

  isRunning = true;
  const startTime = Date.now();

  try {
    const raw = await scrape({ categoryId, period, filters });
    const result = parseResult(raw);
    result.elapsedMs = Date.now() - startTime;

    if (format === 'csv') {
      const csv = toCSV(result);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="itemscout_${categoryId}.csv"`);
      return res.send('\uFEFF' + csv);
    }

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  } finally {
    isRunning = false;
  }
});

// ──────────────────────────────────────────
// 서버 시작 + 초기 카테고리 자동 로드
// ──────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[Server] 포트 ${PORT} 에서 실행 중`);
  console.log('[Server] 엔드포인트:');
  console.log('  GET  /health');
  console.log('  GET  /categories           (자동 동기화 포함)');
  console.log('  GET  /categories?sync=true (강제 재동기화)');
  console.log('  GET  /categories?flat=true&level=3');
  console.log('  POST /scrape');
  console.log('  GET  /scrape?categoryId=3502');

  // 서버 시작 시 카테고리 캐시가 없거나 만료된 경우 백그라운드 자동 동기화
  const maxAgeDays = parseInt(process.env.CATEGORY_CACHE_DAYS || '7', 10);
  if (isCacheStale(maxAgeDays)) {
    console.log('[Server] 카테고리 캐시 없음/만료 → 백그라운드 동기화 시작');
    isRunning = true;
    syncCategories()
      .then(data => console.log(`[Server] 카테고리 동기화 완료: ${data.totalCount}개`))
      .catch(err => console.error('[Server] 카테고리 동기화 실패:', err.message))
      .finally(() => { isRunning = false; });
  } else {
    const cache = loadCategories();
    console.log(`[Server] 카테고리 캐시 로드: ${cache?.totalCount}개 (${cache?.syncedAt})`);
  }
});
