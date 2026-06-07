FROM node:20-alpine

# Install build dependencies for sqlite3 native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY . .

EXPOSE 3005

ENV PORT=3005
ENV NODE_ENV=production

CMD ["node", "server.js"]
