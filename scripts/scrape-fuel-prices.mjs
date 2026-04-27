// scripts/scrape-fuel-prices.mjs
// Pakistan fuel price scraper for FleetLine.
//
// Runs in GitHub Actions on a schedule and writes data/fuel-prices.json.
// Tries multiple sources in priority order. On failure, KEEPS the last
// successful petrol/diesel values so the app never sees `null`.
//
// If a target's HTML changes and the parser breaks:
//   1. Run `node scripts/scrape-fuel-prices.mjs` locally to see logs
//   2. Tweak the regex or selector for that target below
//   3. Commit. The Action will pick it up next run.

import fs from 'node:fs/promises';
import path from 'node:path';

const PLAUSIBLE_MIN_PKR = 100;   // floor for petrol/L sanity check
const PLAUSIBLE_MAX_PKR = 1000;  // ceiling for petrol/L sanity check
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = 'fleetline-fuel-price-bot/1.0 (+https://github.com/chabdulhanan555-star/fleetline-supabase)';

// Targets are tried in order. First one that returns a plausible petrol number wins.
const TARGETS = [
  {
    name: 'PSO',
    url: 'https://www.psopk.com/',
    parse: parsePsoFptitle,
  },
  {
    name: 'ProPakistani',
    url: 'https://propakistani.pk/petrol-price-in-pakistan/',
    parse: parseGenericPriceTable,
  },
];

const dataPath = path.resolve('data/fuel-prices.json');

async function loadPrevious() {
  try {
    const raw = await fs.readFile(dataPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

// ---- Parsers -------------------------------------------------------------

// PSO renders prices as `<p class="fptitle">Rs.XXX/Ltr</p>` inside a uikit
// switcher. The page also contains a placeholder value (420) repeated dozens
// of times for marketing tabs. We treat any value that appears >5 times as a
// placeholder, and assume the first real price in document order is petrol
// and the next distinct one is diesel.
function parsePsoFptitle(html) {
  const matches = [...html.matchAll(/class="fptitle">\s*Rs\.?\s*([0-9]+(?:\.[0-9]+)?)\s*\/?\s*Ltr/gi)];
  if (matches.length === 0) return { petrol: null, diesel: null };

  const prices = matches.map((match) => Number(match[1])).filter((value) => Number.isFinite(value));
  const counts = prices.reduce((accumulator, price) => {
    accumulator[price] = (accumulator[price] ?? 0) + 1;
    return accumulator;
  }, {});

  // Real fuel prices typically appear 1-5 times (per region). Anything over
  // that is almost certainly a marketing placeholder.
  const isPlausible = (price) =>
    price >= PLAUSIBLE_MIN_PKR && price <= PLAUSIBLE_MAX_PKR && counts[price] <= 5;

  let petrol = null;
  let diesel = null;
  for (const price of prices) {
    if (!isPlausible(price)) continue;
    if (petrol === null) {
      petrol = price;
      continue;
    }
    if (price !== petrol) {
      diesel = price;
      break;
    }
  }
  return { petrol, diesel };
}

// Generic price-table-ish parser for news pages.
function parseGenericPriceTable(html) {
  const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  return {
    petrol: extractPriceNear(stripped, /\bpetrol\b/i),
    diesel: extractPriceNear(stripped, /\bdiesel\b/i),
  };
}

// Find the first plausible "PKR XX.XX" within ~140 chars of the keyword.
function extractPriceNear(html, keywordRegex) {
  const matchKeyword = html.match(keywordRegex);
  if (!matchKeyword) return null;
  const start = matchKeyword.index ?? 0;
  const window = html.slice(start, start + 220);

  // Match either "Rs. 285.40" / "PKR 285.40" / "285.40" / "285"
  const priceMatches = [...window.matchAll(/(?:rs\.?|pkr|₨)?\s*([0-9]{2,4}(?:\.[0-9]{1,2})?)/gi)];
  for (const m of priceMatches) {
    const num = Number(m[1]);
    if (Number.isFinite(num) && num >= PLAUSIBLE_MIN_PKR && num <= PLAUSIBLE_MAX_PKR) {
      return Math.round(num * 100) / 100;
    }
  }
  return null;
}

// ---- Main ----------------------------------------------------------------

async function tryTarget(target) {
  console.log(`[scraper] trying ${target.name} (${target.url})`);
  try {
    const html = await fetchHtml(target.url);
    const parsed = target.parse(html);
    if (!parsed.petrol || parsed.petrol < PLAUSIBLE_MIN_PKR || parsed.petrol > PLAUSIBLE_MAX_PKR) {
      throw new Error(`Could not extract a plausible petrol price (got ${parsed.petrol})`);
    }
    console.log(`[scraper] ${target.name} ok: petrol=${parsed.petrol}, diesel=${parsed.diesel}`);
    return {
      petrol: parsed.petrol,
      diesel: parsed.diesel,
      source: target.name,
      sourceUrl: target.url,
    };
  } catch (error) {
    console.warn(`[scraper] ${target.name} failed: ${error.message}`);
    return { error: error.message, source: target.name };
  }
}

async function main() {
  const previous = await loadPrevious();
  const fetchedAt = new Date().toISOString();

  const errors = [];
  let success = null;
  for (const target of TARGETS) {
    const result = await tryTarget(target);
    if (result.petrol) {
      success = result;
      break;
    }
    errors.push(`${result.source}: ${result.error}`);
  }

  const output = success
    ? {
        success: true,
        petrol: success.petrol,
        diesel: success.diesel,
        currency: 'PKR',
        fetchedAt,
        source: success.source,
        sourceUrl: success.sourceUrl,
        error: null,
        lastSuccessfulFetch: fetchedAt,
      }
    : {
        success: false,
        petrol: previous?.petrol ?? null,
        diesel: previous?.diesel ?? null,
        currency: 'PKR',
        fetchedAt,
        source: null,
        sourceUrl: null,
        error: errors.join(' | ') || 'Unknown failure',
        lastSuccessfulFetch: previous?.lastSuccessfulFetch ?? null,
      };

  await fs.mkdir(path.dirname(dataPath), { recursive: true });
  await fs.writeFile(dataPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  console.log(`[scraper] wrote ${dataPath}`);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error('[scraper] fatal error:', err);
  process.exit(1);
});
