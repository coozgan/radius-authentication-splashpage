variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "ap-southeast-1"
}

variable "environment" {
  description = "Deployment environment (production, staging)"
  type        = string
  default     = "production"
}

variable "project" {
  description = "Project identifier used in resource names and tags"
  type        = string
  default     = "radius-auth"
}

variable "dynamodb_table_name" {
  description = "DynamoDB table name for client tracking"
  type        = string
  default     = "radius-auth-clients"
}

variable "sqs_queue_name" {
  description = "SQS queue name for client authentication events"
  type        = string
  default     = "radius-auth-client-events"
}

variable "lambda_function_name" {
  description = "Lambda function name for the client tracker"
  type        = string
  default     = "radius-auth-client-tracker"
}

variable "ecs_task_role_name" {
  description = "IAM role name for the ECS task (app-level permissions)"
  type        = string
  default     = "radius-auth-ecs-task-role"
}

variable "dlq_alarm_email" {
  description = "Email address for DLQ and Lambda error alarm notifications. Leave empty to disable email alerts."
  type        = string
  default     = ""
}

variable "meraki_network_id" {
  description = "Meraki network ID for the splash authorization API calls (e.g. L_3966545371806568169)"
  type        = string
  default     = "L_3966545371806568169"
}

variable "ssid_map" {
  description = "JSON map of SSID name to Meraki SSID number, e.g. {\"ICS-Staff\":\"1\",\"ICS-HS\":\"7\"}"
  type        = string
  default     = "{\"ICS-Staff\":\"1\",\"ICS-HS\":\"7\"}"
}
