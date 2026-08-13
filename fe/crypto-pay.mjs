// crypto-pay.mjs — thanh toán crypto trên SOLANA (USDC/USDT-SPL + SOL) — auto-poll + unique-amount.
// NHIỀU ví nhận + NHIỀU RPC (Infura): round-robin/failover RPC, spread invoice qua các ví.
// Non-custodial; match tx theo (VÍ + mint/SOL + số base-unit LẺ DUY NHẤT/invoice/ví).
// Poller CHỈ chạy ở FE (1 instance) -> no double-credit. docs/PAYMENT_RESEARCH.md §3-5.
// Correctness: claimInvoice() (pending->paid atomic) chống double; sigSeen/markSigSeen chỉ đỡ re-parse.
import { cfg } from "../shared/config.mjs";
import * as repo from "../shared/repo.mjs";
import { slackAlert, paymentHook } from "../shared/slack.mjs";

const SOL_MINT = "So11111111111111111111111111111111111111112";
// coin -> {decimals, mint(null=SOL), label, step lẻ (base units), dp hiển thị}
const COINS = {
  usdc: { decimals: 6, mint: () => cfg.usdcMint, label: "USDC", step: 1000, dp: 3 },
  usdt: { decimals: 6, mint: () => cfg.usdtMint, label: "USDT", step: 1000, dp: 3 },
  sol:  { decimals: 9, mint: () => null,         label: "SOL",  step: 1,    dp: 9 },
};
export const COIN_KEYS = Object.keys(COINS);
export const cryptoEnabled = () => cfg.receiveSolAddresses.length > 0 && cfg.solanaRpcUrls.length > 0;
const dbg = (...a) => { if (process.env.CRYPTO_DEBUG === "1") console.log("[crypto]", ...a); };

function priceUsd(kind) {
  if (kind === "whale") return cfg.whalePriceUsd;
  if (kind === "pack") return cfg.packPriceUsd;
  return cfg.proPriceUsd;
}

// ---- Solana JSON-RPC: round-robin + failover qua nhiều endpoint ----
let rpcIdx = 0, reqId = 0;
async function rpc(method, params) {
  const urls = cfg.solanaRpcUrls;
  let lastErr;
  for (let i = 0; i < urls.length; i++) {          // thử tối đa mọi endpoint (failover)
    const url = urls[(rpcIdx++) % urls.length];    // round-robin (spread tải)
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++reqId, method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    } catch (e) { lastErr = e; dbg("rpc fail", method, e.message); }
  }
  throw lastErr || new Error("no rpc url");
}

// giá SOL/USD (Jupiter price API) — khoá lúc tạo invoice
async function solPriceUsd() {
  try {
    const r = await fetch(`https://api.jup.ag/price/v2?ids=${SOL_MINT}`);
    const j = await r.json();
    const p = Number(j?.data?.[SOL_MINT]?.price);
    return p > 0 ? p : null;
  } catch { return null; }
}

// chọn ví ÍT pending nhất cho coin (spread tải + tăng headroom unique-amount)
function pickWallet(pend) {
  const cnt = new Map(cfg.receiveSolAddresses.map((w) => [w, 0]));
  for (const p of pend) if (cnt.has(p.address)) cnt.set(p.address, cnt.get(p.address) + 1);
  let best = cfg.receiveSolAddresses[0], min = Infinity;
  for (const w of cfg.receiveSolAddresses) { const c = cnt.get(w); if (c < min) { min = c; best = w; } }
  return best;
}

// ---- tạo invoice: chọn ví + cấp số base-unit lẻ DUY NHẤT/(coin,ví) ----
export async function makeInvoice(tgId, kind, coin) {
  if (!cryptoEnabled()) return { error: "crypto_disabled" };
  const c = COINS[coin]; if (!c) return { error: "bad_coin" };
  const usd = priceUsd(kind);
  let base;
  if (coin === "sol") {
    const px = await solPriceUsd();
    if (!px) return { error: "price_unavailable" };
    base = Math.round((usd / px) * 10 ** c.decimals);   // lamports
  } else {
    base = Math.round(usd * 10 ** c.decimals);          // 6 decimals
  }
  const pend = await repo.listPendingInvoices(coin);
  const address = pickWallet(pend);
  const used = new Set(pend.filter((p) => p.address === address).map((p) => p.expect_base));   // unique theo (coin, VÍ)
  let expectBase = 0;
  for (let s = 1; s <= 999; s++) { const cand = base + s * c.step; if (!used.has(cand)) { expectBase = cand; break; } }
  if (!expectBase) return { error: "too_many_pending" };
  const display = (expectBase / 10 ** c.decimals).toFixed(c.dp);
  const inv = await repo.createCryptoInvoice({
    tgId, kind, coin, mint: c.mint(), decimals: c.decimals, expectBase, display,
    priceUsd: usd, address, windowMin: cfg.cryptoWindowMin, graceH: cfg.cryptoLateGraceH,
  });
  const u = await repo.getUser(tgId);   // audit: nếu auto-credit hỏng, biết ai chờ + số/ví để /grant tay
  paymentHook(`📝 Crypto invoice · ${u?.username ? "@" + u.username : "(no username)"} (${tgId}) · ${kind} · ${c.label} · send ${display} → ${address.slice(0, 6)}…${address.slice(-4)} · exp ${cfg.cryptoWindowMin}m`);
  return { ok: true, invoice: inv, address, amount: display, coin: c.label, expiresAt: inv.expires_at };
}

// ---- số nhận vào 1 VÍ cụ thể từ 1 tx -> {sol: lamports, <mint>: baseUnits} (BigInt) ----
function receivedDeltas(tx, addr) {
  const meta = tx?.meta; if (!meta) return {};
  const keys = (tx?.transaction?.message?.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
  const out = {};
  const i = keys.indexOf(addr);
  if (i >= 0 && Array.isArray(meta.preBalances) && Array.isArray(meta.postBalances)) {
    const d = BigInt(meta.postBalances[i]) - BigInt(meta.preBalances[i]);
    if (d > 0n) out.sol = d;
  }
  const pre = new Map();
  for (const b of meta.preTokenBalances || []) if (b.owner === addr) pre.set(b.mint, BigInt(b.uiTokenAmount.amount));
  for (const b of meta.postTokenBalances || []) if (b.owner === addr) {
    const d = BigInt(b.uiTokenAmount.amount) - (pre.get(b.mint) || 0n);
    if (d > 0n) out[b.mint] = d;
  }
  return out;
}

// ---- match tx (nhận vào `wallet`) với invoice pending + credit (atomic) ----
async function tryCredit(bot, sig, tx, wallet) {
  const deltas = receivedDeltas(tx, wallet);
  if (!Object.keys(deltas).length) return null;
  for (const coin of COIN_KEYS) {
    const c = COINS[coin];
    const key = coin === "sol" ? "sol" : c.mint();
    const got = deltas[key]; if (got == null) continue;
    const pend = await repo.listPendingInvoices(coin);
    const hit = pend.find((p) => p.address === wallet && BigInt(p.expect_base) === got);
    if (!hit) continue;
    if (!(await repo.claimInvoice(hit._id, sig))) return null;   // đã credit trước đó
    const res = await repo.applyPurchase(hit.tg_id, hit.kind);
    await repo.recordPayment({ tgId: hit.tg_id, method: "crypto", kind: hit.kind, amount: hit.display, currency: c.label, usd: hit.price_usd ?? null, ref: sig });
    await repo.markReferralSubscribed(hit.tg_id);
    await repo.awardRefConvert(hit.tg_id, { amount: hit.price_usd, currency: c.label, chargeId: sig });
    dbg("credited", hit._id, coin, hit.kind, "ví", wallet.slice(0, 6), "-> limit", res?.account_limit);
    const bu = await repo.getUser(hit.tg_id);
    paymentHook(`✅ Crypto PAID · ${bu?.username ? "@" + bu.username : ""} (${hit.tg_id}) · ${hit.kind} · ${c.label} ${hit.display} · tx ${sig.slice(0, 8)}… · limit ${res?.account_limit ?? "?"}`);
    try {
      const line = hit.kind === "pack"
        ? `✅ Crypto payment received! <b>+${cfg.packSize}</b> accounts — new limit <b>${res?.account_limit ?? "updated"}</b>.`
        : `✅ Crypto payment confirmed! <b>${res?.tier ?? hit.kind}</b> plan, limit <b>${res?.account_limit ?? ""}</b> accounts.`;
      await bot.api.sendMessage(hit.tg_id, line, { parse_mode: "HTML" });
    } catch {}
    return { credited: hit, res };
  }
  return null;
}

// ---- health check RPC (Infura live/dead) — che key khi log ----
const maskUrl = (u) => { try { const x = new URL(u); const k = x.pathname.split("/").pop(); return `${x.host}/…${k && k.length > 4 ? k.slice(-4) : ""}`; } catch { return "(invalid url)"; } };
async function probe(url) {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getVersion" }) });
    const j = await r.json();
    return !!j.result;   // getVersion trả {solana-core,...} nếu URL/key OK
  } catch { return false; }
}
// [{url, ok}] cho từng RPC — dùng ở boot + có thể gắn /admin.
export async function checkRpcHealth() {
  const out = [];
  for (const u of cfg.solanaRpcUrls) out.push({ url: u, ok: await probe(u) });
  return out;
}
async function alertOps(bot, text) {   // Slack (nếu bật) + DM admin
  slackAlert(text);
  for (const id of cfg.adminIds) { try { await bot.api.sendMessage(id, text); } catch {} }
}

// ---- poller (mỗi cryptoPollSec): quét TẤT CẢ ví ----
let running = false, rpcDownStreak = 0, rpcAlerted = false;
export function startPoller(bot) {
  if (!cryptoEnabled()) { console.log("[crypto] TẮT (thiếu RECEIVE_SOL_ADDRESS / SOLANA_RPC_URL)"); return null; }
  console.log(`[crypto] poller ON — ${cfg.receiveSolAddresses.length} ví · ${cfg.solanaRpcUrls.length} RPC · mỗi ${cfg.cryptoPollSec}s`);
  // Health probe lúc BOOT: bắt ngay URL sai / key chết (không phải đợi user báo).
  checkRpcHealth().then((res) => {
    res.forEach((r, i) => console.log(`[crypto] RPC #${i + 1} ${maskUrl(r.url)} ${r.ok ? "✓ live" : "✗ DEAD"}`));
    const alive = res.filter((r) => r.ok).length;
    if (alive === 0) alertOps(bot, `🔴 Crypto: TẤT CẢ ${res.length} RPC Solana DEAD — auto-credit KHÔNG chạy. Kiểm tra SOLANA_RPC_URL / Infura key: ${res.map((r) => maskUrl(r.url)).join(", ")}`);
    else if (alive < res.length) alertOps(bot, `🟡 Crypto: ${res.length - alive}/${res.length} RPC Solana dead (còn ${alive} live).`);
  }).catch(() => {});
  const tick = async () => {
    if (running) return; running = true;
    let ok = false;   // có gọi được RPC tick này? (phát hiện RPC chết)
    try {
      await repo.expireStaleInvoices();
      for (const wallet of cfg.receiveSolAddresses) {
        // Catch-up: phân trang từ MỚI->CŨ tới khi gặp sig ĐÃ xử lý (sigSeen bền qua restart nhờ Mongo)
        // -> KHÔNG bỏ sót payment kể cả bot down lâu + burst. Cap chặn quét vô hạn lần đầu (seen rỗng).
        let before, scanned = 0, stop = false;
        while (!stop && scanned < 300) {
          let sigs;
          try { sigs = await rpc("getSignaturesForAddress", [wallet, before ? { limit: 100, before } : { limit: 100 }]); ok = true; }
          catch (e) { dbg("getSigs err", wallet.slice(0, 6), e.message); break; }
          if (!sigs || !sigs.length) break;
          for (const s of sigs) {
            if (await repo.sigSeen(s.signature)) { stop = true; break; }   // tới cái đã xử lý -> đã bắt hết cái mới
            if (!s.err) {
              let tx; try { tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]); }
              catch (e) { dbg("getTx err", e.message); continue; }   // lỗi RPC -> chưa mark seen -> thử lại tick sau
              if (tx) { try { await tryCredit(bot, s.signature, tx, wallet); } catch (e) { dbg("credit err", e.message); } }
            }
            await repo.markSigSeen(s.signature);
          }
          before = sigs[sigs.length - 1].signature;
          scanned += sigs.length;
        }
      }
    } catch (e) { dbg("poll err", e.message); }
    finally {
      // Alert RPC chết: gọi RPC fail N tick liên tiếp -> báo 1 lần (Slack+admin); hồi phục -> báo lại.
      if (ok) { if (rpcAlerted) { alertOps(bot, "🟢 Crypto: RPC Solana đã hồi phục — auto-credit chạy lại."); rpcAlerted = false; } rpcDownStreak = 0; }
      else if (++rpcDownStreak >= 3 && !rpcAlerted) { rpcAlerted = true; alertOps(bot, `🔴 Crypto: RPC Solana không phản hồi ${rpcDownStreak} lần liên tiếp — auto-credit đang GIÁN ĐOẠN. Kiểm tra Infura.`); }
      running = false;
    }
  };
  tick();
  return setInterval(tick, cfg.cryptoPollSec * 1000);
}

// ---- /pay <sig> fallback: verify 1 sig thủ công (thử khớp trên mọi ví) ----
export async function verifyManual(bot, sig) {
  if (!cryptoEnabled()) return { error: "crypto_disabled" };
  let tx; try { tx = await rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]); }
  catch { return { error: "tx_not_found" }; }
  if (!tx) return { error: "tx_not_found" };
  for (const wallet of cfg.receiveSolAddresses) {
    const r = await tryCredit(bot, sig, tx, wallet);
    if (r?.credited) { await repo.markSigSeen(sig); return { ok: true, credited: r.credited }; }
  }
  await repo.markSigSeen(sig);
  return { error: "no_match" };
}
