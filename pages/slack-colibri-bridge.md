---
title: Slack → Colibri Bridge
contributors: Tom Larkworthy
---

> **Status:** v0 forward path live since 2026-05-31. Bot identity [`@feelingofcomputing.bsky.social`](https://bsky.app/profile/feelingofcomputing.bsky.social) (`did:plc:4gcxakknd6hxtnhf33miwsob`). Community owned by a separate identity (`did:plc:j7nm3lrd5h7fm3sfhcv3lhfv`). Auto-deployed on push.

One-way sync from the FoC Slack workspace into the [Colibri](https://colibri.social) atproto network. Every bridged message, reaction, and attachment is a public record on the bot's bsky.social PDS; every raw Slack event is archived losslessly under a `com.feelingofcomputing.bridge.*` lexicon on the same repo. The bot authors messages into channels owned by a separate community-owner DID — the *inverse pattern* described under [Identity](#identity).

## What's live

Forward path (Slack → atproto), end-to-end:

- **Messages** — rich text → Colibri facets (bold, italic, strikethrough, code, link, channel); 2048-char cap; fallback to plain-text + URL regex for legacy non-`blocks` messages
- **Mentions** — `@user` resolves to a `social.colibri.richtext.facet#mention` against the user's claimed DID via the [in-source map](https://github.com/tomlarkworthy/slack-sync/blob/main/packages/worker/src/slack-to-did.ts); plain text fallback for unmapped users
- **Threaded replies** — Slack `thread_ts` → Colibri `parent`
- **Reactions** add + remove — deterministic per-emoji rkey on the target message
- **Message edits** — re-derive in place, `putRecord` overwrites, `edited: true` set per the message lexicon
- **Message deletes** — `deleteRecord` on the derived rkey
- **File attachments** — fetch `url_private` with bot token → `com.atproto.repo.uploadBlob` → reference in `attachments[]`; 5 MB cap, oversize gets a `[file 'name' too large]` placeholder in the message text
- **Lossless raw-event archive** — every `event_callback` envelope persisted to `com.feelingofcomputing.bridge.slackRaw` *before* derivation, keyed by `event_id` (idempotent on Slack redelivery)

Not in scope:

- Reverse path (Colibri → Slack)
- Private channels, DMs
- Per-Slack-user authorship — every bridged record is authored by the bot; the original speaker appears as `@user:` in the message text
- `slackRaw` backfill — historical days (pre-2026-05-31) have derived `social.colibri.message` + `social.colibri.reaction` only; the raw archive only exists for traffic the live bridge has seen

## Code

- **Repo**: [tomlarkworthy/slack-sync](https://github.com/tomlarkworthy/slack-sync) — Bun workspace monorepo
- **Worker**: [`packages/worker/src/index.ts`](https://github.com/tomlarkworthy/slack-sync/blob/main/packages/worker/src/index.ts) — single Cloudflare Worker; producer (`fetch`) + consumer (`queue`) in one script
- **Backfill**: [`packages/backfill/src/index.ts`](https://github.com/tomlarkworthy/slack-sync/blob/main/packages/backfill/src/index.ts) — Bun CLI for re-publishing day-files from [Mariano's archive](https://github.com/marianoguerra/Feeling-of-Computing)
- **Slack app manifest**: [`manifest/slack-app.yaml`](https://github.com/tomlarkworthy/slack-sync/blob/main/manifest/slack-app.yaml)
- **Deploy**: Cloudflare Workers Builds, push-to-main → auto-deploy

## Architecture

```mermaid
sequenceDiagram
  autonumber
  actor U as User in Slack
  participant S as Slack Events API
  participant P as Producer (fetch)
  participant Q as CF Queue
  participant C as Consumer (queue)
  participant PDS as bsky.social PDS<br/>(bot's repo)
  participant App as Colibri / firehose readers

  U->>S: send / edit / delete / react
  S->>P: POST /slack/events
  P->>P: HMAC-verify X-Slack-Signature
  P->>Q: enqueue { event_callback }
  P-->>S: 200 OK (within 3s)

  C->>Q: pull batch
  C->>PDS: putRecord slackRaw (rkey = event_id)
  alt event.type = message
    C->>PDS: putRecord / deleteRecord<br/>social.colibri.message
  else event.type = reaction_added / removed
    C->>PDS: putRecord / deleteRecord<br/>social.colibri.reaction
  end
  C->>Q: ack (or retry → DLQ)

  App->>PDS: firehose / fetch
  App-->>U: public conversation visible
```

Notes on the live shape vs. the proposal that preceded it:

- **No D1 cache in v0.** The worker writes straight to the PDS and leans on deterministic rkeys + `putRecord` overwrite for idempotency. The D1 binding is reserved in `wrangler.toml` for v0.1+ if cache reads become useful.
- **slackRaw is the de-facto idempotency boundary.** rkey = sanitised Slack `event_id`; Slack redeliveries hit the same rkey and overwrite identical content.
- **Message rkey** = `tidFromSlackTs(message.ts)` — edits overwrite in place, deletes target the same rkey.
- **Reaction rkey** = `tidFromSlackTs(target.ts, hash10('react:' + emoji))` — same emoji on the same message always lands on the same record, so `reaction_removed` can `deleteRecord` without lookup.

## Lexicons

### Reused from Colibri

- [`social.colibri.message`](https://lexicon.garden/browse/social.colibri.message) — text, facets, createdAt, channel, parent, attachments, edited
- [`social.colibri.reaction`](https://lexicon.garden/browse/social.colibri.reaction) — emoji, targetMessage
- [`social.colibri.richtext.facet`](https://lexicon.garden/browse/social.colibri.richtext.facet) — bold, italic, strikethrough, code, link, mention, channel

### Owned: `com.feelingofcomputing.bridge.*`

Namespace owned because FoC owns `feelingofcomputing.com/.org/.net`. The archive's lifetime, schema, and ownership belong to FoC, not Colibri — explicit boundary in the lexicon namespace de-risks Colibri lexicon churn (it has a substantial rework in flight on `feat/rework`) and de-risks Colibri disappearing entirely. If either happens, the raw archive on atproto is untouched and re-derivable.

#### Live in v0: `com.feelingofcomputing.bridge.slackRaw`

Lossless capture of the full `event_callback` envelope, written *before* any derivation.

```json
{
  "lexicon": 1,
  "id": "com.feelingofcomputing.bridge.slackRaw",
  "defs": {
    "main": {
      "type": "record",
      "key": "any",
      "record": {
        "type": "object",
        "required": ["slackChannelId", "slackTs", "payload", "capturedAt"],
        "properties": {
          "slackChannelId": { "type": "string" },
          "slackTs":        { "type": "string" },
          "eventType":      { "type": "string", "description": "Slack event type: message, message_changed, message_deleted, reaction_added, reaction_removed, etc." },
          "payload":        { "type": "unknown", "description": "Raw Slack event_callback envelope as received." },
          "capturedAt":     { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

rkey = sanitised Slack `event_id`. Slack file attachments referenced in `payload.files[]` are captured by URL only; the bytes are re-uploaded as atproto blobs by the derived `social.colibri.message` path (see [Code → Worker](https://github.com/tomlarkworthy/slack-sync/blob/main/packages/worker/src/index.ts)).

## Maintenance

The bridge's per-deployment configuration lives in source, not in lexicon records. Two maps:

- **Slack channel → Colibri channel rkey** — `vendor/slack-sync/packages/worker/src/index.ts` (constant `CHANNEL_MAP`) for the live worker, and [`tools/slack-to-colibri-channel.json`](https://github.com/tomlarkworthy/slack-sync) for the backfill CLI. The two must agree.
- **Slack user id → claimed atproto DID** — [`packages/worker/src/slack-to-did.ts`](https://github.com/tomlarkworthy/slack-sync/blob/main/packages/worker/src/slack-to-did.ts) for the live worker, `tools/slack-to-did.json` for the backfill. The two must agree.

To add a new bridged channel: community owner creates a `social.colibri.channel` record under their DID inside the existing community + category, hands the rkey to the bridge maintainer, who edits both files, commits, and pushes — Cloudflare Workers Builds redeploys the worker automatically on push.

To map a new user to their DID: get their bsky handle, resolve to a DID with `com.atproto.identity.resolveHandle`, add the entry to both files, commit, push.

## Identity

Two DIDs are involved:

- **Community owner** (`did:plc:j7nm3lrd5h7fm3sfhcv3lhfv`) owns the [Feeling of Computing community](https://colibri.social) and every category + channel under it.
- **Bot** (`did:plc:4gcxakknd6hxtnhf33miwsob`, handle `feelingofcomputing.bsky.social`) is a member with a `social.colibri.membership` record; it authors every bridged message into channels owned by the community owner.

Attribution for the original Slack speaker lives in the message text as `@user: ...` — rendered as a Colibri mention facet once the speaker has claimed a DID.

### Authorship is immutable

The author of an atproto record is the DID of the repo it lives on. `putRecord` edits content; `deleteRecord` removes a record; nothing reassigns authorship. All bridged messages stay authored by the bot. Retroactive delete + republish would change the at-uri, breaking links, threads, and firehose state, so we don't.

### Channels live in the bot's community

The Colibri appview hard-couples channel ownership to community ownership by author DID. From `jetstream.rs`:

```rust
let community_uri =
    format!("at://{}/social.colibri.community/{}", did, record.community);
```

The community URI for an indexed channel is constructed from the **channel record's author DID** plus the channel's `community` rkey field. A bot-authored channel record can only resolve to a community on the bot's own repo; the appview will not index a bot-authored channel into a community owned by a different DID.

v0 went with the **inverse pattern**: the community owner pre-creates the community + every bridged channel under their own DID; the bot only authors messages referencing the channel rkeys. The bot does *not* own the community, channels, or categories. Trade-off: one-time manual setup by the community owner and an ongoing convention that they add a Colibri channel whenever a new Slack channel should be bridged — but the bot's repo stays a pure archival identity, and ownership of the community is decoupled from the bridge's operational lifetime (we could replace the bot identity tomorrow without affecting the community).

### Per-message avatar / displayName

Avatar and displayName come from the actor's profile record — one per DID. With one bot DID, every bridged message renders with the bot's avatar regardless of who sent it on Slack. The Colibri message lexicon has no override fields, so attribution lives in the message text body. This is the biggest visual gap and it isn't fixable without either upstream changes to the Colibri lexicon or per-user atproto identities (rejected: bsky.social account-creation rate limits and creating DIDs for users without their consent).

## Operational notes

- **Backfill is in progress.** Sourced from Mariano's weekly archive dumps (`history/YYYY/MM/DD.json`). 4 weeks (2026-05-05 → 2026-06-01) bridged as of 2026-06-01. Rkeys are deterministic, so re-running a day overwrites in place; map updates get picked up on the next pass.
- **6 Slack channels are not bridged** (`#of-end-user-programming`, `#of-graphics`, `#of-music`, `#of-logic-programming`, `#reading-together`, `#of-functional-programming`; ~4600 messages of historical traffic combined). The backfill hard-fails on any day that references them. To bridge them, the community owner creates the corresponding Colibri channels and the maps in *Maintenance* get updated.
- **Lexicon records show "not validated"** in atproto-browser. `com.feelingofcomputing.bridge.slackRaw` isn't published anywhere yet; doing so would require either a `_lexicon` TXT record on `feelingofcomputing.com` or a `com.atproto.lexicon.schema` record. The bridge functions either way — validation is purely a tooling/discoverability signal.

## Known gaps

Things observably missing from v0. Listed as facts, not commitments.

- **Per-record author override on Colibri's lexicon.** Every bridged message and reaction renders as the bot. Optional `displayAuthor: { name, avatar? }` on `social.colibri.message` and `social.colibri.reaction` would be the cleanest fix; would also unblock proper reaction multi-reactor counts.
- **Thread rendering.** Slack's threads flatten to sibling rows in Colibri because Colibri's UI is Discourse-flat — a 30-reply Slack thread becomes 30 top-level rows referencing the same `parent_message`. Colibri's `feat/rework` branch still renders flat.
- **Cross-repo channel ownership in Colibri's appview.** The appview hard-codes `community_uri = at://{channel_author}/social.colibri.community/{rkey}`, so a single DID has to own both the community and every channel under it. The bridge's workaround is "community owner pre-creates channels under their own DID, bot authors messages referencing those channel rkeys" — requires manual coordination per new bridged channel.
- **Quote facet.** Slack `rich_text_quote` blocks render as `> `-prefixed plain text because Colibri's facet feature set has no quote.
- **TID-on-rkey monotonicity assurance from Colibri.** `social.colibri.message` uses `key: "tid"`. bsky.social tolerates non-monotonic TIDs (without which backfill of old Slack history would 409 against live messages). A PDS that strictly enforced monotonicity would break the bridge; a one-line assurance in the lexicon docs or a switch to `key: "any"` would lock this in.

## Prior art

- **[Bridgy Fed](https://fed.brid.gy)** — ActivityPub ↔ atproto. Not directly applicable (Slack isn't ActivityPub) but informs the rejected per-user ghost-DID approach.
- **[matrix-appservice-slack](https://github.com/matrix-org/matrix-appservice-slack)** — closest sibling. Same Slack-webhook → ghost-users → federated-protocol shape, targeting Matrix.
- **Mariano's `scripts/dump-history.js` + `foc-server`** ([repo](https://github.com/marianoguerra/Feeling-of-Computing)) — the existing FoC pipeline pulls `conversations.history` + `conversations.replies` via Slack REST on a weekly cadence, writes JSON to `history/YYYY/MM/DD{,.replies}.json`, indexes into LanceDB with sentence-transformer embeddings, serves search via a Rust `axum` binary on Ubuntu under systemd behind nginx. Pull, not push; ingest-and-reindex, not bridge. The bridge's `slackRaw` lexicon is the atproto-native analog of those `history/*.json` dumps — same archival role, public over the firehose instead of `git push`. The backfill CLI consumes these JSON dumps directly.

## Related

- [[Projects]] — Colibri and FoC are both listed.
- [Colibri lexicons](https://lexicon.garden/browse/social.colibri)
- [Colibri source](https://github.com/colibri-social/colibri.social)
- [FoC repo](https://github.com/marianoguerra/Feeling-of-Computing)
