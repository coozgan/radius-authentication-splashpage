# ============================================================
# CloudWatch — Logs, Alarms
# ============================================================

# Lambda log group with 30-day retention
resource "aws_cloudwatch_log_group" "lambda_logs" {
  name              = "/aws/lambda/${var.lambda_function_name}"
  retention_in_days = 30
}

# ── Optional SNS topic for email alerts ───────────────────
# Only created when dlq_alarm_email variable is set

resource "aws_sns_topic" "alarms" {
  count = var.dlq_alarm_email != "" ? 1 : 0
  name  = "${var.project}-alarms"
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count     = var.dlq_alarm_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = var.dlq_alarm_email
}

# ── Alarms ────────────────────────────────────────────────

# Fires as soon as a single message lands in the DLQ (Lambda kept failing)
resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name          = "${var.project}-dlq-has-messages"
  alarm_description   = "One or more client auth events could not be processed after 3 retries. Check Lambda logs."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.client_events_dlq.name
  }

  alarm_actions = var.dlq_alarm_email != "" ? [aws_sns_topic.alarms[0].arn] : []
}

# Fires when Lambda reports errors (e.g. DynamoDB unreachable, malformed message)
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "${var.project}-lambda-tracker-errors"
  alarm_description   = "Lambda client tracker is reporting errors. Check /aws/lambda/${var.lambda_function_name} logs."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.client_tracker.function_name
  }

  alarm_actions = var.dlq_alarm_email != "" ? [aws_sns_topic.alarms[0].arn] : []
}
