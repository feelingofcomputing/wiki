#!/usr/bin/env bun
// Reference implementation of the Slack→Colibri bridge backfill.
// See pages/slack-colibri-bridge.md for the design proposal this script realises.
//
// Reads a day's worth of Slack history JSON (Mariano's dump-history.js output)
// and publishes each message as a `social.colibri.message` record on a bot's
// atproto repo. Two-pass: top-level first, then thread replies with `parent`
// set from a deterministic TID derived from `thread_ts`.
//
// Channel lookup precedence:
//   1. tools/slack-to-colibri-channel.json (community-owner-pre-created channels)
//   2. otherwise deterministic rkey derived from Slack channel.created;
//      live mode lazy-creates the channel + updates the category's channelOrder
//      (needs COLIBRI_COMMUNITY_URI + COLIBRI_CATEGORY_RKEY).
//
// Rich text: when a message carries Slack's structured `blocks` (rich_text),
// it's walked into Colibri `text + facets` covering mentions, channels, links,
// bold/italic/strikethrough/code, code blocks, quotes, lists, and emoji
// (resolved via vendor/feeling-of-computing/conversations/src/emoji-data.js).
// Falls back to the legacy `text` field with regex link extraction when
// `blocks` is absent (older Slack messages, app-posted messages without blocks).
//
// Idempotent: every rkey is derived from Slack identifiers; uses putRecord.
// Dry-run by default. Pass --live to publish.
// --live always needs BSKY_HANDLE + BSKY_APP_PASSWORD.

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const PDS = "https://bsky.social";
const USERS_JSON = "vendor/feeling-of-computing/history/users.json";
const CHANNELS_JSON = "vendor/feeling-of-computing/history/channels.json";
const SLACK_TO_DID_JSON = "tools/slack-to-did.json";
const SLACK_TO_COLIBRI_CHANNEL_JSON = "tools/slack-to-colibri-channel.json";
const EMOJI_DATA_JS =
  "vendor/feeling-of-computing/conversations/src/emoji-data.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "src-day": { type: "string" },
    "src-dir": {
      type: "string",
      default: "vendor/feeling-of-computing/history",
    },
    limit: { type: "string", default: "1000" },
    live: { type: "boolean", default: false },
    "delay-ms": { type: "string", default: "200" },
  },
});

if (!values["src-day"]) {
  console.error("usage: bun pages/slack-colibri-bridge.ts --src-day YYYY/MM/DD [--limit N] [--live]");
  process.exit(1);
}

const srcDay = values["src-day"]!;
const srcDir = values["src-dir"]!;
const limit = parseInt(values.limit!, 10);
const dryRun = !values.live;
const delayMs = parseInt(values["delay-ms"]!, 10);

// ── reference data ──────────────────────────────────────────────────────────
type SlackUser = {
  id: string;
  name?: string;
  real_name?: string;
  profile?: { display_name?: string };
};
const users: SlackUser[] = JSON.parse(readFileSync(USERS_JSON, "utf-8"));
const nameOf = new Map<string, string>(
  users.map((u) => [u.id, u.profile?.display_name || u.real_name || u.name || u.id]),
);

type SlackChannel = { id: string; name: string; created: number };
const channels: SlackChannel[] = JSON.parse(readFileSync(CHANNELS_JSON, "utf-8"));
const channelOf = new Map<string, SlackChannel>(channels.map((c) => [c.id, c]));

const SLACK_TO_DID: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  try {
    const raw = JSON.parse(readFileSync(SLACK_TO_DID_JSON, "utf-8"));
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("_")) continue;
      const did = typeof v === "string" ? v : (v as any)?.did;
      if (did) map[k] = did;
    }
  } catch {}
  return map;
})();

const MANUAL_CHANNELS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  try {
    const raw = JSON.parse(readFileSync(SLACK_TO_COLIBRI_CHANNEL_JSON, "utf-8"));
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("_")) continue;
      const rkey = typeof v === "string" ? v : (v as any)?.rkey;
      if (rkey) map[k] = rkey;
    }
  } catch {}
  return map;
})();

// emoji map (Mariano's tables); loaded dynamically because the file lives in a vendor submodule
let EMOJI_MAP = new Map<string, string>();
try {
  const url = pathToFileURL(resolvePath(process.cwd(), EMOJI_DATA_JS)).href;
  const mod: any = await import(url);
  for (const [name, unicode] of mod.entries ?? []) EMOJI_MAP.set(name, unicode);
  for (const [name, unicode] of Object.entries(mod.aliases ?? {}))
    EMOJI_MAP.set(name, unicode as string);
} catch {
  console.error(`(emoji data not loaded from ${EMOJI_DATA_JS}; falling back to :name:)`);
}

// ── deterministic TID derivation (53b microseconds + 10b clock id) ──────────
const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";
function tidFromMicros(microseconds: bigint, clockId = 0): string {
  let n = (microseconds << 10n) | BigInt(clockId & 0x3ff);
  const chars: string[] = [];
  for (let i = 0; i < 13; i++) {
    chars.push(TID_ALPHABET[Number(n & 0x1fn)]);
    n >>= 5n;
  }
  return chars.reverse().join("");
}
function tidFromSlackTs(ts: string, clockId = 0) {
  const [sec, usecRaw = ""] = ts.split(".");
  const usec = (usecRaw + "000000").slice(0, 6);
  return tidFromMicros(BigInt(sec) * 1_000_000n + BigInt(usec), clockId);
}
function hash10(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h) & 0x3ff;
}
// Reaction rkey: synthesise time from the *message* ts so reactions live next to
// their target in TID order; clockId distinguishes the emoji. With 10 bits of
// clockId space and a small number of distinct emojis per message, collisions
// are rare; collisions just merge two emoji into one reaction record, which
// `slackRaw` can correct if we re-derive.
function tidForReaction(messageTs: string, emojiName: string) {
  return tidFromSlackTs(messageTs, hash10(`react:${emojiName}`));
}
function colibriChannelRkey(slackChannelId: string): string {
  const ch = channelOf.get(slackChannelId);
  if (!ch) throw new Error(`unknown slack channel ${slackChannelId}`);
  return tidFromMicros(BigInt(ch.created) * 1_000_000n, hash10(slackChannelId));
}

// ── facet builder ──────────────────────────────────────────────────────────
const enc = new TextEncoder();
const utf8Len = (s: string) => enc.encode(s).length;

type Facet = {
  $type: "social.colibri.richtext.facet";
  index: { byteStart: number; byteEnd: number };
  features: any[];
};

class FacetBuilder {
  parts: string[] = [];
  facets: Facet[] = [];
  byteOffset = 0;

  emit(text: string, ...features: any[]) {
    if (!text) return;
    const start = this.byteOffset;
    this.parts.push(text);
    this.byteOffset += utf8Len(text);
    if (features.length > 0) {
      this.facets.push({
        $type: "social.colibri.richtext.facet",
        index: { byteStart: start, byteEnd: this.byteOffset },
        features,
      });
    }
  }

  finish() {
    return { text: this.parts.join(""), facets: this.facets };
  }
}

// ── blocks walker (ported from Mariano's components.js fromData methods) ──
// Produces Colibri text + facets from Slack's rich_text block tree. Element
// types we recognise: rich_text_section, rich_text_quote, rich_text_preformatted,
// rich_text_list (and inside sections: text, link, user, channel, emoji, broadcast).

function walkBlocks(blocks: any[], b: FacetBuilder) {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block?.type !== "rich_text") continue;
    walkRichTextElements(block.elements ?? [], b);
    if (i < blocks.length - 1) b.emit("\n");
  }
}

function walkRichTextElements(elements: any[], b: FacetBuilder) {
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    switch (el?.type) {
      case "rich_text_section":
        walkSection(el.elements ?? [], b);
        break;
      case "rich_text_quote":
        walkQuote(el.elements ?? [], b);
        break;
      case "rich_text_preformatted":
        walkPreformatted(el.elements ?? [], b);
        break;
      case "rich_text_list":
        walkList(el, b);
        break;
    }
    if (i < elements.length - 1) b.emit("\n");
  }
}

function walkSection(elements: any[], b: FacetBuilder) {
  for (const el of elements) walkSectionItem(el, b);
}

function walkSectionItem(item: any, b: FacetBuilder) {
  switch (item?.type) {
    case "text": {
      const features: any[] = [];
      const s = item.style ?? {};
      if (s.bold)
        features.push({ $type: "social.colibri.richtext.facet#bold" });
      if (s.italic)
        features.push({ $type: "social.colibri.richtext.facet#italic" });
      if (s.strike)
        features.push({ $type: "social.colibri.richtext.facet#strikethrough" });
      if (s.code)
        features.push({ $type: "social.colibri.richtext.facet#code" });
      b.emit(item.text ?? "", ...features);
      break;
    }
    case "link": {
      const text = item.text || item.url;
      b.emit(text, {
        $type: "social.colibri.richtext.facet#link",
        uri: item.url,
      });
      break;
    }
    case "user": {
      const did = SLACK_TO_DID[item.user_id];
      const name = nameOf.get(item.user_id) ?? item.user_id;
      if (did)
        b.emit(`@${name}`, {
          $type: "social.colibri.richtext.facet#mention",
          did,
        });
      else b.emit(`@${name}`);
      break;
    }
    case "channel": {
      const ch = channelOf.get(item.channel_id);
      const name = ch?.name ?? item.channel_id;
      const rkey = MANUAL_CHANNELS[item.channel_id];
      if (rkey)
        b.emit(`#${name}`, {
          $type: "social.colibri.richtext.facet#channel",
          channel: rkey,
        });
      else b.emit(`#${name}`);
      break;
    }
    case "emoji": {
      // Slack sends `unicode` (codepoint sequence, dash-separated) for standard emoji,
      // and only the `name` for custom workspace emoji.
      let unicode = "";
      if (item.unicode) {
        try {
          unicode = String.fromCodePoint(
            ...item.unicode.split("-").map((h: string) => parseInt(h, 16)),
          );
        } catch {}
      }
      if (!unicode) unicode = EMOJI_MAP.get(item.name) ?? `:${item.name}:`;
      b.emit(unicode);
      break;
    }
    case "broadcast":
      b.emit(`@${item.range}`);
      break;
    case "color":
      b.emit(item.value ?? "");
      break;
  }
}

function walkQuote(elements: any[], b: FacetBuilder) {
  // Build the inner text, then line-prefix with "> ". Facet offsets inside
  // the quoted block are dropped (v0 best-effort).
  const inner = new FacetBuilder();
  walkSection(elements, inner);
  const { text } = inner.finish();
  const prefixed = text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  b.emit(prefixed);
}

function walkPreformatted(elements: any[], b: FacetBuilder) {
  // Render the inner text, then wrap the whole span in a single code facet.
  const inner = new FacetBuilder();
  walkSection(elements, inner);
  const { text } = inner.finish();
  if (!text) return;
  b.emit("\n");
  const start = b.byteOffset;
  b.parts.push(text);
  b.byteOffset += utf8Len(text);
  b.facets.push({
    $type: "social.colibri.richtext.facet",
    index: { byteStart: start, byteEnd: b.byteOffset },
    features: [{ $type: "social.colibri.richtext.facet#code" }],
  });
  b.emit("\n");
}

function walkList(list: any, b: FacetBuilder) {
  const ordered = list.style === "ordered";
  const items = list.elements ?? [];
  for (let i = 0; i < items.length; i++) {
    const prefix = ordered ? `${i + 1}. ` : "• ";
    b.emit(prefix);
    // Items can be rich_text_section or another rich_text_list.
    const child = items[i];
    if (child?.type === "rich_text_section") walkSection(child.elements ?? [], b);
    else if (child?.elements) walkSection(child.elements, b);
    if (i < items.length - 1) b.emit("\n");
  }
}

// ── message builder ─────────────────────────────────────────────────────────

function buildMessage(m: any, channelRkey: string, parentRkey?: string) {
  const author = nameOf.get(m.user || "") || m.user || "unknown";
  const claimedDid = SLACK_TO_DID[m.user || ""];

  const b = new FacetBuilder();
  if (claimedDid)
    b.emit(`@${author}`, {
      $type: "social.colibri.richtext.facet#mention",
      did: claimedDid,
    });
  else b.emit(`@${author}`);
  b.emit(": ");

  if (Array.isArray(m.blocks) && m.blocks.some((blk: any) => blk?.type === "rich_text")) {
    walkBlocks(m.blocks, b);
  } else {
    // Legacy fallback: plain text + URL regex link facets + entity decoding.
    legacyTextFallback(m.text || "", b);
  }

  let { text, facets } = b.finish();

  // 2048-char hard cap. If we truncate, drop any facets that extend past the cut.
  if (text.length > 2048) {
    text = text.slice(0, 2048);
    const maxBytes = utf8Len(text);
    facets = facets.filter((f) => f.index.byteEnd <= maxBytes);
  }

  return {
    rkey: tidFromSlackTs(m.ts),
    record: {
      $type: "social.colibri.message",
      text,
      channel: channelRkey,
      createdAt: new Date(parseFloat(m.ts) * 1000).toISOString(),
      facets,
      attachments: [],
      ...(parentRkey ? { parent: parentRkey } : {}),
    },
    hasBlocks: Array.isArray(m.blocks) && m.blocks.length > 0,
    facetCount: facets.length,
    truncated: false,
  };
}

function emojiForReaction(name: string): string {
  // Strip Slack ":name::skin-tone-X:" → look up base name, accept the loss of skin tone in v0.
  const baseName = name.split("::")[0];
  return EMOJI_MAP.get(baseName) ?? `:${name}:`;
}

// Walk a message's `reactions` array → one reaction record per emoji (per
// message). Multiple Slack users with the same emoji collapse into one record
// (they'd all author from the bot anyway and the appview likely dedupes by
// (author, emoji, target)). Multi-reactor count is preserved losslessly in
// `slackRaw`.
function reactionsFor(m: any, targetMessageRkey: string) {
  const out: { rkey: string; record: any; userCount: number; name: string; emoji: string }[] = [];
  for (const r of m.reactions ?? []) {
    if (!r?.name) continue;
    const emoji = emojiForReaction(r.name);
    out.push({
      rkey: tidForReaction(m.ts, r.name),
      name: r.name,
      emoji,
      userCount: (r.users ?? []).length || r.count || 1,
      record: {
        $type: "social.colibri.reaction",
        emoji,
        targetMessage: targetMessageRkey,
      },
    });
  }
  return out;
}

function legacyTextFallback(raw: string, b: FacetBuilder) {
  const decoded = raw
    .replace(/<([^>|]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  const urlRe = /https?:\/\/[^\s<>"']+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(decoded)) !== null) {
    if (m.index > last) b.emit(decoded.slice(last, m.index));
    b.emit(m[0], {
      $type: "social.colibri.richtext.facet#link",
      uri: m[0],
    });
    last = m.index + m[0].length;
  }
  if (last < decoded.length) b.emit(decoded.slice(last));
}

// ── load day's data ─────────────────────────────────────────────────────────
const dayPath = `${srcDir}/${srcDay}`;
let topLevelRaw: any[] = [];
let repliesRaw: any[] = [];
try {
  topLevelRaw = JSON.parse(readFileSync(`${dayPath}.json`, "utf-8"));
} catch {}
try {
  repliesRaw = JSON.parse(readFileSync(`${dayPath}.replies.json`, "utf-8"));
} catch {}

const tops = topLevelRaw
  .filter(
    (m) =>
      m.type === "message" &&
      !m.subtype &&
      m.text &&
      (!m.thread_ts || m.thread_ts === m.ts),
  )
  .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))
  .slice(0, limit);

const replies = repliesRaw
  .filter(
    (m) =>
      m.type === "message" &&
      !m.subtype &&
      m.text &&
      m.thread_ts &&
      m.thread_ts !== m.ts,
  )
  .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))
  .slice(0, limit);

const slackChannelsTouched = new Set<string>(
  [...tops, ...replies].map((m) => m.channel_id).filter(Boolean),
);

const channelMap: Record<string, string> = {};
const channelSrc: Record<string, "manual" | "derived"> = {};
for (const cid of slackChannelsTouched) {
  if (MANUAL_CHANNELS[cid]) {
    channelMap[cid] = MANUAL_CHANNELS[cid];
    channelSrc[cid] = "manual";
  } else {
    channelMap[cid] = colibriChannelRkey(cid);
    channelSrc[cid] = "derived";
  }
}
const allManual = [...slackChannelsTouched].every(
  (cid) => channelSrc[cid] === "manual",
);

// ── preview ─────────────────────────────────────────────────────────────────
console.log(`=== ${srcDay} ===`);
console.log(
  `top-level: ${tops.length}  replies: ${replies.length}  channels: ${slackChannelsTouched.size}`,
);
console.log("");
console.log(`CHANNELS (${allManual ? "manual mapping" : "deterministic / lazy-create"}):`);
for (const cid of slackChannelsTouched) {
  const ch = channelOf.get(cid)!;
  console.log(
    `  ${cid.padEnd(13)}  ${ch.name.padEnd(22)}  → ${channelMap[cid]}  [${channelSrc[cid]}]`,
  );
}

const fmtRow = (
  m: any,
  built: ReturnType<typeof buildMessage>,
  parent?: string,
) => {
  const tags = `${built.hasBlocks ? "B" : "."}${built.facetCount.toString().padStart(2, " ")}`;
  const parentCol = parent ? `parent=${parent}` : "                  ";
  const rxCount = (m.reactions ?? []).length;
  const rxTag = rxCount ? `+${rxCount}r` : "    ";
  return `  ${m.ts}  ${(m.channel_name || "?").padEnd(20)}  ${built.rkey}  ${parentCol}  ${tags} ${rxTag}  '${built.record.text.slice(0, 70).replace(/\n/g, " ")}…'`;
};

console.log("");
console.log("TOP-LEVEL:");
for (const m of tops)
  console.log(fmtRow(m, buildMessage(m, channelMap[m.channel_id])));

console.log("");
console.log("REPLIES:");
for (const m of replies) {
  const parent = tidFromSlackTs(m.thread_ts!);
  console.log(fmtRow(m, buildMessage(m, channelMap[m.channel_id], parent), parent));
}

const allWithReactions: { m: any; targetRkey: string }[] = [];
for (const m of tops)
  if (m.reactions?.length)
    allWithReactions.push({ m, targetRkey: tidFromSlackTs(m.ts) });
for (const m of replies)
  if (m.reactions?.length)
    allWithReactions.push({ m, targetRkey: tidFromSlackTs(m.ts) });

if (allWithReactions.length > 0) {
  console.log("");
  console.log("REACTIONS:");
  for (const { m, targetRkey } of allWithReactions) {
    for (const r of reactionsFor(m, targetRkey)) {
      console.log(
        `  ${m.ts}  target=${targetRkey}  rkey=${r.rkey}  ${r.emoji} (:${r.name}: ×${r.userCount})`,
      );
    }
  }
}

if (dryRun) {
  console.log("");
  console.log("(dry-run; pass --live to publish)");
  process.exit(0);
}

// ── live mode ───────────────────────────────────────────────────────────────
const HANDLE = process.env.BSKY_HANDLE;
const PASSWORD = process.env.BSKY_APP_PASSWORD;
if (!HANDLE || !PASSWORD) {
  console.error("set BSKY_HANDLE, BSKY_APP_PASSWORD");
  process.exit(1);
}
const COMMUNITY_URI = process.env.COLIBRI_COMMUNITY_URI;
const CATEGORY_RKEY = process.env.COLIBRI_CATEGORY_RKEY;
if (!allManual && (!COMMUNITY_URI || !CATEGORY_RKEY)) {
  console.error("some channels need lazy-create; set COLIBRI_COMMUNITY_URI + COLIBRI_CATEGORY_RKEY,");
  console.error(`or add them to ${SLACK_TO_COLIBRI_CHANNEL_JSON}`);
  process.exit(1);
}
const COMMUNITY_RKEY = COMMUNITY_URI?.split("/").pop();

const sessRes = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identifier: HANDLE, password: PASSWORD }),
});
if (!sessRes.ok) throw new Error(`login: ${await sessRes.text()}`);
const sess: any = await sessRes.json();
const did = sess.did as string;
const auth = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${sess.accessJwt}`,
};
console.error(`logged in as @${sess.handle} (${did})`);

async function put(collection: string, rkey: string, record: any) {
  const r = await fetch(`${PDS}/xrpc/com.atproto.repo.putRecord`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ repo: did, collection, rkey, record }),
  });
  if (!r.ok)
    throw new Error(`putRecord ${collection}/${rkey}: ${r.status} ${await r.text()}`);
  return await r.json();
}
async function get(repo: string, collection: string, rkey: string) {
  const r = await fetch(
    `${PDS}/xrpc/com.atproto.repo.getRecord?repo=${repo}&collection=${collection}&rkey=${rkey}`,
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`getRecord ${collection}/${rkey}: ${r.status}`);
  return await r.json();
}

if (!allManual) {
  const catRes = await get(did, "social.colibri.category", CATEGORY_RKEY!);
  if (!catRes) {
    console.error(`category ${CATEGORY_RKEY} not found on ${did}; create it first`);
    process.exit(1);
  }
  const categoryRecord: any = catRes.value;
  const existingOrder: string[] = categoryRecord.channelOrder || [];
  const newRkeys: string[] = [];

  for (const cid of slackChannelsTouched) {
    if (channelSrc[cid] === "manual") continue;
    const rkey = channelMap[cid];
    const ch = channelOf.get(cid)!;
    const existing = await get(did, "social.colibri.channel", rkey);
    if (!existing) {
      await put("social.colibri.channel", rkey, {
        $type: "social.colibri.channel",
        name: ch.name,
        type: "text",
        category: CATEGORY_RKEY,
        community: COMMUNITY_RKEY,
        ownerOnly: false,
      });
      console.error(`  created #${ch.name} (${rkey})`);
    }
    if (!existingOrder.includes(rkey)) newRkeys.push(rkey);
    await new Promise((r) => setTimeout(r, delayMs));
  }

  if (newRkeys.length > 0) {
    categoryRecord.channelOrder = [...existingOrder, ...newRkeys];
    await put("social.colibri.category", CATEGORY_RKEY!, categoryRecord);
    console.error(`  category.channelOrder +${newRkeys.length}`);
  }
}

console.error("");
console.error("top-level…");
let okT = 0, failT = 0;
for (const m of tops) {
  const built = buildMessage(m, channelMap[m.channel_id]);
  try {
    await put("social.colibri.message", built.rkey, built.record);
    okT++;
  } catch (e) {
    failT++;
    console.error(`  fail ${m.ts}: ${e}`);
  }
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
}

console.error("");
console.error("replies…");
let okR = 0, failR = 0;
for (const m of replies) {
  const parent = tidFromSlackTs(m.thread_ts!);
  const built = buildMessage(m, channelMap[m.channel_id], parent);
  try {
    await put("social.colibri.message", built.rkey, built.record);
    okR++;
  } catch (e) {
    failR++;
    console.error(`  fail ${m.ts}: ${e}`);
  }
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
}

console.error("");
console.error("reactions…");
let okX = 0, failX = 0;
for (const { m, targetRkey } of allWithReactions) {
  for (const r of reactionsFor(m, targetRkey)) {
    try {
      await put("social.colibri.reaction", r.rkey, r.record);
      okX++;
    } catch (e) {
      failX++;
      console.error(`  fail ${m.ts} ${r.name}: ${e}`);
    }
    if (delayMs > 0) await new Promise((rs) => setTimeout(rs, delayMs));
  }
}

console.error("");
console.error(`done: ${okT} top-level, ${okR} replies, ${okX} reactions, ${failT + failR + failX} failed`);
