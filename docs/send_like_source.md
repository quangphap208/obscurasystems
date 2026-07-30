# Spec định dạng tin của channel "Redacted Bot"

Tài liệu để một channel khác hiển thị **giống y hệt** channel `-1002422752661`
(*Elon, Vitalik & CZ Tweet Alerts*, sinh bởi [@redactedsystemsbot](https://t.me/redactedsystemsbot)).

Suy ra từ **400 tin thật**, id `55405`–`55804`, đọc ngày 2026-07-30.
Bản cài đặt chạy được: [send_like_source.py](send_like_source.py) — mọi con số dưới đây đều
có selftest đối chiếu với tin gốc (`python3 send_like_source.py --dry-run`).

---

## 1. Khung chung

```
<PREFIX> <author> <ACTION> <target>
<SEP><nội dung tweet>
```

| Loại | SEP |
|---|---|
| Replied To · Quoted · Retweeted · Pinned · unPinned | `\n\n` |
| Tweeted · Deleted · followed · Unfollowed | `\n` |

---

## 2. Bảy loại tin

| # | Loại | Prefix | Số tin /400 | Dòng đầu |
|---|---|---|---|---|
| 1 | Replied To | `🖇️` | 156 | `🖇️ elonmusk Replied To kane` |
| 2 | Retweeted | `🔄` | 112 | `🔄 elonmusk Retweeted ZiaYusufUK` |
| 3 | Quoted | `💬` | 81 | `💬 elonmusk Quoted PeterDiamandis` |
| 4 | Tweeted | `📝` | 36 | `🎥📝 elonmusk Tweeted` |
| 5 | followed / Unfollowed | `🦶` / `❌🦶` | 7 | `🦶 elonmusk followed dhh` |
| 6 | Deleted Tweet/Retweet | `🚨🗑️` | 4 | `🖼️🚨🗑️ Deleted Tweet from cz_binance` |
| 7 | Pinned / unPinned | `📌` / `❌📌` | 4 | `📌 elonmusk Pinned Reply To brivael` |

Tổng đúng 400, không có tin nào ngoài 7 loại này.

---

## 3. PREFIX = media indicator + action indicator

Media indicator đứng **trước**, action indicator đứng **sau**:

| Ký hiệu | Nghĩa |
|---|---|
| `🖼️` × N | tweet có N ảnh — quan sát được tới `🖼️🖼️🖼️🖼️` (4 ảnh) |
| `🎥` | tweet có video hoặc gif (luôn chỉ 1) |
| `📝` | Tweeted — tweet gốc của chính tài khoản |
| `🔄` | Retweeted |
| `🖇️` | Replied To |
| `💬` | Quoted |
| `🚨🗑️` | Deleted |
| `📌` / `❌📌` | Pinned / unPinned Reply To |
| `🦶` / `❌🦶` | followed / Unfollowed |

Ví dụ ghép: `🖼️🖼️🔄` = retweet kèm 2 ảnh · `🎥📝` = tweet gốc kèm video.

Phân bố thật: `🖇️`154 · `💬`81 · `🔄`40 · `🎥🔄`35 · `🖼️🔄`31 · `🎥📝`26 · `📝`7 ·
`🦶`6 · `🖼️🚨🗑️`3 · `🖼️🖼️🖼️🖼️🔄`3 · `📌`3 · `🖼️🖼️🔄`2 · `🖼️🖇️`2 · `🖼️📝`2 ·
`🎥🚨🗑️`1 · `❌📌`1 · `🖼️🖼️📝`1 · `❌🦶`1 · `🖼️🖼️🖼️🔄`1

---

## 4. URL preview — thứ quyết định hình ảnh hiện ra

| Nội dung tweet | URL preview | webpage.type |
|---|---|---|
| Video / gif | `https://d.fxtwitter.com/<author>/status/<id>` | `document` |
| Ảnh | `https://pbs.twimg.com/media/<key>.jpg` | `photo` |
| Reply / Quote / Pin | `https://fxtwitter.com/<target>/status/<parent_id>` | `photo` / `video`, có `site_name` = `🧵 Thread • FxTwitter` |
| Chỉ text | không preview | — |

Host thật trên 400 tin: `fxtwitter.com` 237 · `d.fxtwitter.com` 62 · không có 50 ·
`pbs.twimg.com` 45 · `x.com` 3 · khác 3.

> **Đây là điểm channel target đang làm sai.** Target dán link profile
> `https://x.com/<author>` vào `@author` ở đầu message. Telegram lấy **link đầu tiên**
> trong text làm preview → ra card profile (avatar + "Elon Musk (@elonmusk) on X") thay vì
> nội dung tweet. Source **không để link nào trong text** mà chỉ định URL preview riêng
> qua `link_preview_options.url` (Bot API) / `InputMediaWebPage` (MTProto).

---

## 5. invert_media

```
invert_media = True   ⟺  preview là media trực tiếp (d.fxtwitter.com | pbs.twimg.com)
invert_media = False  ⟺  card fxtwitter.com, hoặc không có preview
```

Đúng **107/107** và **293/293** trên mẫu 400 tin — không một ngoại lệ.
`True` = preview nằm **trên** text. Bot API: `link_preview_options.show_above_text`.

| Prefix | invert | host preview |
|---|---|---|
| `🖇️` (154) | False | `fxtwitter.com` |
| `💬` (81) | False | `fxtwitter.com` |
| `🔄` (40) | False | không có (36/40) |
| `🎥🔄` (35) | **True** | `d.fxtwitter.com` |
| `🖼️🔄` (31) | **True** | `pbs.twimg.com` |
| `🎥📝` (26) | **True** | `d.fxtwitter.com` |
| `📝` (7) | False | không có |

---

## 6. Entity — source tự nó KHÔNG nhất quán

Phải bám sát từng loại, đừng chuẩn hoá lại:

| Loại | prefix | author | động từ | target |
|---|---|---|---|---|
| Replied To | `TextUrl` → fxtwitter tweet cha | `Bold` | **`Code`** | `Bold` |
| Retweeted | *không entity* | `Bold` | **`Code`** | `Bold` |
| Quoted | `TextUrl` → fxtwitter tweet quote | **`TextUrl`** → `x.com/<author>` | **`Bold`** | **`TextUrl`** → `x.com/<target>` |
| Tweeted | *không entity* | `Bold` | — | — |
| Deleted | *không entity* | `Bold` | `Bold` trên `Deleted Tweet` | — |
| Pinned / unPinned | `TextUrl` → fxtwitter | `Bold` | **`Bold`** | `Bold` |
| followed | *không entity* | `Bold` **+** `TextUrl` chồng nhau | *không entity* | `Bold` + `TextUrl` |

Chú ý 2 chỗ dễ sai:

- `Replied To` / `Retweeted` dùng **`Code`** cho động từ; `Quoted` / `Pinned` dùng **`Bold`**.
- Loại `followed` gắn **2 entity chồng lên cùng một đoạn** (`Bold` và `TextUrl` cùng
  offset/length), và có thêm `Blockquote` bọc profile card.

Phân bố tổ hợp entity thật: `Bold×2 + Code×1 + TextUrl×1` 124 · `Bold×2 + Code×1` 85 ·
`Bold×1 + TextUrl×3` 73 · `Bold×1` 18 · `Bold×1 + Url×1` 17.

### Profile card của loại followed

Nội dung `Blockquote`:

```
 <Display Name> (<handle>)
<N> Following | <N> Followers

<bio>

📍 <location>
🔗 <website>
```

`Display Name` được `Bold` riêng bên trong blockquote. `location` có thể là `null`.

---

## 7. Nút inline

**393/400 tin** — 1 hàng, 2 nút:

| Nhãn | URL |
|---|---|
| `Redacted Bot` | `https://t.me/redactedsystemsbot?start=<channel_id>` |
| `View Tweet` | `https://x.com/<author>/status/<tweet_id>` |

**7 tin loại follow** — 3 hàng, mỗi hàng 1 nút:

| Nhãn | URL |
|---|---|
| `Redacted Bot` | `https://t.me/redactedsystemsbot?start=<channel_id>` |
| `View Followed Account` | `https://x.com/<target>/` |
| `QA: <target>` | `https://t.me/redactedsystemsbot?start=qa+<target>` |

> `?start=2422752661` là **link referral** của họ (`2422752661` = id channel source).
> Nếu copy y nguyên thì bạn đang chạy referral hộ họ. Đổi sang bot của bạn.

---

## 8. Offset entity tính theo UTF-16 — lỗi phổ biến nhất

Telegram đếm offset/length bằng **đơn vị UTF-16**, không phải ký tự Python.

| Emoji | Code point | Đơn vị UTF-16 |
|---|---|---|
| `🖼️` | U+1F5BC U+FE0F | **3** |
| `🖇️` | U+1F587 U+FE0F | **3** |
| `🗑️` | U+1F5D1 U+FE0F | **3** |
| `🎥` `📝` `🔄` `💬` `🚨` `📌` `🦶` | 1 code point ngoài BMP | **2** |
| `❌` | U+274C | **1** (nằm trong BMP) |
| ký tự thường | | 1 |

Emoji có variation selector `U+FE0F` ăn 3 đơn vị, còn `❌` chỉ ăn 1. Dùng `len()` của
Python là lệch ngay.

Kiểm chứng — offset của `author` = bề rộng prefix + 1 (dấu cách), **khớp 16/16 prefix**
quan sát được:

| Prefix | UTF-16 | author offset thật |
|---|---|---|
| `🖇️` | 3 | 4 |
| `🔄` | 2 | 3 |
| `🎥🔄` | 4 | 5 |
| `🖼️🔄` | 5 | 6 |
| `🖼️🖇️` | 6 | 7 |
| `🖼️🖼️🔄` | 8 | 9 |
| `🖼️🚨🗑️` | 8 | 9 |
| `🖼️🖼️🖼️🖼️🔄` | 14 | 15 |
| `❌📌` | 3 | 4 |

Cách tính đúng:

```python
def u16len(s):
    return len(s.encode("utf-16-le")) // 2
```

---

## 9. Hai điều dễ làm sai hướng

**Không dùng album, không upload file.** 0/400 tin là media group, 0/400 upload
photo/document thật — **toàn bộ media đi qua link preview**. Tweet 4 ảnh cũng chỉ là
`🖼️🖼️🖼️🖼️` ở prefix + **1** preview của ảnh đầu. Nếu bạn định dùng `sendMediaGroup`
thì sai hướng ngay từ đầu.

**Chỉ bot gửi được nút inline.** User account (MTProto user session) không có cách nào
gắn `reply_markup`. Muốn có nút thì phải dùng bot token và cho bot làm admin channel đích.

---

## 10. Cách gửi — Bot API

`link_preview_options` (Bot API 7.0+) cho phép chỉ định URL preview **không cần nằm trong
text** — đúng kỹ thuật source dùng.

```json
POST https://api.telegram.org/bot<TOKEN>/sendMessage
{
  "chat_id": -1004310952458,
  "text": "🎥📝 elonmusk Tweeted\nGrok Imagine",
  "entities": [
    {"type": "bold", "offset": 5, "length": 8}
  ],
  "link_preview_options": {
    "url": "https://d.fxtwitter.com/elonmusk/status/2082656239780266487",
    "show_above_text": true,
    "prefer_large_media": true
  },
  "reply_markup": {"inline_keyboard": [[
    {"text": "My Bot",     "url": "https://t.me/mybot?start=4310952458"},
    {"text": "View Tweet", "url": "https://x.com/elonmusk/status/2082656239780266487"}
  ]]}
}
```

Dùng `entities` thay vì `parse_mode` nếu nội dung tweet có thể chứa `*`, `_`, `` ` ``,
`[` — không thì Telegram sẽ hiểu sai và trả `400 Bad Request: can't parse entities`.

---

## 11. Cách gửi — Telethon (MTProto)

`send_message()` của Telethon **không nhận** `invert_media` (đã kiểm tra trên 1.43.2),
phải gọi raw request:

```python
import random
from telethon.tl import functions, types

await client(functions.messages.SendMediaRequest(
    peer=TARGET,
    media=types.InputMediaWebPage(
        url="https://d.fxtwitter.com/elonmusk/status/2082656239780266487",
        force_large_media=True,
        optional=True),          # preview lỗi thì vẫn gửi text, không raise
    message="🎥📝 elonmusk Tweeted\nGrok Imagine",
    entities=[types.MessageEntityBold(offset=5, length=8)],
    invert_media=True,
    reply_markup=types.ReplyInlineMarkup([types.KeyboardButtonRow([
        types.KeyboardButtonUrl("View Tweet",
            "https://x.com/elonmusk/status/2082656239780266487"),
    ])]),
    random_id=random.getrandbits(63),
))
```

Không có preview thì dùng `SendMessageRequest(..., no_webpage=True)`.

---

## 12. Ví dụ thật từng loại

Lấy nguyên từ channel source, offset đã giải mã theo UTF-16.

### Replied To — id 55804

```
🖇️ elonmusk Replied To kane

Looks creepy 😬
```

| Entity | off | len | đoạn | url |
|---|---|---|---|---|
| TextUrl | 0 | 3 | `🖇️` | `https://fxtwitter.com/kane/status/2082608592839229649` |
| Bold | 4 | 8 | `elonmusk` | |
| Code | 13 | 10 | `Replied To` | |
| Bold | 24 | 4 | `kane` | |

preview `fxtwitter.com/kane/status/2082608592839229649` · `invert=False`

### Retweeted không media — id 55803

```
🔄 elonmusk Retweeted ZiaYusufUK

So, the rules are if you have right wing views…
```

`Bold(3,8)` `Code(12,9)` `Bold(22,10)` · **không preview** · `invert=False`

### Tweeted + video — id 55802

```
🎥📝 elonmusk Tweeted
Grok Imagine
```

`Bold(5,8)` · preview `d.fxtwitter.com/elonmusk/status/2082656239780266487` · `invert=True`

### Quoted — id 55801

```
💬 elonmusk Quoted PeterDiamandis

It will happen
```

| Entity | off | len | đoạn | url |
|---|---|---|---|---|
| TextUrl | 0 | 2 | `💬` | `https://fxtwitter.com/PeterDiamandis/status/2082498584650416155` |
| TextUrl | 3 | 8 | `elonmusk` | `https://x.com/elonmusk` |
| Bold | 12 | 6 | `Quoted` | |
| TextUrl | 19 | 14 | `PeterDiamandis` | `https://x.com/PeterDiamandis` |

`invert=False`

### Retweeted + ảnh — id 55796

```
🖼️🔄 elonmusk Retweeted alanvibe

Allison Pearson receives payout and apology…
```

`Bold(6,8)` `Code(15,9)` `Bold(25,8)` `Mention(113,15)` ·
preview `pbs.twimg.com/media/HOa9WjzWoAAz10K.jpg` · `invert=True`

### Deleted — id 55743

```
🖼️🚨🗑️ Deleted Tweet from cz_binance
Brutal... Hope this marks the bottom. Stay SAFU!
```

`Bold(9,13)` trên `Deleted Tweet` · `Bold(28,10)` trên `cz_binance` ·
preview `pbs.twimg.com/media/HOKIDdQa0AA-4lf.jpg` · `invert=True`

### followed — id 55701

```
🦶 elonmusk followed dhh
 DHH (dhh)
201 Following | 769,233 Followers

Father of three, Creator of Ruby on Rails + Omarchy…

📍 null
🔗 https://dhh.dk
```

`TextUrl(3,8)`+`Bold(3,8)` trên `elonmusk` · `TextUrl(21,3)`+`Bold(21,3)` trên `dhh` ·
`Blockquote(25,227)` · **không preview** · `invert=False` · **3 hàng nút**

---

## 13. Checklist chuyển target sang giống source

- [ ] Đổi poster sang **bot** làm admin channel (bắt buộc, để có nút inline)
- [ ] Bỏ link `x.com/<author>` gắn vào `@author` ở đầu message — nó chiếm preview
- [ ] Bỏ URL thô ở cuối text, chuyển vào nút `View Tweet`
- [ ] Chỉ định URL preview riêng: `d.fxtwitter.com` (video) / `pbs.twimg.com` (ảnh) / `fxtwitter.com` (reply-quote)
- [ ] Bật `show_above_text` / `invert_media` khi preview là media trực tiếp
- [ ] Prefix emoji động theo loại + số ảnh, thay cho `🐦` cố định
- [ ] Dùng `Code` cho động từ ở Replied To / Retweeted, `Bold` ở Quoted / Pinned
- [ ] Tính offset entity bằng UTF-16
- [ ] Thay nút referral `redactedsystemsbot` bằng bot của bạn
