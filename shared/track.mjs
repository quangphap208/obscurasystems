// track.mjs — event log cho analytics (mô hình docs/DASHBOARD.md: bot ghi event một chỗ,
// dashboard/scripts chỉ aggregate đọc). Fire-and-forget: KHÔNG await trong handler, nuốt lỗi —
// analytics không được phép làm chậm hay làm chết UI.
//
//   user_actions { tg_id, action, meta?, at:Date }   TTL 90 ngày (index ở mongo.mjs)
//   users.last_active_at (ms)                        bump mỗi tương tác (touch)
//
// action phẳng, meta nhỏ: start{source,ref,qa} · add{handle,result} · remove{handle,ok} ·
// toggle{key,scope,on} · nav{to} · subscribe_view · invoice_stars{kind} · invoice_crypto{kind,coin} ·
// paid_stars{kind,stars} · pay_manual{ok} · support{len} · platform{p,act} · admin{cmd,target}
import { col, now } from "./mongo.mjs";

// Bump last_active_at — gọi cho MỌI tương tác (middleware), rẻ, không ghi user_actions.
export function touch(tgId) {
  try {
    col("users").updateOne({ _id: Number(tgId) }, { $set: { last_active_at: now() } })
      .catch((e) => console.warn("[track] touch", e.message));
  } catch {}   // col() throw khi chưa connect — bot chưa boot xong thì bỏ qua
}

// Ghi 1 event có nghĩa (kèm touch). meta bỏ qua nếu rỗng.
export function track(tgId, action, meta = null) {
  try {
    col("user_actions").insertOne({
      tg_id: Number(tgId), action, ...(meta && Object.keys(meta).length ? { meta } : {}), at: new Date(),
    }).catch((e) => console.warn("[track]", action, e.message));
  } catch {}
  touch(tgId);
}
