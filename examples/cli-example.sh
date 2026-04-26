#!/usr/bin/env bash
# Smoke-test wafle-mcp over stdio: initialize, list tools, call wafle_auth_me.
# Requires: WAFLE_API_KEY in env (or .env loaded), Node 20+, dist/ built.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${WAFLE_API_KEY:-}" ]]; then
  echo "WAFLE_API_KEY is required" >&2
  exit 2
fi

if [[ ! -f dist/index.js ]]; then
  echo "dist/ not built; running npm run build…" >&2
  npm run build
fi

node - <<'JS'
const { spawn } = require('node:child_process');
const proc = spawn('node', ['dist/index.js', '--transport=stdio'], {
  env: { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' },
});
let buf = '';
proc.stdout.on('data', (d) => { buf += d.toString(); });
proc.stderr.on('data', (d) => process.stderr.write(d));

function send(msg) { proc.stdin.write(JSON.stringify(msg) + '\n'); }

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'wafle-cli-example', version: '0.1.0' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wafle_auth_me', arguments: {} } });
send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'wafle_stores_list', arguments: {} } });

setTimeout(() => {
  proc.kill('SIGTERM');
  for (const line of buf.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.id === 1) console.log('=> initialize ok');
      else if (m.id === 2) console.log(`=> tools/list returned ${m.result?.tools?.length} tools`);
      else if (m.id === 3) console.log('=> wafle_auth_me ->', JSON.stringify(m.result?.content));
      else if (m.id === 4) {
        const txt = m.result?.content?.[0]?.text ?? '';
        const stores = (txt.match(/"slug": "([^"]+)"/g) || []).map(s => s.replace(/.*"([^"]+)".*/, '$1'));
        console.log(`=> wafle_stores_list -> ${stores.length} stores: ${stores.join(', ')}`);
      }
    } catch {}
  }
  process.exit(0);
}, 5000);
JS
