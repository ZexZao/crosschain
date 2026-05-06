# One-click cross-chain E2E test startup script
# Supports first-time setup and subsequent runs
# Usage: .\start.ps1 [-TestMode forward|full] [-SkipSetup]

param(
    [ValidateSet('forward', 'full')]
    [string]$TestMode = 'full',
    [switch]$SkipSetup
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

$fabricRuntime = Join-Path $projectRoot 'fabric-network\runtime'
$isFirstTime = (-not $SkipSetup) -and (-not (Test-Path $fabricRuntime))

function Write-Step {
    param([string]$Message)
    Write-Host "`n>> $Message" -ForegroundColor Cyan
}

function Wait-Rpc {
    param([string]$Uri, [string]$Body = '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}', [int]$Timeout = 60)
    $deadline = (Get-Date).AddSeconds($Timeout)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json' -Body $Body
            if ($r.result) { return $r }
        } catch { Start-Sleep -Seconds 2 }
    }
    throw "Timeout: $Uri"
}

function Wait-Container {
    param([string]$Name, [string]$LogPattern, [int]$Timeout = 120)
    $deadline = (Get-Date).AddSeconds($Timeout)
    while ((Get-Date) -lt $deadline) {
        $running = docker inspect -f '{{.State.Running}}' $Name 2>$null
        if ($running -eq 'true') {
            if (-not $LogPattern) { return }
            $logs = docker logs $Name --tail 10 2>$null
            if ($logs -match $LogPattern) { return }
        }
        Start-Sleep -Seconds 2
    }
    throw "Timeout waiting for container: $Name"
}

function Wait-Process {
    param([string]$Pattern, [int]$Timeout = 5)
    $deadline = (Get-Date).AddSeconds($Timeout)
    while ((Get-Date) -lt $deadline) {
        $found = Get-Process -Name 'node' -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowTitle -match $Pattern -or $_.CommandLine -match $Pattern }
        if ($found) { return }
        Start-Sleep -Seconds 1
    }
}

# =============================================
# Phase 1: First-time setup
# =============================================
if ($isFirstTime) {
    Write-Step 'Phase 1: First-time setup'

    Write-Host 'Installing npm dependencies...'
    npm install 2>&1 | Select-Object -Last 5

    Write-Host 'Bootstrapping Fabric network (crypto material + genesis block)...'
    powershell -ExecutionPolicy Bypass -File fabric-network\scripts\bootstrap.ps1

    Write-Host 'Exporting Fabric wallet identity...'
    node scripts/export-fabric-wallet.js

    Write-Host 'Compiling Solidity contracts...'
    npx hardhat compile --quiet
} else {
    Write-Step 'Phase 1: Skipped (Fabric network already initialized)'
}

# =============================================
# Phase 2: Start blockchain infrastructure
# =============================================
Write-Step 'Phase 2: Starting blockchain infrastructure'

Write-Host 'Starting Fabric containers (CA, orderer, peers, validators, aggregator)...'
docker compose -f docker-compose.fabric.yml up -d `
    fabric-ca.org1.example.com `
    orderer.example.com `
    peer0.org1.example.com peer1.org1.example.com peer2.org1.example.com peer3.org1.example.com `
    validator-node-1 validator-node-2 validator-node-3 validator-node-4 `
    consensus-aggregator `
    fabric-tools 2>&1 | Select-Object -Last 5

Write-Host 'Starting EVM containers (node + validators)...'
docker compose up -d evm-node evm-validator-node-1 evm-validator-node-2 evm-validator-node-3 evm-validator-node-4 2>&1 | Select-Object -Last 5

Write-Host 'Starting TEE verifier in Docker...'
docker compose up -d tee-verifier 2>&1 | Select-Object -Last 3

# =============================================
# Phase 3: Wait for all services
# =============================================
Write-Step 'Phase 3: Waiting for services to be ready'

$peers = @('peer0.org1.example.com', 'peer1.org1.example.com', 'peer2.org1.example.com', 'peer3.org1.example.com')
foreach ($peer in $peers) {
    Write-Host "  Waiting for $peer..."
    Wait-Container -Name $peer -LogPattern 'Started peer' -Timeout 180
}

Write-Host '  Waiting for Fabric validators + aggregator...'
Wait-Container -Name 'validator-node-1' -LogPattern 'listening' -Timeout 120
Wait-Container -Name 'validator-node-2' -LogPattern 'listening' -Timeout 60
Wait-Container -Name 'validator-node-3' -LogPattern 'listening' -Timeout 60
Wait-Container -Name 'validator-node-4' -LogPattern 'listening' -Timeout 60
Wait-Container -Name 'consensus-aggregator' -LogPattern 'listening on 9200' -Timeout 60

Write-Host '  Waiting for EVM RPC (port 8545)...'
Wait-Rpc -Uri 'http://127.0.0.1:8545' | Out-Null

Write-Host '  Waiting for EVM validators...'
Wait-Container -Name 'crosschain-evm-validator-node-1-1' -LogPattern 'listening' -Timeout 120
Wait-Container -Name 'crosschain-evm-validator-node-2-1' -LogPattern 'listening' -Timeout 60
Wait-Container -Name 'crosschain-evm-validator-node-3-1' -LogPattern 'listening' -Timeout 60
Wait-Container -Name 'crosschain-evm-validator-node-4-1' -LogPattern 'listening' -Timeout 60

Write-Host '  Waiting for TEE verifier (port 9000)...'
$teeDeadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $teeDeadline) {
    try {
        $teeResp = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:9000/pubkey' -TimeoutSec 2
        if ($teeResp.address) { break }
    } catch { Start-Sleep -Seconds 2 }
}

# =============================================
# Phase 4: Channel + chaincode (first time only)
# =============================================
if ($isFirstTime) {
    Write-Step 'Phase 4: Creating channel and deploying chaincode'

    Write-Host 'Creating Fabric channel mychannel...'
    powershell -ExecutionPolicy Bypass -File fabric-network\scripts\create-channel.ps1

    Write-Host 'Deploying xcall chaincode...'
    powershell -ExecutionPolicy Bypass -File fabric-network\scripts\deploy-chaincode.ps1
} else {
    Write-Step 'Phase 4: Skipped (channel + chaincode already deployed)'
}

# =============================================
# Phase 5: Deploy EVM contracts
# =============================================
Write-Step 'Phase 5: Deploying EVM contracts'
npm.cmd run deploy 2>&1 | Select-Object -Last 5

# =============================================
# Phase 6: Start Fabric listener
# =============================================
Write-Step 'Phase 6: Starting Fabric listener'

Write-Host 'Starting fabric-listener in Docker...'
docker compose -f docker-compose.fabric.yml up -d fabric-listener 2>&1 | Select-Object -Last 3

Write-Host 'Waiting for fabric-listener to be ready...'
Wait-Container -Name 'fabric-listener' -LogPattern 'Listening Fabric events' -Timeout 90

# =============================================
# Phase 7: Restart consensus aggregator (picks up EVM validators)
# =============================================
Write-Step 'Phase 7: Restarting consensus aggregator for EVM validator connectivity'
docker restart consensus-aggregator 2>&1 | Out-Null
Start-Sleep -Seconds 3
Wait-Container -Name 'consensus-aggregator' -LogPattern 'listening on 9200' -Timeout 60

# =============================================
# Phase 8: Run tests
# =============================================
Write-Step 'Phase 8: Running tests'

if ($TestMode -eq 'full') {
    Write-Host 'Running FULL round-trip test suite (Fabric -> EVM -> Fabric ACK)...' -ForegroundColor Green
    node scripts/run-full-suite.js
    Write-Host ''
    Write-Host 'Results:' -ForegroundColor Green
    Write-Host '  runtime\fabric-full-roundtrip-results.json'
} else {
    Write-Host 'Running FORWARD-ONLY test suite (Fabric -> EVM)...' -ForegroundColor Green
    node scripts/run-fabric-e2e-tests.js
    Write-Host ''
    Write-Host 'Results:' -ForegroundColor Green
    Write-Host '  runtime\fabric-hybrid-e2e-results.json'
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host 'All done!' -ForegroundColor Green
