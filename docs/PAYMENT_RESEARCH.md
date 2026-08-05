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

| Gói | Acc | Crypto | Stars | Bạn nhận (crypto) | Bạn nhận (Stars) |
|---|---|---|---|---|---|
| **Free** | 3 | – | – | – | – |
| **Pro** ⭐ | 25 | **$7** | 500⭐ ($9.99) | ~$6.9 | ~$6.5 |
| **Whale** | 100 | **$17** | 1200⭐ (~$24) | ~$16.8 | ~$15.6 |
| **Pack +10 acc** | +10 | **$4** | 300⭐ (~$6) | ~$3.9 | ~$3.9 |
| **Whitelist** | admin | – | – | – | – |

- Crypto rẻ hơn user **~30%** nhưng bạn **net bằng/hơn** Stars → win-win (bên "mất" là phí nền tảng Telegram).
- Đòn bẩy mạnh nếu muốn: hạ crypto Pro xuống **$6.5** (= net Stars) → user tiết kiệm **35%**, bạn không thiệt.
- `account_limit = tier_base + addon_packs×10`. Thêm field `users.addon_packs` (int).
- Pack **cố tình đắt hơn/acc** để đẩy user lên Whale khi cần nhiều: breakpoint sạch ở **>45 acc** (2 pack = $18 ≈ Whale $19 mà chỉ 45 vs 100 acc). Pack dành cho top-up nhỏ 10–30 acc.
- **Vẫn rẻ áp đảo**: kể cả pack đắt nhất ($0.5/acc) vẫn rẻ hơn Redacted $2/acc (4×), X-Alpha ~$6/acc (12×), Xanguard $0.7–1.9/acc (1.4–3.8×).

**Map config (khi code):**
```
FREE_LIMIT=3
PRO_LIMIT=25          PRO_PRICE_STARS=500    PRO_PRICE_USD=7
WHALE_LIMIT=100       WHALE_PRICE_STARS=1200 WHALE_PRICE_USD=17   (tier mới)
PACK_SIZE=10          PACK_PRICE_STARS=300   PACK_PRICE_USD=4     (add-on mới)
```

---

## 3. Cơ chế crypto đã chốt: **multi-coin · auto-poll + unique-amount**

Rails chốt: **USDC-SOL + USDT-TRC20 + SOL native**. Xác minh: **auto-poll RPC + số tiền lẻ duy nhất**
(non-custodial, **0% phí bên thứ 3**, giữ 100%).

**3 phương án đã cân — chọn cái đầu:**

| Cách | Auto? | Phí bên thứ 3 | Công sức | Ghi chú |
|---|---|---|---|---|
| ✅ **Auto-poll RPC + unique amount** | tự credit | **0%** | vừa | 1 ví nhận + RPC; match tx theo số lẻ duy nhất/invoice — non-custodial |
| Processor (**NOWPayments**) | webhook | ~0.5% | thấp | hosted invoice, ổn nhất, thêm dependency, no-KYC gói cơ bản |
| Manual `/pay <txhash>` + admin verify | ❌ | 0% | thấp nhất | đơn giản nhưng thủ công, có ma sát |

Coin nên là **stablecoin (USDC/USDT)** để giá sub không trôi; **Solana** hợp audience (phí ~$0, finality nhanh).

---

## 4. Kiến trúc + luồng

**Poller đặt trong FE** (không phải BE): FE tạo invoice, có grammy để nhắn user, **chỉ 1 instance** (ràng buộc 409)
→ **không double-credit**. BE giữ nguyên vai trò engine X.

```
User /subscribe
  → chọn phương thức: [⭐ Stars]  |  [🪙 Crypto (rẻ hơn ~30%)]
  → nếu Crypto: chọn coin (USDC-SOL / USDT-TRON / SOL)
  → tạo invoice: gán unique-amount → show địa chỉ + số tiền CHÍNH XÁC + đếm ngược 30'
  → poller dò chain mỗi ~25s → khớp (đúng địa chỉ + đúng số lẻ duy nhất) → credit tier + báo user
```

**Cơ chế unique-amount (mấu chốt auto-match):**
- **Stablecoin** (USDC/USDT, 6 decimals): giá gốc + số lẻ duy nhất/invoice. Pro $7 → user gửi `7.001`, `7.002`, … (≤999 invoice pending/coin cùng lúc — thừa sức). Khớp = đúng địa chỉ + đúng số lẻ.
- **SOL native**: khoá tỉ giá $→SOL lúc tạo invoice (giữ 30') + tag lamport duy nhất, match có dung sai nhỏ.
- **Idempotency**: lưu tx signature đã khớp → không credit 2 lần.
- **Late grace**: quá 30' vẫn khớp trong **24h** (tx chậm vẫn được cộng), sau đó mới nhả slot.
- **Fallback**: giữ nút `/pay <txhash>` cho ca lệch số / user hỏi.

---

## 5. File sẽ đụng + env cần điền

| File | Việc |
|---|---|
| `shared/config.mjs` | giá crypto+Stars, địa chỉ nhận, RPC, window/tolerance |
| `shared/repo.mjs` | collection `crypto_invoices` + CRUD + `applyPurchase` |
| **`fe/crypto-pay.mjs`** (mới) | invoice + unique-amount + adapter Solana/Tron + poller loop + credit |
| `fe/bot.mjs` | `/subscribe` 2 nhánh, chọn coin, invoice pack, start poller lúc boot |
| `fe/screens.mjs` | màn chọn method/coin + màn "gửi X tới địa chỉ Y" |
| `.env.example` | biến mới |

**Env cần cung cấp:** `RECEIVE_SOL_ADDRESS`, `RECEIVE_TRON_ADDRESS`, `SOLANA_RPC_URL` (+Helius key), `TRONGRID_API_KEY`.
**Mặc định sẽ dùng:** window **30'** hiển thị · match trễ **24h** · poll **25s/chain** · Solana RPC **Helius** (parsed tx) · Tron **TronGrid** · giá SOL **Jupiter price API** (khoá lúc tạo invoice) · contract mặc định USDC-SPL mint chuẩn + USDT-TRC20 `TR7NHq…` chuẩn.

---

## 6. Quyết định còn treo (chốt trước khi code `crypto-pay.mjs`)

1. **Pack recurring hay one-time** — khuyến nghị **one-time đến hết hạn tier** (đơn giản, dễ hiểu) cho v1. *Chưa chốt.*
2. **RPC provider** — Helius (SOL) + TronGrid (Tron) ok, hay endpoint riêng? *Chưa chốt.*
3. **2 ví nhận** (SOL + Tron) — đã có chưa, hay để placeholder `FILL_ME`? *Chưa chốt.*
4. **⚡ Tron vs ERC20** — research cũ chốt **Tron (USDT-TRC20)**; user (2026-08-05) nhắc *"usdt sol hoặc erc20"*.
   Nếu muốn **ERC20 (Ethereum)** thay/thêm Tron → cần adapter chain thứ 3 (gas cao hơn, finality chậm hơn Tron/SOL).
   **Cần chốt: Tron hay Ethereum (hay cả 2)** cho nhánh USDT. *Chưa chốt.*

---

## 7. Status checklist (cập nhật mỗi lần code)

- [x] Stars (XTR) — `/subscribe` invoice + `successful_payment` credit Pro. **Đang chạy.**
- [x] Ref points nối sẵn cho crypto (`awardRefConvert` currency-aware, `REF_POINTS_PER_USD`). **Xong (046bdfc).**
- [ ] Tier Whale + Pack add-on (config + FE invoice + callback + screens).
- [ ] `shared/repo.mjs`: collection `crypto_invoices` + `applyPurchase`.
- [ ] `fe/crypto-pay.mjs`: invoice unique-amount + adapter Solana/Tron(/ERC20?) + poller + credit.
- [ ] `fe/bot.mjs`: `/subscribe` 2 nhánh + chọn coin + pack invoice + start poller lúc boot.
- [ ] `fe/screens.mjs`: màn method/coin + màn "gửi X tới địa chỉ Y".
- [ ] `.env`: điền ví nhận + RPC keys.
- [ ] `/pay <txhash>` fallback thủ công.

---

## 8. Nối với Referral (đã sẵn sàng)

`repo.awardRefConvert(referred, { amount, currency, chargeId })` + `REF_POINTS_PER_USD` **đã ready**.
Khi `crypto-pay.mjs` credit tier xong, gọi thêm:
```js
await repo.awardRefConvert(buyerTgId, { amount: usdValue, currency: "USDT", chargeId: txSignature });
```
→ điểm ref cho thanh toán crypto tự chạy, idempotent theo `c:<txSignature>`. Xem thêm quy tắc điểm trong code
`shared/repo.mjs` (§ ref points) — join +`REF_JOIN_POINTS`, convert +`amount × rate`.

---

## Appendix A — Research giá đối thủ (định vị thị trường, ~giữa 2026)

Số từ trang bán của từng bên; **có thể đổi** — dùng để định vị, không quote chính xác cho khách.

| Sản phẩm | Mô hình | Giá/tháng | # acc | $/acc | Giao | Payment |
|---|---|---|---|---|---|---|
| **Obscura** ⭐ | flat + cap | **~$8** (Pro) | 25–30 | **$0.3** | TG | Stars (+crypto sắp có) |
| **Redacted** (bot đang clone) | **per-account** | — | ∞ | **$2.00** | TG | crypto |
| **X-Alpha** (xfollowtracker) | per-acc bucket | $30 / $70 / $100 / $225 | 5 / 10 / 16 / 40 | ~$6 | TG | crypto (BTC/ETH/USDC/SOL/USDT), no-KYC |
| **X-Relay** | tier | $15 (Lite) / $30 (Solo) / $69 (Pro) | thấp | — | TG+DC | crypto (BTC/ETH/USDT/SOL/TON/LTC), 3d trial |
| **Xanguard** | volume-discount | $19 → $349 (Starter 10 → Enterprise 500; free 1) | 10–500 | $0.7–1.9 | TG | **SOL only**, on-chain confirm |
| **Tweet Catcher** | feature-gate | €70 → €300 (+€30 automation) | — | — | TG+DC | card (Whop) |
| **TweetStream** | flat hi-floor | $199 → $499 (annual $139/$349) | 50–250 | $2–4 | **DC only** (no TG native) | card |
| **TwitGram** | free | $0 | ít | $0 | TG | — |

**Nhận định:** vùng giá "nóng" là **$15–70/tháng** (retail Telegram). Redacted **$2/acc** phạt power-user
(15 KOL = $30). Obscura flat ~$8 ở **$0.3/acc** → rẻ nhất bảng, feature ngang X-Relay/X-Alpha.

**4 archetype mô hình giá:** ① per-account tuyến tính (Redacted) · ② tier = bucket account, $/acc phẳng (X-Alpha)
· ③ tier volume-discount, $/acc giảm dần (Xanguard, TweetStream) · ④ feature-gated (TweetStream replay,
Tweet Catcher WebSocket, Xanguard reply-enrichment).

**Đòn bẩy chia tier:** số account · số connection/destination · số keyword/query · enrichment/feature ·
rate-limit/độ trễ · support · add-on module bán rời.

---

## Changelog

- **2026-08-05** — Tạo doc, tổng hợp lại toàn bộ research payment (dual-pay, bảng giá, cơ chế crypto auto-poll unique-amount, kiến trúc, đối thủ) từ transcript. Ghi 4 quyết định còn treo (incl. Tron vs ERC20). Ref-side đã nối sẵn.
