FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++ git

COPY vendor ./vendor
RUN cd vendor/stoat.js && npm install --legacy-peer-deps && npm run build

COPY package*.json ./

RUN npm install

FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/vendor ./vendor
COPY . .

RUN addgroup -S appgroup && adduser -S appuser -G appgroup && \
    mkdir -p data/logs data/storage data/temp_media && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

CMD ["node", "index.js"]
