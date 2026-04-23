const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const iconv = require('iconv-lite');

const MASTER_DIR = path.join(__dirname, 'master');
const OUTPUT_FILE = path.join(__dirname, 'stocks.json');

const inputs = [
  { zipName: 'kospi_code.mst.zip', market: 'KOSPI' },
  { zipName: 'kosdaq_code.mst.zip', market: 'KOSDAQ' },
];

function parseLine(line, market) {
  if (!line || !line.trim()) return null;
  const rawLine = line.replace(/\r?\n$/, '');
  const part1 = rawLine.length > 228 ? rawLine.slice(0, rawLine.length - 228) : rawLine;
  const shortCode = part1.slice(0, 9).trim();
  const standardCode = part1.slice(9, 21).trim();
  const name = part1.slice(21).trim();

  if (!standardCode && !name) return null;
  return { market, shortCode, standardCode, name };
}

function parseZipFile(zipPath, market) {
  const zip = new AdmZip(zipPath);
  const entry = zip.getEntries().find((item) => /\.mst$/i.test(item.entryName));
  if (!entry) {
    throw new Error(`No .mst entry found in zip: ${zipPath}`);
  }

  const buffer = entry.getData();
  const text = iconv.decode(buffer, 'cp949');
  return text
    .split(/\r?\n/)
    .map((line) => parseLine(line, market))
    .filter(Boolean);
}

function buildStocks() {
  const allStocks = [];

  for (const input of inputs) {
    const zipPath = path.join(MASTER_DIR, input.zipName);
    if (!fs.existsSync(zipPath)) {
      console.warn(`Skipping missing file: ${zipPath}`);
      continue;
    }
    const stocks = parseZipFile(zipPath, input.market);
    allStocks.push(...stocks);
  }

  const byCode = allStocks.reduce((acc, stock) => {
    if (stock.standardCode) {
      acc[stock.standardCode] = {
        name: stock.name,
        market: stock.market,
        shortCode: stock.shortCode,
      };
    }
    return acc;
  }, {});

  return { stocks: allStocks, byCode };
}

function saveJson(data) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2), 'utf8');
  console.log(`Created ${OUTPUT_FILE} with ${data.stocks.length} entries.`);
}

try {
  const data = buildStocks();
  saveJson(data);
} catch (error) {
  console.error('Error generating stocks.json:', error.message);
  process.exit(1);
}
