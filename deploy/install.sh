#!/bin/bash
set -e
cd /opt/wafle-mcp
echo "=== Backup ==="
rm -rf /opt/wafle-mcp.bak.dist
cp -r dist /opt/wafle-mcp.bak.dist 2>/dev/null || true

echo "=== Extract ==="
tar xzf /tmp/wafle-mcp-v0.2.tgz -C /opt/wafle-mcp 2>/dev/null

echo "=== package.json version ==="
grep '"version"' /opt/wafle-mcp/package.json

echo "=== npm install ==="
npm install --no-fund --no-audit 2>&1 | tail -8

echo "=== build ==="
npm run build 2>&1 | tail -5

echo "=== verify dist ==="
ls -la dist/index.js
node dist/index.js --version 2>&1 | head -3

echo "=== restart service ==="
systemctl restart wafle-mcp
sleep 2
systemctl is-active wafle-mcp
echo "=== service status ==="
systemctl status wafle-mcp --no-pager | head -15

echo "=== healthz ==="
curl -s http://127.0.0.1:7100/healthz || true

echo "=== DONE ==="
