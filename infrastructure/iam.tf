# ============================================================
# IAM — Least-Privilege Roles and Policies
#
# Two roles:
#   1. lambda_execution_role  — Used BY Lambda (CloudWatch + DynamoDB write + SQS consume)
#   2. ecs_task_role          — Used BY ECS container (SQS publish only)
#
# Principle of least privilege:
#   - Lambda cannot DeleteItem on DynamoDB
#   - ECS task cannot read from SQS or touch DynamoDB directly
# ============================================================

# ── Lambda Execution Role ─────────────────────────────────
data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda_execution_role" {
  name               = "${var.project}-lambda-execution-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

# AWS managed policy — grants CreateLogGroup, CreateLogStream, PutLogEvents
resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  role       = aws_iam_role.lambda_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# DynamoDB: write and update only — no DeleteItem
resource "aws_iam_policy" "lambda_dynamodb" {
  name        = "${var.project}-lambda-dynamodb"
  description = "Lambda can upsert client records. DeleteItem is intentionally excluded."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDBUpsert"
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:GetItem"
        ]
        Resource = aws_dynamodb_table.client_tracking.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_dynamodb" {
  role       = aws_iam_role.lambda_execution_role.name
  policy_arn = aws_iam_policy.lambda_dynamodb.arn
}

# SQS: Lambda trigger permissions
resource "aws_iam_policy" "lambda_sqs_consume" {
  name        = "${var.project}-lambda-sqs-consume"
  description = "Lambda can consume messages from the client events queue"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SQSConsume"
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = aws_sqs_queue.client_events.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_sqs_consume" {
  role       = aws_iam_role.lambda_execution_role.name
  policy_arn = aws_iam_policy.lambda_sqs_consume.arn
}

# ── ECS Task Role ─────────────────────────────────────────
# This is the role the running container assumes — separate from the
# execution role (which is used by the ECS control plane to pull images
# and fetch secrets).
data "aws_iam_policy_document" "ecs_task_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_task_role" {
  name               = var.ecs_task_role_name
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
}

# ECS task may only publish to the queue — it cannot read or delete
resource "aws_iam_policy" "ecs_sqs_publish" {
  name        = "${var.project}-ecs-sqs-publish"
  description = "ECS task can send auth events to SQS. Read/delete actions excluded."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SQSPublish"
        Effect = "Allow"
        Action = [
          "sqs:SendMessage",
          "sqs:GetQueueUrl"
        ]
        Resource = aws_sqs_queue.client_events.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_sqs_publish" {
  role       = aws_iam_role.ecs_task_role.name
  policy_arn = aws_iam_policy.ecs_sqs_publish.arn
}
