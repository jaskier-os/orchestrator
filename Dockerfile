FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

# Copy SDK first (referenced as file:./sdk in package.json)
COPY sdk/ sdk/

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ src/

EXPOSE 10001

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:10001/api/v1/health || exit 1

CMD ["node", "src/index.js"]
