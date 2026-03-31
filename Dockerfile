FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --silent
COPY . .
CMD ["node", "net-dump.js"]
