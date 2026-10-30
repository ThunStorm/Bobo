#!/bin/bash
# Finder can launch this file with a minimal PATH; never depend on its cwd.
cd -- "$(dirname -- "$0")" || exit 1

fail() {
  printf '\n%s\n' "$1" >&2
  if [ -t 0 ]; then
    read -r -p '按回车键关闭窗口…' _reply
  fi
  exit 1
}

supported_node() {
  [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1
}

# An explicit override must be valid; do not silently select another runtime.
if [ -n "${NODE_BINARY:-}" ]; then
  supported_node "$NODE_BINARY" || fail 'NODE_BINARY 必须是可执行的 Node.js 18+ 绝对路径。'
  node_bin="$NODE_BINARY"
else
  node_bin="$(command -v node || true)"
  if ! supported_node "$node_bin"; then
    node_bin=''
    # Homebrew (Apple Silicon / Intel), official installer, Volta, then nvm.
    for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
      if supported_node "$candidate"; then
        node_bin="$candidate"
        break
      fi
    done
    if [ -z "$node_bin" ]; then
      best_major=0
      for candidate in "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node; do
        if supported_node "$candidate"; then
          major="$("$candidate" -p 'process.versions.node.split(".")[0]')"
          if [ "$major" -gt "$best_major" ]; then
            node_bin="$candidate"
            best_major="$major"
          fi
        fi
      done
    fi
  fi
  [ -n "$node_bin" ] || fail '未找到 Node.js 18+。请先安装 Node.js，或用 NODE_BINARY 指定其绝对路径，然后重新双击 upgrade-data.command。'
fi

printf 'Bobo · 使用 Node.js %s\n' "$("$node_bin" --version)"
"$node_bin" scripts/upgrade-data.js --interactive "$@"
upgrade_status=$?
if [ -t 0 ]; then read -r -p '按回车键关闭窗口…' _upgrade_reply; fi
exit "$upgrade_status"
