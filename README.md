# Obscura Systems — Telegram KOL tracker

Bot Telegram theo dõi hoạt động tài khoản X (mô phỏng `@redactedsystemsbot`), chia làm **2 phần độc lập**, giao tiếp qua **MongoDB Atlas**:

| Phần | Vai trò | Entry |
|---|---|---|
| **FE** (`fe/`) | Bot Telegram: `/start`, `/add`, `/remove`, Settings, Referrals, `/subscribe`. UI/UX theo `docs/bot_build_spec.md`. | `fe/bot.mjs` |
| **BE** (`be/`) | Engine: đọc feed Bloom (research) → normalize → lọc theo settings từng user → **DM** thẳng cho user, format theo `docs/send_like_source.md`. | `be/engine.mjs` |

> Dự án **standalone**, không phụ thuộc `kol-router` (repo riêng). Transport Bloom + format là dữ kiện giao thức nên viết mới tương đương.

## Kiến trúc

```
FE bot (grammy) ──┐                         ┌── users, watches, settings, referrals
                  ├──► MongoDB Atlas ◄──────┤   bloom_accounts, tracked_handles,
BE engine ────────┘                         └── tweet_cache(TTL), deliveries(TTL)

BE engine:
  Bloom Pool (N shard = N session, mỗi shard 1 Chromium context, tap WS đã giải mã)
     │ (mỗi handle được track trên 1 shard qua REST tsunami)
     ▼
  normalize → tweet_cache → Dispatcher → (watchers theo handle) → lọc settings → DM
     ▲
  Tracker Sync: union(watches.handle) ↔ pool; gán shard còn chỗ; untrack khi ref=0;
                re-home handle của shard chết; alert admin khi pool đầy / session hết hạn.
```

## Nguồn dữ liệu (Bloom) phục vụ được gì
Bám research: **14/20** feature Redacted lấy trực tiếp từ feed Bloom (tweets/quotes/retweets/replies,
photos/videos, follows/unfollows, profileChanges/affiliations, deletedTweets, suspensions/deactivations, OCR).
**5 feature Bloom không phát** — `pins/unpins/spaces/trendingTweets/trendingProfiles` — hiển thị ở FE nhưng **bị gate**
(alert "coming soon / customers only"). Chi tiết: `shared/features.mjs`.

## Cài đặt

```bash
npm install
npx playwright install chromium   # tải Chromium khớp version (BE cần browser thật)
cp .env.example .env          # điền BOT_TOKEN, MONGODB_URI, BLOOM_SESSIONS, ADMIN_IDS
npm run migrate               # tạo collection + index (gồm TTL)
npm run seed                  # nạp pool Bloom từ BLOOM_SESSIONS (+ user test nếu set SEED_USER)
```

> `.env` cho phép comment `# ...` sau giá trị (parser tự cắt). Không cần xoá comment ở `.env.example`.

## Chạy

```bash
npm run be     # engine (cần BLOOM_SESSIONS + Chromium; qua quantum PoW nên phải browser thật)
npm run fe     # bot Telegram (long polling)
```

Hoặc 24/7 bằng pm2:
```bash
pm2 start ecosystem.config.cjs   # 2 app: kol-fe, kol-be
pm2 logs
```

## Kiểm thử nhanh (không cần network)

```bash
npm run verify   # render 7 loại tin mẫu, so mắt với docs/send_like_source.md §12
```

## Lệnh bot
| Lệnh | |
|---|---|
| `/start` | menu chính (deep-link: `?start=<tg_id>` referral, `?start=qa+<handle>` QA) |
| `/add <user>` | theo dõi 1 account X (validate qua Bloom, check limit gói) |
| `/remove <user>` | bỏ theo dõi |
| `/subscribe` | nâng Pro (thanh toán **Telegram Stars**) |
| `/grant <tg_id> [days]` | admin cấp Pro tay (test) |

## Cấu trúc
```
shared/   config.mjs · mongo.mjs · repo.mjs (DAL) · settings.mjs (19+1 khoá) · features.mjs · migrate.mjs
be/       engine.mjs · pool.mjs · dispatcher.mjs · tracker-sync.mjs · tweet-cache.mjs · lib/{tsunami,telegram,format}.mjs
fe/       bot.mjs · screens.mjs · xsearch.mjs
scripts/  seed.mjs · verify_format.mjs
docs/     bot_build_spec.md · send_like_source.md · x_account_features.md · ...
```

## Ràng buộc / rủi ro (từ research)
- **Session Bloom hết hạn (~30 ngày):** pool ⇒ suy giảm cục bộ (1 shard chết), alert admin, không sập toàn hệ.
- **Quantum PoW:** mỗi shard = 1 Chromium context ⇒ tốn RAM; giới hạn số shard theo VPS.
- **Cap tracker mỗi account Bloom:** đặt qua `BLOOM_CAPACITY`; reconciler tôn trọng, đầy thì alert.
- **Fan-out lớn:** mỗi event ghi N delivery + query Atlas; ở quy mô lớn nên gộp batch (v2).
- **5 feature bị gate:** Bloom không có nguồn — không hứa.
