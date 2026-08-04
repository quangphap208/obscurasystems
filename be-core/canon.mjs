// canon.mjs (be-core) — chuẩn hoá giá trị để so sánh CHÉO NGUỒN (Bloom ↔ j7) không sinh false-diff.
// canonAvatar: bỏ hậu tố kích cỡ (_normal/_bigger/_mini/_400x400…) + query. Cùng 1 ảnh nhưng
// feed trả `_400x400`, search trả `_normal`, j7 lại URL khác cỡ — không chuẩn hoá sẽ "đổi avatar"
// GIẢ và ping-pong vô hạn. Bản đã bỏ hậu tố = ảnh gốc full-res, dùng luôn cho preview.
export const canonAvatar = (url) => (String(url || "")
  .replace(/\?.*$/, "")
  .replace(/_(normal|bigger|mini|reasonably_small|\d+x\d+)(?=\.\w+$)/i, "")) || null;
