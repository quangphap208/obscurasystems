# Analytics & Admin Dashboard — phần data của dự án

> Mô hình theo [DASHBOARD.md](DASHBOARD.md) (clone guide từ `find_og_token`): **bot ghi event
> một chỗ, mọi thứ downstream chỉ là aggregation đọc**. Metric mới = aggregation mới,
> không cần schema migration.

Triển khai 13-14/8/2026, 4 phase (mỗi phase 1 commit): event tracking → payments audit +
delivery rollup → dashboard server → hardening.

---

## 1. Data model

| Collection | Ghi bởi | Nội dung | TTL |
|---|---|---|---|
| `user_actions` | FE qua [`shared/track.mjs`](../shared/track.mjs) | 1 doc / event: `{tg_id, action, meta?, at:Date}` | **90 ngày** |
| `users.last_active_at` | middleware `touch()` (mọi tương tác) | ms — nguồn cho "active today/week" | — |
| `payments` | FE `successful_payment` (Stars) + `crypto-pay tryCredit` | audit: `{_id:"<method>:<ref>", tg_id, method, kind, amount, currency, usd, ref, at}` — `_id` idempotent, retry không double-record | vĩnh viễn |
| `delivery_stats` | BE [`be-core/dispatch.mjs`](../be-core/dispatch.mjs) | rollup/ngày DM đã gửi: `{_id:"YYYY-MM-DD", n, kind.*, src.*}` — đếm in-memory, flush `$inc` 60s (restart mất ≤60s) | vĩnh viễn |
| `admin_actions` | dashboard `pro-action` | audit mutation từ browser: `{via:"dash", action, target, ...}` | vĩnh viễn |

Index tạo ở [`shared/mongo.mjs`](../shared/mongo.mjs) (`npm run migrate`).

### Taxonomy `action` (user_actions)

| action | meta | Ý nghĩa |
|---|---|---|
| `start` | `{source?, ref?, qa?}` | /start (kèm nguồn campaign + referral first-touch) |
| `add` | `{handle, result: ok\|limit\|not_found\|no_access}` | funnel thêm account |
| `remove` | `{handle, ok}` | bỏ theo dõi (lệnh + nút 🗑) |
| `toggle` | `{key, scope: g\|w, h?, on}` | bật/tắt setting |
| `nav` | `{to}` | điều hướng màn (home/accounts/referrals/settings) |
| `subscribe_view` / `plan_view` | `{enabled}` / `{kind}` | funnel thanh toán — bước xem |
| `invoice_stars` / `invoice_crypto` | `{kind}` / `{kind, coin}` | funnel — bước tạo invoice |
| `paid_stars` | `{kind, stars}` | thanh toán Stars thành công |
| `pay_manual` | `{ok}` | /pay đối soát tay |
| `support` | `{len}` | report gửi admin |
| `platform` | `{p, act: on\|off\|all\|none\|follow\|unfollow, h?}` | picker Truth/IG |
| `admin` | `{cmd, target, ...}` | /grant, /whitelist, /unwhitelist qua Telegram |

**Quy ước:** `track()` fire-and-forget (không await, nuốt lỗi) — analytics không được làm chậm
UI. **Không** log mỗi DM gửi ra thành event (fan-out lớn) — đo qua `delivery_stats`.

---

## 2. Dashboard (`dashboard/`)

- **Server**: [`server.mjs`](../dashboard/server.mjs) — node:http thuần, 0 dependency.
  `npm run dash` / pm2 `kol-dash` (đã khai báo trong `ecosystem.config.cjs`).
- **UI**: [`index.html`](../dashboard/index.html) — 1 trang dark, fetch JSON, tự refresh 60s.
  Stat tiles + bar chart (activity/deliveries/hourly) + bảng (top handles, sources/referral,
  actions, payments, PRO, recent events) + form quản PRO.

### API

| Endpoint | Trả về |
|---|---|
| `GET /api/overview` | tổng user/tier, active & new hôm nay, watches, event/noti hôm nay, doanh thu |
| `GET /api/activity?days=` | event/ngày + unique users (user_actions) |
| `GET /api/deliveries?days=` | DM gửi/ngày (delivery_stats) |
| `GET /api/hourly` | event theo giờ, 24h (UTC) |
| `GET /api/actions?days=` | đếm theo loại action |
| `GET /api/top-handles` | handle được watch nhiều nhất |
| `GET /api/sources` | user theo `ref_source` + referral funnel + top referrer |
| `GET /api/payments` | 30 giao dịch gần nhất + totals theo method/kind |
| `GET /api/pro-users` | tài khoản ≠ Free: days_left, watches, last_active |
| `GET /api/recent` | 50 event gần nhất |
| `POST /api/pro-action` | `{action: grant\|whitelist\|free, tg_id, days?, limit?}` — mirror lệnh bot, ghi `admin_actions` |

### Bảo mật (làm từ đầu, không nợ như bản gốc find_og_token)

- `DASH_PASSWORD` **bắt buộc** từ env — trống thì server từ chối chạy. Sinh: `openssl rand -hex 12`.
- Session cookie HttpOnly SameSite=Strict 24h (in-memory — restart = logout hết).
- Rate-limit login **5 lần / 5 phút / IP**. CSRF token cho mọi POST mutation.
- **Bind `127.0.0.1` mặc định** — truy cập: `ssh -L 5050:127.0.0.1:5050 vps` rồi mở
  `http://localhost:5050`. Muốn public: nginx + TLS + IP allowlist, đừng đổi `DASH_BIND` trần.
- Mutation nào cũng vào audit `admin_actions`.

---

## 3. Mở rộng

- **Track event mới**: gọi `track(tgId, "ten_action", {meta})` ở FE — tự hiện trong
  `/api/actions` + `/api/recent`, không cần migration.
- **Metric/chart mới**: thêm 1 aggregation trong `api = {...}` của `server.mjs` (copy shape
  `activity`/`actions`) + 1 `fetch` trong `index.html`.
- **Lưu ý**: `user_actions` không backfill được — data chỉ có từ lúc deploy Phase 1.
  Giờ trong dashboard là **UTC**.

## 4. Deploy

```bash
# VPS
git pull
# .env: thêm DASH_PASSWORD=<openssl rand -hex 12> (DASH_PORT/DASH_BIND mặc định 5050/127.0.0.1)
pm2 restart kol-fe kol-be kol-be-j7    # ăn track() + delivery rollup + payments audit
pm2 start ecosystem.config.cjs --only kol-dash
# máy local: ssh -L 5050:127.0.0.1:5050 <vps> → http://localhost:5050
```

> `npm run migrate` KHÔNG bắt buộc: `connect()` tự `ensureIndexes()` mỗi lần process boot
> (idempotent). Script chỉ hữu ích khi muốn tạo index tường minh + xem thống kê collection
> trước khi chạy — và index analytics đã được tạo trên Atlas từ lúc triển khai.
