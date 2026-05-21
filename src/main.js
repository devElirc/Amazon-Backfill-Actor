import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import minimist from 'minimist';
import { runScraper } from './scraper.js';

async function main() {
    const argv = minimist(process.argv.slice(2));
    const inputFile = argv.inputFile || 'input.json';

    let input = {};
    try {
        input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    } catch (err) {
        console.error(`[cli] Failed to read input file "${inputFile}":`, err.message || String(err));
        process.exit(1);
    }

    try {
        const finalOutput = await runScraper(input, {
            outputDir: process.cwd(),
            writeFiles: true,
        });
        console.log('[cli] Scrape completed successfully');
        console.log(`[cli] runId=${finalOutput.runId} items=${Array.isArray(finalOutput.results) ? finalOutput.results.length : 0}`);
        process.exit(0);
    } catch (err) {
        console.error('[cli] Scrape failed:', err.message || String(err));
        process.exit(1);
    }
}

main();
