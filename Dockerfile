FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Install curl for health checks with retry logic
# Use main Alpine mirror instead of CDN for better reliability
RUN sed -i 's/dl-cdn.alpinelinux.org/dl-4.alpinelinux.org/g' /etc/apk/repositories && \
    apk update && apk add --no-cache curl

# Install app dependencies
# Copy package.json and package-lock.json first for better caching
COPY package*.json ./
RUN npm ci --only=production

# Bundle app source
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Define environment variables with defaults
ENV PORT=3000

# RADIUS Configuration
ENV RADIUS_HOST="13.250.55.36"
ENV RADIUS_PORT=1812
ENV RADIUS_SECRET="testing123"
ENV RADIUS_TIMEOUT_MS=10000
ENV RADIUS_DEBUG=0

# Optional RADIUS attributes
ENV NAS_IP_ADDRESS=""
ENV NAS_IDENTIFIER=""

# Filter-ID Access Control
ENV ALLOWED_FILTER_ID="StaffPolicy"
ENV ACCESS_DENIED_MESSAGE="You don't belong to this SSID"
ENV ACCESS_GRANTED_MESSAGE="Access granted - Account verified"
ENV AUTH_REQUIRE_FILTER_ID=1

# Meraki API Configuration
ENV MERAKI_API_KEY=""
ENV MERAKI_NETWORK_ID=""
ENV MERAKI_DEVICE_RENAME_ENABLED=0

# Set Node to production mode
ENV NODE_ENV=production

# Use a non-root user for security
RUN adduser -D -H -h /usr/src/app appuser && \
    chown -R appuser:appuser /usr/src/app
USER appuser

# Start the application
CMD [ "node", "server.js" ]