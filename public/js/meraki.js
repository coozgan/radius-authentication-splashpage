/**
 * Meraki Splash Page with RADIUS Authentication
 * 
 * Handles parameter extraction, authentication, and network access
 */

// Set up page when loaded
document.addEventListener('DOMContentLoaded', function() {
    // Extract Meraki parameters
    extractAndLogParameters();
    
    // Set up form submission handler
    document.getElementById('loginForm').addEventListener('submit', function(e) {
        e.preventDefault();
        performAuthentication();
    });
    
    // Add validation styles
    addValidationStyles();
});

// Global variables to store Meraki parameters
let base_grant_url = '';
let user_continue_url = '';
let node_mac = '';
let client_ip = '';
let client_mac = '';

// Extract and log Meraki parameters
function extractAndLogParameters() {
    // Log raw query string for debugging
    const rawQuery = window.location.search;
    console.log('Raw query string:', rawQuery);
    
    // Parse query parameters
    const urlParams = new URLSearchParams(window.location.search);
    
    // Extract required Meraki parameters
    base_grant_url = urlParams.get('base_grant_url') || '';
    user_continue_url = urlParams.get('user_continue_url') || '';
    node_mac = urlParams.get('node_mac') || '';
    client_ip = urlParams.get('client_ip') || '';
    client_mac = urlParams.get('client_mac') || '';
    
    // Log extracted parameters
    console.log('Extracted Meraki parameters:');
    console.log('- base_grant_url:', base_grant_url);
    console.log('- user_continue_url:', user_continue_url);
    console.log('- node_mac:', node_mac);
    console.log('- client_ip:', client_ip);
    console.log('- client_mac:', client_mac);
    
    // Fix MAC address format if needed
    if (client_mac) {
        // Ensure proper MAC format with colons
        if (!client_mac.includes(':')) {
            let formattedMac = '';
            for (let i = 0; i < client_mac.length; i += 2) {
                formattedMac += client_mac.substr(i, 2) + (i < client_mac.length - 2 ? ':' : '');
            }
            client_mac = formattedMac;
            console.log('Reformatted client_mac:', client_mac);
        }
    }
    
    // Validate required parameters
    if (!base_grant_url || !user_continue_url) {
        console.warn('Missing required Meraki parameters!');
        showErrorMessage('This page must be accessed via Meraki splash page redirect.');
    }
}

// Authenticate with RADIUS server
async function performAuthentication() {
    // Show loading indicator and hide any messages
    showLoading(true);
    hideMessages();
    hideValidationStatus();
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    try {
        console.log('Sending authentication request to server...');
        
        // Send authentication request with all Meraki parameters to the server
        const response = await fetch('/auth/radius', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                username: username,
                password: password,
                // Pass all Meraki parameters to the server
                client_mac: client_mac,
                client_ip: client_ip,
                node_mac: node_mac
            })
        });
        
        const data = await response.json();
        console.log('Authentication response:', data);
        
        if (response.ok && data.success) {
            // RADIUS Authentication successful and StaffPolicy filter found
            console.log(`Authentication successful! Filter-Id: ${data.filterId || 'none'}`);
            
            // Show success message
            showSuccessMessage('Authentication successful!');
            
            // Show validation status
            if (data.validation) {
                showValidationStatus(
                    data.validation.status || 'success',
                    data.validation.message || 'Access '
                );
            }
            
            // Grant network access after a short delay
            setTimeout(() => {
                grantNetworkAccess();
            }, 1500);
        } else {
            // Authentication failed or policy not matched
            const errorMsg = data.message || 'Authentication failed. Please check your credentials.';
            console.error('Authentication failed:', errorMsg);
            
            showErrorMessage(errorMsg);
            
            // Show validation status if available
            if (data.validation) {
                showValidationStatus(
                    data.validation.status || 'error',
                    data.validation.message || 'Access denied'
                );
            }
            
            showLoading(false);
        }
    } catch (error) {
        console.error('Authentication error:', error);
        showErrorMessage('Network error. Please try again later.');
        showLoading(false);
    }
}

// Grant network access using the Meraki base_grant_url
function grantNetworkAccess() {
    if (!base_grant_url) {
        console.error('Cannot grant network access: base_grant_url is missing');
        showErrorMessage('Cannot grant network access due to missing parameters.');
        showLoading(false);
        return;
    }
    
    // Construct the full grant URL
    const grantUrl = `${base_grant_url}?continue_url=${encodeURIComponent(user_continue_url)}`;
    console.log('Redirecting to:', grantUrl);
    
    // Redirect to grant URL
    window.location.href = grantUrl;
}

// UI Helper Functions
function showLoading(show) {
    const loadingIndicator = document.getElementById('loadingIndicator');
    if (loadingIndicator) {
        loadingIndicator.style.display = show ? 'block' : 'none';
    }
    
    const loginButton = document.getElementById('loginButton');
    if (loginButton) {
        loginButton.disabled = show;
    }
}

function hideMessages() {
    const errorMessage = document.getElementById('errorMessage');
    const successMessage = document.getElementById('successMessage');
    
    if (errorMessage) errorMessage.style.display = 'none';
    if (successMessage) successMessage.style.display = 'none';
}

function showErrorMessage(message) {
    const errorMessage = document.getElementById('errorMessage');
    if (errorMessage) {
        errorMessage.textContent = message;
        errorMessage.style.display = 'block';
    }
}

function showSuccessMessage(message) {
    const successMessage = document.getElementById('successMessage');
    if (successMessage) {
        successMessage.textContent = message;
        successMessage.style.display = 'block';
    }
}

// Add validation status UI functions
function showValidationStatus(status, message) {
    // Create validation container if it doesn't exist
    let container = document.getElementById('validationStatus');
    if (!container) {
        container = document.createElement('div');
        container.id = 'validationStatus';
        container.className = 'validation-status';
        
        const iconElement = document.createElement('div');
        iconElement.className = 'validation-icon';
        
        const messageElement = document.createElement('div');
        messageElement.className = 'validation-message';
        
        container.appendChild(iconElement);
        container.appendChild(messageElement);
        
        // Insert after status container or before form actions
        const statusContainer = document.getElementById('statusContainer');
        if (statusContainer) {
            statusContainer.appendChild(container);
        } else {
            const formActions = document.querySelector('.form-actions');
            if (formActions) {
                formActions.parentElement.insertBefore(container, formActions);
            }
        }
    }
    
    container.style.display = 'flex';
    container.className = 'validation-status ' + status; // success, warning, or error
    
    // Set appropriate icon based on status
    const iconElement = container.querySelector('.validation-icon');
    if (iconElement) {
        if (status === 'success') {
            iconElement.innerHTML = '✓';
        } else if (status === 'warning') {
            iconElement.innerHTML = '⚠';
        } else if (status === 'error') {
            iconElement.innerHTML = '✗';
        }
    }
    
    const messageElement = container.querySelector('.validation-message');
    if (messageElement) {
        messageElement.textContent = message;
    }
}

function hideValidationStatus() {
    const container = document.getElementById('validationStatus');
    if (container) {
        container.style.display = 'none';
    }
}

// Add some CSS for validation status
function addValidationStyles() {
    // Check if styles already exist
    if (document.getElementById('validation-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'validation-styles';
    style.textContent = `
        .validation-status {
            margin: 15px 0;
            padding: 10px;
            border-radius: 4px;
            display: flex;
            align-items: center;
        }
        
        .validation-status.success {
            background-color: #d4edda;
            border: 1px solid #c3e6cb;
            color: #155724;
        }
        
        .validation-status.warning {
            background-color: #fff3cd;
            border: 1px solid #ffeeba;
            color: #856404;
        }
        
        .validation-status.error {
            background-color: #f8d7da;
            border: 1px solid #f5c6cb;
            color: #721c24;
        }
        
        .validation-icon {
            display: inline-block;
            width: 20px;
            height: 20px;
            margin-right: 8px;
            text-align: center;
            font-weight: bold;
        }
        
        .validation-message {
            display: inline-block;
            flex: 1;
        }
    `;
    
    document.head.appendChild(style);
}