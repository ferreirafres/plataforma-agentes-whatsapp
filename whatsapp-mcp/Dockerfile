FROM node:22-alpine
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont font-noto-emoji ffmpeg \
    && addgroup -g 10001 app && adduser -D -u 10001 -G app app \
    && install -d -m 0700 -o app -g app /data /bootstrap

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    NODE_ENV=production \
    HOME=/home/app
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.js ./
USER app
EXPOSE 3000
CMD ["node", "index.js"]
