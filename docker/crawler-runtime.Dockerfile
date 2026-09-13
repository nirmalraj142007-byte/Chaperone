# Boot harness runtime image for packages/crawler/src/boot.ts.
#
# Node 22 + Python 3.12 + uv/uvx, and nothing else — no git, no build
# toolchain, no shell utilities beyond what the base images already carry.
# Base is python:3.12-slim-bookworm rather than a node:22 image because
# Debian bookworm's own apt repo ships Python 3.11, not 3.12 — Python 3.12
# has to come from the base image choice, Node 22 layers on top via
# NodeSource's official apt repo (which publishes for any Debian codename,
# bookworm included). Verified locally on 2026-09-13: this combination
# produces node v22.23.2 / Python 3.12.14 / uv+uvx 0.12.13.
FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh && \
    apt-get purge -y curl gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
