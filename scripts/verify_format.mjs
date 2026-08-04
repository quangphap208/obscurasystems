// verify_format.mjs — self-test format module: render mẫu 7 loại tin (send_like_source.md §12).
// Không cần DB/network. `npm run verify`.
import { normalize } from "../be/normalize.mjs";
import { buildMessage } from "../be-core/message.mjs";

const B = { botUser: "kolbot" };
const F = [
  ["Tweeted + video", { type: "tweet", data: { type: "TWEET", id: "2082656239780266487", author: { screen_name: "elonmusk" }, text: "Grok Imagine", media: { videos: ["v"] } } }],
  ["Replied To", { type: "tweet", data: { type: "REPLY", id: "1", author: { screen_name: "elonmusk" }, text: "@kane Looks creepy 😬", parent_tweet: { id: "2082608592839229649", author: { screen_name: "kane" } } } }],
  ["Retweeted (no media)", { type: "tweet", data: { type: "RETWEET", id: "2", author: { screen_name: "elonmusk" }, parent_tweet: { id: "9", author: { screen_name: "ZiaYusufUK" }, text: "So, the rules are…" } } }],
  ["Retweeted + photo", { type: "tweet", data: { type: "RETWEET", id: "3", author: { screen_name: "elonmusk" }, parent_tweet: { id: "8", author: { screen_name: "alanvibe" }, text: "Allison Pearson receives payout…", media: { images: ["https://pbs.twimg.com/media/HOa9WjzWoAAz10K.jpg"] } } } }],
  ["Quoted", { type: "tweet", data: { type: "QUOTE", id: "4", author: { screen_name: "elonmusk" }, text: "It will happen", parent_tweet: { id: "2082498584650416155", author: { screen_name: "PeterDiamandis" } } } }],
  ["Deleted (photo)", { type: "compliance", data: { event_type: "delete", entity_id: "5", author_id: "44", tweet_content: { author: { screen_name: "cz_binance" }, text: "Brutal... Hope this marks the bottom. Stay SAFU!", media: { images: ["https://pbs.twimg.com/media/HOKIDdQa0AA-4lf.jpg"] } } } }],
  ["followed", { type: "activity", data: { type: "follow.follow", actor: { screen_name: "elonmusk" }, target: { screen_name: "dhh", name: "DHH", friends_count: 201, followers_count: 769233, description: "Father of three, Creator of Ruby on Rails + Omarchy", location: null, url: "https://dhh.dk" } } }],
];

for (const [name, frame] of F) {
  const e = normalize(frame);
  const m = buildMessage(e, B);
  console.log("──", name, "(kind=" + e.kind + ")");
  console.log(m.text);
  console.log("preview:", JSON.stringify(m.link_preview_options));
  console.log("buttons:", JSON.stringify((m.reply_markup?.inline_keyboard || []).map((r) => r.map((b) => b.text))));
  console.log();
}
console.log("✅ format self-test xong. So mắt với docs/send_like_source.md §12.");
