# ============================================================
# Dashboard API — Lambda + HTTP API Gateway
#
# Exposes endpoints for the Next.js dashboard:
#   GET    /clients                      — list all clients (DynamoDB Scan)
#   POST   /clients/{clientId}/extend    — extend one client (Meraki + DynamoDB)
#   POST   /clients/bulk-extend          — extend many clients in parallel
#   DELETE /clients/{clientId}           — delete one client record
#   POST   /clients/bulk-delete          — delete many client records
#
# The Meraki API key is retrieved from Secrets Manager at runtime,
# so it never appears in Lambda env vars or Terraform state.
# ============================================================

# ── IAM: Dashboard Lambda Role ────────────────────────────

data "aws_iam_policy_document" "dashboard_lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dashboard_lambda_role" {
  name               = "${var.project}-dashboard-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.dashboard_lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "dashboard_lambda_basic_execution" {
  role       = aws_iam_role.dashboard_lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# DynamoDB: read, update, and delete — only the dashboard admin role can delete
resource "aws_iam_policy" "dashboard_lambda_dynamodb" {
  name        = "${var.project}-dashboard-lambda-dynamodb"
  description = "Dashboard Lambda can read, update, and delete client records via explicit admin action."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDBReadUpdateDelete"
        Effect = "Allow"
        Action = [
          "dynamodb:Scan",
          "dynamodb:GetItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
        ]
        Resource = aws_dynamodb_table.client_tracking.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "dashboard_lambda_dynamodb" {
  role       = aws_iam_role.dashboard_lambda_role.name
  policy_arn = aws_iam_policy.dashboard_lambda_dynamodb.arn
}

# Secrets Manager: read the Meraki API key — no write access
resource "aws_iam_policy" "dashboard_lambda_secrets" {
  name        = "${var.project}-dashboard-lambda-secrets"
  description = "Dashboard Lambda can read the Meraki API key from Secrets Manager."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "SecretsManagerRead"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.meraki_api_key.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "dashboard_lambda_secrets" {
  role       = aws_iam_role.dashboard_lambda_role.name
  policy_arn = aws_iam_policy.dashboard_lambda_secrets.arn
}

# ── CloudWatch: Dashboard Lambda Logs ─────────────────────

resource "aws_cloudwatch_log_group" "dashboard_lambda_logs" {
  name              = "/aws/lambda/${var.project}-dashboard-api"
  retention_in_days = 30
}

# ── Lambda: Dashboard API ──────────────────────────────────

data "archive_file" "dashboard_lambda_zip" {
  type        = "zip"
  source_dir  = "${path.module}/lambda-src/dashboard"
  output_path = "${path.module}/.terraform/dashboard-lambda-package.zip"
}

resource "aws_lambda_function" "dashboard_api" {
  function_name    = "${var.project}-dashboard-api"
  description      = "Dashboard API: list clients, extend single/bulk Meraki splash authorizations"
  filename         = data.archive_file.dashboard_lambda_zip.output_path
  source_code_hash = data.archive_file.dashboard_lambda_zip.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs18.x"
  architectures    = ["arm64"] # Graviton2 — same performance, lower cost
  role             = aws_iam_role.dashboard_lambda_role.arn
  timeout          = 30         # Meraki API calls can take several seconds under load
  memory_size      = 128

  environment {
    variables = {
      DYNAMODB_TABLE_NAME                 = aws_dynamodb_table.client_tracking.name
      MERAKI_SECRET_ARN                   = aws_secretsmanager_secret.meraki_api_key.arn
      MERAKI_NETWORK_ID                   = var.meraki_network_id
      SSID_MAP                            = var.ssid_map
      AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.dashboard_lambda_basic_execution,
    aws_iam_role_policy_attachment.dashboard_lambda_dynamodb,
    aws_iam_role_policy_attachment.dashboard_lambda_secrets,
    aws_cloudwatch_log_group.dashboard_lambda_logs,
  ]
}

# ── HTTP API Gateway ───────────────────────────────────────

resource "aws_apigatewayv2_api" "dashboard" {
  name          = "${var.project}-dashboard-api"
  protocol_type = "HTTP"
  description   = "HTTP API for the WiFi client dashboard"

  cors_configuration {
    allow_origins = ["*"] # Restrict to your dashboard domain in production
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["Content-Type"]
    max_age       = 3600
  }
}

resource "aws_apigatewayv2_stage" "dashboard_default" {
  api_id      = aws_apigatewayv2_api.dashboard.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_apigatewayv2_integration" "dashboard_lambda" {
  api_id                 = aws_apigatewayv2_api.dashboard.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.dashboard_api.invoke_arn
  payload_format_version = "2.0"
}

# Single catch-all route — the Lambda handles all path routing internally
resource "aws_apigatewayv2_route" "dashboard_catch_all" {
  api_id    = aws_apigatewayv2_api.dashboard.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.dashboard_lambda.id}"
}

# Allow API Gateway to invoke the Lambda function
resource "aws_lambda_permission" "dashboard_api_gateway" {
  statement_id  = "AllowHTTPAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.dashboard_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.dashboard.execution_arn}/*/*"
}
