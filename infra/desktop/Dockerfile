FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    xfce4-session xfce4-panel xfce4-settings xfdesktop4 xfwm4 thunar \
    dbus-x11 tigervnc-standalone-server tigervnc-tools websockify \
    x11-utils xdotool xclip scrot fonts-noto-cjk fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 10001 -s /bin/bash muse && mkdir -p /workspace /opt/opengrok \
    && chown -R muse:muse /workspace /opt/opengrok
WORKDIR /opt/opengrok
COPY apps/desktop-runtime/package.json apps/desktop-runtime/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY apps/desktop-runtime/runtime.mjs ./runtime.mjs
COPY packages/network-policy/public-url.mjs ./public-url.mjs
COPY apps/desktop-runtime/network-policy.mjs ./network-policy.mjs
COPY apps/desktop-runtime/workspace-files.mjs ./workspace-files.mjs
COPY infra/desktop/start.sh ./start.sh
RUN chmod +x ./start.sh && chown -R muse:muse /opt/opengrok
USER muse
EXPOSE 6080 3843
CMD ["/opt/opengrok/start.sh"]
