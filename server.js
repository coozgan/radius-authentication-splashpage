/**
 * RADIUS-Meraki Authentication Server
 * 
 * This server provides:
 * 1. RADIUS authentication for Meraki splash pages
 * 2. Filter-Id based access control using environment variables
 * 
 * Version: 3.1.0
 */

// Core dependencies
const express = require('express');
const radius = require('radius');
const dgram = require('dgram');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Application setup
const app = express();
const port = process.env.PORT || 3000;
const APP_VERSION = '3.1.0';

// RADIUS server configuration from environment variables
const RADIUS_HOST = process.env.RADIUS_HOST || '192.168.1.108'; 
const RADIUS_PORT = parseInt(process.env.RADIUS_PORT || '1812');
const RADIUS_SECRET = process.env.RADIUS_SECRET || 'testing123';

// Filter-ID configuration from environment variable
// Default is StaffPolicy if not specified
const ALLOWED_FILTER_ID = process.env.ALLOWED_FILTER_ID || 'StaffPolicy';
const ACCESS_DENIED_MESSAGE = process.env.ACCESS_DENIED_MESSAGE || 'You don\'t belong to this SSID';

// Simple file logger
const logToFile = (message) => {
    try {
        fs.appendFileSync('server.log', `[${new Date().toISOString()}] ${message}\n`);
    } catch (e) {
        console.error('Failed to write to log file:', e);
    }
};

// Minimal startup logging
console.log(`RADIUS-Meraki Auth Server v${APP_VERSION} starting`);

// Only log critical configuration issues
if (!RADIUS_SECRET) {
    console.error('CRITICAL ERROR: RADIUS shared secret is missing!');
    process.exit(1);
}

// ===== MIDDLEWARE SETUP =====
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Security headers
app.use((req, res, next) => {
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://stackpath.bootstrapcdn.com; img-src 'self' data: http: https:; font-src 'self'; connect-src 'self'"
    );
    next();
});

// Request logging middleware - only log errors and slow responses
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        // Only log errors (4xx/5xx) and slow responses (>1000ms)
        if (res.statusCode >= 400 || duration > 1000) {
            console.log(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
        }
    });
    next();
});

// ===== ROUTE DEFINITIONS =====

// Serve the splash page as default
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Test splash page with parameters
app.get('/test-splash', (req, res) => {
    console.log('Test splash page requested');

    try {
        // Build the redirect URL with test parameters
        const baseUrl = `${req.protocol}://${req.get('host')}/`;
        const redirectUrl = `${baseUrl}?base_grant_url=https://n143.network-auth.com/splash/grant&user_continue_url=http://google.com&node_mac=00:11:22:33:44:55&client_ip=10.0.0.1&client_mac=AA:BB:CC:DD:EE:FF`;
        return res.redirect(redirectUrl);
    } catch (err) {
        console.error('Error in test-splash route:', err);
        return res.status(500).send('Error preparing test splash parameters: ' + err.message);
    }
});

// Health check endpoint with configuration info
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        version: APP_VERSION,
        timestamp: new Date().toISOString(),
        radius: {
            host: RADIUS_HOST,
            port: RADIUS_PORT
        },
        accessControl: {
            allowedFilterId: ALLOWED_FILTER_ID
        },
        container: {
            hostname: os.hostname()
        }
    });
});

// Health check endpoint for ECS and load balancers
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// RADIUS authentication endpoint
app.post('/auth/radius', async (req, res) => {
    console.log('Authentication request received');
    logToFile(`Authentication request: ${JSON.stringify(req.body)}`);

    try {
        // Extract parameters from the request
        const {
            username,
            password,
            client_mac,
            client_ip,
            node_mac
        } = req.body;

        // Validate inputs
        if (!username || !password) {
            console.log('Missing credentials in request');
            return res.status(400).json({
                success: false,
                message: 'Username and password are required'
            });
        }

        // Perform RADIUS authentication
        const result = await authenticateWithRadius(username, password);

        if (result.success) {
            console.log(`Authentication successful for user: ${username}`);
            logToFile(`Authentication successful for user: ${username}, Filter-Id: ${result.filterId || 'none'}`);

            // Check if user has the allowed Filter-Id
            if (result.filterId === ALLOWED_FILTER_ID) {
                // Add this with your other environment variables near the top of the file
                const ACCESS_GRANTED_MESSAGE = process.env.ACCESS_GRANTED_MESSAGE || 'Access granted - Account verified';
                
                // Modified success response code:
                return res.status(200).json({
                    success: true,
                    message: 'Authentication successful',
                    filterId: result.filterId,
                    validation: {
                        status: 'success',
                        message: ACCESS_GRANTED_MESSAGE
                    }
                });
            } else {
                console.log(`User does not have ${ALLOWED_FILTER_ID} Filter-Id - Access denied`);
                return res.status(403).json({
                    success: false,
                    message: ACCESS_DENIED_MESSAGE,
                    filterId: result.filterId,
                    validation: {
                        status: 'error',
                        message: `Access denied - ${ACCESS_DENIED_MESSAGE}`
                    }
                });
            }
        } else {
            console.log(`Authentication failed for user: ${username}`);
            return res.status(401).json({
                success: false,
                message: result.message || 'Authentication failed'
            });
        }
    } catch (error) {
        console.error('Authentication error:', error.message);
        logToFile(`Authentication error: ${error.message}`);
        return res.status(500).json({
            success: false,
            message: 'Server error during authentication'
        });
    } finally {
        console.log('Authentication request completed');
        console.log('=================================================');
    }
});

// RADIUS authentication function
function authenticateWithRadius(username, password) {
    return new Promise((resolve, reject) => {
        // Create UDP client
        const client = dgram.createSocket('udp4');
        let timeoutId = null;
        let clientClosed = false;

        // Handle socket errors
        client.on('error', (err) => {
            console.error('Socket error:', err);
            if (!clientClosed) {
                clearTimeoutSafely();
                closeSafely();
                reject(new Error(`Network error: ${err.message}`));
            }
        });

        // Handle RADIUS responses
        client.on('message', (message, rinfo) => {
            if (clientClosed) return;

            clearTimeoutSafely();
            console.log(`Received RADIUS response from ${rinfo.address}:${rinfo.port}`);

            try {
                // Decode the response
                const response = radius.decode({
                    packet: message,
                    secret: RADIUS_SECRET
                });

                console.log('Decoded response code:', response.code);

                // Log only in debug mode to save on CloudWatch costs
                // if (response.attributes) {
                //     console.log('RADIUS Attributes:', JSON.stringify(response.attributes, null, 2));
                // }

                closeSafely();

                // Check response code
                if (response.code === 'Access-Accept') {
                    // Extract Filter-Id if present
                    const filterId = response.attributes && response.attributes['Filter-Id']
                        ? response.attributes['Filter-Id']
                        : null;
                    resolve({ success: true, filterId: filterId });
                } else {
                    console.log('Authentication failed. Response code:', response.code);
                    resolve({
                        success: false,
                        message: `Authentication failed. Please check your credentials.`
                    });
                }
            } catch (err) {
                console.error('Failed to decode RADIUS response:', err);
                closeSafely();
                reject(new Error(`Failed to process authentication response: ${err.message}`));
            }
        });

        // Create RADIUS request
        try {                // Create the packet
            const packet = {
                code: 'Access-Request',
                identifier: Math.floor(Math.random() * 256),
                attributes: [
                    ['User-Name', username],
                    ['User-Password', password],
                    ['NAS-IP-Address', '127.0.0.1'],
                    ['NAS-Port', 0]
                ]
            };

            // Encode the packet with shared secret
            const encoded = radius.encode({
                ...packet,
                secret: RADIUS_SECRET
            });

            // Send the packet to RADIUS server
            client.send(encoded, 0, encoded.length, RADIUS_PORT, RADIUS_HOST, (err) => {
                if (err) {
                    console.error('Failed to send request:', err);
                    clearTimeoutSafely();
                    closeSafely();
                    reject(new Error(`Failed to send authentication request: ${err.message}`));
                } else {
                    try {
                        const address = client.address();
                        console.log(`RADIUS request sent from ${address.address}:${address.port} to ${RADIUS_HOST}:${RADIUS_PORT}`);
                    } catch (err) {
                        console.log(`RADIUS request sent to ${RADIUS_HOST}:${RADIUS_PORT}`);
                    }
                }
            });

            // Set request timeout
            timeoutId = setTimeout(() => {
                console.log('RADIUS request timed out');
                closeSafely();
                resolve({ success: false, message: 'Authentication server timed out' });
            }, 10000); // 10 second timeout

        } catch (err) {
            console.error('Failed to create RADIUS request:', err);
            closeSafely();
            reject(new Error(`Failed to create authentication request: ${err.message}`));
        }

        // Helper function to safely clear timeout
        function clearTimeoutSafely() {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
        }

        // Helper function to safely close socket
        function closeSafely() {
            if (clientClosed) return;
            clientClosed = true;

            try {
                client.removeAllListeners();
                client.close();
            } catch (err) {
                console.error('Error closing socket:', err);
            }
        }
    });
}

// Start server
app.listen(port, () => {
    console.log(`Server started successfully!`);
    console.log(`Ready to receive connections.`);
});