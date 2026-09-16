FROM node:20-alpine

WORKDIR /app

# better-sqlite3のネイティブビルドに必要
RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

EXPOSE 3000
CMD ["node", "server.js"]
