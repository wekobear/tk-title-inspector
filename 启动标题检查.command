#!/bin/zsh
set -e
cd "$(dirname "$0")"
if [[ -x /opt/homebrew/bin/node && -x /opt/homebrew/bin/npm ]]; then
  export PATH="/opt/homebrew/bin:$PATH"
fi
if [[ ! -d node_modules ]]; then
  npm ci
fi
echo 'TK 标题检查：请在浏览器打开 http://127.0.0.1:5173/'
exec npm run dev
