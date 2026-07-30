// capture_frames.mjs — debug: mở 1 shard Bloom, in mọi frame; DUMP đầy đủ frame
// activity/enrichment (để soi cấu trúc thật, vd đổi avatar). `node scripts/capture_frames.mjs`
//   - Stream gọn: [tweet:REPLY] [compliance:delete] ...
//   - Frame activity/enrichment: in full JSON + ghi vào data/frames.log
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connect, close } from "../shared/mongo.mjs";
import * as repo from "../shared/repo.mjs";
import { cfg } from "../shared/config.mjs";
import { BloomShard } from "../be/pool.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const LOG = join(__dir, "..", "data", "frames.log");
mkdirSync(dirname(LOG), { recursive: true });

await connect();
const accts = await repo.listBloomAccounts(true);
if (!accts.length) { console.error("Chưa có shard nào. npm run seed trước."); process.exit(1); }

console.log("🎥 Capture đang chạy. Đổi avatar/bio/follow từ account đang track để xem frame.");
console.log("   Stream: [type:subtype]  |  activity/enrichment sẽ in full + ghi data/frames.log\n");

// id riêng => profile dir riêng (chạy song song BE không đụng be/state/profile-1)
const shard = new BloomShard({ ...accts[0], id: "capture" }, {
  headless: cfg.headless,
  onExpired: () => console.error("⚠️ session hết hạn"),
  onFrame: (f) => {
    const t = f.type;
    if (t === "activity" || t === "enrichment") {
      const tag = f.data?.event || f.data?.type || "";
      console.log(`\n=== FRAME ${t} ${tag} ===`);
      console.log(JSON.stringify(f, null, 2).slice(0, 3000));
      try { appendFileSync(LOG, JSON.stringify(f) + "\n"); } catch {}
    } else {
      process.stdout.write(`[${t}${f.data?.type ? ":" + f.data.type : ""}${f.data?.event_type ? ":" + f.data.event_type : ""}] `);
    }
  },
});
await shard.start();

process.on("SIGINT", async () => { await shard.stop(); await close(); process.exit(0); });
