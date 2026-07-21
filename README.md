# Berkshire Watcher

`portfolio.json`에 등록한 종목을 기준으로 회사 뉴스가 아니라 요인망 변화를 감시해 Telegram으로 보냅니다.

알림 목표:

```text
T점수 + 긍정/부정 + 쉬운 판단 + 큰그림 + 같이 봐야 할 종목 + 확인할 데이터 해석법
```

## Run

```bash
npm run check
```

실제 뉴스 검색과 Telegram 전송:

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
MINIMAX_API_KEY=... # 선택: 있으면 기사 본문 한국어 요약/번역에 사용
MINIMAX_API_URL=https://integrate.api.nvidia.com/v1/chat/completions
MINIMAX_MODEL=minimaxai/minimax-m3
npm run send
```

`--dry-run`을 붙이면 Telegram 전송 없이 콘솔에만 출력합니다.

## Telecodex Flow

1. Telegram에서 ai-berkshire/berkshire-watcher 전용 Codex 세션에 자연어로 요청합니다.
2. Codex가 `data/portfolio.json`과 `data/profiles/*.json`을 수정합니다.
3. Codex가 commit/push합니다.
4. GitHub Actions가 하루 두 번 `portfolio.json`을 읽고 알림을 보냅니다.

## Schedule

GitHub Actions runs twice daily at 08:00 and 20:00 KST:

```text
0 23 * * *  # UTC, previous day
0 11 * * *  # UTC
```

예:

```text
MP 관심종목 추가. 희토류, 방산, EV 체인으로 봐줘.
NVDA는 보유로 바꿔.
CRCL은 일시중지.
```

삭제는 기본적으로 `paused`로 바꾸는 것을 권장합니다. 완전 삭제는 명시했을 때만 하세요.

## Data Shape

`portfolio.json`은 보유/관심 목록만 얇게 유지합니다.

```json
{
  "ticker": "MP",
  "name": "MP Materials",
  "status": "watching",
  "portfolios": ["전체", "전략광물"],
  "template": "critical_minerals",
  "profile": "MP"
}
```

종목별 상세 요인은 `data/profiles/TICKER.json`에 둡니다.

```json
{
  "template": "critical_minerals",
  "sector": "Materials",
  "subsector": "Rare Earths & Critical Minerals",
  "themes": ["rare earths", "defense supply chain"],
  "sector_cycle": {
    "why": "소재/전략광물 섹터 자금 흐름이 개별 종목 판단에 영향을 줌",
    "positive": ["소재 섹터가 시장 대비 강함"],
    "negative": ["성장주/고변동성 종목에서 자금이 빠짐"],
    "watch": ["Materials sector relative strength", "REMX trend"]
  },
  "watch_queries": [
    {
      "query": "China rare earth export controls",
      "why": "중국 공급망 압박이 커지는지 확인"
    }
  ],
  "related_tickers": [
    {
      "ticker": "LYC.AX",
      "why": "MP와 가장 직접 비교되는 중국 밖 희토류 공급자"
    }
  ],
  "key_indicators": [
    {
      "name": "NdPr price",
      "why": "희토류 핵심 가격 지표",
      "positive": "상승하면 MP 매출/마진 기대에 긍정",
      "negative": "급락하면 공급망 프리미엄 약화 가능"
    }
  ]
}
```

반복되는 섹터/테마 기본값은 `data/templates/*.json`에 둡니다. 템플릿은 시작점이고, 실제 메시지 품질은 종목별 profile의 `why_it_matters`, `chain`, `related_tickers`, `key_indicators`가 결정합니다.

## Sources

기본 수집은 Google News RSS이고, Google 링크를 원문 URL로 해제한 뒤 접근 가능한 HTML 본문을 읽어 내용 요약에 반영합니다. 회사 종목은 회사명/티커가 직접 확인된 기사만, 레버리지 ETF는 등록된 섹터 트리거가 확인된 기사만 사용합니다.

`MINIMAX_API_KEY`가 있으면 NVIDIA OpenAI 호환 endpoint의 `minimaxai/minimax-m3`로 본문 기반 한국어 요약/번역을 만들고, 없으면 기존 Google 번역 fallback을 사용합니다. 필요하면 `MINIMAX_API_URL`, `MINIMAX_MODEL`, `MAX_ARTICLE_FETCHES`로 조정합니다.

`REQUIRE_ARTICLE_BODY=1`을 지정하면 본문을 확보한 기사만 허용합니다. 기본값은 `0`이며, 이때도 본문 없는 기사는 등록된 tier 1~2 출처만 허용합니다. 미등록 출처와 tier 3 보도자료는 원문 본문이 있어야 후보가 되며, 판단은 `출처 확인`으로 제한됩니다.

기본값은 `NEWS_MAX_AGE_HOURS=48`입니다. Google News RSS의 발행시각이 이 범위를 벗어난 기사는 오래된 뉴스로 보고 알림 후보에서 제외합니다.

Telegram 전송이 성공하면 기사 키를 `state/seen.json`에 기록합니다. GitHub Actions는 이 파일을 캐시로 다음 실행에 복원해 같은 종목의 같은 기사를 다시 보내지 않습니다.

알림의 `T1~T10`은 중요도이고, 색상은 방향입니다. 종목별 프로필 트리거만 중요도를 높이며 일반 호재/악재 표현은 초록·빨강·노랑·흰색 방향 판정에만 사용합니다.

소스 관리는 종목마다 복사하지 않습니다. `data/sources.json`의 재사용 그룹을 템플릿이 고르고, 종목별 `trusted_sources`에는 회사 공식 IR/뉴스룸처럼 그 종목에만 붙는 원문 출처만 둡니다.

소스 우선순위:

```text
1. 공식 원문: SEC, Federal Register, Commerce/BIS, Defense.gov, 회사 IR
2. 저명 시장 뉴스: Reuters, Bloomberg, FT, WSJ
3. 산업 전문: Mining.com, Fastmarkets, S&P Global, Argus, Defense News
4. 하류 체인 전문: Automotive News, InsideEVs, Electrek, IEA
```

종목별로 `source_groups`를 지정하면 필요한 소스만 사용합니다.
