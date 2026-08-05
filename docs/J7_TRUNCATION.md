# j7 bị cắt (truncation) — chẩn đoán & giải pháp

Tài liệu gốc rễ vụ **tweet/retweet/quote/delete từ nguồn j7 bị cắt nội dung** (text cụt, thiếu ảnh/video,
đôi khi sai loại) trong khi Bloom render đầy đủ. Áp dụng cho `be-j7/` + `be-core/` (build-bot) và đã sync
sang `j7-kol-router` (single-source).

---

## 1. Triệu chứng

Trên monitor QC thấy cùng 1 tweet, 2 nguồn render KHÁC nhau:

```
[j7 · 🏆 j7]  tweet @elonmusk
📝 elonmusk Tweeted
Can't trust OpenAI https://x.com/ns123abc/status/2084612001221820529     ← CẮT + sai loại (thật ra QUOTE)

[bloom · 🏆 bloom]  quote @elonmusk
💬 elonmusk Quoted ns123abc
Can't trust OpenAI  [card tweet gốc ns123abc + ảnh]                        ← ĐẦY ĐỦ, đúng loại
```

Các dạng đã gặp: retweet text cụt + thiếu media; quote bị nhận nhầm thành `tweet`; note-tweet dài bị cắt
chèn self-link; **delete trống nội dung**.

---

## 2. Bằng chứng (dump payload feed j7 thật)

### 2.1 Tweet gửi 2 PHA
- **Event `tweet`** = snapshot SỚM, THIẾU:
  - `text` bị X cắt: kết thúc `…`/`...`, hoặc chèn `https://x.com/i/web/status/<id>` (note-tweet), hoặc
    kết thúc bằng link tweet được quote `https://x.com/<handle>/status/<id>`.
  - `media` rỗng; đôi khi **sai type** (gửi `TWEET` nhưng thật ra `QUOTE`, `quotedTweet: null`).
- **Event `tweet_update` cờ `isExpandedUpdate: true`** = ĐẦY ĐỦ: full text + media + **đúng type** + `quotedTweet`.

> Cải chính: từng nghĩ "full text không có field nào để đọc" — SAI. Data đầy đủ CÓ, nằm ở `tweet_update`
> mà cả build-bot lẫn j7-kol trước đây đều **DROP** (`if (kind === "update") return`).

### 2.2 Delete có sẵn nội dung — chỉ đọc nhầm field
`tweet_deleted` của j7:
```json
{ "id": "...", "tweet": { "type": "TWEET", "author": {"handle": "..."},
    "body": { "text": "..." },                         // ← NỘI DUNG ở đây (KHÔNG phải tweet.text)
    "media": { "images": ["https://pbs.twimg.com/..."] },
    "retweet": null, "quoted": null }, "deletedTweet": null }
```
`normDelete` cũ đọc `s.text` (undefined) → rỗng. Bloom đầy đủ vì payload compliance của Bloom tự chứa
`tweet_content.text`.

### 2.3 Expansion tới NHANH (đo 150s feed thật)
| Loại | có expansion | delay trung bình | delay tối đa |
|---|---|---|---|
| retweet | 7/17 | 187ms | **315ms** |
| tweet | 62/115 | 247ms | 1610ms (1 ngoại lệ) |
| reply | 45/63 | 171ms | 621ms |

Retweet có video: expansion ~140ms. → `WAIT_MS = 3000` thừa sức bắt.

### 2.4 Đo lại 05-08-2026 (j7-kol-router) — ~19% tweet cắt KHÔNG BAO GIỜ có expansion

2 phiên đo TOÀN feed (script trong `j7-kol-router/scripts/`): `truncation_stats.mjs` (300s) +
`expansion_probe.mjs` (600s, 385 tweet live / 247 expansion):

| (probe 600s, mature ≥30s) | tweet | reply | retweet | quote | tổng |
|---|---|---|---|---|---|
| bị cắt | 121 | 26 | 37 | 1 | 185 |
| miss expansion (đợi đến hết phiên) | 19 | 7 | 8 | 1 | **35 (~19%)** |

- **Delay expansion**: p50 ~145ms; chỉ 4/150 ca >3s, 2 ca >10s, max 20.1s → **nâng `WAIT_MS` chỉ vớt ~2-3%**,
  không giải quyết được 19% miss.
- **Miss CỤM THEO ACCOUNT** (fail cả burst): DHSgov 6 event liên tiếp, EmbamexEUA, GavinNewsom, MarioNawfal,
  Zeneca, CNN, DailyMail, business, kanyewest…
- **KẾT LUẬN**: các tweet này server j7 **không sinh expansion** (enrichment phía nguồn fail theo
  account/burst) — đợi bao lâu cũng không tới. Không tự vá thì nhánh fallback GỬI BẢN CẮT là tất yếu (→ §8).

---

## 3. Giải pháp (đã triển khai)

### 3.1 Buffer 2-pha — `be-j7/expand-buffer.mjs`
Giữ bản cắt tối đa `WAIT_MS` (3000ms), thay bằng expansion khi tới (huỷ bản cắt). Tweet KHÔNG cắt → gửi
NGAY (không trễ). RETWEET **luôn** buffer (bản đầu luôn cụt + media rỗng bất kể form text). `dispatched`
TTL 60s bỏ expansion tới trễ của tweet đã gửi (tránh dup do reclassify type: `tweet:id` ≠ `quote:id`).

### 3.2 engine — `be-j7/engine-j7.mjs` `onEvent`
- `kind === "update"` + `raw.isExpandedUpdate` → `normalizeJ7(raw, "tweet")` → `buf.expanded(ev)`.
- tweet-family LIVE (`tweet/retweet/quote/reply`) → `buf.tweet(ev, raw)`; follow/pin/profile/platform/initial → `dispatch` thẳng.

### 3.3 Nhận diện cắt — `be-core/events.mjs` `J7_TRUNCATED`
```
/…\s*$ | \.\.\.\s*$ | (?:x|twitter)\.com\/i\/web\/status\/ | (?:x|twitter)\.com\/[^\/\s]+\/status\/\d+\s*$/i
```
Dùng CHUNG cho buffer + gate. (Retweet không phụ thuộc regex — buffer theo `kind`.)

### 3.4 normalize — `be-j7/normalize-j7.mjs`
- Retweet: `content = quotedTweet.text || originalTweetText || raw.text` (ưu tiên tweet GỐC hơn bản cắt);
  media `originalMedia || quotedTweet.media`.
- Delete: `content = s.body.text || src.body.text || s.text`; media `s.media`; `isRt` thêm `s.retweet`.

### 3.5 Quality-gate (fallback) — `be-core/dispatch.mjs`
Khi buffer fallback (không có expansion) mà tweet vẫn cắt VÀ Bloom track handle (`getTracked().bloom_account_id`):
BỎ bản j7 → **nhường Bloom** (bản đầy đủ). Bloom không cover → vẫn gửi bản j7 (some > none).

### 3.6 QC monitor
- Event gated hiện GHI CHÚ gọn (không show thân tin cắt): `⤷ j7 bị cắt, đã chặn — Bloom đã gửi bản đầy đủ ✓`.
- `dup ← X` CHỈ khi nguồn KHÁC thắng; twin re-emit cùng nguồn → `🏆` (không `dup ← chính-nó`).

Commit liên quan: `2c3ef3a` (retweet), `63b616e` (buffer), `fa4db7b` (retweet-always + regex), `b845477`
(QC gọn), `cdb924b` (delete), `99aadab` (log), `1f83bc6` (self-dup label).

---

## 4. Đọc log

| Log | Nghĩa |
|---|---|
| `[j7-buf] hold @X reply — đợi expansion (3000ms)` | Buffer giữ tweet cắt, chờ expansion |
| `[j7-buf] @X expansion ✓ -> gửi bản ĐẦY ĐỦ (j7 tự render)` | ✅ **j7 tự render đầy đủ** — kết quả mong muốn |
| `[j7-buf] @X KHÔNG có expansion sau 3000ms -> bản cắt (fallback)` | Không expansion + KHÔNG có fxtwitter fallback → gửi bản cắt |
| `[j7-fx] @X kind không expansion -> fxtwitter ✓ (bản đầy đủ)` | §8: fetch fxtwitter OK → gửi bản đầy đủ (hiện: j7-kol) |
| `[j7-fx] @X kind không expansion, fxtwitter ✗ -> bản cắt (fallback)` | §8: fxtwitter fail → mới gửi bản cắt (hiện: j7-kol) |
| `[j7-gate] tweet cắt @X -> nhường Bloom (không gửi bản j7)` | Gate (build-bot): bỏ bản j7 cắt, Bloom bù |

**Delivery không hỏng** ở mọi nhánh: user luôn nhận bản đầy đủ (j7 tự render hoặc Bloom bù).

---

## 5. Chẩn đoán khi VẪN thấy `[j7-gate]` / `KHÔNG có expansion` nhiều

Code đã đúng (`be-j7/j7feed.mjs` line 40 subscribe `tweet_update`; engine xử lý `isExpandedUpdate`) →
nếu vẫn miss thì do **feed/account phía nguồn**, không phải code. Có 2 mức KHÁC nhau (đừng nhầm):

Đếm để phân loại:
```
pm2 logs kol-be-j7 --lines 1000 --nostream | grep -c "expansion ✓"
pm2 logs kol-be-j7 --lines 1000 --nostream | grep -c "KHÔNG có expansion"
```

| Kết quả | Nguyên nhân | Fix |
|---|---|---|
| `expansion ✓` > 0 (nhiều), fallback ~15-25% | **BÌNH THƯỜNG** — server không sinh expansion cho ~19% tweet cắt (§2.4). Nâng `WAIT_MS` chỉ vớt ~2-3% | fix triệt để → §8 |
| `expansion ✓` = 0, fallback nhiều | Session **không nhận `tweet_update`** | ⬇ |

### Session không nhận `tweet_update`

> **CẢI CHÍNH 05-08-2026** — thực nghiệm `expansion_probe.mjs` (j7-kol-router):
> mở **2 socket CÙNG token** song song 600s → cả 2 nhận **y hệt** 247/247 expansion (`onlyA = onlyB = 0`),
> phase-1 trùng 383/385. Server **broadcast update cho MỌI kết nối** của account.
> Giả thuyết cũ "trùng token → server chỉ đẩy `tweet_update` cho 1 kết nối" là **SAI** — chạy chung token
> không gây miss (sự cố build-bot ngày trước nhiều khả năng do tier account, không phải trùng token).

Nguyên nhân còn lại: **khác tier account** — token thuộc tài khoản không được cấp `tweet_update` →
đổi sang tài khoản có nhận (như account j7-kol đã test: 198 update/200s).

---

## 6. Sync j7-kol-router

j7-kol-router (single-source, gửi channel) đã port: delete `s.body.text`, retweet `quotedTweet.text`,
buffer 2-pha `isExpandedUpdate` (`lib/expand-buffer.mjs` + `router.mjs` tách `emit()`). KHÔNG port:
cross-source dedup / quality-gate nhường-Bloom (j7-kol không có Bloom), monitor firehose.

Quy tắc: sửa phần render/normalize j7 nào thì áp cho **CẢ 2 repo**.

---

## 7. File liên quan
- `be-j7/normalize-j7.mjs` — normTweet (retweet content), normDelete (body.text)
- `be-j7/expand-buffer.mjs` — buffer 2-pha
- `be-j7/engine-j7.mjs` — onEvent xử lý isExpandedUpdate + route buffer
- `be-j7/j7feed.mjs` — subscribe `tweet_update`
- `be-core/events.mjs` — `J7_TRUNCATED` regex (dùng chung)
- `be-core/dispatch.mjs` — quality-gate + monitor QC
- `j7-kol-router/scripts/truncation_stats.mjs` — đo tỉ lệ cắt / expansion / delay trên toàn feed
- `j7-kol-router/scripts/expansion_probe.mjs` — 2 socket cùng token: phân định miss do connection hay do server

---

## 8. Fix TRIỆT ĐỂ — fallback fetch fxtwitter (chốt 05-08-2026 · ✅ j7-kol-router · ⏳ build-bot)

~19% miss là **từ nguồn và vĩnh viễn** (§2.4) → nhánh fallback phải **tự vá** thay vì gửi bản cắt:
hết `WAIT_MS` không có expansion → `GET https://api.fxtwitter.com/status/<id>` → dựng lại event đầy đủ
→ dispatch. fxtwitter lỗi/timeout → gửi bản cắt như cũ (**không tệ hơn hiện tại**).

Đã verify bằng CHÍNH các tweet miss trong phiên đo 05-08-2026:
- tweet @business bị cắt → fxtwitter trả **full text 380 ký tự**;
- retweet @MartinShkreli (j7 cụt + media rỗng) → fxtwitter tự resolve về tweet **GỐC**
  (`author: BrettHarrison`, `reposted_by: MartinShkreli`), full text **3 391 ký tự** (note-tweet);
- API trả đủ `media.photos/videos`, `quote`, `replying_to`, `is_note_tweet` → sửa được text, media
  lẫn **type sai** (tweet→quote).

Tần suất fallback thực đo ~3.5 lần/phút toàn feed — nhẹ với API công khai (repo vốn đã dùng fxtwitter
cho preview). **Trạng thái**: ✅ j7-kol-router (`lib/fxfetch.mjs` + `makeExpandBuffer({ fetchFull })` →
hết `WAIT_MS` gọi `fetchFull(ev)`, fail mới gửi bản cắt); ⏳ **build-bot CHƯA có** —
`be-j7/expand-buffer.mjs` chưa nhận `fetchFull` nên vẫn rơi vào gate/bản-cắt. Cần sync sang build-bot
(quy tắc §6): thêm `be-j7/fxfetch.mjs` + truyền `fetchFull` vào buffer ở `be-j7/engine-j7.mjs`.
