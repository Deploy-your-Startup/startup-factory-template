FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

# The standalone archive includes the server's web assets and native dependencies.
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) platform=x64; checksum=64e0f8446d3f618b157d4e5a0a6808ab3c8bf1a1b3e44eab3100e554be05e5d7 ;; \
      arm64) platform=arm64; checksum=c553c17db07030d032808989427db5022bf04027ebcec2218c69fb1a5fa1377f ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl --fail --silent --show-error --location --retry 3 \
      "https://github.com/pingdotgg/t3code/releases/download/v0.1.13/t3-0.1.13-linux-${platform}.tar.gz" \
      --output /tmp/t3.tar.gz; \
    echo "${checksum}  /tmp/t3.tar.gz" | sha256sum --check --status; \
    mkdir /opt/t3; \
    tar --extract --gzip --file /tmp/t3.tar.gz --directory /opt/t3 --strip-components=1; \
    rm /tmp/t3.tar.gz; \
    ln -s /opt/t3/t3 /usr/local/bin/t3; \
    t3 --version

RUN npm install --global --no-audit --no-fund @openai/codex@0.167.2 \
    && codex --version \
    && npm cache clean --force

COPY --chmod=755 entrypoint.sh /usr/local/bin/factory-t3
ENV HOME=/home/node \
    T3CODE_HOME=/home/node/.t3
USER 1000:1000
WORKDIR /home/node
EXPOSE 3773
ENTRYPOINT ["/usr/local/bin/factory-t3"]
