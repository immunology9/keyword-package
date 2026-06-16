/**
 * category-sync.js — 온디맨드 카테고리 로딩
 *
 * 전략: 사용자가 드롭다운을 선택할 때만 Playwright로 해당 레벨 자식만 가져옴
 * 캐시: 메모리(Map) + 파일(cache/cat_{id}.json) 이중 캐시
 * 속도: 캐시 히트 시 즉시(<50ms) / 미스 시 2~4초
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ── 메모리 캐시 ────────────────────────────
const memCache  = new Map();
const pending   = new Map();
let   busy      = false;
const waitQueue = [];

// ── 1차 카테고리 하드코딩 (instant) ────────
const ROOT_CATEGORIES = [
  { id:1,     name:'패션의류',     level:1, isLeaf:0 },
  { id:2,     name:'패션잡화',     level:1, isLeaf:0 },
  { id:3,     name:'화장품/미용',  level:1, isLeaf:0 },
  { id:4,     name:'디지털/가전',  level:1, isLeaf:0 },
  { id:5,     name:'가구/인테리어',level:1, isLeaf:0 },
  { id:6,     name:'출산/육아',    level:1, isLeaf:0 },
  { id:7,     name:'식품',         level:1, isLeaf:0 },
  { id:8,     name:'스포츠/레저',  level:1, isLeaf:0 },
  { id:9,     name:'생활/건강',    level:1, isLeaf:0 },
  { id:10,    name:'여가/생활편의',level:1, isLeaf:0 },
  { id:11,    name:'면세점',       level:1, isLeaf:0 },
  { id:45830, name:'도서',         level:1, isLeaf:0 },
];

// ── 파일 캐시 유틸 ─────────────────────────
function cacheFile(id) { return path.join(CACHE_DIR, `cat_${id}.json`); }

function readCache(id) {
  try {
    const f = cacheFile(id);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf-8')).data;
  } catch { return null; }
}

function writeCache(id, data) {
  try {
    fs.writeFileSync(
      cacheFile(id),
      JSON.stringify({ cachedAt: new Date().toISOString(), data }),
      'utf-8'
    );
  } catch (e) { console.error('[Cache] 저장 실패:', e.message); }
}

// ── React Fiber에서 최하위 candidates 추출 ─
const EXTRACT_FN = () => {
  const root = document.querySelector('#__next') || document.body;
  const key  = Object.keys(root).find(k => k.startsWith('__reactFiber'));
  if (!key) return [];

  let maxLevel = -1;
  let result   = [];

  function walk(fiber, depth) {
    if (!fiber || depth > 300) return;
    const cands = fiber.memoizedProps?.candidates;
    if (Array.isArray(cands) && cands.length > 0 && typeof cands[0]?.level === 'number') {
      if (cands[0].level > maxLevel) {
        maxLevel = cands[0].level;
        result   = cands;
      }
    }
    walk(fiber.child,   depth + 1);
    walk(fiber.sibling, depth + 1);
  }

  walk(root[key], 0);
  return result;
};

// ── candidates 존재 여부 확인 (waitForFunction용) ─
const CHECK_FN = () => {
  const root = document.querySelector('#__next') || document.body;
  const key  = Object.keys(root).find(k => k.startsWith('__reactFiber'));
  if (!key) return false;
  let found = false;
  function walk(f, d) {
    if (!f || d > 300 || found) return;
    const c = f.memoizedProps?.candidates;
    if (Array.isArray(c) && c.length > 0 && c[0]?.level !== undefined) found = true;
    walk(f.child, d + 1);
    walk(f.sibling, d + 1);
  }
  walk(root[key], 0);
  return found;
};

// ── Playwright 동시 실행 제어 ───────────────
async function withBrowser(fn) {
  if (busy) {
    await new Promise(r => waitQueue.push(r));
  }
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
    if (waitQueue.length > 0) waitQueue.shift()();
  }
}

// ── Playwright로 자식 카테고리 fetch ────────
async function fetchFromSite(categoryId) {
  return withBrowser(async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
    });
    const page = await (await browser.newContext({ locale: 'ko-KR' })).newPage();

    await page.route('**/*', route => {
      const t = route.request().resourceType();
      (['image','font','media','stylesheet'].includes(t)) ? route.abort() : route.continue();
    });

    try {
      console.log(`[CatFetch] 접속: /category/${categoryId}`);
      await page.goto(`https://itemscout.io/category/${categoryId}`, {
        waitUntil: 'networkidle', timeout: 30000,
      });

      // 드롭다운 클릭 → React 상태 업데이트 트리거
      const combos = await page.$$('[role="combobox"]');
      if (combos.length > 0) {
        await combos[0].click();
        await page.waitForTimeout(400);
        await page.keyboard.press('Escape');
      }

      // candidates가 로드될 때까지 대기 (최대 10초)
      await page.waitForFunction(CHECK_FN, { timeout: 10000 }).catch(() => {});

      const children = await page.evaluate(EXTRACT_FN);
      console.log(`[CatFetch] id:${categoryId} → ${children.length}개`);
      return children;
    } finally {
      await browser.close();
    }
  });
}

// ── 메인 export: 자식 목록 반환 ────────────
async function getChildren(categoryId) {
  const id = Number(categoryId);

  // 루트(0 또는 NaN) → 하드코딩 즉시 반환
  if (!id) return ROOT_CATEGORIES;

  // 메모리 캐시 히트
  if (memCache.has(id)) {
    console.log(`[Cache] hit(memory): ${id}`);
    return memCache.get(id);
  }

  // 파일 캐시 히트
  const cached = readCache(id);
  if (cached) {
    console.log(`[Cache] hit(file): ${id}`);
    memCache.set(id, cached);
    return cached;
  }

  // 동일 id 중복 요청 방지
  if (pending.has(id)) {
    console.log(`[Cache] pending: ${id}`);
    return pending.get(id);
  }

  const promise = fetchFromSite(id)
    .then(data => {
      memCache.set(id, data);
      writeCache(id, data);
      return data;
    })
    .catch(err => {
      console.error(`[CatFetch] 실패 id:${id}:`, err.message);
      return [];
    })
    .finally(() => pending.delete(id));

  pending.set(id, promise);
  return promise;
}

function getRootCategories() { return ROOT_CATEGORIES; }

function getCacheStats() {
  return {
    memory:  memCache.size,
    files:   fs.readdirSync(CACHE_DIR).filter(f => f.startsWith('cat_')).length,
    pending: pending.size,
  };
}

module.exports = { getChildren, getRootCategories, getCacheStats };
