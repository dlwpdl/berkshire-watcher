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
npm run send
```

`--dry-run`을 붙이면 Telegram 전송 없이 콘솔에만 출력합니다.

## Telecodex Flow

1. Telegram에서 ai-berkshire/berkshire-watcher 전용 Codex 세션에 자연어로 요청합니다.
2. Codex가 `data/portfolio.json`을 수정합니다.
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

## Portfolio Shape

중요한 필드만 유지합니다.

```json
{
  "ticker": "MP",
  "status": "watching",
  "portfolios": ["전체", "전략광물"],
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

## Sources

현재 기사 본문을 직접 긁지 않습니다. 기본 수집은 Google News RSS이고, `data/sources.json`의 저명한 도메인을 `site:` 검색으로 섞습니다.

소스 우선순위:

```text
1. 공식 원문: SEC, Federal Register, Commerce/BIS, Defense.gov, 회사 IR
2. 저명 시장 뉴스: Reuters, Bloomberg, FT, WSJ
3. 산업 전문: Mining.com, Fastmarkets, S&P Global, Argus, Defense News
4. 하류 체인 전문: Automotive News, InsideEVs, Electrek, IEA
```

종목별로 `source_groups`를 지정하면 필요한 소스만 사용합니다.
