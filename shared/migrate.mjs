// migrate.mjs — connect Atlas + tạo index, in số document mỗi collection. `npm run migrate`.
import { connect, close } from "./mongo.mjs";
import { collectionsInfo } from "./repo.mjs";
import { cfg } from "./config.mjs";

const db = await connect();
console.log("Mongo:", cfg.mongoDb, "@", cfg.mongoUri.replace(/\/\/[^@]*@/, "//***@"));
console.log("Collections:", await collectionsInfo());
console.log("✅ index đã tạo, migrate xong.");
await close();
