$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

function Wait-HttpJsonRpc {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$Body,
        [int]$TimeoutSeconds = 60
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json' -Body $Body
            if ($resp.result) {
                return $resp
            }
        } catch {
            Start-Sleep -Seconds 2
        }
    }

    throw "Timed out waiting for JSON-RPC endpoint: $Uri"
}

function Wait-HttpGet {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [int]$TimeoutSeconds = 30
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            return Invoke-RestMethod -Method Get -Uri $Uri
        } catch {
            Start-Sleep -Seconds 1
        }
    }

    throw "Timed out waiting for HTTP endpoint: $Uri"
}

function Wait-FabricListenerReady {
    param(
        [int]$TimeoutSeconds = 90
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $running = docker inspect -f "{{.State.Running}}" fabric-listener 2>$null
            if ($running -match 'true') {
                $logs = docker logs fabric-listener --tail 30 2>$null
                if ($logs -match 'Listening Fabric events on mychannel/xcall:XCALL') {
                    return
                }
            }
        } catch {
            # keep waiting
        }
        Start-Sleep -Seconds 2
    }

    throw 'Timed out waiting for fabric-listener to become ready'
}

Write-Host 'Starting Fabric containers...'
docker compose -f docker-compose.fabric.yml up -d fabric-ca.org1.example.com orderer.example.com peer0.org1.example.com fabric-listener

Write-Host 'Waiting for Fabric listener startup...'
Wait-FabricListenerReady

Write-Host 'Starting EVM node...'
docker compose up -d evm-node

Write-Host 'Waiting for EVM RPC (8545)...'
Wait-HttpJsonRpc -Uri 'http://127.0.0.1:8545' -Body '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' | Out-Null

Write-Host 'Ensuring TEE service is running...'
$existingTee = Get-CimInstance Win32_Process |
    Where-Object {
        $_.Name -eq 'node.exe' -and
        $_.CommandLine -match 'tee-verifier\\server.js'
    }

if (-not $existingTee) {
    $nodePath = (Get-Command node).Source
    $outLog = Join-Path $projectRoot 'runtime\logs\tee-start.out.log'
    $errLog = Join-Path $projectRoot 'runtime\logs\tee-start.err.log'
    if (Test-Path $outLog) { Remove-Item $outLog -Force }
    if (Test-Path $errLog) { Remove-Item $errLog -Force }

    Start-Process -FilePath $nodePath `
        -ArgumentList 'tee-verifier/server.js' `
        -WorkingDirectory $projectRoot `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError $errLog | Out-Null
}

Wait-HttpGet -Uri 'http://127.0.0.1:9000/pubkey' | Out-Null

Write-Host 'Deploying contracts to current EVM node...'
npm.cmd run deploy

Write-Host 'Restarting Fabric listener so it reloads deployment.json...'
docker compose -f docker-compose.fabric.yml restart fabric-listener

Write-Host 'Waiting for Fabric listener restart to complete...'
Wait-FabricListenerReady

Write-Host 'Running real Fabric test suite...'
npm.cmd run fabric:test

Write-Host ''
Write-Host 'Done. Latest result files:'
Write-Host '  runtime\fabric-real-summary.md'
Write-Host '  runtime\fabric-real-results.json'
