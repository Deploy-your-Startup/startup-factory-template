FROM ghcr.io/astral-sh/uv:0.13.10 AS uv
FROM debian:bookworm-slim AS build
ARG TARGETARCH
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/opt/factory/python \
    UV_PROJECT_ENVIRONMENT=/opt/factory/venv
WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --managed-python --no-dev --no-install-project --no-cache \
    && /opt/factory/venv/bin/startup --version

RUN set -eu; \
    version=v1.36.5; \
    url="https://dl.k8s.io/release/$version/bin/linux/$TARGETARCH/kubectl"; \
    curl -fsSL "$url" -o kubectl; \
    curl -fsSL "$url.sha256" -o kubectl.sha256; \
    printf '%s  kubectl\n' "$(cat kubectl.sha256)" | sha256sum -c -; \
    install -Dm755 kubectl /out/usr/local/bin/kubectl; \
    ln -s /opt/factory/venv/bin/startup /out/usr/local/bin/startup; \
    /out/usr/local/bin/kubectl version --client

FROM scratch
COPY --from=build /opt/factory/ /opt/factory/
COPY --from=build /out/ /
COPY --from=uv /uv /usr/local/bin/uv
