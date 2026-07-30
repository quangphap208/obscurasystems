# Bloom vs Redacted Bot — đối chiếu feature theo dõi tài khoản X

So [x_account_features.md](x_account_features.md) (20 feature của [@redactedsystemsbot](https://t.me/redactedsystemsbot))
với những gì **Bloom** (`bloombot.app` tracker) support.

Nguồn cho cột Bloom: event WS thật đã reverse (frame `tweet` + `data.type`, `activity`,
`compliance`, `enrichment`) trong [../reverse-engineering/pretty/](../reverse-engineering/pretty/)
và `locale_en.json`.

**Kết luận nhanh:** Bloom cover **~15/20**. Thiếu 5 (pins, unpins, spaces, trendingTweets,
trendingProfiles). Mạnh hơn ở profile changes / edits / compliance / **OCR + CA detection**.

---

## Bảng đối chiếu

| # | Feature Redacted | Bloom | Cơ chế / event trong Bloom |
|---|---|:---:|---|
| 1 | `tweets` | ✅ | frame `tweet`, `data.type=TWEET` |
| 2 | `quotes` | ✅ | `data.type=QUOTE` |
| 3 | `retweets` | ✅ | `data.type=RETWEET` (body lấy từ `parent_tweet.text`) |
| 4 | `replies` | ✅ | `data.type=REPLY` |
| 5 | `follows` | ✅ | activity `follow.follow` — pref `follow_events` |
| 6 | `unfollows` | ✅ | activity `follow.unfollow` |
| 7 | `pins` | ❌ | **không có** event pin |
| 8 | `unpins` | ❌ | **không có** |
| 9 | `deletedTweets` | ✅ | compliance `delete` — cache `tweet_content`, pref `edit_delete_events` |
| 10 | `photos` | ✅ | `data.media.images` (URL `pbs.twimg.com`) |
| 11 | `videos` | ✅ | `data.media.videos` |
| 12 | `profileChanges` | ✅✅ | **chi tiết hơn** — 9 loại `profile.update.*`: `bio, screenname, handle, profile_picture, banner_picture, url, geo, verified_badge, affiliate_badge` |
| 13 | `muted` | ⚠️ | Bloom có mute **cục bộ** (ẩn thông báo / `Muted` badge) — KHÁC với "account mute người khác" |
| 14 | `spaces` | ❌ | **không** theo dõi X Spaces |
| 15 | `affiliations` | ✅ | activity `profile.update.affiliate_badge` |
| 16 | `suspensions` | ✅ | compliance `user_suspend` / `user_unsuspend` |
| 17 | `deactivations` | ✅ | compliance `user_delete` / `user_undelete` (account deleted/restored) |
| 18 | `trendingTweets` | ❌ | **không** quét telegram channels |
| 19 | `trendingProfiles` | ❌ | **không** |
| 20 | `OCR` | ✅ **hơn** | Bloom **đã chạy** `useOcr` — *"Bloom uses OCR to automatically detect contracts from images"*. Redacted còn *"not live yet"* |

Tổng: **15 ✅ · 1 ⚠️ · 4 ❌** (pins, unpins, spaces, trending×2 → 5 khoá không có).

---

## Bloom KHÔNG có

| Feature | Vì sao / ghi chú |
|---|---|
| `pins` / `unpins` | Không có event pin tweet trong feed Bloom |
| `spaces` | Không có endpoint X Spaces (chỉ thấy CSS `break-spaces`) |
| `trendingTweets` / `trendingProfiles` | Cần hạ tầng quét hàng nghìn channel Telegram — Bloom không làm (Redacted cũng nặng nhất ở đây) |
| `muted` (đúng nghĩa) | Bloom chỉ mute cục bộ, không phát hiện account mute người khác |

## Bloom CÓ THÊM (list Redacted không có)

| Feature | Event Bloom |
|---|---|
| Sửa tweet | compliance `tweet_edit` |
| Tweet ẩn / gỡ / khôi phục | `withheld` / `drop` / `undrop` |
| Account khoá riêng tư | `user_protect` / `user_unprotect` |
| Account bị withheld theo vùng | `user_withheld` |
| Xoá dữ liệu location | `scrub_geo` |
| Đổi verified badge | `profile.update.verified_badge` |
| **Enrichment + CA scanner + auto-buy** | `enrichment` event + task `caScanner` (*"Buys any contract address found in a tracked account's tweets"*) — vượt khỏi "notification", là phần trading lõi |

---

## Đánh giá

- **Core (đăng bài 1–4 + media 10–11):** cả hai đủ → chiếm 385/400 tin channel mẫu. Bloom cân hết.
- **Bloom yếu hơn:** pin/unpin, spaces, trending (2 cái này cần hạ tầng riêng).
- **Bloom mạnh hơn:** profile changes chi tiết (9 loại), tweet edits, compliance đầy đủ (protect/withheld/geo), và **OCR + CA detection đang hoạt động** — thứ Redacted còn nợ.
- Nếu mục tiêu là **trading theo KOL**, Bloom phù hợp hơn (có sẵn CA scan + OCR + auto-buy).
  Nếu mục tiêu thuần **social monitoring** (pin/spaces/trending), Redacted phủ rộng hơn ở nhánh đó.
