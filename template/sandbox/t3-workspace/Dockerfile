# Bake supplies this stage from the same locked kit as local Factory workspaces.
FROM scratch AS factory-tools

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client \
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

COPY --from=factory-tools /opt/factory/ /opt/factory/
COPY --from=factory-tools /usr/local/bin/ /usr/local/bin/
COPY --from=ghcr.io/jdx/mise:2026.11.7@sha256:36a8408d3398aff30a761b4ae57f71f50942d64f4e7ecd5353ffaee7ec4fa63a /usr/local/bin/mise /usr/local/bin/mise
COPY --from=mikefarah/yq:4.54.1@sha256:4b3d9475d65571d28cbb19544d3820ec2945e4c8b2f18279394282b8dc3a592e /usr/bin/yq /usr/local/bin/yq

RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) checksum=62ccf747115ddc61237efffdde66a3c8f70ba249433dc64f70801089b59c59c8 ;; \
      arm64) checksum=4c3e99a50bd8b181a3fe9d69b25dd978bac768148d88f01507c6b4d1ef61a443 ;; \
    esac; \
    archive="gh_2.103.2_linux_${TARGETARCH}"; \
    curl -fsSL --retry 3 "https://github.com/cli/cli/releases/download/v2.103.2/$archive.tar.gz" -o /tmp/gh.tar.gz; \
    echo "${checksum}  /tmp/gh.tar.gz" | sha256sum --check --status; \
    tar -xzf /tmp/gh.tar.gz -C /usr/local/bin --strip-components=2 "$archive/bin/gh"; \
    rm /tmp/gh.tar.gz

COPY --chmod=755 entrypoint.sh /usr/local/bin/factory-t3
ENV PATH="/opt/factory/venv/bin:${PATH}" \
    HOME=/home/node \
    T3CODE_HOME=/home/node/.t3
USER 1000:1000
WORKDIR /home/node
RUN startup --version && kubectl version --client && gh --version \
    && mise --version && uv --version && yq --version
EXPOSE 3773
ENTRYPOINT ["/usr/local/bin/factory-t3"]
