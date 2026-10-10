FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS capture-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libx11-dev \
    libxdamage-dev \
    libxext-dev \
    libxfixes-dev \
    libxtst-dev \
    libpng-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY xcapture.c .
RUN cc -O3 -fPIC -shared -Wall -Wextra -Werror -o libcortexai_agent_hub-xcapture.so xcapture.c \
    -lX11 -lXext -lXdamage -lXfixes -lXtst -lpng

# Papirus ships every size up to 512px; the dock and file chooser only use these.
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS icon-builder
RUN apt-get update && apt-get install -y --no-install-recommends papirus-icon-theme \
  && cd /usr/share/icons \
  && for theme in Papirus Papirus-Dark; do \
       find "$theme" -mindepth 1 -maxdepth 1 -type d \
         ! -name 16x16 ! -name 22x22 ! -name 24x24 ! -name 32x32 ! -name 48x48 ! -name 64x64 ! -name symbolic \
         -exec rm -rf {} +; \
     done \
  && du -sm Papirus Papirus-Dark

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
# Dev tools let bots clone repos and fetch artifacts; containers run uid 1000
# with no privilege escalation, so nothing can be installed at runtime.
# Compilers stay in the builder stage; heavier toolchains are a separate call.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    xfwm4 \
    xfconf \
    picom \
    tint2 \
    hsetroot \
    arc-theme \
    fonts-inter \
    fonts-jetbrains-mono \
    xterm \
    xdotool \
    wmctrl \
    x11-utils \
    x11-xserver-utils \
    imagemagick \
    novnc \
    websockify \
    python3 \
    libnss-wrapper \
    ca-certificates \
    procps \
    bash \
    chromium \
    fonts-liberation \
    fonts-dejavu-core \
    fonts-noto-cjk \
    locales \
    dbus-x11 \
    xdg-desktop-portal \
    xdg-desktop-portal-gtk \
    xdg-utils \
    curl \
    git \
    jq \
    openssh-client \
    unzip \
    xclip \
    xsel \
    poppler-utils \
    pandoc \
    python3-openpyxl \
  && rm -rf /var/lib/apt/lists/* \
  && pdftotext -v \
  && pdfinfo -v \
  && pandoc --version \
  && python3 -c 'import openpyxl; print(openpyxl.__version__)' \
  && groupadd --gid 1000 cortexai-agent-hub \
  && useradd --uid 1000 --gid cortexai-agent-hub --create-home --shell /bin/bash cortexai-agent-hub \
  && install -d -m 755 /usr/local/share/cortexai-agent-hub/desktop/gtk-3.0 \
  && ln -sfn /bin/true /usr/bin/xmessage
RUN ln -s "$(dpkg -L libnss-wrapper | grep '/libnss_wrapper.so$')" /usr/local/lib/libnss_wrapper.so
ARG TARGETARCH
ARG UV_VERSION=0.12.19
RUN set -eux; \
  case "$TARGETARCH" in \
    amd64) uv_arch=x86_64; uv_sha256=23bf5552d220e0842b65c862097b2ebaeba0064b74eda5e565e77fd25969d8c8 ;; \
    arm64) uv_arch=aarch64; uv_sha256=0804e9b164c64b6914182d5920c08551958a095986f10a3731056df701126436 ;; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  archive="$(mktemp)"; \
  curl -fsSL "https://releases.astral.sh/github/uv/releases/download/${UV_VERSION}/uv-${uv_arch}-unknown-linux-gnu.tar.gz" -o "$archive"; \
  echo "$uv_sha256  $archive" | sha256sum -c -; \
  tar -xzf "$archive" -C /usr/local/bin --strip-components=1 "uv-${uv_arch}-unknown-linux-gnu/uv" "uv-${uv_arch}-unknown-linux-gnu/uvx"; \
  rm -f "$archive"; \
  uv --version; \
  uvx --version
# Bots build Office files with these instead of hand-writing OOXML. Hash-pinned wheels only:
# the image has no compiler, and a mismatched download fails the build.
COPY --chmod=644 office-requirements.txt /tmp/office-requirements.txt
RUN uv pip install --system --break-system-packages --require-hashes --only-binary :all: --no-cache \
    -r /tmp/office-requirements.txt \
  && rm /tmp/office-requirements.txt \
  && python3 -c "import docx, openpyxl, pptx"
# Bookworm has no gh package; pin the upstream binary and verify sha256, same as uv.
ARG GH_VERSION=2.100.0
RUN set -eux; \
  case "$TARGETARCH" in \
    amd64) gh_arch=amd64; gh_sha256=e4d4bb4498e8d007abe545b6568926793ace1b6447da598294a610018cb164be ;; \
    arm64) gh_arch=arm64; gh_sha256=ea4e7a581a32ccad6cc7923cb1576ac5859ba4b9a16ab22eb8f8a96e78e2e961 ;; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  archive="$(mktemp)"; \
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${gh_arch}.tar.gz" -o "$archive"; \
  echo "$gh_sha256  $archive" | sha256sum -c -; \
  tar -xzf "$archive" -C /usr/local/bin --strip-components=2 "gh_${GH_VERSION}_linux_${gh_arch}/bin/gh"; \
  rm -f "$archive"; \
  gh --version
ENV DISPLAY=:1
ENV HOME=/home/cortexai-agent-hub
# Keep UTF-8 explicit (an empty LANG broke non-ASCII file handling in the
# file chooser for CJK-market users) and generate zh_CN.UTF-8 so deployments
# that override the computer environment can opt in to a Chinese locale.
RUN sed -i 's/^# zh_CN.UTF-8 UTF-8/zh_CN.UTF-8 UTF-8/' /etc/locale.gen && locale-gen
ENV LANG=C.UTF-8
ENV UV_TOOL_DIR=/home/cortexai-agent-hub/.local/share/uv/tools \
    UV_TOOL_BIN_DIR=/home/cortexai-agent-hub/.local/bin \
    UV_PYTHON_INSTALL_DIR=/home/cortexai-agent-hub/.local/share/uv/python \
    UV_CACHE_DIR=/home/cortexai-agent-hub/.cache/uv
WORKDIR /home/cortexai-agent-hub

# --chmod normalizes modes: a restrictive host umask (e.g. 077 on hardened hosts) would
# otherwise leave these files unreadable to USER 1000 at runtime.
COPY --chmod=755 start.sh /usr/local/bin/cortexai-agent-hub-computer
COPY --chmod=644 user-env.sh /usr/local/lib/cortexai-agent-hub-user-env.sh
COPY --chmod=755 control.py /usr/local/bin/cortexai-agent-hub-computer-control
COPY --from=capture-builder /build/libcortexai_agent_hub-xcapture.so /usr/local/lib/libcortexai_agent_hub-xcapture.so
COPY --chmod=755 cortexai-agent-hub-browser /usr/local/bin/cortexai-agent-hub-browser
COPY --chmod=755 cortexai-agent-hub-focus-or-launch /usr/local/bin/cortexai-agent-hub-focus-or-launch
COPY --chmod=755 cortexai-agent-hub-page-browser /usr/local/bin/cortexai-agent-hub-page-browser
COPY --chmod=644 cortexai-agent-hub-browser.desktop /usr/share/applications/cortexai-agent-hub-browser.desktop
COPY --from=icon-builder /usr/share/icons/Papirus /usr/share/icons/Papirus
COPY --from=icon-builder /usr/share/icons/Papirus-Dark /usr/share/icons/Papirus-Dark
COPY --chmod=755 desktop/session.sh /usr/local/bin/cortexai-agent-hub-desktop-session
COPY --chmod=644 desktop/xfwm4.xml desktop/xfce4-keyboard-shortcuts.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/
COPY --chmod=644 desktop/picom.conf desktop/tint2rc.in desktop/Xresources desktop/browser.desktop.in desktop/terminal.desktop /usr/local/share/cortexai-agent-hub/desktop/
COPY --chmod=644 desktop/gtk-3.0/settings.ini /usr/local/share/cortexai-agent-hub/desktop/gtk-3.0/settings.ini
COPY --chmod=644 embed.html /usr/share/novnc/embed.html
COPY --chmod=644 clipboard-bridge.js /usr/share/novnc/clipboard-bridge.js
COPY --chmod=644 mobile-keyboard.js /usr/share/novnc/mobile-keyboard.js
# Login shells source this after Debian's /etc/profile resets PATH. The home
# volume hides /etc/skel, so ~/.local/bin has to be restored from the image.
COPY --chmod=644 cortexai-agent-hub-local-bin.sh /etc/profile.d/cortexai-agent-hub-local-bin.sh
COPY --chmod=644 office_smoke.py /usr/local/share/cortexai-agent-hub-office-smoke.py
COPY --chmod=644 desktop_smoke.py /usr/local/share/cortexai-agent-hub-desktop-smoke.py
# Strip CR so shebangs work even if the build context came from a CRLF checkout.
RUN ldconfig \
  && sed -i 's/\r$//' /usr/local/bin/cortexai-agent-hub-computer /usr/local/lib/cortexai-agent-hub-user-env.sh /usr/local/bin/cortexai-agent-hub-computer-control /usr/local/bin/cortexai-agent-hub-browser /usr/local/bin/cortexai-agent-hub-focus-or-launch /usr/local/bin/cortexai-agent-hub-page-browser \
    /usr/local/bin/cortexai-agent-hub-desktop-session \
    /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-keyboard-shortcuts.xml \
    /usr/local/share/cortexai-agent-hub/desktop/picom.conf /usr/local/share/cortexai-agent-hub/desktop/tint2rc.in \
    /usr/local/share/cortexai-agent-hub/desktop/Xresources /usr/local/share/cortexai-agent-hub/desktop/browser.desktop.in \
    /usr/local/share/cortexai-agent-hub/desktop/terminal.desktop /usr/local/share/cortexai-agent-hub/desktop/gtk-3.0/settings.ini \
    /etc/profile.d/cortexai-agent-hub-local-bin.sh /usr/local/share/cortexai-agent-hub-desktop-smoke.py
EXPOSE 7070 6080 6081 6082 6083 6084 6085 6086 6087 6088 6089 6090 6091 6092 6093 6094 6095
# Docker exec does not inherit PID 1's exports, so every process gets the same
# identity lookup. Startup creates these private files for the effective UID/GID.
ENV LD_PRELOAD=/usr/local/lib/libnss_wrapper.so \
    NSS_WRAPPER_PASSWD=/tmp/cortexai-agent-hub-nss/passwd \
    NSS_WRAPPER_GROUP=/tmp/cortexai-agent-hub-nss/group
USER 1000:1000
CMD ["/usr/local/bin/cortexai-agent-hub-computer"]
