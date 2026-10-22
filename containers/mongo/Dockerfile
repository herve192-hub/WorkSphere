# Go 1.26.10 fixes CVE-2026-111943 in the stdlib embedded in all nine helpers.
FROM golang:1.26.10-bookworm@sha256:632dff7351799a5a9954a48dc06670ade72ee44e8c351cdc0e5a57af2fea21af AS tools
ENV GOTOOLCHAIN=local
# Retain the upstream database tools' Kerberos support.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libkrb5-dev=1.20.1-2+deb12u5 \
    && rm -rf /var/lib/apt/lists/*

# Upstream release tags resolve to commits 6456aaa0f3c854d199d0f037f068eb97515b7513
# (gosu 1.19) and 9348e032419d906e40966f477278cce647b9b1eb (tools 100.19.1).
ADD --checksum=sha256:cd9719b775dbfedae53923c9b0dc792b66d42c51e0b36652ed6f747fbadc0164 https://codeload.github.com/tianon/gosu/tar.gz/refs/tags/1.19 /archives/gosu.tar.gz
ADD --checksum=sha256:5f8bbd54e76804985d73b66313d7485724396a6ae47135e9bcb57a8a49f4279c https://codeload.github.com/mongodb/mongo-tools/tar.gz/refs/tags/100.19.1 /archives/tools.tar.gz
RUN mkdir -p /src/gosu /src/tools /out \
    && tar -xzf /archives/gosu.tar.gz --strip-components=1 -C /src/gosu \
    && tar -xzf /archives/tools.tar.gz --strip-components=1 -C /src/tools
WORKDIR /src/gosu
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags='-s -w' -o /out/gosu .

WORKDIR /src/tools
# Update only the affected vendored module. Go verifies these upstream sumdb
# checksums; all other sources remain covered by the release archive checksum.
RUN go mod edit -require=golang.org/x/net@v0.60.0 \
    && printf '%s\n' \
      'golang.org/x/net v0.60.0 h1:79p50tfZlm0J9YfoDsSi639qSXNGVwEzOPLCxM2FsYU=' \
      'golang.org/x/net v0.60.0/go.mod h1:2DA/G1UfVbCpQPeWTmMPGY7Cs2PkBkwu743bVX5PIVg=' >> go.sum \
    && go mod download golang.org/x/net@v0.60.0 \
    && rm -rf vendor/golang.org/x/net \
    && cp -a /go/pkg/mod/golang.org/x/net@v0.60.0 vendor/golang.org/x/net \
    && sed -i 's|golang.org/x/net v0.59.0|golang.org/x/net v0.60.0|' vendor/modules.txt
RUN set -eu; \
    for tool in bsondump mongodump mongoexport mongofiles mongoimport mongorestore mongostat mongotop; do \
      go build -mod=vendor -trimpath -buildmode=pie -tags=gssapi,failpoints \
        -ldflags='-s -w -X main.VersionStr=100.19.1 -X main.GitCommit=9348e032419d906e40966f477278cce647b9b1eb' \
        -o "/out/$tool" "./$tool/main"; \
    done

FROM mongo:7.0.45-jammy@sha256:6200825c6ed5de8cd5df71403c3e73af6621c1479a0b35ac0c206047d8e418c4
RUN apt-get update \
    && apt-get install -y --no-install-recommends libssl3=3.0.2-0ubuntu1.30 \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o mongodb -g mongodb /home/mongodb
ENV HOME=/home/mongodb \
    JSYAML_VERSION=3.15.2 \
    JSYAML_CHECKSUM=7f005cf0b8ee639b4557e0e321dc067c1f2aa0a442d096e03f2ab53353738794
ADD --checksum=sha256:7f005cf0b8ee639b4557e0e321dc067c1f2aa0a442d096e03f2ab53353738794 https://registry.npmjs.org/js-yaml/-/js-yaml-3.15.2.tgz /tmp/js-yaml.tgz
RUN tar -xzf /tmp/js-yaml.tgz --strip-components=1 -C /opt/js-yaml package/dist/js-yaml.js package/package.json \
    && rm /tmp/js-yaml.tgz
COPY --from=tools /out/gosu /usr/local/bin/gosu
COPY --from=tools /out/bsondump /out/mongodump /out/mongoexport /out/mongofiles /out/mongoimport /out/mongorestore /out/mongostat /out/mongotop /usr/bin/
# Match the upstream data-volume UID/GID while running mongod without root.
USER mongodb
