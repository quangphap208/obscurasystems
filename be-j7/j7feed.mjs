// j7feed.mjs (BE j7) — INGEST: đọc feed KOL realtime từ j7tracker.io qua socket.io (JWT auth).
// Không cần Playwright/PoW — chỉ 1 socket thuần (auth khác Bloom hoàn toàn). Port từ j7-kol-router.
//
// Luồng: connect (auth:{token}) -> emit "user_connected" <token> để MỞ feed ->
//   "initialTweets" (backlog, mảng ~100)  |  "tweet" (live)  |  "tweet_deleted"  |  hoạt động profile.
import { io } from "socket.io-client";

export class J7Feed {
  // onEvent(rawTweet, kind)   kind ∈ {"initial","tweet","deleted","update","external",
  //   "followed","unfollowed","pinned","unpinned","profile","affiliation","deactivated","suspended"}
  constructor({ host, token, onEvent, onLog, onAuthError }) {
    this.host = host;
    this.token = token;
    this.onEvent = onEvent;
    this.onLog = onLog || (() => {});
    this.onAuthError = onAuthError || (() => {});
    this.socket = null;
  }

  start() {
    const socket = io(this.host, {
      transports: ["websocket"], upgrade: false,
      auth: { token: this.token },
      reconnection: true, reconnectionAttempts: Infinity,
      reconnectionDelay: 2000, reconnectionDelayMax: 30000, timeout: 10000,
    });
    this.socket = socket;

    socket.on("connect", () => {
      socket.emit("user_connected", this.token);   // <-- BẮT BUỘC để server bắt đầu đẩy feed
      this.onLog(`🟢 j7 connected (${socket.id})`);
    });

    socket.on("initialTweets", (arr) => {
      if (!Array.isArray(arr)) return;
      for (const t of arr) this.onEvent(t, "initial");
    });
    socket.on("tweet",         (t) => this.onEvent(t, "tweet"));
    socket.on("tweet_deleted", (t) => this.onEvent(t, "deleted"));
    socket.on("tweet_update",  (t) => this.onEvent(t, "update"));
    // post nền tảng ngoài: Truth Social / Instagram (+ BinanceSquare/card/video-update) đều về đây
    socket.on("external_message", (e) => this.onEvent(e, "external"));
    // activity (follow/unfollow/pin/unpin) — j7 có, Bloom thiếu
    socket.on("following_update",        (e) => this.onEvent(e, "followed"));
    socket.on("unfollowing_update",      (e) => this.onEvent(e, "unfollowed"));
    socket.on("profile_pinned_update",   (e) => this.onEvent(e, "pinned"));
    socket.on("profile_unpinned_update", (e) => this.onEvent(e, "unpinned"));
    // profile change (name/bio/avatar/…, affiliation, deactivate, suspend)
    socket.on("profile_update",             (e) => this.onEvent(e, "profile"));
    socket.on("profile_affiliation_update", (e) => this.onEvent(e, "affiliation"));
    socket.on("profile_deactivated_update", (e) => this.onEvent(e, "deactivated"));
    socket.on("profile_suspended_update",   (e) => this.onEvent(e, "suspended"));

    socket.on("auth_error", () => this.onAuthError("auth_error"));
    socket.on("connect_error", (e) => {
      const m = e && e.message ? e.message : String(e);
      if (/Invalid token|Account disabled/i.test(m)) this.onAuthError(m);
      else this.onLog(`[j7] connect_error: ${m}`);
    });
    socket.on("disconnect", (r) => this.onLog(`[j7] disconnect: ${r}`));
    return socket;
  }

  // Cập nhật token (sau khi rotate) — áp cho lần reconnect kế tiếp.
  updateToken(token) {
    this.token = token;
    if (this.socket) this.socket.auth = { token };
  }

  // Passthrough cho tracker-sync-j7 dùng chung 1 socket (get_all_watched_accounts + add/remove pool).
  emit(event, payload) { if (this.socket) this.socket.emit(event, payload); }
  on(event, cb) { if (this.socket) this.socket.on(event, cb); return this; }

  stop() { if (this.socket) { try { this.socket.disconnect(); } catch {} } }
}
