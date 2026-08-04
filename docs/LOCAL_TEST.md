# Test local an toàn (không đụng prod)

Prod (VPS) dùng chung **3 tài nguyên**. Test local phải tách để **không ảnh hưởng**:

| Tài nguyên | Nếu dùng chung | Cách tách khi test |
|---|---|---|
| **BOT_TOKEN** (Telegram) | 2 instance cùng token → **lỗi 409**; BE gửi **DM user thật** | **Bot test riêng** (tạo qua @BotFather) |
| **MongoDB** (`redacted_clone`) | Ghi đè watches/users/deliveries prod | **DB test riêng**: `MONGODB_DB=obscura_test` (cùng cluster Atlas, khác namespace → prod nguyên vẹn) |
| **Session Bloom / j7** | 2 BE cùng session → gửi noti 2 lần; tracker-sync có thể **untrack nhầm** account prod | **KHÔNG chạy Bloom/j7 thật ở local** — dùng injector event giả |

> Mẹo: `env` **thắng** `.env` (config nạp .env chỉ khi biến chưa có trong process.env) → chỉ cần đặt biến ở đầu lệnh, **không sửa file .env**.

---

## Bước 1 — Bot test + DB test

1. Tạo bot test: @BotFather → `/newbot` → lấy `TEST_TOKEN`. Nhắn `/start` cho bot test 1 lần (để nó chat được với bạn) + lấy `tg_id` của bạn (vd qua @userinfobot).
2. Migrate + tạo index cho DB test:
   ```bash
   MONGODB_DB=obscura_test npm run migrate
   ```

## Bước 2 — Chạy FE (bot) local

```bash
MONGODB_DB=obscura_test BOT_TOKEN=<TEST_TOKEN> ADMIN_IDS=<tg_id_bạn> SUBS_ENABLED=0 npm run fe
```
→ mở bot test trên Telegram: test `/start`, `/add elonmusk`, ⚙️ Settings, 🟣 Truth / 📸 Instagram picker… **Toàn bộ UI, zero rủi ro prod.**

Muốn picker Truth/IG có account để chọn (khi chưa chạy j7):
```bash
MONGODB_DB=obscura_test node scripts/inject_event.mjs seed-platlist
```

## Bước 3 — Test DELIVERY (noti) mà KHÔNG cần Bloom/j7

Injector bơm event **giả** qua dispatcher thật → bot test **DM bạn** (test render + lọc settings + dedup):

```bash
# seed nhanh 1 user (bạn) + watch
MONGODB_DB=obscura_test node scripts/inject_event.mjs seed-user <tg_id> elonmusk,cz_binance

# bơm noti (dùng CÙNG BOT_TOKEN test để DM về đúng bot)
MONGODB_DB=obscura_test BOT_TOKEN=<TEST_TOKEN> node scripts/inject_event.mjs tweet elonmusk "Hello test"
MONGODB_DB=obscura_test BOT_TOKEN=<TEST_TOKEN> node scripts/inject_event.mjs reply elonmusk kane "@kane hi"
MONGODB_DB=obscura_test BOT_TOKEN=<TEST_TOKEN> node scripts/inject_event.mjs platform truth realdonaldtrump "Big news"
```
> Nhớ ở bot test: bật ⚙️ setting tương ứng (tweets/replies…) và với Truth/IG phải **Enable + follow** account đó thì mới nhận.

---

## An toàn
- Injector **từ chối chạy nếu `MONGODB_DB=redacted_clone`** (prod) — trừ khi `ALLOW_PROD=1` (đừng dùng khi test).
- **KHÔNG** đặt `BOT_TOKEN` prod khi test (sẽ DM user thật + 409 với FE VPS).
- **KHÔNG** chạy `npm run be` / `be-j7` ở local với session prod (double-dispatch + rủi ro untrack). Nếu cần feed thật ở local: dùng **session Bloom/j7 riêng** + `SOURCE_EXCLUSIVE=0` + DB test.

## Monitor firehose — verify merge 2 BE (Bloom + j7)

1 channel nhận **MỌI event** (bỏ qua settings/watcher) từ **cả 2 BE**, kèm **race-outcome** (nguồn tới trước 🏆, sau `dup ←`). Dùng để soi merge trước khi tin ở prod. **Trống `MONITOR_CHAT` = TẮT** (prod không đụng).

**Chuẩn bị:**
1. Tạo **channel test** → add **bot test** làm **admin** → **post 1 tin** trong channel.
2. Lấy chat_id: `BOT_TOKEN=<TEST> node scripts/chat_id.mjs` → copy id channel (số âm, `-100…`).

**Chạy BE local với monitor** (test DB + monitor + KHÔNG untrack prod):
```bash
# nhẹ, thử trước: chỉ j7
MONGODB_DB=obscura_test BOT_TOKEN=<TEST> MONITOR_CHAT=<-100…> \
  J7_SESSION_TOKEN=<token> SOURCE_EXCLUSIVE=0 npm run be-j7

# đầy đủ merge: thêm Bloom (nặng — cần Chromium/PoW)
MONGODB_DB=obscura_test BOT_TOKEN=<TEST> MONITOR_CHAT=<-100…> \
  BLOOM_SESSIONS=<token> SOURCE_EXCLUSIVE=0 npm run be
```

**Đọc channel:** mỗi dòng `[nguồn · 🏆/dup] kind @handle` + full render. Verify:
- Cả `[bloom]` lẫn `[j7]` xuất hiện → 2 nguồn chạy.
- Cùng `tweetId` từ 2 nguồn → so timestamp = latency race; `🏆` vs `dup ←` = dedup đúng.
- pins/unpins chỉ `[j7]`, verified/edit chỉ `[bloom]`, Truth/IG `[j7]`.
- Đối chiếu `deliveries.source` (user chỉ nhận 1 lần) ↔ channel (thấy cả 2) → cross-source dedup OK.

> ⚠️ Injector cũng đi qua hook này → `MONITOR_CHAT=<id> node scripts/inject_event.mjs …` bơm cả vào monitor (source=`test`). Dùng để test format nhanh không cần feed thật.
> ⚠️ `SOURCE_EXCLUSIVE=0` bắt buộc khi dùng session chung prod (chỉ observe+add, KHÔNG untrack). Sạch nhất: session Bloom/j7 riêng cho test.

## Dọn DB test
```bash
# xoá hẳn DB test khi xong (mongosh) — KHÔNG đụng redacted_clone
mongosh "<MONGODB_URI>" --eval 'db.getSiblingDB("obscura_test").dropDatabase()'
```
