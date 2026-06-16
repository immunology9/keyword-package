/**
 * category-sync.js
 * 
 * 아이템스카우트의 전체 카테고리 트리를 Playwright로 자동 추출.
 * 
 * 동작 원리:
 * - 카테고리 데이터는 JS 번들에 내장 (API 호출 없음, 확인 완료)
 * - 각 카테고리 선택 시 URL이 /category/{id}로 바뀜
 * - React Fiber에서 candidates prop으로 하위 카테고리 목록 로드됨
 * - 1차 클릭 → 2차 목록 로드 → 2차 클릭 → 3차 목록 로드 → ... 반복
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CATEGORY_CACHE_PATH = path.join(__dirname, 'categories.json');
const SYNC_TIMEOUT_MS = 60 * 1000; // 카테고리 하나당 최대 60초

// ──────────────────────────────────────────
// React Fiber에서 카테고리 데이터 추출
// (브라우저 context에서 실행되는 함수)
// ──────────────────────────────────────────
const EXTRACT_CATEGORIES_FROM_FIBER = () => {
  const root = document.querySelector('#__next') || document.body;
  const reactKey = Object.keys(root).find(k => k.startsWith('__reactFiber'));
  if (!reactKey) return null;

  const results = [];
  const seen = new Set();

  function walk(fiber, depth) {
    if (!fiber || depth > 300) return;

    // memoizedProps의 'candidates' prop 탐색
    const props = fiber.memoizedProps;
    if (props && typeof props === 'object') {
      const candidates = props.candidates;
      if (
        Array.isArray(candidates) &&
        candidates.length > 0 &&
        candidates[0]?.id !== undefined &&
        candidates[0]?.name !== undefined &&
        candidates[0]?.level !== undefined
      ) {
        const key = candidates.map(c => c.id).join(',');
        if (!seen.has(key)) {
          seen.add(key);
          results.push(candidates);
        }
      }
    }

    // memoizedState도 확인
    let state = fiber.memoizedState;
    while (state) {
      const val = state.memoizedState;
      if (
        Array.isArray(val) &&
        val.length > 0 &&
        val[0]?.id !== undefined &&
        val[0]?.name !== undefined &&
        val[0]?.level !== undefined
      ) {
        const key = val.map(c => c.id).join(',');
        if (!seen.has(key)) {
          seen.add(key);
          results.push(val);
        }
      }
      state = state.next;
    }

    walk(fiber.child, depth + 1);
    walk(fiber.sibling, depth + 1);
  }

  walk(root[reactKey], 0);
  return results;
};

// ──────────────────────────────────────────
// 특정 카테고리 클릭 → URL 변화 → 하위 목록 추출
// ──────────────────────────────────────────
async function clickCategoryAndGetChildren(page, categoryName, level) {
  // 해당 레벨의 combobox 버튼 (1차=0번째, 2차=1번째 ...)
  const comboIndex = level - 1;

  // combobox 열기
  const combos = await page.$$('[role="combobox"]');
  if (!combos[comboIndex]) return { url: page.url(), children: [] };

  await combos[comboIndex].click();
  await page.waitForTimeout(500);

  // 이름으로 항목 찾아 클릭
  try {
    const item = await page.getByText(categoryName, { exact: true }).first();
    if (item) {
      await item.click();
      await page.waitForTimeout(800);
    }
  } catch (e) {
    // 클릭 실패 시 ESC로 닫기
    await page.keyboard.press('Escape');
    return { url: page.url(), children: [] };
  }

  const currentUrl = page.url();
  const currentId = currentUrl.split('/category/')[1] || null;

  // React Fiber에서 다음 레벨 candidates 추출
  const allCandidates = await page.evaluate(EXTRACT_CATEGORIES_FROM_FIBER);
  const nextLevel = level + 1;
  const children = (allCandidates || [])
    .flat()
    .filter(c => c.level === nextLevel);

  return { url: currentUrl, id: currentId ? parseInt(currentId) : null, children };
}

// ──────────────────────────────────────────
// 재귀적으로 카테고리 트리 빌드
// ──────────────────────────────────────────
async function buildCategoryTree(page, categories, currentLevel, maxLevel = 4) {
  const result = [];

  for (const cat of categories) {
    console.log(`  ${'  '.repeat(currentLevel - 1)}[L${currentLevel}] ${cat.name} (id:${cat.id})`);

    const node = {
      id: cat.id,
      name: cat.name,
      level: cat.level,
      nvCatId: cat.nvCatId,
      isLeaf: cat.isLeaf,
      children: [],
    };

    // isLeaf=1이면 더 이상 하위 없음
    if (cat.isLeaf === 1 || currentLevel >= maxLevel) {
      result.push(node);
      continue;
    }

    // 해당 카테고리 클릭해서 하위 목록 로드
    const { children } = await clickCategoryAndGetChildren(page, cat.name, currentLevel);

    if (children && children.length > 0) {
      // 재귀 탐색
      node.children = await buildCategoryTree(page, children, currentLevel + 1, maxLevel);
    }

    result.push(node);

    // 과도한 클릭 방지: 짧은 딜레이
    await page.waitForTimeout(300);
  }

  return result;
}

// ──────────────────────────────────────────
// 트리를 평탄화(flatten)하여 { id, name, path, level } 목록으로
// ──────────────────────────────────────────
function flattenTree(nodes, parentPath = '') {
  const result = [];
  for (const node of nodes) {
    const currentPath = parentPath ? `${parentPath} > ${node.name}` : node.name;
    result.push({
      id: node.id,
      name: node.name,
      path: currentPath,
      level: node.level,
      nvCatId: node.nvCatId,
      isLeaf: node.isLeaf,
    });
    if (node.children && node.children.length > 0) {
      result.push(...flattenTree(node.children, currentPath));
    }
  }
  return result;
}

// ──────────────────────────────────────────
// 메인: 전체 카테고리 동기화
// ──────────────────────────────────────────
async function syncCategories({ headless = true } = {}) {
  console.log('[CategorySync] 시작...');

  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'ko-KR',
  });

  const page = await context.newPage();

  // 이미지/폰트 차단 (속도 향상)
  await page.route('**/*', route => {
    if (['image', 'font', 'media'].includes(route.request().resourceType())) {
      route.abort();
    } else {
      route.continue();
    }
  });

  try {
    await page.goto('https://itemscout.io/category', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // ── Step 1: 1차 카테고리 전체 목록 추출 ──
    console.log('[CategorySync] 1차 카테고리 추출 중...');

    const allCandidates = await page.evaluate(EXTRACT_CATEGORIES_FROM_FIBER);
    const level1 = (allCandidates || []).flat().filter(c => c.level === 1);

    if (level1.length === 0) {
      throw new Error('1차 카테고리 추출 실패 — Fiber 구조 변경 가능성');
    }

    console.log(`[CategorySync] 1차 카테고리 ${level1.length}개 발견`);

    // ── Step 2: 재귀 트리 빌드 ──
    const tree = await buildCategoryTree(page, level1, 1, 4);

    // ── Step 3: 결과 저장 ──
    const flat = flattenTree(tree);
    const result = {
      syncedAt: new Date().toISOString(),
      totalCount: flat.length,
      tree,
      flat,
    };

    fs.writeFileSync(CATEGORY_CACHE_PATH, JSON.stringify(result, null, 2), 'utf-8');
    console.log(`[CategorySync] 완료 — 총 ${flat.length}개 카테고리 저장: ${CATEGORY_CACHE_PATH}`);

    return result;
  } finally {
    await browser.close();
  }
}

// ──────────────────────────────────────────
// 캐시 읽기 (동기화 없이 저장된 목록 반환)
// ──────────────────────────────────────────
function loadCategories() {
  if (!fs.existsSync(CATEGORY_CACHE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CATEGORY_CACHE_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────
// 캐시 만료 여부 확인 (기본: 7일)
// ──────────────────────────────────────────
function isCacheStale(maxAgeDays = 7) {
  const cache = loadCategories();
  if (!cache || !cache.syncedAt) return true;
  const age = Date.now() - new Date(cache.syncedAt).getTime();
  return age > maxAgeDays * 24 * 60 * 60 * 1000;
}

// ──────────────────────────────────────────
// 자동: 만료 시 재동기화, 아니면 캐시 반환
// ──────────────────────────────────────────
async function getCategoriesWithAutoSync(maxAgeDays = 7) {
  if (isCacheStale(maxAgeDays)) {
    console.log('[CategorySync] 캐시 만료 → 자동 재동기화');
    return await syncCategories();
  }
  console.log('[CategorySync] 캐시 유효 → 저장된 데이터 반환');
  return loadCategories();
}

module.exports = {
  syncCategories,
  loadCategories,
  isCacheStale,
  getCategoriesWithAutoSync,
  flattenTree,
};
