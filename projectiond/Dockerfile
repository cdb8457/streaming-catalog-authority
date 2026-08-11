# projectiond — the projection appliance's data plane.
#
# TWO STAGES. The builder has the toolchain; the runtime has a static binary, a CA bundle and nothing else.
# There is no shell, no package manager and no interpreter in the image that serves the mount.
#
# BOTH STAGES ARE PINNED BY DIGEST. A tag is mutable, so "reproducible" and "golang:1.26.5-bookworm" cannot
# both be true; the tag stays for readability and the digest is what selects the image.
FROM golang:1.26.5-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651 AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# CGO off: a static binary that runs on any Linux, including a distroless runtime. The race detector needs
# cgo and is a separate gate; a release build does not.
ENV CGO_ENABLED=0
ARG VERSION=0.1.0-phase1
RUN go build -trimpath -ldflags "-s -w -X main.Version=${VERSION}" -o /out/projectiond ./cmd/projectiond

FROM gcr.io/distroless/static-debian12:nonroot@sha256:f5b485ea962d9bd1186b2f6b3a061191539b905b82ec395de78cbfae51f20e35

COPY --from=build /out/projectiond /usr/local/bin/projectiond

# NON-ROOT BY DEFAULT. Mounting FUSE needs /dev/fuse and CAP_SYS_ADMIN, which the deployment grants
# explicitly; the image does not assume them. `--check-config`, `--version` and the status surface all run
# perfectly well as an unprivileged user with a read-only root filesystem, which is what the image smoke
# asserts.
USER nonroot:nonroot

# THE HEALTHCHECK IS WIRED TO READINESS, AND IT IS THIS BINARY BECAUSE THE IMAGE HAS NOTHING ELSE.
#
# There is no shell, no curl and no wget in this stage, so a healthcheck has to be the daemon's own binary in
# a mode that starts nothing: `--healthcheck` reads the configured status address, makes one loopback request
# to /readyz, prints a closed-set reason code and exits. It constructs no daemon and cannot mount.
#
# THE NUMBERS ARE PREDECLARED IN `PROJECTIOND_MOUNT_HEALTH` and cross-checked by
# `test/projection-operational-mount-health.ts`. Two of the relations matter more than the values:
#   start-period (20s) EXCEEDS the bootstrap grace (15s), so the first probe Docker actually counts is one the
#     grace can no longer answer — otherwise a container could report healthy having never observed its mount;
#   retries x interval (30s) EXCEEDS the daemon's own fault hold (6s), so the DAEMON decides what is broken
#     and Docker only repeats it. An anti-flap policy in two places is an anti-flap policy in neither.
#
# THIS CHANGES WHAT THE CONTAINER REPORTS AND NOT WHAT ANYTHING DOES TO IT. Docker's `restart:` policies do
# not react to health status, so nothing here restarts, replaces or stops a container. Wiring health to an
# action is deliberately NOT in this tranche.
#
# THE CONFIG PATH IS THE SHIPPED CONVENTION, the same one `docker-compose.projectiond.operator.yml` and every
# gate mount it at. A deployment that puts its configuration elsewhere overrides the healthcheck with it.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/usr/local/bin/projectiond", "--config=/etc/projectiond/config.json", "--healthcheck"]

ENTRYPOINT ["/usr/local/bin/projectiond"]
