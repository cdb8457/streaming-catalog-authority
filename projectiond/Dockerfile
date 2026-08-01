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
ENTRYPOINT ["/usr/local/bin/projectiond"]
