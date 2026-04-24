# ============================================================
# DynamoDB — Client Tracking Table
#
# Schema:
#   PK  ClientID (S)        — MAC address (unique per device in Meraki)
#       ClientName (S)      — Authenticated username / email
#       MacAddress (S)      — MAC address (explicit column alongside PK)
#       ConnectionTimestamp (S) — Last successful auth, ISO 8601 SGT (+08:00)
#       ExpirationTimestamp (S) — ConnectionTimestamp + 90 days, ISO 8601 SGT
#       LastUpdated (S)     — UTC ISO 8601 of last DynamoDB write
#       ClientIP (S)        — IP address at time of last auth
#       SSID (S)            — WiFi SSID (set via NETWORK_SSID ECS env var)
#       ConnectionCount (N) — Lifetime count of successful authentications
#
# Records are NEVER deleted — only added or updated.
# ExpirationTimestamp is stored for application-level queries only;
# DynamoDB TTL is intentionally NOT enabled so records are kept forever.
# ============================================================

resource "aws_dynamodb_table" "client_tracking" {
  name         = var.dynamodb_table_name
  billing_mode = "PAY_PER_REQUEST" # On-demand — no capacity planning needed

  hash_key = "ClientID"

  attribute {
    name = "ClientID"
    type = "S"
  }

  # Point-in-time recovery: enables restore to any second in the past 35 days
  point_in_time_recovery {
    enabled = true
  }

  # Encryption at rest using AWS-owned key (no extra cost)
  server_side_encryption {
    enabled = true
  }

  tags = {
    Name = var.dynamodb_table_name
  }
}
