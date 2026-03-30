const fs = require('fs-extra');
const path = require('path');

function usage() {
  console.error('Usage: node scripts/load-test-case.js <dataset-file> <case-id> [--full]');
  process.exit(1);
}

function main() {
  const datasetFile = process.argv[2];
  const caseId = process.argv[3];
  const full = process.argv.includes('--full');

  if (!datasetFile || !caseId) {
    usage();
  }

  const p = path.resolve(process.cwd(), datasetFile);
  if (!fs.existsSync(p)) {
    throw new Error(`Dataset file not found: ${p}`);
  }

  const dataset = fs.readJsonSync(p);
  const found = (dataset.cases || []).find((item) => item.caseId === caseId);
  if (!found) {
    throw new Error(`Case not found: ${caseId}`);
  }

  process.stdout.write(JSON.stringify(full ? found : found.payload));
}

main();
