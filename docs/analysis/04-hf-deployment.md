# 04 — Hugging Face Spaces as a deployment target for SpaceCities

**Researched:** 2026-08-30 · **Target:** `https://huggingface.co/spaces/Almaatla/SpaceCities` (Docker SDK, currently **private**)
**Method:** live Hugging Face documentation (`huggingface.co/docs/hub/*`), the Hub API via the authenticated MCP connector, and direct HTTP probes against the live Spaces edge. Every non-obvious claim carries a source URL. Claims I could **not** verify are collected in [§11](#11-things-i-could-not-verify) and flagged inline as **[UNVERIFIED]**.

---

## 0. Executive summary — read this first

Four findings change the shape of the plan. Two are hard blockers.

| # | Finding | Impact |
|---|---|---|
| **B1** | **The Space must be made public.** A private Space returns `404` to everyone except the owner and collaborators — the running app, not just the source. | **Blocker for multiplayer.** [§9](#9-private-vs-public) |
| **B2** | **`Almaatla` is not on a paid plan** (`is_pro: false`, verified via the Hub API), and HF now documents that *"Gradio and Docker Spaces run on compute and require a paid plan to **create**"*. | The **existing** Space (created 2026-02-23) should keep working — the restriction is worded against *creation*. But do **not** delete it, and expect `hub-sync`'s `hf repo create` step to be the risky part. [§3.1](#31-the-paid-plan-caveat) |
| **B3** | **Classic "persistent storage" no longer exists.** `suggested_storage` is documented as *"The persistent storage feature is no longer available so this setting will be ignored."* `/data` is now an **attached Storage Bucket volume**. | The current Dockerfile's `ln -s /data data` is very likely symlinking to **ephemeral disk** today. [§4](#4-persistent-storage) |
| **B4** | **Free hardware sleeps after 48 h idle and all in-memory state dies** — on sleep, on every git push (rebuild), and on any crash/restart. | Matches cannot be "long-lived in memory". Needs snapshot-to-disk + resume. [§3](#3-hardware--lifecycle) |

The good news: **raw WebSockets work.** I verified empirically that a `Upgrade: websocket` request traverses the HF edge proxy and reaches the container ([§1.1](#11-verified-websocket-upgrades-reach-the-container)). A 20 Hz push is not a problem.

---

## 1. WebSockets on HF Spaces

### 1.1 Verified: WebSocket upgrades reach the container

There is **no page in the HF docs that states "WebSockets are supported"** in so many words. So I tested it directly against a live, running public Docker Space (`Almaatla/private-room`, a FastAPI/uvicorn app with no WebSocket route):

```console
$ curl -sS -o /dev/null -D - --http1.1 \
    -H "Connection: Upgrade" -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Version: 13" \
    -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
    https://almaatla-private-room.hf.space/ws

HTTP/1.1 403 Forbidden
Date: Sun, 30 Aug 2026 16:49:01 GMT
Connection: keep-alive
x-proxied-host: http://10.112.58.9
x-proxied-replica: uxm7fnh3-hqx78
x-proxied-path: /ws
```

Two things are proven by this response:

1. **The upgrade request was forwarded to the container.** The `x-proxied-host` / `x-proxied-replica` / `x-proxied-path` headers are added by the HF edge *when it proxies to the app*. A proxy-level rejection would not carry them. The `403` is Starlette's own reply for a WebSocket handshake against an unrouted path — i.e. the request arrived as an ASGI `websocket` scope.
2. **The edge downgrades to HTTP/1.1 for the upgrade.** Note `HTTP/1.1 403` here versus `HTTP/2 404` for the same path over plain GET (see [§10.2](#102-http2-at-the-edge)). That is exactly the behaviour of a WebSocket-capable reverse proxy.

Corroborating evidence from live Spaces:

- `langtech-innovation/WhisperLiveKitDiarization` is a public Docker Space whose README describes *"A FastAPI-based WebSocket server that receives streamed audio data, processes it in real time, and returns transcriptions to the frontend"* — continuous bidirectional binary streaming, on Spaces. It also uses `app_port: 8000`. — <https://huggingface.co/spaces/langtech-innovation/WhisperLiveKitDiarization/blob/main/README.md>
- HF's own Panel guide instructs users to pass `allow-websocket-origin` *"to enable the connection to the server's websocket"* — HF documenting a WebSocket app on Spaces. — <https://huggingface.co/docs/hub/spaces-sdks-docker-panel>
- The user's own `Almaatla/WebSocketChat` Docker Space (private, uvicorn on 7860) is prior art in this exact account.

**Verdict: raw WebSockets on a Docker Space are fine. Use `wss://`, never `ws://`.**

### 1.2 Client-side URL

Connect to the Space's own origin, not `huggingface.co`:

```js
const ws = new WebSocket(`wss://${location.host}/ws`);
```

The Space is served from the root of `https://<space-subdomain>.hf.space` — *"Your space is always served from the root of this subdomain."* — <https://huggingface.co/docs/hub/spaces-embed#direct-url>. For `Almaatla/SpaceCities` that is `https://almaatla-spacecities.hf.space`.

> **Gotcha:** when a Space is viewed inside the `huggingface.co/spaces/...` page it runs in an **iframe** whose `location.host` is already the `.hf.space` subdomain, so the snippet above is correct in both contexts. Do **not** hard-code `ws://` — mixed content will be blocked. A recurring forum failure mode is exactly this: *"my mistake was to use `ws://` instead of `wss://`"* — <https://discuss.huggingface.co/t/fastapi-websocket-returns-http-404-on-spaces/159865>

### 1.3 Timeouts, message rate and size — the honest picture

| Question | Answer |
|---|---|
| Documented idle/proxy timeout for WS? | **[UNVERIFIED]** — HF publishes no number. |
| Documented max message size? | **[UNVERIFIED]** — none published. |
| Documented max connection duration? | **[UNVERIFIED]** — none published. |
| Documented max concurrent connections? | **[UNVERIFIED]** — none published. |

What I can say with evidence:

- **A 20 Hz server push is never idle**, so any idle-timeout the edge may impose (commonly 60–100 s on CDN-fronted proxies) cannot fire on a live match. The risk is confined to *lobby* / *spectator* / *paused* connections. **Mitigation: send an application-level ping every ~20–30 s on every socket, in both directions**, and treat a missed pong as a disconnect. This is cheap insurance and standard practice.
- There *is* circumstantial evidence of proxy-level timeout sensitivity for long-lived connections: HF's Shiny-for-R guide requires the development build of `httpuv` because it *"resolves an issue with app timeouts on Hugging Face"* — <https://huggingface.co/docs/hub/spaces-sdks-docker-shiny>. That is an R-stack quirk, not a documented WS limit, but it tells you the edge is opinionated about long-held sockets.
- A 12 MB POST body passed through the edge to the container untouched (verified, [§10.4](#104-request-body-size)), so there is no aggressive small body cap. Game deltas at 20 Hz are kilobytes; this is a non-issue.
- **Design guidance:** at 20 Hz with N players, keep per-tick payloads small (binary or compact JSON deltas, not full-state snapshots). This is good practice regardless of HF; it also keeps you far away from any undocumented ceiling.

### 1.4 Fallbacks, if WS ever misbehaves

- **SSE (`text/event-stream`) works and is HF's own transport.** HF documents streaming Space responses with `curl -N` returning `event: complete / data: ...` — <https://huggingface.co/docs/hub/spaces-api-endpoints#queue-based-api-recommended> — and the Hub itself streams Space logs/events/metrics over SSE — <https://huggingface.co/docs/hub/spaces-gpus#streaming>. SSE is server→client only, so you'd need `POST` for client→server input: roughly 2× the round trips and no ordering guarantee between the two channels. Acceptable for a fallback, poor as a primary for an RTS.
- **Long-poll** works but is the worst option at 20 Hz — one request per tick per player.
- **Browser connection limits are relaxed here** because the edge speaks HTTP/2 ([§10.2](#102-http2-at-the-edge)), which multiplexes; the classic 6-connections-per-host cap that cripples SSE over HTTP/1.1 does not bite.

**Recommendation:** WebSocket primary, SSE+POST fallback only if telemetry shows real-world upgrade failures. Do not build the fallback speculatively.

---

## 2. Port & networking

### 2.1 The listening port

- **Default is `7860`.** *"You can also change the default exposed port `7860` by setting `app_port: 7860`."* — <https://huggingface.co/docs/hub/spaces-sdks-docker#setting-up-docker-spaces>
- Config reference: **`app_port` : _int_ — "Port on which your application is running. Used only if `sdk` is `docker`. Default port is `7860`."** — <https://huggingface.co/docs/hub/spaces-config-reference>
- **Bind to `0.0.0.0`, not `127.0.0.1`.** Every official HF Dockerfile example does (`--host 0.0.0.0 --port 7860`) — <https://huggingface.co/docs/hub/spaces-sdks-docker-first-demo>. The current SpaceCities Space README has **no** `app_port` key and works on 7860, confirming the default empirically.

**Decision: keep 7860 and omit `app_port`.** Adding `app_port: 7860` is harmless and self-documenting; I'd include it for clarity. Read the port from `process.env.PORT` with a `7860` default so local dev and the Space agree.

### 2.2 Only one port is exposed to the internet

> *"Internally you could have as many open ports as you want. For instance, you can install Elasticsearch inside your Space and call it internally on its default port 9200. If you want to expose apps served on multiple ports to the outside world, a workaround is to use a reverse proxy like Nginx to dispatch requests from the broader internet (on a single port) to different internal ports."*
> — <https://huggingface.co/docs/hub/spaces-sdks-docker#setting-up-docker-spaces>

**Exactly one port is reachable from outside.** So for SpaceCities:

- **Do not** put the game server and the MCP server on different ports.
- **Do** multiplex by path in a single Node HTTP server — e.g. `/` → static assets, `/ws` → game WebSocket, `/mcp` → MCP streamable-HTTP endpoint, `/healthz` → liveness. Since the game is zero-dependency Node, a single `http.createServer` with a path switch plus a WebSocket upgrade handler is the natural shape and needs no nginx.

### 2.3 Outbound networking is restricted

> *"If your Space needs to make any network requests, you can make requests through the standard HTTP and HTTPS ports (80 and 443) along with port 8080. Any requests going to other ports will be blocked."*
> — <https://huggingface.co/docs/hub/spaces-overview#networking>

Irrelevant for a self-contained game, but it rules out e.g. an external Postgres on 5432 or a Redis on 6379 later. Plan persistence around HTTPS-reachable services only.

---

## 3. Hardware & lifecycle

### 3.1 The paid-plan caveat

HF now gates compute-backed Spaces behind a subscription:

> *"Static Spaces are free for everyone. Gradio and Docker Spaces run on compute and require a paid plan to create: PRO for personal accounts, Team or Enterprise for organizations."*
> — <https://huggingface.co/docs/hub/spaces-overview#creating-a-new-space>
>
> *"CPU Basic has no hourly cost, but creating a new Space that runs on compute (Gradio or Docker) requires a paid plan."*
> — <https://huggingface.co/docs/hub/spaces-gpus#cpu>

I confirmed via the authenticated Hub API that the account is **not** on PRO:

```json
{"account":{"name":"Almaatla","is_pro":false}, "organizations":[{"name":"OrganizedProgrammers","role":"admin"}]}
```

Both doc sentences are worded against **creating**, and `Almaatla/SpaceCities` already exists (`sdk: docker`, `private: true`, last modified 2026-02-23). So overwriting it should be fine. **Consequences to plan around:**

- **Never delete the Space.** You may not be able to recreate it.
- **Prefer a workflow that pushes to the existing repo** over one that creates it. `huggingface/hub-sync` runs `hf repo create` — idempotent on an existing repo, but it is the one step that could hit the paywall. The `git push` variant ([§7.3](#73-alternative-direct-git-force-push)) touches no creation API at all, which makes it the **safer** choice for this account.
- PRO is **$9/month** (<https://huggingface.co/pricing>) and would additionally unlock *protected* visibility, custom sleep time, custom domains and Dev Mode — see [§9](#9-private-vs-public).
- **[UNVERIFIED]** Whether a free account can still *push to and rebuild* an existing Docker Space. The docs only speak about creation. This is the single highest-value thing to test early: push a trivial commit and watch it build before investing in the port.

### 3.2 Free-tier hardware

> | **Hardware** | **CPU** | **Memory** | **Disk** | **Hourly Price** |
> |---|---|---|---|---|
> | CPU Basic | 2 vCPU | 16 GB | 50 GB | Free! |
>
> — <https://huggingface.co/docs/hub/spaces-gpus#cpu>

Also: *"Each Spaces environment is limited to 16GB RAM, 2 CPU cores and 50GB of (not persistent) disk space by default."* — <https://huggingface.co/docs/hub/spaces-overview#hardware-resources>

**2 vCPU / 16 GB is generous for a 20 Hz authoritative sim in Node.** Node is single-threaded, so the sim gets ~1 core and the second core absorbs I/O and GC. 16 GB means memory is a non-constraint; the binding constraint will be the 50 ms tick budget on one core.

At runtime the container also gets `CPU_CORES` and `MEMORY` env vars — <https://huggingface.co/docs/hub/spaces-overview#built-in-environment-variables> — useful for sizing worker pools or logging.

### 3.3 Sleeping — this determines the whole persistence design

> *"If your Space runs on the default `cpu-basic` hardware, it will go to sleep if inactive for more than a set time (currently, **48 hours**). Anyone visiting your Space will restart it automatically. If you want your Space never to deactivate or if you want to set a custom sleep time, **you need to upgrade to paid hardware**."*
> — <https://huggingface.co/docs/hub/spaces-gpus#sleep-time>

Reinforced by the `huggingface_hub` guide: *"if you are using a 'cpu-basic' hardware, you cannot configure a custom sleep time. Your Space will automatically be paused after 48h of inactivity."* — <https://huggingface.co/docs/huggingface_hub/guides/manage-spaces>

And from billing: *"Spaces running on free hardware are suspended automatically if they are not used for an extended period of time (e.g. two days)."* — <https://huggingface.co/docs/hub/spaces-gpus#billing>

**What happens to in-memory state:** it is destroyed. The container is torn down. Beyond sleep, state is *also* lost on:

- **every git push** — *"Each time a new commit is pushed, the Space will automatically rebuild and restart"* — <https://huggingface.co/docs/hub/spaces-overview#creating-a-new-space>
- **every settings change** — *"Any change in your Space configuration (secrets or hardware) will trigger a restart of your app."* — <https://huggingface.co/docs/huggingface_hub/guides/manage-spaces>
- manual pause/restart, factory reboot, and crashes (*"If a running Space starts to fail, it will be automatically suspended"* — <https://huggingface.co/docs/hub/spaces-gpus#billing>).

I observed this live: three Spaces I probed returned an immediate `HTTP/2 503` with no `x-proxied-*` headers — sleeping, nothing behind the proxy. A sleeping Space answers `503` on its `.hf.space` subdomain; it is the *Space page* visit that wakes it.

> **Design consequence — this is the important one.** Treat every match as **crash-tolerant**, not merely long-lived. Snapshot authoritative match state to disk on a cadence (say every 5–10 s, plus on every significant transition) and restore on boot. Give each match an id and let clients rejoin by id after a reconnect. Without this, an unlucky `git push` mid-match destroys every game in progress.

### 3.4 Cold start

**[UNVERIFIED — no published number.]** What is documented:

- `startup_duration_timeout` defaults to **30 minutes** — *"the maximum time your Space is allowed to start before it times out and is flagged as unhealthy"* — <https://huggingface.co/docs/hub/spaces-config-reference>. That is a ceiling, not an expectation.
- A wake from sleep re-provisions a VM and starts the container. There is no rebuild (the image is cached), so cold start ≈ VM provisioning + `node server/index.js`. For a zero-dependency Node app, process start is milliseconds; the VM is the cost.
- Practical expectation: **tens of seconds**, not minutes. Measure it once deployed; do not design around a guess.

**Mitigation for players:** the first visitor after a sleep will hit a `503` on the raw subdomain. Serve a friendly retry/loading page and have the client retry the WebSocket with backoff.

### 3.5 "Always on"

There is no free always-on option.

- **Upgrade to CPU Upgrade — $0.03/hour** (8 vCPU / 32 GB) — <https://huggingface.co/docs/hub/spaces-gpus#cpu>. *"Upgraded Spaces run indefinitely by default, even if there is no usage."* — <https://huggingface.co/docs/hub/spaces-gpus#billing>. That is ~**$21.60/month** if left running, billed by the minute while `Starting` or `Running`, and **not** billed during build or while paused.
- **Do not build an external keep-alive pinger.** A user who pinged `/health/ready` every 2 minutes from a Cloudflare Worker had the Space **paused for abuse** — <https://discuss.huggingface.co/t/keepalive-ping-get-health-ready-every-2-minutes/176238>. (Community thread, not staff guidance — but the outcome is real and the downside is losing the Space.)

**Recommendation:** ship on free CPU Basic with proper snapshot/restore. 48 h of idle tolerance is plenty for a game people actually play; if it gets traction, $0.03/h removes the problem entirely.

---

## 4. Persistent storage

### 4.1 The old model is gone

> **`suggested_storage`** … *"**The persistent storage feature is no longer available so this setting will be ignored.**"*
> — <https://huggingface.co/docs/hub/spaces-config-reference>

The paid Small/Medium/Large `/data` tiers are no longer the mechanism. The replacement is **Storage Buckets attached as volumes**.

### 4.2 Everything else is ephemeral

> *"Every Space comes with a small amount of disk storage. This disk space is **ephemeral**, meaning its content will be lost if your Space restarts or is stopped."*
> — <https://huggingface.co/docs/hub/spaces-storage>
>
> *"The data written on disk is lost whenever your Docker Space restarts. To persist data across restarts, you can attach a Storage Bucket to your Space."*
> — <https://huggingface.co/docs/hub/spaces-sdks-docker#data-persistence>

The 50 GB container disk survives nothing. Anything not in a mounted bucket is gone on restart, rebuild, sleep or crash.

### 4.3 How `/data` works now

> *"Storage Buckets are the recommended way to persist data in your Space. Attached buckets are mounted into the Space container at the path you specify, making their contents available as local files at runtime. Buckets can be attached when creating a Space, from the Space settings UI, or programmatically… They can be mounted read-write (the default) or read-only."*
> — <https://huggingface.co/docs/hub/spaces-storage#attached-volumes>

Buckets are S3-like, **non-versioned and mutable**, built on Xet — <https://huggingface.co/docs/hub/storage-buckets>. That suits snapshot files far better than the old "commit to a dataset repo" trick.

**Concrete recipe** (HF's own, from the Label Studio guide — <https://huggingface.co/docs/hub/spaces-sdks-docker-label-studio#enable-persistence-with-hf-storage-buckets>):

```bash
# 1. create the bucket
hf buckets create Almaatla/spacecities-data --private

# 2. attach it at /data  (UI: Space Settings → Storage Buckets, mount path /data)
hf spaces volumes set Almaatla/SpaceCities -v hf://buckets/Almaatla/spacecities-data:/data

# 3. factory rebuild so the mount takes effect
hf spaces restart Almaatla/SpaceCities --factory-reboot
```

Or in Python — <https://huggingface.co/docs/huggingface_hub/guides/manage-spaces#mount-volumes-in-your-space>:

```python
from huggingface_hub import HfApi, Volume
api = HfApi()
api.set_space_volumes(
    "Almaatla/SpaceCities",
    volumes=[Volume(type="bucket", source="Almaatla/spacecities-data", mount_path="/data")],
)
api.restart_space("Almaatla/SpaceCities", factory_reboot=True)
```

> ⚠️ `set_space_volumes` **replaces** the full volume list: *"Setting volumes replaces any previously mounted volumes."* Read `api.get_space_runtime(...).volumes` first if anything is already attached.
> ⚠️ Only buckets support **read-write**: *"Models, datasets, and Spaces are always mounted as read-only. Only storage buckets support read-write mounts."*

### 4.4 Free tier and size

> *"Buckets are available to all users and organizations."* … *"As for other repositories, buckets are free to create and have a free storage allowance."*
> — <https://huggingface.co/docs/hub/storage-buckets>

A **free user gets 100 GB of private storage** — <https://huggingface.co/docs/hub/storage-limits#storage-plans>. Match snapshots are kilobytes. **A private bucket is comfortably free for this project.**

### 4.5 Survival matrix

| Event | Container disk | Mounted bucket |
|---|---|---|
| Restart / sleep→wake | ❌ lost | ✅ survives |
| Rebuild (git push) | ❌ lost | ✅ survives |
| Factory reboot | ❌ lost | ✅ survives |
| Space deleted | ❌ | ✅ (bucket is a separate repo) |

Buckets are a distinct repo type with their own lifecycle, so they outlive the Space. Note the flip side: *"deletions are immediate and permanent — there is no way to recover a deleted file."*

### 4.6 Build-time restriction

> *"At the moment, `/data` volume is **only available at runtime**, i.e. you cannot use `/data` during the build step of your Dockerfile."*
> — <https://huggingface.co/docs/hub/spaces-sdks-docker#data-persistence>

So: no seeding `/data` from the Dockerfile. Create directories and default files **at server startup**, idempotently.

### 4.7 Action item on the current Space

The existing Dockerfile does `RUN mkdir /data && chmod 777 /data` and `RUN rm -rf data && ln -s /data data`. Given that classic persistent storage is retired, that `/data` is now **almost certainly a plain ephemeral directory** unless a bucket happens to be attached. **Verify in Space Settings → Storage Buckets (or `hf spaces volumes ls Almaatla/SpaceCities`) before assuming any existing data survives the overwrite — and back up anything in there first.**

---

## 5. Secrets & variables

### 5.1 Setting them

Space **Settings** page → *Variables and secrets*. — <https://huggingface.co/docs/hub/spaces-overview#managing-secrets>

> *"**Variables** if you need to store non-sensitive configuration values. They are publicly accessible and viewable and will be automatically added to Spaces duplicated from yours. **Secrets** to store access tokens, API keys, or any sensitive values or credentials. They are private and their value cannot be read from the Space's settings page once set. They won't be added to Spaces duplicated from your repository."*

Programmatically: `api.add_space_secret(repo_id, key, value)` / `api.add_space_variable(...)` — <https://huggingface.co/docs/huggingface_hub/guides/manage-spaces#configure-secrets-and-variables>. Secret values are write-only on read-back.

### 5.2 Build-time vs runtime — the part that bites

| | Build time | Runtime |
|---|---|---|
| **Variables** | Passed as Docker **`build-arg`s** — declare with `ARG NAME` in the Dockerfile | Injected as env vars |
| **Secrets** | **NOT** env vars and **NOT** build-args. Must be explicitly mounted per-`RUN` | Injected as env vars |

> *"Variables are passed as `build-arg`s when building your Docker Space."*
> *"In Docker Spaces, the secrets management is different for security reasons. Once you create a secret in the Settings tab, you can expose the secret by adding the following line in your Dockerfile: … you can read it at build time by mounting it to a file, then reading it with `$(cat /run/secrets/SECRET_EXAMPLE)`."*
> — <https://huggingface.co/docs/hub/spaces-sdks-docker#secrets-and-variables-management>

```dockerfile
# Build-time secret access — the ONLY way. Not available as $ENV during build.
RUN --mount=type=secret,id=SECRET_EXAMPLE,mode=0444,required=true \
    some-command --token "$(cat /run/secrets/SECRET_EXAMPLE)"
```

> **Takeaway for SpaceCities:** we have no build step and need no build-time secrets. Read everything at runtime. Do not add `ARG`/`ENV` lines for secrets — they'd bake values into image layers.

### 5.3 Reading them in Node

Plain `process.env`. Nothing HF-specific:

```js
// config.js — read at runtime; never at import-time-with-throw, or a missing
// secret turns into a boot loop and an auto-suspended Space.
export const config = {
  port:      Number(process.env.PORT ?? 7860),
  host:      process.env.HOST ?? '0.0.0.0',
  dataDir:   process.env.DATA_DIR ?? '/data',
  mcpToken:  process.env.MCP_TOKEN ?? null,      // Space *secret*
  spaceHost: process.env.SPACE_HOST ?? null,     // injected by HF
  spaceId:   process.env.SPACE_ID ?? null,       // injected by HF
};
```

HF injects these automatically at runtime — <https://huggingface.co/docs/hub/spaces-overview#built-in-environment-variables>:
`SPACE_ID`, `SPACE_HOST` (e.g. `almaatla-spacecities.hf.space`), `SPACE_AUTHOR_NAME`, `SPACE_REPO_NAME`, `SPACE_TITLE`, `SPACE_CREATOR_USER_ID`, `CPU_CORES`, `MEMORY`, `ACCELERATOR`.

`SPACE_HOST` is the clean way to build absolute URLs (MCP endpoint advertisement, OAuth redirect URIs) without hard-coding the subdomain.

> ⚠️ **Changing a secret or variable restarts the Space** — *"Any change in your Space configuration (secrets or hardware) will trigger a restart of your app."* Every in-flight match dies. Set them once, before launch.

> ⚠️ HF runs a **Secrets Scanner** and warns owners about hard-coded secrets — <https://huggingface.co/docs/hub/spaces-overview#managing-secrets>. Since the Space will be public, this matters.

---

## 6. README front-matter / Space config

Config lives in the YAML block at the top of `README.md` **at the repo root** — <https://huggingface.co/docs/hub/spaces-config-reference>.

### 6.1 Recommended block for SpaceCities

```yaml
---
title: SpaceCities
emoji: 🚀
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: Multiplayer real-time strategy, playable by humans and AI agents.
header: mini
fullWidth: true
tags:
  - game
  - multiplayer
  - websocket
  - mcp
---
```

### 6.2 Key reference (verbatim from the config reference)

| Key | Type | Notes |
|---|---|---|
| `title` | string | Display title. Also surfaces as `SPACE_TITLE` env var. |
| `emoji` | string | *"Space emoji (emoji-only character allowed)."* |
| `colorFrom` / `colorTo` | string | Thumbnail gradient. One of `red, yellow, green, blue, indigo, purple, pink, gray`. |
| `sdk` | string | *"Can be either `gradio`, `docker`, or `static`."* → **`docker`** |
| **`app_port`** | int | *"Port on which your application is running. **Used only if `sdk` is `docker`. Default port is `7860`.**"* |
| `pinned` | bool | Keeps the Space at the top of your profile. |
| `license` | string | Standard SPDX-ish identifier. |
| `short_description` | string | *"Displayed in the Space's thumbnail."* |
| `tags` | list | Free-form descriptors. |
| `header` | string | `mini` or `default`. *"If `header` is set to `mini` the space will be displayed full-screen with a mini floating header."* — **want this for a game.** |
| `fullWidth` | bool | *"Whether your Space is rendered inside a full-width … or fixed-width column … inside the iframe. Defaults to `true`."* |
| `disable_embedding` | bool | *"Whether the Space iframe can be embedded in other websites. Defaults to false, i.e. Spaces *can* be embedded."* |
| `startup_duration_timeout` | string | *"maximum time your Space is allowed to start before it times out and is flagged as unhealthy. Defaults to 30 minutes."* |
| `custom_headers` | dict | **Only** COEP / COOP / CORP are allowed. All keys and values lowercase. |
| `base_path` | string | *"For non-static Spaces, initial url to render. Needs to start with `/`."* |
| `hf_oauth` (+ `hf_oauth_scopes`, `hf_oauth_expiration_minutes`, `hf_oauth_authorized_org`) | — | Sign-in with HF. See [§9.4](#94-optional-hf-oauth-for-identity). |
| `models` / `datasets` | list | Linked Hub artefacts; auto-parsed from code if omitted. |
| `suggested_hardware` | string | `cpu-basic`, `cpu-upgrade`, … *"Setting this value will not automatically assign an hardware."* |
| `suggested_storage` | string | ⚠️ **Ignored — persistent storage feature is retired.** Do not use. |
| `python_version`, `sdk_version`, `app_file`, `app_build_command`, `preload_from_hub` | — | Gradio/static only. **Not applicable to a Docker Space.** |

### 6.3 Is `app_port` needed?

**No — 7860 is the default**, and the existing Space runs on 7860 with no `app_port` key. Include it anyway: it is one line, it documents intent, and it prevents a future port change from silently 503-ing.

### 6.4 The front-matter trap

**Whatever deploy mechanism you use overwrites the Space's `README.md` with the GitHub repo's `README.md`.** If the GitHub README has no YAML front-matter, the Space loses `sdk: docker` and **stops building**. The current Space README (`title: Voice Notes`, `sdk: docker`) will be replaced.

→ **Put the block above at the top of the GitHub repo's root `README.md` before the first deploy.** This is the single most likely way to break the first deployment.

---

## 7. Deploying from GitHub via Actions

### 7.1 What HF currently documents

The canonical path changed: HF now points at an official action, `huggingface/hub-sync`.

> *"You can keep your Space in sync with your GitHub repository using the official `huggingface/hub-sync` GitHub Action."*
> — <https://huggingface.co/docs/hub/spaces-github-actions>

Parameters — <https://huggingface.co/docs/hub/repositories-github-actions#parameters>:

| Parameter | Required | Default | Description |
|---|---|---|---|
| `github_repo_id` | Yes | — | Use `${{ github.repository }}` |
| `huggingface_repo_id` | Yes | — | `username/repo-name` |
| `hf_token` | Yes | — | HF access token |
| `repo_type` | No | `space` | `space` / `model` / `dataset` |
| `space_sdk` | No | **`gradio`** | ⚠️ **must set to `docker`** |
| `private` | No | `false` | Whether to create the repo as private |
| `subdirectory` | No | `.` | For monorepos |

Mechanics: *"The action mirrors your files to the Hub using the `hf` CLI — **it is not a git-to-git sync**. It automatically excludes `.github/` and `.git/` directories and mirrors deletions (files removed from GitHub will be removed from the Hub)."*

### 7.2 Recommended workflow — `hub-sync`

**This is the right choice here, and it dissolves the "existing unrelated history" problem entirely.** Because it uploads file *contents* rather than pushing git objects, there is no common-ancestor check, no non-fast-forward rejection, and no force push. The Space's existing history is simply extended by one commit whose tree is your GitHub tree; the old files (`app.py`, `requirements.txt`, `static/index.html`, `data/sample.txt`) are **deleted** by the mirror, which is exactly the "overwrite entirely" semantics we want.

`.github/workflows/deploy-hf.yml`:

```yaml
name: Deploy to Hugging Face Space

on:
  push:
    branches: [main]
  workflow_dispatch:

# Only one deploy at a time; a superseded deploy is pointless and each push
# rebuilds the Space (and kills every in-flight match).
concurrency:
  group: deploy-hf-space
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Check out the repository
        uses: actions/checkout@v6
        # hub-sync uploads the working tree, not git history, so the default
        # shallow checkout is fine here. No fetch-depth: 0 needed.

      - name: Sanity-check the Space front-matter before publishing
        run: |
          head -n 1 README.md | grep -qx -- '---' \
            || { echo "::error::README.md must start with the Space YAML front-matter"; exit 1; }
          grep -qE '^sdk:[[:space:]]*docker$' README.md \
            || { echo "::error::README.md front-matter must contain 'sdk: docker'"; exit 1; }
          test -f Dockerfile \
            || { echo "::error::Dockerfile is missing"; exit 1; }

      - name: Sync to the Hugging Face Space
        uses: huggingface/hub-sync@v0.1.0
        with:
          github_repo_id: ${{ github.repository }}
          huggingface_repo_id: Almaatla/SpaceCities
          hf_token: ${{ secrets.HF_TOKEN }}
          repo_type: space
          space_sdk: docker      # REQUIRED — the default is `gradio`
```

Verified: `huggingface/hub-sync` exists on GitHub at version **0.1.0**, uploads via *"the official HF CLI via `uvx`"*, performs *"true mirroring"* that *"deletes removed files from HF using `--delete=\"*\"`"*, and excludes `.github/` and `.git/` — <https://github.com/huggingface/hub-sync>.

**Token:** *"Create a Hugging Face access token with **write** permission to the target repo. For better security, use a fine-grained token scoped to only the repository you're syncing to."* — <https://huggingface.co/docs/hub/repositories-github-actions#setup>. Create at <https://huggingface.co/settings/tokens>, store as the GitHub Actions secret `HF_TOKEN`.

**Caveats specific to `hub-sync`:**

- ⚠️ `private` defaults to `false`. It is documented only as *"Whether to create the repo as private"*, so it should not touch an existing repo's visibility — but **[UNVERIFIED]**. Since we want the Space public anyway ([§9](#9-private-vs-public)), flip it to public in Settings first and the ambiguity disappears.
- ⚠️ It calls `hf repo create`. On a free account this is the step most exposed to the paid-plan gate ([§3.1](#31-the-paid-plan-caveat)). The repo already exists, so it should no-op — but if the first run fails with a plan/quota error, switch to §7.3.
- ⚠️ `.github/` is excluded, so this workflow file never lands in the public Space. Good.

### 7.3 Alternative: direct git force-push

Use this if `hub-sync` trips over the plan gate, or if you want byte-exact git-level control. HF documents the shape — <https://huggingface.co/docs/hub/spaces-github-actions#alternative-manual-git-push> — but its snippet uses a **plain `git push`, which will fail here**, because the Space's history is unrelated to the GitHub repo's history (non-fast-forward). You must force.

```yaml
name: Deploy to Hugging Face Space (git force-push)

on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: deploy-hf-space
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Check out the full history
        uses: actions/checkout@v6
        with:
          # REQUIRED. A shallow clone cannot be pushed: git refuses with
          # "shallow update not allowed". Force-pushing needs real history.
          fetch-depth: 0
          # Only needed if this repo tracks files with Git LFS. Spaces requires
          # LFS for files >10MB. Harmless if unused.
          lfs: true

      - name: Verify the Space front-matter
        run: |
          head -n 1 README.md | grep -qx -- '---' \
            || { echo "::error::README.md must start with the Space YAML front-matter"; exit 1; }
          grep -qE '^sdk:[[:space:]]*docker$' README.md \
            || { echo "::error::README.md front-matter must contain 'sdk: docker'"; exit 1; }

      - name: Force-push to the Space, replacing its unrelated history
        env:
          HF_TOKEN: ${{ secrets.HF_TOKEN }}
          HF_USER: Almaatla
          HF_SPACE: Almaatla/SpaceCities
        run: |
          # No `set -x` — it would echo the URL, and with it the token.
          set -euo pipefail
          git lfs install --local || true
          git push --force \
            "https://${HF_USER}:${HF_TOKEN}@huggingface.co/spaces/${HF_SPACE}.git" \
            HEAD:refs/heads/main
```

**On each point the task asked about:**

- **Remote URL form:** `https://<hf-username>:<token>@huggingface.co/spaces/<owner>/<name>.git`. This is the form HF documents (`git push https://HF_USERNAME:$HF_TOKEN@huggingface.co/spaces/HF_USERNAME/SPACE_NAME main`). The username component is not meaningfully validated; the token is what authenticates. An `Authorization` header via `http.extraheader` is the alternative, but it is *worse* for leak-safety in Actions: it persists into `.git/config` and shows up in `git config --list` debug output, whereas GitHub Actions automatically masks the value of `secrets.HF_TOKEN` wherever it appears in logs.
- **`fetch-depth: 0`:** **required.** `actions/checkout` defaults to a depth-1 shallow clone, and git will not push shallow history to a remote that lacks the objects.
- **LFS:** Spaces requires Git-LFS for files over 10 MB — *"For files larger than 10MB, Spaces requires Git-LFS. Make sure large files in your GitHub repository are tracked with LFS before syncing."* — <https://huggingface.co/docs/hub/spaces-github-actions#file-size-considerations>. SpaceCities is source + small static assets, so this should not apply; keep `lfs: true` as cheap insurance. Note the force-push **removes the Space's existing `.gitattributes`** — fine for a no-LFS repo, but if you later add LFS you must commit a `.gitattributes` in GitHub.
- **Force-push semantics & the existing history:** the Space repo has unrelated commits (a "Voice Notes" FastAPI app). `--force` with `HEAD:refs/heads/main` replaces the branch pointer wholesale; the old tree becomes unreachable. This is deliberate and is what "we will overwrite this Space entirely" means. It is **destructive and not undoable from CI** — take a backup clone of the Space first if anything there matters.
- **Token leaking:** three defences, all applied above — (1) the token only ever exists as `${{ secrets.HF_TOKEN }}` → an env var, which Actions masks in logs; (2) no `set -x` / no `echo` of the URL; (3) `permissions: contents: read` so the job holds no other privilege. Prefer a **fine-grained token scoped to just this Space repo** so a leak is contained.
- **`.github/` is pushed** by this variant (unlike `hub-sync`). On a public Space that exposes the workflow file — no secret values, but be aware.

### 7.4 Keyless alternative: Trusted Publishers

HF now supports OIDC token exchange, removing the stored secret entirely:

> *"Push to the Hub from CI without storing an `HF_TOKEN` secret. Your CI job proves its identity to Hugging Face using a short-lived OpenID Connect (OIDC) token from your CI provider, and gets back a short-lived Hugging Face token in exchange."*
> — <https://huggingface.co/docs/hub/trusted-publishers>

Configure on `https://huggingface.co/spaces/Almaatla/SpaceCities/settings` → **Trusted Publishers** with claims `repository = alma92350/SpaceCities`, `branch = main`, `workflow = deploy-hf.yml`; then:

```yaml
    permissions:
      id-token: write   # required so the job can request an OIDC token
      contents: read
    steps:
      - uses: actions/checkout@v6
      - run: |
          curl -LsSf https://hf.co/cli/install.sh | bash
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"
      - env:
          HF_OIDC_RESOURCE: spaces/Almaatla/SpaceCities
        run: hf upload spaces/Almaatla/SpaceCities . . --commit-message "Deploy ${GITHUB_SHA::7}"
```

Tokens live 60 minutes and are scoped to one repo. **The user has already created `HF_TOKEN` in GitHub, so §7.2 is the path of least resistance today** — note this as the hardening follow-up.

---

## 8. Node 22 Dockerfile for a HF Docker Space

### 8.1 The UID-1000 rule, and the trap in `node:*` images

> *"The container runs with user ID 1000. To avoid permission issues you should create a user and set its `WORKDIR` before any `COPY` or download."*
> — <https://huggingface.co/docs/hub/spaces-sdks-docker#permissions>

> ⚠️ **Do not copy `RUN useradd -m -u 1000 user` from the Python examples into a Node image.** The official `node:*` images already ship a `node` user **at UID 1000**, so `useradd -u 1000` fails the build with *"UID 1000 is not unique"*. HF's own Node example sidesteps this by not creating a user at all — it just does `RUN chown 1000 /app` then `USER 1000` — <https://huggingface.co/docs/hub/spaces-dev-mode#example-of-compatible-dockerfiles>. That is the pattern used below. HF's requirement is about the **UID**, not the username.

Also from the permissions docs: *"Always specify the `--chown=user` with `ADD` and `COPY`"*, and *"You should always avoid superfluous chowns… a recursive chown can result in a very large image due to the duplication of all affected files."* Hence `COPY --chown=1000:1000` plus a single **non-recursive** `chown` on the `WORKDIR`.

### 8.2 The Dockerfile

```dockerfile
# SpaceCities — Node 22 game server for a Hugging Face Docker Space
# Docs: https://huggingface.co/docs/hub/spaces-sdks-docker
#
# Design notes:
#  - Zero npm dependencies: there is deliberately no `npm ci` / `npm install`.
#  - Debian-slim base: HF states alpine is untested for Dev Mode, and glibc
#    avoids musl surprises. (https://huggingface.co/docs/hub/spaces-dev-mode)
#  - UID 1000 is mandatory. node:* images already provide it as the `node`
#    user, so we reuse that UID instead of calling useradd (which would fail).

FROM node:22-slim

# Utilities required for Spaces Dev Mode (a PRO feature) and generally useful
# for debugging a running container. Drop this layer to shave ~40MB if you
# never intend to SSH in.
# https://huggingface.co/docs/hub/spaces-dev-mode#docker-spaces
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash curl wget procps git git-lfs ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    # HF proxies external traffic to this single port; 7860 is the Spaces
    # default and matches `app_port` in README.md.
    PORT=7860 \
    # Must be 0.0.0.0 — binding 127.0.0.1 makes the app unreachable.
    HOST=0.0.0.0 \
    # Mount a Storage Bucket here to persist match snapshots.
    # https://huggingface.co/docs/hub/spaces-storage#attached-volumes
    DATA_DIR=/data

# Dev Mode requires the app to live in /app and /app to be owned by UID 1000.
WORKDIR /app

# Fallback so the server still boots when no bucket is attached. NOTE: /data is
# NOT available during build, so we only prepare the mount point here; the app
# must create its subdirectories at runtime.
# https://huggingface.co/docs/hub/spaces-sdks-docker#data-persistence
RUN mkdir -p /data && chown 1000:1000 /data

# Ship the source owned by UID 1000 (HF: prefer --chown over a later chown -R).
COPY --chown=1000:1000 . /app

# Single, non-recursive chown for the WORKDIR itself (created as root above).
RUN chown 1000:1000 /app

USER 1000

# Documentation only — Spaces routes via `app_port`, not EXPOSE.
EXPOSE 7860

# A CMD instruction is required for Dev Mode compatibility.
CMD ["node", "src/server/index.js"]
```

### 8.3 Companion `.dockerignore`

```gitignore
.git
.github
node_modules
docs
*.md
!README.md
.DS_Store
coverage
test
```

### 8.4 Server-side expectations this Dockerfile encodes

```js
import http from 'node:http';
import fs from 'node:fs/promises';

const PORT     = Number(process.env.PORT ?? 7860);
const HOST     = process.env.HOST ?? '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR ?? '/data';

// /data is unavailable at build time — create the tree on every boot.
await fs.mkdir(`${DATA_DIR}/matches`, { recursive: true });

const server = http.createServer(/* static files + /mcp + /healthz */);
// Multiplex the game WebSocket onto the same port — only one is exposed.
server.on('upgrade', (req, socket, head) => { /* validate Origin, then accept */ });
server.listen(PORT, HOST);
```

Three things this must get right, all covered above: bind `0.0.0.0:7860`; create `DATA_DIR` subtrees at startup, never at build; and share one port across static, `/ws` and `/mcp`.

### 8.5 Image size & build

**[UNVERIFIED]** — HF publishes no explicit image-size or build-timeout limit for Docker Spaces. What is documented is `startup_duration_timeout` (default 30 min), which governs *start*, not build. `node:22-slim` plus a dependency-free source tree lands around 250 MB, far below anything plausible. Not a risk.

---

## 9. Private vs public

### 9.1 Private is fatal for multiplayer

Spaces now have **three** visibility levels — <https://huggingface.co/docs/hub/spaces-overview#space-visibility>:

| | Public | Protected | Private |
|---|---|---|---|
| Source code on the Hub | Visible to everyone | Private (owner/collaborators) | Private (owner/collaborators) |
| **App accessible via embed URL** | **Yes** | **Yes** | **No** |
| App accessible via custom domain | Yes | Yes | No |
| Clonable by others | Yes | No | No |

> *"**Private** Spaces are fully private: the source code and the running app are only accessible to the owner and collaborators. The Space will not appear in search results and other users will receive a `404` error when visiting its URL."*

**So: on the current private Space, no one but `Almaatla` (and collaborators) can reach the game at all.** Not "they must log in" — they get a `404`. Anonymous players cannot connect. Neither can an external AI agent hitting the MCP endpoint without owner credentials.

Embedding confirms the same boundary: *"To embed a Space its visibility needs to be **public** or **protected**."* — <https://huggingface.co/docs/hub/spaces-embed>

### 9.2 Recommendation

**Make the Space public.** Settings → visibility dropdown.

- **Public** is the only free option that lets anonymous players connect. Consequence: the source is world-readable — fine for this project, and it means the repo must contain **no secrets** (HF's Secrets Scanner will flag any that slip in).
- **Protected** would be ideal — running app public, source private — but *"Protected visibility is part of PRO or Team & Enterprise plans"* — <https://huggingface.co/docs/hub/spaces-overview#space-visibility>. Not available on this account today ($9/mo if source privacy later matters).

### 9.3 Public means genuinely open — design for it

There is **no HF-provided authentication in front of a public Space.** Anyone with the URL reaches your WebSocket and your `/mcp` endpoint. Combined with the edge's permissive CORS ([§10.3](#103-cors-is-handled-and-widened-by-the-edge)), plan for:

- **Validate the `Origin` header on every WebSocket upgrade.** Browsers send `Origin` on WS handshakes but enforce **no** same-origin policy on WebSockets — that check is the server's job. Accept only your own `.hf.space` origin (and localhost in dev). Without it, any website can silently open sockets to your game as a visiting player's browser.
- **Gate the MCP endpoint with a bearer token** stored as a Space *secret*, unless agent access is meant to be fully open.
- **Rate-limit** connections and messages per IP/session. See [§10.5](#105-client-ip-and-x-forwarded-headers) on identifying clients.
- Assume the client is hostile: the server is already authoritative, which is the right architecture here.

### 9.4 Optional: HF OAuth for identity

If you want real player identities rather than anonymous nicknames, `hf_oauth: true` in the README front-matter provisions an OAuth app and injects `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_SCOPES`, `OPENID_PROVIDER_URL` — <https://huggingface.co/docs/hub/spaces-oauth>. `openid profile` are always granted. Redirect URI can be `https://{SPACE_HOST}/login/callback`. Node has first-class support via `@huggingface/hub` or `openid-client`.

> ⚠️ *"You should use `target=_blank` on the button to open the sign-in page in a new tab, unless you run the space outside its `iframe`. Otherwise, you might encounter issues with cookies on some browsers."*

This is **optional** and adds friction for casual players. Suggest: anonymous play by default, optional HF sign-in for persistent profiles.

---

## 10. Everything else that will bite us

### 10.1 The edge is a reverse proxy that rewrites and annotates

Verified against a live running Space:

```console
$ curl -sS -o /dev/null -D - https://almaatla-private-room.hf.space/
HTTP/2 200
server: uvicorn
x-proxied-host: http://10.112.58.9
x-proxied-replica: uxm7fnh3-hqx78
x-proxied-path: /
link: <https://huggingface.co/spaces/Almaatla/private-room>;rel="canonical"
x-request-id: NGHCsT
vary: origin, access-control-request-method, access-control-request-headers
access-control-expose-headers: *
```

The `x-proxied-replica` header confirms replica-aware routing. **Implication:** if you ever scale to multiple replicas (*"Replicas are only available for upgraded (paid) hardware"* — <https://huggingface.co/docs/hub/spaces-gpus#replicas>), in-memory match state does **not** shard correctly. **[UNVERIFIED]** whether WS connections are sticky per replica. On free CPU Basic there is exactly one replica, so this is a future concern only — but it means "scale up to handle more players" is *not* a free lever.

### 10.2 HTTP/2 at the edge

Ordinary requests are served over **HTTP/2** (`HTTP/2 200` above), while the WebSocket upgrade came back as `HTTP/1.1 403` — the edge negotiates down for upgrades. Two consequences:

- **Good:** HTTP/2 multiplexing removes the 6-connections-per-host limit, so SSE and parallel asset loads are cheap.
- **Neutral:** browsers open WebSockets over HTTP/1.1 regardless; RFC 8441 Extended CONNECT is not needed and its absence changes nothing.

### 10.3 CORS is handled — and widened — by the edge

Verified:

```console
$ curl -o /dev/null -D - -H "Origin: https://example.com" https://almaatla-private-room.hf.space/
access-control-allow-origin: https://example.com          # ← arbitrary origin reflected

$ curl -o /dev/null -D - -X OPTIONS \
      -H "Origin: https://example.com" \
      -H "Access-Control-Request-Method: POST" \
      https://almaatla-private-room.hf.space/
HTTP/2 200
access-control-allow-methods: POST
access-control-max-age: 600
access-control-allow-origin: https://example.com
```

Note the preflight carries **no `x-proxied-*` headers** and `content-length: 0` — **the edge answers `OPTIONS` itself; it never reaches the container.**

- ✅ **You do not need CORS middleware in the Node app** for ordinary cross-origin `GET`/`POST`. The edge reflects any origin.
- ⚠️ **Conversely you cannot restrict CORS from your app either** — the edge's reflection wins for preflights. Any website can invoke your endpoints cross-origin.
- ✅ No `access-control-allow-credentials` was returned, so browsers will **not** send cookies cross-origin. Do not rely on cookie-based auth for the MCP endpoint; use a bearer token.
- ⚠️ Your Node app **cannot see `OPTIONS` requests** at all. Don't build MCP CORS negotiation that depends on observing the preflight.
- ⚠️ This makes the `Origin` check on the WebSocket upgrade ([§9.3](#93-public-means-genuinely-open--design-for-it)) load-bearing, not optional.

### 10.4 Request body size

A **12 MB** `POST` reached the container intact (`x-proxied-*` present on the response). No aggressive proxy body cap at that scale. **[UNVERIFIED]** above 12 MB. Irrelevant for a game whose largest message is a lobby config.

### 10.5 Client IP and `X-Forwarded-*`

**[UNVERIFIED]** — HF does not document which forwarding headers the edge injects. What *is* documented: for ZeroGPU Space-to-Space calls, HF uses an **`x-ip-token`** header that apps forward to attribute the caller — <https://huggingface.co/docs/hub/spaces-api-endpoints#calling-spaces-from-another-space>. That indicates HF has its own identity-header conventions rather than relying on `X-Forwarded-For`.

**Guidance:** do **not** trust `X-Forwarded-For` for rate limiting without first verifying what actually arrives. Easiest verification: add a temporary `/debug/headers` route to the deployed Space that echoes `req.headers`, hit it once, then remove it. Until then, rate-limit on **session/connection identity** (a server-issued token) rather than IP.

### 10.6 Build & deploy behaviour

- **Every push rebuilds and restarts.** *"Each time a new commit is pushed, the Space will automatically rebuild and restart."* Batch changes; avoid deploying during peak play.
- **No cost during build:** *"it is only billed when the Space is `Starting` or `Running`… there is no cost during build."* — <https://huggingface.co/docs/hub/spaces-gpus#billing>
- **Repeated failures auto-suspend:** *"If a running Space starts to fail, it will be automatically suspended."* A crash-looping server will take the Space down. **Add a supervisor-friendly top-level error handler and never `process.exit(1)` on a recoverable error.**
- **Debugging:** Build and Container logs in the UI, or `hf spaces logs Almaatla/SpaceCities -f` — <https://huggingface.co/docs/huggingface_hub/guides/manage-spaces#debug-a-failing-space-by-reading-its-logs>.
- **`custom_headers` is restrictive:** only COEP/COOP/CORP, lowercase. You **cannot** set CSP, HSTS or arbitrary headers via front-matter — set them from Node instead.

### 10.7 Repo hygiene

- Files >10 MB require Git-LFS on Spaces — <https://huggingface.co/docs/hub/spaces-github-actions#file-size-considerations>.
- General repo guidance: <100k files, <10k entries per folder — <https://huggingface.co/docs/hub/storage-limits#recommendations>. Trivially satisfied.
- Free account: 100 GB private storage, best-effort public storage — <https://huggingface.co/docs/hub/storage-limits#storage-plans>.

### 10.8 Sleeping Spaces answer `503`

Observed on three sleeping Spaces: immediate `HTTP/2 503`, no `x-proxied-*`. *"Anyone visiting your Space will restart it automatically."* — the wake is triggered by visiting the Space; a bare `fetch()` to the subdomain returned `503` without appearing to warm it. **Ship a client that retries with backoff and shows "waking the server…" rather than a hard error.**

---

## 11. Things I could NOT verify

Do not treat any of these as settled. Each is a candidate for a 10-minute empirical test once the Space is live.

| # | Unverified claim | Why it matters | How to settle it |
|---|---|---|---|
| U1 | **Whether a free (non-PRO) account can push to and rebuild an *existing* Docker Space.** Docs only gate *creation*. | If not, the whole plan needs PRO ($9/mo). | Push a trivial commit to the Space and watch the build. **Do this first.** |
| U2 | WebSocket **idle timeout** at the edge. | Governs lobby/spectator sockets. | Open a WS, send nothing, time the close. A 20 Hz match is never idle regardless. |
| U3 | WebSocket **max message size**, **max connection duration**, **max concurrent connections**. | Ceiling on player count. | Load-test with a script; measure. |
| U4 | **Cold-start time** from sleep. | First-player experience. | Let it sleep 48 h, then time a wake. |
| U5 | Whether a **mounted bucket at `/data` is writable by UID 1000**. Docs say buckets mount read-write by default but say nothing about ownership. | Snapshot persistence silently fails if not. | Attach the bucket, factory reboot, `fs.writeFile` on boot, check the log. |
| U6 | Whether `hub-sync`'s `private: false` default **changes an existing Space's visibility**. | Could unexpectedly flip visibility. | Set visibility to public manually first; then it's moot. |
| U7 | Which **forwarding headers** (`X-Forwarded-For`, `X-Real-IP`, …) the edge injects. | Rate limiting by IP. | Temporary `/debug/headers` route. |
| U8 | Whether WebSocket connections are **sticky per replica**. | Only matters on paid multi-replica. | N/A on free tier (single replica). |
| U9 | Explicit **Docker image size limit** and **build timeout**. | None found; `node:22-slim` is small enough that it's academic. | — |
| U10 | Request body limit **above 12 MB**. | Not relevant to this workload. | — |
| U11 | Whether the existing Space currently has a **bucket attached at `/data`**. | Determines whether existing data survives the overwrite. | `hf spaces volumes ls Almaatla/SpaceCities`, or check Settings. |

---

## 12. Ordered action list

1. **Verify U1** — push a no-op commit to `Almaatla/SpaceCities` and confirm it builds on the free plan. Everything else depends on this.
2. **Check U11 and back up** — `hf spaces volumes ls Almaatla/SpaceCities`; clone the Space repo locally before any force-push. The overwrite is not undoable.
3. **Set the Space to public** (Settings → visibility). Without this there is no multiplayer.
4. **Put the [§6.1](#61-recommended-block-for-spacecities) YAML front-matter at the top of the GitHub repo's root `README.md`.** Most likely first-deploy failure if skipped.
5. **Add the [§8.2](#82-the-dockerfile) Dockerfile and [§8.3](#83-companion-dockerignore) `.dockerignore`.**
6. **Add [§7.2](#72-recommended-workflow--hub-sync) `.github/workflows/deploy-hf.yml`**; confirm the GitHub secret `HF_TOKEN` is a **write** token (fine-grained, scoped to this Space).
7. **Create and attach the storage bucket** ([§4.3](#43-how-data-works-now)), factory reboot, and verify U5 by writing a file on boot.
8. **Implement snapshot/restore for match state** ([§3.3](#33-sleeping--this-determines-the-whole-persistence-design)) — the single most important architectural consequence of this research.
9. **Implement the WebSocket `Origin` check and an MCP bearer token** ([§9.3](#93-public-means-genuinely-open--design-for-it)) before announcing the game.
10. **Add an application-level WS heartbeat** (~20–30 s) to sidestep U2.

---

## Sources

- Docker Spaces — <https://huggingface.co/docs/hub/spaces-sdks-docker>
- Spaces Overview (visibility, hardware, secrets, networking, env vars) — <https://huggingface.co/docs/hub/spaces-overview>
- Spaces Configuration Reference — <https://huggingface.co/docs/hub/spaces-config-reference>
- Using GPU Spaces (hardware, sleep time, billing, replicas, streaming) — <https://huggingface.co/docs/hub/spaces-gpus>
- Disk usage on Spaces — <https://huggingface.co/docs/hub/spaces-storage>
- Storage Buckets — <https://huggingface.co/docs/hub/storage-buckets>
- Storage limits — <https://huggingface.co/docs/hub/storage-limits>
- Managing Spaces with GitHub Actions — <https://huggingface.co/docs/hub/spaces-github-actions>
- GitHub Actions for Hub repos (`hub-sync` parameters) — <https://huggingface.co/docs/hub/repositories-github-actions>
- Trusted Publishers (keyless OIDC) — <https://huggingface.co/docs/hub/trusted-publishers>
- Spaces Dev Mode (Node Dockerfile, UID 1000, `/app`) — <https://huggingface.co/docs/hub/spaces-dev-mode>
- Your First Docker Space — <https://huggingface.co/docs/hub/spaces-sdks-docker-first-demo>
- Embed your Space — <https://huggingface.co/docs/hub/spaces-embed>
- Spaces Custom Domain — <https://huggingface.co/docs/hub/spaces-custom-domain>
- Sign-In with HF (OAuth) — <https://huggingface.co/docs/hub/spaces-oauth>
- Spaces as API endpoints (SSE, `x-ip-token`) — <https://huggingface.co/docs/hub/spaces-api-endpoints>
- Panel on Spaces (websockets) — <https://huggingface.co/docs/hub/spaces-sdks-docker-panel>
- Shiny on Spaces (app timeouts) — <https://huggingface.co/docs/hub/spaces-sdks-docker-shiny>
- Label Studio on Spaces (bucket persistence recipe) — <https://huggingface.co/docs/hub/spaces-sdks-docker-label-studio>
- Manage your Space (`huggingface_hub`: volumes, secrets, sleep time, logs) — <https://huggingface.co/docs/huggingface_hub/guides/manage-spaces>
- Pricing — <https://huggingface.co/pricing>
- `huggingface/hub-sync` action — <https://github.com/huggingface/hub-sync>
- Forum: WebSocket 404 on Spaces (`wss://` not `ws://`) — <https://discuss.huggingface.co/t/fastapi-websocket-returns-http-404-on-spaces/159865>
- Forum: keepalive ping flagged as abuse — <https://discuss.huggingface.co/t/keepalive-ping-get-health-ready-every-2-minutes/176238>
- Live WebSocket Docker Space (evidence) — <https://huggingface.co/spaces/langtech-innovation/WhisperLiveKitDiarization/blob/main/README.md>
- Primary probes against `https://almaatla-private-room.hf.space` (2026-08-30), reproduced inline in §1.1, §10.1, §10.3, §10.4.
