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
