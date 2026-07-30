# Chức năng theo dõi tài khoản X của bot

Danh mục **20 loại sự kiện** bot phát hiện được trên một tài khoản X, cùng nguồn dữ liệu
cần có và định dạng tin sinh ra.

Trích từ 2 nguồn quan sát thực tế:

| Nguồn | Cho biết |
|---|---|
| Màn `⚙️ Global Settings` của [@redactedsystemsbot](https://t.me/redactedsystemsbot) | 20 khoá bật/tắt, giá trị mặc định, khoá nào bị gate |
| 400 tin channel `-1002422752661` | tin thật sinh ra cho 8/20 loại |

Tài liệu liên quan: [bot_build_spec.md](bot_build_spec.md) (UI, callback, DB) ·
[send_like_source.md](send_like_source.md) (định dạng tin).

---

## 1. Bảng tổng hợp

| # | Khoá | Nhóm | Mặc định | Trạng thái | Tin mẫu | Loại tin |
|---|---|---|---|---|---|---|
| 1 | `tweets` | New Accounts | ✅ | hoạt động | **36** | `📝` Tweeted |
| 2 | `quotes` | New Accounts | ✅ | hoạt động | **81** | `💬` Quoted |
| 3 | `retweets` | New Accounts | ✅ | hoạt động | **112** | `🔄` Retweeted |
| 4 | `replies` | New Accounts | ✅ | hoạt động | **156** | `🖇️` Replied To |
| 5 | `follows` | New Accounts | ❌ | hoạt động | **6** | `🦶` followed |
| 6 | `unfollows` | New Accounts | ❌ | hoạt động | **1** | `❌🦶` Unfollowed |
| 7 | `pins` | New Accounts | ❌ | hoạt động | **3** | `📌` Pinned Reply To |
| 8 | `unpins` | New Accounts | ❌ | hoạt động | **1** | `❌📌` unPinned Reply To |
| 9 | `deletedTweets` | New Accounts | ❌ | **chưa test** | **4** | `🚨🗑️` Deleted Tweet/Retweet |
| 10 | `photos` | New Accounts | ✅ | hoạt động | 45 preview | bộ lọc — prefix `🖼️` |
| 11 | `videos` | New Accounts | ❌ | hoạt động | 62 preview | bộ lọc — prefix `🎥` |
| 12 | `profileChanges` | New Accounts | ✅ | hoạt động | — | chưa rõ |
| 13 | `muted` | New Accounts | ❌ | hoạt động | — | chưa rõ |
| 14 | `spaces` | New Accounts | ❌ | **chỉ trả phí** | — | chưa rõ |
| 15 | `affiliations` | New Accounts | ❌ | hoạt động | — | chưa rõ |
| 16 | `suspensions` | Custom Notif. | ✅ | hoạt động | — | chưa rõ |
| 17 | `deactivations` | Custom Notif. | ✅ | hoạt động | — | chưa rõ |
| 18 | `trendingTweets` | Custom Notif. | ❌ | hoạt động | — | chưa rõ |
| 19 | `trendingProfiles` | Custom Notif. | ❌ | hoạt động | — | chưa rõ |
| 20 | `OCR` | riêng | ❌ | **chưa hoạt động** | — | — |

**8/20 loại có tin mẫu thật.** 11 loại còn lại chỉ biết tên khoá, không biết bot render ra
sao — phải tự thiết kế.

Lưu ý về cột *Mặc định*: đó là giá trị preset trên account Free/EXPIRED đã crawl. Channel
mẫu có `follows` và `videos` bật dù mặc định là ❌ → **mặc định của bot ≠ cấu hình của
channel mẫu**, hai thứ độc lập.

---

## 2. Nhóm A — Hoạt động đăng bài (4 loại, có đầy đủ tin mẫu)

Chiếm **385/400 tin** của channel mẫu. Đây là phần cốt lõi.

### `tweets` — tweet gốc

Tài khoản đăng tweet mới, không phải reply/quote/retweet.

- Trigger: item mới trên timeline có `in_reply_to_status_id = null`, không `retweeted_status`, không `quoted_status`
- Tin: `📝 <author> Tweeted` — xem mục 12 của [send_like_source.md](send_like_source.md)

### `replies` — trả lời tweet người khác

Loại nhiều nhất (156/400).

- Trigger: `in_reply_to_status_id != null`
- Cần thêm: **tweet cha** để dựng preview `fxtwitter.com/<target>/status/<parent_id>`
- Tin: `🖇️ <author> Replied To <target>`

### `quotes` — quote tweet

- Trigger: có `quoted_status`
- Cần thêm: tweet được quote (dựng preview) + handle của tác giả tweet đó
- Tin: `💬 <author> Quoted <target>`
- Khác biệt: entity dùng `TextUrl` cho tên và `Bold` cho động từ, ngược với `replies`

### `retweets` — retweet

- Trigger: có `retweeted_status`
- Tin: `🔄 <author> Retweeted <target>`
- **Nội dung body là của tweet gốc**, không phải của người retweet
- 36/40 tin retweet không kèm preview — retweet text-only thì không có gì để preview

---

## 3. Nhóm B — Quan hệ và hồ sơ (4 loại)

### `follows` / `unfollows` — theo dõi / bỏ theo dõi

Phải **diff danh sách following** giữa 2 lần poll. Không có webhook cho việc này.

Tin sinh ra kèm **profile card** của account bị follow, bọc trong `Blockquote`:

```
 <Display Name> (<handle>)
<N> Following | <N> Followers

<bio>

📍 <location>
🔗 <website>
```

→ nghĩa là bot phải lấy **user object đầy đủ** của account đích, không chỉ handle.
`location` có thể là chuỗi `null`.

Loại này có **bộ nút riêng 3 hàng**: `[Bot]` / `[View Followed Account]` / `[QA: <handle>]`.

### `profileChanges` — đổi hồ sơ

Mặc định ✅ nhưng **không có tin mẫu**. Suy ra phải snapshot rồi diff các trường: tên hiển
thị, handle, bio, avatar, banner, location, website, trạng thái verified.

### `affiliations` — liên kết tổ chức

X có huy hiệu affiliation (account con của một tổ chức). Không có tin mẫu.

---

## 4. Nhóm C — Vòng đời tài khoản (3 loại)

### `deletedTweets` — tweet bị xoá

Phải **lưu lại tweet đã thấy** rồi phát hiện khi nó biến mất. Bot gốc render được cả nội
dung tweet đã xoá → chứng tỏ nó lưu full nội dung, không chỉ id.

Tin: `🚨🗑️ Deleted Tweet from <author>` hoặc `Deleted Retweet from <author>`.
Vẫn giữ được media preview → media cũng phải cache lại URL.

> Nút này bị crawler bỏ qua có chủ đích (nhãn chứa "deleted", trùng regex an toàn) nên
> chưa biết bấm vào có bị gate hay không.

### `suspensions` / `deactivations` — bị đình chỉ / tự vô hiệu hoá

Mặc định ✅ cả hai, thuộc nhóm Custom Notifications. Phát hiện qua lỗi khi query user:
- suspended → API trả cờ suspended
- deactivated → user không còn tồn tại

Không có tin mẫu.

---

## 5. Nhóm D — Bộ lọc media (2 khoá, không phải loại sự kiện)

`photos` và `videos` **không sinh tin riêng** — chúng lọc xem tin có media thì có gửi hay
không, và quyết định prefix emoji:

| Nội dung | Prefix | URL preview |
|---|---|---|
| N ảnh | `🖼️` × N (thấy tới 4) | `https://pbs.twimg.com/media/<key>.jpg` |
| video / gif | `🎥` | `https://d.fxtwitter.com/<author>/status/<id>` |

Media indicator đứng **trước** action indicator: `🖼️🖼️🔄` = retweet kèm 2 ảnh.

Quan trọng: **không upload file, không dùng media group.** 0/400 tin là album, 0/400
upload thật — toàn bộ media đi qua link preview. Tweet 4 ảnh cũng chỉ có 1 preview của
ảnh đầu.

---

## 6. Nhóm E — Ngoài phạm vi 1 tài khoản (2 loại)

`trendingTweets` và `trendingProfiles` — theo mô tả trong bot:

> *Get trendingProfiles & trendingTweets that are being scanned across thousands of telegram &*

(câu bị cắt giữa trong chính bot gốc)

Đây **không phải theo dõi account cụ thể** mà là quét hàng nghìn channel/group Telegram để
tìm tweet và profile đang được nhắc nhiều. Cần hạ tầng riêng hoàn toàn: một mạng lưới
account đọc channel Telegram + đếm tần suất. Nặng hơn tất cả các loại còn lại cộng lại.

Mặc định ❌ cả hai.

---

## 7. Hai chức năng bị chặn

| Khoá | Bấm vào ra gì | Nghĩa |
|---|---|---|
| `OCR` | alert `This feature is not live yet!` | Chưa làm xong. Mô tả: *Automatically detect SOL & EVM contracts from images* — OCR ảnh trong tweet để bắt địa chỉ contract Solana/EVM |
| `spaces` | alert `This selected setting is for customers only` | Chỉ tier trả phí. Theo dõi X Spaces (audio room) |

`OCR` cho thấy định hướng sản phẩm: bot này nhắm vào người giao dịch crypto, không phải
theo dõi mạng xã hội nói chung.

---

## 8. Quản lý tài khoản theo dõi

| Lệnh | Chức năng |
|---|---|
| `/add <username>` | thêm 1 account X vào danh sách theo dõi |
| `/remove <username>` | bỏ theo dõi |
| `👀 X accounts` | xem danh sách đang theo dõi |

Giới hạn theo tier — account crawl là **Free, limit 0 account, đã EXPIRED**, nên toàn bộ
luồng `/add` chưa quan sát được.

Khi thêm account mới, bot áp **preset từ Global Settings** — đúng như mô tả trong bot:

> *Preset For New Accounts ⇢ Set default settings for when you add a new account. That way
> you don't have to manually set these every time!*

Suy ra mỗi account theo dõi có **bản cài đặt riêng**, khởi tạo bằng preset global rồi sửa
độc lập sau. Nhưng màn cài đặt riêng từng account **chưa crawl được** (cần account có ít
nhất 1 watch).

---

## 9. Chức năng phụ trợ

**Deep-link `?start=`** dùng 3 dạng khác nhau:

| Dạng | Ví dụ | Ý nghĩa |
|---|---|---|
| `<tg_user_id>` | `?start=1144383007` | link referral |
| `<channel_id>` | `?start=2422752661` | gắn nút bot trong tin đăng ở channel |
| `qa+<handle>` | `?start=qa+dhh` | nút `QA: <handle>` ở tin follow — hỏi/phân tích account đó |

Chức năng `QA` chưa biết làm gì cụ thể, chỉ thấy nút.

---

## 10. Nguồn dữ liệu X cần có, xếp theo độ khó

| Mức | Loại | Cần gì |
|---|---|---|
| Dễ | `tweets` `replies` `quotes` `retweets` `photos` `videos` | poll timeline định kỳ |
| Trung bình | `pins` `unpins` | đọc pinned tweet trong user object, diff |
| Trung bình | `profileChanges` | snapshot user object, diff từng trường |
| Trung bình | `suspensions` `deactivations` | bắt lỗi khi query user |
| Khó | `follows` `unfollows` | phải liệt kê **toàn bộ** following rồi diff — tốn quota nhất |
| Khó | `deletedTweets` | phải cache full nội dung + media, rồi phát hiện biến mất |
| Khó | `spaces` | endpoint Spaces, phải poll liên tục |
| Khó | `affiliations` | dữ liệu affiliation ít tài liệu |
| Rất khó | `trendingTweets` `trendingProfiles` | quét hàng nghìn channel Telegram, hạ tầng riêng |
| Rất khó | `OCR` | pipeline OCR ảnh + regex địa chỉ SOL/EVM (bot gốc cũng chưa làm xong) |

Nếu dựng lại, nên làm theo thứ tự bảng này. Nhóm "Dễ" đã chiếm **385/400 tin** thực tế —
làm xong 4 loại đó là đã có ~96% khối lượng thông báo.

---

## 11. Ranh giới bằng chứng

Để không nhầm suy đoán với dữ liệu:

**Quan sát trực tiếp**
- 20 khoá, tên chính xác, nhóm, giá trị mặc định, `callback_data`
- 2 alert gate: `OCR` chưa live, `spaces` chỉ trả phí
- Định dạng tin đầy đủ cho 8 loại (mục 1–5 của [send_like_source.md](send_like_source.md))
- Mô tả 3 nhóm tính năng, lấy nguyên văn từ text màn settings
- 3 dạng deep-link `?start=`

**Suy ra, chưa kiểm chứng**
- Cách phát hiện `follows`/`profileChanges`/`deletedTweets`/`suspensions` (dựa vào việc
  X không có webhook cho các sự kiện này, buộc phải poll + diff)
- Mỗi watch có settings riêng (dựa vào chữ *"Preset For New Accounts"*)
- Bảng độ khó ở mục 10

**Không có dữ liệu**
- Định dạng tin của 11 loại còn lại
- Toàn bộ UI và giới hạn của tier trả phí
- Nút `deletedTweets` có bị gate hay không
- Chức năng `QA` làm gì
- Bot gốc lấy dữ liệu X bằng cách nào
