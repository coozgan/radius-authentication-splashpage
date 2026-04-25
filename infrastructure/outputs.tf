output "dynamodb_table_name" {
  description = "DynamoDB table name"
  value       = aws_dynamodb_table.client_tracking.name
}

output "dynamodb_table_arn" {
  description = "DynamoDB table ARN"
  value       = aws_dynamodb_table.client_tracking.arn
}

output "sqs_queue_url" {
  description = "SQS queue URL — set as SQS_QUEUE_URL in the ECS task environment"
  value       = aws_sqs_queue.client_events.url
}

output "sqs_queue_arn" {
  description = "SQS queue ARN"
  value       = aws_sqs_queue.client_events.arn
}

output "sqs_dlq_url" {
  description = "Dead-letter queue URL for monitoring failed messages"
  value       = aws_sqs_queue.client_events_dlq.url
}

output "lambda_function_name" {
  description = "Lambda function name"
  value       = aws_lambda_function.client_tracker.function_name
}

output "lambda_function_arn" {
  description = "Lambda function ARN"
  value       = aws_lambda_function.client_tracker.arn
}

output "ecs_task_role_arn" {
  description = "ECS task role ARN — set as taskRoleArn in task-definition.json"
  value       = aws_iam_role.ecs_task_role.arn
}

output "dashboard_api_url" {
  description = "HTTP API Gateway URL — set as DASHBOARD_API_URL in dashboard/.env.local"
  value       = aws_apigatewayv2_api.dashboard.api_endpoint
}

output "meraki_secret_arn" {
  description = "Secrets Manager ARN — set the API key value with: aws secretsmanager put-secret-value --secret-id <arn> --secret-string '{\"api_key\":\"YOUR_KEY\"}'"
  value       = aws_secretsmanager_secret.meraki_api_key.arn
}
