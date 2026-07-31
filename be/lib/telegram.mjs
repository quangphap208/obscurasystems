// telegram.mjs — gửi Telegram Bot API: hàng đợi per-chat + rate-limit 429.
// Payload dựng từ format.buildMessage: { text, link_preview_options, reply_markup }.
const API = (token, m) => `https://api.telegram.org/bot${token}/${m}`;

export class Telegram {
  constructor(token) { this.token = token; this.queues = new Map(); }

  // enqueue theo từng chatId (tuần tự, ~1.1s/tin để né rate-limit per-chat).
  // priority=true -> chen lên đầu hàng (vd delete: không đợi sau đống tweet đang xếp hàng).
  send(chatId, payload, { priority = false } = {}) {
    if (!chatId) return;
    if (!this.queues.has(chatId)) this.queues.set(chatId, { q: [], draining: false });
    const st = this.queues.get(chatId);
    if (priority) st.q.unshift(payload); else st.q.push(payload);
    this._drain(chatId);
  }

  async _drain(chatId) {
    const st = this.queues.get(chatId);
    if (st.draining) return;
    st.draining = true;
    while (st.q.length) {
      const p = st.q.shift();
      try { await this._deliver(chatId, p); }
      catch (e) {
        // lỗi mạng tạm thời -> nhét lại đầu hàng, backoff dần (tối đa 5 lần ~2.5 phút) rồi mới bỏ.
        // Lỗi cứng (400/403...) thì bỏ luôn: retry không cứu được.
        const transient = /fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN|socket|abort/i.test(e.message);
        const tries = (p._tries = (p._tries || 0) + 1);
        if (transient && tries <= 5) {
          st.q.unshift(p);
          console.warn(`[tg] ${chatId} ${e.message} — retry ${tries}/5`);
          await new Promise((r) => setTimeout(r, Math.min(2000 * 3 ** (tries - 1), 60000)));
          continue;
        }
        console.warn("[tg]", chatId, e.message, transient ? "(bỏ sau 5 lần retry)" : "");
      }
      await new Promise((r) => setTimeout(r, 1100));
    }
    st.draining = false;
  }

  async _call(method, body) {
    const res = await fetch(API(this.token, method), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      const wait = ((j.parameters && j.parameters.retry_after) || 2) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return this._call(method, body);
    }
    if (!res.ok) throw new Error(`${method} ${res.status} ${(await res.text()).slice(0, 160)}`);
    return res.json();
  }

  async _deliver(chatId, msg) {
    const body = { chat_id: chatId, text: msg.text, parse_mode: "HTML" };
    if (msg.link_preview_options) body.link_preview_options = msg.link_preview_options;
    if (msg.reply_markup) body.reply_markup = msg.reply_markup;
    return this._call("sendMessage", body);
  }

  // gửi ngay, không queue (cảnh báo admin)
  async notify(chatId, text) {
    if (!chatId) return;
    try { await this._call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }); }
    catch (e) { console.warn("[tg notify]", e.message); }
  }

  async getMe() { try { const r = await this._call("getMe", {}); return r.result; } catch { return null; } }
}
