#!/bin/sh
# Copies the generated SDK from an exe.dev repository checkout.
# Usage: npm run sync-commands [-- path/to/exe]   (default: ../exe)
set -eu
cp "${1:-../exe}/sdk/js/"*.ts src/
