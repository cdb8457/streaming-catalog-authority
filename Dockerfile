FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# Expects ADMIN_DATABASE_URL + DATABASE_URL to point at an external PostgreSQL 16
# (see docker-compose.yml). Without them, the suite would boot embedded PG.
CMD ["npm", "run", "ci"]
