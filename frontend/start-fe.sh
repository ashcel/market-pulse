#!/bin/bash
cd /home/ubuntu/code/personal/market-pulse/frontend
NODE_ENV=production \
PORT=3002 \
BACKEND_URL=http://localhost:8002 \
INTERNAL_API_KEY=3abc0fc7504850eff7e32e07923e41a1bc0118105886b71c4b412126ea092588 \
DATABASE_URL='postgres://postgres:dc5520c9736a963eba1eab087e3bb1253780b0df3440c3fe@localhost:5435/market_pulse' \
node .output/server/index.mjs 2>/tmp/fe-error.log
