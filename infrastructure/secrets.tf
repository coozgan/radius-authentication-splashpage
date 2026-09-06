# ============================================================
# Secrets Manager — Meraki Dashboard API Key
#
# The secret is created here but the VALUE must be set manually
# after terraform apply (so the key never appears in .tfstate):
#
#   aws secretsmanager put-secret-value \
#     --region ap-southeast-1 \
#     --secret-id radius-auth-meraki-api-key \
#     --secret-string '{"api_key":"YOUR_MERAKI_API_KEY_HERE"}'
# ============================================================

# ============================================================
# Secrets Manager — Dashboard API shared key
#
# The shared secret the frontend presents as X-Dashboard-Key and the
# dashboard Lambda demands before any routing. API Gateway has no
# authorizer, so this is the only gate on the API.
#
# Same manual-value rule as above — generate and set it after apply:
#
#   KEY=$(openssl rand -base64 32)
#   aws secretsmanager put-secret-value \
#     --region ap-southeast-1 \
#     --secret-id radius-auth-dashboard-api-key \
#     --secret-string "{\"api_key\":\"$KEY\"}"
#
# then set the same $KEY as the encrypted DASHBOARD_API_KEY variable on
# the Cloudflare Pages project. Set Cloudflare FIRST: the Lambda starts
# refusing unkeyed requests the moment it is deployed.
# ============================================================

resource "aws_secretsmanager_secret" "dashboard_api_key" {
  name        = "${var.project}-dashboard-api-key"
  description = "Shared secret the frontend presents to the dashboard API; the only gate on API Gateway."

  recovery_window_in_days = 7

  tags = {
    Project     = var.project
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret" "meraki_api_key" {
  name        = "${var.project}-meraki-api-key"
  description = "Meraki Dashboard API key used by the dashboard Lambda to extend splash authorizations."

  # Prevent accidental deletion — must be explicitly recovered or force-deleted
  recovery_window_in_days = 7

  tags = {
    Project     = var.project
    Environment = var.environment
  }
}
