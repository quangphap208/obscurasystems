// features.mjs — ánh xạ 20 feature Redacted -> nguồn Bloom (từ research reverse-engineer).
// Dùng để: (1) FE hiển thị gate đúng, (2) tài liệu hoá BE phục vụ được gì.
// Nguồn: docs/x_account_features.md + bloom_vs_redacted.md.

// fulfilled: BE lấy được từ feed Bloom | via: frame Bloom tương ứng
export const FEATURE_SOURCE = {
  tweets:            { fulfilled: true,  via: "frame tweet · data.type=TWEET" },
  quotes:            { fulfilled: true,  via: "frame tweet · data.type=QUOTE" },
  retweets:          { fulfilled: true,  via: "frame tweet · data.type=RETWEET (body ở parent_tweet)" },
  replies:           { fulfilled: true,  via: "frame tweet · data.type=REPLY" },
  photos:            { fulfilled: true,  via: "data.media.images (pbs.twimg.com)" },
  videos:            { fulfilled: true,  via: "data.media.videos (d.fxtwitter.com)" },
  follows:           { fulfilled: true,  via: "activity follow.follow" },
  unfollows:         { fulfilled: true,  via: "activity follow.unfollow" },
  profileChanges:    { fulfilled: true,  via: "activity profile.update.* (9 sub-type)" },
  affiliations:      { fulfilled: true,  via: "activity profile.update.affiliate_badge" },
  deletedTweets:     { fulfilled: true,  via: "compliance delete + tweet_cache" },
  suspensions:       { fulfilled: true,  via: "compliance user_suspend/unsuspend" },
  deactivations:     { fulfilled: true,  via: "compliance user_delete/undelete" },
  OCR:               { fulfilled: true,  via: "enrichment · useOcr (cần wiring, v1 gate)" },
  // Bloom KHÔNG phát — gate ở FE:
  muted:             { fulfilled: false, via: "Bloom chỉ mute cục bộ, không phát event" },
  spaces:            { fulfilled: false, via: "Bloom không theo dõi X Spaces" },
  pins:              { fulfilled: false, via: "Bloom không phát event pin" },
  unpins:            { fulfilled: false, via: "Bloom không phát event pin" },
  trendingTweets:    { fulfilled: false, via: "cần hạ tầng quét hàng nghìn channel" },
  trendingProfiles:  { fulfilled: false, via: "cần hạ tầng quét hàng nghìn channel" },
};

export const isFulfilled = (key) => FEATURE_SOURCE[key]?.fulfilled ?? false;
