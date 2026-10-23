FROM --platform=$BUILDPLATFORM golang:1.25.8-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY . .

ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT
RUN set -eux; \
    mkdir -p /out /runtime/cache /runtime/frames; \
    chmod 0700 /runtime/cache /runtime/frames; \
    if [ "$TARGETARCH" = arm ] && [ "$TARGETVARIANT" = v7 ]; then export GOARM=7; fi; \
    CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
      go build -trimpath -ldflags="-s -w" -o /out/ribbonfish ./cmd/ribbonfish

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/ribbonfish /ribbonfish
COPY --from=build --chown=65532:65532 --chmod=0700 /runtime/cache /var/lib/ribbonfish/cache
COPY --from=build --chown=65532:65532 --chmod=0700 /runtime/frames /var/lib/ribbonfish/frames
WORKDIR /app
USER 65532:65532
ENTRYPOINT ["/ribbonfish"]
