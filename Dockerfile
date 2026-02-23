# Use the exact Playwright version required
FROM mcr.microsoft.com/playwright:v1.57.0-noble

# Install Node 20 (image already contains Node)
WORKDIR /usr/src/app

# Copy package files first
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy rest of project
COPY . ./

# Start app
CMD ["node", "src/main.js"]