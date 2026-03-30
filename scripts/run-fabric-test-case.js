const { execFileSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

function usage() {
  console.error('Usage: node scripts/run-fabric-test-case.js <dataset-file> <case-id>');
  process.exit(1);
}

function main() {
  const datasetFile = process.argv[2];
  const caseId = process.argv[3];
  if (!datasetFile || !caseId) {
    usage();
  }

  const projectRoot = path.join(__dirname, '..');
  const datasetPath = path.resolve(projectRoot, datasetFile);
  if (!fs.existsSync(datasetPath)) {
    throw new Error(`Dataset file not found: ${datasetPath}`);
  }

  const dataset = fs.readJsonSync(datasetPath);
  const selected = (dataset.cases || []).find((item) => item.caseId === caseId);
  if (!selected) {
    throw new Error(`Case not found: ${caseId}`);
  }
  if (!selected.payload) {
    throw new Error(`Case ${caseId} does not contain payload`);
  }

  const tempPath = path.join(projectRoot, 'runtime', `fabric-case-${caseId}.json`);
  fs.ensureDirSync(path.dirname(tempPath));
  fs.writeFileSync(tempPath, JSON.stringify(selected.payload), 'utf8');

  try {
    const composeArgs = [
      'compose',
      '-f',
      'docker-compose.fabric.yml',
      'run',
      '--rm',
      'fabric-tools',
      'bash',
      '/fabric-network/fabric-network/scripts/invoke-xcall.sh',
      '--payload-file',
      `/fabric-network/runtime/${path.basename(tempPath)}`
    ];

    const result = execFileSync('docker', composeArgs, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: 'pipe'
    });

    console.log(JSON.stringify({
      ok: true,
      caseId,
      dataset: dataset.dataset,
      description: selected.description,
      payload: selected.payload,
      output: result.trim()
    }, null, 2));
  } finally {
    fs.removeSync(tempPath);
  }
}

main();
