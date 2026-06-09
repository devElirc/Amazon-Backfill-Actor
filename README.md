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



