# PAYMENT — Research & Kế hoạch (living doc)

> **Tài liệu sống.** Mỗi lần đụng tới payment (đổi giá, chốt quyết định, code thêm) **cập nhật**:
> (1) mục **Status checklist** §7, (2) mục **Quyết định còn treo** §6 nếu chốt được cái nào,
> (3) thêm 1 dòng vào **Changelog** cuối file. Nguồn gốc: research trong hội thoại (đã đào lại từ transcript).

| | |
|---|---|
| Trạng thái | 🟡 Đã chốt hướng + giá, **CHƯA code** phần crypto (chỉ có Stars/XTR đang chạy) |
| Cập nhật lần cuối | 2026-08-05 |
| Liên quan | [ARCHITECTURE_FE.md](ARCHITECTURE_FE.md) · code hiện tại: `fe/bot.mjs` (`/subscribe`, `successful_payment`), `shared/config.mjs` |
| Đã nối sẵn | Ref points: `repo.awardRefConvert()` + `REF_POINTS_PER_USD` (currency-aware) — xem §8 |

---

## 1. Vấn đề gốc → quyết định dual-payment

**Telegram Stars bị cắt ~35%**: user trả **$9.99** (500⭐) → chỉ nhận **~$6.5** (Apple/Google 30% + phí Telegram).
**Crypto trực tiếp giữ ~100%**. Cả thị trường ngách (X-Alpha, Xanguard, Tweet Catcher) đều nhận crypto.

→ **CHỐT: 2 cổng song song** — **Stars** (tiện, 1-chạm, cho user chưa có ví) + **Crypto** (rẻ hơn ~30% cho user,
mà bạn net bằng/hơn Stars; hợp audience crypto-native).

---

## 2. Bảng giá đã chốt (hybrid: tier nền + pack cộng dồn)

> **v2 (2026-08-05):** Free 3 vĩnh viễn · Pro $15/30 · Whale $40/100 · Stars = USD ×1.3 (+30%). Pack $6 còn đề xuất.

| Gói | Acc | 🪙 Crypto | ⭐ Stars (+30%) | Bạn net crypto | Bạn net Stars |
|---|---|---|---|---|---|
| **Free (TRIAL)** | **5** acc · **3 ngày** (từ /start) | $0 | – | – | – |
| **Pro** ⭐ | **30** | **$15** | ~**1000⭐** (~$20) | ~$15 | ~$13 |
| **Whale** | **100** | **$40** | ~**2600⭐** (~$52) | ~$40 | ~$34 |
| **Pack +10 acc** | +10 | **$6** *(đề xuất, chưa chốt cứng)* | ~**400⭐** (~$8) | ~$6 | ~$5 |
| **Whitelist** | admin | – | – | – | – |

**Đơn giá/acc:** Whale **$0.40** < Pro **$0.50** < Pack **$0.60** — mua sỉ rẻ nhất, cam kết nền vừa, top-up lẻ nhỉnh hơn (chuẩn ladder SaaS).

- **Stars = USD × 1.3** ("nudge" sang crypto; bù một phần ~35% phí nền tảng). Crypto vẫn net > Stars → incentive đúng hướng. Muốn Stars net **bằng** crypto thì ×1.54.
- ⏱ **Đồng hồ:** Free = **TRIAL 5 acc / 3 ngày từ /start** (hết → pause TẤT CẢ watch + báo, /subscribe để tiếp; `/start` hiện thời gian còn lại). Gói trả phí từ **ngày mua** + số ngày (gia hạn STACK, §6.5). Pack one-time tới hết hạn tier (§6.1).
- `account_limit = tier_base + addon_packs×10`. Thêm field `users.addon_packs` (int).
- **Pack breakpoint (pack $6):** cần >~**70 acc** thì lên Whale rẻ hơn (5 pack = $30, Pro+5pack $45 > Whale $40). Pack lo top-up 30–70 acc.
- **Vẫn rẻ áp đảo:** 15–30 KOL rẻ hơn Redacted **50–75%**; 100 acc rẻ **80%**. Đơn giá $0.40–0.60/acc — rẻ nhất thị trường.

**Map config (khi code):**
```
FREE_LIMIT=5            # TRIAL: N acc trong TRIAL_DAYS ngày; TRIAL_DAYS=3
PRO_LIMIT=30            PRO_PRICE_USD=15    PRO_PRICE_STARS=1000
WHALE_LIMIT=100         WHALE_PRICE_USD=40  WHALE_PRICE_STARS=2600
PACK_SIZE=10            PACK_PRICE_USD=6    PACK_PRICE_STARS=400    # đề xuất, chưa chốt cứng
# Stars = USD × 1.3
# expires_at gói trả phí tính từ lần ADD account đầu tiên, KHÔNG phải lúc trả tiền
```

---

## 3. Cơ chế crypto đã chốt: **chỉ Solana · auto-poll + unique-amount**

Rails chốt (v3.2, 2026-08-05): **CHỈ SOLANA**, nhận **3 coin** — **USDC-SPL + USDT-SPL** (stablecoin ≈$1) + **SOL native**.
**Bỏ Tron/ERC20 vì fee thanh toán cao**; Solana phí ~$0, finality nhanh, hợp audience. 1 chain adapter + 1 ví.
Xác minh: **auto-poll RPC + số tiền lẻ duy nhất** (non-custodial, **0% phí bên thứ 3**, giữ 100%).

**3 phương án đã cân — chọn cái đầu:**

| Cách | Auto? | Phí bên thứ 3 | Công sức | Ghi chú |
|---|---|---|---|---|
| ✅ **Auto-poll RPC + unique amount** | tự credit | **0%** | vừa | 1 ví nhận + RPC; match tx theo số lẻ duy nhất/invoice — non-custodial |
| Processor (**NOWPayments**) | webhook | ~0.5% | thấp | hosted invoice, ổn nhất, thêm dependency, no-KYC gói cơ bản |
| Manual `/pay <txhash>` + admin verify | ❌ | 0% | thấp nhất | đơn giản nhưng thủ công, có ma sát |

Ưu tiên **stablecoin (USDC/USDT-SPL)** để giá sub không trôi; SOL native tuỳ chọn (khoá tỉ giá lúc tạo invoice).

---

## 4. Kiến trúc + luồng

**Poller đặt trong FE** (không phải BE): FE tạo invoice, có grammy để nhắn user, **chỉ 1 instance** (ràng buộc 409)
→ **không double-credit**. BE giữ nguyên vai trò engine X.

```
User /subscribe
  → chọn phương thức: [⭐ Stars]  |  [🪙 Crypto (rẻ hơn ~30%)]
  → nếu Crypto: chọn coin (USDC / USDT / SOL) — đều SPL/native trên Solana
  → tạo invoice: gán unique-amount → show địa chỉ + số tiền CHÍNH XÁC + đếm ngược 30'
  → poller dò chain mỗi ~25s → khớp (đúng địa chỉ + đúng số lẻ duy nhất) → credit tier + báo user
```

**Cơ chế unique-amount (mấu chốt auto-match):**
- **USDC / USDT-SPL** (stablecoin ≈$1, 6 decimals): số token = giá USD + số lẻ duy nhất/invoice. Pro $15 → user gửi `15.001`, `15.002`, … (≤999 invoice pending **mỗi coin** — thừa sức). Khớp = đúng địa chỉ + **đúng mint** (phân biệt USDC vs USDT) + đúng số lẻ.
- **SOL native**: số SOL = giá USD ÷ giá SOL hiện tại (khoá 30') + tag lamport duy nhất, match có dung sai nhỏ.
- **Quy đổi & credit theo giá USD gốc**: stablecoin 1:1 USD; SOL = USD ÷ giá SOL (**Jupiter price API**, khoá lúc tạo invoice). Credit tier + ref points **dựa trên `invoice.priceUSD`** (KHÔNG dùng số token thực nhận) → tránh nhiễu số lẻ / trượt giá SOL. Gọi `awardRefConvert({ amount: invoice.priceUSD, currency: coin, chargeId: txSig })`.
- **Idempotency**: lưu tx signature đã khớp → không credit 2 lần.
- **Late grace**: quá 30' vẫn khớp trong **24h** (tx chậm vẫn được cộng), sau đó mới nhả slot.
- **Fallback**: giữ nút `/pay <txhash>` cho ca lệch số / user hỏi.

### 4.1 Unique-amount → định danh ĐÚNG user khi nhiều tx cùng ví

**Vấn đề:** nhiều user trả vào CÙNG ví → 1 ví nhận hàng loạt tx. Làm sao biết tx nào của ai?

**Giải: số tiền = "mã hoá đơn".** Mỗi invoice pending lưu `{tg_id, kind, coin, address(ví), expect_base}`;
`expect_base` (số base-unit) là **DUY NHẤT trong (coin, ví)**. Tx tới ví W, coin C, số = X base-units →
tìm invoice `address=W & coin=C & expect_base=X` → ra ĐÚNG `tg_id` (ai) + `kind` (gói).

Ví dụ (cùng 1 ví, USDC — cùng giá gốc vẫn không lẫn):
| User | Gói | Số phải gửi |
|---|---|---|
| A (tg 111) | Pro | **15.001** |
| B (tg 222) | Pro | **15.002** |
| C (tg 333) | Whale | **40.001** |

→ Tx **15.002** vào ví → chỉ khớp invoice **B** → credit đúng tg 222.

**Đảm bảo:**
- **Không trùng:** lúc tạo invoice, quét mọi invoice pending cùng (coin, ví) → chọn số lẻ CHƯA dùng (1..999). Hết 999 → báo bận (khó chạm; headroom ×số-ví ×3-coin).
- **Khớp chính xác:** so số base-unit **NGUYÊN** (post−pre balance) == `expect_base` → không lệ thuộc float.
- **Trả xong nhả số:** invoice → `paid`, số đó tái dùng cho invoice sau.
- **Chống double-credit:** `claimInvoice` atomic (pending→paid 1 lần) + sig đã `seen` + ref-ledger `c:<sig>`.
- **Nhiều ví:** số chỉ cần unique **trong 1 ví** → 2 ví khác nhau được trùng số (phân biệt bởi ví) → headroom ×số-ví.

**Edge:**
- User gửi **thiếu số lẻ** (vd 15.000) → không khớp invoice nào → không credit → dùng `/pay <sig>` / support. (Màn invoice nhấn mạnh "gửi ĐÚNG số".)
- Trả **quá trễ >24h** (sau grace, số đã bị invoice mới tái dùng) → hiếm, có thể khớp nhầm → xử lý qua `/pay`/support. Trong 24h số vẫn được giữ (invoice còn pending) → an toàn.

---

## 5. File sẽ đụng + env cần điền

| File | Việc |
|---|---|
| `shared/config.mjs` | giá crypto+Stars, địa chỉ nhận, RPC, window/tolerance |
| `shared/repo.mjs` | collection `crypto_invoices` + CRUD + `applyPurchase` |
| **`fe/crypto-pay.mjs`** (mới) | invoice + unique-amount + adapter Solana (Infura RPC) + poller loop + credit |
| `fe/bot.mjs` | `/subscribe` 2 nhánh, chọn coin, invoice pack, start poller lúc boot |
| `fe/screens.mjs` | màn chọn method/coin + màn "gửi X tới địa chỉ Y" |
| `.env.example` | biến mới |

**Env cần cung cấp (hỗ trợ NHIỀU — CSV):** `RECEIVE_SOL_ADDRESS` = 1+ ví nhận (USDC/USDT-SPL + SOL), `addr1,addr2,…` — invoice tự spread sang ví ít pending nhất (tăng headroom unique-amount/ví). `SOLANA_RPC_URL` = 1+ endpoint Infura `https://solana-mainnet.infura.io/v3/<KEY>`, `url1,url2` — **round-robin + failover** (né rate-limit). Key nằm trong URL (không cần biến riêng).
**Mặc định sẽ dùng:** window **30'** hiển thị · match trễ **24h** · poll **~25s** · Solana RPC **Infura** (`getSignaturesForAddress` + `getTransaction` jsonParsed → đọc pre/post token balances match USDC/USDT-SPL/SOL) · giá SOL **Jupiter price API** (khoá lúc tạo invoice) · mint chuẩn: **USDC-SPL** `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` + **USDT-SPL** `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`.

---

## 6. Quyết định còn treo (chốt trước khi code `crypto-pay.mjs`)

1. **✅ Pack — CHỐT: one-time đến hết hạn tier.** Mua 1 lần, +10 acc tới `expires_at` của tier; tier hết hạn/gia hạn → reset `addon_packs=0`, mua lại nếu cần. (Crypto không auto-recur nên one-time là hợp lý.) (2026-08-05)
2. **✅ RPC provider — CHỐT: Infura** (Solana mainnet: `solana-mainnet.infura.io/v3/<key>`). Dùng `getSignaturesForAddress` + `getTransaction(jsonParsed)` để đọc pre/post token balances, tự parse (không cần enriched API kiểu Helius). (2026-08-05)
3. **Ví nhận Solana** — đã có ví chưa (nhận cả USDC-SPL + SOL), hay để placeholder `FILL_ME`? *Chưa chốt.*
4. **✅ Chain crypto — CHỐT: CHỈ SOLANA**, nhận **USDC-SPL + USDT-SPL + SOL native**. Bỏ Tron/ERC20 vì **fee thanh toán cao**. Stablecoin 1:1 USD, SOL quy đổi qua Jupiter (khoá 30'); credit theo `invoice.priceUSD`. (2026-08-05)
5. **✅ Đồng hồ gói trả phí — CHỐT:** mua mới / hết hạn → từ **ngày mua** + số ngày. **Gia hạn khi CÒN hạn → STACK** `max(now, expires_at) + days` (không mất ngày còn lại — học từ ref ETH §11 renewal semantics). Free = không đồng hồ. Bỏ nhánh "từ lần add đầu". (2026-08-05)
6. **✅ Giá pack — CHỐT: $6/+10 acc** (~400⭐). (2026-08-05)

---

## 7. Status checklist (cập nhật mỗi lần code)

- [x] Stars (XTR) — `/subscribe` invoice + `successful_payment` credit Pro. **Đang chạy.**
- [x] Ref points nối sẵn cho crypto (`awardRefConvert` currency-aware, `REF_POINTS_PER_USD`). **Xong (046bdfc).**
- [x] **Phase 1**: Tier Whale + Pack add-on (config + `applyPurchase`/`addon_packs` + FE invoice/callback/screens). **Code xong.**
- [x] **Phase 2**: crypto core — `crypto_invoices` + `fe/crypto-pay.mjs` (invoice unique-amount + poller Infura + match/credit atomic). **Code xong, chờ test live.**
- [x] **Phase 3**: UX wiring — `/subscribe`→method→coin→invoice screen + nudge "crypto better price" (không nêu số) + `/pay <sig>` fallback. **Code xong.**
- [ ] `.env`: điền ví nhận + RPC key (Phase 4 deploy).

---

## 8. Nối với Referral (đã sẵn sàng)

`repo.awardRefConvert(referred, { amount, currency, chargeId })` + `REF_POINTS_PER_USD` **đã ready**.
Khi `crypto-pay.mjs` credit tier xong, gọi thêm:
```js
await repo.awardRefConvert(buyerTgId, { amount: usdValue, currency: "USDC", chargeId: txSignature });
```
→ điểm ref cho thanh toán crypto tự chạy, idempotent theo `c:<txSignature>`. Xem thêm quy tắc điểm trong code
`shared/repo.mjs` (§ ref points) — join +`REF_JOIN_POINTS`, convert +`amount × rate`.

---

## 9. Kế hoạch triển khai (phased)

**Thứ tự:** P1 (Stars tier — ship liền, **không cần secret**) → P2 (crypto core) → P3 (crypto UX) → P4 (test/deploy). P2–P3 cần **ví Solana + Infura key**.

### Phase 1 — Tier restructure qua Stars (không cần secret) — ✅ CODE XONG (chờ test live)
Ship được ngay: Free/Pro/Whale + Pack bằng Stars, **đồng hồ tính từ ngày mua**.
- [x] `shared/config.mjs` + `.env.example`: `PRO_LIMIT=30 PRO_PRICE_STARS=1000 PRO_PRICE_USD=15`, `WHALE_LIMIT=100 WHALE_PRICE_STARS=2600 WHALE_PRICE_USD=40 WHALE_DAYS=30`, `PACK_SIZE=10 PACK_PRICE_STARS=400 PACK_PRICE_USD=6`.
- [x] `shared/repo.mjs`: users field **`addon_packs`** (int=0). `baseLimit(tier)` + `applyPurchase(tgId, kind)`:
  - `pro`/`whale`: set tier + `expires_at = now + days`, `addon_packs=0`, `account_limit = baseLimit(tier)`.
  - `pack`: chỉ khi tier có phí còn hạn (`isActive`) → `addon_packs++`, `account_limit = baseLimit(tier) + addon_packs*PACK_SIZE`.
- [x] `fe/screens.mjs`: `subscribeScreen(user, cfg)` liệt kê **Free/Pro/Whale** + nút mua từng gói + nút Pack.
- [x] `fe/bot.mjs`: `PLANS` + `sendPlanInvoice(ctx, kind)`; callback `buy:pro|buy:whale|buy:pack`; `successful_payment` đọc `invoice_payload` → `applyPurchase` + `awardRefConvert` + reply đúng gói; /add chạm limit → gợi ý Pack/Whale.
- [ ] **Deploy .env**: thêm `WHALE_*`, `PACK_*`, `PRO_PRICE_USD` vào VPS `.env`; chỉnh `FREE_LIMIT`/`PRO_LIMIT`/`PRO_PRICE_STARS` về số chốt nếu muốn (hiện .env đang FREE=15/PRO=40/500⭐). Bật `SUBS_ENABLED=1` khi mở bán.
- [ ] Verify live: Pro→limit 30 + hạn 30d · Pack→+10 (cần tier còn hạn) · Whale→100.

> ✅ **Expiry (trial + gói) — mechanism C, ĐÃ LÀM:** sweep `repo.sweepExpired()` mỗi `EXPIRY_SWEEP_MIN` (60') + boot → user hết hạn (`expires_at<now`, cả **trial Free** lẫn **gói trả phí**) → **PAUSE TẤT CẢ watch (X + platform)** (BE `watchersOfHandle` lọc `paused` → ngừng gửi) + set `expired_notified` + báo (trial vs gói). **Gia hạn** (`applyPurchase`) un-pause + reset `expired_notified` → khôi phục tức thì, không mất dữ liệu. Gate thêm: **`/add` + platform-add chặn nếu `!hasAccess`** (`hasAccess` = trial/gói còn hạn HOẶC Whitelist). Không còn free-forever. accountsScreen đánh dấu ⏸.
> - *Lưu ý:* handle chỉ watch bởi user paused **vẫn được BE track** (pool) — pause chỉ chặn delivery, không untrack (gia hạn = instant). Watch platform (truth/IG) chưa pause (chỉ X). Có thể tối ưu sau.

### Phase 2 — Crypto core `fe/crypto-pay.mjs` (cần ví + Infura) — ✅ CODE XONG (chờ test live)
- [x] `shared/mongo.mjs`: `crypto_invoices` index (`coin`,`status`) + (`status`,`dead_at`); `crypto_seen` TTL 3d.
- [x] `shared/repo.mjs`: `createCryptoInvoice`, `listPendingInvoices`, `pendingExpectBases`, **`claimInvoice`** (pending→paid atomic qua `modifiedCount` = chống double-credit), `expireStaleInvoices`, `sigSeen`/`markSigSeen`.
- [x] `fe/crypto-pay.mjs`:
  - `makeInvoice(tgId, kind, coin)`: `price_usd` theo gói; **matching bằng base-unit nguyên** (không float) — stablecoin `+s×1000` (0.001), SOL `+s×1 lamport`; SOL giá qua Jupiter (khoá). Round-trip display↔base verify OK.
  - Poller ~25s: `getSignaturesForAddress` (Infura) → sig mới (skip `sigSeen`) → `getTransaction(jsonParsed)` → `receivedDeltas` (SOL pre/postBalances + SPL theo **mint** pre/postTokenBalances) → match pending (`expect_base`) → `claimInvoice` (atomic) → `applyPurchase` + `awardRefConvert({amount:price_usd, currency:coin, chargeId:sig})` + notify. Late-grace `dead_at` 24h.
  - `verifyManual(bot, sig)` cho `/pay` fallback (Phase 3 wiring).
- [x] Poller **CHỈ chạy ở FE** (`startPoller(bot)` trước `bot.start`, `running` guard, no-op nếu chưa cấu hình) → no double-credit.

### Phase 3 — Crypto UX + wiring — ✅ CODE XONG
- [x] `fe/screens.mjs`: `paymentMethodScreen` (⭐ Stars / 🪙 Crypto — **nudge "better price", không nêu số**) → `cryptoCoinScreen` (USDC/USDT/SOL) → `cryptoInvoiceScreen` (địa chỉ `<code>` + số tiền chính xác + hạn + gợi ý `/pay`).
- [x] `fe/bot.mjs`: `/subscribe` → `plan:<kind>` (crypto off → Stars thẳng; on → method) → `stars:` / `crypto:` → `pc:<kind>:<coin>` → `makeInvoice` → invoice screen. Poller start lúc boot (Phase 2). `/pay <sig>` → `verifyManual`. Pack (Stars & crypto) chặn khi chưa có tier còn hạn. Nudge chỉ hiện khi `cryptoEnabled`.

### Phase 4 — Test & deploy
- [ ] Test số nhỏ thật mỗi coin: đúng số→credit · sai số lẻ→bỏ · gửi lại tx→không double.
- [ ] Điền `.env` (ví + Infura key), `SUBS_ENABLED=1`, `pm2 restart kol-fe`.

**Rủi ro:** unique-amount ≤999 pending/coin (log nếu chạm) · Infura rate-limit (cache sig) · SOL biến động → credit theo `price_usd` · secrets chỉ ở `.env`.

---

## Appendix A — Research giá đối thủ (định vị thị trường, ~giữa 2026)

Số từ trang bán của từng bên; **có thể đổi** — dùng để định vị, không quote chính xác cho khách.

| Sản phẩm | Mô hình | Giá/tháng | # acc | $/acc | Giao | Payment |
|---|---|---|---|---|---|---|
| **Obscura** ⭐ | tier + pack | **$15** (Pro) / $40 (Whale) | 30 / 100 | **$0.4–0.5** | TG | Stars + crypto (sắp) |
| **Redacted** (bot đang clone) | **per-account, min 5** | **$10** (sàn 5) → $2/acc | 5→∞ | **$2.00** | TG | crypto |
| **X-Alpha** (xfollowtracker) | per-acc bucket | $30 / $70 / $100 / $225 | 5 / 10 / 16 / 40 | ~$6 | TG | crypto (BTC/ETH/USDC/SOL/USDT), no-KYC |
| **X-Relay** | tier | $15 (Lite) / $30 (Solo) / $69 (Pro) | thấp | — | TG+DC | crypto (BTC/ETH/USDT/SOL/TON/LTC), 3d trial |
| **Xanguard** | volume-discount | $19 → $349 (Starter 10 → Enterprise 500; free 1) | 10–500 | $0.7–1.9 | TG | **SOL only**, on-chain confirm |
| **Tweet Catcher** | feature-gate | €70 → €300 (+€30 automation) | — | — | TG+DC | card (Whop) |
| **TweetStream** | flat hi-floor | $199 → $499 (annual $139/$349) | 50–250 | $2–4 | **DC only** (no TG native) | card |
| **TwitGram** | free | $0 | ít | $0 | TG | — |

**Nhận định:** vùng giá "nóng" là **$15–70/tháng** (retail Telegram). **Redacted**: free chỉ **trial 5 acc/24h**,
sau đó **$2/acc, min 5 ($10 sàn)** — KHÔNG có free-forever, phạt power-user (30 KOL = $60). Obscura: **Free 3
vĩnh viễn** + Pro $15/30 ($0.50/acc) → rẻ hơn **50–80%** ở mức dùng thật, và free **bền hơn hẳn** (mãi vs 24h).
Điểm mềm duy nhất: khúc **4–7 acc paid** (sàn $10 Redacted < Pro $15), nhưng Free 3 mãi đã che 1–3 acc.

**4 archetype mô hình giá:** ① per-account tuyến tính (Redacted) · ② tier = bucket account, $/acc phẳng (X-Alpha)
· ③ tier volume-discount, $/acc giảm dần (Xanguard, TweetStream) · ④ feature-gated (TweetStream replay,
Tweet Catcher WebSocket, Xanguard reply-enrichment).

**Đòn bẩy chia tier:** số account · số connection/destination · số keyword/query · enrichment/feature ·
rate-limit/độ trễ · support · add-on module bán rời.

---

## Changelog

- **2026-08-05** — Tạo doc, tổng hợp lại toàn bộ research payment (dual-pay, bảng giá, cơ chế crypto auto-poll unique-amount, kiến trúc, đối thủ) từ transcript. Ghi 4 quyết định còn treo (incl. Tron vs ERC20). Ref-side đã nối sẵn.
- **2026-08-05 (v2)** — Chốt giá mới: **Free 3 vĩnh viễn** · **Pro $15/30** · **Whale $40/100** · **Stars = USD ×1.3 (+30%)** · Pack **$6/+10** (đề xuất). Thêm quy tắc **đồng hồ gói trả phí tính từ lần add account đầu tiên** (§2, §6.5). Cập nhật model Redacted đúng thực tế: free **trial 5 acc/24h**, sau đó **$2/acc min 5 ($10 sàn)** (Appendix A). Điểm mềm 4–7 acc paid được ghi nhận.
- **2026-08-05 (v3)** — Chốt crypto **CHỈ SOLANA** (USDC-SPL chính + SOL native), **bỏ Tron/ERC20 vì fee thanh toán cao**. Đơn giản hoá: 1 chain adapter + 1 ví `RECEIVE_SOL_ADDRESS`; bỏ `RECEIVE_TRON_ADDRESS`/`TRONGRID_API_KEY`. Cập nhật §3/§4/§5/§6.4/§7/§8. §6.4 chuyển từ "treo" → CHỐT.
- **2026-08-05 (v3.1)** — Chốt **RPC provider = Infura** (Solana mainnet `solana-mainnet.infura.io/v3/<key>`), thay Helius. Env: `SOLANA_RPC_URL` (endpoint Infura) + `INFURA_API_KEY`. Dò tx bằng `getSignaturesForAddress`+`getTransaction(jsonParsed)`, tự parse pre/post token balances. §6.2 chuyển "treo" → CHỐT.
- **2026-08-05 (v3.2)** — Nhận **3 coin trên Solana: USDC-SPL + USDT-SPL + SOL**. Quy đổi: stablecoin 1:1 USD; SOL = USD÷giá SOL (Jupiter, khoá 30'). **Credit tier + ref points theo `invoice.priceUSD`** (không dùng số token thực nhận). Match phân biệt theo **mint** (USDC vs USDT). Thêm mint USDT-SPL vào §5. Cập nhật §3/§4/§6.4.
- **2026-08-05 (v3.3)** — Chốt 3 prereq: **Pack one-time đến hết hạn tier** (§6.1); **giá pack $6/+10** (§6.6); **đồng hồ** buyer mới từ lần add đầu / nâng cấp từ ngày payment (§6.5). Tất cả §6 giờ đã CHỐT trừ ví Solana + Infura key (secrets, để `.env`). Sẵn sàng code Phase 1 (Stars tier restructure, không cần secrets).
- **2026-08-05 (v3.4)** — **Đơn giản hoá đồng hồ:** gói trả phí LUÔN tính từ **ngày mua** (bỏ nhánh "từ lần add đầu"). Free vẫn vĩnh viễn (không đồng hồ). → Phase 1 khỏi cần trạng thái pending-start, gọn code hơn.
- **2026-08-05 (code)** — **Phase 1** (2ac1f38, Stars tier Whale+Pack+applyPurchase) · **Phase 2** (4b1318b, crypto core `fe/crypto-pay.mjs`) · **Phase 3** (1a0ecff, UX /subscribe→method→coin→invoice + nudge "better price" + `/pay`). Còn Phase 4 = deploy .env + test live.
- **2026-08-05 (v3.5)** — **NHIỀU ví + NHIỀU RPC** (CSV trong `RECEIVE_SOL_ADDRESS` / `SOLANA_RPC_URL`). RPC round-robin + failover (né rate-limit Infura); invoice spread sang ví ít pending nhất; unique-amount tính theo **(coin, VÍ)** → headroom ×số-ví; match theo (ví + mint + expect_base). `cfg.receiveSolAddress`→`receiveSolAddresses`, `solanaRpcUrl`→`solanaRpcUrls` (list). Bỏ `pendingExpectBases`. Thêm §4.1 giải thích unique-amount định danh user; màn invoice nhấn "số chính xác = cách auto-confirm".
- **2026-08-05 (expiry-downgrade, mechanism C)** — Sweep `downgradeExpired()` (mỗi `EXPIRY_SWEEP_MIN`=60' + boot): gói hết hạn → Free + **pause** watch X vượt `freeLimit` (BE `watchersOfHandle` lọc `paused`), notify. Gia hạn → un-pause (không mất dữ liệu). `countWatches` loại paused; accountsScreen ⏸. Vá lỗ hổng "hết hạn vẫn nhận alert/thêm account".
- **2026-08-05 (PAYMENT_WEBHOOK audit)** — Webhook audit thanh toán RIÊNG (`PAYMENT_WEBHOOK`, tách khỏi `SLACK_WEBHOOK`): bắn **4 sự kiện** kèm **tgId + username** → `paymentHook` (`{text, content}` hợp Slack/Discord/custom): **📝 invoice tạo** (user+kind+coin+số+ví — mục đích chính: nếu auto-credit hỏng vẫn biết AI chờ để `/grant` tay), **✅ crypto PAID** (tx), **✅ Stars PAID**, **⚠️ /pay NO MATCH** (user báo lệch). Trống = tắt.
- **2026-08-05 (RPC health-check)** — Thêm **kiểm tra Infura live/dead**: (1) **boot probe** `getVersion` từng RPC → log ✓live/✗DEAD (che key), alert 🔴 nếu **tất cả dead** / 🟡 nếu **một phần** (Slack + DM admin) → bắt ngay URL sai/key chết thay vì fail âm thầm. (2) **runtime**: RPC fail 3 tick liên tiếp → alert "auto-credit GIÁN ĐOẠN", hồi phục → alert 🟢. `checkRpcHealth()` export (gắn `/admin` được). Trước đó poller fail hoàn toàn im lặng.
- **2026-08-05 (học từ ref ETH PAYMENT_SYSTEM.md)** — Áp dụng 2 điểm họ tự flag ở §10/§11: **(1) gia hạn STACK** thời gian còn lại (`applyPurchase`, §6.5) — tránh cướp ngày người gia hạn sớm. **(2) poller catch-up**: phân trang `getSignaturesForAddress` (before-cursor, limit 100, cap 300) tới khi gặp `sigSeen` → KHÔNG sót payment khi bot down lâu + burst; `sigSeen` bền trong Mongo (TTL 3d) nên **hơn** cursor in-memory của họ (họ reset về head khi restart). Phần còn lại mình đã ngang/hơn: unique-amount **deterministic** (không random-collision như họ), multi-RPC **round-robin+failover** (> time-slice 1 key), `claimInvoice` atomic. Bỏ qua: credits/B1G1 (feature riêng của họ), stats dashboard (tuỳ chọn, để sau).
- **2026-08-05 (Free → TRIAL)** — **ĐẢO** quyết định "Free 3 vĩnh viễn" → **Free = TRIAL 5 acc / 3 ngày** (`FREE_LIMIT=5`, `TRIAL_DAYS=3`), tính từ **/start** (`ensureUser` set `expires_at=now+3d`; Free-null cũ migrate 1 lần lúc /start). Hết trial → `sweepExpired` **pause TẤT CẢ watch** + báo "trial hết hạn" (1 lần, `expired_notified`). `/start` field **Exp hiện thời gian còn lại** (`fmtExp` đổi sang "2d 5h left"). Gate `/add` + platform-add bằng **`hasAccess`** (trial/gói còn hạn hoặc Whitelist). `downgradeExpired`→`sweepExpired` (pause ALL, bỏ "giữ freeLimit" vì không còn free-forever). Gia hạn reset `expired_notified` + un-pause. UI: "Free trial", subscribeScreen "5 acc for 3 days".
