FROM --platform=$BUILDPLATFORM golang:1.26.10-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY . .

ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT
RUN set -eux; \
    mkdir -p /out /runtime/ribbonfish/cache /runtime/ribbonfish/frames; \
    chmod 0700 /runtime/ribbonfish /runtime/ribbonfish/cache /runtime/ribbonfish/frames; \
    if [ "$TARGETARCH" = arm ] && [ "$TARGETVARIANT" = v7 ]; then export GOARM=7; fi; \
    CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
      go build -trimpath -ldflags="-s -w" -o /out/ribbonfish ./cmd/ribbonfish

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/ribbonfish /ribbonfish
COPY --from=build --chown=65532:65532 /runtime/ribbonfish /var/lib/ribbonfish
COPY --from=build --chown=65532:65532 /src/defaults /usr/share/ribbonfish/defaults
WORKDIR /app
USER 65532:65532
ENV RIBBONFISH_DEFAULTS_DIR=/usr/share/ribbonfish/defaults
ENTRYPOINT ["/ribbonfish"]
