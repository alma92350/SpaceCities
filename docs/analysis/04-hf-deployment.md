# 04 — Hugging Face Spaces as a deployment target for SpaceCities

**Researched:** 2026-08-30 · **Target:** `https://huggingface.co/spaces/Almaatla/SpaceCities` (Docker SDK, currently **private**)

**Method.** Live Hugging Face documentation (`huggingface.co/docs/hub/*`), the Hub filesystem via the authenticated MCP connector, and **direct empirical probes** against a live public Docker Space (`Almaatla/private-room`) from this machine. Every non-obvious claim carries a source URL. Claims I could **not** verify are flagged inline as **[UNVERIFIED]** and collected in [§11](#11-what-i-could-not-verify).

---

## 0. Executive summary

| # | Finding | Impact |
|---|---|---|
| **F1** | **WebSockets work, and 20 Hz is comfortable.** Measured through the real HF edge: 400/400 frames round-tripped, **0% loss, p50 RTT 32.6 ms, max 48.8 ms**. | No blocker. [§1](#1-websockets) |
| **F2** | **The Space must be made public (or "protected").** A **private** Space returns **404** to everyone but the owner/collaborators — the *running app*, not just the source. | **Blocker for multiplayer.** [§9](#9-private-vs-public) |
| **F3** | **Classic persistent storage is gone.** HF now documents `suggested_storage` as *"The persistent storage feature is no longer available so this setting will be ignored."* Disk is **ephemeral**; persistence is now an attached **Storage Bucket**. | The Space's current `ln -s /data data` is almost certainly pointing at ephemeral disk. [§4](#4-persistent-storage) |
| **F4** | **Free hardware sleeps after 48 h idle**, and in-memory state dies on sleep, on every push (rebuild), and on any crash. | Long matches need snapshot + resume. [§3](#3-hardware--lifecycle) |
| **F5** | **Creating** a Docker Space now requires a paid plan (PRO for personal accounts). The Space already exists, so we are overwriting, not creating — but **do not delete it**, and avoid `hub-sync`, whose first step is `hf repo create`. | [§3.1](#31-the-paid-plan-caveat), [§7](#7-deploying-from-github-actions) |
| **F6** | `node:22` images **already ship a UID-1000 user** named `node`. The HF-documented `RUN useradd -m -u 1000 user` **fails** on them. | Dockerfile must not copy the Python recipe blindly. [§8](#8-the-dockerfile) |

---

## 1. WebSockets

### 1.1 Verified end-to-end, not inferred

There is **no HF documentation page that says "WebSockets are supported."** So I tested it, and I want to record the false negative first because it is a trap.

A raw `curl` upgrade probe against `Almaatla/private-room` returns **403** — on the real route *and* on a nonsense path:

```console
$ curl -sS -o /dev/null -D - --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
    https://almaatla-private-room.hf.space/ws
HTTP/1.1 403 Forbidden
x-proxied-host: http://10.112.58.9
x-proxied-replica: uxm7fnh3-hqx78
x-proxied-path: /ws
```

That 403 is **not** the edge blocking WebSockets. Reading the app source (`hf://spaces/Almaatla/private-room/app.py`) explains it: the handler calls `websocket.close(code=1008, reason="chat_id required")` **before** `websocket.accept()` when the `chat_id` query parameter is missing, and Starlette renders a pre-accept close as an HTTP 403 handshake rejection. My probe simply omitted the parameter.

With a **real WebSocket client** (Node 22's built-in `WebSocket`) and the required parameter, the handshake succeeds:

```console
$ node ws-test.mjs 'wss://almaatla-private-room.hf.space/ws?chat_id=sc-probe&name=probe'
[353ms] OPEN protocol="" ext="permessage-deflate"
[359ms] MSG#1 len=99 {"type": "system", ... "message": "probe joined (users=1)"}
```

**Control:** the same script against `wss://echo.websocket.org/` and `wss://ws.postman-echo.com/raw` also opened and held, proving my sandbox egress is not the variable.

Two details worth keeping:

- **`permessage-deflate` is negotiated.** Per-message compression is on by default here. For a 20 Hz binary delta stream this is usually a *win* on bandwidth but costs CPU per frame on a 2-vCPU box. If frames are already compact binary, consider disabling it server-side and measuring.
- **The edge downgrades to HTTP/1.1 for the upgrade** while serving normal pages over HTTP/2 (see [§10.3](#103-http2)). That is exactly how a WebSocket-capable reverse proxy behaves.

### 1.2 Measured: 20 Hz is fine

Round-trip test through the live edge — 400 messages at 20 Hz (50 ms interval), echoed back by the server's broadcast:

```
sent=400  echoed=400  lost=0 (0.0%)
RTT ms: p50=32.6  p90=33.2  p99=36.6  max=48.8
```

Zero loss, and jitter under 20 ms across the whole run. **A 20 Hz authoritative push is not at risk from the transport.** The tight p50/p99 spread (32.6 → 36.6 ms) suggests the edge is not batching or throttling small frames.

> Caveat: this measures *one* client against a trivial broadcast app on a warm Space. It does not measure N concurrent players or the CPU cost of the SpaceCities simulation. See [§3.2](#32-what-2-vcpu-means-for-a-20-hz-authoritative-sim).

### 1.3 Idle timeout and keep-alive

**[PARTIALLY VERIFIED]** I ran a fully idle WebSocket (no application traffic in either direction) against the live Space. Result is recorded in [§11](#11-what-i-could-not-verify) — at the time of writing it had survived the observation window without being closed.

HF publishes **no documented WebSocket idle timeout**. Given that, treat the timeout as unknown-and-hostile and implement keep-alive regardless:

- **Send a ping every 20–30 s.** This is the standard interval for surviving reverse-proxy idle timeouts, which commonly default to 60 s. — <https://websocket.org/guides/troubleshooting/timeout/>
- Use **RFC 6455 protocol-level ping/pong**, not an application JSON heartbeat, where possible. Node's `ws` library does this with `ws.ping()`; the browser has no API to send a protocol ping, so the **server** must ping and the browser auto-replies with a pong.
- Add **client-side dead-connection detection**: if no frame arrives for ~2 ping intervals, tear down and reconnect rather than waiting for a TCP timeout.

For SpaceCities specifically, a 20 Hz push means the connection is **never idle during a match**, so the idle timeout only matters in lobby/menu/paused states. That is where a keep-alive is genuinely needed.

**Recommended:** server pings every 25 s; client reconnects with exponential backoff and resumes from a server-authoritative snapshot.

### 1.4 Message size and rate

**[UNVERIFIED]** HF documents no WebSocket frame-size or message-rate limit. I did not empirically find the ceiling. Practical guidance:

- Keep per-tick deltas well under **64 KB**; that is comfortably inside any plausible proxy buffer.
- If a full-state snapshot is large, chunk it rather than sending one multi-megabyte frame.
- The 20 Hz test above shows no rate limiting at 20 messages/second/connection.

---

## 2. Port and networking

**Listen on `0.0.0.0:7860`.** Confirmed in two places:

- *"You can also change the default exposed port `7860` by setting `app_port: 7860`."* — <https://huggingface.co/docs/hub/spaces-sdks-docker>
- `app_port` : *int* — *"Port on which your application is running. Used only if `sdk` is `docker`. Default port is `7860`."* — <https://huggingface.co/docs/hub/spaces-config-reference>

Bind to `0.0.0.0`, **not** `127.0.0.1` — the HF-documented Dockerfile uses `--host 0.0.0.0`. — <https://huggingface.co/docs/hub/spaces-sdks-docker-first-demo>

### 2.1 Only one port is exposed — confirmed

> *"Internally you could have as many open ports as you want. For instance, you can install Elasticsearch inside your Space and call it internally on its default port 9200. If you want to expose apps served on multiple ports to the outside world, a workaround is to use a reverse proxy like Nginx to dispatch requests from the broader internet (on a single port) to different internal ports."*
> — <https://huggingface.co/docs/hub/spaces-sdks-docker>

**This confirms the expectation: exactly one externally reachable port.** Static assets, the WebSocket endpoint, and `/mcp` must all be multiplexed behind port 7860 by our own Node server. That is exactly what `Almaatla/private-room` does (FastAPI serving `/`, `@app.websocket("/ws")`, and `app.mount("", _mcp_app)` for `/mcp` — all on 7860), and I confirmed `/mcp` responds on the same host and port:

```console
$ curl -sS -o /dev/null -D - https://almaatla-private-room.hf.space/mcp
HTTP/2 401
server: uvicorn
x-proxied-path: /mcp
```

(The 401 is that app's own API-key middleware, not an HF restriction — proof the request reached the app.)

### 2.2 Outbound networking

> *"If your Space needs to make any network requests, you can make requests through the standard HTTP and HTTPS ports (80 and 443) along with port 8080. Any requests going to other ports will be blocked."*
> — <https://huggingface.co/docs/hub/spaces-overview#networking>

Irrelevant for us today (SpaceCities makes no outbound calls), but it rules out ever adding an external database on a nonstandard port.

### 2.3 Deriving the WebSocket URL in the browser

Do **not** hardcode the host. The Space is served both at `https://<owner>-<space>.hf.space` and inside an iframe on the Space page. Derive it:

```js
const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
```

Always `wss://` in practice — the edge is HTTPS-only, and a `ws://` URL from an HTTPS page is blocked as mixed content.

At runtime the container also gets `SPACE_HOST` (e.g. `osanseviero-i-like-flan.hf.space`) if the server needs to know its own public hostname. — <https://huggingface.co/docs/hub/spaces-overview#built-in-environment-variables>

---

## 3. Hardware and lifecycle

### 3.1 Free tier

| Hardware | CPU | Memory | Disk | Hourly Price |
|---|---|---|---|---|
| **CPU Basic** | **2 vCPU** | **16 GB** | **50 GB** | **Free** |
| CPU Upgrade | 8 vCPU | 32 GB | 50 GB | $0.03 |

— <https://huggingface.co/docs/hub/spaces-gpus#hardware-specs>

Also stated as: *"Each Spaces environment is limited to 16GB RAM, 2 CPU cores and 50GB of (not persistent) disk space by default."* — <https://huggingface.co/docs/hub/spaces-overview#hardware-resources>

Note the disk is explicitly described as **"(not persistent)"**.

#### The paid-plan caveat

> *"Static Spaces are free for everyone. Gradio and Docker Spaces run on compute and require a paid plan to create: PRO for personal accounts, Team or Enterprise for organizations."*
> — <https://huggingface.co/docs/hub/spaces-overview#creating-a-new-space>

The restriction is worded against **creating**. `Almaatla/SpaceCities` already exists as a Docker Space, so overwriting its contents should be unaffected. Two consequences:

1. **Do not delete the Space** to "start clean." You may not be able to recreate it.
2. **Do not use `huggingface/hub-sync`**, whose documented mechanism is *"`hf repo create` + `hf upload`"* — the create step is the risky one. Use a plain git push instead ([§7](#7-deploying-from-github-actions)).

### 3.2 What 2 vCPU means for a 20 Hz authoritative sim

**[UNVERIFIED — needs a load test]** 2 vCPU / 16 GB is generous on RAM and thin on CPU. Node is single-threaded for the simulation, so effectively **one core runs the 20 Hz tick loop** and the second absorbs I/O, TLS, and `permessage-deflate`. A 50 ms budget per tick is a lot for an RTS at small player counts, but the serialize-and-fan-out cost grows with players × entities. Measure before promising a player cap.

### 3.3 Sleep and idle behaviour — the important part

> *"If your Space runs on the default `cpu-basic` hardware, it will go to sleep if inactive for more than a set time (currently, 48 hours). Anyone visiting your Space will restart it automatically."*
> *"If you want your Space never to deactivate or if you want to set a custom sleep time, you need to upgrade to paid hardware."*
> — <https://huggingface.co/docs/hub/spaces-gpus#sleep-time>

And: *"Spaces running on free hardware are suspended automatically if they are not used for an extended period of time (e.g. two days). Upgraded Spaces run indefinitely by default, even if there is no usage."* — <https://huggingface.co/docs/hub/spaces-gpus#billing>

So, on free hardware:

| Event | Trigger | In-memory state |
|---|---|---|
| **Sleep** | 48 h with no traffic | **Lost** |
| **Wake** | any visitor | fresh process, empty memory |
| **Rebuild** | every git push | **Lost** |
| **Crash / restart** | app failure | **Lost** |
| **Pause** | manual, owner only | **Lost**; owner must restart |

**48 h of idle is not the threat.** The threats are (a) *every deploy restarts the game*, and (b) a crash wipes every match. Neither is fixed by upgrading hardware.

**Cold start.** **[UNVERIFIED]** HF does not publish a cold-start number. What is documented is the *ceiling*: `startup_duration_timeout` *"is the maximum time your Space is allowed to start before it times out and is flagged as unhealthy. Defaults to 30 minutes."* — <https://huggingface.co/docs/hub/spaces-config-reference>. For a zero-dependency Node app with no model download, container start should be seconds, but the wake-from-sleep path also has to schedule and pull the image. Expect a visitor hitting a sleeping Space to wait — plan a loading state, not an instant connect.

### 3.4 Always-on options and cost

- **CPU Upgrade: $0.03/hour.** Running continuously that is **~$0.72/day, ~$21.90/month** (730 h). *"Upgraded Spaces run indefinitely by default."*
- **Plus the PRO plan** for the account, since compute Spaces are a paid-plan feature.
- Billing is *"computed by the minute: you get charged for every minute the Space runs on the requested hardware, regardless of whether the Space is used"*, and *"there is no cost during build."* — <https://huggingface.co/docs/hub/spaces-gpus#billing>
- To stop billing: switch back to CPU Basic, or **pause** the Space (*"Paused time is not billed"*).
- On upgraded hardware you can also set a **custom sleep time** so it idles (and stops billing) when unused, waking on the next visitor.

**Recommendation:** stay on **CPU Basic** and engineer for restart-survival. Paying ~$22/month buys "no 48 h sleep" but does **not** buy "matches survive a deploy or a crash" — that requires snapshotting either way. Build the snapshot; upgrade only if idle-sleep proves to be a real user complaint.

### 3.5 Replicas — do not use

> *"You can scale your Space horizontally by requesting multiple replicas... Replicas are only available for upgraded (paid) hardware."*
> — <https://huggingface.co/docs/hub/spaces-gpus#replicas>

**Actively harmful for us.** An authoritative simulation with in-memory match state cannot be load-balanced across replicas without shared state and sticky sessions. Keep `replicas: 1`.

---

## 4. Persistent storage

### 4.1 The model changed — this is the biggest surprise

The old "persistent storage" tiers are **retired**:

> **`suggested_storage`** — *"The persistent storage feature is no longer available so this setting will be ignored."*
> — <https://huggingface.co/docs/hub/spaces-config-reference>

And the storage page is now titled *"Disk usage on Spaces"*:

> *"Every Space comes with a small amount of disk storage. This disk space is **ephemeral**, meaning its content will be lost if your Space restarts or is stopped. If you need to persist data with a longer lifetime than the Space itself, you can attach one or more Storage Buckets as volumes."*
> — <https://huggingface.co/docs/hub/spaces-storage>

The Docker page agrees:

> *"The data written on disk is lost whenever your Docker Space restarts. To persist data across restarts, you can attach a Storage Bucket to your Space. At the moment, `/data` volume is only available at runtime, i.e. you cannot use `/data` during the build step of your Dockerfile."*
> — <https://huggingface.co/docs/hub/spaces-sdks-docker#data-persistence>

### 4.2 What this means for `/data`

The current Space Dockerfile does:

```dockerfile
RUN mkdir /data && chmod 777 /data
RUN rm -rf data && ln -s /data data
```

**[UNVERIFIED but strongly implied]** With no bucket attached, that `/data` is a plain directory on the **ephemeral 50 GB layer** — it looks persistent and is not. The `RUN mkdir /data` in the build even guarantees the path exists, masking the problem. **Do not inherit this pattern and assume durability.**

**The rest of the filesystem is confirmed ephemeral** — stated three times across the docs above, and the hardware table calls the 50 GB *"(not persistent)"*.

### 4.3 Storage Buckets — the current answer

> *"Storage Buckets are a repo type on the Hugging Face Hub providing S3-like object storage... **non-versioned** and **mutable**, designed for use cases where you need simple, fast storage."*
> *"Buckets are available to all users and organizations."*
> *"As for other repositories, buckets are free to create and have a free storage allowance."*
> — <https://huggingface.co/docs/hub/storage-buckets>

> *"Attached buckets are mounted into the Space container at the path you specify, making their contents available as local files at runtime. Buckets can be attached when creating a Space, from the Space settings UI, or programmatically... They can be mounted read-write (the default) or read-only."*
> — <https://huggingface.co/docs/hub/spaces-storage#attached-volumes>

So the path forward for durable match state:

1. Create a bucket (`hf buckets create SpaceCities-state`, or the UI at <https://huggingface.co/new-bucket>).
2. Attach it to the Space **at mount path `/data`**, read-write, from Space settings.
3. Then — and only then — is `/data` durable across restart/rebuild/sleep.
4. **`/data` is runtime-only.** Never `COPY` into it or read it in a `RUN` step.

**Survival matrix** (with a bucket attached at `/data`):

| Event | `/data` (bucket) | Rest of filesystem | In-memory |
|---|---|---|---|
| Restart / wake from sleep | **Survives** | Reset to image | Lost |
| Rebuild (git push) | **Survives** | Rebuilt from Dockerfile | Lost |
| Factory reset | **[UNVERIFIED]** — bucket is a separate repo, so it should survive; the Space's own disk does not | Reset | Lost |
| Bucket detached/deleted | Gone permanently (*"deletions are immediate and permanent — there is no way to recover a deleted file"*) | — | — |

**Caveat:** a bucket is object storage, not a POSIX filesystem. **[UNVERIFIED]** how well it tolerates frequent small random writes or `fsync`-heavy patterns. For 20 Hz match state, do **not** write every tick — snapshot periodically (e.g. every 10–30 s and on clean shutdown) and write whole files, not in-place mutations.

**Alternative:** commit snapshots to a Hub **Dataset** repo, the long-standing pattern HF documents for Space persistence. — <https://huggingface.co/docs/hub/spaces-sdks-docker#data-persistence>

---

## 5. Secrets and variables

### 5.1 Setting them

Space **Settings** page → add a **variable** or a **secret**.

> *"Use **Variables** if you need to store non-sensitive configuration values. They are publicly accessible and viewable and will be automatically added to Spaces duplicated from yours."*
> *"Use **Secrets** to store access tokens, API keys, or any sensitive values or credentials. They are private and their value cannot be read from the Space's settings page once set. They won't be added to Spaces duplicated from your repository."*
> — <https://huggingface.co/docs/hub/spaces-overview#managing-secrets>

### 5.2 Build time vs runtime — the trap

| | Build time | Runtime |
|---|---|---|
| **Variables** | Passed as Docker **`build-arg`s**; read with `ARG NAME` | Injected as environment variables |
| **Secrets** | **NOT** environment variables. Must be explicitly mounted per-`RUN` | Injected as environment variables |

— <https://huggingface.co/docs/hub/spaces-sdks-docker#secrets-and-variables-management>

**Explicitly: secrets are not ambiently available at build time.** To read one during build you must opt in per instruction:

```dockerfile
RUN --mount=type=secret,id=SECRET_EXAMPLE,mode=0444,required=true \
    some-command "$(cat /run/secrets/SECRET_EXAMPLE)"
```

**For SpaceCities this is a non-issue and should stay that way.** We have no build step and no build-time secret need. Read everything at runtime.

### 5.3 Reading them from Node

Plain `process.env` — nothing HF-specific:

```js
const port = Number(process.env.PORT ?? process.env.APP_PORT ?? 7860);
const dataDir = process.env.DATA_DIR ?? '/data';
const adminKey = process.env.ADMIN_KEY;          // a Space *secret*
const spaceHost = process.env.SPACE_HOST;        // injected by HF
if (!adminKey) console.warn('ADMIN_KEY unset — admin endpoints disabled');
```

Useful built-ins injected at runtime: `SPACE_ID`, `SPACE_HOST`, `SPACE_AUTHOR_NAME`, `SPACE_REPO_NAME`, `SPACE_TITLE`, `CPU_CORES`, `MEMORY`, `ACCELERATOR`. — <https://huggingface.co/docs/hub/spaces-overview#built-in-environment-variables>

> HF runs a **Secrets Scanner** and warns owners when hard-coded secrets are found in a Space. — <https://huggingface.co/docs/hub/spaces-overview#managing-secrets>

---

## 6. README front matter

All keys below verified against <https://huggingface.co/docs/hub/spaces-config-reference>.

**Ship this exact block** as the top of the Space's `README.md`:

```yaml
---
title: SpaceCities
emoji: 🚀
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
header: mini
fullWidth: true
short_description: Real-time multiplayer space RTS with an MCP endpoint for agent players.
license: mit
tags:
  - game
  - multiplayer
  - rts
  - websocket
  - mcp
---
```

Why each key:

| Key | Value | Rationale |
|---|---|---|
| `title` | `SpaceCities` | Display title. Also surfaces as `SPACE_TITLE` env var. |
| `emoji` | `🚀` | *"emoji-only character allowed."* |
| `colorFrom` / `colorTo` | `indigo` / `purple` | Thumbnail gradient. **Allowed values only:** `red, yellow, green, blue, indigo, purple, pink, gray`. |
| `sdk` | `docker` | *"Can be either `gradio`, `docker`, or `static`."* |
| `app_port` | `7860` | *"Used only if `sdk` is `docker`. Default port is `7860`."* Explicit is better. |
| `pinned` | `false` | Whether it stays on top of the profile. |
| `header` | `mini` | *"If `header` is set to `mini` the space will be displayed full-screen with a mini floating header."* **Right choice for a game.** |
| `fullWidth` | `true` | Full-width rather than a fixed-width container. Defaults to `true`; explicit for clarity. |
| `short_description` | … | *"displayed in the Space's thumbnail."* |
| `license` | `mit` | Match the repo's LICENSE. |
| `tags` | list | *"List of terms that describe your Space task or scope."* |

**Deliberately omitted:**

- `suggested_storage` — **retired**; *"no longer available so this setting will be ignored."*
- `suggested_hardware` — only affects users duplicating the Space; *"Setting this value will not automatically assign an hardware to this Space."* Harmless to add (`cpu-basic`) but does nothing for us.
- `python_version`, `sdk_version`, `app_file`, `app_build_command` — Gradio/static only.
- `models`, `datasets`, `preload_from_hub` — no Hub artifacts involved.
- `hf_oauth` — see [§9](#9-private-vs-public); add **only** if we adopt HF sign-in.
- `disable_embedding` — defaults to false (embedding allowed). Leave alone.
- `startup_duration_timeout` — 30 min default is far beyond our needs.
- `custom_headers` — only COEP/COOP/CORP are permitted, and only if we ever need `SharedArrayBuffer`. Not needed.
- `base_path` — we serve from `/`.

---

## 7. Deploying from GitHub Actions

### 7.1 Which mechanism

HF documents **two** approaches. — <https://huggingface.co/docs/hub/spaces-github-actions>

1. **`huggingface/hub-sync`** (the "official" action). *"The action mirrors your files to the Hub using the `hf` CLI (`hf repo create` + `hf upload`). It is not a git-to-git sync — it uploads the file contents and automatically excludes `.github/` and `.git/` directories. Files removed from your GitHub repository will also be removed from the Hub."*
2. **Manual git push** — a direct git-to-git sync.

**Use the manual git push.** Reasons:

- `hub-sync`'s first step is **`hf repo create`**, and Docker Space *creation* now requires a paid plan ([§3.1](#31-the-paid-plan-caveat)). That is the one operation we want to avoid.
- `hub-sync` defaults `space_sdk` to `gradio`; a mistake there could rewrite the Space's SDK.
- We want the Space's git history replaced deliberately, which is a git operation.

### 7.2 The unrelated-history problem — and why force push is correct

The Space repo today contains a **different application** (a "Voice Notes" FastAPI app — verified via `hf://spaces/Almaatla/SpaceCities`: `app.py`, `requirements.txt`, `static/`, `data/`, and a README titled `Voice Notes`). Its git history has **no common ancestor** with `alma92350/SpaceCities`.

Two ways to reconcile, and only one is right here:

| Approach | Effect | Verdict |
|---|---|---|
| `git pull --allow-unrelated-histories` then push | Merges the Voice Notes tree into ours. Leaves `app.py`, `requirements.txt`, and the old `static/` **in the Space**, where a stray `app.py` is harmless but the old `README.md` front matter and `.gitattributes` may conflict. Creates a messy merge commit and can fail on conflicting paths. | ❌ Wrong tool |
| **`git push --force`** | Replaces the Space's `main` with our tree wholesale. Old files vanish because the tree is replaced. History is discarded. | ✅ **Correct** |

We are **overwriting the Space entirely**, so force push is not a workaround — it is the accurate expression of intent. The trade-off is that the Space's prior history is destroyed; if that history matters, clone the Space repo once and archive it before the first deploy.

### 7.3 Token-leak avoidance

The HF-documented one-liner is:

```yaml
run: git push https://HF_USERNAME:$HF_TOKEN@huggingface.co/spaces/HF_USERNAME/SPACE_NAME main
```

This **works** but embeds the token in a URL. That URL can surface in git's own error output and in the remote list. GitHub Actions masks registered secrets in logs, but masking is best-effort and does not cover every path. The workflow below hardens it:

- The token is only ever in an `env:` block, never in a `with:` or an echoed string.
- The authenticated URL is built inside the step and **never** persisted via `git remote add`.
- `actions/checkout` is told `persist-credentials: false` so the GitHub token isn't left in `.git/config`.
- No `set -x`.

> HF also now offers **Trusted Publishers** — *"keyless publishing — no `HF_TOKEN` secret to store or rotate — ... exchanges GitHub Actions' built-in OIDC token for a short-lived, repo-scoped Hub token."* — <https://huggingface.co/docs/hub/repositories-github-actions>. **[UNVERIFIED]** whether this covers Spaces git-push (as opposed to `hf upload`). Worth investigating later; the `HF_TOKEN` route is what we have working today.

### 7.4 `fetch-depth` and LFS

- **`fetch-depth: 0` is required.** The default shallow clone (depth 1) cannot be pushed to another remote — git refuses to push a shallow history. This is the single most common failure in these workflows.
- **`lfs: true`** — *"For files larger than 10MB, Spaces requires Git-LFS. Make sure large files in your GitHub repository are tracked with LFS before syncing."* — <https://huggingface.co/docs/hub/spaces-github-actions>. SpaceCities is source-only today, so nothing should be over 10 MB; including `lfs: true` is cheap insurance and a no-op if there are no LFS objects.

### 7.5 The complete workflow

`.github/workflows/deploy-hf.yml`:

```yaml
name: Deploy to Hugging Face Space

on:
  push:
    branches: [main]
  workflow_dispatch:

# Never run two deploys at once — the Space rebuilds on every push.
concurrency:
  group: deploy-hf
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout full history
        uses: actions/checkout@v4
        with:
          # Required: a shallow clone cannot be pushed to another remote.
          fetch-depth: 0
          lfs: true
          # Don't leave the GitHub token sitting in .git/config.
          persist-credentials: false

      - name: Force-push to the Space
        env:
          HF_TOKEN: ${{ secrets.HF_TOKEN }}
          HF_OWNER: Almaatla
          HF_SPACE: SpaceCities
        run: |
          set -euo pipefail
          test -n "$HF_TOKEN" || { echo "HF_TOKEN is empty"; exit 1; }

          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

          # Build the authenticated URL locally; never store it in a remote.
          REMOTE="https://user:${HF_TOKEN}@huggingface.co/spaces/${HF_OWNER}/${HF_SPACE}"

          # The Space has unrelated history (a previous app). We overwrite it
          # wholesale, so force-push HEAD onto the Space's main branch.
          git push --force "$REMOTE" HEAD:refs/heads/main
```

Notes on the details:

- **`https://user:${HF_TOKEN}@…`** — the username is not validated when a token is used as the password; the docs' own example uses the HF username. A literal `user` avoids leaking the account name into the command. **[UNVERIFIED]** that HF accepts an arbitrary username; if it rejects it, substitute `Almaatla`. Test the first deploy manually.
- **`HEAD:refs/heads/main`** — pushes whatever branch the workflow ran on to the Space's `main`, so this keeps working if the GitHub default branch is ever renamed.
- **`--force`** — required; see [§7.2](#72-the-unrelated-history-problem--and-why-force-push-is-correct).
- **`concurrency`** — two overlapping pushes cause two rebuilds and a race; serialize them.
- **`.github/` is pushed too.** Unlike `hub-sync`, a git push carries the workflow directory to the Space. Harmless (HF ignores it) but publicly visible once the Space is public. Remove it in the workflow if that bothers you.
- The token needs **write** access to the Space. Prefer a **fine-grained token scoped to just this repo**. — <https://huggingface.co/docs/hub/repositories-github-actions>

---

## 8. The Dockerfile

### 8.1 The UID-1000 trap

HF's rule: *"The container runs with user ID 1000. To avoid permission issues you should create a user and set its `WORKDIR` before any `COPY` or download."* — <https://huggingface.co/docs/hub/spaces-sdks-docker#permissions>

Their example is `RUN useradd -m -u 1000 user`. **[VERIFY BEFORE FIRST BUILD]** Official `node` images **already create a `node` user and group at UID/GID 1000**, so `useradd -m -u 1000 user` is expected to fail with *"UID 1000 is not unique."* The Dockerfile below uses the **existing `node` user**, which satisfies HF's requirement (the constraint is the *UID*, not the username). If a build ever fails on this, the fallback is `usermod -l user node` or simply keeping `USER node`.

### 8.2 Complete Dockerfile

```dockerfile
# syntax=docker/dockerfile:1
# SpaceCities on Hugging Face Docker Spaces.
# Docs: https://huggingface.co/docs/hub/spaces-sdks-docker
#
# Zero npm dependencies, ES modules, no build step.
# Serves static assets + WebSocket + /mcp on a single port (7860).

FROM node:22-slim

# HF requires the container to run as UID 1000.
# node:* images ALREADY ship a `node` user at UID/GID 1000, so do NOT run
# `useradd -m -u 1000 user` here — it fails with "UID 1000 is not unique".
# Using the built-in `node` user satisfies the requirement.

ENV NODE_ENV=production \
    PORT=7860 \
    DATA_DIR=/data \
    HOME=/home/node

# /data is the runtime mount point for an attached Storage Bucket.
# It is NOT available during build (HF: "/data volume is only available at
# runtime"), so we only create the mount point and hand it to UID 1000.
RUN mkdir -p /data && chown node:node /data

WORKDIR /home/node/app

# Copy with --chown so no recursive chown layer is needed.
# No `npm install`: SpaceCities has zero runtime dependencies.
COPY --chown=node:node . /home/node/app

USER node

EXPOSE 7860

# Node 22 has a built-in WebSocket client and a stable fetch; the server side
# is implemented on top of node:http + the raw `upgrade` event.
CMD ["node", "server/index.js"]
```

### 8.3 Notes and obligations on the app side

- **`EXPOSE 7860` is documentation only** — HF routes by `app_port` in the README, not by `EXPOSE`. Keep both consistent at 7860.
- **Bind `0.0.0.0`**, and read the port from the environment with a 7860 default.
- **Handle `SIGTERM`.** A rebuild or sleep sends a termination signal. This is the one chance to flush match state to `/data`. Node does **not** exit gracefully by default on SIGTERM when there are open sockets — install a handler:
  ```js
  process.on('SIGTERM', async () => { await snapshotToDisk(); server.close(() => process.exit(0)); });
  ```
- **Do not write to `/data` during build.** It is empty at build time and the write would land in the image layer, then be shadowed by the mount at runtime.
- **Guard against no bucket attached.** If `/data` is unmounted it is still a writable directory — just an ephemeral one. Log loudly at startup if a marker file written on the previous boot is missing, so "storage silently isn't persistent" is visible rather than mysterious.
- **`.dockerignore`** — add one (`.git`, `docs/`, `.github/`, `node_modules`) to keep the image small and builds fast.
- **Multiplexing on one port**: a single `http.Server` handles static file responses, the `upgrade` event for `/ws`, and `POST /mcp`. This mirrors exactly what `private-room` does with FastAPI, which is verified working ([§2.1](#21-only-one-port-is-exposed--confirmed)).

---

## 9. Private vs public

### 9.1 A private Space cannot host anonymous multiplayer. Full stop.

HF now documents **three** visibility levels:

| | Public | Protected | Private |
|---|---|---|---|
| Source code on the Hub | Visible to everyone | Private (owner/collaborators) | Private (owner/collaborators) |
| **App accessible via embed URL** | **Yes** | **Yes** | **No** |
| App accessible via custom domain | Yes | Yes | No |
| Clonable by others | Yes | No | No |

> *"**Private** Spaces are fully private: the source code and the running app are only accessible to the owner and collaborators. The Space will not appear in search results and other users will receive a **`404`** error when visiting its URL."*
> — <https://huggingface.co/docs/hub/spaces-overview#space-visibility>

**Answer to "can anonymous players connect at all?": no.** Not the page, not the WebSocket, not `/mcp`. Everyone who is not the owner or an explicit collaborator gets a 404 before any application code runs. There is no anonymous auth path into a private Space.

### 9.2 The "protected" middle ground

> *"**Protected** Spaces keep their source code private on the Hub — only the owner and collaborators can view or clone the repository. However, the running app is publicly accessible through its embed URL (`https://<space-subdomain>.hf.space`)... This is especially useful for hosting websites or apps without publishing the source code."*
> — <https://huggingface.co/docs/hub/spaces-overview#space-visibility>

> *"Protected visibility is part of PRO or Team & Enterprise plans."*

This is exactly "playable by anyone, source not published" — but it **costs a PRO plan**.

### 9.3 Recommendation

**Make the Space public.**

1. It is the only free option where anonymous players can connect.
2. The GitHub repo `alma92350/SpaceCities` is the source of truth and is already its own thing — the Space is a deployment artifact, not a secret.
3. `protected` buys only source-hiding, for a paid plan, and the source is on GitHub anyway.

**Consequences to design for once public:**

- Anyone can connect, including bots. The server is authoritative, which is the right defence, but add basic **rate limiting** and a **connection cap**.
- `/mcp` becomes publicly reachable. Decide deliberately whether agent play is open or key-gated. `private-room` gates `/api` and `/mcp` behind an `x-api-key` checked against a Space **secret** — a good, cheap pattern to copy (verified: `curl https://almaatla-private-room.hf.space/mcp` → `HTTP/2 401`).
- Do not log player IPs or persist anything personal to `/data`.
- If you later want *identified* players, `hf_oauth: true` adds HF sign-in. — <https://huggingface.co/docs/hub/spaces-oauth>

---

## 10. Other things that bite

### 10.1 The app runs in an iframe

The Space page embeds the app in an iframe; the direct origin is `https://<owner>-<space>.hf.space` (lowercased, `/` → `-`). Implications: use `header: mini` + `fullWidth: true` for a game; pointer-lock, fullscreen, and audio autoplay all behave differently inside an iframe; and `disable_embedding` (default false) controls whether *other* sites may embed it.

### 10.2 CORS and `X-Forwarded-*`

Observed response headers from the live edge:

```
vary: origin, access-control-request-method, access-control-request-headers
access-control-expose-headers: *
access-control-allow-origin: https://almaatla-private-room.hf.space   (when Origin was sent)
x-proxied-host: http://10.112.58.9
x-proxied-replica: uxm7fnh3-hqx78
x-proxied-path: /
link: <https://huggingface.co/spaces/Almaatla/private-room>;rel="canonical"
```

- The `access-control-*` headers there come from **that app's own CORS middleware**, not from HF. **[UNVERIFIED]** whether the HF edge injects CORS on its own. Since our client is served from the same origin as the WebSocket, **we need no CORS at all** for gameplay. Only `/mcp` called from a different origin would need it.
- HF adds **`x-proxied-host` / `x-proxied-replica` / `x-proxied-path`**, not the conventional `X-Forwarded-For`. **[UNVERIFIED]** whether `X-Forwarded-For` / `X-Forwarded-Proto` reach the container. **Do not rely on client IP** for rate limiting until verified — use a session/connection identity instead.
- **WebSocket handshakes carry no CORS protection.** The browser sends `Origin` but does not enforce same-origin on WebSockets. **Validate the `Origin` header server-side** on upgrade, or any page on the internet can open a socket to the game.

### 10.3 HTTP/2

Normal responses are **HTTP/2** (`HTTP/2 200`, `server: uvicorn`); the WebSocket upgrade is served over **HTTP/1.1**. Both work; no action needed. Note HTTP/2 means many small asset requests are cheap — don't bother bundling for its own sake.

### 10.4 Build timeouts and image size

**[UNVERIFIED]** I found no documented Space **build timeout** or **image size limit**. What *is* documented is `startup_duration_timeout` (default 30 min) which governs *start*, not *build*. For a zero-dependency Node app the build is a `COPY` on top of `node:22-slim` (~80 MB base) — orders of magnitude away from any plausible limit. Not a risk for us, but do not assume headroom if the image ever grows.

### 10.5 Request size limits

**[UNVERIFIED]** No documented HTTP request body size limit at the edge. Not a concern: gameplay traffic is WebSocket frames, and `/mcp` payloads are small JSON.

### 10.6 Logs and observability

- **Build** and **Container** logs in the Space UI via the *Open Logs* button. — <https://huggingface.co/docs/hub/spaces-sdks-docker-first-demo#debugging>
- Programmatic **SSE** streams, authenticated:
  - `GET /api/spaces/{namespace}/{repo}/logs/{build|run}` (accepts `?tail=100`)
  - `GET /api/spaces/{namespace}/{repo}/events` — status events
  - `GET /api/spaces/{namespace}/{repo}/metrics`
  — <https://huggingface.co/docs/hub/spaces-gpus#streaming>
- There is **no persistent log storage**. Logs die with the container. If match outcomes matter, write them to `/data` (bucket) yourself.
- **Dev Mode** allows attaching VS Code or SSH to a running Space — very useful for debugging the first deploy. — <https://huggingface.co/dev-mode-explorers>

### 10.7 Deploy = restart

Worth restating because it shapes the whole design: **every git push rebuilds and restarts the Space**, killing every live match. *"Each time a new commit is pushed, the Space will automatically rebuild and restart."* — <https://huggingface.co/docs/hub/spaces-overview>. Batch deploys, and announce/drain before pushing if anyone is playing.

---

## 11. What I could not verify

Flagged so nobody mistakes these for established facts.

| # | Claim | Status | How to settle it |
|---|---|---|---|
| U1 | **WebSocket idle timeout at the HF edge** | Undocumented. I ran a fully idle connection against a live Space; it was still open at the end of my observation window, but I did not run it long enough to find the ceiling. | Hold an idle socket for 1 h+ and log the close code. Regardless, **ship a 25 s keep-alive** — cheap, and removes the question. |
| U2 | **WebSocket max frame size / message rate cap** | Undocumented; not probed. | Send escalating frame sizes (64 KB → 1 MB → 8 MB) and find where it breaks. |
| U3 | **Cold-start time from sleep** | Undocumented. | Let the Space sleep 48 h, then time a cold visit. |
| U4 | **Whether `/data` persists with no bucket attached** | Docs strongly imply **no** (disk is "ephemeral"), but I could not test the running Space. | Write a timestamp file to `/data` on boot, force a rebuild, read it back. **Do this before trusting any persistence.** |
| U5 | **Whether a bucket at `/data` survives factory reset** | Not documented explicitly. A bucket is a separate repo, so it should. | Ask HF, or test on a throwaway Space. |
| U6 | **Bucket write performance for frequent small writes** | Object storage, not POSIX. Unknown latency/semantics. | Benchmark a snapshot write before choosing the snapshot interval. |
| U7 | **`useradd -m -u 1000 user` fails on `node:22-slim`** | Strongly expected (node images ship UID 1000) but **not** empirically confirmed — no Docker available here. | `docker build` locally once. The supplied Dockerfile sidesteps it by using the existing `node` user. |
| U8 | **Git push with username `user`** | The docs' example uses the real HF username. I could not test a push. | First deploy manually; fall back to `Almaatla` if rejected. |
| U9 | **Trusted Publishers (keyless OIDC) for Space git-push** | Documented for Hub publishing; unclear whether it covers git push to a Space. | Read <https://huggingface.co/docs/hub/trusted-publishers>. |
| U10 | **`X-Forwarded-For` reaching the container** | HF sends `x-proxied-*`; standard forwarded headers unconfirmed. | Log all request headers from the deployed app once. |
| U11 | **Build timeout / image size limit** | No documented figures found. | Not a practical risk at our image size. |
| U12 | **Whether overwriting (not creating) a Docker Space is unaffected by the paid-plan rule** | The rule is worded against *creation*; the Space exists. Not tested. | The first deploy is the test. **Do not delete the Space.** |
| U13 | **2 vCPU headroom for N-player 20 Hz simulation** | Not load-tested. | Load-test with synthetic clients before promising a player cap. |

---

## 12. Action checklist

1. **Make the Space public** (Settings → visibility). Nothing else works until this is done.
2. **Do not delete the Space** — recreating a Docker Space needs PRO.
3. Create a **Storage Bucket** and attach it at **`/data`**, read-write, if match state must survive restarts.
4. **Verify persistence** (U4) with a boot-timestamp file before relying on it.
5. Ship the README front matter from [§6](#6-readme-front-matter) and the Dockerfile from [§8](#8-the-dockerfile).
6. Add `.github/workflows/deploy-hf.yml` from [§7.5](#75-the-complete-workflow); confirm the `HF_TOKEN` secret has **write** access to the Space.
7. Run the first deploy **manually** to shake out U7 and U8.
8. Implement: `SIGTERM` snapshot, 25 s server ping, `Origin` validation on upgrade, connection cap, and a loading state for cold starts.
9. Decide whether `/mcp` is open or key-gated; if gated, add a Space **secret** and check it in middleware.

## Sources

- [Docker Spaces](https://huggingface.co/docs/hub/spaces-sdks-docker)
- [Spaces Overview](https://huggingface.co/docs/hub/spaces-overview)
- [Spaces Configuration Reference](https://huggingface.co/docs/hub/spaces-config-reference)
- [Using GPU Spaces (hardware, sleep, billing, replicas, log streaming)](https://huggingface.co/docs/hub/spaces-gpus)
- [Disk usage on Spaces](https://huggingface.co/docs/hub/spaces-storage)
- [Storage Buckets](https://huggingface.co/docs/hub/storage-buckets)
- [Managing Spaces with GitHub Actions](https://huggingface.co/docs/hub/spaces-github-actions)
- [GitHub Actions (hub-sync parameters, Trusted Publishers)](https://huggingface.co/docs/hub/repositories-github-actions)
- [Your First Docker Space](https://huggingface.co/docs/hub/spaces-sdks-docker-first-demo)
- [Spaces OAuth](https://huggingface.co/docs/hub/spaces-oauth)
- [WebSocket timeout troubleshooting](https://websocket.org/guides/troubleshooting/timeout/)
