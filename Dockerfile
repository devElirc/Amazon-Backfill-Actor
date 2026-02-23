# Use official Apify Node + Playwright image
FROM apify/actor-node-playwright:20

# Set working directory
WORKDIR /usr/src/app

# Copy package files first (better Docker caching)
COPY package*.json ./

# Install production dependencies only
RUN npm install --omit=dev

# Copy the rest of the project
COPY . ./

# Start the Actor
CMD ["node", "src/main.js"]