import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { runScraper } from './src/scraper.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT) || 3001;

let running = false;

app.get('/health', (_req, res) => {
    res.json({
        success: true,
        service: 'amazon-scraper-api',
        running,
    });
});

app.post('/scrape', async (req, res) => {
    const configuredApiKey = process.env.SCRAPER_API_KEY;
    if (!configuredApiKey) {
        return res.status(500).json({
            success: false,
            error: 'SCRAPER_API_KEY is not configured on the server.',
        });
    }

    const incomingApiKey = req.header('X-API-Key');
    if (!incomingApiKey || incomingApiKey !== configuredApiKey) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized',
        });
    }

    if (running) {
        return res.status(429).json({
            success: false,
            error: 'A scrape job is already running. Please try again later.',
        });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!Array.isArray(body.asins) || body.asins.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'Invalid request body: asins must be a non-empty array.',
        });
    }

    let maxAsinsPerRun = Number.isInteger(body.maxAsinsPerRun) ? body.maxAsinsPerRun : 3;
    maxAsinsPerRun = Math.min(maxAsinsPerRun, 5);
    const maxReviewsPerStar = Number.isInteger(body.maxReviewsPerStar) ? body.maxReviewsPerStar : 5;
    const locale = (body.locale || 'US').toString().trim().toUpperCase() || 'US';

    const input = {
        ...body,
        asins: body.asins,
        maxAsinsPerRun,
        maxReviewsPerStar,
        locale,
    };

    const jobId = crypto.randomUUID();
    const jobsRoot = path.join(process.cwd(), 'jobs');
    const jobDir = path.join(jobsRoot, jobId);

    running = true;
    try {
        fs.mkdirSync(jobDir, { recursive: true });
        fs.writeFileSync(path.join(jobDir, 'input.json'), JSON.stringify(input, null, 2));

        const finalOutput = await runScraper(input, {
            jobId,
            outputDir: jobDir,
            writeFiles: true,
        });

        return res.json({
            success: true,
            jobId,
            result: finalOutput,
        });
    } catch (err) {
        const errorMessage = err?.message || String(err);
        try {
            fs.mkdirSync(jobDir, { recursive: true });
            fs.writeFileSync(
                path.join(jobDir, 'error.json'),
                JSON.stringify(
                    {
                        success: false,
                        jobId,
                        error: errorMessage,
                        ts: new Date().toISOString(),
                    },
                    null,
                    2,
                ),
            );
        } catch {
            // ignore write failures
        }

        return res.status(500).json({
            success: false,
            jobId,
            error: errorMessage,
        });
    } finally {
        running = false;
    }
});

app.listen(PORT, () => {
    console.log(`amazon-scraper-api listening on port ${PORT}`);
});
