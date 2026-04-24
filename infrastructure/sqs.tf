# ============================================================
# SQS — Client Authentication Event Queue
#
# Flow:
#   ECS (server.js) ──SendMessage──► radius-auth-client-events
#                                           │
#                                     Lambda trigger
#                                           │
#                                    (on 3 failures)
#                                           ▼
#                               radius-auth-client-events-dlq
# ============================================================

# Dead-letter queue — receives messages that failed Lambda processing 3 times
resource "aws_sqs_queue" "client_events_dlq" {
  name = "${var.sqs_queue_name}-dlq"

  # Keep failed messages for 14 days for investigation
  message_retention_seconds = 1209600

  # Encryption at rest
  sqs_managed_sse_enabled = true

  tags = {
    Name = "${var.sqs_queue_name}-dlq"
  }
}

# Main queue — receives auth events from ECS
resource "aws_sqs_queue" "client_events" {
  name = var.sqs_queue_name

  # Must be >= Lambda timeout (30s). Set to 35s for safety margin.
  visibility_timeout_seconds = 35

  # Keep messages for 1 day; Lambda processes them near real-time
  message_retention_seconds = 86400

  # SQS long-polling not needed (Lambda trigger handles this natively)
  receive_wait_time_seconds = 0

  # Encryption at rest
  sqs_managed_sse_enabled = true

  # After 3 failed Lambda invocations, move message to DLQ
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.client_events_dlq.arn
    maxReceiveCount     = 3
  })

  tags = {
    Name = var.sqs_queue_name
  }
}
