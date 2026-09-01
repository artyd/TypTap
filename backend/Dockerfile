FROM node:20-alpine

WORKDIR /app

# Ставим зависимости отдельным слоем — кэшируется, пока package*.json не менялись.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Код приложения.
COPY . .

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

CMD ["node", "server.js"]
