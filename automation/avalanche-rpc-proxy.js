const http = require('http');

const allowedPorts = new Set([9650, 9652, 9654, 9656, 9658]);
const host = process.env.AVALANCHE_PROXY_TARGET_HOST || 'host.docker.internal';
const listenPort = Number(process.env.AVALANCHE_PROXY_PORT || 9650);

const server = http.createServer((request, response) => {
  const match = String(request.url || '').match(/^\/node\/(\d+)(\/.*)$/);
  const targetPort = match ? Number(match[1]) : 9650;
  const targetPath = match ? match[2] : request.url;
  if (!allowedPorts.has(targetPort)) {
    response.writeHead(400);
    response.end('unsupported Avalanche node port');
    return;
  }
  const upstream = http.request({
    host,
    port: targetPort,
    path: targetPath,
    method: request.method,
    headers: { ...request.headers, host: `localhost:${targetPort}` },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', (error) => {
    response.writeHead(502, { 'content-type': 'text/plain' });
    response.end(error.message);
  });
  request.pipe(upstream);
});

server.listen(listenPort, '0.0.0.0', () => {
  console.log(`Avalanche RPC proxy listening on ${listenPort}`);
});
