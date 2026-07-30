// pool.mjs — Bloom Pool Manager: mỗi tài khoản Bloom = 1 shard (1 Playwright context + session).
// Mỗi shard mở /trackers bằng browser thật (bắt buộc để qua quantum PoW), tap JSON.parse để
// bắt frame WS đã giải mã, đẩy về dispatcher chung. Shard chỉ nhận event của handle mà session
// đó đang track (tracker-sync lo việc track/untrack qua REST cùng session).
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const __dir = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dir, "state");
const APP = "https://manager.bloombot.app";
const TRACKERS_URL = `${APP}/trackers`;

// Patch JSON.parse trong trang để mọi frame WS giải mã đều lộ qua window.__tap.
const TAP_INIT = () => {
  const WANT = new Set(["tweet", "retweet", "quote", "reply", "compliance", "activity", "enrichment"]);
  const orig = JSON.parse;
  JSON.parse = function (...a) {
    const out = orig.apply(this, a);
    try { if (out && typeof out === "object" && WANT.has(out.type) && out.data) window.__tap && window.__tap(out); } catch {}
    return out;
  };
};

export class BloomShard {
  constructor(account, { headless = true, onFrame, onExpired }) {
    this.account = account;           // { id, label, session_token, ... }
    this.headless = headless;
    this.onFrame = onFrame;
    this.onExpired = onExpired;
    this.ctx = null; this.page = null; this.alive = false;
  }

  async start() {
    const profileDir = join(STATE_DIR, `profile-${this.account.id}`);
    mkdirSync(profileDir, { recursive: true });
    this.ctx = await chromium.launchPersistentContext(profileDir, {
      headless: this.headless, viewport: { width: 1440, height: 900 },
      args: ["--disable-blink-features=AutomationControlled"],
    });
    await this.ctx.addCookies([{
      name: "__Secure-session_token", value: this.account.session_token,
      domain: ".bloombot.app", path: "/", secure: true, httpOnly: true, sameSite: "None",
    }]);
    await this.ctx.exposeBinding("__tap", (_s, frame) => { try { this.onFrame(frame, this.account); } catch (e) { console.warn("[frame]", e.message); } });
    await this.ctx.addInitScript(TAP_INIT);

    this.page = this.ctx.pages()[0] || (await this.ctx.newPage());
    this.page.on("console", (m) => { if (m.text().includes("[Tracker] WS Open")) console.log(`🟢 shard ${this.account.id} WS connected`); });

    await this.page.goto(TRACKERS_URL, { waitUntil: "domcontentloaded" });
    if (this.page.url().includes("/login")) { await this._expire(); return false; }
    this.alive = true;
    console.log(`✅ shard ${this.account.id} (${this.account.label || "bloom"}) chạy`);

    this._watch = setInterval(async () => {
      try {
        if (this.page.isClosed()) return;
        if (this.page.url().includes("/login")) { await this._expire(); }
      } catch {}
    }, 30000);
    return true;
  }

  async _expire() {
    if (!this.alive && this.expired) return;
    this.expired = true; this.alive = false;
    console.error(`⚠️ shard ${this.account.id} session hết hạn (redirect /login)`);
    try { await this.onExpired?.(this.account); } catch {}
  }

  async refresh() { try { if (this.page && !this.page.isClosed()) await this.page.goto(TRACKERS_URL, { waitUntil: "domcontentloaded" }); } catch {} }
  async stop() { clearInterval(this._watch); try { await this.ctx?.close(); } catch {} }
}

export class BloomPool {
  constructor({ headless, onFrame, onExpired }) {
    this.headless = headless; this.onFrame = onFrame; this.onExpired = onExpired; this.shards = new Map();
  }
  async startAll(accounts) {
    for (const acc of accounts) {
      const shard = new BloomShard(acc, { headless: this.headless, onFrame: this.onFrame, onExpired: this.onExpired });
      this.shards.set(acc.id, shard);
      await shard.start();
    }
    return [...this.shards.values()].filter((s) => s.alive).length;
  }
  get(id) { return this.shards.get(id); }
  async stopAll() { for (const s of this.shards.values()) await s.stop(); }
}

export { TRACKERS_URL };
