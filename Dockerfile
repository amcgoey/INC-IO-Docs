# --- Stage 1: Build ---
FROM node:22-slim AS builder

WORKDIR /app

# Copy package files and install all dependencies (including devDependencies)
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the source code
COPY . .

# Build the TypeScript code
RUN npm run build

# --- Stage 2: Production ---
FROM node:22-slim

WORKDIR /app
RUN chown node:node /app

# Run as non-root user
USER node

# Copy package files and install only production dependencies
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled code from the builder stage
COPY --chown=node:node --from=builder /app/dist ./dist

# Expose port 8080
EXPOSE 8080

# Start the application
CMD ["npm", "start"]
