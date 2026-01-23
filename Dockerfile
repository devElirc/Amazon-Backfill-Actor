# ================================
# Use Playwright base image matching local version
# ================================
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

# ================================
# Set working directory
# ================================
WORKDIR /usr/src/app

# ================================
# Copy package files first and install dependencies
# This ensures Docker caching works efficiently
# ================================
COPY package.json package-lock.json ./

# Install dependencies exactly as in package-lock.json
RUN npm ci --only=production

# ================================
# Copy the rest of the app
# ================================
COPY . .

# ================================
# Ensure user pwuser has access
# The base image already has 'pwuser'
# ================================
RUN chown -R pwuser:pwuser /usr/src/app

# Switch to non-root user for security
USER pwuser

# ================================
# Default command
# ================================
CMD ["node", "src/main.js"]
