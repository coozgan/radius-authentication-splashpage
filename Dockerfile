FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Install curl for health checks
RUN apk add --no-cache curl

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
ENV RADIUS_HOST="10.0.0.1"
ENV RADIUS_PORT=1812
ENV RADIUS_SECRET="testing123"
ENV ALLOWED_FILTER_ID="StaffPolicy"
ENV ACCESS_DENIED_MESSAGE="You don't belong to this SSID"
ENV ACCESS_GRANTED_MESSAGE="Access granted - Staff account verified"

# Set Node to production mode
ENV NODE_ENV=production

# Use a non-root user for security
RUN adduser -D -H -h /usr/src/app appuser && \
    chown -R appuser:appuser /usr/src/app
USER appuser

# Start the application
CMD [ "node", "server.js" ]