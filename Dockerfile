# Use official Apify Node + Playwright image
FROM apify/actor-node-playwright:20

# Switch to root to install dependencies
USER root

WORKDIR /usr/src/app

# Copy package files first (better caching)
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy the rest of the project
COPY . ./

# Fix ownership so the default user can access files
RUN chown -R myuser:myuser /usr/src/app

# Switch back to default Apify user
USER myuser

# Start the Actor
CMD ["node", "src/main.js"]