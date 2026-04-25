/**
 * RADIUS-Meraki Authentication Server
 * 
 * This server provides:
 * 1. RADIUS authentication for Meraki splash pages
 * 2. Filter-Id based access control using environment variables
 * 
 * Version: 3.1.0
 */

// Load environment variables from .env file
require('dotenv').config();

// Core dependencies
const express = require('express');
const radius = require('radius');
const dgram = require('dgram');
const https = require('https');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

// Application setup
const app = express();
const port = process.env.PORT || 3000;
const APP_VERSION = '3.1.0';

// RADIUS server configuration from environment variables
const RADIUS_HOST = process.env.RADIUS_HOST || '192.168.1.108'; 
const RADIUS_PORT = parseInt(process.env.RADIUS_PORT || '1812');
const RADIUS_SECRET = process.env.RADIUS_SECRET || 'testing123';
const NAS_IP_ADDRESS = process.env.NAS_IP_ADDRESS; // optional override
const NAS_IDENTIFIER = process.env.NAS_IDENTIFIER; // optional
const RADIUS_TIMEOUT_MS = parseInt(process.env.RADIUS_TIMEOUT_MS || '10000');
const RADIUS_DEBUG = process.env.RADIUS_DEBUG === '1';

// Meraki API configuration
const MERAKI_API_KEY = process.env.MERAKI_API_KEY;
const MERAKI_NETWORK_ID = process.env.MERAKI_NETWORK_ID;
const MERAKI_DEVICE_RENAME_ENABLED = process.env.MERAKI_DEVICE_RENAME_ENABLED === '1';
const TEST_USER = process.env.TEST_USER; // Skip Meraki API calls for this user

// SQS client tracking configuration
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL;
const NETWORK_SSID = process.env.NETWORK_SSID || '';
const sqsClient = SQS_QUEUE_URL
    ? new SQSClient({ region: process.env.AWS_REGION || 'ap-southeast-1' })
    : null;

// Filter-ID configuration from environment variable
// Default is StaffPolicy if not specified
const ALLOWED_FILTER_ID = process.env.ALLOWED_FILTER_ID || 'StaffPolicy';
const ACCESS_DENIED_MESSAGE = process.env.ACCESS_DENIED_MESSAGE || 'You don\'t belong to this SSID';
const ACCESS_GRANTED_MESSAGE = process.env.ACCESS_GRANTED_MESSAGE || 'Access granted - Account verified';
// If set to '0', a missing / different Filter-Id will not hard fail auth (helpful for debugging)
const AUTH_REQUIRE_FILTER_ID = process.env.AUTH_REQUIRE_FILTER_ID !== '0';

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
        const redirectUrl = `${baseUrl}?base_grant_url=https://n143.network-auth.com/splash/grant&user_continue_url=http://google.com&node_mac=00:11:22:33:44:55&client_ip=10.0.0.1&client_mac=aa:bb:cc:aa:ff:ee`;
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
            node_mac,
            ssid // allow caller to provide SSID (Meraki sometimes can pass via query/body)
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
        const result = await authenticateWithRadius(
            username,
            password,
            {
                clientMac: client_mac,
                clientIp: client_ip,
                nodeMac: node_mac,
                ssid
            }
        );

        if (result.success) {
            console.log(`Authentication successful for user: ${username}`);
            logToFile(`Authentication successful for user: ${username}, Filter-Id: ${result.filterId || 'none'}`);

            // Check if user has the allowed Filter-Id
            const filterMatch = result.filterId === ALLOWED_FILTER_ID;

            if (filterMatch || !AUTH_REQUIRE_FILTER_ID) {
                if (!filterMatch) {
                    console.log(`WARNING: Filter-Id mismatch (expected ${ALLOWED_FILTER_ID}, got ${result.filterId || 'none'}) but AUTH_REQUIRE_FILTER_ID=0 so allowing.`);
                }

                // Skip all side-effects (Meraki + SQS tracking) for the health-check test user
                const isTestUser = TEST_USER && username.toLowerCase() === TEST_USER.toLowerCase();

                if (isTestUser) {
                    console.log(`Test user detected (${username}) — skipping Meraki and client tracking`);
                } else {
                    // Rename device in Meraki dashboard
                    if (MERAKI_DEVICE_RENAME_ENABLED && client_mac) {
                        renameDeviceInMeraki(username, client_mac)
                            .then(renameResult => {
                                if (renameResult.success) {
                                    console.log(`Device renamed successfully: ${renameResult.deviceName}`);
                                } else {
                                    console.log(`Device rename failed: ${renameResult.error}`);
                                }
                            })
                            .catch(err => {
                                console.error(`Device rename error: ${err.message}`);
                            });
                    }

                    // Publish auth event to SQS for DynamoDB client tracking (async, non-blocking)
                    if (client_mac) {
                        publishClientEvent(username, client_mac, client_ip, NETWORK_SSID);
                    }
                }

                return res.status(200).json({
                    success: true,
                    message: 'Authentication successful',
                    filterId: result.filterId,
                    validation: {
                        status: 'success',
                        message: ACCESS_GRANTED_MESSAGE,
                        filterPolicy: {
                            required: ALLOWED_FILTER_ID,
                            received: result.filterId || null,
                            enforced: AUTH_REQUIRE_FILTER_ID
                        }
                    }
                });
            }

            console.log(`User does not have required Filter-Id (${ALLOWED_FILTER_ID}) - Access denied`);
            return res.status(403).json({
                success: false,
                message: ACCESS_DENIED_MESSAGE,
                filterId: result.filterId,
                validation: {
                    status: 'error',
                    message: `Access denied - ${ACCESS_DENIED_MESSAGE}`,
                    filterPolicy: {
                        required: ALLOWED_FILTER_ID,
                        received: result.filterId || null,
                        enforced: AUTH_REQUIRE_FILTER_ID
                    }
                }
            });
        } else {
            console.log(`Authentication failed for user: ${username}`);
            return res.status(401).json({
                success: false,
                message: result.message || 'Authentication failed',
                radius: result.radius || undefined
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

// Builds the canonical device/client name used in both Meraki and DynamoDB:
//   "john.doe@ics.edu.sg" + "aa:bb:cc:dd:ee:ff"  →  "john.doe.eeff"
function buildDeviceName(email, macAddress) {
    const userPart = email.split('@')[0];
    const last4Mac = macAddress.replace(/[:-]/g, '').toLowerCase().slice(-4);
    return `${userPart}.${last4Mac}`;
}

// Publishes a client auth event to SQS for async DynamoDB tracking.
// Non-blocking — failures are logged but do not affect the auth response.
async function publishClientEvent(username, clientMac, clientIp, ssid) {
    if (!sqsClient || !SQS_QUEUE_URL) return;

    try {
        const payload = {
            clientId:   clientMac,
            clientName: buildDeviceName(username, clientMac),
            macAddress: clientMac,
            clientIp:   clientIp || '',
            ssid:       ssid || '',
        };

        await sqsClient.send(new SendMessageCommand({
            QueueUrl:    SQS_QUEUE_URL,
            MessageBody: JSON.stringify(payload),
        }));

        console.log(`Client event queued for tracking: ${clientMac} (${username})`);
    } catch (err) {
        // Log and continue — client tracking must not block or fail authentication
        console.error(`Failed to queue client event for ${clientMac}: ${err.message}`);
    }
}

// Meraki API function to rename device
async function renameDeviceInMeraki(email, macAddress) {
    try {
        // Validate required configuration
        if (!MERAKI_API_KEY || !MERAKI_NETWORK_ID) {
            return {
                success: false,
                error: 'Meraki API credentials not configured'
            };
        }

        const deviceName = buildDeviceName(email, macAddress);
        
        console.log(`Attempting to rename device ${macAddress} to ${deviceName}`);
        
        // Prepare API request
        const url = `https://api.meraki.com/api/v1/networks/${MERAKI_NETWORK_ID}/clients/provision`;
        const payload = {
            clients: [
                {
                    mac: macAddress,
                    name: deviceName
                }
            ],
            devicePolicy: 'Normal'
        };
        
        // Make API call using https module
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify(payload);
            
            const options = {
                hostname: 'api.meraki.com',
                port: 443,
                path: `/api/v1/networks/${MERAKI_NETWORK_ID}/clients/provision`,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${MERAKI_API_KEY}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };
            
            const req = https.request(options, (res) => {
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        console.log(`Meraki API response: ${res.statusCode}`);
                        resolve({
                            success: true,
                            deviceName: deviceName,
                            response: data
                        });
                    } else {
                        console.error(`Meraki API error: ${res.statusCode} - ${data}`);
                        resolve({
                            success: false,
                            error: `API returned status ${res.statusCode}: ${data}`
                        });
                    }
                });
            });
            
            req.on('error', (err) => {
                console.error('Meraki API request error:', err);
                reject(err);
            });
            
            // Write data to request body
            req.write(postData);
            req.end();
        });
        
    } catch (error) {
        console.error('Error in renameDeviceInMeraki:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// RADIUS authentication function
function authenticateWithRadius(username, password, context = {}) {
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
                if (RADIUS_DEBUG && response.attributes) {
                    console.log('RADIUS Attributes:', JSON.stringify(response.attributes, null, 2));
                }

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
                    const replyMessage = response.attributes && response.attributes['Reply-Message']
                        ? response.attributes['Reply-Message']
                        : undefined;
                    resolve({
                        success: false,
                        message: replyMessage || `Authentication failed. Please check your credentials.`,
                        radius: {
                            code: response.code,
                            replyMessage
                        }
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
                    ['User-Password', password], // PAP
                    ['Service-Type', 'Framed-User'],
                    ['NAS-Port', 0]
                ]
            };

            // Determine NAS-IP-Address
            const nasIp = NAS_IP_ADDRESS || detectServerIP();
            if (nasIp) packet.attributes.push(['NAS-IP-Address', nasIp]);
            if (NAS_IDENTIFIER) packet.attributes.push(['NAS-Identifier', NAS_IDENTIFIER]);

            // Add contextual attributes if provided
            if (context.clientMac) {
                packet.attributes.push(['Calling-Station-Id', context.clientMac]);
            }
            if (context.nodeMac || context.ssid) {
                // Called-Station-Id format often AP_MAC:SSID (AP MAC no separators) or AP_MAC:SSID
                let called = context.nodeMac || '';
                if (called && called.includes(':')) called = called.toUpperCase().replace(/:/g, '-');
                if (context.ssid) {
                    called = called ? `${called}:${context.ssid}` : context.ssid;
                }
                if (called) packet.attributes.push(['Called-Station-Id', called]);
            }

            if (RADIUS_DEBUG) {
                console.log('Outgoing RADIUS attributes:', JSON.stringify(packet.attributes, null, 2));
            }

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
            }, RADIUS_TIMEOUT_MS);

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

        function detectServerIP() {
            try {
                const ifs = os.networkInterfaces();
                for (const name of Object.keys(ifs)) {
                    for (const iface of ifs[name]) {
                        if (iface.family === 'IPv4' && !iface.internal) {
                            return iface.address;
                        }
                    }
                }
            } catch (e) {
                if (RADIUS_DEBUG) console.log('Failed to detect server IP:', e.message);
            }
            return null;
        }
    });
}

// Start server
app.listen(port, () => {
    console.log(`Server started successfully!`);
    console.log(`Ready to receive connections.`);
});