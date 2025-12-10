export function parseNumberWithSuffix(numStr) {
    if (!numStr) return null;
    numStr = numStr.replace(/,/g, '');
    let multiplier = 1;
    if (/k/i.test(numStr)) multiplier = 1000;
    if (/m/i.test(numStr)) multiplier = 1000000;
    return parseFloat(numStr) * multiplier;
}

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
