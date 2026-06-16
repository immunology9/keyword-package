# ──────────────────────────────────────────
# Railway용 Playwright 도커 이미지
# Playwright 공식 base image 사용 (Chromium 내장)
# ──────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# 패키지 설치
COPY package*.json ./
RUN npm install --production

# Playwright Chromium 설치 확인
RUN npx playwright install chromium

# 소스 복사
COPY . .

# Railway는 PORT 환경변수 자동 설정
EXPOSE 3000

CMD ["node", "index.js"]
