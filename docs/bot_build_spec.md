# Build spec — Telegram bot theo dõi tài khoản X (clone @redactedsystemsbot)

Tài liệu này dùng làm input cho agent để **dựng lại bot**. Mọi chuỗi text, layout bàn
phím và `callback_data` bên dưới là **quan sát thực tế** từ bot gốc, không phải suy đoán.

| | |
|---|---|
| Bot gốc | [@redactedsystemsbot](https://t.me/redactedsystemsbot) |
| Nguồn dữ liệu | crawl 42 màn / 165 liên kết / 230 thao tác — [out/screens.free.json](out/screens.free.json), [out/tree.free.md](out/tree.free.md) |
| Account crawl | tier **Free**, trạng thái **EXPIRED**, 0 account đang theo dõi |
| Định dạng tin thông báo | tài liệu riêng: [send_like_source.md](send_like_source.md) |

> **Đọc mục 10 trước khi bắt đầu.** Crawl chỉ chạm được 3 nút gốc; nhiều luồng quan trọng
> (thêm account, thanh toán, cài đặt riêng từng account) **chưa có dữ liệu** và phải tự
> thiết kế. Đừng coi tài liệu này là đủ để clone 1:1.

---

## 1. Độ phủ thật của dữ liệu

42 màn crawl được thực chất chỉ là **6 màn logic**:

| Màn logic | Id trong crawl | Ghi chú |
|---|---|---|
| Welcome / main menu | #1 | 3 nút |
| Danh sách account (rỗng) | #3 | không nút |
| Referral stats | #5 | 1 nút |
| Global Settings | #7, và #9–#42 (trừ #22) | **34 bản** — cùng một màn, chỉ khác trạng thái toggle |
| Toast điều hướng | #2, #4, #6 | `answerCallbackQuery` không alert |
| Alert chặn | #8, #22 | `answerCallbackQuery(show_alert=true)` |

Nghĩa là: **UI của bot rất nhỏ**. Phần lớn giá trị nằm ở pipeline thông báo, không nằm ở
số lượng màn.

---

## 2. Kiến trúc đề xuất

```
X/Twitter poller ──► normalizer ──► event queue ──► formatter ──► Telegram sender
                                                       │
                                                       └── send_like_source.md
   Bot UI (aiogram / telethon) ──► DB (users, watches, settings)
```

Gợi ý stack: Python + aiogram 3 (hoặc python-telegram-bot 21) + Postgres + Redis queue.
Bot UI và poller nên là 2 process riêng — poller chạy liên tục, UI chỉ phản hồi callback.

---

## 3. Data model

```sql
users (
  tg_id            bigint primary key,
  username         text,
  tier             text default 'Free',      -- Free | Paid tiers
  account_limit    int  default 0,
  expires_at       timestamptz,              -- null/quá khứ => EXPIRED
  referred_by      bigint references users(tg_id),
  points           int  default 0,
  created_at       timestamptz default now()
);

watches (                                    -- account X mà user theo dõi
  tg_id            bigint references users(tg_id),
  handle           text,                     -- không có '@'
  x_user_id        text,
  settings         jsonb,                     -- override; null = dùng preset global
  created_at       timestamptz default now(),
  primary key (tg_id, handle)
);

global_settings (                            -- preset áp cho account MỚI thêm
  tg_id            bigint primary key references users(tg_id),
  ocr              bool default false,
  -- 15 khoá nhóm New Accounts, xem mục 5
  tweets bool default true, quotes bool default true,
  retweets bool default true, replies bool default true,
  follows bool default false, profile_changes bool default true,
  muted bool default false, spaces bool default false,
  deleted_tweets bool default false, photos bool default true,
  videos bool default false, unfollows bool default false,
  pins bool default false, unpins bool default false,
  affiliations bool default false,
  -- 4 khoá nhóm Custom Notifications
  trending_tweets bool default false, trending_profiles bool default false,
  suspensions bool default true, deactivations bool default true
);

referrals (referrer bigint, referred bigint, subscribed bool, primary key (referrer, referred));
```

Giá trị `default` ở trên là **trạng thái thật quan sát được** trên account Free/EXPIRED.

---

## 4. Sơ đồ điều hướng

```
/start ──► #1 Welcome
             ├─ 👀 X accounts     ──► toast "Viewing accounts"      ──► #3 danh sách
             ├─ 👥 Referrals      ──► toast "Viewing Referrals..."  ──► #5 referral
             └─ ⚙️ Global Settings ──► toast "Viewing global settings" ──► #7 settings
                                        ├─ toggle bất kỳ ──► edit tại chỗ, giữ nguyên màn
                                        ├─ OCR           ──► alert "not live yet"
                                        ├─ spaces        ──► alert "customers only"
                                        └─ ⓧ Close       ──► xoá message
```

**Mỗi nút điều hướng phát ra 2 thứ**: một toast (`answerCallbackQuery`) rồi một message
mới. Đây là lý do crawl ghi nhận cả `toast` lẫn `screen` cho cùng một lần bấm.

---

## 5. Schema `callback_data` — phần quan trọng nhất

### Điều hướng

| `callback_data` | Hành động |
|---|---|
| `viewAccounts` | toast `Viewing accounts` + gửi màn danh sách account |
| `referrals` | toast `Viewing Referrals...` + gửi màn referral |
| `globalsettings` | toast `Viewing global settings` + gửi màn settings |
| `close` | xoá message hiện tại |
| `none` | **no-op** — dùng cho nút tiêu đề phân nhóm |

### Toggle setting

```
gs_<key>_<giá_trị_hiện_tại>              nhóm New Accounts
gs_<key>_<giá_trị_hiện_tại>_cn           nhóm Custom Notifications
```

`callback_data` mang **trạng thái ĐANG có**, handler đảo ngược nó:

```python
# gs_tweets_true  → đang bật → tắt đi
# gs_follows_false → đang tắt → bật lên
_, key, cur, *tail = data.split("_")
new = (cur == "false")
group = "cn" if tail == ["cn"] else "new_accounts"
```

Cách này cho phép handler stateless, không cần đọc DB trước khi biết phải set gì. Nhưng
nó **không idempotent**: nếu user bấm 2 lần từ 2 thiết bị trên cùng message cũ thì trạng
thái nhảy sai. Bản clone nên đọc giá trị hiện tại từ DB thay vì tin vào callback, và chỉ
dùng phần `<key>` — đây là chỗ nên làm tốt hơn bot gốc.

### 19 khoá setting

Nhóm **New Accounts** (15) — theo đúng thứ tự hiển thị:

```
tweets  quotes  retweets  replies  follows  profileChanges  muted  spaces
deletedTweets  photos  videos  unfollows  pins  unpins  affiliations
```

Nhóm **Custom Notifications** (4), hậu tố `_cn`:

```
trendingTweets  trendingProfiles  suspensions  deactivations
```

Ngoài nhóm: `OCR` (callback `gs_OCR_false`, hiện chưa hoạt động).

---

## 6. Từng màn — text nguyên văn + bàn phím

> Các dấu `**bold**`, `__italic__`, `` `code` `` dưới đây là cách Telethon **dựng lại**
> entity khi đọc tin. Bot gốc có thể đã gửi bằng HTML hoặc MarkdownV2 — bạn dùng
> `parse_mode` nào cũng được, miễn ra đúng bold/italic/code ở đúng đoạn.

### #1 — Welcome (màn gốc, `/start`)

```
Welcome to Redacted Systems Bot, **{username}** 👋

📊 Your plan:
• Tier: **{tier}**
• Limit: **{limit}** Accounts
• Exp: **{exp}**

Current Accounts Watched:
• __X__: **{n_watched}**

💡 **/add** & **/remove** **<username>** for X

⚠️ Your plan has expired. Please use /subscribe to purchase plan to continue using services.
```

- `{exp}` = `EXPIRED` khi hết hạn, ngược lại là ngày hết hạn.
- Dòng `⚠️` **chỉ hiện khi hết hạn** — có điều kiện.
- Bàn phím 3 hàng × 1 nút:

| Nhãn | callback |
|---|---|
| `👀 X accounts` | `viewAccounts` |
| `👥 Referrals` | `referrals` |
| `⚙️ Global Settings` | `globalsettings` |

### #3 — Danh sách account, trạng thái rỗng

```
You are not watching any accounts yet.
```

Không có nút. **Đây là empty state**; layout khi *có* account chưa crawl được (mục 10).

### #5 — Referral stats

```
👥 **Your Referral Stats**

• Amount: **{n_direct}**
• Indirect: **{n_indirect}**
• Subscribed: **{n_subscribed}**
• Earned: **{points}** Points

**🔗 Tap To Copy Referral Link**
`https://t.me/{bot_username}?start={tg_user_id}`
```

- Link referral bọc trong entity `code` → client Telegram cho tap-to-copy.
- Tham số `start` là **tg user id của người mời**.
- 1 nút: `ⓧ Close` → `close`.

### #7 — Global Settings

```
⚙️ Global Settings ⚙️

🔎 **OCR** ⇢ __Automatically detect SOL & EVM contracts from images__

📨 **Preset For New Accounts** ⇢ __Set default settings for when you add a new account. That way you don't have to manually set these every time!__

⚒ **Custom Notifications** ⇢ __Get trendingProfiles & trendingTweets that are being scanned across thousands of telegram & __

❌ = **Disabled** | Tap to enable/disable a setting.
```

*(Dòng cuối mục `Custom Notifications` bị cắt giữa câu ngay trong bot gốc — `telegram & `
rồi hết. Bản clone nên viết cho trọn nghĩa.)*

Bàn phím **14 hàng / 23 nút**, nhãn = `<key> ✅|❌`:

| Hàng | Nút |
|---|---|
| 1 | `OCR ❌` |
| 2 | `---- New Accounts ----` → `none` |
| 3 | `tweets ✅` · `quotes ✅` |
| 4 | `retweets ✅` · `replies ✅` |
| 5 | `follows ❌` · `profileChanges ✅` |
| 6 | `muted ❌` · `spaces ❌` |
| 7 | `deletedTweets ❌` · `photos ✅` |
| 8 | `videos ❌` · `unfollows ❌` |
| 9 | `pins ❌` · `unpins ❌` |
| 10 | `affiliations ❌` |
| 11 | `---- Custom Notifications ----` → `none` |
| 12 | `trendingTweets ❌` · `trendingProfiles ❌` |
| 13 | `suspensions ✅` · `deactivations ✅` |
| 14 | `ⓧ Close` → `close` |

Quy tắc layout: 2 nút/hàng, nhóm nào lẻ thì nút cuối đứng riêng (`affiliations`). Nút
tiêu đề nhóm chiếm cả hàng.

### #2 / #4 / #6 — Toast điều hướng

`answerCallbackQuery(text=..., show_alert=False)`:

| Nút | Text |
|---|---|
| `👀 X accounts` | `Viewing accounts` |
| `👥 Referrals` | `Viewing Referrals...` |
| `⚙️ Global Settings` | `Viewing global settings` |

### #8 / #22 — Alert chặn

`answerCallbackQuery(text=..., show_alert=True)`:

| Điều kiện | Text |
|---|---|
| Bấm `OCR` | `This feature is not live yet!` |
| Bấm `spaces` (tier Free) | `This selected setting is for customers only` |

---

## 7. Quy tắc UI phải tuân theo

1. **Toggle sửa message tại chỗ.** Bấm setting → `editMessageText` + bàn phím mới trên
   **cùng message**, không gửi message mới. Crawl xác nhận: 34 màn settings phân bố trên
   đúng **17 `msg_id`, mỗi msg_id mang 2 trạng thái khác nhau** — tức mỗi lần crawler mở
   settings rồi bấm 1 toggle, nội dung đổi mà `msg_id` không đổi. 17/17 trường hợp đều vậy.
2. **Nút tiêu đề là nút thật** với `callback_data=none`, không phải text. Handler phải
   `answerCallbackQuery()` rỗng để client không xoay vòng chờ.
3. **Toast cho điều hướng, alert cho việc bị chặn.** Đừng dùng alert cho điều hướng —
   nó chặn UI người dùng.
4. **Trạng thái nằm trong nhãn nút** (`tweets ✅`), không nằm trong text message. Nhờ
   vậy text message là hằng số, chỉ bàn phím thay đổi.
5. **`ⓧ Close` xoá message**, không phải quay lại menu.
6. Bot gốc **không có nút Back** ở màn nào. Muốn về menu phải gõ lại `/start`. Cân nhắc
   thêm — đây là điểm yếu UX của bot gốc.

---

## 8. Pipeline thông báo

Đây là phần tạo ra giá trị thật. Bot đăng vào channel riêng của user, định dạng đã được
đặc tả đầy đủ ở **[send_like_source.md](send_like_source.md)** — 7 loại tin, quy tắc
prefix emoji, URL preview, `invert_media`, entity từng loại, bố cục nút.

Bản đồ từ setting sang loại tin:

| Setting | Loại tin sinh ra (theo send_like_source.md) |
|---|---|
| `tweets` | `📝` Tweeted |
| `retweets` | `🔄` Retweeted |
| `replies` | `🖇️` Replied To |
| `quotes` | `💬` Quoted |
| `deletedTweets` | `🚨🗑️` Deleted Tweet/Retweet |
| `pins` / `unpins` | `📌` / `❌📌` |
| `follows` / `unfollows` | `🦶` / `❌🦶` |
| `photos` / `videos` | bộ lọc media, quyết định prefix `🖼️` / `🎥` |
| `profileChanges`, `muted`, `spaces`, `affiliations`, `suspensions`, `deactivations`, `trending*` | **chưa quan sát được tin mẫu** — xem mục 10 |

Nguồn media cho preview: `d.fxtwitter.com` (video), `pbs.twimg.com` (ảnh),
`fxtwitter.com` (card reply/quote). Không upload file, không dùng media group.

---

## 9. Lệnh

| Lệnh | Trạng thái dữ liệu |
|---|---|
| `/start` | ✅ đã có màn #1. Nhận param: `?start=<tg_id>` (referral), `?start=<channel_id>`, `?start=qa+<handle>` |
| `/add <username>` | ❌ chỉ biết là tồn tại (nhắc trong màn #1) |
| `/remove <username>` | ❌ chỉ biết là tồn tại |
| `/subscribe` | ❌ chỉ biết là tồn tại |

---

## 10. Phần PHẢI tự thiết kế — crawl không chạm tới

Liệt kê rõ để agent không tưởng là đã đủ:

| Thiếu | Lý do |
|---|---|
| Luồng `/add` — hỏi handle, validate, báo vượt limit | account crawl có limit = 0 |
| Màn danh sách account khi **có** account, cài đặt riêng từng account | chỉ crawl được empty state |
| Luồng `/subscribe` — bảng giá, thanh toán, xác nhận | không crawl (nút mua bị bỏ qua có chủ đích) |
| Nút `deletedTweets` | bị regex an toàn của crawler chặn (nhãn chứa "deleted") |
| Toàn bộ UI của tier trả phí | account crawl là Free/EXPIRED |
| Mẫu tin cho `profileChanges`, `muted`, `spaces`, `affiliations`, `suspensions`, `deactivations`, `trendingTweets`, `trendingProfiles` | 400 tin channel mẫu không chứa loại nào trong số này |
| Xử lý lỗi: handle không tồn tại, account private, rate limit của X | không quan sát được |
| Nguồn dữ liệu X | bot gốc dùng gì để lấy tweet realtime là hộp đen |

Muốn bù các khoảng trống này: chạy lại crawler bằng account **đã trả phí và có account
đang theo dõi**, rồi diff hai file JSON:

```bash
python3 app.py --label paid --probe-errors --sample-file ~/anh.jpg
```

---

## 11. Checklist triển khai

- [ ] DB schema mục 3, seed đúng giá trị default ở mục 5
- [ ] `/start` render màn #1 với dòng `⚠️` có điều kiện theo `expires_at`
- [ ] Router callback theo schema mục 5, có nhánh `none` trả `answerCallbackQuery()` rỗng
- [ ] Toggle đọc trạng thái **từ DB** rồi đảo, không tin `callback_data` (khác bot gốc, có lý do)
- [ ] Settings render 14 hàng đúng thứ tự mục 6, nhãn `<key> ✅|❌`
- [ ] Toggle dùng `editMessageText`, giữ nguyên `msg_id`
- [ ] Gating: alert `customers only` cho setting trả phí, `not live yet` cho tính năng chưa xong
- [ ] `close` xoá message
- [ ] Referral: link `?start=<tg_id>`, entity `code` để tap-to-copy, ghi bảng `referrals`
- [ ] Poller X + formatter theo [send_like_source.md](send_like_source.md)
- [ ] Lọc event theo `watches.settings` (fallback `global_settings`)
- [ ] Thêm nút Back (bot gốc không có — nên có)
