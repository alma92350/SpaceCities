# syntax=docker/dockerfile:1
# SpaceCities on Hugging Face Docker Spaces.
# Docs: https://huggingface.co/docs/hub/spaces-sdks-docker
#
# Zero npm dependencies, ES modules, no build step — this Dockerfile has no
# `npm install` because there is nothing to install (see package.json).
#
# PHASE 0: the CMD below serves the existing single-player game through
# tools/serve.js, the zero-dependency static server already in this repo.
# Multiplayer (TASKS.md Phase 1+) replaces the CMD with the real match
# server once it exists; nothing else in this file needs to change for that —
# the port, the user, and the /data mount point are already right.

FROM node:22-slim

# HF requires the container to run as UID 1000. node:* images already ship a
# `node` user at UID/GID 1000 (verified against the upstream Dockerfile:
# https://github.com/nodejs/docker-node/blob/main/22/bookworm-slim/Dockerfile),
# so do NOT `RUN useradd -m -u 1000 user` here the way HF's own Python example
# does (https://huggingface.co/docs/hub/spaces-sdks-docker#permissions) — that
# fails with "UID 1000 is not unique". The built-in `node` user already
# satisfies the requirement; the constraint HF states is the UID, not the name.

ENV NODE_ENV=production \
    PORT=7860 \
    DATA_DIR=/data

# /data is the runtime mount point for an attached HF Storage Bucket. It is
# NOT available during build ("the /data volume is only available at
# runtime"), so this only creates the mount point and hands it to the runtime
# user. Never write here during build — it would land in the image layer and
# then be shadowed by the real mount at container start.
RUN mkdir -p /data && chown node:node /data

WORKDIR /home/node/app

# --chown avoids a separate recursive chown layer on the whole tree.
COPY --chown=node:node . .

USER node

# The Space's README.md `app_port` must match this — see the front matter
# there. EXPOSE itself is documentation only; HF routes by app_port.
EXPOSE 7860

# Phase 0: serve the existing single-player game as static ES modules.
# tools/serve.js already reads PORT from the environment and binds all
# interfaces, so no server change was needed to satisfy the HF contract.
CMD ["node", "tools/serve.js"]
