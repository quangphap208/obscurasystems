// format.mjs — chuẩn hoá frame WS Bloom + dựng tin Telegram theo format "Redacted Bot".
// Spec: docs/send_like_source.md. Nguyên tắc: KHÔNG để link trong text (link chiếm preview);
// media/preview đặt qua link_preview_options.url; dùng HTML parse_mode (Telegram tự tính offset).

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FX = "https://fxtwitter.com", DFX = "https://d.fxtwitter.com";

// [action emoji, verb, separator]
const ACT = {
  tweet:          ["📝", "Tweeted", "\n"],
  retweet:        ["🔄", "Retweeted", "\n\n"],
  reply:          ["🖇️", "Replied To", "\n\n"],
  quote:          ["💬", "Quoted", "\n\n"],
  pinned:         ["📌", "Pinned Reply To", "\n\n"],
  unpinned:       ["❌📌", "unPinned Reply To", "\n\n"],
  deleted:        ["🚨🗑️", "Deleted", "\n"],
  followed:       ["🦶", "followed", "\n"],
  unfollowed:     ["❌🦶", "Unfollowed", "\n"],
  profileChanges: ["📇", "changed", "\n\n"],
  affiliation:    ["🔗", "affiliation changed", "\n"],
  suspended:      ["⛔", "was Suspended", "\n"],
  deactivated:    ["👻", "Deactivated account", "\n"],
};
const REPLYLIKE = new Set(["reply", "quote", "pinned", "unpinned"]);
const SUBTYPE = { TWEET: "tweet", RETWEET: "retweet", REPLY: "reply", QUOTE: "quote" };

const mediaOf = (m = {}) => ({
  images: (m.images || []).filter(Boolean),
  videos: (m.videos || []).filter(Boolean),
});

// Chuẩn hoá 1 frame ({type,data}) -> event thống nhất, hoặc null nếu bỏ qua.
export function normalize(frame) {
  if (!frame || typeof frame !== "object") return null;
  const t = frame.type, d = frame.data || {};

  // ---- compliance: delete / suspend / deactivate ----
  if (t === "compliance") {
    const ev = d.event_type;
    if (ev === "delete") {
      const tc = d.tweet_content || {};
      let { images, videos } = mediaOf(tc.media);
      const isRt = tc.type === "RETWEET" || !!tc.retweeted_status;
      if (isRt && !images.length && !videos.length) ({ images, videos } = mediaOf(tc.parent_tweet?.media));
      return {
        kind: "deleted", deletedIsRetweet: isRt,
        authorId: d.author_id ? String(d.author_id) : null, actor: tc.author?.screen_name || null,
        content: tc.text || tc.parent_tweet?.text || "", tweetId: d.entity_id || null,
        target: null, parentId: null, images, hasVideo: videos.length > 0,
      };
    }
    if (ev === "user_suspend" || ev === "user_unsuspend")
      return { kind: "suspended", undo: ev === "user_unsuspend", authorId: d.author_id ? String(d.author_id) : null, actor: d.screen_name || d.author?.screen_name || null, content: "", images: [], hasVideo: false };
    if (ev === "user_delete" || ev === "user_undelete")
      return { kind: "deactivated", undo: ev === "user_undelete", authorId: d.author_id ? String(d.author_id) : null, actor: d.screen_name || d.author?.screen_name || null, content: "", images: [], hasVideo: false };
    return null;
  }

  // ---- activity: follow / unfollow / profile changes ----
  if (t === "activity") {
    const a = d.actor || d.author || {};
    const sub = d.type || d.event_type || "";
    if (sub === "follow.follow" || sub === "follow.unfollow") {
      const tgt = d.target || d.followed || {};
      return {
        kind: sub === "follow.follow" ? "followed" : "unfollowed",
        authorId: a.id ? String(a.id) : null, actor: a.screen_name || null, actorName: a.name || "",
        target: tgt.screen_name || null, targetUser: tgt, content: "",
        profileCard: profileCard(tgt), images: [], hasVideo: false,
      };
    }
    if (sub.startsWith("profile.update.")) {
      const field = sub.slice("profile.update.".length);
      if (field === "affiliate_badge")
        return { kind: "affiliation", authorId: a.id ? String(a.id) : null, actor: a.screen_name || null, content: d.new_value || d.value || "", images: [], hasVideo: false };
      const img = field === "profile_picture" || field === "banner_picture";
      return {
        kind: "profileChanges", field, authorId: a.id ? String(a.id) : null, actor: a.screen_name || null,
        oldValue: d.old_value ?? null, newValue: d.new_value ?? d.value ?? null,
        content: buildProfileBody(field, d.old_value, d.new_value ?? d.value),
        images: img && d.new_value ? [d.new_value] : [], hasVideo: false,
      };
    }
    return null;
  }

  // ---- tweet-likes (Bloom gửi mọi loại dưới frame "tweet"; sub-type ở data.type) ----
  if (!["tweet", "retweet", "quote", "reply"].includes(t)) return null;
  const a = d.author || {};
  const sub = t === "tweet" ? (SUBTYPE[d.type] || "tweet") : t;
  let { images, videos } = mediaOf(d.media);
  if (sub === "retweet" && !images.length && !videos.length) ({ images, videos } = mediaOf(d.parent_tweet?.media));
  const content = d.text || (sub === "retweet" ? (d.parent_tweet?.text || "") : "");
  return {
    kind: sub, authorId: a.id ? String(a.id) : null, actor: a.screen_name || null, actorName: a.name || "",
    content, tweetId: d.id || null,
    target: d.parent_tweet?.author?.screen_name || null, parentId: d.parent_tweet?.id || null,
    images, hasVideo: videos.length > 0, createdAt: d.tweet_created_at || null,
  };
}

function buildProfileBody(field, oldV, newV) {
  if (field === "profile_picture" || field === "banner_picture") return `Updated ${field.replace("_", " ")}`;
  const lines = [`Updated <b>${esc(field)}</b>`];
  if (oldV) lines.push(`old: ${esc(oldV)}`);
  if (newV) lines.push(`new: ${esc(newV)}`);
  return lines.join("\n");
}

// Profile card (blockquote) cho follow — theo send_like_source.md §6.
function profileCard(u) {
  if (!u || !u.screen_name) return "";
  const fol = u.friends_count ?? u.following_count ?? "?";
  const fers = u.followers_count ?? "?";
  const parts = [` ${u.name || u.screen_name} (${u.screen_name})`, `${fol} Following | ${fers} Followers`];
  if (u.description) parts.push("", u.description);
  const tail = [];
  if (u.location !== undefined) tail.push(`📍 ${u.location ?? "null"}`);
  if (u.url) tail.push(`🔗 ${u.url}`);
  if (tail.length) parts.push("", ...tail);
  return parts.join("\n");
}

// Dựng { text(HTML), link_preview_options, reply_markup } cho Bot API.
export function buildMessage(e, { botUser } = {}) {
  const k = e.kind;
  const meta = ACT[k]; if (!meta) return null;
  const [emoji, verb, sep] = meta;
  const author = e.actor, target = e.target;
  const nPhotos = (e.images || []).length, video = !!e.hasVideo;
  const pre = (video ? "🎥" : "🖼️".repeat(nPhotos)) + emoji;
  const parentLink = target && e.parentId ? `${FX}/${target}/status/${e.parentId}` : null;
  const preHtml = (parentLink && REPLYLIKE.has(k)) ? `<a href="${parentLink}">${pre}</a>` : pre;

  let head;
  if (k === "tweet") head = `${preHtml} <b>${esc(author)}</b> ${verb}`;
  else if (k === "retweet") head = `${preHtml} <b>${esc(author)}</b> <code>${verb}</code> <b>${esc(target)}</b>`;
  else if (k === "reply") head = `${preHtml} <b>${esc(author)}</b> <code>${verb}</code> <b>${esc(target)}</b>`;
  else if (k === "pinned" || k === "unpinned") head = `${preHtml} <b>${esc(author)}</b> <b>${verb}</b> <b>${esc(target)}</b>`;
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
  else if (parentLink && REPLYLIKE.has(k)) lpo = { url: parentLink, show_above_text: false, prefer_large_media: true };
  else lpo = { is_disabled: true };

  // nút inline. Noti gửi DM sẵn nên không cần nút mở-bot; thay bằng 🗑 Delete để user
  // xoá chính tin noti này (callback "del" -> FE deleteMessage).
  const rows = [];
  const del = { text: "🗑 Delete", callback_data: "del" };
  if (k === "followed" || k === "unfollowed") {
    rows.push([del]);
    if (target) rows.push([{ text: "View Followed Account", url: `https://x.com/${target}/` }]);
    if (target && botUser) rows.push([{ text: `QA: ${target}`, url: `https://t.me/${botUser}?start=qa+${target}` }]);
  } else {
    const row = [del];
    if (e.tweetId && author) row.push({ text: "View Tweet", url: `https://x.com/${author}/status/${e.tweetId}` });
    rows.push(row);
  }
  return { text, link_preview_options: lpo, reply_markup: { inline_keyboard: rows } };
}

export { ACT, esc };
