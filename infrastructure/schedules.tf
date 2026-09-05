# ============================================================
# Scheduling — schedules table + sweeper Lambda
#
# One EventBridge rule ticks the sweeper every 5 minutes. The sweeper scans
# for enabled rows whose NextRunAt has passed and acts on each through the
# same shared setAuthorization() the dashboard API uses.
#
# Rows are never deleted — cancelling sets Enabled = false.
#
# Schema:
#   PK  ScheduleID (S)   — UUID, or "<parentId>-revoke-<EndsAt>" for a spawned revoke
#       Kind (S)         — "once" | "autorenew"
#       Action (S)       — "extend" | "revoke"
#       ClientID (S)     — FK into the client tracking table
#       NextRunAt (S)    — UTC ISO 8601 (Z). Compared as a string, so mixed
#                          offsets would sort wrongly and fire at the wrong time.
#       EndsAt (S)       — mandatory for autorenew; the only bound on renewal
#       Enabled (BOOL)   — false = cancelled or terminal
#       RunCount / FailureCount (N), LastRunAt / LastResult / CreatedAt (S)
# ============================================================

resource "aws_dynamodb_table" "schedules" {
  name         = var.schedules_table_name
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "ScheduleID"

  attribute {
    name = "ScheduleID"
    type = "S"
  }

  # No GSI on Enabled/NextRunAt: at hundreds of rows a filtered Scan costs less
  # than an index and is one less moving part.
  # ponytail: revisit past ~5k schedules — add a GSI on Enabled.

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = {
    Name = var.schedules_table_name
  }
}

# ── IAM: Sweeper Lambda Role ──────────────────────────────

resource "aws_iam_role" "sweeper_lambda_role" {
  name               = "${var.project}-sweeper-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.dashboard_lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "sweeper_basic_execution" {
  role       = aws_iam_role.sweeper_lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy" "sweeper_dynamodb" {
  name        = "${var.project}-sweeper-dynamodb"
  description = "Sweeper reads/updates client records and manages schedule rows."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ClientTableReadUpdate"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.client_tracking.arn
      },
      {
        Sid      = "SchedulesTableReadWrite"
        Effect   = "Allow"
        Action   = ["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"]
        Resource = aws_dynamodb_table.schedules.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "sweeper_dynamodb" {
  role       = aws_iam_role.sweeper_lambda_role.name
  policy_arn = aws_iam_policy.sweeper_dynamodb.arn
}

resource "aws_iam_role_policy_attachment" "sweeper_secrets" {
  role       = aws_iam_role.sweeper_lambda_role.name
  policy_arn = aws_iam_policy.dashboard_lambda_secrets.arn
}

# ── CloudWatch ────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "sweeper_logs" {
  name              = "/aws/lambda/${var.project}-schedule-sweeper"
  retention_in_days = 30
}

resource "aws_cloudwatch_metric_alarm" "sweeper_errors" {
  alarm_name          = "${var.project}-schedule-sweeper-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_description   = "The schedule sweeper is throwing — scheduled renewals and revokes may not be running."
  alarm_actions       = var.dlq_alarm_email != "" ? [aws_sns_topic.alarms[0].arn] : []

  dimensions = {
    FunctionName = aws_lambda_function.schedule_sweeper.function_name
  }
}

# A row that stopped with no failures and no revoke to enforce its end date.
# The handler only logs this token when Kind != "once", because that same
# signature is the normal terminal state of every successful `once` job. A
# corrupt Kind also lands here, and should alarm — that is the point.
resource "aws_cloudwatch_log_metric_filter" "sweeper_unexpected_stop" {
  name           = "${var.project}-schedule-stopped-unexpected"
  log_group_name = aws_cloudwatch_log_group.sweeper_logs.name
  pattern        = "SCHEDULE_STOPPED_UNEXPECTED"

  metric_transformation {
    name          = "ScheduleStoppedUnexpected"
    namespace     = "${var.project}/Schedules"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "sweeper_unexpected_stop" {
  alarm_name          = "${var.project}-schedule-stopped-unexpected"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.sweeper_unexpected_stop.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.sweeper_unexpected_stop.metric_transformation[0].namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_description   = "A non-'once' schedule stopped on corrupt data (bad Kind or missing/malformed EndsAt). The device may stay authorized with nothing scheduled to revoke it."
  alarm_actions       = var.dlq_alarm_email != "" ? [aws_sns_topic.alarms[0].arn] : []
}

# A row that exhausted its retry budget and was disabled. This is otherwise the
# only silent terminal path in the feature: per-row failures are caught inside
# the handler, so they never reach the AWS/Lambda Errors metric, and
# isUnexpectedStop() excludes failureCount > 0 so the alarm above misses it.
# Without this the device's authorization just lapses with nobody notified.
resource "aws_cloudwatch_log_metric_filter" "sweeper_failure_cap" {
  name           = "${var.project}-schedule-failure-cap"
  log_group_name = aws_cloudwatch_log_group.sweeper_logs.name
  pattern        = "SCHEDULE_FAILURE_CAP_REACHED"

  metric_transformation {
    name          = "ScheduleFailureCapReached"
    namespace     = "${var.project}/Schedules"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "sweeper_failure_cap" {
  alarm_name          = "${var.project}-schedule-failure-cap"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.sweeper_failure_cap.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.sweeper_failure_cap.metric_transformation[0].namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_description   = "A schedule was disabled after 5 consecutive failures (expired Meraki key, SSID missing from SSID_MAP, client deleted). Its device will lose authorization at the real expiry unless someone intervenes."
  alarm_actions       = var.dlq_alarm_email != "" ? [aws_sns_topic.alarms[0].arn] : []
}

# ── Lambda ────────────────────────────────────────────────

# Filenames MUST preserve the lambda-src/ layout: index.js resolves its imports
# with require('../shared/...'), so a flattened zip is MODULE_NOT_FOUND on every
# cold start. Same shape as data.archive_file.dashboard_lambda_zip.
data "archive_file" "sweeper_lambda_zip" {
  type        = "zip"
  output_path = "${path.module}/.terraform/sweeper-lambda-package.zip"

  source {
    content  = file("${path.module}/lambda-src/sweeper/index.js")
    filename = "sweeper/index.js"
  }

  source {
    content  = file("${path.module}/lambda-src/shared/meraki.js")
    filename = "shared/meraki.js"
  }

  source {
    content  = file("${path.module}/lambda-src/shared/schedule-logic.js")
    filename = "shared/schedule-logic.js"
  }
}

resource "aws_lambda_function" "schedule_sweeper" {
  function_name    = "${var.project}-schedule-sweeper"
  description      = "Runs due scheduled splash-authorization actions every 5 minutes"
  filename         = data.archive_file.sweeper_lambda_zip.output_path
  source_code_hash = data.archive_file.sweeper_lambda_zip.output_base64sha256
  handler          = "sweeper/index.handler"
  runtime          = "nodejs18.x"
  architectures    = ["arm64"]
  role             = aws_iam_role.sweeper_lambda_role.arn
  timeout          = 300 # a sweep may touch many clients, each a Meraki round-trip
  memory_size      = 256

  environment {
    variables = {
      DYNAMODB_TABLE_NAME                 = aws_dynamodb_table.client_tracking.name
      SCHEDULES_TABLE_NAME                = aws_dynamodb_table.schedules.name
      MERAKI_SECRET_ARN                   = aws_secretsmanager_secret.meraki_api_key.arn
      MERAKI_NETWORK_ID                   = var.meraki_network_id
      SSID_MAP                            = var.ssid_map
      AUTORENEW_LEAD_DAYS                 = var.autorenew_lead_days
      AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.sweeper_basic_execution,
    aws_iam_role_policy_attachment.sweeper_dynamodb,
    aws_iam_role_policy_attachment.sweeper_secrets,
    aws_cloudwatch_log_group.sweeper_logs,
  ]
}

# ── EventBridge: 5-minute tick ────────────────────────────

resource "aws_cloudwatch_event_rule" "sweeper_tick" {
  name                = "${var.project}-schedule-sweeper-tick"
  description         = "Fires the schedule sweeper every 5 minutes"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "sweeper" {
  rule      = aws_cloudwatch_event_rule.sweeper_tick.name
  target_id = "schedule-sweeper"
  arn       = aws_lambda_function.schedule_sweeper.arn
}

resource "aws_lambda_permission" "sweeper_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.schedule_sweeper.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.sweeper_tick.arn
}
