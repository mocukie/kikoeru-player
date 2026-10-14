FROM node:24
RUN apt-get update && apt-get install -y --no-install-recommends xz-utils libgtk-3-0 libasound2 libx11-xcb1 libdbus-glib-1-2 libxtst6 libpci3 pulseaudio pulseaudio-utils && rm -rf /var/lib/apt/lists/*
ADD firefox-158.0.tar.xz /opt/
ADD geckodriver.tgz /usr/local/bin/
RUN ln -s /opt/firefox/firefox /usr/local/bin/firefox
