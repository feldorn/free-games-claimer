#!/bin/bash
set -e

npm install --no-audit --no-fund
npx patchright install chromium 2>/dev/null || true
