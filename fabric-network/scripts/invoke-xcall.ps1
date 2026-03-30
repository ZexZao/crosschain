param(
  [string]$PayloadJson = '{"op":"asset_lock","assetId":"FABRIC-DEMO-001","owner":"org1.userA","amount":"88.00"}'
)

$root = Split-Path -Parent $PSScriptRoot
$project = Split-Path -Parent $root

docker compose -f (Join-Path $project 'docker-compose.fabric.yml') run --rm fabric-tools bash /fabric-network/fabric-network/scripts/invoke-xcall.sh $PayloadJson
