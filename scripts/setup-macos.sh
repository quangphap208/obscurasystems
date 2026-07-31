#!/usr/bin/env bash
# setup-macos.sh — cài & chạy Obscura Systems trên VPS/máy macOS (idempotent, chạy lại được).
# Lo: Homebrew, Node 20, pm2, npm deps, Chromium (Playwright), migrate + seed, rồi bật pm2.
# KHÔNG tự điền .env / whitelist Atlas — 2 việc đó cần bạn làm tay (script sẽ nhắc & chặn nếu thiếu).
#
#   cd obscurasystems
#   bash scripts/setup-macos.sh
#
set -euo pipefail

# ── vị trí repo (script nằm trong scripts/) ───────────────────────────────────
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say()  { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()   { printf "  \033[1;32m✔\033[0m %s\n" "$*"; }
warn() { printf "  \033[1;33m!\033[0m %s\n" "$*"; }
die()  { printf "\n\033[1;31m✘ %s\033[0m\n" "$*" >&2; exit 1; }

[[ "$(uname)" == "Darwin" ]] || die "Script này cho macOS. Linux VPS xem docs/DEPLOY (dùng apt + playwright --with-deps)."

# ── 1) Homebrew ───────────────────────────────────────────────────────────────
say "1/8 Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  warn "Chưa có Homebrew — đang cài…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # nạp brew vào PATH (Apple Silicon vs Intel)
  [[ -x /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)"
  [[ -x /usr/local/bin/brew ]]   && eval "$(/usr/local/bin/brew shellenv)"
fi
ok "brew $(brew --version | head -1 | awk '{print $2}')"

# ── 2) Node 20 ────────────────────────────────────────────────────────────────
say "2/8 Node.js (>=18, khuyến nghị 20)"
NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/v([0-9]+).*/\1/' || echo 0)"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  warn "Node thiếu/cũ (đang: $(node -v 2>/dev/null || echo 'không có')) — cài node@20…"
  brew install node@20
  brew link --overwrite --force node@20 2>/dev/null || true
fi
ok "node $(node -v)  ·  npm $(npm -v)"

# ── 3) pm2 ────────────────────────────────────────────────────────────────────
say "3/8 pm2"
command -v pm2 >/dev/null 2>&1 || npm install -g pm2
ok "pm2 $(pm2 -v)"

# ── 4) npm deps ───────────────────────────────────────────────────────────────
say "4/8 npm install"
npm install
ok "dependencies xong"

# ── 5) Chromium cho Playwright (BE cần browser thật để qua quantum PoW) ────────
say "5/8 Chromium (Playwright)"
npx playwright install chromium
ok "Chromium sẵn sàng"

# ── 6) .env — bắt buộc điền trước ─────────────────────────────────────────────
say "6/8 Kiểm tra .env"
if [[ ! -f .env ]]; then
  cp .env.example .env
  die ".env vừa được tạo từ .env.example — HÃY ĐIỀN giá trị thật (BOT_TOKEN, MONGODB_URI, BLOOM_SESSIONS, ADMIN_IDS) rồi chạy lại script."
fi
# validate các khoá bắt buộc có giá trị (không phải placeholder)
req_missing=0
check_env() {
  local key="$1"
  local val
  val="$(grep -E "^${key}=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*//' | xargs 2>/dev/null || true)"
  if [[ -z "$val" || "$val" == *"..."* || "$val" == "123456:ABC"* || "$val" == *"user:pass@"* || "$val" == "token_shard_1"* ]]; then
    warn "$key chưa điền (đang: '${val:-trống}')"; req_missing=1
  else
    ok "$key ✓"
  fi
}
check_env BOT_TOKEN
check_env MONGODB_URI
check_env BLOOM_SESSIONS
check_env ADMIN_IDS
[[ "$req_missing" == 0 ]] || die "Điền nốt các khoá còn thiếu trong .env rồi chạy lại."

# nhắc whitelist Atlas
IP="$(curl -fsS --max-time 5 ifconfig.me 2>/dev/null || echo '?')"
warn "MongoDB Atlas → Network Access phải whitelist IP máy này: ${IP}  (thiếu = kết nối timeout)."

# ── 7) migrate + seed ─────────────────────────────────────────────────────────
say "7/8 migrate + seed (Atlas)"
npm run migrate
npm run seed
ok "collection/index + pool Bloom xong"

# ── 8) pm2 up ─────────────────────────────────────────────────────────────────
say "8/8 pm2 start"
if pm2 describe kol-be >/dev/null 2>&1; then
  pm2 restart ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi
pm2 save
ok "kol-fe + kol-be đang chạy"

printf "\n\033[1;32m✅ Xong.\033[0m\n"
cat <<'EOF'
  • Tự bật lại sau reboot:   pm2 startup   ← chạy dòng lệnh nó in ra (có sudo)
  • Xem log:                 pm2 logs kol-be   (tìm "🟢 shard 1 WS connected")
  • Trạng thái:              pm2 status
  • Cập nhật code sau này:    git pull && npm install && pm2 restart all

  ⚠️  Chỉ chạy 1 nơi: nếu máy khác cũng chạy cùng BOT_TOKEN, tắt nó (pm2 delete all)
      kẻo Telegram lỗi 409 và noti gửi 2 lần.
EOF
