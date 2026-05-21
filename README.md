# Amazon Backfill Scraper (VPS Ready)

## Install

```bash
npm install
npx playwright install --with-deps chromium
cp .env.example .env
```

## Run CLI scrape

```bash
node src/main.js --inputFile input.json
```

## Run API service

```bash
npm start
```

## API examples

`GET http://localhost:3001/health`

`POST http://localhost:3001/scrape`

Headers:
- `Content-Type: application/json`
- `X-API-Key: <SCRAPER_API_KEY>`

Body:

```json
{
  "asins": ["B0XXXXXXXX"],
  "locale": "US",
  "maxReviewsPerStar": 5,
  "maxAsinsPerRun": 1
}
```



curl http://localhost:3001/health
curl -X POST http://localhost:3001/scrape ^
  -H "Content-Type: application/json" ^
  -H "X-API-Key: 7f3b8e1d9a2c4f6b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d" ^
  -d "{\"asins\":[\"B0F6N7YXF1\"],\"maxAsinsPerRun\":1}"