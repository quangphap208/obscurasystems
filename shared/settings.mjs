// settings.mjs — metadata 19+1 khoá setting (thứ tự & tên khớp @redactedsystemsbot),
// default preset, và ánh xạ loại event -> khoá để dispatcher lọc.
//
// key   = tên hiển thị / callback (camelCase, đúng như bot gốc: `deletedTweets ❌`)
// col   = tên cột DB (snake_case)
// group = 'new' (New Accounts) | 'cn' (Custom Notifications) | 'ocr'
// def   = giá trị mặc định (spec §3, trạng thái thật account Free)
// gate  = null | 'coming' (chưa hỗ trợ) | 'paid' (chỉ trả phí) — dùng cho FE chặn toggle
//
// gate theo NGUỒN: pins/unpins nay do j7 cấp (nguồn 2) -> đã bỏ gate. Còn lại Bloom lẫn j7 đều
// không phát (spaces/trendingTweets/trendingProfiles) + muted (chỉ cục bộ) vẫn bị gate.

export const SETTINGS = [
  // ---- New Accounts (15) — đúng thứ tự hiển thị ----
  { key: "tweets",           col: "tweets",            group: "new", def: 1, gate: null },
  { key: "quotes",           col: "quotes",            group: "new", def: 1, gate: null },
  { key: "retweets",         col: "retweets",          group: "new", def: 1, gate: null },
  { key: "replies",          col: "replies",           group: "new", def: 1, gate: null },
  { key: "follows",          col: "follows",           group: "new", def: 0, gate: null },
  { key: "profileChanges",   col: "profile_changes",   group: "new", def: 1, gate: null },
  { key: "muted",            col: "muted",             group: "new", def: 0, gate: "coming", hidden: true },   // Bloom chỉ mute cục bộ
  { key: "spaces",           col: "spaces",            group: "new", def: 0, gate: "paid",   hidden: true },   // Bloom không có Spaces
  { key: "deletedTweets",    col: "deleted_tweets",    group: "new", def: 0, gate: null },
  { key: "photos",           col: "photos",            group: "new", def: 1, gate: null },
  { key: "videos",           col: "videos",            group: "new", def: 0, gate: null },
  { key: "unfollows",        col: "unfollows",         group: "new", def: 0, gate: null },
  { key: "pins",             col: "pins",              group: "new", def: 0, gate: null },   // j7 phát event pin (Bloom không) — chỉ bắn cho account j7 cover
  { key: "unpins",           col: "unpins",            group: "new", def: 0, gate: null },
  { key: "affiliations",     col: "affiliations",      group: "new", def: 0, gate: null },
  // Hiển thị: bật/tắt nút inline 🗑 Delete trên mỗi tin noti (KHÔNG map event -> không lọc loại tin).
  { key: "deleteButton",     col: "delete_button",     group: "new", def: 1, gate: null },
  // ---- Custom Notifications (4) — hậu tố callback _cn ----
  { key: "trendingTweets",   col: "trending_tweets",   group: "cn",  def: 0, gate: "coming", hidden: true },  // cần hạ tầng riêng
  { key: "trendingProfiles", col: "trending_profiles", group: "cn",  def: 0, gate: "coming", hidden: true },
  { key: "suspensions",      col: "suspensions",       group: "cn",  def: 1, gate: null },
  { key: "deactivations",    col: "deactivations",     group: "cn",  def: 1, gate: null },
];

// OCR đứng riêng ngoài 2 nhóm. Bloom CÓ hỗ trợ (useOcr) nhưng chưa wired -> ẩn khỏi UI (hidden)
// cho tới khi nối enrichment/OCR. Bỏ hidden (và gate) khi wired xong.
export const OCR = { key: "OCR", col: "ocr", group: "ocr", def: 0, gate: "coming", hidden: true };

export const ALL_KEYS = [OCR, ...SETTINGS];
export const byKey = Object.fromEntries(ALL_KEYS.map((s) => [s.key, s]));
export const byCol = Object.fromEntries(ALL_KEYS.map((s) => [s.col, s]));

export const DEFAULTS = Object.fromEntries(ALL_KEYS.map((s) => [s.col, s.def]));

export const GATE_TEXT = {
  coming: "This feature is not live yet!",
  paid: "This selected setting is for customers only",
};

// Loại event (normalize.kind) -> cột setting quyết định có gửi hay không.
export const KIND_TO_COL = {
  tweet:          "tweets",
  retweet:        "retweets",
  reply:          "replies",
  quote:          "quotes",
  deleted:        "deleted_tweets",
  followed:       "follows",
  unfollowed:     "unfollows",
  pinned:         "pins",
  unpinned:       "unpins",
  profileChanges: "profile_changes",
  affiliation:    "affiliations",
  suspended:      "suspensions",
  deactivated:    "deactivations",
};

// Cho FE: nhãn nút "<key> ✅|❌"
export const label = (s, on) => `${s.key} ${on ? "✅" : "❌"}`;
