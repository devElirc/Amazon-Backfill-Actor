# Use Apify Node + Playwright image
FROM apify/actor-node-playwright:20

# Switch to root temporarily to fix permissions and install dependencies
USER root

# Set working directory
WORKDIR /usr/src/app

# Copy all files
COPY . ./

# Give write access to the working directory
RUN chmod -R 777 /usr/src/app

# Install production dependencies
RUN npm install --only=prod

# Switch back to default user in the image
USER pwuser

# Default command
CMD ["node", "src/main.js"]
