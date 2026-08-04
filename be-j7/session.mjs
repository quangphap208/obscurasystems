// session.mjs (BE j7) — quản lý JWT session của j7 (đọc/ghi + validate + rotate).
// Auth RIÊNG của nguồn j7 (KHÁC Bloom cookie+PoW). Cơ chế xoay token: gọi /api/session-check với
// header x-session-id; server trả header X-New-Token (khi token gần hết hạn) -> lưu đè, dùng reconnect.
// Port từ j7-kol-router/lib/session.mjs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Token ưu tiên file rotate (state/), fallback token gốc trong .env.
export function loadToken(tokenFile, envToken) {
  try { const t = readFileSync(tokenFile, "utf8").trim(); if (t) return t; } catch {}
  return envToken;
}
export function saveToken(tokenFile, token) {
  try { mkdirSync(dirname(tokenFile), { recursive: true }); writeFileSync(tokenFile, token + "\n"); } catch {}
}

// exp (ms) từ payload JWT; 0 nếu không đọc được.
export function tokenExp(token) {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return (JSON.parse(Buffer.from(p, "base64").toString()).exp || 0) * 1000;
  } catch { return 0; }
}
export function daysLeft(token) {
  const e = tokenExp(token);
  return e ? (e - Date.now()) / 86400000 : NaN;
}

// Gọi /api/session-check. Trả { valid, rotated(token mới|null), status }.
export async function sessionCheck(host, token) {
  const res = await fetch(`${host}/api/session-check`, {
    headers: {
      "x-session-id": token,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Origin": "https://j7tracker.io",
      "User-Agent": "Mozilla/5.0",
    },
  });
  const body = await res.json().catch(() => ({}));
  const fresh = res.headers.get("x-new-token");
  return { valid: !!body.valid, rotated: fresh && fresh !== token ? fresh : null, status: res.status };
}
