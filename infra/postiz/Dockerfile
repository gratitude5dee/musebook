# infra/postiz/Dockerfile — the sidecar image pin, nothing else.
# §12.2.8's containment is binary: this file exists ONLY to pin the upstream
# image by digest so a deploy cannot silently float to a new build. There is
# no COPY/ADD/RUN/ENV here and there must never be — one instruction that
# layers Musebook code into this image makes the whole bundle a combined AGPL
# work. scripts/gates/checks.mjs (agplContainment) enforces exactly that.
FROM ghcr.io/gitroomhq/postiz-app@sha256:01b24a4fc1055f6833122c99614805bea702fdc0ee30c9b5d09330b521fa1efa
