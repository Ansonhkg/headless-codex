FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

COPY chatgpt.deb /tmp/chatgpt.deb

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      dbus-x11 \
      git \
      novnc \
      websockify \
      x11vnc \
      xvfb \
    && (dpkg -i /tmp/chatgpt.deb || apt-get install -f -y --no-install-recommends) \
    && rm -f /tmp/chatgpt.deb \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /bin/bash codex \
    && install -d -o codex -g codex -m 0700 /data \
    && install -d -o codex -g codex -m 0755 /workspace

COPY headless-codex /usr/local/bin/headless-codex
COPY launch-chatgpt /usr/local/bin/launch-chatgpt
COPY entrypoint /usr/local/bin/headless-codex-entrypoint
COPY fonts /usr/local/share/headless-codex/fonts
COPY assets /usr/local/share/headless-codex/assets

RUN chmod 0755 /usr/local/bin/headless-codex /usr/local/bin/launch-chatgpt /usr/local/bin/headless-codex-entrypoint

USER codex
WORKDIR /workspace

ENV HOME=/home/codex \
    CODEX_HOME=/data/codex-home \
    HEADLESS_CODEX_HOST=0.0.0.0 \
    HEADLESS_CODEX_PORT=4580 \
    HEADLESS_CODEX_DATA_DIR=/data \
    HEADLESS_CODEX_WORKSPACE_ROOT=/workspace \
    HEADLESS_CODEX_CODEX_BINARY=/usr/lib/chatgpt/resources/codex \
    HEADLESS_CODEX_MODEL=gpt-5.6-luna \
    HEADLESS_CODEX_REASONING=xhigh \
    HEADLESS_CODEX_FONT_DIR=/usr/local/share/headless-codex/fonts \
    HEADLESS_CODEX_ASSET_DIR=/usr/local/share/headless-codex/assets \
    HEADLESS_CODEX_DESKTOP=1 \
    HEADLESS_CODEX_DESKTOP_BINARY=/usr/local/bin/launch-chatgpt \
    HEADLESS_CODEX_INTERACTIVE_VIEWER=1 \
    HEADLESS_CODEX_VIEWER_HOST=0.0.0.0

EXPOSE 4580 6080
VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/headless-codex-entrypoint"]
CMD ["serve"]
