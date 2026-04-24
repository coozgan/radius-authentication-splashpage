# ============================================================
# Lambda — Client Tracker
#
# Triggered by SQS. Reads each auth event and upserts the
# client record in DynamoDB (add or update, never delete).
# Reports partial batch failures so only failed messages
# are retried — not the entire batch.
# ============================================================

# Zip the lambda-src directory on every plan/apply
data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = "${path.module}/lambda-src"
  output_path = "${path.module}/.terraform/lambda-package.zip"
}

resource "aws_lambda_function" "client_tracker" {
  function_name    = var.lambda_function_name
  description      = "Upserts RADIUS client records in DynamoDB on each successful authentication"
  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs18.x"
  architectures    = ["arm64"] # Graviton2 — ~20% cheaper, same performance
  role             = aws_iam_role.lambda_execution_role.arn
  timeout          = 30
  memory_size      = 128

  environment {
    variables = {
      DYNAMODB_TABLE_NAME                 = aws_dynamodb_table.client_tracking.name
      AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1" # Keep-alive for DynamoDB HTTP connections
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.lambda_basic_execution,
    aws_iam_role_policy_attachment.lambda_dynamodb,
    aws_iam_role_policy_attachment.lambda_sqs_consume,
    aws_cloudwatch_log_group.lambda_logs,
  ]
}

# SQS → Lambda trigger
resource "aws_lambda_event_source_mapping" "sqs_trigger" {
  event_source_arn = aws_sqs_queue.client_events.arn
  function_name    = aws_lambda_function.client_tracker.arn
  enabled          = true

  # Process up to 10 messages per invocation
  batch_size = 10

  # Collect messages for up to 5 seconds before invoking (reduces Lambda calls during bursts)
  maximum_batching_window_in_seconds = 5

  # Only failed messages are retried — successfully processed ones are not re-sent
  function_response_types = ["ReportBatchItemFailures"]
}
