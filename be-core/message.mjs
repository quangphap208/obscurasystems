// message.mjs (be-core) — dựng tin Telegram theo format "Redacted Bot" + event builder profile.
// DÙNG CHUNG cho BE Bloom + BE j7: cả 2 nguồn normalize về canonical event rồi render qua đây
// -> ai thắng race cũng ra tin GIỐNG HỆT. Spec: docs/send_like_source.md.
// Nguyên tắc: KHÔNG để link trong text (link chiếm preview); media/preview qua
// link_preview_options.url; dùng HTML parse_mode (Telegram tự tính offset).

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FX = "https://fxtwitter.com", DFX = "https://d.fxtwitter.com";

// [action emoji, verb, separator]
const ACT = {
  tweet:          ["📝", "Tweeted", "\n"],
  retweet:        ["🔄", "Retweeted", "\n\n"],
  reply:          ["🖇️", "Replied To", "\n\n"],
  quote:          ["💬", "Quoted", "\n\n"],
  pinned:         ["📌", "Pinned", "\n\n"],
  unpinned:       ["❌📌", "unPinned", "\n\n"],
  deleted:        ["🚨🗑️", "Deleted", "\n"],
  followed:       ["🦶", "followed", "\n"],
  unfollowed:     ["❌🦶", "Unfollowed", "\n"],
  profileChanges: ["📇", "changed", "\n\n"],
  affiliation:    ["🔗", "affiliation changed", "\n"],
  suspended:      ["⛔", "was Suspended", "\n"],
  deactivated:    ["👻", "Deactivated account", "\n"],
};
const REPLYLIKE = new Set(["reply", "quote", "pinned", "unpinned"]);

// Dựng event chuẩn hoá cho 1 thay đổi profile — dùng chung cho normalize (frame Bloom),
// profile-poller (tự dò qua search), và (sau này) normalize-j7. field = subtype canonical
// (bio/screenname/handle/profile_picture/banner_picture/url/geo/verified_badge/affiliate_badge).
export function makeProfileEvent(field, before, after, { authorId = null, actor = null } = {}) {
  if (field === "affiliate_badge")
    return { kind: "affiliation", authorId, actor, content: typeof after === "string" ? after : "", images: [], hasVideo: false };
  const img = field === "profile_picture" || field === "banner_picture";
  return {
    kind: "profileChanges", field, authorId, actor,
    oldValue: before ?? null, newValue: after ?? null,
    content: buildProfileBody(field, before, after),
    images: img && typeof after === "string" ? [after] : [], hasVideo: false,
  };
}

function buildProfileBody(field, oldV, newV) {
  if (field === "profile_picture" || field === "banner_picture") return `Updated ${field.replace("_", " ")}`;
  const lines = [`Updated <b>${esc(field)}</b>`];
  if (oldV) lines.push(`old: ${esc(oldV)}`);
  if (newV) lines.push(`new: ${esc(newV)}`);
  return lines.join("\n");
}

// Dựng { text(HTML), link_preview_options, reply_markup } cho Bot API.
// deleteButton: hiện nút 🗑 Delete (setting delete_button; mặc định bật).
export function buildMessage(e, { botUser, deleteButton = true } = {}) {
  const k = e.kind;
  const meta = ACT[k]; if (!meta) return null;
  const [emoji, verb, sep] = meta;
  const author = e.actor, target = e.target;
  const nPhotos = (e.images || []).length, video = !!e.hasVideo;
  // Bug 5 (relay_bugs): tweet đã xoá -> d.fxtwitter 404 nên deleted-video KHÔNG dựng được
  // preview; bỏ 🎥 để giữ bất biến prefix-media ⟺ preview-media-trực-tiếp (ảnh pbs vẫn sống).
  const mediaPre = video ? (k === "deleted" ? "" : "🎥") : "🖼️".repeat(nPhotos);
  const pre = mediaPre + emoji;
  // link thread cho REPLYLIKE: reply/quote -> tweet cha; pinned/unpinned -> chính tweet đã pin.
  let threadUrl = null;
  if ((k === "reply" || k === "quote") && target && e.parentId) threadUrl = `${FX}/${target}/status/${e.parentId}`;
  else if ((k === "pinned" || k === "unpinned") && author && e.tweetId) threadUrl = `${FX}/${author}/status/${e.tweetId}`;
  const preHtml = (threadUrl && REPLYLIKE.has(k)) ? `<a href="${threadUrl}">${pre}</a>` : pre;

  let head;
  if (k === "tweet") head = `${preHtml} <b>${esc(author)}</b> ${verb}`;
  else if (k === "retweet") head = `${preHtml} <b>${esc(author)}</b> <code>${verb}</code> <b>${esc(target)}</b>`;
  else if (k === "reply") head = `${preHtml} <b>${esc(author)}</b> <code>${verb}</code> <b>${esc(target)}</b>`;
  else if (k === "pinned" || k === "unpinned") head = (e.pinnedIsReply && target)
    ? `${preHtml} <b>${esc(author)}</b> <b>${verb} Reply To</b> <b>${esc(target)}</b>`
    : `${preHtml} <b>${esc(author)}</b> <b>${verb}</b>`;
  else if (k === "quote") head = `${preHtml} <a href="https://x.com/${author}">${esc(author)}</a> <b>${verb}</b> <a href="https://x.com/${target}">${esc(target)}</a>`;
  else if (k === "deleted") head = `${preHtml} <b>Deleted ${e.deletedIsRetweet ? "Retweet" : "Tweet"}</b> from <b>${esc(author)}</b>`;
  else if (k === "followed" || k === "unfollowed") head = `${preHtml} <a href="https://x.com/${author}"><b>${esc(author)}</b></a> ${verb} <a href="https://x.com/${target}"><b>${esc(target)}</b></a>`;
  else if (k === "profileChanges") head = `${preHtml} <b>${esc(author)}</b> ${verb} profile`;
  else if (k === "affiliation") head = `${preHtml} <b>${esc(author)}</b> ${verb}`;
  else if (k === "suspended") head = `${preHtml} <b>${esc(author)}</b> ${e.undo ? "un-Suspended" : verb}`;
  else if (k === "deactivated") head = `${preHtml} <b>${esc(author)}</b> ${e.undo ? "Reactivated account" : verb}`;

  let text;
  if (k === "followed" || k === "unfollowed") {
    text = head + sep + (e.profileCard ? `<blockquote>${esc(e.profileCard)}</blockquote>` : "");
  } else {
    let body = e.content || "";
    // Chỉ cắt ĐÚNG mention của người được reply (không cắt mọi mention đầu body) — relay_bugs Lỗi 2.
    // vd reply @ggreenwald vẫn giữ "@AGHamilton29 …" do tác giả tự gõ.
    if (k === "reply" && target) body = body.replace(new RegExp("^@" + reEsc(target) + "\\s+", "i"), "");
    // profileChanges body đã chứa HTML (bold field) -> không esc lại
    text = head + sep + (k === "profileChanges" ? body : esc(body));
  }

  // preview
  let lpo;
  if (k === "deleted") {
    lpo = (nPhotos && e.images[0]) ? { url: e.images[0], show_above_text: true, prefer_large_media: true } : { is_disabled: true };
  } else if (k === "profileChanges" && nPhotos && e.images[0]) {
    lpo = { url: e.images[0], show_above_text: true, prefer_large_media: true };
  } else if (video && e.tweetId) lpo = { url: `${DFX}/${author}/status/${e.tweetId}`, show_above_text: true, prefer_large_media: true };
  else if (nPhotos && e.images[0]) lpo = { url: e.images[0], show_above_text: true, prefer_large_media: true };
  else if (threadUrl && REPLYLIKE.has(k)) lpo = { url: threadUrl, show_above_text: false, prefer_large_media: true };
  else lpo = { is_disabled: true };

  // nút inline. Noti gửi DM sẵn nên không cần nút mở-bot; thay bằng 🗑 Delete để user
  // xoá chính tin noti này (callback "del" -> FE deleteMessage).
  const rows = [];
  const del = { text: "🗑 Delete", callback_data: "del" };
  if (k === "followed" || k === "unfollowed") {
    if (deleteButton) rows.push([del]);
    if (target) rows.push([{ text: "View Followed Account", url: `https://x.com/${target}/` }]);
    if (target && botUser) rows.push([{ text: `QA: ${target}`, url: `https://t.me/${botUser}?start=qa+${target}` }]);
  } else {
    const row = [];
    if (deleteButton) row.push(del);
    if (e.tweetId && author) row.push({ text: "View Tweet", url: `https://x.com/${author}/status/${e.tweetId}` });
    if (row.length) rows.push(row);
  }
  return { text, link_preview_options: lpo, reply_markup: rows.length ? { inline_keyboard: rows } : undefined };
}

export { ACT, esc };
