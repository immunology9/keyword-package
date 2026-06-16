# 아이템스카우트 카테고리 수집기

아이템스카우트 `/category/{id}` 페이지에서 인기 키워드 데이터를 자동 수집하는 Railway 서버입니다.

## 구조

```
index.js      ← Express API 서버 (진입점)
scraper.js    ← Playwright 스크래핑 핵심 로직
parser.js     ← DOM 데이터 정제 + CSV 변환
Dockerfile    ← Railway 배포용 컨테이너 설정
railway.toml  ← Railway 설정
```

---

## Railway 배포 방법

1. GitHub에 이 폴더 push
2. Railway 대시보드 → New Project → Deploy from GitHub
3. 환경변수 설정 (선택):
   - `SCRAPER_API_KEY` : API 인증키 (없으면 인증 생략)
   - `PORT` : Railway가 자동 설정 (건드리지 않아도 됨)
4. 배포 완료 후 도메인 확인

---

## API 사용법

### 헬스체크
```
GET /health
```

---

### 수집 요청 (POST)
```
POST /scrape
Content-Type: application/json
x-api-key: YOUR_KEY  (SCRAPER_API_KEY 설정 시)

{
  "categoryId": "3502",
  "period": "30d",
  "filters": {
    "keywordType": "shopping",
    "excludeBrand": true,
    "gender": "all"
  },
  "format": "json"
}
```

### 수집 요청 (GET - 간단 버전)
```
GET /scrape?categoryId=3502
GET /scrape?categoryId=3502&format=csv
GET /scrape?categoryId=3502&keywordType=shopping&gender=female
```

---

## 파라미터 설명

| 파라미터 | 필수 | 값 | 설명 |
|---------|------|-----|------|
| categoryId | ✅ | "3502" | URL의 숫자 |
| period | | "30d" / "2025-05" | 기간 (기본: 최근 30일) |
| format | | "json" / "csv" | 응답 형식 (기본: json) |
| filters.keywordType | | "all" / "shopping" / "info" / "brand" | 키워드 유형 |
| filters.excludeBrand | | true / false | 주요 브랜드 제외 |
| filters.isNew | | "1month" / "1year" | 신규 키워드 필터 |
| filters.gender | | "all" / "male" / "female" | 성별 필터 |

---

## 응답 예시 (JSON)

```json
{
  "success": true,
  "categoryId": "3502",
  "categoryName": "메모판/미니보드",
  "period": "30d",
  "totalCount": 484,
  "collectedCount": 484,
  "collectedAt": "2026-06-16T10:00:00.000Z",
  "elapsedMs": 45230,
  "data": [
    {
      "rank": 405,
      "keyword": "투두리스트",
      "category": "스케줄러/플래너",
      "keywordType": "쇼핑성",
      "keywordTypeScore": 84,
      "searchTotal": 24070,
      "searchPC": 2100,
      "searchMobile": 21970,
      "productCount": 42690,
      "competition": 1.77,
      "competitionGrade": "아주좋음",
      "adBidPC": 320,
      "adBidMobile": 280,
      "adCTRPC": 0.82,
      "adCTRMobile": 1.24,
      "adClickAvg": 1574.6,
      "adClickCompetition": 27.11,
      "adCostPerClick": 0.09
    }
  ]
}
```

---

## 카테고리 ID 찾는 법

1. https://itemscout.io/category 접속
2. 원하는 카테고리 선택
3. URL 확인: `https://itemscout.io/category/3502` → ID = `3502`

---

## 주의사항

- 수집 1회당 약 30~90초 소요 (카테고리 키워드 수에 따라)
- 동시 요청 1개 제한 (Playwright 메모리 소모로 인한 안전장치)
- Railway 무료 플랜은 메모리 512MB → Playwright는 1GB 이상 권장 (Hobby 이상)
