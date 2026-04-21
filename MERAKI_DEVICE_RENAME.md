# Meraki Device Auto-Rename Feature

## Overview
This feature automatically renames endpoint devices in the Meraki dashboard after successful RADIUS authentication. The device name follows the format: `username.last4mac`

Example: 
- Email: `jgomez@ics.edu.sg`
- MAC Address: `fe:b2:9e:b5:06:39`
- Device Name: `jgomez.0639`

## Configuration

### Environment Variables
Add the following environment variables to enable this feature:

```bash
# Required: Meraki API Key
export MERAKI_API_KEY="your_meraki_api_key_here"

# Required: Meraki Network ID
export MERAKI_NETWORK_ID="L_3966545371806568169"

# Required: Enable the device rename feature (set to '1' to enable)
export MERAKI_DEVICE_RENAME_ENABLED="1"
```

### Example Setup
Based on your existing configuration:

```bash
export MERAKI_API_KEY="7f1e248ded3d51bada595b64f29f52d16bf673a6"
export MERAKI_NETWORK_ID="L_3966545371806568169"
export MERAKI_DEVICE_RENAME_ENABLED="1"
```

## How It Works

1. User logs in via the splash page with their ICS email (e.g., `jgomez@ics.edu.sg`)
2. RADIUS authentication is performed
3. If authentication is successful and user has the correct Filter-Id:
   - Extract username from email (part before `@`)
   - Extract last 4 characters from MAC address
   - Call Meraki API to rename the device to `username.last4mac`
4. Network access is granted

## API Call Details

The server makes the following API call to Meraki:

```bash
POST https://api.meraki.com/api/v1/networks/{NETWORK_ID}/clients/provision
Authorization: Bearer {MERAKI_API_KEY}
Content-Type: application/json

{
    "clients": [
        {
            "mac": "fe:b2:9e:b5:06:39",
            "name": "jgomez.0639"
        }
    ],
    "devicePolicy": "Normal"
}
```

## Security Notes

- The device rename operation happens asynchronously and doesn't block user authentication
- If the Meraki API call fails, the user still gets network access (the rename is optional)
- API errors are logged but don't affect the user experience
- The API key should be stored securely as an environment variable, never in code

## Troubleshooting

### Device not being renamed?

1. **Check if feature is enabled:**
   ```bash
   echo $MERAKI_DEVICE_RENAME_ENABLED
   # Should output: 1
   ```

2. **Verify API credentials:**
   ```bash
   echo $MERAKI_API_KEY
   echo $MERAKI_NETWORK_ID
   ```

3. **Check server logs:**
   ```bash
   tail -f server.log
   ```
   
   Look for messages like:
   - `Attempting to rename device [MAC] to [name]`
   - `Device renamed successfully: [name]`
   - `Device rename failed: [error]`

4. **Test Meraki API manually:**
   ```bash
   curl -L --request POST \
   --url https://api.meraki.com/api/v1/networks/$MERAKI_NETWORK_ID/clients/provision \
   --header "Authorization: Bearer $MERAKI_API_KEY" \
   --header 'Content-Type: application/json' \
   --header 'Accept: application/json' \
   --data '{
       "clients": [
           {
               "mac": "fe:b2:9e:b5:06:39",
               "name": "test.0639"
           }
       ],
       "devicePolicy": "Normal"
   }'
   ```

### Common Issues

- **Missing MAC address:** Ensure the Meraki splash page is passing the `client_mac` parameter
- **API permissions:** Verify the API key has permission to provision clients
- **Network ID mismatch:** Ensure you're using the correct Network ID for your Meraki network

## Disabling the Feature

To disable device auto-rename:

```bash
export MERAKI_DEVICE_RENAME_ENABLED="0"
# or simply unset the variable
unset MERAKI_DEVICE_RENAME_ENABLED
```

Then restart the server.
