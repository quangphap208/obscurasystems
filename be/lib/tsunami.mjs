// tsunami.mjs — client REST mã hoá cho Bloom "tsunami" (tsunami.bloombot.app).
// Giao thức: handshake lấy transport_key (AES-256-GCM), rồi mỗi request gói frame:
//   [version=1 | IV 12B | ciphertext(+tag)]  -> base64url,  AAD = "METHOD path".
// Auth bằng cookie __Secure-session_token. (Reimplement từ research Bloom, viết mới cho project này.)

const TSUNAMI = "https://tsunami.bloombot.app";

const b64urlToBytes = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  return Uint8Array.from(Buffer.from(s, "base64"));
};
const bytesToB64url = (u) =>
  Buffer.from(u).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const cookieHeader = (session, base = {}) => ({ ...base, Cookie: `__Secure-session_token=${session}` });

export async function handshake(session) {
  const r = await fetch(`${TSUNAMI}/api/handshake`, { headers: cookieHeader(session) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`handshake ${r.status}: ${txt.slice(0, 200)}`);
  const j = JSON.parse(txt);
  if (!j.success || !j.data?.transport_key) throw new Error("handshake invalid: " + txt.slice(0, 200));
  const raw = b64urlToBytes(j.data.transport_key);
  if (raw.length !== 32) throw new Error("bad key size " + raw.length);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptFrame(key, method, path, bodyBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(`${method} ${path}`);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, bodyBytes));
  const frame = new Uint8Array(13 + ct.length);
  frame[0] = 1; frame.set(iv, 1); frame.set(ct, 13);
  return bytesToB64url(frame);
}

async function decryptFrame(key, method, path, respText) {
  const i = b64urlToBytes(respText);
  if (i.length < 29) throw new Error("frame too short: " + respText.slice(0, 120));
  if (i[0] !== 1) throw new Error("bad frame version " + i[0]);
  const iv = i.slice(1, 13), ct = i.slice(13);
  const aad = new TextEncoder().encode(`${method} ${path}`);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, ct);
  return new Uint8Array(pt);
}

// Gửi 1 request mã hoá; trả về payload đã parse (.data như app).
export async function tsunamiRequest(session, key, method, path, body) {
  const bodyBytes = body !== undefined ? new TextEncoder().encode(JSON.stringify(body)) : new Uint8Array(0);
  const frame = await encryptFrame(key, method, path, bodyBytes);
  const r = await fetch(`${TSUNAMI}${path}`, {
    method,
    headers: cookieHeader(session, { "Content-Type": "text/plain; charset=utf-8" }),
    body: method === "GET" || method === "HEAD" ? undefined : frame,
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${txt.slice(0, 200)}`);
  const pt = await decryptFrame(key, method, path, txt);
  const parsed = JSON.parse(new TextDecoder().decode(pt));
  if (parsed && parsed.success === false) throw new Error(parsed.error || `tsunami error ${path}`);
  return parsed.data !== undefined ? parsed.data : parsed;
}

// ---- helpers cấp cao cho tracker sync ----

// Tìm user X theo handle. Trả {found:[{twitter_handle,twitter_id|screen_name}], notFound:[]}.
export async function searchUsers(session, key, usernames) {
  const res = await tsunamiRequest(session, key, "POST", "/api/twitter/search", { usernames });
  return { found: res.users ?? [], notFound: res.notFound ?? res.not_found ?? [] };
}
// Thêm account vào tracker của session này.
export async function trackNames(session, key, names) {
  const res = await tsunamiRequest(session, key, "POST", "/api/twitter/track", { twitter_names: names });
  return { added: res.added ?? [], notFound: res.notFound ?? res.not_found ?? [] };
}
// Bỏ theo dõi. Bloom nhận theo id hoặc handle tuỳ endpoint — thử id trước.
export async function untrackNames(session, key, names) {
  return tsunamiRequest(session, key, "POST", "/api/twitter/untrack", { twitter_names: names });
}
// Danh sách account đang tracked của session này (để đo cap thực).
export async function fetchState(session, key) {
  const st = await tsunamiRequest(session, key, "GET", "/api/twitter/state");
  return st.accounts ?? [];
}

export { b64urlToBytes, bytesToB64url };
