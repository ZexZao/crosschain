$root = Split-Path -Parent $PSScriptRoot
$project = Split-Path -Parent $root

docker compose -f (Join-Path $project 'docker-compose.fabric.yml') run --rm fabric-tools bash /fabric-network/fabric-network/scripts/create-channel.sh
