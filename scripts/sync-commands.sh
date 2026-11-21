#!/bin/sh
# Copies the generated SDK from an exe.dev repository checkout, and writes
# src/version.ts, which it imports, from package.json.
# Usage: npm run sync-commands [-- path/to/exe]   (default: ../exe)
set -eu
cp "${1:-../exe}/sdk/js/"*.ts src/
node scripts/version.mjs
