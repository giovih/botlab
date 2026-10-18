# Il "mini PC" di ogni bot: Ubuntu con desktop grafico, Chromium e terminale.
# Lo schermo si guarda in diretta dall'app (noVNC).
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    LANG=C.UTF-8 \
    DISPLAY=:1
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl wget ca-certificates git python3 python3-pip python3-venv \
      nano jq unzip zip procps iputils-ping less file socat \
      xvfb x11vnc openbox tint2 xterm xdotool scrot x11-utils x11-xserver-utils \
      novnc websockify fonts-dejavu fonts-liberation fonts-noto-color-emoji \
      libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
      libasound2t64 libatspi2.0-0t64 \
    && rm -rf /var/lib/apt/lists/*
# Chromium (quello di Playwright: funziona su Intel e ARM senza snap).
# I bot possono usare Playwright anche dai loro script Python.
ARG SKIP_BROWSER=0
RUN if [ "$SKIP_BROWSER" != 1 ]; then \
      pip3 install --no-cache-dir playwright \
      && python3 -m playwright install --with-deps chromium \
      && rm -rf /var/lib/apt/lists/*; \
    fi
COPY desktop/chromium /usr/local/bin/chromium
COPY desktop/avvia-desktop /usr/local/bin/avvia-desktop
COPY desktop/chromium.desktop /usr/share/applications/chromium.desktop
COPY desktop/tint2rc /root/.config/tint2/tint2rc
RUN chmod +x /usr/local/bin/chromium /usr/local/bin/avvia-desktop
WORKDIR /root
CMD ["/usr/local/bin/avvia-desktop"]
