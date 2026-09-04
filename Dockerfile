FROM golang:1.26.8-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -buildvcs=false -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/shell ./cmd/shell

FROM alpine:3.22
RUN apk add --no-cache bash ca-certificates tini \
    && adduser -D -h /home/shellonline shellonline \
    && install -d -o shellonline -g shellonline /var/lib/shell-online /workspace
COPY --from=build /out/shell /usr/local/bin/shell
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/shell-online-entrypoint
USER shellonline
WORKDIR /workspace
VOLUME ["/var/lib/shell-online", "/workspace"]
ENV SHELL=/bin/bash
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/shell-online-entrypoint"]
CMD ["/bin/bash", "-il"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD shell list --json | grep -q '"id"' || exit 1
