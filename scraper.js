const { chromium } = require('playwright');

// ──────────────────────────────────────────
// 상수
// ──────────────────────────────────────────
const BASE_URL = 'https://itemscout.io/category';
const SCROLL_WAIT_MS = 1500;   // 스크롤 후 대기 시간 (너무 짧으면 데이터 누락)
const MAX_SCROLL_TRIES = 40;   // 안전장치: 최대 스크롤 횟수
const TABLE_TIMEOUT_MS = 15000; // 테이블 렌더링 대기 최대 시간

// 보기옵션에서 추가로 체크할 컬럼 텍스트
// (기본 체크되지 않은 것들만 — 현장에서 확인한 목록)
const EXTRA_COLUMNS = [
  'PC 검색수',
  '모바일 검색수',
  'PC 광고단가',
  '모바일 광고단가',
  'PC 광고클릭률',
  '모바일 광고클릭률',
  '모바일 광고클릭수',
];

// ──────────────────────────────────────────
// 메인 스크래퍼
// ──────────────────────────────────────────
async function scrape(options = {}) {
  const {
    categoryId,
    period = '30d',       // '30d' | 'YYYY-MM' (예: '2025-05')
    filters = {},
    headless = true,
  } = options;

  if (!categoryId) throw new Error('categoryId 필수');

  const browser = await chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',   // Railway 메모리 제한 대응
      '--disable-gpu',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ko-KR',
  });

  const page = await context.newPage();

  // 불필요한 리소스 차단 (속도 향상)
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'font', 'media'].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  try {
    // ── 1. 페이지 접속 ──────────────────────
    console.log(`[Scraper] 접속: ${BASE_URL}/${categoryId}`);
    await page.goto(`${BASE_URL}/${categoryId}`, { waitUntil: 'networkidle', timeout: 30000 });

    // ── 2. 테이블 로딩 대기 ──────────────────
    await page.waitForSelector('table tbody tr', { timeout: TABLE_TIMEOUT_MS });
    console.log('[Scraper] 테이블 로딩 완료');

    // ── 3. 보기옵션 — 모든 컬럼 활성화 ─────
    await enableAllColumns(page);

    // ── 4. 기간 설정 ────────────────────────
    if (period !== '30d') {
      await setPeriod(page, period);
    }

    // ── 5. 필터 설정 ────────────────────────
    if (Object.keys(filters).length > 0) {
      await applyFilters(page, filters);
    }

    // 필터 적용 후 테이블 재로딩 대기
    await page.waitForSelector('table tbody tr', { timeout: TABLE_TIMEOUT_MS });
    await page.waitForTimeout(1000);

    // ── 6. 총 키워드 수 파악 ────────────────
    const totalCount = await getTotalCount(page);
    console.log(`[Scraper] 총 키워드: ${totalCount}개`);

    // ── 7. 무한 스크롤 — 전체 데이터 로드 ──
    await scrollToLoadAll(page, totalCount);

    // ── 8. 데이터 추출 ──────────────────────
    const { headers, rows } = await extractTableData(page);
    console.log(`[Scraper] 추출 완료: ${rows.length}개`);

    // ── 9. 카테고리명 추출 ──────────────────
    const categoryName = await getCategoryName(page);

    return {
      success: true,
      categoryId,
      categoryName,
      period,
      filters,
      totalCount,
      collectedCount: rows.length,
      collectedAt: new Date().toISOString(),
      headers,
      data: rows,
    };
  } finally {
    await browser.close();
  }
}

// ──────────────────────────────────────────
// 보기옵션: 미체크 컬럼 전부 켜기
// ──────────────────────────────────────────
async function enableAllColumns(page) {
  try {
    // "보기옵션" 버튼 클릭
    const viewOptBtn = await page.getByText('보기옵션').first();
    await viewOptBtn.click();
    await page.waitForTimeout(800);

    // 모든 체크박스 텍스트 확인 후 미체크된 것 체크
    const checkboxLabels = await page.$$('label');
    for (const label of checkboxLabels) {
      const text = (await label.innerText()).trim();
      if (EXTRA_COLUMNS.includes(text)) {
        const checkbox = await label.$('input[type="checkbox"]');
        if (checkbox) {
          const isChecked = await checkbox.isChecked();
          if (!isChecked) {
            await checkbox.click();
            await page.waitForTimeout(200);
          }
        }
      }
    }

    // 경쟁강도 표시 → "숫자"만 (파싱 편의)
    const numOnlyLabel = await page.getByText('숫자').first();
    if (numOnlyLabel) {
      await numOnlyLabel.click();
      await page.waitForTimeout(200);
    }

    // "적용" 또는 "저장" 버튼 클릭
    const applyBtn = await page.getByRole('button', { name: /적용|저장|확인/ }).first();
    if (applyBtn) {
      await applyBtn.click();
    } else {
      // 버튼 없으면 ESC로 닫기
      await page.keyboard.press('Escape');
    }

    await page.waitForTimeout(1000);
    console.log('[Scraper] 보기옵션 전체 컬럼 활성화 완료');
  } catch (e) {
    console.warn('[Scraper] 보기옵션 설정 실패 (기본값 유지):', e.message);
  }
}

// ──────────────────────────────────────────
// 기간 설정 (과거 선택 - 월 단위)
// ──────────────────────────────────────────
async function setPeriod(page, period) {
  try {
    // '과거 선택' 버튼 클릭
    await page.getByText('과거 선택').click();
    await page.waitForTimeout(800);

    // 달력/드롭다운에서 해당 월 선택 (year-month 형식: '2025-05')
    // 실제 UI에 따라 조정 필요
    const [year, month] = period.split('-');
    console.log(`[Scraper] 기간 설정: ${year}년 ${month}월`);

    // 사이트 UI에 따라 드롭다운 또는 달력 조작
    // (UI 변경 시 이 부분 수정)
    await page.waitForTimeout(500);
  } catch (e) {
    console.warn('[Scraper] 기간 설정 실패 (최근 30일 유지):', e.message);
  }
}

// ──────────────────────────────────────────
// 필터 설정
// ──────────────────────────────────────────
async function applyFilters(page, filters) {
  try {
    const {
      keywordType,    // 'all' | 'shopping' | 'info' | 'brand'
      excludeBrand,   // true/false
      isNew,         // '1month' | '1year' | null
      gender,        // 'all' | 'male' | 'female'
      ageMin,
      ageMax,
    } = filters;

    // 키워드 유형
    if (keywordType && keywordType !== 'all') {
      const typeMap = {
        shopping: '쇼핑성',
        info: '정보성',
        brand: '브랜드 키워드',
      };
      const label = typeMap[keywordType];
      if (label) {
        await page.getByText(label).first().click();
        await page.waitForTimeout(300);
      }
    }

    // 주요 브랜드 제외
    if (excludeBrand) {
      try {
        await page.getByText('주요 브랜드 제외').click();
        await page.waitForTimeout(300);
      } catch (e) {}
    }

    // 신규 키워드
    if (isNew === '1month') {
      await page.getByText('1달 전 없던').first().click();
      await page.waitForTimeout(300);
    } else if (isNew === '1year') {
      await page.getByText('1년 전 없던').first().click();
      await page.waitForTimeout(300);
    }

    // 성별
    if (gender && gender !== 'all') {
      const genderMap = { male: '남성', female: '여성' };
      await page.getByText(genderMap[gender]).first().click();
      await page.waitForTimeout(300);
    }

    // 연령대 슬라이더 (필요 시 구현 확장)
    // → 복잡한 슬라이더 조작이 필요해 일단 생략

    await page.waitForTimeout(500);
    console.log('[Scraper] 필터 설정 완료', filters);
  } catch (e) {
    console.warn('[Scraper] 필터 설정 실패:', e.message);
  }
}

// ──────────────────────────────────────────
// 총 키워드 수 파악
// ──────────────────────────────────────────
async function getTotalCount(page) {
  try {
    const text = await page.evaluate(() => {
      const el = [...document.querySelectorAll('h2, h3, h4, [class*="count"]')]
        .find((e) => /키워드 \d+개/.test(e.innerText));
      return el ? el.innerText : '';
    });
    const match = text.match(/키워드 (\d+)개/);
    return match ? parseInt(match[1], 10) : 500;
  } catch {
    return 500; // 파악 실패 시 최대값으로
  }
}

// ──────────────────────────────────────────
// 무한 스크롤 — 전체 데이터 로드
// ──────────────────────────────────────────
async function scrollToLoadAll(page, totalCount) {
  let prevCount = 0;
  let tries = 0;

  while (tries < MAX_SCROLL_TRIES) {
    const currentCount = await page.evaluate(
      () => document.querySelectorAll('table tbody tr').length
    );

    console.log(`[Scraper] 로드됨: ${currentCount} / ${totalCount}`);

    if (currentCount >= totalCount) break;     // 전체 로드 완료
    if (currentCount === prevCount) {
      tries++;
      if (tries >= 3) {
        console.warn('[Scraper] 스크롤 후 변화 없음 — 수집 종료');
        break;
      }
    } else {
      tries = 0;
    }

    prevCount = currentCount;

    // 페이지 최하단으로 스크롤
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(SCROLL_WAIT_MS);
  }
}

// ──────────────────────────────────────────
// 테이블 전체 데이터 추출
// ──────────────────────────────────────────
async function extractTableData(page) {
  return await page.evaluate(() => {
    // 헤더
    const headers = [...document.querySelectorAll('table thead th')]
      .map((th) => th.innerText.trim().replace(/\s+/g, ' '))
      .filter((h) => h.length > 0);

    // 행 데이터
    const rows = [...document.querySelectorAll('table tbody tr')].map((tr) => {
      const cells = [...tr.querySelectorAll('td')];
      const row = {};

      cells.forEach((td, i) => {
        const key = headers[i] || `col${i}`;
        if (!key || key === '') return;

        const raw = td.innerText.trim().replace(/\s+/g, ' ');

        // 숫자 파싱: 쉼표 제거
        const numOnly = raw.replace(/,/g, '');
        const parsed = parseFloat(numOnly);

        row[key] = isNaN(parsed) ? raw : parsed;
      });

      return row;
    });

    return { headers, rows };
  });
}

// ──────────────────────────────────────────
// 카테고리명 추출
// ──────────────────────────────────────────
async function getCategoryName(page) {
  try {
    return await page.evaluate(() => {
      // "메모판/미니보드 최근 30일" 형태의 텍스트에서 카테고리명만 추출
      const el = [...document.querySelectorAll('p, span, div')]
        .find((e) => e.innerText && /최근 30일|과거/.test(e.innerText) && e.innerText.length < 50);
      return el ? el.innerText.replace(/최근 30일|과거.*/, '').trim() : '';
    });
  } catch {
    return '';
  }
}

module.exports = { scrape };
